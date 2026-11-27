import { describe, expect, it } from "vitest";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { createDefaultChatCapability } from "./capabilities.js";
import { Gateway } from "./gateway.js";
import { GatewayPromptAdmission, ProviderPromptCounter } from "./gateway-prompt-admission.js";
import type { GatewayCallRequest } from "./gateway.js";
import { PromptCalibrationLedger } from "./prompt-calibration.js";
import { countGatewayPromptTokens } from "./prompt-token-accounting.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import type { GatewayStreamChunk, ModelProviderConfig, NormalizedResponse } from "./types.js";

const provider: ModelProviderConfig = {
  modelId: "gemma-fixture",
  baseUrl: "https://fixture.example/v1",
  apiKey: "fixture",
  timeoutMs: 1000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};
const capability = {
  ...createDefaultChatCapability("gemma-fixture"),
  contextWindow: 131_072,
  maxOutputTokens: 20_480,
};
const inputBudget = deriveContextProfileFromCapability(capability).effectiveInputBudget;

function repetitiveText(tokens: number): string {
  const line = "trace 1 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n";
  const sample = 2_000;
  const perLine =
    countGatewayPromptTokens({ messages: [{ role: "user", content: line.repeat(sample) }] }) /
    sample;
  return line.repeat(Math.ceil(tokens / perLine));
}

function conversation(extraTokens: number): GatewayCallRequest["messages"] {
  return [
    { role: "user", content: "run the trace" },
    { role: "assistant", content: "running" },
    { role: "user", content: repetitiveText(extraTokens) },
  ];
}

function localTokens(messages: GatewayCallRequest["messages"]): number {
  return countGatewayPromptTokens({ messages });
}

function extended(
  messages: GatewayCallRequest["messages"],
  growthTokens: number,
): GatewayCallRequest["messages"] {
  return [
    ...messages,
    { role: "assistant", content: "done" },
    { role: "user", content: repetitiveText(growthTokens) },
  ];
}

function admissionFor(
  ledger: PromptCalibrationLedger,
  events: ModelGatewayLogEvent[],
): GatewayPromptAdmission {
  return new GatewayPromptAdmission({
    provider,
    capability,
    now: (): number => 1,
    counter: new ProviderPromptCounter(() => 1),
    correlationId: "calibration",
    calibration: ledger,
    log: {
      write: (event): void => {
        events.push(event);
      },
    },
  });
}

async function turn(
  ledger: PromptCalibrationLedger,
  messages: GatewayCallRequest["messages"],
  providerUsage: number | undefined,
  events: ModelGatewayLogEvent[] = [],
): Promise<void> {
  const admission = admissionFor(ledger, events);
  try {
    await admission.admit({ modelId: provider.modelId, messages }, 10_000);
  } finally {
    if (providerUsage !== undefined) admission.recordUsage(providerUsage);
  }
}

function lastAdmission(events: readonly ModelGatewayLogEvent[]): Record<string, unknown> {
  return events.filter((event) => event.op === "gateway.prompt.admission").at(-1)?.extra ?? {};
}

