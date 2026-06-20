/**
 * Repo-local config (`.pitm/config.json`) with safe defaults.
 * Resolution: project config > defaults. Unknown keys are ignored, not fatal.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./errors.ts";

export const PITM_DIR = ".pitm";
export const CONFIG_PATH = join(PITM_DIR, "config.json");
export const STATE_PATH = join(PITM_DIR, "state.json");
export const MAILBOX_PATH = join(PITM_DIR, "mailbox.json");

export type PhaseName = "planner" | "worker" | "fixer" | "reviewer" | "verifier";

export interface PitmConfig {
	models: Partial<Record<PhaseName, string>>; // "provider/modelId"
	verifyCommand: string;
	git: {
		targetBranch: string;
		autoPush: boolean;
		autoMerge: boolean;
	};
	budget: {
		maxTokensPerRun: number;
		maxCiFixRetries: number;
	};
}

export const DEFAULT_CONFIG: PitmConfig = {
	models: {
		planner: "anthropic/claude-sonnet-4-6",
		worker: "opencode-go/glm-5.2",
		fixer: "openai-codex/gpt-5.4",
		reviewer: "anthropic/claude-sonnet-4-6",
		verifier: "opencode-go/glm-5.2",
	},
	verifyCommand: "bun run verify",
	git: { targetBranch: "main", autoPush: true, autoMerge: false },
	budget: { maxTokensPerRun: 2_000_000, maxCiFixRetries: 3 },
};

/** Load and merge config from `<cwd>/.pitm/config.json`. Missing file = defaults. */
export function loadConfig(cwd: string = process.cwd()): PitmConfig {
	const path = join(cwd, CONFIG_PATH);
	if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);

	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (e) {
		throw new ConfigError(`Failed to read ${CONFIG_PATH}: ${(e as Error).message}`);
	}

	let parsed: Partial<PitmConfig>;
	try {
		parsed = JSON.parse(raw) as Partial<PitmConfig>;
	} catch (e) {
		throw new ConfigError(`Failed to parse ${CONFIG_PATH}: ${(e as Error).message}`);
	}

	return mergeConfig(DEFAULT_CONFIG, parsed);
}

function mergeConfig(base: PitmConfig, override: Partial<PitmConfig>): PitmConfig {
	return {
		models: { ...base.models, ...(override.models ?? {}) },
		verifyCommand: override.verifyCommand ?? base.verifyCommand,
		git: { ...base.git, ...(override.git ?? {}) },
		budget: { ...base.budget, ...(override.budget ?? {}) },
	};
}

/** Split a "provider/modelId" string. Throws if malformed (no `/`). */
export function parseModelRef(ref: string): { provider: string; modelId: string } {
	const idx = ref.indexOf("/");
	if (idx <= 0 || idx >= ref.length - 1) {
		throw new ConfigError(
			`Invalid model reference "${ref}" — expected "provider/modelId".`,
		);
	}
	return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}
