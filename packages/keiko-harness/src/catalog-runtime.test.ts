import { describe, expect, it, vi } from "vitest";
import {
  createGatewayToolCatalogBridge,
  Gateway,
  type GatewayConfig,
  type ProviderAdapter,
} from "@oscharko-dev/keiko-model-gateway";
import {
  compileToolProjection,
  createInitialToolCatalog,
  lookupCatalogTool,
} from "@oscharko-dev/keiko-tool-catalog";
import { writeToolCatalogQualificationObservation } from "../../../scripts/lib/tool-catalog-qualification-observation.mjs";
import { createSession, type HarnessDeps } from "./session.js";
import { MemoryEventSink } from "./sinks.js";
import { GatewayModelPort } from "./adapters.js";
import {
  createLegacyPortCatalogBinding,
  type LegacyPortCatalogHandlerAttestation,
} from "./legacy-port-catalog.js";
import {
  buildContext,
  catalogTestFactory,
  prepareToolResponse,
  recordingTool,
  response,
  scriptedModel,
  stubClock,
  toolCall,
} from "./_support.js";
import { handleToolCall } from "./executor.js";
import { bindHarnessCatalog, captureModelToolCalls } from "./catalog-runtime.js";

const TASK = { taskType: "investigate-bug", input: { description: "Read accepted file" } } as const;
describe("native harness catalog consumer", () => {
  it("spans the concrete Gateway and native harness through one canonical settlement", async () => {
    const catalog = createInitialToolCatalog();
    const profile = { id: "legacy-native", version: 1 } as const;
    const projection = compileToolProjection(catalog, profile);
    const handlers: readonly LegacyPortCatalogHandlerAttestation[] = projection.tools.map(
      (tool) => {
        const descriptor = lookupCatalogTool(catalog, tool.toolRef);
        if (descriptor === undefined) throw new TypeError("Missing native catalog descriptor");
        return {
          alias: tool.alias,
          handlerId: descriptor.handlerRequirement.id,
          handlerVersion: descriptor.handlerRequirement.contractVersion,
          catalogAction: tool.alias,
        };
      },
    );
    const executed: string[] = [];
    const tools = recordingTool();
    const productivePort: HarnessDeps["tools"] = {
      ...tools.port,
      execute: (request) => {
        executed.push(request.toolName);
        return Promise.resolve({
          toolCallId: request.toolCallId,
          output: "bounded",
          durationMs: 1,
        });
      },
    };
    const binding = createLegacyPortCatalogBinding(catalog, profile, productivePort, handlers);
    let providerCalls = 0;
    const adapter: ProviderAdapter = {
      call: (_request, provider) => {
        providerCalls += 1;
        const gatewayCatalog = createGatewayToolCatalogBridge(_request, () => 0);
        return Promise.resolve(
          providerCalls === 1
            ? {
                modelId: provider.modelId,
                content: "",
                finishReason: "tool_calls" as const,
                toolCalls: gatewayCatalog.bindCalls([
                  {
                    id: "call-native-1",
                    name: "read_file",
                    arguments: { path: "fixture.txt" },
                  },
                ]),
                structuredOutput: null,
                usage: {
                  requestId: "provider-1",
                  promptTokens: 1,
                  completionTokens: 1,
                  latencyMs: 1,
                  costClass: "low" as const,
                },
              }
            : response(),
        );
      },
    };
    const config: GatewayConfig = {
      providers: [
        {
          modelId: "m",
          baseUrl: "https://provider.invalid/v1",
          apiKey: "fixture-key",
          timeoutMs: 1_000,
          maxRetries: 0,
          retryBaseDelayMs: 1,
        },
      ],
      circuitBreaker: { failureThreshold: 1, cooldownMs: 1_000, halfOpenProbes: 1 },
    };
    const gateway = new Gateway(config, { adapter });
    const session = createSession(
      TASK,
      { model: "m", workingDirectory: "/repo", dryRun: false },
      {
        model: new GatewayModelPort(gateway),
        tools: productivePort,
        bindToolCatalog: binding.factory,
        sink: new MemoryEventSink(),
        clock: stubClock().clock,
      },
    );

    const result = await session.result;
    expect(result).toMatchObject({ outcome: "completed" });
    expect(providerCalls).toBe(2);
    expect(executed).toEqual(["read_file"]);
    writeToolCatalogQualificationObservation({
      consumer: "native-harness-gateway",
      component: "native-harness-gateway",
      binding: {
        catalogRevision: binding.evidence.catalogRevision,
        profile: binding.evidence.profile,
        projectionDigest: binding.evidence.projectionDigest,
        handlerSetDigest: binding.evidence.handlerSetDigest,
      },
      terminalStatus: "completed",
      settlementCount: 1,
      proof: { kind: "single-settlement" },
    });
  });
  it("default dry-run does not bind or advertise productive tools", async () => {
    const model = scriptedModel([response()]);
    const tools = recordingTool([{ name: "run_command", description: "legacy", parameters: {} }]);
    const bindToolCatalog = vi.fn(catalogTestFactory(tools.port));
    const session = createSession(
      TASK,
      { model: "m", workingDirectory: "/repo" },
      {
        model: model.port,
        tools: tools.port,
        bindToolCatalog,
        sink: new MemoryEventSink(),
        clock: stubClock().clock,
      },
    );
    expect((await session.result).outcome).toBe("completed");
    expect(bindToolCatalog).not.toHaveBeenCalled();
    expect(model.requests()[0]).not.toHaveProperty("tools");
    expect(model.requests()[0]).not.toHaveProperty("toolCatalog");
    expect(tools.calls()).toHaveLength(0);
  });
  it("does not fall back to legacy execution without a catalog factory", async () => {
    const model = scriptedModel([
      response({ finishReason: "tool_calls", toolCalls: [toolCall("call-1")] }),
    ]);
    const tools = recordingTool();
    const session = createSession(
      TASK,
      { model: "m", workingDirectory: "/repo", dryRun: false },
      {
        model: model.port,
        tools: tools.port,
        sink: new MemoryEventSink(),
        clock: stubClock().clock,
      },
    );
    expect((await session.result).outcome).toBe("failed");
    expect(tools.calls()).toHaveLength(0);
  });
  it("rejects a bound command disguised by a read-only alias before reservation or execution", () => {
    const tools = recordingTool();
    const { ctx } = buildContext({
      task: TASK,
      tools: tools.port,
      model: scriptedModel([response()]).port,
    });
    ctx.lastResponse = response({ toolCalls: [toolCall("call-1", "run_command")] });
    prepareToolResponse(ctx);
    const command = ctx.lastResponse.toolCalls[0];
    if (command === undefined) throw new TypeError("Expected bound command");
    expect(() =>
      captureModelToolCalls(
        ctx,
        response({
          toolCalls: [{ ...command, name: "read_file", arguments: { path: "fixture.txt" } }],
        }),
      ),
    ).toThrow("disagrees");
    expect(ctx.counters).toMatchObject({ toolCalls: 0, commandExecutions: 0 });
    expect(tools.calls()).toHaveLength(0);
  });
  it("captures the approved argument view without evaluating getters or retaining mutable input", () => {
    const { ctx } = buildContext({ task: TASK, model: scriptedModel([response()]).port });
    ctx.lastResponse = response({ toolCalls: [toolCall("call-1")] });
    prepareToolResponse(ctx);
    const source = structuredClone(ctx.lastResponse);
    const captured = captureModelToolCalls(ctx, source);
    const call = source.toolCalls[0];
    if (call === undefined) throw new TypeError("Expected bound call");
    call.arguments.path = "changed.txt";
    expect(captured.toolCalls[0]?.arguments.path).toBe("fixture.txt");
    const getter = vi.fn(() => "private.txt");
    const args = Object.defineProperty({}, "path", { enumerable: true, get: getter });
    expect(() =>
      captureModelToolCalls(ctx, response({ toolCalls: [{ ...call, arguments: args }] })),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it("reports receipt-only replay as unavailable output without charging or executing again", async () => {
    const tools = recordingTool();
    const { ctx } = buildContext({
      task: TASK,
      tools: tools.port,
      model: scriptedModel([response()]).port,
    });
    const bindToolCatalog: NonNullable<HarnessDeps["bindToolCatalog"]> = (context) => ({
      ...catalogTestFactory(tools.port)(context),
      execute: () =>
        Promise.resolve({
          kind: "replayed",
          receipt: {
            invocationId: "prior-1",
            reservationId: "prior-1",
            settlementId: "settlement-1",
            effectStarted: true,
            budgetDisposition: "committed",
            status: "completed",
          },
        }),
    });
    ctx.catalog = bindHarnessCatalog(ctx, "run-1", bindToolCatalog);
    ctx.lastResponse = response({ toolCalls: [toolCall("call-1")] });
    prepareToolResponse(ctx);
    expect((await handleToolCall(ctx)).to).toBe("failed");
    expect(ctx.failure?.message).toContain("replay output unavailable");
    expect(ctx.counters.toolCalls).toBe(0);
    expect(tools.calls()).toHaveLength(0);
    expect(ctx.messages.some((message) => message.role === "tool")).toBe(false);
  });
  it("rejects oversized canonical output before completed evidence or optional shaping", async () => {
    const tools: HarnessDeps["tools"] = {
      execute: (request: Parameters<HarnessDeps["tools"]["execute"]>[0]) =>
        Promise.resolve({
          toolCallId: request.toolCallId,
          output: "x".repeat(65_537),
          durationMs: 0,
        }),
      listTools: () => [],
    };
    const shaperPort = vi.fn(() => undefined);
    const { ctx, sink } = buildContext({
      task: TASK,
      tools,
      model: scriptedModel([response()]).port,
      shaperPort,
    });
    ctx.lastResponse = response({ toolCalls: [toolCall("call-1")] });
    prepareToolResponse(ctx);
    expect((await handleToolCall(ctx)).to).toBe("failed");
    expect(sink.events().some((event) => event.type === "tool:call:completed")).toBe(false);
    expect(shaperPort).not.toHaveBeenCalled();
  });
});
