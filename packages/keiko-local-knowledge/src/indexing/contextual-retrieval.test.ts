import { describe, expect, it } from "vitest";

import type { ChunkId, DocumentId } from "@oscharko-dev/keiko-contracts";
import type {
  GatewayRequest,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";

import {
  CONTEXTUAL_RETRIEVAL_DISABLED_KEY,
  ContextualRetrievalError,
  boundedDocumentContext,
  buildContextualRetrievalMessages,
  contextualRetrievalChunkKey,
  contextualRetrievalStrategyKey,
  contextualizeChunk,
  type ContextualChunkInput,
} from "./contextual-retrieval.js";

function input(overrides: Partial<ContextualChunkInput> = {}): ContextualChunkInput {
  return {
    documentId: "doc-1" as DocumentId,
    chunkId: "chunk-1" as ChunkId,
    originalText: "The refund policy applies to enterprise accounts.",
    safeExcerptHash: "hash-1",
    documentText: "Intro. The refund policy applies to enterprise accounts. Appendix.",
    ...overrides,
  };
}

function response(modelId: string, content: string): NormalizedResponse {
  return {
    modelId,
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "ctx-1",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

describe("contextualRetrievalStrategyKey", () => {
  it("uses the disabled key unless contextual retrieval is explicitly enabled", () => {
    expect(contextualRetrievalStrategyKey(undefined)).toBe(CONTEXTUAL_RETRIEVAL_DISABLED_KEY);
    expect(contextualRetrievalStrategyKey({ enabled: false })).toBe(
      CONTEXTUAL_RETRIEVAL_DISABLED_KEY,
    );
  });

  it("includes prompt version, model, and chunk hash in enabled keys", () => {
    expect(
      contextualRetrievalChunkKey(
        { enabled: true, promptVersion: "prompt-v2", modelId: "ctx-model" },
        "safe-hash",
      ),
    ).toBe("indexed-text=contextual-v1|prompt=prompt-v2|model=ctx-model|chunk=safe-hash");
    expect(contextualRetrievalStrategyKey({ enabled: true })).toBe(
      "indexed-text=contextual-v1|prompt=contextual-retrieval-v1|model=unconfigured",
    );
  });
});

describe("boundedDocumentContext", () => {
  it("returns short documents unchanged", () => {
    expect(boundedDocumentContext("short document", 0, 5, { documentContextMaxChars: 100 })).toBe(
      "short document",
    );
  });

  it("centers long documents around the chunk and clamps invalid budgets to the default", () => {
    const source = `${"a".repeat(60)}TARGET${"b".repeat(60)}`;
    const bounded = boundedDocumentContext(source, 60, 66, { documentContextMaxChars: 20 });
    expect(bounded).toContain("TARGET");
    expect(bounded.length).toBeLessThanOrEqual(20);

    expect(
      boundedDocumentContext(source, 60, 66, { documentContextMaxChars: Number.NaN }),
    ).toBe(source);
    expect(boundedDocumentContext(source, 5, 2, { documentContextMaxChars: 10 }).length).toBeLessThanOrEqual(
      10,
    );
  });
});

describe("buildContextualRetrievalMessages", () => {
  it("wraps document and chunk text as untrusted prompt data", () => {
    const messages = buildContextualRetrievalMessages("doc text", "chunk text");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("untrusted data");
    expect(messages[1]?.content).toContain("<document>\ndoc text\n</document>");
    expect(messages[1]?.content).toContain("<chunk>\nchunk text\n</chunk>");
  });
});

describe("contextualizeChunk", () => {
  it("returns raw text when contextual retrieval is disabled", async () => {
    await expect(contextualizeChunk(input(), undefined)).resolves.toEqual({
      contextualRetrievalKey: `${CONTEXTUAL_RETRIEVAL_DISABLED_KEY}|chunk=hash-1`,
      contextPrefix: null,
      augmentedText: "The refund policy applies to enterprise accounts.",
      status: "disabled",
    });
  });

  it("generates sanitized bounded context and propagates cancellation signals", async () => {
    const calls: GatewayRequest[] = [];
    const controller = new AbortController();
    const result = await contextualizeChunk(input({ signal: controller.signal }), {
      enabled: true,
      modelId: "ctx-model",
      maxContextChars: 16,
      chatGateway: {
        chat: (request) => {
          calls.push(request);
          return Promise.resolve(response("ctx-model", "  Alpha\u0000\n   beta gamma delta  "));
        },
      },
    });

    expect(result.status).toBe("generated");
    expect(result.contextPrefix).toBe("Alpha beta gamma");
    expect(result.augmentedText).toBe(
      "Alpha beta gamma\n\nThe refund policy applies to enterprise accounts.",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.modelId).toBe("ctx-model");
    expect(calls[0]?.responseFormat).toEqual({ type: "text" });
    expect(calls[0]?.cancellationSignal).toBe(controller.signal);
  });

  it("keeps raw chunk text when the generated context sanitizes to empty", async () => {
    const result = await contextualizeChunk(input(), {
      enabled: true,
      modelId: "ctx-model",
      chatGateway: {
        chat: () => Promise.resolve(response("ctx-model", "\u0000 \n\t")),
      },
    });

    expect(result).toMatchObject({
      contextPrefix: null,
      augmentedText: "The refund policy applies to enterprise accounts.",
      status: "generated",
    });
  });

  it("degrades to raw text when generation fails in non-strict mode", async () => {
    const result = await contextualizeChunk(input(), { enabled: true, modelId: "ctx-model" });
    expect(result).toMatchObject({
      contextPrefix: null,
      augmentedText: "The refund policy applies to enterprise accounts.",
      status: "degraded",
    });
  });

  it("throws a contextual retrieval error when strict generation fails", async () => {
    await expect(
      contextualizeChunk(input(), {
        enabled: true,
        modelId: "ctx-model",
        strict: true,
        chatGateway: {
          chat: () => Promise.reject(new Error("gateway down")),
        },
      }),
    ).rejects.toBeInstanceOf(ContextualRetrievalError);
  });
});
