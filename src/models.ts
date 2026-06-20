/**
 * Per-phase model resolution. Config "provider/modelId" -> ModelRegistry ->
 * fallback to first available. `doctor` calls the same resolver to fail fast.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { join as joinPath } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PhaseName } from "./config.ts";
import { parseModelRef } from "./config.ts";
import { ModelResolutionError } from "./errors.ts";

export interface ResolvedModels {
	registry: ModelRegistry;
	authStorage: AuthStorage;
	byPhase: Partial<Record<PhaseName, Model<Api>>>;
	available: Model<Api>[];
}

/** Auth + registry are process-singletons; build once, reuse across phases. */
export function buildRegistry(): { authStorage: AuthStorage; registry: ModelRegistry } {
	const authStorage = AuthStorage.create();
	const registry = ModelRegistry.create(authStorage, joinPath(getAgentDir(), "models.json"));
	return { authStorage, registry };
}

export function resolveModel(
	registry: ModelRegistry,
	ref: string | undefined,
): Model<Api> {
	if (ref) {
		const { provider, modelId } = parseModelRef(ref);
		const m = registry.find(provider, modelId);
		if (m) return m as Model<Api>;
		throw new ModelResolutionError(
			`Model "${ref}" not found in registry (built-in + ~/.pi/agent/models.json).`,
		);
	}
	const available = registry.getAvailable();
	const first = available[0];
	if (!first) {
		throw new ModelResolutionError(
			"No models available — run `pi` to authenticate a provider first.",
		);
	}
	return first as Model<Api>;
}

/** Resolve every phase configured in `models`. Unconfigured phases are omitted. */
export function resolveAll(
	registry: ModelRegistry,
	models: Partial<Record<PhaseName, string>>,
): Partial<Record<PhaseName, Model<Api>>> {
	const out: Partial<Record<PhaseName, Model<Api>>> = {};
	for (const key of Object.keys(models) as PhaseName[]) {
		const ref = models[key];
		if (ref) out[key] = resolveModel(registry, ref);
	}
	return out;
}

export function modelLabel(m: Model<Api> | undefined): string {
	if (!m) return "(unset)";
	const providerId = typeof m.provider === "string" ? m.provider : ((m.provider as { id?: string }).id ?? "(unknown)");
	return `${providerId}/${m.id}`;
}
