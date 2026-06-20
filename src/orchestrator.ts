/**
 * Orchestrator: owns the state machine and the per-phase loop.
 *
 * Full state machine:
 *
 *   planning -> working (per task) -> pr_open -> ci_pending -> ci_fixing
 *        -> review -> merging -> verifying -> done
 *                                            ↘ needs_human (at any failing gate)
 *
 * Mailbox: between/within worker turns, undelivered steering messages are
 * delivered to the live pi session via `session.steer()`.
 *
 * Safety: autoMerge defaults false; CI/review/verify gates must pass before
 * merge; bounded retries route to needs_human instead of looping forever.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { loadConfig, type PitmConfig } from "./config.ts";
import { isPitmError, PitmError } from "./errors.ts";
import {
	branchFromGoal,
	commit,
	createBranch,
	detectDefaultBranch,
	ghPrCreate,
	ghPrMerge,
	pushBranch,
	pushUpstream,
	stageAll,
} from "./git.ts";
import { buildRegistry, modelLabel, resolveAll } from "./models.ts";
import { type AgentSessionLike, type PhaseRunResult } from "./agent.ts";
import { runPlanner, toTasks } from "./phases/planner.ts";
import { runWorker } from "./phases/worker.ts";
import { runCiLoop } from "./ci.ts";
import { runVerifier } from "./phases/verifier.ts";
import { runReviewLoop } from "./reviews.ts";
import { mergeExternalMailbox, startMailboxPoller } from "./mailbox.ts";
import { acquireLock, type HeldLock } from "./lock.ts";
import {
	budgetExhausted,
	loadState,
	log,
	requireState,
	saveState,
	type State,
	type Task,
} from "./state.ts";

export interface StartOptions {
	goal: string;
	cwd?: string;
	config?: PitmConfig;
	/** Override the planner model ref ("provider/modelId") for dry-plan runs. */
	plannerOverride?: string;
}

export interface RunContext {
	cwd: string;
	config: PitmConfig;
	byPhase: Partial<Record<string, Model<Api>>>;
	knownReviewComments: Set<string>;
	lock: HeldLock;
}

/** Begin a new run. Throws if a run already exists in this cwd. */
export async function startRun(opts: StartOptions): Promise<State> {
	const cwd = opts.cwd ?? process.cwd();
	if (loadState(cwd)) {
		throw new PitmError(
			`A run already exists at .pitm/state.json. Use \`pitm resume\` to continue or delete it first.`,
			"RUN_EXISTS",
		);
	}
	const config = opts.config ?? loadConfig(cwd);
	const { registry } = buildRegistry();
	const byPhase = resolveAll(registry, config.models);
	const lock = await acquireLock(cwd);

	const branch = branchFromGoal(opts.goal);
	const defaultBranch = await detectDefaultBranch(cwd, config.git.targetBranch);
	if (defaultBranch !== config.git.targetBranch) {
		console.error(
			`Note: config git.targetBranch="${config.git.targetBranch}" but the repo default is "${defaultBranch}". Using "${defaultBranch}" as the PR base.`,
		);
	}
	const state: State = {
		goal: opts.goal,
		phase: "planning",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		branch,
		baseBranch: defaultBranch,
		verifyCommand: config.verifyCommand,
		tasks: [],
		modelByPhase: serializeModelRefs(byPhase),
		budget: { maxTokensPerRun: config.budget.maxTokensPerRun, spentTokens: 0 },
		mailbox: [],
		runLog: [],
	};
	saveState(state, cwd);

	try {
		await createBranch(branch, cwd);
	} catch (e) {
		return fail(state, cwd, `Could not create branch ${branch}: ${(e as Error).message}`, lock);
	}

	const ctx: RunContext = { cwd, config, byPhase, knownReviewComments: new Set(), lock };

	const plannerModel = byPhase.planner;
	if (!plannerModel) return fail(state, cwd, "No planner model resolved.", lock);
	log(state, "planning", `Planning with ${modelLabel(plannerModel)}`, modelLabel(plannerModel));
	saveState(state, cwd);

	const plan = await runPlanner(cwd, opts.goal, plannerModel, config.verifyCommand);
	state.tasks = toTasks(plan);
	if (state.tasks.length === 0) {
		state.phase = "done";
		log(state, "planning", "Planner found no tasks — goal already satisfied.");
		saveState(state, cwd);
		await lock.release();
		return state;
	}
	state.phase = "working";
	log(state, "planning", `Planned ${state.tasks.length} task(s).`);
	saveState(state, cwd);

	await workLoop(state, ctx);
	await afterPr(state, ctx);
	return state;
}

export interface PlanPreview {
	goal: string;
	model: string;
	tasks: Task[];
	totalTokens: number;
}

