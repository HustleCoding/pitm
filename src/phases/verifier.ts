/**
 * Verifier phase: a read-mostly pi session checks each task's recorded success
 * criteria against the actual codebase + a local verify run. Emits a verdict.
 *
 * This is the "is the task actually done?" gate that autonomous agents are bad
 * at — so it runs on a strong model and must produce a strict JSON verdict.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { runPhase } from "../agent.ts";
import type { Task } from "../state.ts";

export interface VerifierVerdict {
	allPass: boolean;
	results: Array<{ taskId: string; criterion: string; pass: boolean; note: string }>;
}

const SYSTEM_PROMPT = `You are a rigorous QA engineer verifying whether a completed PR satisfies
its recorded success criteria. Use read/grep/find/ls to inspect the code and bash to run the
project's verify command. Do NOT edit or write files.

For EACH success criterion of EACH task, determine pass/fail with a one-line note. Be strict:
"the code looks plausible" is not pass — require concrete evidence (the verify command passes,
the route exists, the test asserts the behavior, etc.).

Respond with ONLY a single JSON object, no prose, no fences:
{
  "allPass": true | false,
  "results": [
    { "taskId": "T1", "criterion": "...", "pass": true, "note": "evidence" }
  ]
}`;

export interface VerifierInput {
	cwd: string;
	goal: string;
	tasks: Task[];
	verifyCommand: string;
	model: Model<Api>;
}

export async function runVerifier(input: VerifierInput): Promise<VerifierVerdict> {
	const tasksBlock = input.tasks
		.map((t) =>
			[
				`## ${t.id}: ${t.title}`,
				t.details,
				"Success criteria:",
				...t.successCriteria.map((c) => `  - ${c}`),
			].join("\n"),
		)
		.join("\n\n");
	const prompt = `Goal: ${input.goal}

Tasks to verify:
${tasksBlock}

Run \`${input.verifyCommand}\` and inspect the code. Emit the verdict JSON.
Working directory: ${input.cwd}`;

	const result = await runPhase({
		cwd: input.cwd,
		model: input.model,
		systemPrompt: SYSTEM_PROMPT,
		tools: ["read", "bash", "grep", "find", "ls"],
		prompt,
	});
	return parseVerdict(result.text);
}

function parseVerdict(text: string): VerifierVerdict {
	const json = extractJson(text);
	if (!json) {
		return {
			allPass: false,
			results: [
				{
					taskId: "?",
					criterion: "verifier produced parseable JSON",
					pass: false,
					note: `Raw verifier output:\n${text.slice(0, 800)}`,
				},
			],
		};
	}
	try {
		const v = JSON.parse(json) as VerifierVerdict;
		if (!Array.isArray(v.results)) throw new Error("missing results");
		return v;
	} catch (e) {
		return {
			allPass: false,
			results: [
				{
					taskId: "?",
					criterion: "verifier produced valid JSON",
					pass: false,
					note: `Parse error: ${(e as Error).message}`,
				},
			],
		};
	}
}

function extractJson(text: string): string | undefined {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = fenced?.[1] ?? text;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return undefined;
	return candidate.slice(start, end + 1);
}
