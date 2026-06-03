// Capability registry: the single source of truth for model routing. Workflow code
// selects models by querying this registry (by id or by capability requirements),
// never by hard-coding a model name.

import { CAPABILITY_DATA } from "./capabilities.data.js";
import type { CostClass, ModelCapability, ModelKind } from "./types.js";

export const CAPABILITY_REGISTRY: readonly ModelCapability[] = CAPABILITY_DATA;

const COST_RANK: Readonly<Record<CostClass, number>> = { low: 0, medium: 1, high: 2 };

export interface CapabilityQuery {
  readonly kind?: ModelKind | undefined;
  readonly toolCalling?: boolean | undefined;
  readonly structuredOutput?: boolean | undefined;
  readonly minContextWindow?: number | undefined;
}

export function findCapability(modelId: string): ModelCapability | undefined {
  return CAPABILITY_REGISTRY.find((cap) => cap.id === modelId);
}

export function listCapabilities(): readonly ModelCapability[] {
  return CAPABILITY_REGISTRY;
}

export function createDefaultChatCapability(modelId: string): ModelCapability {
  return {
    id: modelId,
    kind: "chat",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "runtime-configured endpoint",
    preferredUseCases: ["Chat", "Agent workflow"],
    knownLimitations: [
      "Runtime-configured capability; validate against the target endpoint before production use",
    ],
  };
}

function matches(cap: ModelCapability, query: CapabilityQuery): boolean {
  if (query.kind !== undefined && cap.kind !== query.kind) {
    return false;
  }
  if (query.toolCalling === true && !cap.toolCalling) {
    return false;
  }
  if (query.structuredOutput === true && !cap.structuredOutput) {
    return false;
  }
  if (query.minContextWindow !== undefined && cap.contextWindow < query.minContextWindow) {
    return false;
  }
  return true;
}

// Returns the lowest-cost capability satisfying the query, or undefined if none.
// Ties on cost class are broken by registry order (first declared wins).
export function selectCheapest(query: CapabilityQuery): ModelCapability | undefined {
  let best: ModelCapability | undefined;
  for (const cap of CAPABILITY_REGISTRY) {
    if (!matches(cap, query)) {
      continue;
    }
    if (best === undefined || COST_RANK[cap.costClass] < COST_RANK[best.costClass]) {
      best = cap;
    }
  }
  return best;
}
