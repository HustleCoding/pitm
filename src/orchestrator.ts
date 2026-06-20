/**
 * Orchestrator: owns the state machine and the per-phase loop.
 *
 * Phase 1 surface: planning -> working (per task) -> pr_open -> done.
 * CI/review/merge/verify phases route to `needs_human` with a clear note;
 * they're stubbed here and built in later phases per the plan.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { loadConfig, type PitmConfig } from "./config.ts";
import { GitError, isPitmError, PitmError } from "./errors.ts";
import {
	branchFromGoal,
	commit,
	createBranch,
	ghPrCreate,
	pushUpstream,
	stageAll,
} from "./git.ts";
import { buildRegistry, modelLabel, resolveAll } from "./models.ts";
import { runPhase } from "./agent.ts";
import { runPlanner, toTasks } from "./phases/planner.ts";
import { runWorker } from "./phases/worker.ts";
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
	const { registry, authStorage } = buildRegistry();
	// Keep authStorage referenced so linters don't drop the singleton side-effect.
	void authStorage;
	const byPhase = resolveAll(registry, config.models);

	const branch = branchFromGoal(opts.goal);
	const state: State = {
		goal: opts.goal,
		phase: "planning",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		branch,
		baseBranch: config.git.targetBranch,
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
		return fail(state, cwd, `Could not create branch ${branch}: ${(e as Error).message}`);
	}

	// --- planning ---
	log(state, "planning", `Planning with ${modelLabel(byPhase.planner)}`, modelLabel(byPhase.planner));
	saveState(state, cwd);
	const plannerModel = byPhase.planner;
	if (!plannerModel) return fail(state, cwd, "No planner model resolved.");
	const plan = await runPlanner(cwd, opts.goal, plannerModel, config.verifyCommand);
	state.tasks = toTasks(plan);
	if (state.tasks.length === 0) {
		state.phase = "done";
		log(state, "planning", "Planner found no tasks — goal already satisfied.");
		saveState(state, cwd);
		return state;
	}
	state.phase = "working";
	log(state, "planning", `Planned ${state.tasks.length} task(s).`);
	saveState(state, cwd);

	// --- working ---
	await workLoop(state, cwd, config, byPhase.worker);
	return state;
}

/** Resume an existing run from its saved phase. */
export async function resumeRun(cwd: string = process.cwd()): Promise<State> {
	const state = requireState(cwd);
	const config = loadConfig(cwd);
	const { registry } = buildRegistry();
	const byPhase = resolveAll(registry, config.models);

	if (state.phase === "done" || state.phase === "needs_human") {
		return state; // nothing to do
	}
	if (state.phase === "planning") {
		// Re-plan from scratch.
		const plan = await runPlanner(cwd, state.goal, byPhase.planner as Model<Api>, config.verifyCommand);
		state.tasks = toTasks(plan);
		state.phase = "working";
		log(state, "planning", `Re-planned ${state.tasks.length} task(s) on resume.`);
		saveState(state, cwd);
	}
	if (state.phase === "working") {
		await workLoop(state, cwd, config, byPhase.worker);
	}
	if (state.phase === "pr_open") {
		await openPrIfMissing(state, cwd, config);
	}
	return state;
}

/** Iterate remaining pending tasks; commit after each; open PR at the end. */
async function workLoop(
	state: State,
	cwd: string,
	config: PitmConfig,
	workerModel: Model<Api> | undefined,
): Promise<void> {
	if (!workerModel) {
		fail(state, cwd, "No worker model resolved.");
		return;
	}
	while (true) {
		if (budgetExhausted(state)) {
			return void fail(state, cwd, "Token budget exhausted before finishing all tasks.");
		}
		const next = nextPendingTask(state);
		if (!next) break;
		next.status = "in_progress";
		next.attempts += 1;
		state.currentTaskId = next.id;
		log(state, "working", `Starting ${next.id}: ${next.title}`, modelLabel(workerModel));
		saveState(state, cwd);

		try {
			const result = await runWorker({
				cwd,
				goal: state.goal,
				task: next,
				verifyCommand: config.verifyCommand,
				model: workerModel,
				previousTasks: state.tasks,
			});
			state.budget.spentTokens += result.totalTokens;
			log(state, "working", `${next.id} complete (${result.totalTokens} tokens). ${summarize(result.text)}`, result.model);
			next.status = "done";
			// Commit this task.
			await stageAll(cwd);
			const sha = await commit(`${next.id}: ${next.title}\n\n${state.goal}`, cwd);
			next.commitSha = sha;
			saveState(state, cwd);
		} catch (e) {
			next.status = "failed";
			const msg = (e as Error).message;
			log(state, "working", `${next.id} failed: ${msg}`);
			saveState(state, cwd);
			return void fail(state, cwd, `Task ${next.id} failed: ${msg}`);
		}
	}
	state.currentTaskId = undefined;

	// All tasks done -> open PR.
	state.phase = "pr_open";
	log(state, "working", "All tasks complete. Opening PR.");
	saveState(state, cwd);
	await openPrIfMissing(state, cwd, config);
}

async function openPrIfMissing(state: State, cwd: string, config: PitmConfig): Promise<void> {
	if (state.pr) {
		state.phase = "done";
		log(state, "pr_open", `PR already open: ${state.pr.url}`);
		saveState(state, cwd);
		return;
	}
	if (config.git.autoPush) {
		try {
			await pushUpstream(state.branch, cwd);
		} catch (e) {
			return void fail(state, cwd, `Push failed: ${(e as Error).message}`);
		}
	}
	try {
		const body = prBody(state);
		const pr = await ghPrCreate(prTitle(state), body, state.baseBranch, cwd);
		state.pr = pr;
		state.phase = "done";
		log(state, "pr_open", `PR #${pr.number} opened: ${pr.url}`);
		saveState(state, cwd);
	} catch (e) {
		if (isPitmError(e) && e instanceof GitError) {
			return void fail(state, cwd, `gh pr create failed: ${e.message}`);
		}
		return void fail(state, cwd, `PR creation error: ${(e as Error).message}`);
	}
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
		"_Generated by pi-task-master. CI/review/merge loops are not yet automated — please review._",
	].join("\n");
}

function fail(state: State, cwd: string, message: string): State {
	state.phase = "needs_human";
	state.humanNote = message;
	log(state, state.phase, message);
	saveState(state, cwd);
	return state;
}

function summarize(text: string): string {
	const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
	return firstLine.slice(0, 160);
}

function serializeModelRefs(
	byPhase: Partial<Record<string, Model<Api>> >,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, m] of Object.entries(byPhase)) {
		if (m) out[k] = modelLabel(m);
	}
	return out;
}