/** Dry-run: run only the planner, print tasks, no git/state/PR side effects. */
export async function planOnly(opts: StartOptions): Promise<PlanPreview> {
	const cwd = opts.cwd ?? process.cwd();
	const config = opts.config ?? loadConfig(cwd);
	const { registry } = buildRegistry();
	let plannerModel: Model<Api> | undefined;
	if (opts.plannerOverride) {
		const { resolveModel } = await import("./models.ts");
		plannerModel = resolveModel(registry, opts.plannerOverride);
	} else {
		const byPhase = resolveAll(registry, config.models);
		plannerModel = byPhase.planner;
	}
	if (!plannerModel) {
		throw new PitmError("No planner model resolved.", "MODEL_RESOLUTION_ERROR");
	}
	const plan = await runPlanner(cwd, opts.goal, plannerModel, config.verifyCommand);
	const tasks = toTasks(plan);
	return {
		goal: opts.goal,
		model: modelLabel(plannerModel),
		tasks,
		totalTokens: 0,
	};
}

/** Resume an existing run from its saved phase. */
export async function resumeRun(cwd: string = process.cwd()): Promise<State> {
	const state = requireState(cwd);
	if (state.phase === "done" || state.phase === "needs_human") return state;
	const config = loadConfig(cwd);
	const { registry } = buildRegistry();
	const byPhase = resolveAll(registry, config.models);
	const lock = await acquireLock(cwd);
	const ctx: RunContext = { cwd, config, byPhase, knownReviewComments: new Set(), lock };

	if (state.phase === "planning") {
		const plan = await runPlanner(cwd, state.goal, byPhase.planner as Model<Api>, config.verifyCommand);
		state.tasks = toTasks(plan);
		state.phase = "working";
		log(state, "planning", `Re-planned ${state.tasks.length} task(s) on resume.`);
		saveState(state, cwd);
	}
	if (state.phase === "working") {
		await workLoop(state, ctx);
	}
	await afterPr(state, ctx);
	return state;
}

/** Iterate remaining pending tasks; commit after each; then open the PR. */
async function workLoop(state: State, ctx: RunContext): Promise<void> {
	const { cwd, config, byPhase, lock } = ctx;
	const workerModel = byPhase.worker;
	if (!workerModel) return void fail(state, cwd, "No worker model resolved.", lock);

	while (true) {
		if (budgetExhausted(state)) {
			return void fail(state, cwd, "Token budget exhausted before finishing all tasks.", lock);
		}
		mergeExternalMailbox(state, cwd);
		const next = nextPendingTask(state);
		if (!next) break;
		next.status = "in_progress";
		next.attempts += 1;
		state.currentTaskId = next.id;
		log(state, "working", `Starting ${next.id}: ${next.title}`, modelLabel(workerModel));
		saveState(state, cwd);

		try {
			const result = await runWorkerWithMailbox(state, ctx, next);
			state.budget.spentTokens += result.totalTokens;
			log(
				state,
				"working",
				`${next.id} complete (${result.totalTokens} tokens). ${summarize(result.text)}`,
				result.model,
			);
			next.status = "done";
			await stageAll(cwd);
			const sha = await commit(`${next.id}: ${next.title}\n\n${state.goal}`, cwd);
			next.commitSha = sha;
			saveState(state, cwd);
		} catch (e) {
			next.status = "failed";
			const msg = (e as Error).message;
			log(state, "working", `${next.id} failed: ${msg}`);
			saveState(state, cwd);
			return void fail(state, cwd, `Task ${next.id} failed: ${msg}`, lock);
		}
	}
	state.currentTaskId = undefined;
	state.phase = "pr_open";
	log(state, "working", "All tasks complete. Opening PR.");
	saveState(state, cwd);
	await openPrIfMissing(state, ctx);
}

/** Run the worker with a live mailbox poller steering the session mid-run. */
async function runWorkerWithMailbox(
	state: State,
	ctx: RunContext,
	task: Task,
): Promise<PhaseRunResult> {
	const { cwd, config, byPhase } = ctx;
	const workerModel = byPhase.worker as Model<Api>;
	let stopPoller: (() => void) | undefined;
	try {
		const result = await runWorker({
			cwd,
			goal: state.goal,
			task,
			verifyCommand: config.verifyCommand,
			model: workerModel,
			previousTasks: state.tasks,
			onSession: (session: AgentSessionLike) => {
				stopPoller = startMailboxPoller(state, session, 2000);
			},
		});
		return result;
	} finally {
		stopPoller?.();
	}
}

async function openPrIfMissing(state: State, ctx: RunContext): Promise<void> {
	const { cwd, config, lock } = ctx;
	if (state.pr) {
		log(state, "pr_open", `PR already open: ${state.pr.url}`);
		saveState(state, cwd);
		return;
	}
	if (config.git.autoPush) {
		try {
			await pushUpstream(state.branch, cwd);
		} catch (e) {
			return void fail(state, cwd, `Push failed: ${(e as Error).message}`, lock);
		}
	}
	try {
		const pr = await ghPrCreate(prTitle(state), prBody(state), state.baseBranch, cwd);
		state.pr = pr;
		log(state, "pr_open", `PR #${pr.number} opened: ${pr.url}`);
		saveState(state, cwd);
	} catch (e) {
		if (isPitmError(e)) {
			return void fail(state, cwd, `gh pr create failed: ${e.message}`, lock);
		}
		return void fail(state, cwd, `PR creation error: ${(e as Error).message}`, lock);
	}
}

