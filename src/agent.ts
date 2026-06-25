/**
 * Per-phase pi agent session factory + runner.
 *
 * Each phase gets its own short-lived AgentSession with:
 *  - a fixed model (per-phase routing),
 *  - a scoped system prompt,
 *  - a scoped tool set (planner is read-only; worker can edit),
 *  - an in-memory SessionManager (orchestrator owns durability via state.json).
 *
 * The runner streams text deltas to stdout for visibility, then returns the
 * final assistant text + token usage so the orchestrator can log + budget.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentSessionEvent,
	createAgentSession,
	createExtensionRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { modelLabel } from "./models.ts";
import { phaseEnd, startSpinner, status, stopSpinner, textStreaming, toolCall, toolEnd } from "./progress.ts";

/** Minimal slice of AgentSession the orchestrator needs for mailbox steering. */
export interface AgentSessionLike {
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	agent: { waitForIdle(): Promise<void> };
	dispose(): void;
}

export interface PhaseRunOptions {
	cwd: string;
	model: Model<Api>;
	systemPrompt: string;
	tools: string[];
	prompt: string;
	/** Optional mailbox entries delivered as steering messages after the prompt. */
	steerMidRun?: string[];
	/** Abort signal — if aborted, we stop waiting (best-effort). */
	signal?: AbortSignal;
	/** Called once with the live AgentSession, so callers can attach a mailbox poller. */
	onSession?: (session: AgentSessionLike) => void;
	/** Human-readable label for the phase, shown in progress output. */
	phaseLabel?: string;
	/** Skills to expose to the agent (names + descriptions appended to the
	 *  system prompt; full SKILL.md read on demand). Empty by default. */
	skills?: Skill[];
}

export interface PhaseRunResult {
	text: string;
	totalTokens: number;
	model: string;
	messages: AgentMessage[];
	/** File paths the agent modified via edit/write tools. Used to commit only
	 *  what the agent touched, never `git add -A`. */
	touchedPaths: string[];
}

function makeLoader(systemPrompt: string, skills: Skill[]): ResourceLoader {
	return {
		getExtensions: () => ({
			extensions: [],
			errors: [],
			runtime: createExtensionRuntime(),
		}),
		getSkills: () => ({ skills, diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

/**
 * Run a single phase to completion. Throws on agent error or budget abort.
 */
export async function runPhase(opts: PhaseRunOptions): Promise<PhaseRunResult> {
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: true, maxRetries: 2 },
	});
	const loader = makeLoader(opts.systemPrompt, opts.skills ?? []);
	await loader.reload();

	const { session } = await createAgentSession({
		cwd: opts.cwd,
		model: opts.model,
		thinkingLevel: "medium",
		tools: opts.tools,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(opts.cwd),
		settingsManager,
	});

	if (opts.onSession) opts.onSession(session as unknown as AgentSessionLike);

	let text = "";
	let totalTokens = 0;
	let streamedAnyText = false;
	const touchedPaths = new Set<string>();
	const label = opts.phaseLabel ?? "agent";

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		switch (event.type) {
			case "tool_execution_start":
				toolCall(event.toolName, event.args);
				captureTouchedPath(event.toolName, event.args, touchedPaths);
				break;
			case "tool_execution_end":
				toolEnd(event.toolName, event.isError);
				startSpinner("thinking…");
				break;
			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta") {
					if (!streamedAnyText) {
						textStreaming();
						streamedAnyText = true;
					}
					text += event.assistantMessageEvent.delta;
				}
				break;
			default:
				break;
		}
	});

	try {
		startSpinner("thinking…");
		await session.prompt(opts.prompt);
		// Deliver any mid-run steering messages, then wait for the agent to drain.
		for (const steer of opts.steerMidRun ?? []) {
			await session.steer(steer);
		}
		await session.agent.waitForIdle();
		stopSpinner();

		// Sum usage from all assistant messages for budget accounting.
		for (const msg of session.messages) {
			if (msg.role === "assistant") {
				const usage = (msg as { usage?: { totalTokens?: number } }).usage;
				if (usage?.totalTokens) totalTokens += usage.totalTokens;
			}
		}
		const finalText = extractAssistantText(session.messages) ?? text;
		if (!finalText) {
			const err = (session.agent.state as { errorMessage?: string }).errorMessage;
			if (err) {
				throw new Error(`Agent produced no text output. Agent error: ${err}`);
			}
			// Dump message roles + stop reasons for diagnosis.
			const diag = session.messages
				.map((m) => {
					if (m.role === "assistant") {
						const am = m as { stopReason?: string; errorMessage?: string; usage?: { totalTokens?: number } };
						return `  assistant stopReason=${am.stopReason ?? "?"} err=${am.errorMessage ?? "none"} tokens=${am.usage?.totalTokens ?? 0}`;
					}
					return `  ${m.role}`;
				})
				.join("\n");
			throw new Error(`Agent produced no text output. Message trace:\n${diag}`);
		}
		phaseEnd(label, `${session.messages.filter((m) => m.role === "assistant").length} assistant msg(s)`, totalTokens);
		return {
			text: finalText,
			totalTokens,
			model: modelLabel(opts.model),
			messages: session.messages,
			touchedPaths: [...touchedPaths],
		};
	} finally {
		stopSpinner();
		unsubscribe();
		session.dispose();
	}
}

/** Record the path of any edit/write tool call so the orchestrator can commit
 *  only the files the agent actually touched. */
function captureTouchedPath(toolName: string, args: unknown, out: Set<string>): void {
	if (toolName !== "edit" && toolName !== "write") return;
	if (!args || typeof args !== "object") return;
	const path = (args as { path?: unknown; file_path?: unknown }).path
		?? (args as { file_path?: unknown }).file_path;
	if (typeof path === "string" && path.trim()) out.add(path.trim());
}

/** Concatenate all text blocks from assistant messages, in order. */
function extractAssistantText(messages: AgentMessage[]): string | undefined {
	const out: string[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		const content = (msg as { content?: Array<{ type: string; text?: string }> }).content;
		if (!content) continue;
		for (const block of content) {
			if (block.type === "text" && block.text) out.push(block.text);
		}
	}
	return out.length ? out.join("\n") : undefined;
}
