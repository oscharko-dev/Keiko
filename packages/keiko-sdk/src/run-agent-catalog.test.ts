import { describe, expect, it, vi } from "vitest";
import { DryRunToolPort, MemoryEventSink } from "@oscharko-dev/keiko-harness";
import type { GatewayRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import { runAgent } from "./run-agent.js";
import { writeToolCatalogQualificationObservation } from "../../../scripts/lib/tool-catalog-qualification-observation.mjs";

describe("SDK native catalog readiness", () => {
  it("keeps the real default session unavailable and advertises no productive tools", async () => {
    const requests: GatewayRequest[] = [];
    const tools = new DryRunToolPort();
    const execute = vi.spyOn(tools, "execute");
    const bindToolCatalog = vi.fn((): never => {
      throw new TypeError("Productive factory must not run in dry-run");
    });
    const session = runAgent(
      { taskType: "investigate-bug", input: { description: "Inspect accepted task" } },
      { model: "m", workingDirectory: "/repo", evidence: { write: false } },
      {
        tools,
        bindToolCatalog,
        sink: new MemoryEventSink(),
        model: {
          call: (request): Promise<NormalizedResponse> => {
            requests.push(request);
            return Promise.resolve({
              modelId: "m",
              content: "Inspection planned",
              finishReason: "stop",
              toolCalls: [],
              structuredOutput: null,
              usage: {
                requestId: "r",
                promptTokens: 1,
                completionTokens: 1,
                latencyMs: 0,
                costClass: "low",
              },
            });
          },
        },
      },
    );
    expect((await session.result).outcome).toBe("completed");
    expect(requests[0]).not.toHaveProperty("tools");
    expect(requests[0]).not.toHaveProperty("toolCatalog");
    const advertised = tools.listTools();
    expect(advertised.length).toBeGreaterThan(0);
    const first = advertised[0];
    if (first === undefined) throw new TypeError("Expected an advertised legacy tool");
    await expect(
      tools.execute({
        toolCallId: "tc-sdk-dry-run",
        toolName: first.name,
        arguments: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("unavailable");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(bindToolCatalog).not.toHaveBeenCalled();
    writeToolCatalogQualificationObservation({
      consumer: "cli-server-sdk",
      component: "sdk",
      binding: tools.catalogBinding(),
      terminalStatus: "unavailable",
      settlementCount: 0,
      proof: { kind: "closed-unavailable" },
    });
  });
});
