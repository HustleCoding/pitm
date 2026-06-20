/**
 * Worker phase: an edit-capable pi session implements a single task, runs the
 * project's verify command via bash, and reports. The orchestrator commits.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { runPhase, type AgentSessionLike, type PhaseRunResult } from "../agent.ts";
import type { Task } from "../state.ts";

const SYSTEM_PROMPT = `You are a senior software engineer implementing ONE task in an existing repo.
Make the minimal change required. Use read/grep/find to navigate, then edit/write to implement.
After implementing, run the project's verify command via bash and iterate until it passes.

Rules:
- Do NOT commit, branch, push, or run git/gh commands. The orchestrator owns git.
- Do NOT amend unrelated code. Touch only what the task requires.
- Preserve existing style, architecture, and naming.
- If you receive a steering message mid-run, honor it for THIS task only.
- When the verify command passes, stop. Report what you changed in 2-4 lines.`;

export interface WorkerInput {
	cwd: string;
	goal: string;
	task: Task;
	verifyCommand: string;
	model: Model<Api>;
	previousTasks: Task[];
	/** Called once with the live AgentSession, for mailbox steering. */
	onSession?: (session: AgentSessionLike) => void;
}

export async function runWorker(input: WorkerInput): Promise<PhaseRunResult> {
	const prompt = buildPrompt(input);
	return runPhase({
		cwd: input.cwd,
		model: input.model,
		systemPrompt: SYSTEM_PROMPT,
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		prompt,
		onSession: input.onSession,
		phaseLabel: `worker ${input.task.id}`,
	});
}

function buildPrompt(input: WorkerInput): string {
	const context = input.previousTasks
		.filter((t) => t.status === "done")
		.map((t) => `  - ${t.id}: ${t.title} (done)`)
		.join("\n");
	return `Overall goal: ${input.goal}
${context ? `Already completed:\n${context}\n` : ""}
Your task (${input.task.id}): ${input.task.id}

Title: ${input.task.title}
Details: ${input.task.details}
Success criteria:
${input.task.successCriteria.map((c) => `  - ${c}`).join("\n")}

Implement this task now, then run \`${input.verifyCommand}\` and make it pass.
The working directory is ${input.cwd}.`;
}
