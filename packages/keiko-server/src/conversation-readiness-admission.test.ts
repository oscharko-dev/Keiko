import { describe, expect, it } from "vitest";
import type { GatewayRequest, NormalizedResponse } from "@oscharko-dev/keiko-contracts";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import type { GatewayStreamChunk } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { withConversationReadinessAdmission } from "./conversation-readiness-admission.js";
import type { UiHandlerDeps } from "./deps.js";

function doneResponse(): NormalizedResponse {
  return {
    modelId: "stream-model",
    content: "hello",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "admission-test",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

// A receiver-dependent ModelPort exactly like the production GatewayModelPort: callStream is a
// PROTOTYPE method reading instance state through `this`. Class bodies are strict mode, so an
// unbound extraction throws a TypeError on the first next() — the defect this file pins.
class ReceiverBoundPort implements ModelPort {
  private readonly chunks: readonly GatewayStreamChunk[];

  public constructor(chunks: readonly GatewayStreamChunk[]) {
    this.chunks = chunks;
  }

  public call(): Promise<NormalizedResponse> {
    return Promise.resolve(doneResponse());
  }

  public async *callStream(
    _request: GatewayRequest,
    _signal: AbortSignal,
  ): AsyncIterable<GatewayStreamChunk> {
    for (const chunk of this.chunks) {
      yield await Promise.resolve(chunk);
    }
  }
}

function readyDeps(generation: number): Pick<UiHandlerDeps, "gatewayConfig"> {
  return {
    gatewayConfig: {
      storagePath: "/dev/null",
      current: () => undefined,
      present: () => true,
      set: () => undefined,
      verification: () => UNVERIFIED_GATEWAY,
      generation: () => generation,
      recordVerification: () => undefined,
      verifiedCapability: () => ({
        modelId: "stream-model",
        generation,
        checkedAt: "2026-08-17T00:00:00.000Z",
        fields: { conversationReady: true },
      }),
      recordVerifiedCapability: () => undefined,
      clearVerifiedCapability: () => false,
    },
  };
}

describe("withConversationReadinessAdmission — streaming receiver", () => {
  it("forwards callStream with its original receiver instead of throwing TypeError", async () => {
    const chunks: readonly GatewayStreamChunk[] = [
      { type: "delta", token: "hello" },
      { type: "done", response: doneResponse() },
    ];
    const deps = readyDeps(3);
    const wrapped = withConversationReadinessAdmission(
      new ReceiverBoundPort(chunks),
      "stream-model",
      { modelId: "stream-model", gatewayConfigGeneration: 3 },
      deps,
    );

    const stream = wrapped.callStream;
    expect(stream).toBeDefined();
    if (stream === undefined) return;
    const seen: GatewayStreamChunk[] = [];
    for await (const chunk of stream(
      { modelId: "stream-model", messages: [] },
      new AbortController().signal,
    )) {
      seen.push(chunk);
    }
    expect(seen).toEqual(chunks);
  });
});
