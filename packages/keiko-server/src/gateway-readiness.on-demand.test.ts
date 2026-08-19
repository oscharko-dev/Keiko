import { afterEach, describe, expect, it, vi } from "vitest";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts";
import {
  CHAT_MODEL_WALK_BUDGET_MS,
  ensureAnyConversationReadyChatModel,
  ensureOnDemandConversationReadiness,
  NOT_READY_REPROBE_COOLDOWN_MS,
} from "./gateway-readiness.js";
import type { UiHandlerDeps } from "./deps.js";

afterEach(() => {
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
    const verifiedCapability = vi.fn(() => ({
      modelId: "chat-model",
      generation: 3,
      checkedAt: new Date(Date.now() - 1_000).toISOString(),
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
    const { deps, fetchCalls, readyRecords } = probeableDeps(
      new Date(Date.now() - NOT_READY_REPROBE_COOLDOWN_MS - 1_000).toISOString(),
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
    const { deps, fetchCalls } = probeableDeps(new Date(Date.now() - 1_000).toISOString());
    await expect(ensureOnDemandConversationReadiness(deps, "chat-model")).resolves.toBeUndefined();
    expect(fetchCalls()).toBe(0);
  });

  it("probes immediately when the current-generation observation carries no readiness field", async () => {
    // Review finding on #3220: only an EXPLICIT failed probe earns the cooldown. A capability
    // observation without a conversationReady field is unknown readiness — suppressing its
    // probe converted unknown into a 30-second admission block.
    const { deps, fetchCalls } = probeableDeps(new Date(Date.now() - 1_000).toISOString(), {});
    await expect(ensureOnDemandConversationReadiness(deps, "chat-model")).resolves.toBeUndefined();
    expect(fetchCalls()).toBeGreaterThan(0);
  });

  it("probes immediately when the not-ready timestamp lies in the future — fail-open on clock skew", async () => {
    const { deps, fetchCalls } = probeableDeps(new Date(Date.now() + 60_000).toISOString());
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
