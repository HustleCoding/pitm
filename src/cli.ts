/**
 * CLI entrypoint. Small hand-rolled subcommand dispatcher (no extra dep).
 *
 *   pitm init                 interactive config wizard — pick provider + models
 *   pitm start "<goal>"       plan -> work -> PR -> CI -> review -> verify -> (merge)
 *   pitm resume               resume the current run from its saved phase
 *   pitm retry                retry a run stuck at needs_human
 *   pitm status               show the current run's phase, tasks, and PR
 *   pitm log [--json]         show persistent run history
 *   pitm config [get|set]     view or edit config values
 *   pitm doctor               check pi auth, gh, git, config, and models
 *   pitm steer "<message>"    append a steering message to the mailbox
 *   pitm watch [--port N]     start the HTTP mailbox endpoint for external injects
 */
import { planOnly, startRun, resumeRun } from "./orchestrator.ts";
import { runDoctor } from "./doctor.ts";
import { runInit } from "./init.ts";
import { runRetry } from "./retry.ts";
import { printLog } from "./history.ts";
import { runConfigCommand } from "./config-cmd.ts";
import { requireState, saveState } from "./state.ts";
import { isPitmError } from "./errors.ts";
import { appendSteer, mergeExternalMailbox } from "./mailbox.ts";
import { startMailboxServer } from "./mailbox-server.ts";
import { MAILBOX_PATH } from "./config.ts";
import { bold, cyan, dim, green, red } from "./ui.ts";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";

/** stdout stream — color helpers target this so summary/plan output is colored. */
const stdout = process.stdout;

/**
 * Resolve the effective working directory.
 *
 * 1. Explicit --cwd flag (if present).
 * 2. $PWD — the shell-set working directory; survives symlink traversal that
 *    can sometimes cause `process.cwd()` to return the linked-package dir
 *    instead of the user's project dir (observed with `bun link`).
 * 3. process.cwd() — OS-reported cwd (fallback).
 */
function resolveWorkingDirectory(cwdOverride?: string): string {
	if (cwdOverride) return resolvePath(cwdOverride);
	const env = process.env["PWD"];
	if (env) return resolvePath(env);
	return process.cwd();
}

/** Strip --cwd flag from argv, returning { cwd, rest }. */
function extractCwdFlag(argv: string[]): { cwdOverride?: string; rest: string[] } {
	const rest: string[] = [];
	let cwdOverride: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--cwd" && argv[i + 1]) {
			cwdOverride = argv[++i];
			continue;
		}
		const m = a.match(/^--cwd=(.+)$/);
		if (m) {
			cwdOverride = m[1];
			continue;
		}
		rest.push(a);
	}
	return { cwdOverride, rest };
}

function usage(): never {
	const d = (s: string) => dim(s, stdout);
	console.log(`${bold("pitm", stdout)} ${dim("— autonomous task orchestration over the pi SDK", stdout)}

${bold("Setup", stdout)}
  pitm init                  ${d("Interactive setup: pick provider, models, settings.")}
  pitm doctor                ${d("Check pi auth, gh, git, config, and models.")}
  pitm config [get|set]      ${d("View or edit .pitm/config.json values.")}

${bold("Run", stdout)}
  pitm start "<goal>" [--dry-plan] [--planner provider/modelId] [--force]
                             ${d("Plan + full pipeline, or just plan with --dry-plan.")}
  pitm resume                ${d("Resume the current run from its saved phase.")}
  pitm retry                 ${d("Retry a run stuck at needs_human.")}
  pitm steer "<message>"     ${d("Append a steering message to the mailbox.")}
  pitm watch [--port N]      ${d("Start the HTTP mailbox endpoint (default :7331).")}

${bold("Inspect", stdout)}
  pitm status [--json]       ${d("Show the current run's phase, tasks, and PR.")}
  pitm log [--json]          ${d("Show persistent run history across all past runs.")}
  pitm reset                 ${d("Delete .pitm/state.json and mailbox.json to start fresh.")}

${bold("Global flags", stdout)}
  --cwd <dir>                ${d("Set the working directory (default: $PWD or process.cwd()).")}

${d("State lives in .pitm/state.json (one run per repo).")}`);
	process.exit(2);
}

