/**
 * Small, reusable ANSI color/style helpers for CLI output.
 *
 * All helpers are TTY-aware: they apply ANSI escape sequences only when the
 * target stream is a TTY and color hasn't been disabled. Otherwise (pipes,
 * redirected output, CI logs) they return the text unchanged so captured
 * output stays clean and machine-readable.
 *
 * Honors the de-facto environment conventions:
 *   - `NO_COLOR`     (any non-empty value)  → colors disabled
 *   - `FORCE_COLOR=0` / `FORCE_COLOR=false` → colors disabled
 *   - `FORCE_COLOR=1` (or any other truthy)  → colors forced ON
 *
 * Helpers target a specific stream so we can color stderr progress while
 * keeping stdout pristine. By default `stderr` is used (progress output).
 */

type Stream = NodeJS.WriteStream;

/** Whether ANSI colors should be emitted for the given stream. */
export function colorsEnabled(stream: Stream = process.stderr): boolean {
	const env = process.env;
	if (env.NO_COLOR != null && env.NO_COLOR !== "") return false;
	const force = env.FORCE_COLOR;
	if (force === "0" || force === "false") return false;
	if (force === "1" || force === "true" || force === "2" || force === "3") return true;
	return stream.isTTY ?? false;
}

const RESET = "\x1b[0m";

type Code = string;

/** Wrap `text` in ANSI `open`/`close` codes when colors are enabled. */
function wrap(stream: Stream, open: Code, text: string): string {
	if (!colorsEnabled(stream)) return text;
	return `${open}${text}${RESET}`;
}

// --- Foreground colors -----------------------------------------------------

export function green(text: string, stream: Stream = process.stderr): string {
	return wrap(stream, "\x1b[32m", text);
}

export function red(text: string, stream: Stream = process.stderr): string {
	return wrap(stream, "\x1b[31m", text);
}

export function cyan(text: string, stream: Stream = process.stderr): string {
	return wrap(stream, "\x1b[36m", text);
}

// --- Styles ----------------------------------------------------------------

export function dim(text: string, stream: Stream = process.stderr): string {
	return wrap(stream, "\x1b[2m", text);
}

export function bold(text: string, stream: Stream = process.stderr): string {
	return wrap(stream, "\x1b[1m", text);
}

/**
 * A horizontal rule spanning the terminal width (or `fallback` cols when not a
 * TTY). Returns a string of `─` characters; when colors are enabled it is
 * dimmed.
 */
export function hr(stream: Stream = process.stderr, fallback = 40): string {
	const width = stream.columns && stream.columns > 0 ? stream.columns : fallback;
	const line = "─".repeat(Math.max(0, width));
	return dim(line, stream);
}
