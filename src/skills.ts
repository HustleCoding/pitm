/**
 * Loads pi agent skills for the code-writing phases (worker, fixer, reviewer).
 *
 * Skills are opt-in (`config.skills.enabled`). When enabled we load from:
 *   - pitm's bundled `skills/` directory (if `includeBundled`),
 *   - the target repo's `.pitm/skills/` directory (if present),
 *   - any extra `config.skills.paths` (absolute, or relative to the repo).
 *
 * The pi SDK appends each model-invocable skill's name + description to the
 * phase system prompt and lets the agent `read` the full SKILL.md on demand.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import type { PitmConfig } from "./config.ts";
import { PITM_DIR } from "./config.ts";

/** Absolute path to the skills shipped with pitm (`<repo root>/skills`). */
export const BUNDLED_SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

/** Directories to scan for skills, given the target repo cwd + config. */
export function resolveSkillDirs(cwd: string, config: PitmConfig): string[] {
	const dirs: string[] = [];
	if (config.skills.includeBundled) dirs.push(BUNDLED_SKILLS_DIR);
	dirs.push(join(cwd, PITM_DIR, "skills"));
	for (const p of config.skills.paths) {
		dirs.push(isAbsolute(p) ? p : join(cwd, p));
	}
	return dirs.filter((dir) => existsSync(dir));
}

/**
 * Load and merge skills from all configured directories. Returns an empty list
 * when skills are disabled. Later directories win on name collision so a repo's
 * own skill can override a bundled one.
 */
export function loadPitmSkills(cwd: string, config: PitmConfig): Skill[] {
	if (!config.skills.enabled) return [];
	const byName = new Map<string, Skill>();
	for (const dir of resolveSkillDirs(cwd, config)) {
		for (const skill of loadSkillsFromDir({ dir, source: "pitm" }).skills) {
			byName.set(skill.name, skill);
		}
	}
	return [...byName.values()];
}
