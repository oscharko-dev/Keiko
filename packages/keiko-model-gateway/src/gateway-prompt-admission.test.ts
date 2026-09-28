import { describe, expect, it, vi } from "vitest";
import { GatewayPromptAdmission, ProviderPromptCounter } from "./gateway-prompt-admission.js";
import { createDefaultChatCapability } from "./capabilities.js";
import type { GatewayCallRequest } from "./gateway.js";
import type { ModelProviderConfig } from "./types.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { countGatewayPromptTokens } from "./prompt-token-accounting.js";

const provider: ModelProviderConfig = {
  modelId: "fixture",
  baseUrl: "https://fixture.example/v1",
  apiKey: "fixture",
  tokenCounter: "litellm",
  timeoutMs: 1000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};
const request: GatewayCallRequest = {
  modelId: "fixture",
  messages: [{ role: "user", content: "question" }],
};
const capability = {
  ...createDefaultChatCapability("fixture"),
  contextWindow: 4096,
  maxOutputTokens: 1024,
};
const log = { write: (): void => undefined };

describe("provider counter availability", () => {
  it("remembers rejection for a bounded interval and retries afterward", async () => {
    let now = 0;
    const counter = new ProviderPromptCounter(() => now);
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 403 })),
    );
    await counter.count(request, provider, log, fetchImpl);
    await counter.count(request, provider, log, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();
    now += 60_001;
    await counter.count(request, provider, log, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not disable the provider counter after caller cancellation", async () => {
    const counter = new ProviderPromptCounter(() => 1);
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ total_tokens: 20 })),
    );
    await counter.count(
      { ...request, cancellationSignal: AbortSignal.abort() },
      provider,
      log,
      fetchImpl,
    );
    await expect(counter.count(request, provider, log, fetchImpl)).resolves.toMatchObject({
      status: "available",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

it("retains a prior measured contribution if counting fails during a repair", async () => {
  const events: ModelGatewayLogEvent[] = [];
  const budget = deriveContextProfileFromCapability(capability).effectiveInputBudget;
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ total_tokens: budget - 1 }))
    .mockResolvedValueOnce(new Response(null, { status: 403 }));
  const admission = new GatewayPromptAdmission({
    provider,
    capability,
    now: (): number => 1,
    counter: new ProviderPromptCounter(() => 1),
    correlationId: "retained-counter",
    fetchImpl,
    log: {
      write: (event): void => {
        events.push(event);
      },
    },
  });
  await admission.admit(request, 10_000);
  const repaired = {
    ...request,
    messages: [
      ...request.messages,
      { role: "system" as const, content: "Correct the previous invalid tool call." },
    ],
  };
  expect(countGatewayPromptTokens(repaired)).toBeLessThan(budget);
  await expect(admission.admit(repaired, 10_000)).rejects.toMatchObject({
    code: "GATEWAY_CONTEXT_OVERFLOW",
  });
  expect(
    events.filter((event) => event.op === "gateway.prompt.admission").at(-1)?.extra,
  ).toMatchObject({ state: "overflow", counterStatus: "unavailable" });
});

it("settles a typed timeout if counting exhausts the remaining call budget", async () => {
  let now = 1;
  const admission = new GatewayPromptAdmission({
    provider,
    capability,
    now: (): number => now,
    counter: new ProviderPromptCounter(() => now),
    correlationId: "counter-timeout",
    log,
    fetchImpl: (): Promise<Response> => {
      now += 100;
      return Promise.resolve(Response.json({ total_tokens: 20 }));
    },
  });
  await expect(admission.admit(request, 100)).rejects.toMatchObject({ code: "GATEWAY_TIMEOUT" });
});

it.each([50, 100])("charges the complete local admission duration of %i ms", async (duration) => {
  let now = 0;
  const admission = new GatewayPromptAdmission({
    provider,
    capability,
    now: (): number => now,
    counter: new ProviderPromptCounter(() => now),
    correlationId: "local-admission-budget",
    fetchImpl: (): Promise<Response> => Promise.resolve(Response.json({ total_tokens: 20 })),
    log: {
      write: (event): void => {
        if (event.op === "gateway.prompt.admission") now += duration;
      },
    },
  });
  const result = admission.admit(request, 100);
  if (duration === 100) await expect(result).rejects.toMatchObject({ code: "GATEWAY_TIMEOUT" });
  else await expect(result).resolves.toBe(50);
});
