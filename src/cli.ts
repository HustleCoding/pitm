/**
 * CLI entrypoint. Small hand-rolled subcommand dispatcher (no extra dep).
 *
 *   pitm start "<goal>"       plan -> work -> PR -> CI -> review -> verify -> (merge)
 *   pitm resume               resume the current run from its saved phase
 *   pitm status               show the current run's phase, tasks, and PR
 *   pitm doctor               check pi auth, gh, git, config, and models
 *   pitm steer "<message>"    append a steering message to the mailbox
 *   pitm watch [--port N]     start the HTTP mailbox endpoint for external injects
 */
import { planOnly, startRun, resumeRun } from "./orchestrator.ts";
import { runDoctor } from "./doctor.ts";
import { requireState, saveState } from "./state.ts";
import { isPitmError } from "./errors.ts";
import { appendSteer, mergeExternalMailbox } from "./mailbox.ts";
import { startMailboxServer } from "./mailbox-server.ts";
import { MAILBOX_PATH } from "./config.ts";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function usage(): never {
	console.log(`pi-task-master — autonomous task orchestration over the pi SDK

Usage:
  pitm start "<goal>" [--dry-plan] [--planner provider/modelId] [--force]   Plan + full pipeline, or just plan with --dry-plan.
  pitm resume                Resume the current run from its saved phase.
  pitm status [--json]       Show the current run's phase, tasks, and PR.
  pitm doctor                Check pi auth, gh, git, config, and models.
  pitm steer "<message>"     Append a steering message to the mailbox.
  pitm watch [--port N]      Start the HTTP mailbox endpoint (default :7331).

State lives in .pitm/state.json (one run per repo).`);
	process.exit(2);
}

async function main(argv: string[]): Promise<void> {
	const [cmd, ...rest] = argv;
	switch (cmd) {
		case "start": {
			const { goal, dryPlan, planner, force } = parseStartArgs(rest);
			if (!goal) usage();
			await withSigint(async () => {
				if (dryPlan) {
					const preview = await planOnly({ goal, plannerOverride: planner });
					printPlanPreview(preview);
					return;
				}
				if (force) await clearExistingRun();
				const state = await startRun({ goal });
				printSummary(state);
			});
			return;
		}
		case "resume": {
			await withSigint(async () => {
				const state = await resumeRun();
				printSummary(state);
			});
			return;
		}
		case "status": {
			const jsonMode = rest.includes('--json');
			try {
				const state = requireState();
				if (jsonMode) {
					printStatusJson(state);
				} else {
					printSummary(state);
				}
			} catch (e) {
				console.log(`No active pi-task-master run in this repo. Start one with: pitm start "<goal>"`);
				process.exit(0);
			}
			return;
		}
		case "doctor": {
			const { allRequiredPassed } = await runDoctor();
			process.exit(allRequiredPassed ? 0 : 1);
		}
		case "steer": {
			const text = rest.join(" ").trim();
			if (!text) usage();
			let state;
			try {
				state = requireState();
			} catch {
				console.error("No active run to steer. Start one first: pitm start \"<goal>\"");
				process.exit(1);
			}
			appendSteer(state, text);
			saveState(state);
			appendToMailboxFile(text);
			console.log("Steering message queued. It will be delivered to the running session.");
			return;
		}
		case "watch": {
			const port = parsePortFlag(rest);
			const srv = await startMailboxServer({ port });
			console.log(`pi-task-master mailbox server on http://${"127.0.0.1"}:${srv.port}`);
			console.log("  POST /steer      {\"text\":\"...\"}");
			console.log("  POST /followup   {\"text\":\"...\"}");
			console.log("  GET  /state      current run state");
			console.log("  GET  /healthz");
			console.log("Ctrl+C to stop.");
			const stop = () => {
				srv.close().then(() => process.exit(0));
			};
			process.on("SIGINT", stop);
			process.on("SIGTERM", stop);
			return;
		}
		case "--help":
		case "-h":
		case undefined:
			usage();
		default:
			console.error(`Unknown command: ${cmd}`);
			usage();
	}
}

function parsePortFlag(rest: string[]): number | undefined {
	const i = rest.findIndex((a) => a === "--port");
	if (i >= 0 && rest[i + 1]) return Number(rest[i + 1]);
	for (const a of rest) {
		const m = a.match(/^--port=(\d+)$/);
		if (m) return Number(m[1]);
	}
	return undefined;
}

/** Parse `start` args: strip --dry-plan, return the goal + the flag. */
function parseStartArgs(rest: string[]): { goal: string; dryPlan: boolean; planner?: string; force: boolean } {
	const dryPlan = rest.some((a) => a === "--dry-plan" || a === "--plan-only");
	const force = rest.some((a) => a === "--force" || a === "-f");
	let planner: string | undefined;
	const filtered: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i]!;
		if (a === "--dry-plan" || a === "--plan-only" || a === "--force" || a === "-f") continue;
		if (a === "--planner") { planner = rest[i + 1]; i++; continue; }
		const m = a.match(/^--planner=(.+)$/);
		if (m) { planner = m[1]; continue; }
		filtered.push(a);
	}
	return { goal: filtered.join(" ").trim(), dryPlan, planner, force };
}

const ACTIVE_PHASES = new Set([
	"planning",
	"working",
	"pr_open",
	"ci_pending",
	"ci_fixing",
	"review",
	"merging",
	"verifying",
]);

function isActivePhase(phase: string): boolean {
	return ACTIVE_PHASES.has(phase);
}

