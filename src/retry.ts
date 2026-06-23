/**
 * `pitm retry` — retry a run stuck at `needs_human`.
 *
 * Inspects the run log to determine the last active phase, resets the state
 * back to that phase, clears humanNote, and hands off to `resumeRun`.
 */
import { loadState, saveState, type Phase, type State } from "./state.ts";
import { resumeRun } from "./orchestrator.ts";

const RETRYABLE_PHASES: ReadonlySet<Phase> = new Set([
	"planning",
	"working",
	"pr_open",
	"ci_pending",
	"ci_fixing",
	"review",
	"merging",
	"verifying",
]);

/**
 * Walk the runLog backward to find the last phase that was active before
 * the run hit `needs_human`.
 */
function detectRetryPhase(state: State): Phase {
	for (let i = state.runLog.length - 1; i >= 0; i--) {
		const entry = state.runLog[i]!;
		if (entry.phase !== "needs_human" && RETRYABLE_PHASES.has(entry.phase)) {
			return entry.phase;
		}
	}
	return "planning";
}

export async function runRetry(cwd: string = process.cwd()): Promise<State> {
	const state = loadState(cwd);
	if (!state) {
		console.error("No active run found. Start one with: pitm start \"<goal>\"");
		process.exit(1);
	}

	if (state.phase === "done") {
		console.log("Run already completed. Nothing to retry.");
		console.log(`  Goal: ${state.goal}`);
		if (state.pr) console.log(`  PR:   ${state.pr.url}`);
		return state;
	}

	if (state.phase !== "needs_human") {
		console.log(`Run is still active (phase: ${state.phase}). Use \`pitm resume\` instead.`);
		return state;
	}

	const retryPhase = detectRetryPhase(state);
	console.log(`Retrying from phase: ${retryPhase}`);
	if (state.humanNote) {
		console.log(`  Previous error: ${state.humanNote.split("\n")[0]}`);
	}

	// Reset failed tasks back to pending so they can be re-attempted
	if (retryPhase === "working") {
		for (const t of state.tasks) {
			if (t.status === "failed") {
				t.status = "pending";
				t.attempts = 0;
			}
		}
	}

	state.phase = retryPhase;
	state.humanNote = undefined;
	saveState(state, cwd);

	return resumeRun(cwd);
}
