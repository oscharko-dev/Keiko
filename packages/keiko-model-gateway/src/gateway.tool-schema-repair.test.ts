import { ContextOverflowError } from "@oscharko-dev/keiko-security/errors/gateway";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { describe, expect, it, vi } from "vitest";
import { openCodeGatewayCatalogAdvertisement } from "./__fixtures__/toolCatalog.js";
import { Gateway, type GatewayCallRequest, type GatewaySpendReservation } from "./gateway.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import { countGatewayPromptTokens } from "./prompt-token-accounting.js";
import { createGatewayToolCatalogBridge } from "./toolCatalogBridge.js";
import type { Clock, GatewayConfig, ModelProviderConfig } from "./types.js";

const MODEL_ID = "fixture-model";
const NOW = Date.parse("2026-09-05T00:00:00.000Z");
const INVALID_ARGUMENT_SECRET = "private-invalid-argument-body";

function clock(): Clock {
  let current = NOW;
  return {
    now: (): number => current,
    sleep: (ms): Promise<void> => {
      current += ms;
      return Promise.resolve();
    },
  };
}

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    modelId: MODEL_ID,
    baseUrl: "https://provider.example/v1",
    apiKey: "fixture-key",
    timeoutMs: 30_000,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

function config(contextWindow = 64_000): GatewayConfig {
  return {
    capabilities: [
      {
        id: MODEL_ID,
        kind: "chat",
        contextWindow,
        maxOutputTokens: 4_096,
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: true,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "fixture",
        preferredUseCases: [],
        knownLimitations: [],
      },
    ],
    providers: [provider()],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
  };
}

function request(): GatewayCallRequest {
  return {
    modelId: MODEL_ID,
    messages: [{ role: "user", content: "bounded fixture request" }],
    toolCatalog: openCodeGatewayCatalogAdvertisement(NOW),
    logContext: { correlationId: "correlation-1" },
  };
}

