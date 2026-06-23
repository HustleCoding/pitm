/**
 * Persistent run history. Appends a summary to `.pitm/history.json` when a run
 * reaches a terminal phase (done | needs_human). Survives `pitm reset`.
 *
 *   pitm log          show past runs
 *   pitm log --json   machine-readable output
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PITM_DIR } from "./config.ts";
import type { State } from "./state.ts";

export const HISTORY_PATH = join(PITM_DIR, "history.json");

export interface RunSummary {
	goal: string;
	outcome: "done" | "needs_human";
	branch: string;
	pr?: { number: number; url: string };
	startedAt: string;
	finishedAt: string;
	tokensSpent: number;
	taskCount: number;
	tasksDone: number;
	tasksFailed: number;
	models: Record<string, string>;
	humanNote?: string;
}

function historyPath(cwd: string): string {
	return join(cwd, HISTORY_PATH);
}

export function loadHistory(cwd: string = process.cwd()): RunSummary[] {
	const path = historyPath(cwd);
	if (!existsSync(path)) return [];
	try {
		return JSON.parse(readFileSync(path, "utf8")) as RunSummary[];
	} catch {
		return [];
	}
}

export function appendHistory(state: State, cwd: string = process.cwd()): void {
	if (state.phase !== "done" && state.phase !== "needs_human") return;

	const entry: RunSummary = {
		goal: state.goal,
		outcome: state.phase,
		branch: state.branch,
		pr: state.pr,
		startedAt: state.createdAt,
		finishedAt: new Date().toISOString(),
		tokensSpent: state.budget.spentTokens,
		taskCount: state.tasks.length,
		tasksDone: state.tasks.filter((t) => t.status === "done").length,
		tasksFailed: state.tasks.filter((t) => t.status === "failed").length,
		models: state.modelByPhase,
		humanNote: state.humanNote,
	};

	const history = loadHistory(cwd);
	history.push(entry);
	mkdirSync(join(cwd, PITM_DIR), { recursive: true });
	writeFileSync(historyPath(cwd), JSON.stringify(history, null, 2) + "\n");
}

export function printLog(cwd: string = process.cwd(), json = false): void {
	const history = loadHistory(cwd);

	if (history.length === 0) {
		console.log("No run history yet. Start a run with: pitm start \"<goal>\"");
		return;
	}

	if (json) {
		console.log(JSON.stringify(history, null, 2));
		return;
	}

	console.log(`\n  Run history (${history.length} run${history.length === 1 ? "" : "s"}):\n`);

	for (let i = 0; i < history.length; i++) {
		const r = history[i]!;
		const num = `#${i + 1}`;
		const icon = r.outcome === "done" ? "✓" : "✗";
		const date = new Date(r.startedAt).toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
		const tokens = (r.tokensSpent / 1000).toFixed(1);
		const tasks = `${r.tasksDone}/${r.taskCount} tasks`;

		console.log(`  ${icon} ${num}  ${date}  ${r.outcome.toUpperCase()}`);
		console.log(`    Goal:   ${r.goal}`);
		console.log(`    Branch: ${r.branch}`);
		if (r.pr) console.log(`    PR:     ${r.pr.url}`);
		console.log(`    Tasks:  ${tasks}  |  Tokens: ${tokens}k`);
		if (r.humanNote) console.log(`    Note:   ${r.humanNote.split("\n")[0]}`);
		console.log("");
	}
}
