// Tests for `ModelGatewayAnswerGenerator` (Epic #189, Issue #200). Pins the prompt shape
// (deterministic, citation-ordered), the no-evidence gate (gateway MUST NOT be called
// when grounding rejects), and signal propagation.

import { describe, expect, it, vi } from "vitest";

import type {
  CapsuleAnswerGroundingPolicy,
  GatewayRequest,
  KnowledgeCapsuleId,
  NormalizedResponse,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";

import { assembleGroundedContext } from "../retrieval/context-pack-assembler.js";
import {
  AnswerGroundingRejectedError,
  ModelGatewayAnswerGenerator,
  buildPromptMessages,
  type ChatGateway,
} from "./model-gateway-answer-generator.js";
import type { ConversationGroundedQuery } from "./types.js";

function reference(chunk: string, displayName = "doc.txt"): RetrievalReference {
  return {
    chunkId: chunk as RetrievalReference["chunkId"],
    capsuleId: "cap-a" as KnowledgeCapsuleId,
    score: 0.9,
    citation: {
      documentId: "doc-1" as RetrievalReference["citation"]["documentId"],
      capsuleId: "cap-a" as KnowledgeCapsuleId,
      sourceId: "src-1" as RetrievalReference["citation"]["sourceId"],
      chunkId: chunk as RetrievalReference["citation"]["chunkId"],
      safeDisplayName: displayName,
    },
  };
}

function fakeGateway(content: string): {
  readonly chat: ChatGateway;
  readonly calls: GatewayRequest[];
} {
  const calls: GatewayRequest[] = [];
  const response: NormalizedResponse = {
    modelId: "test-model",
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "req-1",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
  return {
    chat: {
      chat: async (req: GatewayRequest): Promise<NormalizedResponse> => {
        calls.push(req);
        return Promise.resolve(response);
      },
    },
    calls,
  };
}

const query: ConversationGroundedQuery = {
  conversationId: "conv-1",
  capsuleId: "cap-a" as KnowledgeCapsuleId,
  text: "what is alpha?",
};

function assertUserPromptContains(
  content: string | undefined,
  substrings: readonly string[],
): void {
  for (const substring of substrings) {
    expect(content).toContain(substring);
  }
}

describe("ModelGatewayAnswerGenerator", () => {
  it("calls the gateway with deterministic prompt messages and returns content", async () => {
    const refs = [reference("ch-1", "alpha.txt"), reference("ch-2", "beta.txt")];
    const pack = assembleGroundedContext(refs);
    const gw = fakeGateway("Alpha is the first letter [1].");
    const generator = new ModelGatewayAnswerGenerator({
      chatGateway: gw.chat,
      modelId: "test-model",
      policy: "best-effort",
    });
    const text = await generator.generate({ query, pack, references: refs });
    expect(text).toBe("Alpha is the first letter [1].");
    expect(gw.calls).toHaveLength(1);
    const sent = gw.calls[0];
    expect(sent?.modelId).toBe("test-model");
    expect(sent?.messages[0]?.role).toBe("system");
    assertUserPromptContains(sent?.messages[1]?.content, [
      "Question: what is alpha?",
      "Context (2 citations)",
      "[1] alpha.txt",
      "[2] beta.txt",
    ]);
  });

  it("refuses to call the gateway when grounding rejects (require-citations + empty refs)", async () => {
    const pack = assembleGroundedContext([]);
    const gatewayCalled = vi.fn((): Promise<NormalizedResponse> => {
      return Promise.reject(new Error("must not call gateway"));
    });
    const generator = new ModelGatewayAnswerGenerator({
      chatGateway: { chat: gatewayCalled },
      modelId: "test-model",
      policy: "require-citations" satisfies CapsuleAnswerGroundingPolicy,
    });
    await expect(generator.generate({ query, pack, references: [] })).rejects.toBeInstanceOf(
      AnswerGroundingRejectedError,
    );
    expect(gatewayCalled).not.toHaveBeenCalled();
  });

  it("forwards an AbortSignal to the gateway request", async () => {
    const refs = [reference("ch-1")];
    const pack = assembleGroundedContext(refs);
    const gw = fakeGateway("answer");
    const generator = new ModelGatewayAnswerGenerator({
      chatGateway: gw.chat,
      modelId: "test-model",
      policy: "best-effort",
    });
    const controller = new AbortController();
    await generator.generate({
      query,
      pack,
      references: refs,
      signal: controller.signal,
    });
    expect(gw.calls[0]?.cancellationSignal).toBe(controller.signal);
  });

  it("redacts citation display metadata before sending the prompt", async () => {
    const refs = [reference("ch-1", "manual-TOKEN-123.md")];
    const pack = assembleGroundedContext(refs);
    const gw = fakeGateway("answer");
    const generator = new ModelGatewayAnswerGenerator({
      chatGateway: gw.chat,
      modelId: "test-model",
      policy: "best-effort",
      redactCitationMetadata: (value): string => value.replaceAll("TOKEN-123", "[REDACTED]"),
    });

    await generator.generate({ query, pack, references: refs });

    const prompt = gw.calls[0]?.messages[1]?.content ?? "";
    expect(prompt).toContain("manual-[REDACTED].md");
    expect(prompt).not.toContain("TOKEN-123");
  });

  it("produces byte-identical prompt messages for identical packs", () => {
    const refs = [reference("ch-1"), reference("ch-2")];
    const pack = assembleGroundedContext(refs);
    const first = buildPromptMessages("q", pack);
    const second = buildPromptMessages("q", pack);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
