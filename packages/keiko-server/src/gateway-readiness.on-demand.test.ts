import { afterEach, describe, expect, it, vi } from "vitest";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import {
  CHAT_MODEL_WALK_BUDGET_MS,
  ensureAnyConversationReadyChatModel,
  ensureOnDemandConversationReadiness,
  NOT_READY_REPROBE_COOLDOWN_MS,
} from "./gateway-readiness.js";
import type { UiHandlerDeps } from "./deps.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import type { ServerLogEvent } from "./observability/server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

// The cooldown maths compare an observation's checkedAt against the real clock inside the
// production module, so these tests freeze Date.now to a fixed epoch instead of deriving
// timestamps from the wall clock — a clock jump or a slow run can never move a "fresh"
// observation across the 30 s boundary (review finding on #3221).
const NOW = 1_700_000_000_000;
function freezeNow(): void {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Focused branch pins for the fresh-install on-demand verification: the field twin covers the
// journey; these cover the guards that must NOT probe.

function holderWith(
  observation: ReturnType<NonNullable<UiHandlerDeps["gatewayConfig"]>["verifiedCapability"]>,
  generation = 3,
): NonNullable<UiHandlerDeps["gatewayConfig"]> {
  return {
    storagePath: "/dev/null",
    current: () => undefined,
    present: () => true,
    set: () => undefined,
    verification: () => UNVERIFIED_GATEWAY,
    generation: () => generation,
    recordVerification: () => undefined,
    verifiedCapability: () => observation,
    recordVerifiedCapability: () => undefined,
    clearVerifiedCapability: () => false,
  };
}

describe("ensureOnDemandConversationReadiness guards", () => {
  it("returns without probing when no gateway is configured", async () => {
    await expect(
      ensureOnDemandConversationReadiness({} as UiHandlerDeps, "chat-model"),
    ).resolves.toBeUndefined();
  });

  it("returns without probing for an empty model id", async () => {
    const deps = { gatewayConfig: holderWith(undefined) } as unknown as UiHandlerDeps;
    await expect(ensureOnDemandConversationReadiness(deps, "")).resolves.toBeUndefined();
  });

  it("returns without probing when the model is already conversation-ready", async () => {
    const deps = {
      gatewayConfig: holderWith({
        modelId: "chat-model",
        generation: 3,
        checkedAt: "2026-08-19T00:00:00.000Z",
        fields: { conversationReady: true },
      }),
    } as unknown as UiHandlerDeps;
    await expect(ensureOnDemandConversationReadiness(deps, "chat-model")).resolves.toBeUndefined();
  });

  // Relocated pin (0.3.11 → 0.3.12): the original invariant — retries hit the guard instead of
  // the wire — now holds WITHIN the re-probe cooldown. Beyond it the observation is stale by
  // design: a forever-pin turned one transient gateway outage into a bricked chat surface for
  // the rest of the process lifetime (walk amplification: every configured model pinned).
  it("respects a FRESH observed not-ready at the current generation without re-probing", async () => {
    freezeNow();
    const verifiedCapability = vi.fn(() => ({
      modelId: "chat-model",
      generation: 3,
      checkedAt: new Date(NOW - 1_000).toISOString(),
      fields: { conversationReady: false },
    }));
    const deps = {
      gatewayConfig: { ...holderWith(undefined), verifiedCapability },
    } as unknown as UiHandlerDeps;
    // currentGatewayConfig(deps) is undefined here, so a probe attempt would throw inside
    // runGatewayReadiness's provider selection — resolving cleanly proves the guard returned
    // BEFORE any probing.
    await expect(ensureOnDemandConversationReadiness(deps, "chat-model")).resolves.toBeUndefined();
  });

  it("re-probes a not-ready observation older than the cooldown so an outage heals", async () => {
    freezeNow();
    const { deps, fetchCalls, readyRecords } = probeableDeps(
      new Date(NOW - NOT_READY_REPROBE_COOLDOWN_MS - 1_000).toISOString(),
    );
    // The within-cooldown pin above proves a FRESH not-ready observation returns before any
    // probing — a wire hit here is only possible because the stale pin expired. The recovered
    // gateway (the fake answers the chat probe) heals the observation to conversation-ready.
    await expect(ensureOnDemandConversationReadiness(deps, "chat-model")).resolves.toBeUndefined();
    expect(fetchCalls()).toBeGreaterThan(0);
    expect(readyRecords()).toContain(true);
  });

  it("re-probes when the observation timestamp is malformed — fail-open toward probing", async () => {
    const { deps, fetchCalls } = probeableDeps("not-a-timestamp");
    await expect(ensureOnDemandConversationReadiness(deps, "chat-model")).resolves.toBeUndefined();
    expect(fetchCalls()).toBeGreaterThan(0);
  });

  it("does not touch the wire for a fresh not-ready observation even with a live transport", async () => {
    freezeNow();
    const { deps, fetchCalls } = probeableDeps(new Date(NOW - 1_000).toISOString());
    await expect(ensureOnDemandConversationReadiness(deps, "chat-model")).resolves.toBeUndefined();
    expect(fetchCalls()).toBe(0);
  });

  it("probes immediately when the current-generation observation carries no readiness field", async () => {
    // Review finding on #3220: only an EXPLICIT failed probe earns the cooldown. A capability
    // observation without a conversationReady field is unknown readiness — suppressing its
    // probe converted unknown into a 30-second admission block.
    freezeNow();
    const { deps, fetchCalls } = probeableDeps(new Date(NOW - 1_000).toISOString(), {});
    await expect(ensureOnDemandConversationReadiness(deps, "chat-model")).resolves.toBeUndefined();
    expect(fetchCalls()).toBeGreaterThan(0);
  });

  it("probes immediately when the not-ready timestamp lies in the future — fail-open on clock skew", async () => {
    freezeNow();
    const { deps, fetchCalls } = probeableDeps(new Date(NOW + 60_000).toISOString());
    await expect(ensureOnDemandConversationReadiness(deps, "chat-model")).resolves.toBeUndefined();
    expect(fetchCalls()).toBeGreaterThan(0);
  });
});

// Deps with ONE configured provider, a fake gateway transport that answers the minimal chat
// probe, and a current-generation not-ready observation stamped `checkedAt`. Generation is
// unique per call so the module-level in-flight probe map never collides across tests.
let nextGeneration = 100;
function probeableDeps(
  checkedAt: string,
  fields: { conversationReady?: boolean } = { conversationReady: false },
): {
  deps: UiHandlerDeps;
  fetchCalls: () => number;
  readyRecords: () => readonly (boolean | undefined)[];
} {
  const generation = (nextGeneration += 1);
  let calls = 0;
  const recorded: (boolean | undefined)[] = [];
  const provider = {
    modelId: "chat-model",
    baseUrl: "https://siu.llm.intern/v1",
    apiKey: "k",
    timeoutMs: 1_000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
  const holder = {
    ...holderWith(
      {
        modelId: "chat-model",
        generation,
        checkedAt,
        fields,
      },
      generation,
    ),
    current: (): { providers: (typeof provider)[] } => ({ providers: [provider] }),
    recordVerifiedCapability: (
      _modelId: string,
      fields: { conversationReady?: boolean | undefined },
    ): void => {
      recorded.push(fields.conversationReady);
    },
  };
  const deps = {
    gatewayConfig: holder,
    redactor: (value: unknown): unknown => value,
    gatewayReadinessFetch: (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
  } as unknown as UiHandlerDeps;
  return { deps, fetchCalls: () => calls, readyRecords: () => recorded };
}

// The walk is BOUNDED (the unbounded-sum lesson of the 0.3.11 embedding ladder): an interactive
// create must never wait out one provider timeout per configured model. A probe that outlives
// the budget keeps running in the shared in-flight map, but the REQUEST stops waiting.
describe("ensureAnyConversationReadyChatModel budget", () => {
  it("stops waiting at the aggregate walk budget while slow probes keep running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    // Unique per test run: the hanging m2 probe stays in the module-level in-flight map for
    // the process lifetime, and a fixed generation would let a later test adopt it.
    const generation = (nextGeneration += 1);
    const probed: string[] = [];
    const providers = ["m1", "m2", "m3"].map((modelId) => ({
      modelId,
      baseUrl: "https://siu.llm.intern/v1",
      apiKey: "k",
      // Deliberately far beyond the walk budget: only the budget can end the wait.
      timeoutMs: 600_000,
      maxRetries: 0,
      retryBaseDelayMs: 1,
    }));
    const deps = {
      gatewayConfig: {
        ...holderWith(undefined, generation),
        current: () => ({ providers }),
        recordVerifiedCapability: (): void => {
          // Static holder: observations never persist, so every walk candidate stays probeable.
        },
      },
      redactor: (value: unknown): unknown => value,
      gatewayReadinessFetch: (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const raw = typeof init?.body === "string" ? init.body : "{}";
        const model = (JSON.parse(raw) as { model?: string }).model ?? "?";
        probed.push(model);
        if (model === "m1") {
          // The requested default answers EMPTY — an honest probe failure, so the walk starts.
          return Promise.resolve(
            new Response(
              JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        // Every sibling hangs far past the budget.
        return new Promise<Response>(() => {
          // never resolves
        });
      },
    } as unknown as UiHandlerDeps;

    let settled = false;
    const walk = ensureAnyConversationReadyChatModel(deps, "m1").then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(CHAT_MODEL_WALK_BUDGET_MS + 1_000);
    await walk;
    expect(settled).toBe(true);
    // The requested model and the FIRST walk candidate were probed; the budget expired while
    // that candidate hung, so the walk never reached the third model.
    expect(probed).toEqual(["m1", "m2"]);
  });
});

// #3557: the on-demand probe used to leave no line at all, so a conversation refused after it could
// not be told apart from one refused without any check. Its lines carry the conversation request's
// correlation id, so that request's timeline shows the check it waited for.
describe("on-demand readiness evidence", () => {
  it("logs the probe under the conversation request's correlation id", async () => {
    const { deps } = probeableDeps("not-a-timestamp");
    const events: ServerLogEvent[] = [];
    const logged = {
      ...deps,
      activityLog: { write: (event: ServerLogEvent): void => void events.push(event) },
    } as UiHandlerDeps;

    await ensureOnDemandConversationReadiness(logged, "chat-model", "corr-chat-send-0001");

    const readiness = events.filter((event) => event.op.startsWith("gateway.readiness."));
    expect(readiness.map((event) => [event.op, event.correlationId])).toEqual([
      ["gateway.readiness.started", "corr-chat-send-0001"],
      ["gateway.readiness.completed", "corr-chat-send-0001"],
    ]);
    expect(
      expectActivityLogProof(
        "gateway.readiness.started.line",
        formatActivityLogProofLine(readiness[0] ?? {}),
      ),
    ).toMatchObject({ modelId: "chat-model", trigger: "on-demand", probeCount: 1 });
    expect(
      expectActivityLogProof(
        "gateway.readiness.completed.line",
        formatActivityLogProofLine(readiness[1] ?? {}),
      ),
    ).toMatchObject({
      modelId: "chat-model",
      trigger: "on-demand",
      overallStatus: "ready",
      probeCount: 1,
    });
    expect(readiness[1]?.durationMs).toEqual(expect.any(Number));
  });

  // Review finding B (P1) and its CodeRabbit duplicate at gateway-readiness.ts:1664: after a
  // restart, two sends for the same unobserved model can arrive together. The FIRST starts the
  // probe; before this fix the SECOND just awaited it silently, so its own timeline had no line at
  // all connecting it to the check that actually decided its outcome.
  it("logs a join line under the SECOND caller's own correlation id, linked to the probe's", async () => {
    const { deps } = probeableDeps("not-a-timestamp");
    const events: ServerLogEvent[] = [];
    const logged = {
      ...deps,
      activityLog: { write: (event: ServerLogEvent): void => void events.push(event) },
    } as UiHandlerDeps;

    // Both calls are issued before either is awaited: `ensureOnDemandConversationReadiness` writes
    // the shared in-flight map synchronously, before its own first `await`, so the second call is
    // guaranteed to observe the first's in-flight probe instead of racing to start its own — this
    // mirrors two concurrent chat requests for the same unobserved model hitting the BFF together.
    const first = ensureOnDemandConversationReadiness(logged, "chat-model", "corr-probe-A");
    const second = ensureOnDemandConversationReadiness(logged, "chat-model", "corr-joiner-B");
    await Promise.all([first, second]);

    const joined = events.filter((event) => event.op === "gateway.readiness.joined");
    expect(joined).toHaveLength(1);
    const [joinEvent] = joined;
    expect(joinEvent?.correlationId).toBe("corr-joiner-B");
    const persisted = expectActivityLogProof(
      "gateway.readiness.joined.line",
      formatActivityLogProofLine(joinEvent ?? {}),
    );
    expect(persisted).toMatchObject({
      probeCorrelationId: "corr-probe-A",
      modelId: "chat-model",
    });

    // The probe itself still ran exactly once, under the FIRST caller's correlation id — the
    // joiner never starts a probe of its own.
    const readiness = events.filter(
      (event) =>
        event.op.startsWith("gateway.readiness.") && event.op !== "gateway.readiness.joined",
    );
    expect(readiness.map((event) => [event.op, event.correlationId])).toEqual([
      ["gateway.readiness.started", "corr-probe-A"],
      ["gateway.readiness.completed", "corr-probe-A"],
    ]);
  });

  it("mints its own correlation id for a joiner that supplied none", async () => {
    const { deps } = probeableDeps("not-a-timestamp");
    const events: ServerLogEvent[] = [];
    const logged = {
      ...deps,
      activityLog: { write: (event: ServerLogEvent): void => void events.push(event) },
    } as UiHandlerDeps;

    const first = ensureOnDemandConversationReadiness(logged, "chat-model", "corr-probe-only");
    const second = ensureOnDemandConversationReadiness(logged, "chat-model");
    await Promise.all([first, second]);

    const joined = events.filter((event) => event.op === "gateway.readiness.joined");
    expect(joined).toHaveLength(1);
    expect(typeof joined[0]?.correlationId).toBe("string");
    expect(joined[0]?.correlationId).not.toBe("corr-probe-only");
    expect(joined[0]?.correlationId).not.toBe(UNKNOWN_CORRELATION_ID);
  });
});
