import { describe, expect, it, vi } from "vitest";
import { createDefaultChatCapability, type GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import { runGatewayReadiness } from "./gateway-readiness.js";
import { currentConversationReadinessObservation } from "./deps.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

// #4115: a single-slot local model that is still busy with another generation must stay
// selectable and admitted, as standalone OpenCode simply waits for it.

const MODEL = "busy-local-model";

function config(): GatewayConfig {
  return {
    providers: [
      {
        modelId: MODEL,
        baseUrl: "https://llm-gateway.internal/v1",
        apiKey: "secret-token",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 0,
      },
    ],
    capabilities: [createDefaultChatCapability(MODEL)],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };
}

interface Observation {
  readonly modelId: string;
  readonly generation: number;
  readonly checkedAt: string;
  readonly conversationCheckedAt?: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

interface Harness {
  readonly deps: UiHandlerDeps;
  readonly events: ServerLogEvent[];
  readonly diagnostics: ServerDiagnosticRecord[];
  readonly verifications: string[];
  current(): Observation | undefined;
}

function harness(fetchImpl: typeof fetch, previous: Observation | undefined): Harness {
  const gateway = config();
  const events: ServerLogEvent[] = [];
  const diagnostics: ServerDiagnosticRecord[] = [];
  const verifications: string[] = [];
  let observation = previous;
  const deps: UiHandlerDeps = {
    config: gateway,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    gatewayReadinessFetch: fetchImpl,
    diagnostics: { record: (entry) => void diagnostics.push(entry) },
    activityLog: { write: (event) => void events.push(event) },
    gatewayConfig: {
      storagePath: "/dev/null",
      current: () => gateway,
      present: () => true,
      set: () => undefined,
      verification: () => UNVERIFIED_GATEWAY,
      generation: () => 7,
      recordVerification: (state) => void verifications.push(state),
      verifiedCapability: () => observation,
      recordVerifiedCapability: (modelId, fields, checkedAt, generation, conversationCheckedAt) => {
        observation = {
          modelId,
          generation: generation ?? 0,
          checkedAt,
          ...(conversationCheckedAt === undefined ? {} : { conversationCheckedAt }),
          fields,
        };
      },
      clearVerifiedCapability: () => {
        observation = undefined;
        return true;
      },
    },
  };
  return { deps, events, diagnostics, verifications, current: () => observation };
}

function provenReady(generation = 7, ageMs = 4 * 60_000): Observation {
  const at = new Date(Date.now() - ageMs).toISOString();
  return {
    modelId: MODEL,
    generation,
    checkedAt: at,
    fields: { conversationReady: true, toolCalling: true },
  };
}

const timeout = (): typeof fetch =>
  vi.fn().mockRejectedValue(new DOMException("timeout", "TimeoutError")) as typeof fetch;

describe("gateway readiness while a single-slot model is busy (#4115)", () => {
  it("keeps and renews a proven model when the chat probe times out", async () => {
    const run = harness(timeout(), provenReady());

    await runGatewayReadiness(
      { modelId: MODEL, options: { probes: ["chat"] } },
      run.deps,
      "readiness-busy-001",
    );

    expect(run.current()?.fields).toEqual({ conversationReady: true, toolCalling: true });
    expect(currentConversationReadinessObservation(run.deps, MODEL)).toBe(true);
    expect(run.verifications).toEqual([]);
    const retained = run.events.filter((event) => event.op === "gateway.readiness.busy-retained");
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      correlationId: "readiness-busy-001",
      extra: { busySignal: "probe-timeout" },
    });
    const persisted = expectActivityLogProof(
      "gateway.readiness.busy-retained.line",
      formatActivityLogProofLine(retained[0] ?? {}),
    );
    expect(persisted).toMatchObject({ busySignal: "probe-timeout" });
    expect(run.diagnostics).toEqual([
      expect.objectContaining({
        source: "gateway-readiness.chat",
        diagnosticOutcome: "provider-busy",
      }),
    ]);
  });

  it("renews a proof that would otherwise go stale while the model stays busy", async () => {
    const run = harness(timeout(), provenReady(7, 6 * 60_000));
    expect(currentConversationReadinessObservation(run.deps, MODEL)).toBeUndefined();

    await runGatewayReadiness({ modelId: MODEL, options: { probes: ["chat"] } }, run.deps);

    expect(currentConversationReadinessObservation(run.deps, MODEL)).toBe(true);
  });

  it("keeps a proven model when the gateway answers with an overload status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("busy", { status: 503 }));
    const run = harness(fetchImpl as typeof fetch, provenReady());

    await runGatewayReadiness({ modelId: MODEL, options: { probes: ["chat"] } }, run.deps);

    expect(currentConversationReadinessObservation(run.deps, MODEL)).toBe(true);
    const retained = run.events.filter((event) => event.op === "gateway.readiness.busy-retained");
    expect(retained[0]?.extra).toMatchObject({ busySignal: "gateway-overloaded" });
  });

  it("still records an unreachable provider as not ready", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const run = harness(fetchImpl as typeof fetch, provenReady());

    await runGatewayReadiness({ modelId: MODEL, options: { probes: ["chat"] } }, run.deps);

    expect(currentConversationReadinessObservation(run.deps, MODEL)).not.toBe(true);
    expect(run.events.some((event) => event.op === "gateway.readiness.busy-retained")).toBe(false);
    expect(run.diagnostics[0]?.diagnosticOutcome).toBeUndefined();
  });

  it("does not invent readiness for a model never proved ready", async () => {
    const run = harness(timeout(), undefined);

    await runGatewayReadiness({ modelId: MODEL, options: { probes: ["chat"] } }, run.deps);

    expect(currentConversationReadinessObservation(run.deps, MODEL)).not.toBe(true);
    expect(run.events.some((event) => event.op === "gateway.readiness.busy-retained")).toBe(false);
  });

  it("does not carry a proof across a replaced configuration", async () => {
    const run = harness(timeout(), provenReady(6));

    await runGatewayReadiness({ modelId: MODEL, options: { probes: ["chat"] } }, run.deps);

    expect(currentConversationReadinessObservation(run.deps, MODEL)).not.toBe(true);
    expect(run.events.some((event) => event.op === "gateway.readiness.busy-retained")).toBe(false);
  });
});