/** Post-PR pipeline: CI -> review -> verify -> merge. Skipped if not yet open. */
async function afterPr(state: State, ctx: RunContext): Promise<void> {
	const { cwd, config, byPhase, lock } = ctx;
	if (!state.pr) {
		// PR not opened (e.g. work halted) — leave phase as-is.
		return;
	}
	if (state.phase === "done" || state.phase === "needs_human") {
		await lock.release();
		return;
	}

	// --- CI loop ---
	state.phase = "ci_pending";
	saveState(state, cwd);
	const ciOutcome = await runCiLoop({
		cwd,
		state,
		fixerModel: byPhase.fixer,
		maxFixRetries: config.budget.maxCiFixRetries,
	});
	if (ciOutcome === "needs_human") {
		await lock.release();
		return;
	}

	// --- Review loop ---
	const reviewOutcome = await runReviewLoop({
		cwd,
		state,
		reviewerModel: byPhase.reviewer,
		maxRounds: 3,
		knownCommentBodies: ctx.knownReviewComments,
	});
	if (reviewOutcome === "needs_human") {
		await lock.release();
		return;
	}
	// If review produced changes, re-run CI once.
	if (reviewOutcome === "addressed") {
		const reCi = await runCiLoop({
			cwd,
			state,
			fixerModel: byPhase.fixer,
			maxFixRetries: config.budget.maxCiFixRetries,
		});
		if (reCi === "needs_human") {
			await lock.release();
			return;
		}
	}

	// --- Verify ---
	state.phase = "verifying";
	saveState(state, cwd);
	const verifierModel = byPhase.verifier;
	if (!verifierModel) {
		fail(state, cwd, "No verifier model resolved.", lock);
		await lock.release();
		return;
	}
	log(state, "verifying", `Verifying success criteria with ${modelLabel(verifierModel)}`, modelLabel(verifierModel));
	saveState(state, cwd);
	let verdict;
	try {
		verdict = await runVerifier({
			cwd,
			goal: state.goal,
			tasks: state.tasks,
			verifyCommand: state.verifyCommand,
			model: verifierModel,
		});
	} catch (e) {
		fail(state, cwd, `Verifier session errored: ${(e as Error).message}`, lock);
		await lock.release();
		return;
	}
	log(state, "verifying", `Verifier verdict: allPass=${verdict.allPass} (${verdict.results.length} criteria).`);
	saveState(state, cwd);
	if (!verdict.allPass) {
		const failures = verdict.results
			.filter((r) => !r.pass)
			.map((r) => `  - ${r.taskId}: ${r.criterion} — ${r.note}`)
			.join("\n");
		fail(state, cwd, `Success-criteria verification failed:\n${failures}`, lock);
		await lock.release();
		return;
	}

	// --- Merge (opt-in) ---
	if (config.git.autoMerge) {
		state.phase = "merging";
		saveState(state, cwd);
		try {
			await ghPrMerge(state.pr.number, "squash", cwd);
			log(state, "merging", `PR #${state.pr.number} merged (squash).`);
		} catch (e) {
			fail(state, cwd, `Merge failed: ${(e as Error).message}`, lock);
			await lock.release();
			return;
		}
	}

	state.phase = "done";
	log(state, "done", `Run complete. PR: ${state.pr.url}`);
	saveState(state, cwd);
	await lock.release();
}

function nextPendingTask(state: State): Task | undefined {
	return state.tasks.find((t) => t.status === "pending");
}

function prTitle(state: State): string {
	return state.goal.slice(0, 72);
}

function prBody(state: State): string {
	const lines = state.tasks.map(
		(t) => `- [${t.status === "done" ? "x" : " "}] ${t.id}: ${t.title}`,
	);
	return [
		`Goal: ${state.goal}`,
		"",
		"Tasks:",
		...lines,
		"",
		"_Generated by pi-task-master. CI, review, verification, and merge are automated per `.pitm/config.json`._",
	].join("\n");
}

function fail(state: State, cwd: string, message: string, lock?: HeldLock): State {
	state.phase = "needs_human";
	state.humanNote = message;
	log(state, state.phase, message);
	saveState(state, cwd);
	if (lock) void lock.release();
	return state;
}

function summarize(text: string): string {
	const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
	return firstLine.slice(0, 160);
}

function serializeModelRefs(byPhase: Partial<Record<string, Model<Api>>>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, m] of Object.entries(byPhase)) {
		if (m) out[k] = modelLabel(m);
	}
	return out;
}
