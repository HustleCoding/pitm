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
import { startRun, resumeRun } from "./orchestrator.ts";
import { runDoctor } from "./doctor.ts";
import { requireState, saveState } from "./state.ts";
import { isPitmError } from "./errors.ts";
import { appendSteer, mergeExternalMailbox } from "./mailbox.ts";
import { startMailboxServer } from "./mailbox-server.ts";
import { MAILBOX_PATH } from "./config.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function usage(): never {
	console.log(`pi-task-master — autonomous task orchestration over the pi SDK

Usage:
  pitm start "<goal>"        Plan, implement, open PR, run CI/review/verify, (merge).
  pitm resume                Resume the current run from its saved phase.
  pitm status                Show the current run's phase, tasks, and PR.
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
			try {
				printSummary(requireState());
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
		try {
			const s = requireState();
			s.phase = "needs_human";
			s.humanNote = (e as Error).message;
			saveState(s);
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
