/**
 * Planner phase: a read-only pi session reads the codebase and emits a strict
 * JSON task list for the goal. The orchestrator parses it into `State.tasks`.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { runPhase } from "../agent.ts";
import type { Task } from "../state.ts";

export interface PlannerOutput {
	tasks: Array<{
		title: string;
		details: string;
		successCriteria: string[];
	}>;
}

const SYSTEM_PROMPT = `You are a senior software planner. You are given a goal for an existing codebase.
Use the read, grep, find, and ls tools to explore the repo. Do NOT edit, write, or run mutating commands.

Produce a MINIMAL, ordered task list that achieves the goal with the smallest
set of changes. Each task must be independently committable. Prefer fewer,
well-scoped tasks over many trivial ones.

Respond with ONLY a single JSON object, no prose, no markdown fences, matching:
{
  "tasks": [
    {
      "title": "short imperative title",
      "details": "what to change and where; concrete file paths when known",
      "successCriteria": ["verifiable criterion 1", "criterion 2"]
    }
  ]
}
If the goal is already satisfied, return { "tasks": [] }.`;

export async function runPlanner(
	cwd: string,
	goal: string,
	model: Model<Api>,
	verifyCommand: string,
): Promise<PlannerOutput> {
	const prompt = `Goal: ${goal}\n\nExplore the repo at ${cwd}, then emit the task list JSON.\nThe project's verify command is: \`${verifyCommand}\` (workers must make it pass).`;
	const result = await runPhase({
		cwd,
		model,
		systemPrompt: SYSTEM_PROMPT,
		tools: ["read", "grep", "find", "ls"],
		prompt,
	});
	return parsePlannerOutput(result.text);
}

function parsePlannerOutput(text: string): PlannerOutput {
	const json = extractJson(text);
	if (!json) {
		throw new Error(`Planner did not emit parseable JSON. Raw output:\n${text}`);
	}
	const parsed = JSON.parse(json) as PlannerOutput;
	if (!Array.isArray(parsed.tasks)) {
		throw new Error(`Planner JSON missing "tasks" array. Raw:\n${text.slice(0, 500)}`);
	}
	for (const t of parsed.tasks) {
		if (!t.title || !t.details) {
			throw new Error(`Planner task missing title/details: ${JSON.stringify(t)}`);
		}
		if (!Array.isArray(t.successCriteria)) t.successCriteria = [];
	}
	return parsed;
}

function extractJson(text: string): string | undefined {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = fenced?.[1] ?? text;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return undefined;
	return candidate.slice(start, end + 1);
}

/** Assign stable ids T1, T2, ... to planner output. */
export function toTasks(out: PlannerOutput): Task[] {
	return out.tasks.map((t, i) => ({
		id: `T${i + 1}`,
		title: t.title,
		details: t.details,
		successCriteria: t.successCriteria,
		status: "pending" as const,
		attempts: 0,
	}));
}
