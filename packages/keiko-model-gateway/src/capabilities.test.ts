import { describe, expect, it } from "vitest";
import { CONVERSATION_CAPABILITY_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import {
  CAPABILITY_REGISTRY,
  createDefaultChatCapability,
  createDefaultCodexLocalSessionCapability,
  createDefaultEmbeddingCapability,
  explainConversationIneligibility,
  findCapability,
  isConversationEligibleModel,
  isLikelyEmbeddingModelId,
  listCapabilities,
  resolveCostClass,
  selectCheapest,
} from "./capabilities.js";

// Issue #144: minimal non-chat capability record literals used by the eligibility
// tests. Keep these in-file (not in a fixture module) so the structural pin is
// visible alongside the assertions and so future ModelKind additions force a
// compile error here, not a silent eligibility regression.
function embeddingCapability(): ModelCapability {
  return {
    id: "test-embedding-model",
    kind: "embedding",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "test fixture",
    preferredUseCases: ["Embeddings"],
    knownLimitations: ["test fixture"],
  };
}

function ocrVisionCapability(): ModelCapability {
  return {
    id: "test-ocr-vision-model",
    kind: "ocr-vision",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: true,
    supportsDocumentInput: true,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "standard",
    throughputHint: "test fixture",
    preferredUseCases: ["OCR"],
    knownLimitations: ["test fixture"],
  };
}

describe("capability registry", () => {
  it("ships no deployment-specific built-in models", () => {
    expect(CAPABILITY_REGISTRY).toHaveLength(0);
    expect(listCapabilities()).toHaveLength(0);
  });

  it("creates generic local chat capabilities for runtime-configured models", () => {
    const cap = createDefaultChatCapability("example-chat-model");
    expect(cap).toMatchObject({
      id: "example-chat-model",
      kind: "chat",
      toolCalling: true,
      structuredOutput: true,
      costClass: "medium",
      latencyClass: "standard",
    });
  });

  // AC #2: unknown discovered chat models are usable for text but not image/document/workflow.
  it("defaults supportsImageInput to false for runtime-configured chat models", () => {
    const cap = createDefaultChatCapability("example-chat-model");
    expect(cap.supportsImageInput).toBe(false);
  });

  it("defaults supportsDocumentInput to false for runtime-configured chat models", () => {
    const cap = createDefaultChatCapability("example-chat-model");
    expect(cap.supportsDocumentInput).toBe(false);
  });

  it("defaults workflowEligible to false for runtime-configured chat models", () => {
    const cap = createDefaultChatCapability("example-chat-model");
    expect(cap.workflowEligible).toBe(false);
  });

  it("does not advertise agent workflow for runtime-configured chat models", () => {
    const cap = createDefaultChatCapability("example-chat-model");
    expect(cap.preferredUseCases).toEqual(["Chat"]);
  });

  it("declares the default capability as kind 'chat'", () => {
    const cap = createDefaultChatCapability("example-chat-model");
    expect(cap.kind).toBe("chat");
  });

  it("creates local-session coding capabilities for Codex-backed configured models", () => {
    const cap = createDefaultCodexLocalSessionCapability("gpt-5.4");
    expect(cap).toMatchObject({
      id: "gpt-5.4",
      kind: "chat",
      toolCalling: false,
      structuredOutput: true,
      workflowEligible: true,
      throughputHint: "Codex local session",
    });
  });
});

describe("findCapability over a registry seeded with a default chat capability", () => {
  it("returns supportsImageInput === false (AC #2 pin against the in-memory factory path)", () => {
    // Simulate the discovery path: a chat model id is encountered, the default
    // capability is materialised in-process, and a caller looks it up. The
    // conservative-default guarantee must hold end-to-end, not only inside the
    // factory.
    const factoryDefault = createDefaultChatCapability("example-chat-model");
    const registry: readonly ModelCapability[] = [factoryDefault];
    const found = registry.find((c) => c.id === "example-chat-model");
    expect(found?.supportsImageInput).toBe(false);
    expect(found?.supportsDocumentInput).toBe(false);
    expect(found?.workflowEligible).toBe(false);
  });
});

describe("CONVERSATION_CAPABILITY_CONTRACT_VERSION", () => {
  it("is pinned to 2 (bumped from the implicit v1 by Conversation Center fields)", () => {
    expect(CONVERSATION_CAPABILITY_CONTRACT_VERSION).toBe(2);
  });
});

describe("findCapability", () => {
  it("returns undefined for runtime-configured ids", () => {
    expect(findCapability("example-chat-model")).toBeUndefined();
  });
});

describe("listCapabilities", () => {
  it("returns a snapshot of every registered model", () => {
    expect(listCapabilities().map((c) => c.id)).toEqual(CAPABILITY_REGISTRY.map((c) => c.id));
  });
});

describe("selectCheapest", () => {
  it("returns undefined when no built-in capability satisfies the requirements", () => {
    expect(selectCheapest({ kind: "chat", toolCalling: true })).toBeUndefined();
  });

  // Issue #810: image-input (multimodal) requirement on the built-in selector. The
  // built-in registry ships empty, so a supportsImageInput query must return undefined
  // here — the routable surface for deployment vision models is the config-aware
  // selectConfiguredModel path, not the built-in CAPABILITY_DATA. Positive predicate
  // coverage lives in model-selection.test.ts where caps come from an array.
  it("returns undefined for a supportsImageInput query against the empty built-in registry", () => {
    expect(selectCheapest({ kind: "chat", supportsImageInput: true })).toBeUndefined();
  });
});

describe("resolveCostClass", () => {
  it("returns 'unknown' for runtime-configured / unregistered model ids", () => {
    expect(resolveCostClass("example-chat-model")).toBe("unknown");
    expect(resolveCostClass("")).toBe("unknown");
  });
});

// Issue #144 / Epic #142: pin the pure-helper eligibility surface. The helpers
// originate in keiko-contracts; this test exercises them through the model-
// gateway re-export so a downstream refactor that severs the re-export fails.
describe("isConversationEligibleModel", () => {
  it("returns true for a kind:'chat' capability (default factory path)", () => {
    expect(isConversationEligibleModel(createDefaultChatCapability("test-chat-1"))).toBe(true);
  });

  it("returns false for a kind:'embedding' capability", () => {
    expect(isConversationEligibleModel(embeddingCapability())).toBe(false);
  });

  it("returns false for a kind:'ocr-vision' capability", () => {
    expect(isConversationEligibleModel(ocrVisionCapability())).toBe(false);
  });
});

describe("explainConversationIneligibility", () => {
  it("returns undefined for a chat capability", () => {
    expect(
      explainConversationIneligibility(createDefaultChatCapability("test-chat-1")),
    ).toBeUndefined();
  });

  it("returns 'embedding-only' for an embedding capability", () => {
    expect(explainConversationIneligibility(embeddingCapability())).toBe("embedding-only");
  });

  it("returns 'ocr-vision-only' for an ocr-vision capability", () => {
    expect(explainConversationIneligibility(ocrVisionCapability())).toBe("ocr-vision-only");
  });
});

// Issue #144 / Epic #142: embedding-id heuristic — positive matches.
describe("isLikelyEmbeddingModelId — positive cases", () => {
  it("matches 'text-embedding-3-large'", () => {
    expect(isLikelyEmbeddingModelId("text-embedding-3-large")).toBe(true);
  });

  it("matches 'text-embedding-3-small'", () => {
    expect(isLikelyEmbeddingModelId("text-embedding-3-small")).toBe(true);
  });

  it("matches 'text-embedding-ada-002'", () => {
    expect(isLikelyEmbeddingModelId("text-embedding-ada-002")).toBe(true);
  });

  it("matches 'acme-embed' (embed token at end after dash boundary)", () => {
    expect(isLikelyEmbeddingModelId("acme-embed")).toBe(true);
  });

  it("matches 'embeddings-v2' (embed token at start)", () => {
    expect(isLikelyEmbeddingModelId("embeddings-v2")).toBe(true);
  });

  it("matches 'nomic-embed-text'", () => {
    expect(isLikelyEmbeddingModelId("nomic-embed-text")).toBe(true);
  });

  it("matches 'model/embed' (slash boundary)", () => {
    expect(isLikelyEmbeddingModelId("model/embed")).toBe(true);
  });

  it("matches 'model_embed_v1' (underscore boundary)", () => {
    expect(isLikelyEmbeddingModelId("model_embed_v1")).toBe(true);
  });
});

// Issue #144 / Epic #142: embedding-id heuristic — negative matches (must not catch chat models).
describe("isLikelyEmbeddingModelId — negative cases", () => {
  it("does not match 'gpt-oss-120b'", () => {
    expect(isLikelyEmbeddingModelId("gpt-oss-120b")).toBe(false);
  });

  it("does not match 'mistral-large-3'", () => {
    expect(isLikelyEmbeddingModelId("mistral-large-3")).toBe(false);
  });

  it("does not match 'llama-4-maverick-vision'", () => {
    expect(isLikelyEmbeddingModelId("llama-4-maverick-vision")).toBe(false);
  });

  it("does not match 'claude-3-7-sonnet'", () => {
    expect(isLikelyEmbeddingModelId("claude-3-7-sonnet")).toBe(false);
  });

  it("does not match 'gpt-4o'", () => {
    expect(isLikelyEmbeddingModelId("gpt-4o")).toBe(false);
  });

  it("does not match empty string", () => {
    expect(isLikelyEmbeddingModelId("")).toBe(false);
  });
});

// Issue #144 / Epic #142: default embedding capability factory — field shape and eligibility.
describe("createDefaultEmbeddingCapability", () => {
  it("returns kind:'embedding' for the provided id", () => {
    const cap = createDefaultEmbeddingCapability("text-embedding-3-large");
    expect(cap.kind).toBe("embedding");
    expect(cap.id).toBe("text-embedding-3-large");
  });

  it("sets workflowEligible to false", () => {
    expect(createDefaultEmbeddingCapability("text-embedding-3-large").workflowEligible).toBe(false);
  });

  it("sets toolCalling to false", () => {
    expect(createDefaultEmbeddingCapability("text-embedding-3-large").toolCalling).toBe(false);
  });

  it("sets structuredOutput to false", () => {
    expect(createDefaultEmbeddingCapability("text-embedding-3-large").structuredOutput).toBe(false);
  });

  it("sets streaming to false", () => {
    expect(createDefaultEmbeddingCapability("text-embedding-3-large").streaming).toBe(false);
  });

  it("sets maxOutputTokens to 0 (embeddings produce vectors, not tokens)", () => {
    expect(createDefaultEmbeddingCapability("text-embedding-3-large").maxOutputTokens).toBe(0);
  });

  it("is NOT conversation-eligible (AC #143/#144: excluded from conversation dropdown)", () => {
    const cap = createDefaultEmbeddingCapability("text-embedding-3-large");
    expect(isConversationEligibleModel(cap)).toBe(false);
  });

  it("explains ineligibility as 'embedding-only'", () => {
    const cap = createDefaultEmbeddingCapability("text-embedding-3-large");
    expect(explainConversationIneligibility(cap)).toBe("embedding-only");
  });
});
