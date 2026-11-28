import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { describe, expect, it } from "vitest";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { createDefaultChatCapability } from "./capabilities.js";
import { Gateway } from "./gateway.js";
import { GatewayPromptAdmission, ProviderPromptCounter } from "./gateway-prompt-admission.js";
import type { GatewayCallRequest } from "./gateway.js";
import {
  MIN_PLAUSIBLE_USAGE_RATIO,
  PromptCalibrationLedger,
  type PromptCalibrationMark,
} from "./prompt-calibration.js";
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
  target: ModelProviderConfig = provider,
): GatewayPromptAdmission {
  return new GatewayPromptAdmission({
    provider: target,
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
  target: ModelProviderConfig = provider,
): Promise<void> {
  const admission = admissionFor(ledger, events, target);
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
    const first = conversation(inputBudget - 12_000);
    await turn(ledger, first, Math.round(localTokens(first) * 1.05));
    const events: ModelGatewayLogEvent[] = [];
    await expect(turn(ledger, extended(first, 20_000), undefined, events)).rejects.toMatchObject({
      code: "GATEWAY_CONTEXT_OVERFLOW",
    });
    expect(lastAdmission(events)).toMatchObject({ state: "overflow" });
    expect(lastAdmission(events).calibratedPromptTokens).toBeGreaterThan(inputBudget);
  });

  it.each([1, 200])(
    "does not trust a report of %i tokens for a prefix that fills most of the window (cache-excluded usage)",
    async (reported) => {
      const ledger = new PromptCalibrationLedger();
      const first = conversation(inputBudget - 12_000);
      expect(reported).toBeLessThan(localTokens(first) * MIN_PLAUSIBLE_USAGE_RATIO);
      const reportEvents: ModelGatewayLogEvent[] = [];
      await turn(ledger, first, reported, reportEvents);
      const rejected = reportEvents.find((event) => event.op === "gateway.prompt.usage-rejected");
      if (rejected === undefined) throw new Error("Expected the rejected-usage line");
      expect(
        expectActivityLogProof(
          "gateway.prompt.usage-rejected.implausibly-low",
          formatActivityLogProofLine(rejected),
        ),
      ).toMatchObject({ modelIdDigest: sha256Hex(provider.modelId).slice(0, 16) });
      expect(
        reportEvents.filter((event) => event.op === "gateway.prompt.usage-rejected"),
      ).toHaveLength(1);
      expect(rejected.extra).toMatchObject({
        reason: "implausibly-low",
        reportedPromptTokens: reported,
        localPromptTokens: localTokens(first),
      });
      // The follow-up really is over the budget: it must keep the conservative local bound and be
      // refused, not admitted as `reported` plus its growth.
      const followUp = extended(first, 16_000);
      expect(localTokens(followUp)).toBeGreaterThan(inputBudget);
      const events: ModelGatewayLogEvent[] = [];
      await expect(turn(ledger, followUp, undefined, events)).rejects.toMatchObject({
        code: "GATEWAY_CONTEXT_OVERFLOW",
      });
      expect(lastAdmission(events)).toMatchObject({
        state: "overflow",
        counterSource: "fallback-estimated",
        promptTokens: localTokens(followUp),
      });
      expect(lastAdmission(events)).not.toHaveProperty("calibratedPromptTokens");
    },
  );

  it("never calibrates from a report whose cache layout is ambiguous and says so", async () => {
    const ledger = new PromptCalibrationLedger();
    const first = conversation(20_000);
    // A figure well inside the plausibility band: only the layout makes it unusable.
    const reported = Math.round(localTokens(first) * 0.7);
    const events: ModelGatewayLogEvent[] = [];
    const admission = admissionFor(ledger, events);
    await admission.admit({ modelId: provider.modelId, messages: first }, 10_000);
    admission.recordUsage(reported, "ambiguous");
    const rejected = events.find((event) => event.op === "gateway.prompt.usage-rejected");
    if (rejected === undefined) throw new Error("Expected the rejected-usage line");
    expect(
      expectActivityLogProof(
        "gateway.prompt.usage-rejected.ambiguous-cache-layout",
        formatActivityLogProofLine(rejected),
      ),
    ).toMatchObject({ reason: "ambiguous-cache-layout", reportedPromptTokens: reported });
    const next: ModelGatewayLogEvent[] = [];
    await turn(ledger, extended(first, 1_000), undefined, next);
    expect(lastAdmission(next)).not.toHaveProperty("calibratedPromptTokens");
  });

  it.each(["image_url", "file"] as const)(
    "does not learn from a prompt with a %s part whose raw text estimate omits it",
    async (kind) => {
      const ledger = new PromptCalibrationLedger();
      const media: GatewayCallRequest["messages"] = [
        {
          role: "user",
          content: "describe",
          contentParts: [
            { type: "text", text: repetitiveText(20_000) },
            kind === "image_url"
              ? { type: "image_url", image_url: { url: "https://fixture.example/a.png" } }
              : {
                  type: "file",
                  file: { filename: "a.pdf", file_data: "data:application/pdf;base64,AA==" },
                },
          ],
        },
      ];
      // An in-band figure that would otherwise be recorded as this prefix's real size.
      await turn(ledger, media, Math.round(localTokens(media) * 0.7));
      const next: ModelGatewayLogEvent[] = [];
      await turn(ledger, [...media, { role: "assistant", content: "ok" }], undefined, next);
      expect(lastAdmission(next)).not.toHaveProperty("calibratedPromptTokens");
    },
  );

  it("logs an inflated report as implausibly-high and admits the next prompt locally", async () => {
    const ledger = new PromptCalibrationLedger();
    const first = conversation(20_000);
    const reported = localTokens(first) * 3;
    const events: ModelGatewayLogEvent[] = [];
    await turn(ledger, first, reported, events);
    const rejected = events.find((event) => event.op === "gateway.prompt.usage-rejected");
    if (rejected === undefined) throw new Error("Expected the rejected-usage line");
    expect(
      expectActivityLogProof(
        "gateway.prompt.usage-rejected.implausibly-high",
        formatActivityLogProofLine(rejected),
      ),
    ).toMatchObject({ reportedPromptTokens: reported });
    const next: ModelGatewayLogEvent[] = [];
    await turn(ledger, extended(first, 1_000), undefined, next);
    expect(lastAdmission(next)).not.toHaveProperty("calibratedPromptTokens");
  });

  it("keeps an earlier plausible record when a later report is implausible", async () => {
    const ledger = new PromptCalibrationLedger();
    const first = conversation(20_000);
    const reported = Math.round(localTokens(first) * 0.6);
    await turn(ledger, first, reported);
    const second = extended(first, 2_000);
    await turn(ledger, second, 1);
    const events: ModelGatewayLogEvent[] = [];
    await turn(ledger, extended(second, 500), undefined, events);
    expect(lastAdmission(events).calibratedPromptTokens).toBeGreaterThan(reported);
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

function reportingGateway(
  events: ModelGatewayLogEvent[],
  usage: Partial<NormalizedResponse["usage"]> = {},
): Gateway {
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
        ...usage,
      },
    });
  return new Gateway(
    {
      providers: [provider],
      capabilities: [capability],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
    },
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

// Live macOS lab, Gemma 4 31B via LiteLLM/Ollama, first turn of a large-repository run: the local
// estimate was 58,954 and the provider reported 35,798 with no caching involved (ratio 0.61).
const GEMMA_LOCAL = 58_954;
const GEMMA_REPORTED = 35_798;

describe("plausibility floor that learns the model's own ratio", () => {
  const mark = (localTokens: number, digest: string): PromptCalibrationMark => ({
    modelId: "gemma",
    messageCount: 3,
    digest,
    localTokens,
  });

  it("keeps the denser tokenizer's legitimate 0.61 report calibrated", () => {
    expect(GEMMA_REPORTED / GEMMA_LOCAL).toBeCloseTo(0.607, 3);
    const ledger = new PromptCalibrationLedger();
    expect(ledger.record(mark(GEMMA_LOCAL, "a"), GEMMA_REPORTED)).toBe("recorded");
    expect(ledger.record(mark(GEMMA_LOCAL + 4_000, "b"), 40_000)).toBe("recorded");
  });

  it("refuses a cache-excluded report once the ratio is learned, even above the absolute floor", () => {
    const ledger = new PromptCalibrationLedger();
    ledger.record(mark(GEMMA_LOCAL, "a"), GEMMA_REPORTED);
    // 0.28 of the local estimate clears the unlearned quarter floor, but is under half of 0.61.
    const partlyCached = Math.round((GEMMA_LOCAL + 4_000) * 0.28);
    expect(partlyCached).toBeGreaterThan((GEMMA_LOCAL + 4_000) * MIN_PLAUSIBLE_USAGE_RATIO);
    expect(ledger.record(mark(GEMMA_LOCAL + 4_000, "b"), partlyCached)).toBe("implausibly-low");
    expect(ledger.record(mark(GEMMA_LOCAL + 4_000, "c"), 1)).toBe("implausibly-low");
    expect(new PromptCalibrationLedger().record(mark(GEMMA_LOCAL + 4_000, "b"), partlyCached)).toBe(
      "recorded",
    );
  });

  it("falls back to the absolute floor for a model with no learned ratio", () => {
    const ledger = new PromptCalibrationLedger();
    expect(ledger.record(mark(GEMMA_LOCAL, "a"), 200)).toBe("implausibly-low");
    expect(ledger.record(mark(GEMMA_LOCAL, "a"), GEMMA_REPORTED)).toBe("recorded");
  });

  it("is not poisoned by one report near 1: honest 0.40 reports stay calibrated", () => {
    const ledger = new PromptCalibrationLedger();
    // Template or tool-schema overhead on a short prompt can make a single ratio near 1.
    expect(ledger.record(mark(2_000, "a"), 1_990)).toBe("recorded");
    for (const [index, local] of [30_000, 42_000, 55_000].entries())
      expect(ledger.record(mark(local, `h${String(index)}`), Math.round(local * 0.4))).toBe(
        "recorded",
      );
    // The floor stays bounded, so a cache-excluded report is still refused.
    expect(ledger.record(mark(60_000, "x"), 300)).toBe("implausibly-low");
  });

  it("refuses an inflated report above twice the local estimate and never learns from it", () => {
    const ledger = new PromptCalibrationLedger();
    expect(ledger.record(mark(9_000, "a"), 30_000)).toBe("implausibly-high");
    expect(ledger.record(mark(9_000, "b"), 18_000)).toBe("recorded");
    expect(ledger.record(mark(9_000, "c"), 18_001)).toBe("implausibly-high");
    // The refused figure left nothing behind to over-estimate a later prompt.
    expect(ledger.record(mark(9_000, "d"), 5_400)).toBe("recorded");
  });

  it("lets a model whose honest ratio is low keep reporting it", () => {
    const ledger = new PromptCalibrationLedger();
    expect(ledger.record(mark(10_000, "a"), 3_000)).toBe("recorded");
    expect(ledger.record(mark(12_000, "b"), 3_600)).toBe("recorded");
    expect(ledger.record(mark(12_000, "c"), 1_000)).toBe("implausibly-low");
  });

  it("keeps calibrating a conversation from the Gemma report end to end", async () => {
    const ledger = new PromptCalibrationLedger();
    const first = conversation(inputBudget - 12_000);
    const reported = Math.round(localTokens(first) * (GEMMA_REPORTED / GEMMA_LOCAL));
    const events: ModelGatewayLogEvent[] = [];
    await turn(ledger, first, reported, events);
    expect(events.some((event) => event.op === "gateway.prompt.usage-rejected")).toBe(false);
    const second: ModelGatewayLogEvent[] = [];
    await turn(ledger, extended(first, 16_000), undefined, second);
    expect(lastAdmission(second)).toMatchObject({
      state: "admitted",
      counterSource: "usage-calibrated",
    });
  });
});

describe("calibration key", () => {
  it.each([
    ["a different deployment behind the alias", { deploymentIdentitySha256: "d".repeat(64) }],
    ["a different endpoint behind the alias", { baseUrl: "https://other.example/v1" }],
  ])("does not reuse a ratio measured for %s", async (_name, change) => {
    const ledger = new PromptCalibrationLedger();
    const first = conversation(30_000);
    await turn(ledger, first, 10_000);
    const events: ModelGatewayLogEvent[] = [];
    await turn(ledger, first, undefined, events, { ...provider, ...change });
    expect(lastAdmission(events)).not.toHaveProperty("calibratedPromptTokens");
    const same: ModelGatewayLogEvent[] = [];
    await turn(ledger, first, undefined, same);
    expect(lastAdmission(same)).toHaveProperty("calibratedPromptTokens");
  });
});

describe("gateway wiring of provider usage", () => {
  it("calibrates from the total including cache tokens a provider reports beside prompt_tokens", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const first = conversation(6_000);
    const total = Math.round(localTokens(first) * 0.8);
    const gateway = reportingGateway(events, { promptTokens: 200, totalPromptTokens: total });
    await gateway.chat({ modelId: provider.modelId, messages: first });
    await gateway.chat({ modelId: provider.modelId, messages: extended(first, 1_000) });
    const admissions = events.filter((event) => event.op === "gateway.prompt.admission");
    expect(admissions[1]?.extra).toMatchObject({ counterSource: "usage-calibrated" });
    expect(admissions[1]?.extra?.calibratedPromptTokens).toBeGreaterThan(total);
    expect(events.some((event) => event.op === "gateway.prompt.usage-rejected")).toBe(false);
  });

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
