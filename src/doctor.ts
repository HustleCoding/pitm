/**
 * `pitm doctor` — verify the environment the orchestrator depends on.
 * Runs each check independently and reports pass/fail. Exits non-zero if any
 * required check fails, with an actionable message.
 */
import { existsSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig, parseModelRef, type PhaseName } from "./config.ts";
import { buildRegistry, resolveAll } from "./models.ts";
import { currentBranch, ghAuthStatus } from "./git.ts";
import { bold, dim, green, red, yellow } from "./ui.ts";

const out = process.stdout;

interface Check {
	name: string;
	ok: boolean;
	detail: string;
	required: boolean;
}

export interface DoctorReport {
	allRequiredPassed: boolean;
	checks: Check[];
}

export async function runDoctor(cwd: string = process.cwd()): Promise<DoctorReport> {
	const checks: Check[] = [];

	// 1. pi agent dir + auth
	const agentDir = getAgentDir();
	const authPath = `${agentDir}/auth.json`;
	checks.push({
		name: "pi auth.json",
		ok: existsSync(authPath),
		detail: authPath,
		required: true,
	});

	// 2. config loadable
	let config;
	try {
		config = loadConfig(cwd);
		checks.push({ name: ".pitm/config.json", ok: true, detail: "loaded (or defaults)", required: true });
	} catch (e) {
		checks.push({ name: ".pitm/config.json", ok: false, detail: (e as Error).message, required: true });
		return report(checks);
	}

	// 3. models resolvable
	try {
		const { registry } = buildRegistry();
		const byPhase = resolveAll(registry, config.models);
		const missing: string[] = [];
		for (const k of Object.keys(config.models) as PhaseName[]) {
			const ref = config.models[k];
			if (ref && !byPhase[k]) missing.push(ref);
		}
		if (missing.length > 0) {
			checks.push({
				name: "model resolution",
				ok: false,
				detail: `unresolved: ${missing.join(", ")}`,
				required: true,
			});
		} else {
			checks.push({ name: "model resolution", ok: true, detail: "all routed models found", required: true });
		}
		const available = registry.getAvailable();
		checks.push({
			name: "authenticated models",
			ok: available.length > 0,
			detail: `${available.length} available`,
			required: available.length === 0,
		});
	} catch (e) {
		checks.push({ name: "model resolution", ok: false, detail: (e as Error).message, required: true });
	}

	// 4. gh auth
	const gh = await ghAuthStatus(cwd);
	checks.push({
		name: "gh auth status",
		ok: gh.exitCode === 0,
		detail: gh.exitCode === 0 ? "logged in" : gh.stderr || gh.stdout || "not logged in",
		required: true,
	});

	// 5. git repo + current branch
	try {
		const branch = await currentBranch(cwd);
		checks.push({ name: "git repo", ok: true, detail: `on ${branch}`, required: true });
	} catch (e) {
		checks.push({ name: "git repo", ok: false, detail: (e as Error).message, required: true });
	}

	// 6. malformed model refs
	const bad: string[] = [];
	for (const k of Object.keys(config.models) as PhaseName[]) {
		const ref = config.models[k];
		if (ref) {
			try {
				parseModelRef(ref);
			} catch {
				bad.push(`${k}=${ref}`);
			}
		}
	}
	checks.push({
		name: "config model refs",
		ok: bad.length === 0,
		detail: bad.length ? `malformed: ${bad.join(", ")}` : "ok",
		required: false,
	});

	return report(checks);
}

function report(checks: Check[]): DoctorReport {
	const allRequiredPassed = checks.filter((c) => c.required).every((c) => c.ok);
	for (const c of checks) {
		const flag = c.ok ? green("✓", out) : c.required ? red("✗", out) : yellow("!", out);
		console.log(`  ${flag} ${bold(c.name.padEnd(22), out)} ${dim(c.detail, out)}`);
	}
	console.log(
		allRequiredPassed
			? `\n${green("✓", out)} Doctor: all required checks passed.`
			: `\n${red("✗", out)} Doctor: required checks FAILED. Fix the ${red("✗", out)} items above.`,
	);
	return { allRequiredPassed, checks };
}
