import { describe, expect, it } from "vitest";
import { CancelledError } from "../../src/gateway/errors.js";
import type {
  GatewayRequest,
  NormalizedResponse,
  ToolDefinition,
} from "../../src/gateway/types.js";
import { DryRunToolPort, GatewayModelPort } from "../../src/harness/adapters.js";

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
});

describe("DryRunToolPort", () => {
  const tools: readonly ToolDefinition[] = [
    { name: "read_file", description: "read", parameters: {} },
  ];

  it("records the call without executing and returns an empty dry-run output", async () => {
    const port = new DryRunToolPort(tools);
    const result = await port.execute({
      toolCallId: "tc-1",
      toolName: "read_file",
      arguments: { path: "src/foo.ts" },
      signal: new AbortController().signal,
    });
    expect(result.toolCallId).toBe("tc-1");
    expect(result.durationMs).toBe(0);
    expect(port.calls()).toHaveLength(1);
    expect(port.calls()[0]?.toolName).toBe("read_file");
    expect(port.calls()[0]?.arguments).toEqual({ path: "src/foo.ts" });
  });

  it("listTools returns the registered list", () => {
    expect(new DryRunToolPort(tools).listTools()).toEqual(tools);
  });

  it("rejects with CancelledError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    const port = new DryRunToolPort(tools);
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
