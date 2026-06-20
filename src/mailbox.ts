/**
 * Mailbox: durable queue of steering/follow-up messages for the running
 * orchestrator. Two surfaces:
 *
 *  1. `.pitm/state.json` `mailbox[]` — the source of truth the orchestrator
 *     polls during a worker turn and delivers via `session.steer()`.
 *  2. `.pitm/mailbox.json` — append-only file an external process (or the HTTP
 *     endpoint in `mailbox-server.ts`) writes to; the orchestrator merges it
 *     into state on each poll.
 *
 * Mid-run delivery is best-effort: messages land between worker tool turns.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAILBOX_PATH } from "./config.ts";
import type { AgentSessionLike } from "./agent.ts";
import type { MailboxEntry, State } from "./state.ts";

export function appendSteer(state: State, text: string, kind: "steer" | "followUp" = "steer"): void {
	state.mailbox.push({
		id: randomUUID(),
		text,
		kind,
		createdAt: new Date().toISOString(),
	});
}

/** Merge any new entries from the external mailbox.json into state. */
export function mergeExternalMailbox(state: State, cwd: string = process.cwd()): number {
	const path = join(cwd, MAILBOX_PATH);
	if (!existsSync(path)) return 0;
	let entries: Array<{ text?: string; createdAt?: string }> = [];
	try {
		entries = JSON.parse(readFileSync(path, "utf8")) as typeof entries;
	} catch {
		return 0;
	}
	const knownIds = new Set(state.mailbox.map((m) => m.id));
	const knownTexts = new Set(state.mailbox.map((m) => m.text));
	let added = 0;
	for (const e of entries) {
		if (!e.text || knownTexts.has(e.text)) continue;
		state.mailbox.push({
			id: randomUUID(),
			text: e.text,
			kind: "steer",
			createdAt: e.createdAt ?? new Date().toISOString(),
		});
		knownTexts.add(e.text);
		added += 1;
		void knownIds;
	}
	return added;
}

/**
 * Poll the mailbox while a phase session is running, delivering undelivered
 * entries to the live session. Returns a stop() function.
 *
 * Delivery: `steer` entries call `session.steer()`; `followUp` entries call
 * `session.followUp()`. Each entry is marked deliveredAt in state.
 */
export function startMailboxPoller(
	state: State,
	session: AgentSessionLike,
	pollMs = 2000,
): () => void {
	const timer = setInterval(async () => {
		const undelivered = state.mailbox.filter((m) => !m.deliveredAt);
		if (undelivered.length === 0) return;
		for (const entry of undelivered) {
			try {
				if (entry.kind === "followUp") await session.followUp(entry.text);
				else await session.steer(entry.text);
				entry.deliveredAt = new Date().toISOString();
			} catch {
				// Session may have disposed between polls; ignore.
			}
		}
	}, pollMs);
	return () => clearInterval(timer);
}

/** Undelivered mailbox entries, oldest first. */
export function pendingMailbox(state: State): MailboxEntry[] {
	return state.mailbox.filter((m) => !m.deliveredAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
