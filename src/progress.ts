/**
 * Live progress reporter. Prints phase transitions, agent tool calls, and a
 * spinner during idle waits so the user can tell `pitm` is working (and what
 * it's doing) instead of staring at a blank screen for minutes.
 *
 * Output goes to stderr so it never pollutes captured stdout (e.g. `pitm
 * status | jq`).
 *
 *   ▸ planning        glm-5.2
 *    ↳ read  src/cli.ts
 *    ↳ grep  "healthz"
 *    ⟳ thinking…        ← spinner while the model is generating
 *  ✓ planning done (1 task, 3.5k tokens, 12s)
 */
import { isatty } from "node:tty";

const out = process.stderr;
let spinnerActive = false;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;
let phaseStartTime = 0;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function write(s: string): void {
	out.write(s);
}

function clearLine(): void {
	if (isatty(out.fd)) {
		write("\r\x1b[K");
	} else {
		write("\n");
	}
}

export function startSpinner(label: string): void {
	if (!isatty(out.fd)) {
		// Non-TTY: print once, don't animate (logs/CI).
		write(`  ⟳ ${label}\n`);
		return;
	}
	if (spinnerTimer) clearInterval(spinnerTimer);
	let i = 0;
	spinnerActive = true;
	spinnerTimer = setInterval(() => {
		write(`\r\x1b[K  ${SPINNER[i % SPINNER.length]} ${label}`);
		i++;
	}, 80);
}

export function stopSpinner(): void {
	if (spinnerTimer) {
		clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	}
	if (spinnerActive && isatty(out.fd)) {
		write("\r\x1b[K");
	}
	spinnerActive = false;
}

/** Print a phase banner when the orchestrator enters a new phase. */
export function phaseBegin(phase: string, model?: string): void {
	stopSpinner();
	phaseStartTime = Date.now();
	const modelPart = model ? `  ${model}` : "";
	write(`\n▸ ${phase}${modelPart}\n`);
}

/** Print a phase completion line with elapsed time + tokens. */
export function phaseEnd(phase: string, detail: string, tokens?: number): void {
	stopSpinner();
	const elapsed = phaseStartTime ? Math.round((Date.now() - phaseStartTime) / 1000) : 0;
	const tokPart = tokens != null ? `, ${(tokens / 1000).toFixed(1)}k tokens` : "";
	write(`✓ ${phase} done (${detail}${tokPart}, ${elapsed}s)\n`);
}

/** A single tool call, printed inline as it starts. */
export function toolCall(name: string, args: unknown): void {
	stopSpinner();
	const arg = summarizeToolArgs(name, args);
	write(`  ↳ ${name.padEnd(6)} ${arg}\n`);
}

/** A tool finished (best-effort status). */
export function toolEnd(_name: string, isError: boolean): void {
	void _name;
	if (isError) write(`    ⚠ tool error\n`);
}

/** A free-form status line from the orchestrator (e.g. "Opening PR…"). */
export function status(message: string): void {
	stopSpinner();
	write(`  ${message}\n`);
}

/** The agent started producing text — stop the spinner, let deltas stream. */
export function textStreaming(): void {
	stopSpinner();
}

function summarizeToolArgs(name: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	switch (name) {
		case "read":
			return String(a.path ?? "");
		case "bash":
			return truncate(String(a.command ?? ""), 80);
		case "edit":
			return String(a.path ?? "");
		case "write":
			return String(a.path ?? "");
		case "grep":
			return `"${String(a.pattern ?? "")}"${a.path ? ` in ${a.path}` : ""}`;
		case "find":
			return String(a.path ?? "");
		case "ls":
			return String(a.path ?? "");
		default:
			return truncate(JSON.stringify(a).replace(/[{}"]/g, ""), 80);
	}
}

function truncate(s: string, n: number): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n)}…` : one;
}

/** Stop everything (called on exit). */
export function finish(): void {
	stopSpinner();
}
