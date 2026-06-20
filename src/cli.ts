/**
 * CLI entrypoint. Small hand-rolled subcommand dispatcher (no extra dep).
 *
 *   pitm start "<goal>"
 *   pitm resume
 *   pitm status
 *   pitm doctor
 *   pitm steer "<message>"
 */
import { startRun, resumeRun } from "./orchestrator.ts";
import { runDoctor } from "./doctor.ts";
import { requireState, saveState } from "./state.ts";
import { isPitmError } from "./errors.ts";
import { MAILBOX_PATH } from "./config.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function usage(): never {
	console.log(`pi-task-master — autonomous task orchestration over the pi SDK

Usage:
  pitm start "<goal>"        Plan, implement, and open a PR for the goal.
  pitm resume                Resume the current run from its saved phase.
  pitm status                Show the current run's phase, tasks, and PR.
  pitm doctor                Check pi auth, gh, git, config, and models.
  pitm steer "<message>"     Append a steering message to the mailbox.

State lives in .pitm/state.json (one run per repo).`);
	process.exit(2);
}

async function main(argv: string[]): Promise<void> {
	const [cmd, ...rest] = argv;
	switch (cmd) {
		case "start": {
			const goal = rest.join(" ").trim();
			if (!goal) usage();
			await withSigint(async () => {
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
			const state = requireState();
			printSummary(state);
			return;
		}
		case "doctor": {
			const { allRequiredPassed } = await runDoctor();
			process.exit(allRequiredPassed ? 0 : 1);
		}
		case "steer": {
			const text = rest.join(" ").trim();
			if (!text) usage();
			appendSteer(text);
			console.log("Steering message queued. It will be delivered to the next worker turn.");
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

function printSummary(state: ReturnType<typeof requireState>): void {
	console.log(`\nGoal:   ${state.goal}`);
	console.log(`Phase:  ${state.phase}`);
	console.log(`Branch: ${state.branch}`);
	if (state.pr) console.log(`PR:     ${state.pr.url}`);
	if (state.humanNote) console.log(`Note:   ${state.humanNote}`);
	console.log(`Tasks:`);
	for (const t of state.tasks) {
		const mark = t.status === "done" ? "✓" : t.status === "failed" ? "✗" : t.status === "in_progress" ? "→" : " ";
		console.log(`  ${mark} ${t.id}: ${t.title} [${t.status}]`);
	}
	const spent = (state.budget.spentTokens / 1000).toFixed(1);
	console.log(`Budget: ${spent}k / ${state.budget.maxTokensPerRun / 1000}k tokens`);
}

function appendSteer(text: string): void {
	const state = requireState();
	state.mailbox.push({
		id: randomUUID(),
		text,
		kind: "steer",
		createdAt: new Date().toISOString(),
	});
	saveState(state);
	// Also write a standalone mailbox file so an external process can append.
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
		const s = requireState();
		saveState(s);
		process.exit(130);
	};
	process.on("SIGINT", handler);
	try {
		await fn();
	} catch (e) {
		const s = requireState();
		s.phase = "needs_human";
		s.humanNote = (e as Error).message;
		saveState(s);
		console.error(`\nRun halted: ${(e as Error).message}`);
		if (!isPitmError(e)) console.error((e as Error).stack);
		process.exit(1);
	} finally {
		process.off("SIGINT", handler);
	}
}

await main(process.argv.slice(2));
