/**
 * Reviewer phase: given reviewer comments on a PR, an edit-capable pi session
 * addresses them and pushes. The orchestrator re-runs CI afterward.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { runPhase, type PhaseRunResult } from "../agent.ts";
import type { ReviewComment } from "../git.ts";

const SYSTEM_PROMPT = `You are a senior engineer addressing pull-request review comments.
You are given reviewer comments (possibly with file/line context). For each substantive
comment, either make the requested change or, if the comment is wrong/out-of-scope, leave
the code as-is. Use read/grep/find to understand context, edit/write to change code, and
bash to run the project verify command before stopping.

Rules:
- Do NOT commit, branch, push, or run git/gh commands. The orchestrator owns git.
- Do NOT reply to comments; the orchestrator does not post review replies yet. Just fix code.
- Ignore pure style nits that the project's linter doesn't enforce.
- When done, list each comment and what you did about it in 1 line each.`;

export interface ReviewerInput {
	cwd: string;
	goal: string;
	comments: ReviewComment[];
	verifyCommand: string;
	model: Model<Api>;
}

export async function runReviewer(input: ReviewerInput): Promise<PhaseRunResult> {
	const block = input.comments
		.map((c, i) =>
			[
				`### Comment ${i + 1} — @${c.author}${c.state ? ` (${c.state})` : ""}`,
				c.path ? `File: ${c.path}${c.line ? `:${c.line}${c.side ? ` ${c.side}` : ""}` : ""}` : null,
				c.body,
			]
				.filter(Boolean)
				.join("\n"),
		)
		.join("\n\n");
	const prompt = `Goal of this PR: ${input.goal}

Reviewer comments to address:
${block || "(no substantive comments)"}

Address them, then run \`${input.verifyCommand}\` locally. Working directory: ${input.cwd}`;

	return runPhase({
		cwd: input.cwd,
		model: input.model,
		systemPrompt: SYSTEM_PROMPT,
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		prompt,
	});
}
