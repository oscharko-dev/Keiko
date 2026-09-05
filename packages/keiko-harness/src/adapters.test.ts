import { describe, expect, it } from "vitest";
import {
  CancelledError,
  type GatewayCallRequest,
  type GatewayRequest,
  type GatewayStreamChunk,
  type ModelGatewayLogContext,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { createInitialToolCatalog, gatewayToolDefinitions } from "@oscharko-dev/keiko-tool-catalog";
import { DryRunToolPort, GatewayModelPort } from "./adapters.js";
import { HARNESS_CODES } from "./errors.js";

function response(): NormalizedResponse {
  return {
    modelId: "m",
    content: "ok",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: { requestId: "r", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
  };
}

describe("GatewayModelPort", () => {
  it("passes the run signal through as GatewayRequest.cancellationSignal", async () => {
    let seen: AbortSignal | undefined;
    const port = new GatewayModelPort({
      chat: (req: GatewayRequest): Promise<NormalizedResponse> => {
        seen = req.cancellationSignal;
        return Promise.resolve(response());
      },
    });
    const controller = new AbortController();
    const req: GatewayRequest = { modelId: "m", messages: [{ role: "user", content: "hi" }] };
    await port.call(req, controller.signal);
    expect(seen).toBe(controller.signal);
  });

  it("does not overwrite the signal of an already-aborted controller before delegating", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    let aborted = false;
    const port = new GatewayModelPort({
      chat: (req: GatewayRequest): Promise<NormalizedResponse> => {
        aborted = req.cancellationSignal?.aborted ?? false;
        return Promise.resolve(response());
      },
    });
    await port.call({ modelId: "m", messages: [] }, controller.signal);
    expect(aborted).toBe(true);
  });

  it("propagates a CancelledError thrown by the underlying gateway", async () => {
    const port = new GatewayModelPort({
      chat: (): Promise<NormalizedResponse> => Promise.reject(new CancelledError("cancelled")),
    });
    await expect(
      port.call({ modelId: "m", messages: [] }, new AbortController().signal),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  it("callStream delegates to gateway.chatStream with the run signal and yields its chunks", async () => {
    let seen: AbortSignal | undefined;
    const chunks: GatewayStreamChunk[] = [
      { type: "delta", token: "he" },
      { type: "delta", token: "llo" },
      { type: "done", response: response() },
    ];
    const port = new GatewayModelPort({
      chat: (): Promise<NormalizedResponse> => Promise.resolve(response()),
      // eslint-disable-next-line @typescript-eslint/require-await
      chatStream: async function* (req: GatewayRequest): AsyncGenerator<GatewayStreamChunk> {
        seen = req.cancellationSignal;
        yield* chunks;
      },
    });
    const controller = new AbortController();
    const received: GatewayStreamChunk[] = [];
    for await (const chunk of port.callStream({ modelId: "m", messages: [] }, controller.signal)) {
      received.push(chunk);
    }
    expect(seen).toBe(controller.signal);
    expect(received).toEqual(chunks);
  });

  it("forwards the caller's logContext through call to the Gateway double (ADR-0173 D5)", async () => {
    let seen: ModelGatewayLogContext | undefined;
    const port = new GatewayModelPort({
      chat: (req: GatewayCallRequest): Promise<NormalizedResponse> => {
        seen = req.logContext;
        return Promise.resolve(response());
      },
    });
    const request: GatewayCallRequest = {
      modelId: "m",
      messages: [],
      logContext: { correlationId: "run-42" },
    };
    await port.call(request, new AbortController().signal);
    expect(seen).toEqual({ correlationId: "run-42" });
  });

  it("forwards the caller's logContext through callStream to the Gateway double (ADR-0173 D5)", async () => {
    let seen: ModelGatewayLogContext | undefined;
    const port = new GatewayModelPort({
      chat: (): Promise<NormalizedResponse> => Promise.resolve(response()),
      // eslint-disable-next-line @typescript-eslint/require-await
      chatStream: async function* (req: GatewayCallRequest): AsyncGenerator<GatewayStreamChunk> {
        seen = req.logContext;
        yield { type: "done", response: response() };
      },
    });
    const request: GatewayCallRequest = {
      modelId: "m",
      messages: [],
      logContext: { correlationId: "run-77" },
    };
    const received: GatewayStreamChunk[] = [];
    for await (const chunk of port.callStream(request, new AbortController().signal)) {
      received.push(chunk);
    }
    expect(seen).toEqual({ correlationId: "run-77" });
    expect(received).toEqual([{ type: "done", response: response() }]);
  });

  // KEIKO-0463 — SonarJS S7786: after a type check, throw a TypeError (not a bare Error) so the
  // rule stays green whenever this file is touched and downstream `err instanceof TypeError`
  // guards remain correct.
  // KEIKO-0594: this is also the only test exercising the unsupported-streaming guard itself
  // (a ChatModel structurally lacking chatStream — the documented "structural fakes may omit it"
  // case), so it additionally pins the exact message text, the externally observable contract.
  it("throws a TypeError (not a bare Error) when callStream is used but the gateway lacks chatStream", () => {
    const port = new GatewayModelPort({
      chat: (): Promise<NormalizedResponse> => Promise.resolve(response()),
    });
    let thrown: unknown;
    try {
      port.callStream({ modelId: "m", messages: [] }, new AbortController().signal);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toBe("gateway does not support streaming");
  });

  it("leaves logContext undefined when the caller supplies a plain GatewayRequest", async () => {
    let seen: ModelGatewayLogContext | undefined = { correlationId: "should-be-overwritten" };
    const port = new GatewayModelPort({
      chat: (req: GatewayCallRequest): Promise<NormalizedResponse> => {
        seen = req.logContext;
        return Promise.resolve(response());
      },
    });
    const request: GatewayRequest = { modelId: "m", messages: [] };
    await port.call(request, new AbortController().signal);
    expect(seen).toBeUndefined();
  });
});

describe("DryRunToolPort", () => {
  it("does not fabricate completed output for an unavailable dry-run handler", async () => {
    const port = new DryRunToolPort();
    await expect(
      port.execute({
        toolCallId: "tc-1",
        toolName: "read_file",
        arguments: { path: "src/foo.ts" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("unavailable");
    expect(port.calls()).toHaveLength(0);
  });

  // Relocates the prior pin "does not advertise productive tools even when legacy definitions are
  // supplied" (adapters.ts previously took a caller-supplied `legacyDefinitions` constructor
  // argument that could never make the port productive). That injection vector is now removed
  // entirely -- the constructor takes no arguments -- so the fabrication-prevention invariant it
  // guarded is now proven directly by execute() always refusing (the two tests in this file), and
  // this test instead pins the ADR-0175 D1/D4 disposition: honest advertisement of the fixed
  // compiled `legacy-native@1` projection (derived from the real producer, not restated here),
  // paired with the same unconditional refusal for every one of the tools it lists.
  it("advertises the compiled legacy-native catalog projection and refuses execution with a closed reason", async () => {
    const port = new DryRunToolPort();
    const advertised = port.listTools();
    expect(advertised).toEqual(
      gatewayToolDefinitions(createInitialToolCatalog(), { id: "legacy-native", version: 1 }),
    );
    expect(advertised.length).toBeGreaterThan(0);
    for (const tool of advertised) {
      const outcome = port.execute({
        toolCallId: `tc-${tool.name}`,
        toolName: tool.name,
        arguments: {},
        signal: new AbortController().signal,
      });
      await expect(outcome).rejects.toMatchObject({ category: HARNESS_CODES.TOOL_ERROR });
    }
    expect(port.calls()).toHaveLength(0);
  });

  it("rejects with CancelledError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    const port = new DryRunToolPort();
    await expect(
      port.execute({
        toolCallId: "tc-2",
        toolName: "read_file",
        arguments: {},
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(port.calls()).toHaveLength(0);
  });
});
