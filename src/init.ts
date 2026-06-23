/**
 * `pitm init` — interactive config wizard.
 * Detects available providers, lets user pick models per phase, writes .pitm/config.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { buildRegistry } from "./models.ts";
import { PITM_DIR, CONFIG_PATH, type PhaseName } from "./config.ts";

const PHASES: { key: PhaseName; label: string; hint: string }[] = [
	{ key: "planner", label: "Planner", hint: "reads codebase, produces task list (use a strong model)" },
	{ key: "worker", label: "Worker", hint: "implements tasks, runs verify command" },
	{ key: "fixer", label: "Fixer", hint: "reads CI failure logs, pushes fixes (fast + cheap works)" },
	{ key: "reviewer", label: "Reviewer", hint: "addresses PR review comments (use a strong model)" },
	{ key: "verifier", label: "Verifier", hint: "checks success criteria pass (use a strong model)" },
];

interface ProviderGroup {
	provider: string;
	displayName: string;
	models: { id: string; name: string; ref: string }[];
}

function groupByProvider(registry: ReturnType<typeof buildRegistry>["registry"]): ProviderGroup[] {
	const available = registry.getAvailable();
	const map = new Map<string, ProviderGroup>();

	for (const m of available) {
		const providerId = typeof m.provider === "string" ? m.provider : (m.provider as { id?: string }).id ?? "unknown";
		if (!map.has(providerId)) {
			map.set(providerId, {
				provider: providerId,
				displayName: registry.getProviderDisplayName(providerId),
				models: [],
			});
		}
		map.get(providerId)!.models.push({ id: m.id, name: m.name, ref: `${providerId}/${m.id}` });
	}

	// Sort: providers with more models first
	return [...map.values()].sort((a, b) => b.models.length - a.models.length);
}

class Prompt {
	private rl: ReturnType<typeof createInterface>;

	constructor() {
		this.rl = createInterface({ input: process.stdin, output: process.stdout });
	}

	async ask(question: string, defaultValue?: string): Promise<string> {
		const suffix = defaultValue ? ` [${defaultValue}]` : "";
		return new Promise((resolve) => {
			this.rl.question(`${question}${suffix}: `, (answer) => {
				resolve(answer.trim() || defaultValue || "");
			});
		});
	}

	async choose(question: string, options: string[], defaultIdx = 0): Promise<number> {
		console.log(`\n${question}`);
		for (let i = 0; i < options.length; i++) {
			const marker = i === defaultIdx ? "→" : " ";
			console.log(`  ${marker} ${i + 1}. ${options[i]}`);
		}
		const answer = await this.ask(`Choose (1-${options.length})`, String(defaultIdx + 1));
		const idx = parseInt(answer, 10) - 1;
		if (idx >= 0 && idx < options.length) return idx;
		return defaultIdx;
	}

	close(): void {
		this.rl.close();
	}
}

export async function runInit(cwd: string = process.cwd()): Promise<void> {
	const configPath = join(cwd, CONFIG_PATH);

	if (existsSync(configPath)) {
		const prompt = new Prompt();
		const answer = await prompt.ask("Config already exists at .pitm/config.json. Overwrite? (y/N)", "n");
		if (answer.toLowerCase() !== "y") {
			console.log("Cancelled.");
			prompt.close();
			return;
		}
		prompt.close();
	}

	console.log("\n┌─────────────────────────────────────┐");
	console.log("│       pitm init — config wizard     │");
	console.log("└─────────────────────────────────────┘\n");

	// Build registry to discover available models
	const { registry } = buildRegistry();
	const groups = groupByProvider(registry);

	if (groups.length === 0) {
		console.error("No authenticated providers found.");
		console.error("Set an API key first:\n");
		console.error("  export OPENROUTER_API_KEY=\"sk-or-v1-...\"   # easiest: one key, all models");
		console.error("  export ANTHROPIC_API_KEY=\"sk-ant-...\"      # direct Anthropic");
		console.error("  export OPENAI_API_KEY=\"sk-...\"             # direct OpenAI\n");
		console.error("Or store keys in ~/.pi/agent/auth.json. Then re-run: pitm init");
		process.exit(1);
	}

	const prompt = new Prompt();

	// Show available providers
	console.log("Detected providers with authenticated models:\n");
	for (const g of groups) {
		console.log(`  • ${g.displayName} (${g.provider}) — ${g.models.length} models`);
	}

	// Routing mode: single provider vs mix-and-match
	let mixProviders = false;
	if (groups.length === 1) {
		console.log(`\nUsing: ${groups[0]!.displayName} (only authenticated provider)`);
	} else {
		const routingIdx = await prompt.choose(
			"How do you want to assign models?",
			[
				"Use one provider for all phases",
				"Mix providers — pick a different provider per phase",
			],
		);
		mixProviders = routingIdx === 1;
	}

	// Pick model for each phase
	const models: Partial<Record<PhaseName, string>> = {};

	if (!mixProviders) {
		// Single-provider mode (original flow)
		let selectedGroup: ProviderGroup;
		if (groups.length === 1) {
			selectedGroup = groups[0]!;
		} else {
			const providerIdx = await prompt.choose(
				"Which provider?",
				groups.map((g) => `${g.displayName} (${g.models.length} models)`),
			);
			selectedGroup = groups[providerIdx]!;
		}

		const modelOptions = selectedGroup.models.map((m) => `${m.name} (${m.id})`);
		console.log(`\nPick a model for each phase (from ${selectedGroup.displayName}):\n`);

		for (const phase of PHASES) {
			console.log(`  ${phase.label}: ${phase.hint}`);
			const idx = await prompt.choose(
				`  Model for ${phase.label}:`,
				modelOptions,
				0,
			);
			models[phase.key] = selectedGroup.models[idx]!.ref;
			console.log(`  ✓ ${phase.label} → ${selectedGroup.models[idx]!.ref}\n`);
		}
	} else {
		// Multi-provider mode: pick provider + model per phase
		console.log("\nPick a provider and model for each phase:\n");

		for (const phase of PHASES) {
			console.log(`  ${phase.label}: ${phase.hint}`);

			const providerIdx = await prompt.choose(
				`  Provider for ${phase.label}:`,
				groups.map((g) => `${g.displayName} (${g.models.length} models)`),
			);
			const group = groups[providerIdx]!;
			const modelOptions = group.models.map((m) => `${m.name} (${m.id})`);
			const modelIdx = await prompt.choose(
				`  Model for ${phase.label} (${group.displayName}):`,
				modelOptions,
				0,
			);
			models[phase.key] = group.models[modelIdx]!.ref;
			console.log(`  ✓ ${phase.label} → ${group.models[modelIdx]!.ref}\n`);
		}
	}

	// Verify command
	console.log("");
	const verifyCommand = await prompt.ask(
		"Verify command (proves work is correct — e.g. npm test, bun run typecheck, cargo test)",
		detectVerifyCommand(cwd),
	);

	// Target branch
	const targetBranch = await prompt.ask("Target branch for PRs", detectTargetBranch(cwd));

	// Auto-merge?
	const autoMergeAnswer = await prompt.ask("Auto-merge PRs after CI + review + verify? (y/N)", "n");
	const autoMerge = autoMergeAnswer.toLowerCase() === "y";

	prompt.close();

	// Write config
	const config = {
		models,
		verifyCommand,
		git: {
			targetBranch,
			autoPush: true,
			autoMerge,
		},
		budget: {
			maxTokensPerRun: 2_000_000,
			maxCiFixRetries: 3,
		},
	};

	mkdirSync(join(cwd, PITM_DIR), { recursive: true });
	writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

	// Add .pitm/ to .gitignore if not already there
	const gitignorePath = join(cwd, ".gitignore");
	const gitignoreContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
	if (!gitignoreContent.includes(".pitm")) {
		writeFileSync(gitignorePath, gitignoreContent + (gitignoreContent.endsWith("\n") ? "" : "\n") + ".pitm/\n");
		console.log("\n✓ Added .pitm/ to .gitignore");
	}

	console.log(`\n✓ Config written to ${CONFIG_PATH}`);
	console.log("\nNext steps:");
	console.log("  pitm doctor              # verify everything works");
	console.log("  pitm start \"<goal>\"      # run the full pipeline");
}

function detectVerifyCommand(cwd: string): string {
	if (existsSync(join(cwd, "package.json"))) {
		try {
			const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
			if (pkg.scripts?.test && pkg.scripts.test !== "echo \"Error: no test specified\" && exit 1") return "npm test";
			if (pkg.scripts?.typecheck) return "npm run typecheck";
			if (pkg.scripts?.check) return "npm run check";
			if (pkg.scripts?.verify) return "npm run verify";
		} catch { /* ignore */ }
		// Check if bun project
		if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bunfig.toml"))) {
			return "bun run typecheck";
		}
		return "npm test";
	}
	if (existsSync(join(cwd, "Cargo.toml"))) return "cargo test";
	if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) return "pytest";
	if (existsSync(join(cwd, "go.mod"))) return "go test ./...";
	if (existsSync(join(cwd, "Makefile"))) return "make test";
	return "npm test";
}

function detectTargetBranch(cwd: string): string {
	// Check git HEAD refs
	try {
		const packed = join(cwd, ".git", "packed-refs");
		if (existsSync(packed)) {
			const content = readFileSync(packed, "utf8");
			if (content.includes("refs/remotes/origin/main")) return "main";
			if (content.includes("refs/remotes/origin/master")) return "master";
		}
	} catch { /* fallback */ }
	// Check for refs/remotes/origin/main or master
	if (existsSync(join(cwd, ".git", "refs", "remotes", "origin", "main"))) return "main";
	if (existsSync(join(cwd, ".git", "refs", "remotes", "origin", "master"))) return "master";
	return "main";
}
