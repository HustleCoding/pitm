/**
 * Fixer phase: given failing CI checks + their logs, an edit-capable pi session
 * diagnoses and pushes a fix. Bounded by `maxCiFixRetries` in the orchestrator.
 *
 * The fixer defaults to a multimodal model so UI PRs (screenshot diffs) can be
 * triaged — glm-5.2 cannot read images (confirmed).
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { runPhase, type PhaseRunResult } from "../agent.ts";
import type { PrCheck } from "../git.ts";

const SYSTEM_PROMPT = `You are a senior engineer fixing CI failures on a pull request branch.
You are given the failing check names and their logs. Diagnose the root cause, then make the
minimal change that fixes the failure. Use read/grep/find to investigate, edit/write to fix,
and bash to re-run the failing command locally before stopping.

Rules:
- Do NOT commit, branch, push, or run git/gh commands. The orchestrator owns git.
- Touch only what's needed to make CI pass. No opportunistic refactors.
- Preserve existing style, architecture, and naming.
- If the failure is environmental (flaky test, infra, missing secret) and NOT a code defect,
  stop and say so explicitly in your first line: "ENVIRONMENTAL: <reason>". Do not change code.
- When the local run passes (or you determine it's environmental), stop. Summarize the fix in 2-4 lines.`;

export interface FixerInput {
	cwd: string;
	goal: string;
	branch: string;
	failingChecks: PrCheck[];
	logs: Array<{ name: string; log: string }>;
	verifyCommand: string;
	model: Model<Api>;
	/** Rigor skills exposed to the fixer. Empty unless enabled in config. */
	skills?: Skill[];
}

export async function runFixer(input: FixerInput): Promise<PhaseRunResult> {
	const failures = input.failingChecks
		.map((c) => `- ${c.name}${c.link ? ` (${c.link})` : ""}`)
		.join("\n");
	const logsBlock = input.logs
		.map((l) => `### ${l.name}\n\`\`\`\n${l.log.slice(0, 8000)}\n\`\`\``)
		.join("\n\n");
	const prompt = `Goal of this PR: ${input.goal}
Branch: ${input.branch}

Failing CI checks:
${failures}

Logs:
${logsBlock || "(no logs could be fetched)"}

The project's local verify command is: \`${input.verifyCommand}\`
Investigate, fix, and re-run \`${input.verifyCommand}\` locally. Working directory: ${input.cwd}`;

	return runPhase({
		cwd: input.cwd,
		model: input.model,
		systemPrompt: SYSTEM_PROMPT,
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		prompt,
		phaseLabel: "fixing CI",
		skills: input.skills,
	});
}

/** True if the fixer's first line declares an environmental (non-code) failure. */
export function isEnvironmental(result: PhaseRunResult): boolean {
	const firstLine = result.text.split("\n").find((l) => l.trim().length > 0) ?? "";
	return /^environmental/i.test(firstLine.trim());
}
