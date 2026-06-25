/**
 * CI loop: after a PR opens, watch its checks. On failure, spawn a bounded
 * fixer retry. On success, advance. On exhaustion, route to `needs_human`.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
	ghCheckLog,
	ghPrChecks,
	pushBranch,
	summarizeChecks,
	type CheckSummary,
} from "./git.ts";
import { commit, stagePaths, stageTracked } from "./git.ts";
import { runFixer, isEnvironmental } from "./phases/fixer.ts";
import { log, saveState, type State } from "./state.ts";
import { modelLabel } from "./models.ts";
import { phaseEnd, startSpinner, status, stopSpinner } from "./progress.ts";

export interface CiLoopOptions {
	cwd: string;
	state: State;
	fixerModel: Model<Api> | undefined;
	maxFixRetries: number;
	/** Rigor skills exposed to the fixer. Empty unless enabled in config. */
	skills?: Skill[];
	/** Per-poll delay and overall timeout (ms). */
	pollMs?: number;
	timeoutMs?: number;
}

export type CiOutcome = "success" | "fixed" | "failure" | "needs_human" | "environmental";

/** Watch CI to completion (success/failure), then run bounded fixer retries. */
export async function runCiLoop(opts: CiLoopOptions): Promise<CiOutcome> {
	const { cwd, state } = opts;
	if (!state.pr) throw new Error("CI loop requires an open PR.");
	const pollMs = opts.pollMs ?? 15_000;
	const timeoutMs = opts.timeoutMs ?? 30 * 60_000;

	// 1. Wait for the initial CI run to settle.
	status("waiting for CI checks…");
	startSpinner("polling CI…");
	let summary = await waitForChecks(state.pr.number, cwd, pollMs, timeoutMs);
	stopSpinner();
	log(state, "ci_pending", `Initial CI: ${summary.overall} (${summary.checks.length} checks).`);
	phaseEnd("CI", summary.overall);
	saveState(state, cwd);

	if (summary.overall === "success") return "success";
	if (summary.overall === "pending") return "needs_human"; // timed out waiting

	// 2. Bounded fixer retries.
	for (let attempt = 1; attempt <= opts.maxFixRetries; attempt++) {
		state.phase = "ci_fixing";
		if (!opts.fixerModel) {
			return needsHuman(state, cwd, "No fixer model resolved for CI fix loop.");
		}
		const failing = summary.checks.filter((c) => c.state === "failure");
		log(state, "ci_fixing", `Fix attempt ${attempt}/${opts.maxFixRetries} on ${failing.length} failing check(s) with ${modelLabel(opts.fixerModel)}`, modelLabel(opts.fixerModel));
		status(`fix attempt ${attempt}/${opts.maxFixRetries}: ${failing.length} failing check(s)`);
		saveState(state, cwd);

		const logs = await Promise.all(
			failing.map(async (c) => ({ name: c.name, log: await ghCheckLog(c, cwd) })),
		);

		let result;
		try {
			result = await runFixer({
				cwd,
				goal: state.goal,
				branch: state.branch,
				failingChecks: failing,
				logs,
				verifyCommand: state.verifyCommand,
				model: opts.fixerModel,
				skills: opts.skills,
			});
		} catch (e) {
			return needsHuman(state, cwd, `Fixer session errored: ${(e as Error).message}`);
		}
		state.budget.spentTokens += result.totalTokens;
		log(state, "ci_fixing", `Fixer done (${result.totalTokens} tokens). ${result.text.split("\n")[0]?.slice(0, 160)}`, result.model);

		if (isEnvironmental(result)) {
			return needsHuman(state, cwd, `Fixer flagged an environmental (non-code) CI failure:\n${result.text.slice(0, 600)}`);
		}

		// Commit + push the fix (only the files the fixer touched).
		try {
			await stageFixChanges(cwd, result.touchedPaths);
			await commit(`fix(ci): address failing checks (attempt ${attempt})\n\n${state.goal}`, cwd);
			await pushBranch(cwd);
		} catch (e) {
			return needsHuman(state, cwd, `Could not commit/push fix: ${(e as Error).message}`);
		}

		// Re-watch CI after the push.
		state.phase = "ci_pending";
		saveState(state, cwd);
		summary = await waitForChecks(state.pr.number, cwd, pollMs, timeoutMs);
		log(state, "ci_pending", `CI after fix ${attempt}: ${summary.overall}.`);
		saveState(state, cwd);
		if (summary.overall === "success") return "fixed";
		if (summary.overall === "pending") return needsHuman(state, cwd, "CI timed out (still pending) after a fix.");
	}

	return needsHuman(state, cwd, `CI still failing after ${opts.maxFixRetries} fix attempt(s).`);
}

/** Poll `gh pr checks` until all non-neutral checks are success/failure, or timeout. */
async function waitForChecks(
	prNumber: number,
	cwd: string,
	pollMs: number,
	timeoutMs: number,
): Promise<CheckSummary> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const checks = await ghPrChecks(prNumber, cwd);
		const summary = summarizeChecks(checks);
		if (summary.overall !== "pending") return summary;
		if (Date.now() >= deadline) return summary; // still pending -> caller treats as needs_human
		await sleep(pollMs);
	}
}

/** Stage only the fixer's touched files; fall back to tracked modifications. */
async function stageFixChanges(cwd: string, touchedPaths: string[]): Promise<void> {
	if (touchedPaths.length > 0) {
		await stagePaths(touchedPaths, cwd);
		return;
	}
	await stageTracked(cwd);
}

function needsHuman(state: State, cwd: string, message: string): CiOutcome {
	state.phase = "needs_human";
	state.humanNote = message;
	log(state, state.phase, message);
	saveState(state, cwd);
	return "needs_human";
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