describe("usage-calibrated prompt admission", () => {
  it("admits a prompt the local estimate over-counts by 65% once the prefix usage is known", async () => {
    const ledger = new PromptCalibrationLedger();
    const first = conversation(inputBudget - 12_000);
    const firstLocal = localTokens(first);
    expect(firstLocal).toBeLessThan(inputBudget);
    const reported = Math.round(firstLocal * 0.6);
    await turn(ledger, first, reported);
    const second = extended(first, 16_000);
    // Today's rule: the local estimate of the whole prompt is over the budget.
    expect(localTokens(second)).toBeGreaterThan(inputBudget);
    const events: ModelGatewayLogEvent[] = [];
    await turn(ledger, second, undefined, events);
    const extra = lastAdmission(events);
    expect(extra).toMatchObject({
      state: "admitted",
      counterSource: "usage-calibrated",
      localPromptTokens: localTokens(second),
    });
    expect(extra.calibratedPromptTokens).toBeGreaterThan(reported);
    expect(extra.promptTokens).toBe(extra.calibratedPromptTokens);
    expect(extra.promptTokens).toBeLessThan(inputBudget);
  });

  it("refuses the same prompt without a recorded prefix (conservative fallback)", async () => {
    const second = extended(conversation(inputBudget - 12_000), 16_000);
    const events: ModelGatewayLogEvent[] = [];
    await expect(
      turn(new PromptCalibrationLedger(), second, undefined, events),
    ).rejects.toMatchObject({ code: "GATEWAY_CONTEXT_OVERFLOW" });
    expect(lastAdmission(events)).toMatchObject({
      state: "overflow",
      counterSource: "fallback-estimated",
    });
    expect(lastAdmission(events)).not.toHaveProperty("calibratedPromptTokens");
  });

  it("falls back to the local estimate when the prefix is not extended", async () => {
    const ledger = new PromptCalibrationLedger();
    const first = conversation(30_000);
    await turn(ledger, first, 10_000);
    const unrelated = [{ role: "user" as const, content: "something else" }, ...first.slice(1)];
    const events: ModelGatewayLogEvent[] = [];
    await turn(ledger, unrelated, undefined, events);
    expect(lastAdmission(events)).not.toHaveProperty("calibratedPromptTokens");
    expect(lastAdmission(events).promptTokens).toBe(localTokens(unrelated));
  });

  it("still refuses a true overflow when the calibrated estimate exceeds the budget", async () => {
    const ledger = new PromptCalibrationLedger();
    const first = conversation(30_000);
    await turn(ledger, first, inputBudget - 1_000);
    const events: ModelGatewayLogEvent[] = [];
    await expect(turn(ledger, extended(first, 20_000), undefined, events)).rejects.toMatchObject({
      code: "GATEWAY_CONTEXT_OVERFLOW",
    });
    expect(lastAdmission(events)).toMatchObject({ state: "overflow" });
    expect(lastAdmission(events).calibratedPromptTokens).toBeGreaterThan(inputBudget);
  });

  it("never estimates below the provider's reported usage of the prefix", async () => {
    const ledger = new PromptCalibrationLedger();
    const first = conversation(20_000);
    const reported = localTokens(first) + 5_000;
    await turn(ledger, first, reported);
    const events: ModelGatewayLogEvent[] = [];
    await turn(ledger, first, undefined, events);
    expect(lastAdmission(events).calibratedPromptTokens).toBeGreaterThanOrEqual(reported);
  });
});

function reportingGateway(events: ModelGatewayLogEvent[]): Gateway {
  const adapterCall = (): Promise<NormalizedResponse> =>
    Promise.resolve({
      modelId: provider.modelId,
      content: "answer",
      toolCalls: [],
      structuredOutput: null,
      finishReason: "stop",
      usage: {
        requestId: "fixture",
        promptTokens: 2_000,
        completionTokens: 1,
        latencyMs: 1,
        costClass: "low",
      },
    });
  return new Gateway(
    { providers: [provider], capabilities: [capability] },
    {
      log: {
        write: (event): void => {
          events.push(event);
        },
      },
      adapter: {
        call: adapterCall,
        callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
          yield { type: "done", response: await adapterCall() };
        },
      },
    },
  );
}

describe("gateway wiring of provider usage", () => {
  it.each([false, true])(
    "calibrates the next call of a conversation from the reported usage, streaming=%s",
    async (streaming) => {
      const events: ModelGatewayLogEvent[] = [];
      const gateway = reportingGateway(events);
      const send = async (messages: GatewayCallRequest["messages"]): Promise<void> => {
        if (streaming)
          for await (const chunk of gateway.chatStream({ modelId: provider.modelId, messages }))
            expect(chunk).toBeDefined();
        else await gateway.chat({ modelId: provider.modelId, messages });
      };
      const first = conversation(6_000);
      await send(first);
      await send(extended(first, 1_000));
      const admissions = events.filter((event) => event.op === "gateway.prompt.admission");
      expect(admissions).toHaveLength(2);
      expect(admissions[0]?.extra).not.toHaveProperty("calibratedPromptTokens");
      expect(admissions[1]?.extra).toMatchObject({ counterSource: "usage-calibrated" });
      expect(admissions[1]?.extra?.calibratedPromptTokens).toBeGreaterThan(2_000);
    },
  );
});