/** Remove an existing run's state + branch so `start` can begin a new goal. */
async function clearExistingRun(): Promise<void> {
	let state;
	try {
		state = requireState();
	} catch {
		return; // nothing to clear
	}
	if (isActivePhase(state.phase)) {
		console.error(
			`Refusing to --force: a run is still active (phase: ${state.phase}). Finish or abort it first:\n  pitm resume   # to continue, or\n  rm .pitm/state.json && git branch -D ${state.branch}   # to discard`,
		);
		process.exit(1);
	}
	const branch = state.branch;
	try { unlinkSync(".pitm/state.json"); } catch { /* */ }
	try { unlinkSync(".pitm/mailbox.json"); } catch { /* */ }
	console.log(`Cleared previous run (${state.phase}): "${state.goal}".`);
	if (branch) {
		try {
			const { deleteBranch, currentBranch } = await import("./git.ts");
			const cur = await currentBranch(process.cwd()).catch(() => "");
			if (branch !== cur) await deleteBranch(branch, process.cwd()).catch(() => {});
		} catch { /* branch cleanup is best-effort */ }
	}
}

function printPlanPreview(preview: { goal: string; model: string; tasks: Array<{ id: string; title: string; details: string; successCriteria: string[] }> }): void {
	console.log(`\nGoal:   ${preview.goal}`);
	console.log(`Model:  ${preview.model}`);
	console.log(`Tasks:  ${preview.tasks.length}`);
	for (const t of preview.tasks) {
		console.log(`\n  ${t.id}: ${t.title}`);
		console.log(`    ${t.details.split("\n").join("\n    ")}`);
		if (t.successCriteria.length > 0) {
			console.log(`    Success criteria:`);
			for (const c of t.successCriteria) console.log(`      - ${c}`);
		}
	}
	console.log("\n(dry-plan: no branch, no state, no PR created.)");
}

function printStatusJson(state: ReturnType<typeof requireState>): void {
	console.log(JSON.stringify({
		goal: state.goal,
		phase: state.phase,
		branch: state.branch,
		pr: state.pr ?? null,
		humanNote: state.humanNote ?? null,
		tasks: state.tasks.map((t) => ({
			id: t.id,
			title: t.title,
			status: t.status,
			attempts: t.attempts,
			...(t.commitSha !== undefined ? { commitSha: t.commitSha } : {}),
		})),
		budget: {
			spentTokens: state.budget.spentTokens,
			maxTokensPerRun: state.budget.maxTokensPerRun,
		},
		pendingMailbox: state.mailbox.filter((m) => m.deliveredAt === undefined).length,
	}, null, 2));
}

function printSummary(state: ReturnType<typeof requireState>): void {
	console.log(`\nGoal:   ${state.goal}`);
	console.log(`Phase:  ${state.phase}`);
	console.log(`Branch: ${state.branch}`);
	if (state.pr) console.log(`PR:     ${state.pr.url}`);
	if (state.humanNote) console.log(`Note:   ${state.humanNote}`);
	if (state.tasks.length === 0) {
		if (state.phase === "done") {
			console.log(`Tasks:  (none — planner found nothing to implement for this goal)`);
		} else {
			console.log(`Tasks:  (none yet)`);
		}
	} else {
		console.log(`Tasks:`);
		for (const t of state.tasks) {
			const mark = t.status === "done" ? "✓" : t.status === "failed" ? "✗" : t.status === "in_progress" ? "→" : " ";
			console.log(`  ${mark} ${t.id}: ${t.title} [${t.status}]`);
		}
	}
	const spent = (state.budget.spentTokens / 1000).toFixed(1);
	console.log(`Budget: ${spent}k / ${state.budget.maxTokensPerRun / 1000}k tokens`);
	const pending = state.mailbox.filter((m) => !m.deliveredAt).length;
	if (pending > 0) console.log(`Mailbox: ${pending} undelivered`);
}

function appendToMailboxFile(text: string): void {
	const dir = ".pitm";
	mkdirSync(dir, { recursive: true });
	const path = join(process.cwd(), MAILBOX_PATH);
	const existing = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown[]) : [];
	existing.push({ id: randomUUID(), text, createdAt: new Date().toISOString() });
	writeFileSync(path, JSON.stringify(existing, null, 2));
}

/** Wrap a long-running action so SIGINT saves state cleanly instead of corrupting it. */
async function withSigint(fn: () => Promise<void>): Promise<void> {
	const handler = () => {
		console.error("\nSIGINT: saving state and exiting. Run `pitm resume` to continue.");
		try {
			const s = requireState();
			mergeExternalMailbox(s);
			saveState(s);
		} catch (e) {
			console.error(`Could not save state on SIGINT: ${(e as Error).message}`);
		}
		process.exit(130);
	};
	process.on("SIGINT", handler);
	try {
		await fn();
	} catch (e) {
		// Only mark needs_human if a run is ACTIVELY processing. A rejected `start`
		// (e.g. RUN_EXISTS) must not clobber an existing finished run.
		const isRunExists = isPitmError(e) && e.code === "RUN_EXISTS";
		try {
			const s = requireState();
			if (!isRunExists && isActivePhase(s.phase)) {
				s.phase = "needs_human";
			s.humanNote = (e as Error).message;
			saveState(s);
			}
		} catch {
			/* no state to save */
		}
		console.error(`\nRun halted: ${(e as Error).message}`);
		if (!isPitmError(e)) console.error((e as Error).stack);
		process.exit(1);
	} finally {
		process.off("SIGINT", handler);
	}
}

await main(process.argv.slice(2));