function providerResponse(toolCallId: string, name: string, args: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "",
            tool_calls: [
              {
                id: toolCallId,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function successfulResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "corrected" } }],
      usage: { prompt_tokens: 12, completion_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function parsedProviderBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new TypeError("Expected provider JSON body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

function invalidArguments(callId: string): Response {
  return providerResponse(callId, "keiko_changeset_edit", {
    changeset: {
      patch: INVALID_ARGUMENT_SECRET,
      files: INVALID_ARGUMENT_SECRET,
      selectedFiles: [],
    },
  });
}

async function observedRepairPromptTokens(): Promise<number> {
  const events: ModelGatewayLogEvent[] = [];
  let calls = 0;
  await new Gateway(config(), {
    clock: clock(),
    random: (): number => 1,
    fetchImpl: (): Promise<Response> =>
      Promise.resolve(++calls === 1 ? invalidArguments("call-margin") : successfulResponse()),
    log: { write: (event): void => void events.push(event) },
  }).chat(request());
  const tokens = events.find((event) => event.op === "gateway.tool-catalog.repair")?.extra
    ?.promptTokens;
  if (typeof tokens !== "number") throw new TypeError("Expected measured repair token count");
  return tokens;
}

describe("Gateway bounded tool-schema repair", () => {
  it("retries an offered invalid-shape call with one body-free correction in the provider request", async () => {
    const bodies: Record<string, unknown>[] = [];
    const reserved: GatewayCallRequest[] = [];
    const settle = vi.fn();
    const events: ModelGatewayLogEvent[] = [];
    let providerCalls = 0;
    const fetchImpl: typeof fetch = (_url, init) => {
      bodies.push(parsedProviderBody(init));
      providerCalls += 1;
      return Promise.resolve(
        providerCalls === 1 ? invalidArguments("call-actual-1") : successfulResponse(),
      );
    };
    const gateway = new Gateway(config(), {
      fetchImpl,
      clock: clock(),
      random: (): number => 1,
      spendBudget: {
        reserve: (_capability, seen): GatewaySpendReservation => {
          reserved.push(seen);
          return { settle };
        },
      },
      log: { write: (event): void => void events.push(event) },
    });

    await expect(gateway.chat(request())).resolves.toMatchObject({
      content: "corrected",
      toolCalls: [],
    });

    expect(bodies).toHaveLength(2);
    expect(reserved).toHaveLength(2);
    expect(reserved[1]?.messages).toHaveLength(2);
    const serializedRepair = JSON.stringify(bodies[1]);
    expect(serializedRepair).toContain("call-actual-1");
    expect(serializedRepair).toContain("keiko_changeset_edit");
    expect(serializedRepair).toContain("rejected before execution");
    expect(serializedRepair).not.toContain(INVALID_ARGUMENT_SECRET);
    expect(events.find((event) => event.op === "gateway.tool-catalog.repair")).toMatchObject({
      correlationId: "correlation-1",
      extra: {
        state: "scheduled",
        reason: "invalid-shape",
        toolCallId: "call-actual-1",
        offeredAlias: "keiko_changeset_edit",
        correctionMessageCount: 1,
        effectStarted: false,
      },
    });
    expect(JSON.stringify(events)).not.toContain(INVALID_ARGUMENT_SECRET);
  });

  it("replaces the correction suffix across exhausted retries instead of growing the request", async () => {
    const bodies: Record<string, unknown>[] = [];
    const events: ModelGatewayLogEvent[] = [];
    let providerCalls = 0;
    const gateway = new Gateway(config(), {
      clock: clock(),
      random: (): number => 1,
      fetchImpl: (_url, init): Promise<Response> => {
        bodies.push(parsedProviderBody(init));
        providerCalls += 1;
        return Promise.resolve(invalidArguments(`call-${String(providerCalls)}`));
      },
      log: { write: (event): void => void events.push(event) },
    });

    await expect(gateway.chat(request())).rejects.toMatchObject({ retryable: true });

    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies)).not.toContain(INVALID_ARGUMENT_SECRET);
    expect(bodies.map((body) => (body.messages as unknown[]).length)).toEqual([1, 2, 2]);
    expect(JSON.stringify(bodies[1])).toContain("call-1");
    expect(JSON.stringify(bodies[2])).toContain("call-2");
    expect(JSON.stringify(bodies[2])).not.toContain("call-1");
    expect(events.filter((event) => event.op === "gateway.tool-catalog.repair")).toHaveLength(2);
  });

  it("does not add repair feedback for an unoffered tool identity rejection", async () => {
    const bodies: Record<string, unknown>[] = [];
    let providerCalls = 0;
    const gateway = new Gateway(config(), {
      clock: clock(),
      random: (): number => 1,
      fetchImpl: (_url, init): Promise<Response> => {
        bodies.push(parsedProviderBody(init));
        providerCalls += 1;
        return Promise.resolve(
          providerCalls === 1
            ? providerResponse("call-unoffered", "not_an_offered_tool", {})
            : successfulResponse(),
        );
      },
    });

    await expect(gateway.chat(request())).resolves.toMatchObject({ content: "corrected" });

    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.messages)).toEqual([
      [{ role: "user", content: "bounded fixture request" }],
      [{ role: "user", content: "bounded fixture request" }],
    ]);
  });

  it("fails before a second provider call when prompt fits but its output reservation would overflow", async () => {
    const base = request();
    const tools = createGatewayToolCatalogBridge(base, (): number => NOW).tools;
    const basePromptTokens = countGatewayPromptTokens({ messages: base.messages, tools });
    const contextWindow = basePromptTokens + 2_048;
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(invalidArguments("call-context")));
    const events: ModelGatewayLogEvent[] = [];
    const gateway = new Gateway(config(contextWindow), {
      fetchImpl,
      clock: clock(),
      log: { write: (event): void => void events.push(event) },
    });

    await expect(gateway.chat(base)).rejects.toBeInstanceOf(ContextOverflowError);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const repair = events.find((event) => event.op === "gateway.tool-catalog.repair");
    expect(repair).toMatchObject({
      extra: {
        state: "denied",
        reason: "context-window-exceeded",
        toolCallId: "call-context",
        offeredAlias: "keiko_changeset_edit",
        maxOutputTokens: 4_096,
        effectStarted: false,
      },
    });
    expect(repair?.extra?.promptTokens).toBeLessThan(contextWindow);
    const capability = config(contextWindow).capabilities?.[0];
    if (capability === undefined) throw new TypeError("Expected fixture capability");
    expect(repair?.extra?.maxPromptTokens).toBe(
      deriveContextProfileFromCapability(capability).effectiveInputBudget,
    );
    expect(JSON.stringify(events)).not.toContain(INVALID_ARGUMENT_SECRET);
  });

  it("does not create repair metadata before a provider call is safely captured", () => {
    const bridge = createGatewayToolCatalogBridge(request(), (): number => NOW);
    const argumentsWithCycle: Record<string, unknown> = {};
    argumentsWithCycle.self = argumentsWithCycle;
    expect(() =>
      bridge.bind({
        id: "call-cycle",
        name: "keiko_changeset_edit",
        arguments: argumentsWithCycle,
      }),
    ).toThrow(expect.objectContaining({ repair: undefined }));
  });

  it("refuses a repair inside the reserved safety margin before another provider call", async () => {
    const promptTokens = await observedRepairPromptTokens();
    const boundedConfig = config(promptTokens + 4_096);
    const capability = boundedConfig.capabilities?.[0];
    if (capability === undefined) throw new TypeError("Expected fixture capability");
    const context = deriveContextProfileFromCapability(capability);
    expect(context.safetyMarginTokens).toBeGreaterThan(0);
    expect(promptTokens).toBe(context.maxInputTokens - context.reservedOutputTokens);
    expect(promptTokens).toBeGreaterThan(context.effectiveInputBudget);
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(invalidArguments("call-margin")));
    const events: ModelGatewayLogEvent[] = [];
    const gateway = new Gateway(boundedConfig, {
      fetchImpl,
      clock: clock(),
      random: (): number => 1,
      log: { write: (event): void => void events.push(event) },
    });

    await expect(gateway.chat(request())).rejects.toBeInstanceOf(ContextOverflowError);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(events.find((event) => event.op === "gateway.tool-catalog.repair")).toMatchObject({
      extra: {
        state: "denied",
        promptTokens,
        safetyMarginTokens: context.safetyMarginTokens,
        effectStarted: false,
      },
    });
  });
});
