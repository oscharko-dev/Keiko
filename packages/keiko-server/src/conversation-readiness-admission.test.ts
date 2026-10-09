import { describe, expect, it } from "vitest";
import type { GatewayRequest, NormalizedResponse } from "@oscharko-dev/keiko-contracts";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import type { GatewayStreamChunk } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  captureConversationReadinessAdmission,
  withConversationReadinessAdmission,
} from "./conversation-readiness-admission.js";
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
  const checkedAt = new Date().toISOString();
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
        checkedAt,
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
    const admission = captureConversationReadinessAdmission(deps, "stream-model");
    if ("status" in admission) throw new Error("expected fresh test model admission");
    expect(admission.gatewayConfigGeneration).toBe(deps.gatewayConfig?.generation());
    const wrapped = withConversationReadinessAdmission(
      new ReceiverBoundPort(chunks),
      "stream-model",
      admission,
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
