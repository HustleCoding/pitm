/**
 * `pitm config` — view and edit individual config values.
 *
 *   pitm config                   print full config
 *   pitm config get <key>         print a single value (dot-notation)
 *   pitm config set <key> <val>   update a single value and write back
 *
 * Dot-notation keys: models.planner, git.targetBranch, budget.maxTokensPerRun, etc.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, PITM_DIR, loadConfig } from "./config.ts";

type ConfigObj = Record<string, unknown>;

function getNestedValue(obj: ConfigObj, path: string): unknown {
	const parts = path.split(".");
	let current: unknown = obj;
	for (const key of parts) {
		if (current === null || current === undefined || typeof current !== "object") return undefined;
		current = (current as ConfigObj)[key];
	}
	return current;
}

function setNestedValue(obj: ConfigObj, path: string, value: unknown): void {
	const parts = path.split(".");
	let current: ConfigObj = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const key = parts[i]!;
		if (typeof current[key] !== "object" || current[key] === null) {
			current[key] = {};
		}
		current = current[key] as ConfigObj;
	}
	current[parts[parts.length - 1]!] = value;
}

function coerceValue(raw: string): unknown {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (/^\d+$/.test(raw)) return Number(raw);
	return raw;
}

const KNOWN_KEYS = [
	"models.planner",
	"models.worker",
	"models.fixer",
	"models.reviewer",
	"models.verifier",
	"verifyCommand",
	"git.targetBranch",
	"git.autoPush",
	"git.autoMerge",
	"budget.maxTokensPerRun",
	"budget.maxCiFixRetries",
];

export function runConfigCommand(args: string[], cwd: string = process.cwd()): void {
	const [sub, key, ...rest] = args;

	if (!sub || sub === "list") {
		// Print full config
		const config = loadConfig(cwd);
		console.log(JSON.stringify(config, null, 2));
		return;
	}

	if (sub === "get") {
		if (!key) {
			console.error("Usage: pitm config get <key>");
			console.error(`\nAvailable keys:\n${KNOWN_KEYS.map((k) => `  ${k}`).join("\n")}`);
			process.exit(1);
		}
		const config = loadConfig(cwd);
		const value = getNestedValue(config as unknown as ConfigObj, key);
		if (value === undefined) {
			console.error(`Key "${key}" not found in config.`);
			console.error(`\nAvailable keys:\n${KNOWN_KEYS.map((k) => `  ${k}`).join("\n")}`);
			process.exit(1);
		}
		if (typeof value === "object") {
			console.log(JSON.stringify(value, null, 2));
		} else {
			console.log(String(value));
		}
		return;
	}

	if (sub === "set") {
		if (!key || rest.length === 0) {
			console.error("Usage: pitm config set <key> <value>");
			console.error(`\nAvailable keys:\n${KNOWN_KEYS.map((k) => `  ${k}`).join("\n")}`);
			process.exit(1);
		}
		const rawValue = rest.join(" ");
		const configPath = join(cwd, CONFIG_PATH);

		// Read existing raw config (not merged with defaults)
		let rawConfig: ConfigObj = {};
		if (existsSync(configPath)) {
			try {
				rawConfig = JSON.parse(readFileSync(configPath, "utf8")) as ConfigObj;
			} catch {
				rawConfig = {};
			}
		}

		const value = coerceValue(rawValue);
		setNestedValue(rawConfig, key, value);

		mkdirSync(join(cwd, PITM_DIR), { recursive: true });
		writeFileSync(configPath, JSON.stringify(rawConfig, null, 2) + "\n");
		console.log(`${key} = ${typeof value === "string" ? `"${value}"` : value}`);
		return;
	}

	console.error(`Unknown config subcommand: ${sub}`);
	console.error("Usage: pitm config [get <key> | set <key> <value>]");
	process.exit(1);
}
