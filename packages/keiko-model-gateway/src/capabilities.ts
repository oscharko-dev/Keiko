// Capability registry: the single source of truth for model routing. Workflow code
// selects models by querying this registry (by id or by capability requirements),
// never by hard-coding a model name.

import { CAPABILITY_DATA } from "./capabilities.data.js";
import type { CostClass, ModelCapability, ModelKind } from "./types.js";

// Issue #144 / Epic #142: conversation eligibility helpers and reason type.
// The canonical definitions live in `@oscharko-dev/keiko-contracts/gateway`
// so the browser-tier `keiko-ui` package can value-import them without
// crossing ADR-0019 trust rule 3 (UI → model-gateway/src forbidden at error).
// They are re-exported here so server-tier consumers that already depend on
// the model-gateway barrel keep a single import path.
export {
  isConversationEligibleModel,
  explainConversationIneligibility,
} from "@oscharko-dev/keiko-contracts";
export type { ConversationIneligibilityReason } from "@oscharko-dev/keiko-contracts";

export const CAPABILITY_REGISTRY: readonly ModelCapability[] = CAPABILITY_DATA;

const COST_RANK: Readonly<Record<CostClass, number>> = { low: 0, medium: 1, high: 2 };

export interface CapabilityQuery {
  readonly kind?: ModelKind | undefined;
  readonly toolCalling?: boolean | undefined;
  readonly structuredOutput?: boolean | undefined;
  readonly minContextWindow?: number | undefined;
  // Issue #810: require image-input (multimodal) capability. When true, only models that
  // advertise supportsImageInput === true match — the routing key for vision-augmented work.
  readonly supportsImageInput?: boolean | undefined;
}

export function findCapability(modelId: string): ModelCapability | undefined {
  return CAPABILITY_REGISTRY.find((cap) => cap.id === modelId);
}

// Resolves the cost class for a model id by consulting the capability registry.
// Returns "unknown" for unrecognised models so callers can record an honest,
// non-fatal fall-through rather than silently dropping the run. The evidence
// layer receives this through its injected `EvidenceDeps.costClassResolver` port.
export function resolveCostClass(modelId: string): CostClass | "unknown" {
  return findCapability(modelId)?.costClass ?? "unknown";
}

export function listCapabilities(): readonly ModelCapability[] {
  return CAPABILITY_REGISTRY;
}

// Issue #144 / Epic #142: conservative name-based heuristic for embedding model ids.
// Matches ids that contain an embed token on a word boundary (dash, underscore, slash,
// dot, or start/end of string). Also matches `ada-002` which is OpenAI's legacy
// embedding model name that predates the `text-embedding-*` convention.
// ReDoS-safe: no nested quantifiers, linear worst-case.
export const EMBEDDING_ID_PATTERN =
  /(?:^|[-_/. ])(?:text-)?embed(?:ding)?s?(?:[-_/. ]|$)|ada-002(?:$|[-_/. ])/i;

export function isLikelyEmbeddingModelId(id: string): boolean {
  return EMBEDDING_ID_PATTERN.test(id);
}

export function createDefaultEmbeddingCapability(modelId: string): ModelCapability {
  return {
    id: modelId,
    kind: "embedding",
    contextWindow: 8_191,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "runtime-configured embedding endpoint",
    preferredUseCases: ["Embeddings"],
    knownLimitations: [
      "Runtime-configured capability; validate against the target endpoint before production use",
    ],
  };
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
    // Conservative defaults for an UNKNOWN discovered chat model (Issue #143 / AC #2):
    // text-only and not workflow-eligible until explicitly enriched.
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "runtime-configured endpoint",
    preferredUseCases: ["Chat"],
    knownLimitations: [
      "Runtime-configured capability; validate against the target endpoint before production use",
      "Image input, document input, and workflow eligibility require explicit enrichment",
    ],
  };
}

// Every requested boolean capability (when true) must be advertised by the model.
function satisfiesBooleanRequirements(cap: ModelCapability, query: CapabilityQuery): boolean {
  if (query.toolCalling === true && !cap.toolCalling) {
    return false;
  }
  if (query.structuredOutput === true && !cap.structuredOutput) {
    return false;
  }
  if (query.supportsImageInput === true && !cap.supportsImageInput) {
    return false;
  }
  return true;
}

function matches(cap: ModelCapability, query: CapabilityQuery): boolean {
  if (query.kind !== undefined && cap.kind !== query.kind) {
    return false;
  }
  if (!satisfiesBooleanRequirements(cap, query)) {
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