async function main(argv: string[]): Promise<void> {
	const { cwdOverride, rest: strippedArgv } = extractCwdFlag(argv);
	const cwd = resolveWorkingDirectory(cwdOverride);

	const [cmd, ...rest] = strippedArgv;
	switch (cmd) {
		case "init": {
			await runInit(cwd);
			return;
		}
		case "start": {
			const { goal, dryPlan, planner, force } = parseStartArgs(rest);
			if (!goal) usage();
			await withSigint(cwd, async () => {
				if (dryPlan) {
					const preview = await planOnly({ goal, cwd, plannerOverride: planner });
					printPlanPreview(preview);
					return;
				}
				if (force) await clearExistingRun(cwd);
				const state = await startRun({ goal, cwd });
				printSummary(state);
			});
			return;
		}
		case "resume": {
			await withSigint(cwd, async () => {
				const state = await resumeRun(cwd);
				printSummary(state);
			});
			return;
		}
		case "retry": {
			await withSigint(cwd, async () => {
				const state = await runRetry(cwd);
				printSummary(state);
			});
			return;
		}
		case "status": {
			const json = rest.includes("--json");
			try {
				const state = requireState(cwd);
				if (json) {
					console.log(JSON.stringify(state, null, 2));
				} else {
					printSummary(state);
				}
			} catch (e) {
				console.log(`No active pi-task-master run in this repo. Start one with: pitm start "<goal>"`);
				process.exit(0);
			}
			return;
		}
		case "log": {
			const json = rest.includes("--json");
			printLog(cwd, json);
			return;
		}
		case "config": {
			runConfigCommand(rest, cwd);
			return;
		}
		case "doctor": {
			const { allRequiredPassed } = await runDoctor(cwd);
			process.exit(allRequiredPassed ? 0 : 1);
		}
		case "steer": {
			const text = rest.join(" ").trim();
			if (!text) usage();
			let state;
			try {
				state = requireState(cwd);
			} catch {
				console.error("No active run to steer. Start one first: pitm start \"<goal>\"");
				process.exit(1);
			}
			appendSteer(state, text);
			saveState(state, cwd);
			appendToMailboxFile(text, cwd);
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
		case "reset": {
			const statePath = join(cwd, ".pitm", "state.json");
			const mailboxPath = join(cwd, ".pitm", "mailbox.json");
			try { unlinkSync(statePath); } catch { /* */ }
			try { unlinkSync(mailboxPath); } catch { /* */ }
			console.log("State cleared. You can start a fresh run with: pitm start \"<goal>\"");
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
async function clearExistingRun(cwd: string): Promise<void> {
	let state;
	try {
		state = requireState(cwd);
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
	try { unlinkSync(join(cwd, ".pitm", "state.json")); } catch { /* */ }
	try { unlinkSync(join(cwd, ".pitm", "mailbox.json")); } catch { /* */ }
	console.log(`Cleared previous run (${state.phase}): "${state.goal}".`);
	if (branch) {
		try {
			const { deleteBranch, currentBranch } = await import("./git.ts");
			const cur = await currentBranch(cwd).catch(() => "");
			if (branch !== cur) await deleteBranch(branch, cwd).catch(() => {});
		} catch { /* branch cleanup is best-effort */ }
	}
}

function printPlanPreview(preview: { goal: string; model: string; tasks: Array<{ id: string; title: string; details: string; successCriteria: string[] }> }): void {
	const c = (s: string) => cyan(s, stdout);
	const dn = (s: string) => dim(s, stdout);
	console.log(`\nGoal:   ${preview.goal}`);
	console.log(`Model:  ${preview.model}`);
	console.log(`Tasks:  ${preview.tasks.length}`);
	for (const t of preview.tasks) {
		console.log(`\n  ${c(t.id)}: ${t.title}`);
		console.log(`    ${dn(t.details.split("\n").join("\n    "))}`);
		if (t.successCriteria.length > 0) {
			console.log(`    ${dn("Success criteria:")}`);
			for (const c2 of t.successCriteria) console.log(`      ${dn("- " + c2)}`);
		}
	}
	console.log(`\n${dn("(dry-plan: no branch, no state, no PR created.)")}`);
}

function printSummary(state: ReturnType<typeof requireState>): void {
	const g = (s: string) => green(s, stdout);
	const r = (s: string) => red(s, stdout);
	const c = (s: string) => cyan(s, stdout);
	const dn = (s: string) => dim(s, stdout);

	const phaseColor = state.phase === "done" ? g : state.phase === "needs_human" ? r : c;

	console.log(`\nGoal:   ${state.goal}`);
	console.log(`Phase:  ${phaseColor(state.phase)}`);
	console.log(`Branch: ${dn(state.branch)}`);
	if (state.pr) console.log(`PR:     ${c(state.pr.url)}`);
	if (state.humanNote) console.log(`Note:   ${r(state.humanNote)}`);
	if (state.tasks.length === 0) {
		const note = state.phase === "done"
			? "(none — planner found nothing to implement for this goal)"
			: "(none yet)";
		console.log(`Tasks:  ${dn(note)}`);
	} else {
		console.log(`Tasks:`);
		for (const t of state.tasks) {
			const mark = t.status === "done" ? g("✓")
				: t.status === "failed" ? r("✗")
				: t.status === "in_progress" ? c("→")
				: dn(" ");
			console.log(`  ${mark} ${c(t.id)}: ${t.title} ${dn(`[${t.status}]`)}`);
		}
	}
	const spent = (state.budget.spentTokens / 1000).toFixed(1);
	console.log(`Budget: ${dn(`${spent}k / ${state.budget.maxTokensPerRun / 1000}k tokens`)}`);
	const pending = state.mailbox.filter((m) => !m.deliveredAt).length;
	if (pending > 0) console.log(`Mailbox: ${dn(`${pending} undelivered`)}`);
}

function appendToMailboxFile(text: string, cwd: string): void {
	const dir = join(cwd, ".pitm");
	mkdirSync(dir, { recursive: true });
	const path = join(cwd, MAILBOX_PATH);
	const existing = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown[]) : [];
	existing.push({ id: randomUUID(), text, createdAt: new Date().toISOString() });
	writeFileSync(path, JSON.stringify(existing, null, 2));
}

/** Wrap a long-running action so SIGINT saves state cleanly instead of corrupting it. */
async function withSigint(cwd: string, fn: () => Promise<void>): Promise<void> {
	const handler = () => {
		console.error("\nSIGINT: saving state and exiting. Run `pitm resume` to continue.");
		try {
			const s = requireState(cwd);
			mergeExternalMailbox(s, cwd);
			saveState(s, cwd);
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
			const s = requireState(cwd);
			if (!isRunExists && isActivePhase(s.phase)) {
				s.phase = "needs_human";
				s.humanNote = (e as Error).message;
				saveState(s, cwd);
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
