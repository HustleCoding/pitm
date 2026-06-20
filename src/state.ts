/**
 * Durable orchestrator state. One file per goal: `<cwd>/.pitm/state.json`.
 * Checkpointed at every phase transition so `pitm resume` loses no work.
 *
 * Phase 1 only exercises: planning -> working -> pr_open -> done.
 * The remaining phases exist in the type but route to `needs_human`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_PATH } from "./config.ts";
import { StateError } from "./errors.ts";

export type Phase =
	| "planning"
	| "working"
	| "pr_open"
	| "ci_pending"
	| "ci_fixing"
	| "review"
	| "merging"
	| "verifying"
	| "done"
	| "needs_human";

export type TaskStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";

export interface Task {
	id: string; // "T1"
	title: string;
	details: string;
	successCriteria: string[];
	status: TaskStatus;
	attempts: number;
	commitSha?: string;
}

export interface MailboxEntry {
	id: string;
	text: string;
	kind: "steer" | "followUp";
	createdAt: string;
	deliveredAt?: string;
}

export interface RunLogEntry {
	ts: string;
	phase: Phase;
	model?: string;
	message: string;
}

export interface State {
	goal: string;
	phase: Phase;
	createdAt: string;
	updatedAt: string;
	branch: string;
	baseBranch: string;
	verifyCommand: string;
	tasks: Task[];
	currentTaskId?: string;
	modelByPhase: Record<string, string>;
	budget: { maxTokensPerRun: number; spentTokens: number };
	mailbox: MailboxEntry[];
	runLog: RunLogEntry[];
	pr?: { number: number; url: string };
	humanNote?: string;
}

export function statePath(cwd: string = process.cwd()): string {
	return join(cwd, STATE_PATH);
}

export function loadState(cwd: string = process.cwd()): State | undefined {
	const path = statePath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf8");
		return JSON.parse(raw) as State;
	} catch (e) {
		throw new StateError(`Failed to read ${STATE_PATH}: ${(e as Error).message}`);
	}
}

export function saveState(state: State, cwd: string = process.cwd()): void {
	const path = statePath(cwd);
	try {
		mkdirSync(dirname(path), { recursive: true });
		state.updatedAt = new Date().toISOString();
		writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	} catch (e) {
		throw new StateError(`Failed to write ${STATE_PATH}: ${(e as Error).message}`);
	}
}

export function log(
	state: State,
	phase: Phase,
	message: string,
	model?: string,
): void {
	state.runLog.push({
		ts: new Date().toISOString(),
		phase,
		model,
		message,
	});
}

export function requireState(cwd: string = process.cwd()): State {
	const s = loadState(cwd);
	if (!s) {
		throw new StateError(
			`No active run found at ${STATE_PATH}. Start one with: pitm start "<goal>"`,
		);
	}
	return s;
}

/** Crude token-budget check. Returns false when the run would exceed the cap. */
export function budgetExhausted(state: State): boolean {
	return state.budget.spentTokens >= state.budget.maxTokensPerRun;
}
