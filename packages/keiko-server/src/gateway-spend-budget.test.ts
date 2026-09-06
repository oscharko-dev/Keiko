import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Gateway,
  type GatewayConfig,
  type ModelCapability,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import {
  createGatewaySpendBudget,
  QUALIFICATION_SPEND_BUDGET_USD_ENV,
  QUALIFICATION_SPEND_LEDGER_PATH_ENV,
} from "./gateway-spend-budget.js";
import type { ServerLogEvent } from "./observability/server-log.js";

const capability: ModelCapability = {
  id: "spend-fixture",
  kind: "chat",
  contextWindow: 100,
  maxOutputTokens: 20,
  toolCalling: false,
  structuredOutput: false,
  streaming: true,
  supportsImageInput: false,
  supportsDocumentInput: false,
  workflowEligible: false,
  costClass: "low",
  latencyClass: "fast",
  throughputHint: "test",
  preferredUseCases: [],
  knownLimitations: [],
  pricing: { inputUsdPerMillionTokens: 1_000_000, outputUsdPerMillionTokens: 1_000_000 },
};
const request = {
  modelId: capability.id,
  messages: [{ role: "user" as const, content: "private input" }],
  maxOutputTokens: 20,
};
const response: NormalizedResponse = {
  modelId: capability.id,
  content: "private output",
  finishReason: "stop",
  toolCalls: [],
  structuredOutput: null,
  usage: {
    requestId: "request",
    promptTokens: 10,
    completionTokens: 10,
    latencyMs: 1,
    costClass: "low",
  },
};
let directory: string;
const events: ServerLogEvent[] = [];
function budget(
  limit = "150",
  path = join(directory, "spend.db"),
): NonNullable<ReturnType<typeof createGatewaySpendBudget>> {
  const result = createGatewaySpendBudget(
    { [QUALIFICATION_SPEND_BUDGET_USD_ENV]: limit, [QUALIFICATION_SPEND_LEDGER_PATH_ENV]: path },
    {
      write: (event) => {
        events.push(event);
      },
    },
  );
  if (result === undefined) throw new TypeError("fixture budget missing");
  return result;
}

function expectStructuredRejection(reason: string): void {
  const event = events.at(-1);
  expect(event?.op).toBe("gateway.spend.rejected");
  expect(event?.extra?.reason).toBe(reason);
  const frames = event?.extra?.frames;
  expect(Array.isArray(frames)).toBe(true);
  if (!Array.isArray(frames)) throw new TypeError("expected rejection frames");
  expect(frames.length).toBeGreaterThan(0);
  expect(Array.isArray(event?.extra?.causeChain)).toBe(true);
}
const config: GatewayConfig = {
  providers: [
    {
      modelId: capability.id,
      baseUrl: "https://provider.example/v1",
      apiKey: "fixture",
      timeoutMs: 1000,
      maxRetries: 0,
      retryBaseDelayMs: 1,
    },
  ],
  capabilities: [capability],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "keiko-spend-"));
  events.length = 0;
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("shared persistent model spend admission", () => {
  it("records reconstructable diagnostics for caught and locally-constructed rejections", () => {
    expect(() =>
      budget().reserve({ ...capability, pricing: undefined }, request, "pricing-rejection"),
    ).toThrow("spend-pricing-unavailable");
    expectStructuredRejection("spend-pricing-unavailable");

    expect(() => budget("0").reserve(capability, request, "budget-rejection")).toThrow(
      "spend-budget-exceeded",
    );
    expectStructuredRejection("spend-budget-exceeded");
  });

  it("admits zero output only for a validated embedding capability", () => {
    const embedding: ModelCapability = {
      ...capability,
      id: "embedding-fixture",
      kind: "embedding",
      maxOutputTokens: 0,
    };
    const reservation = budget().reserve(
      embedding,
      { modelId: embedding.id, messages: [{ role: "user", content: "private input" }] },
      "embedding-probe",
    );
    reservation.settle({
      ...response.usage,
      promptTokens: 10,
      completionTokens: 0,
    });
    expect(() =>
      budget().reserve(
        { ...capability, maxOutputTokens: 0 },
        { modelId: capability.id, messages: [] },
        "invalid-chat",
      ),
    ).toThrow("spend-bound-unavailable");
  });

  it("does not enforce a qualification ceiling when no spend budget is configured", async () => {
    const call = vi.fn(() => Promise.resolve(response));
    const spendBudget = createGatewaySpendBudget({});
    expect(spendBudget).toBeUndefined();
    const gateway = new Gateway(config, { adapter: { call }, spendBudget });
    await expect(gateway.chat(request)).resolves.toMatchObject({ content: response.content });
    expect(call).toHaveBeenCalledOnce();
  });

  it("retains uncertain reservations across new ports and rejects overlap before provider dispatch", async () => {
    const firstBudget = budget();
    const hold = firstBudget.reserve(capability, request, "first");
    const call = vi.fn(() => Promise.resolve(response));
    const gateway = new Gateway(config, { adapter: { call }, spendBudget: budget() });
    await expect(gateway.chat(request)).rejects.toThrow("spend-budget-exceeded");
    expect(call).not.toHaveBeenCalled();
    hold.settle(undefined);
    expect(() => budget().reserve(capability, request, "restart")).toThrow("spend-budget-exceeded");
  });

  it("settles measured usage once and lets other model sources use the same remaining budget", () => {
    const hold = budget().reserve(capability, request, "workbench");
    hold.settle(response.usage);
    hold.settle(response.usage);
    const next = budget().reserve(capability, request, "chat");
    next.settle(response.usage);
    expect(() => budget().reserve(capability, request, "sidecar")).toThrow("spend-budget-exceeded");
    expect(events.filter((event) => event.op === "gateway.spend.settled")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(JSON.stringify(events)).not.toContain(directory);
  });

  it("records a violated provider cost bound and closes the ledger against further calls", () => {
    const hold = budget().reserve(capability, request, "bounded");
    expect(() => {
      hold.settle({ ...response.usage, promptTokens: 200 });
    }).toThrow("spend-bound-unavailable");
    const event = events.find((candidate) => candidate.op === "gateway.spend.settled");
    expect(event?.extra?.chargedNanoUsd).toBe(210_000_000_000);
    expect(event?.extra?.boundExceeded).toBe(true);
    expect(() => budget().reserve(capability, request, "after-bound-violation")).toThrow(
      "spend-budget-exceeded",
    );
  });

  it("does not enlarge an existing budget when configuration is raised after restart", () => {
    budget().reserve(capability, request, "before-restart");
    expect(() => budget("500").reserve(capability, request, "after-restart")).toThrow(
      "spend-budget-exceeded",
    );
  });

  it.each(["", "-1", "NaN", "50oops", "0"])(
    "refuses invalid or exhausted configured limit %s",
    (limit) => {
      expect(() => budget(limit).reserve(capability, request, "invalid")).toThrow(
        /spend-budget-(invalid|exceeded)/u,
      );
    },
  );

  it("requires durable storage and declared upper pricing before any admission", () => {
    expect(() => budget("150", "relative.db").reserve(capability, request, "path")).toThrow(
      "spend-ledger-unavailable",
    );
    expect(() =>
      budget().reserve({ ...capability, pricing: undefined }, request, "pricing"),
    ).toThrow("spend-pricing-unavailable");
    expect(() =>
      budget().reserve(capability, { ...request, maxOutputTokens: 21 }, "output"),
    ).toThrow("spend-bound-unavailable");
  });
});
