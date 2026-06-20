/**
 * File-based lock for the orchestrator state, so two `pitm` processes don't
 * race on the same run. Uses `proper-lockfile` (already a pi dependency).
 *
 * Lock is best-effort: if the library is unavailable we proceed without
 * locking (single-process is the common case). Holding the lock is advisory;
 * the real protection is that state.json is checkpointed atomically.
 */
import { lock, unlock, check } from "proper-lockfile";
import { join } from "node:path";
import { PITM_DIR } from "./config.ts";

const LOCK_PATH = join(PITM_DIR, "state.json");

export interface HeldLock {
	release: () => Promise<void>;
}

/** Acquire the orchestrator lock; throws if already held. */
export async function acquireLock(cwd: string = process.cwd()): Promise<HeldLock> {
	const target = join(cwd, LOCK_PATH);
	try {
		const locked = await check(target);
		if (locked) {
			throw new Error(`pitm: another orchestrator is already running in ${cwd}.`);
		}
		await lock(target, { retries: 0 });
	} catch (e) {
		if (/already|locked/i.test((e as Error).message)) {
			throw new Error(`pitm: another orchestrator is already running in ${cwd}.`);
		}
		// Library/import problem — degrade to no-op lock rather than crash.
		return { release: async () => {} };
	}
	return {
		release: async () => {
			try {
				await unlock(target);
			} catch {
				/* already released */
			}
		},
	};
}
