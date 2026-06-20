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
} from "@earendil-works/pi-coding-agent";
import { modelLabel } from "./models.ts";

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
}

export interface PhaseRunResult {
	text: string;
	totalTokens: number;
	model: string;
	messages: AgentMessage[];
}

function makeLoader(systemPrompt: string): ResourceLoader {
	return {
		getExtensions: () => ({
			extensions: [],
			errors: [],
			runtime: createExtensionRuntime(),
		}),
		getSkills: () => ({ skills: [], diagnostics: [] }),
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
	const loader = makeLoader(opts.systemPrompt);
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

	let text = "";
	let totalTokens = 0;

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			text += event.assistantMessageEvent.delta;
		}
	});

	try {
		await session.prompt(opts.prompt);
		// Deliver any mid-run steering messages, then wait for the agent to drain.
		for (const steer of opts.steerMidRun ?? []) {
			await session.steer(steer);
		}
		await session.agent.waitForIdle();

		// Sum usage from all assistant messages for budget accounting.
		for (const msg of session.messages) {
			if (msg.role === "assistant") {
				const usage = (msg as { usage?: { totalTokens?: number } }).usage;
				if (usage?.totalTokens) totalTokens += usage.totalTokens;
			}
		}
		const finalText = extractAssistantText(session.messages) ?? text;
		return {
			text: finalText,
			totalTokens,
			model: modelLabel(opts.model),
			messages: session.messages,
		};
	} finally {
		unsubscribe();
		session.dispose();
	}
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
