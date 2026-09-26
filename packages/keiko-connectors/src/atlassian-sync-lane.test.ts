// Provider-agnostic sync lane tests (Issue #2242, ADR-0128 D3/D5). Hermetic: injected transport
// and sleep, virtual clock, no network, no timers.

import { describe, expect, it } from "vitest";
import type { AtlassianSyncBounds } from "@oscharko-dev/keiko-contracts";
import { DEFAULT_ATLASSIAN_SYNC_BOUNDS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "./atlassian-http-port.js";
import {
  ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS,
  ATLASSIAN_SYNC_RETRY_MAX_DELAY_MS,
  AtlassianSyncBudgetExhausted,
  runAtlassianSyncFetch,
  type AtlassianSyncFetchContext,
  type AtlassianSyncItem,
  type AtlassianSyncItemFetchOutcome,
  type AtlassianSyncItemRef,
  type AtlassianSyncSource,
} from "./atlassian-sync-lane.js";

function bounds(overrides: Partial<AtlassianSyncBounds> = {}): AtlassianSyncBounds {
  return { ...DEFAULT_ATLASSIAN_SYNC_BOUNDS, maxDurationMs: 60_000, ...overrides };
}

function item(key: string): AtlassianSyncItem {
  return {
    itemKey: key,
    title: `Title ${key}`,
    relativePath: `pages/${key}.html`,
    contentHtml: `<html><body>${key}</body></html>`,
    byteLength: 40,
  };
}

interface ScriptedSource {
  readonly source: AtlassianSyncSource;
  readonly fetchedKeys: string[];
}

function scriptedSource(
  refs: readonly string[],
  outcomes: Readonly<Record<string, AtlassianSyncItemFetchOutcome>>,
  options: { readonly complete?: boolean; readonly onFetch?: () => void } = {},
): ScriptedSource {
  const fetchedKeys: string[] = [];
  const source: AtlassianSyncSource = {
    enumerate: (): ReturnType<AtlassianSyncSource["enumerate"]> =>
      Promise.resolve({
        ok: true,
        refs: refs.map((itemKey) => ({ itemKey })),
        complete: options.complete ?? true,
      }),
    fetchItem: (ref: AtlassianSyncItemRef): Promise<AtlassianSyncItemFetchOutcome> => {
      fetchedKeys.push(ref.itemKey);
      options.onFetch?.();
      return Promise.resolve(outcomes[ref.itemKey] ?? { kind: "item", item: item(ref.itemKey) });
    },
  };
  return { source, fetchedKeys };
}

const idleHttp: AtlassianHttpBodyPort = () =>
  Promise.resolve({
    kind: "response",
    status: 200,
    bodyText: "{}",
    bodyBytes: 2,
    truncated: false,
  });

describe("runAtlassianSyncFetch", () => {
  it("completes with items, enumerated keys, and exact progress counts", async () => {
    const { source } = scriptedSource(["a", "b", "c"], {});
    const progress: number[] = [];
    const outcome = await runAtlassianSyncFetch({
      source,
      http: idleHttp,
      bounds: bounds(),
      onProgress: (p) => progress.push(p.fetchedItems),
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.items.map((i) => i.itemKey)).toEqual(["a", "b", "c"]);
    expect(outcome.enumeratedItemKeys).toEqual(["a", "b", "c"]);
    expect(outcome.progress).toEqual({
      enumeratedItems: 3,
      fetchedItems: 3,
      indexedItems: 0,
      skippedItems: 0,
      failedItems: 0,
    });
    expect(progress.at(-1)).toBe(3);
  });

  it("degrades per-item failures to a completed run with closed reasons and drops 404s from the enumerated set", async () => {
    const { source } = scriptedSource(["a", "b", "c", "d"], {
      b: { kind: "skipped", reason: "permission-denied" },
      c: { kind: "missing" },
    });
    const outcome = await runAtlassianSyncFetch({ source, http: idleHttp, bounds: bounds() });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.items.map((i) => i.itemKey)).toEqual(["a", "d"]);
    expect(outcome.failures).toEqual([{ itemKey: "b", reason: "permission-denied" }]);
    expect(outcome.enumeratedItemKeys).toEqual(["a", "b", "d"]);
    expect(outcome.progress.skippedItems).toBe(2);
    expect(outcome.progress.failedItems).toBe(1);
  });

  it("aborts the whole run on a fatal classification (401 auth-failed)", async () => {
    const { source } = scriptedSource(["a", "b"], {
      a: { kind: "fatal", reason: "auth-failed" },
    });
    const outcome = await runAtlassianSyncFetch({
      source,
      http: idleHttp,
      bounds: bounds({ maxConcurrency: 1 }),
    });
    expect(outcome).toMatchObject({ status: "failed", applicable: false, reason: "auth-failed" });
  });

  it("fails closed (not applicable) when enumeration overflows maxItems — boundary exact", async () => {
    const atBoundary = await runAtlassianSyncFetch({
      source: scriptedSource(["a", "b", "c"], {}).source,
      http: idleHttp,
      bounds: bounds({ maxItems: 3 }),
    });
    expect(atBoundary.status).toBe("completed");
    const pastBoundary = await runAtlassianSyncFetch({
      source: scriptedSource(["a", "b", "c", "d"], {}).source,
      http: idleHttp,
      bounds: bounds({ maxItems: 3 }),
    });
    expect(pastBoundary).toMatchObject({
      status: "truncated",
      applicable: false,
      reason: "bounds-exceeded",
    });
  });

  it("fails closed when the adapter reports an incomplete enumeration", async () => {
    const { source } = scriptedSource(["a"], {}, { complete: false });
    const outcome = await runAtlassianSyncFetch({ source, http: idleHttp, bounds: bounds() });
    expect(outcome).toMatchObject({ status: "truncated", reason: "bounds-exceeded" });
  });

  it("propagates enumeration failure reasons as a failed run", async () => {
    const source: AtlassianSyncSource = {
      enumerate: () => Promise.resolve({ ok: false, reason: "rate-limited" }),
      fetchItem: () => Promise.resolve({ kind: "missing" }),
    };
    const outcome = await runAtlassianSyncFetch({ source, http: idleHttp, bounds: bounds() });
    expect(outcome).toMatchObject({ status: "failed", reason: "rate-limited" });
  });

  it("terminates cancelled before enumeration and never calls the source", async () => {
    const controller = new AbortController();
    controller.abort();
    let enumerated = false;
    const source: AtlassianSyncSource = {
      enumerate: () => {
        enumerated = true;
        return Promise.resolve({ ok: true, refs: [], complete: true });
      },
      fetchItem: () => Promise.resolve({ kind: "missing" }),
    };
    const outcome = await runAtlassianSyncFetch({
      source,
      http: idleHttp,
      bounds: bounds(),
      signal: controller.signal,
    });
    expect(outcome).toMatchObject({ status: "cancelled", applicable: false });
    expect(enumerated).toBe(false);
  });

  it("stops dispatching at the next item boundary on cancellation", async () => {
    const controller = new AbortController();
    const { source, fetchedKeys } = scriptedSource(
      ["a", "b", "c", "d"],
      {},
      {
        onFetch: () => {
          controller.abort();
        },
      },
    );
    const outcome = await runAtlassianSyncFetch({
      source,
      http: idleHttp,
      bounds: bounds({ maxConcurrency: 1 }),
      signal: controller.signal,
    });
    expect(outcome.status).toBe("cancelled");
    expect(fetchedKeys).toEqual(["a"]);
  });

  it("removes every occurrence of a duplicated key from enumeratedItemKeys once a fetch reports it missing", async () => {
    // Regression for KEIKO-0598: enumerate lists the same key twice (legitimate re-served page or
    // a hostile duplicate). The first fetch of the duplicate still finds it (ordinary item); the
    // second finds it vanished (404/missing) between enumeration and fetch. The former
    // indexOf/splice removal only ever drops ONE positional occurrence, so one copy of the key
    // used to survive in enumeratedItemKeys even though the item is gone.
    const dupKey = "dup";
    let dupCalls = 0;
    const source: AtlassianSyncSource = {
      enumerate: () =>
        Promise.resolve({
          ok: true,
          refs: [{ itemKey: "a" }, { itemKey: dupKey }, { itemKey: dupKey }, { itemKey: "b" }],
          complete: true,
        }),
      fetchItem: (ref): Promise<AtlassianSyncItemFetchOutcome> => {
        if (ref.itemKey !== dupKey) {
          return Promise.resolve({ kind: "item", item: item(ref.itemKey) });
        }
        dupCalls += 1;
        return Promise.resolve(
          dupCalls === 1 ? { kind: "item", item: item(dupKey) } : { kind: "missing" },
        );
      },
    };
    const outcome = await runAtlassianSyncFetch({
      source,
      http: idleHttp,
      bounds: bounds({ maxConcurrency: 1 }),
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.enumeratedItemKeys.filter((key) => key === dupKey)).toHaveLength(0);
    expect(outcome.enumeratedItemKeys).toEqual(["a", "b"]);
  });

  it("drops every fetched item alongside the enumeration key when a duplicate ref's later fetch reports missing (KEIKO-0598 follow-up)", async (): Promise<void> => {
    // Regression for the KEIKO-0598 follow-up Codex identified on #3279: the earlier fix removed
    // every occurrence of a duplicated key from enumeratedItemKeys once a fetch reports it
    // missing, but the ITEM that the first fetch pushed to state.items stayed. That left the two
    // states inconsistent — applyConnectorSyncRun then indexed the fetched item, saw the absent
    // enumeration key as a removal signal, pruned the freshly-indexed document, and persisted a
    // fingerprint that permanently masked the item on subsequent unchanged syncs. This test
    // asserts BOTH states now agree: the missing outcome for a duplicate drops the item AND the
    // key, so the diff downstream sees a clean removal (no phantom index → prune → mask race).
    const dupKey = "dup-item-then-missing";
    let dupCalls = 0;
    const source: AtlassianSyncSource = {
      enumerate: () =>
        Promise.resolve({
          ok: true,
          refs: [
            { itemKey: "a" },
            { itemKey: dupKey },
            { itemKey: dupKey },
            { itemKey: dupKey },
            { itemKey: "b" },
          ],
          complete: true,
        }),
      fetchItem: (ref): Promise<AtlassianSyncItemFetchOutcome> => {
        if (ref.itemKey !== dupKey) {
          return Promise.resolve({ kind: "item", item: item(ref.itemKey) });
        }
        dupCalls += 1;
        return Promise.resolve(
          dupCalls < 3 ? { kind: "item", item: item(dupKey) } : { kind: "missing" },
        );
      },
    };
    const outcome = await runAtlassianSyncFetch({
      source,
      http: idleHttp,
      bounds: bounds({ maxConcurrency: 1 }),
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    // enumeration key removed by the earlier KEIKO-0598 fix — inherited invariant.
    expect(outcome.enumeratedItemKeys).toEqual(["a", "b"]);
    // NEW invariant: state.items agrees — no orphan for the missing key. The two other real
    // items (a, b) are still there.
    expect(outcome.items.map((it) => it.itemKey).sort()).toEqual(["a", "b"]);
    expect(outcome.items.some((it) => it.itemKey === dupKey)).toBe(false);
  });

  it("does not resurrect a missing duplicate when an earlier item fetch settles later", async (): Promise<void> => {
    const dupKey = "missing-before-held-item";
    let duplicateFetchCount = 0;
    let releaseHeldItem: () => void = () => undefined;
    const heldItem = new Promise<void>((resolve) => {
      releaseHeldItem = resolve;
    });
    const source: AtlassianSyncSource = {
      enumerate: () =>
        Promise.resolve({
          ok: true,
          refs: [{ itemKey: dupKey }, { itemKey: dupKey }],
          complete: true,
        }),
      fetchItem: async (): Promise<AtlassianSyncItemFetchOutcome> => {
        duplicateFetchCount += 1;
        if (duplicateFetchCount === 1) {
          await heldItem;
          return { kind: "item", item: item(dupKey) };
        }
        return { kind: "missing" };
      },
    };
    const outcome = await runAtlassianSyncFetch({
      source,
      http: idleHttp,
      bounds: bounds({ maxConcurrency: 2 }),
      onProgress: (progress): void => {
        if (progress.skippedItems === 1) releaseHeldItem();
      },
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.enumeratedItemKeys).toEqual([]);
    expect(outcome.items).toEqual([]);
    expect(outcome.progress).toMatchObject({ fetchedItems: 1, skippedItems: 1 });
  });

  it("waits for every dispatched fetch to settle before returning, so no fetch or onProgress callback fires after the run's promise has settled (budget exhaustion mid-run)", async () => {
    // Regression for KEIKO-0758: `Promise.all` used to settle on the FIRST worker rejection and
    // abandon its still-running siblings. Two refs race at maxConcurrency 2: "fast" exhausts the
    // whole byte budget and then throws on its own second dispatch; "slow" is held open on a gate
    // we control. The fixed pool must not resolve until "slow" is released too, and once released
    // must never dispatch the fourth ref ("d") that was still available on the shared cursor.
    const dispatched: string[] = [];
    const progressCalls: number[] = [];
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const refs = ["fast", "slow", "second", "d"];
    const source: AtlassianSyncSource = {
      enumerate: () =>
        Promise.resolve({
          ok: true,
          refs: refs.map((itemKey) => ({ itemKey })),
          complete: true,
        }),
      fetchItem: async (ref, context): Promise<AtlassianSyncItemFetchOutcome> => {
        dispatched.push(ref.itemKey);
        if (ref.itemKey === "slow") {
          await slowGate;
          return { kind: "item", item: item("slow") };
        }
        // "fast" and "second" each pull the whole 100-byte budget; "second" (fetched by the same
        // worker right after "fast") finds it already exhausted and throws.
        const result = await context.http({
          method: "GET",
          url: "https://tenant.example/x",
          timeoutMs: 1_000,
          maxBodyBytes: 100,
        });
        if (result.kind !== "response") return { kind: "skipped", reason: "unavailable" };
        return { kind: "item", item: item(ref.itemKey) };
      },
    };
    const http: AtlassianHttpBodyPort = () =>
      Promise.resolve({
        kind: "response",
        status: 200,
        bodyText: "x",
        bodyBytes: 100,
        truncated: false,
      });
    let settled = false;
    const promise = runAtlassianSyncFetch({
      source,
      http,
      bounds: bounds({ maxBytes: 100, maxConcurrency: 2 }),
      onProgress: (p) => progressCalls.push(p.fetchedItems + p.skippedItems),
    }).then((outcome) => {
      settled = true;
      return outcome;
    });
    // Flush every pending microtask (the "fast"/"second" chain) without a real timer for "slow".
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatched).toEqual(["fast", "slow", "second"]);
    // "second" has already thrown AtlassianSyncBudgetExhausted by now, but "slow" is still gated —
    // the run must NOT have settled yet: it must wait for "slow", not abandon it as Promise.all did.
    expect(settled).toBe(false);
    releaseSlow?.();
    const outcome = await promise;
    expect(settled).toBe(true);
    expect(outcome).toMatchObject({ status: "truncated", reason: "bounds-exceeded" });
    // "d" was still available on the shared cursor when "second" threw, but the terminated flag
    // must have stopped the "slow" worker from ever dispatching it once it finished.
    expect(dispatched).toEqual(["fast", "slow", "second"]);
    const progressCountAtSettle = progressCalls.length;
    const dispatchedCountAtSettle = dispatched.length;
    await Promise.resolve();
    await Promise.resolve();
    expect(progressCalls).toHaveLength(progressCountAtSettle);
    expect(dispatched).toHaveLength(dispatchedCountAtSettle);
  });

  it("fires the fetchItem AbortSignal on in-flight siblings once one worker throws (KEIKO-0758 follow-up)", async (): Promise<void> => {
    // Codex flagged that the earlier KEIKO-0758 fix set `terminated=true` on a throw but never
    // aborted the in-flight siblings' fetches, so a slow-request sibling could carry the run
    // past `deadlineAt`. The lane-scoped AbortController now fires on first terminal error and
    // the combined signal is delivered to `fetchItem` via context.signal. This test observes
    // the signal directly: two workers race, "fast" throws immediately, "slow" awaits its own
    // abort — a cooperating port sees the signal fire and can settle before the pool's timeout.
    let releaseFast: (() => void) | undefined;
    const fastGate = new Promise<void>((resolve) => {
      releaseFast = resolve;
    });
    let slowSignalAborted = false;
    let slowResolve: (() => void) | undefined;
    const slowSettled = new Promise<void>((resolve) => {
      slowResolve = resolve;
    });
    const source: AtlassianSyncSource = {
      enumerate: () =>
        Promise.resolve({
          ok: true,
          refs: [{ itemKey: "fast" }, { itemKey: "slow" }],
          complete: true,
        }),
      fetchItem: async (ref, context): Promise<AtlassianSyncItemFetchOutcome> => {
        if (ref.itemKey === "fast") {
          await fastGate;
          throw new AtlassianSyncBudgetExhausted("bounds-exceeded");
        }
        // Slow worker: attach to context.signal (the lane-scoped combined signal) and settle
        // when it aborts. A port that does NOT honor signal would hang indefinitely; this test
        // proves the wire-up so a cooperating port can short-circuit.
        expect(context.signal).toBeDefined();
        context.signal?.addEventListener(
          "abort",
          () => {
            slowSignalAborted = true;
            slowResolve?.();
          },
          { once: true },
        );
        await slowSettled;
        return { kind: "skipped", reason: "unavailable" };
      },
    };
    const promise = runAtlassianSyncFetch({
      source,
      http: idleHttp,
      bounds: bounds({ maxConcurrency: 2 }),
    });
    // Yield so both workers are in-flight, then release fast to trigger the throw.
    await Promise.resolve();
    await Promise.resolve();
    releaseFast?.();
    const outcome = await promise;
    expect(slowSignalAborted).toBe(true);
    // The run surfaces the throw as truncated / bounds-exceeded via the
    // AtlassianSyncBudgetExhausted classification path.
    expect(outcome).toMatchObject({ status: "truncated", reason: "bounds-exceeded" });
  });

  it("stops dispatching new work once the run deadline is exceeded (KEIKO-0758 follow-up)", async (): Promise<void> => {
    // Companion to the abort-propagation test above: the deadline check inside the worker loop
    // prevents a slow-last-worker from pulling new refs off the shared cursor after the run
    // budget has already expired. A synthetic `now` clock advances past `maxDurationMs` between
    // the first two fetches; workers must not dispatch a third even though refs remain.
    const dispatched: string[] = [];
    let clock = 0;
    const source: AtlassianSyncSource = {
      enumerate: () =>
        Promise.resolve({
          ok: true,
          refs: [{ itemKey: "a" }, { itemKey: "b" }, { itemKey: "c" }],
          complete: true,
        }),
      fetchItem: (ref): Promise<AtlassianSyncItemFetchOutcome> => {
        dispatched.push(ref.itemKey);
        // Advance the clock so `deadlineExceeded()` starts returning true after the second call.
        if (dispatched.length === 2) clock = 10_000;
        return Promise.resolve({ kind: "item", item: item(ref.itemKey) });
      },
    };
    await runAtlassianSyncFetch({
      source,
      http: idleHttp,
      bounds: bounds({ maxConcurrency: 1, maxDurationMs: 5_000 }),
      now: () => clock,
    });
    // The third ref must NEVER dispatch because deadlineExceeded() flipped true first.
    expect(dispatched.includes("c")).toBe(false);
  });

  it("never exceeds maxConcurrency in-flight fetches — boundary exact", async () => {
    let inFlight = 0;
    let peak = 0;
    const source: AtlassianSyncSource = {
      enumerate: () =>
        Promise.resolve({
          ok: true,
          refs: ["a", "b", "c", "d", "e", "f"].map((itemKey) => ({ itemKey })),
          complete: true,
        }),
      fetchItem: async (ref) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Yield twice so every pooled worker can enter its own fetch before any completes —
        // the observed peak is exactly the pool size, never more.
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
        return { kind: "item", item: item(ref.itemKey) };
      },
    };
    const outcome = await runAtlassianSyncFetch({
      source,
      http: idleHttp,
      bounds: bounds({ maxConcurrency: 2 }),
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.items).toHaveLength(6);
    expect(peak).toBe(2);
  });
});

describe("budgeted retrying transport (ADR-0128 D3)", () => {
  interface RetryHarness {
    readonly context: () => AtlassianSyncFetchContext;
    readonly delays: number[];
    readonly requests: AtlassianHttpBodyRequest[];
    readonly run: (
      responder: (attempt: number) => AtlassianHttpBodyResult,
      boundsOverride?: Partial<AtlassianSyncBounds>,
    ) => Promise<AtlassianHttpBodyResult>;
  }

  // Runs one adapter-style request through the lane by scripting a source whose enumerate() call
  // exercises the budgeted retrying port directly.
  function retryHarness(): RetryHarness {
    const delays: number[] = [];
    const requests: AtlassianHttpBodyRequest[] = [];
    let captured: AtlassianSyncFetchContext | undefined;
    const run = async (
      responder: (attempt: number) => AtlassianHttpBodyResult,
      boundsOverride: Partial<AtlassianSyncBounds> = {},
    ): Promise<AtlassianHttpBodyResult> => {
      let attempt = 0;
      let result: AtlassianHttpBodyResult | undefined;
      const source: AtlassianSyncSource = {
        enumerate: async (context) => {
          captured = context;
          result = await context.http({
            method: "GET",
            url: "https://tenant.example/wiki/api/v2/spaces",
            timeoutMs: 60_000,
            maxBodyBytes: 1_000,
          });
          return { ok: true, refs: [], complete: true };
        },
        fetchItem: () => Promise.resolve({ kind: "missing" }),
      };
      const http: AtlassianHttpBodyPort = (request) => {
        requests.push(request);
        attempt += 1;
        return Promise.resolve(responder(attempt));
      };
      let clock = 0;
      await runAtlassianSyncFetch({
        source,
        http,
        bounds: bounds(boundsOverride),
        now: () => clock,
        sleep: (ms) => {
          delays.push(ms);
          clock += ms;
          return Promise.resolve();
        },
      });
      if (result === undefined) throw new Error("request did not run");
      return result;
    };
    return {
      context: (): AtlassianSyncFetchContext => {
        if (captured === undefined) throw new Error("context not captured");
        return captured;
      },
      delays,
      requests,
      run,
    };
  }

  function rateLimited(retryAfterMs?: number): AtlassianHttpBodyResult {
    return {
      kind: "response",
      status: 429,
      bodyText: "{}",
      bodyBytes: 2,
      truncated: false,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }

  const ok: AtlassianHttpBodyResult = {
    kind: "response",
    status: 200,
    bodyText: "{}",
    bodyBytes: 2,
    truncated: false,
  };

  it("retries 429 with the exact exponential ladder 500/1000/2000/4000 and caps attempts at 5", async () => {
    const harness = retryHarness();
    const result = await harness.run(() => rateLimited());
    expect(result).toMatchObject({ kind: "response", status: 429 });
    expect(harness.requests).toHaveLength(ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS);
    expect(harness.delays).toEqual([500, 1000, 2000, 4000]);
  });

  it("recovers when a retry succeeds mid-ladder", async () => {
    const harness = retryHarness();
    const result = await harness.run((attempt) => (attempt < 3 ? rateLimited() : ok));
    expect(result).toMatchObject({ kind: "response", status: 200 });
    expect(harness.delays).toEqual([500, 1000]);
  });

  it("honors Retry-After when present and caps it at the 8000 ms ceiling", async () => {
    const harness = retryHarness();
    await harness.run((attempt) => (attempt === 1 ? rateLimited(30_000) : ok));
    expect(harness.delays).toEqual([ATLASSIAN_SYNC_RETRY_MAX_DELAY_MS]);
    const second = retryHarness();
    await second.run((attempt) => (attempt === 1 ? rateLimited(1_234) : ok));
    expect(second.delays).toEqual([1_234]);
  });

  it("retries 5xx but never a non-429 4xx", async () => {
    const flaky = retryHarness();
    await flaky.run((attempt) => (attempt === 1 ? { ...ok, status: 503 } : { ...ok, status: 200 }));
    expect(flaky.requests).toHaveLength(2);
    const denied = retryHarness();
    const result = await denied.run(() => ({ ...ok, status: 403 }));
    expect(result).toMatchObject({ status: 403 });
    expect(denied.requests).toHaveLength(1);
  });

  it("sleeps when the delay lands exactly on the deadline — boundary exact", async () => {
    // now(0) + 500 ms delay === deadlineAt 500: not PAST the budget, so the retry proceeds.
    const harness = retryHarness();
    await harness.run((attempt) => (attempt === 1 ? rateLimited() : ok), { maxDurationMs: 500 });
    expect(harness.delays).toEqual([500]);
    expect(harness.requests).toHaveLength(2);
  });

  it("gives up instead of sleeping past the run deadline", async () => {
    const harness = retryHarness();
    const result = await harness.run(() => rateLimited(), { maxDurationMs: 400 });
    // First delay (500 ms) would overshoot the 400 ms budget: no sleep, first response returned.
    expect(harness.delays).toEqual([]);
    expect(result).toMatchObject({ status: 429 });
  });

  it("clamps every request's body cap to the remaining byte budget — continuous enforcement", async () => {
    const harness = retryHarness();
    await harness.run(() => ({ ...ok, bodyBytes: 900, truncated: false }), { maxBytes: 950 });
    expect(harness.requests[0]?.maxBodyBytes).toBe(950);
    // The follow-up request through the same context sees the shrunken budget.
    const context = harness.context();
    const second = await context.http({
      method: "GET",
      url: "https://tenant.example/wiki/api/v2/spaces",
      timeoutMs: 60_000,
      maxBodyBytes: 1_000,
    });
    expect(second).toMatchObject({ kind: "response" });
    expect(harness.requests[1]?.maxBodyBytes).toBe(50);
  });

  it("terminates the run as bounds-exceeded when the byte budget is exhausted — boundary exact", async () => {
    let served = 0;
    const source: AtlassianSyncSource = {
      enumerate: () =>
        Promise.resolve({ ok: true, refs: [{ itemKey: "a" }, { itemKey: "b" }], complete: true }),
      fetchItem: async (ref, context) => {
        const result = await context.http({
          method: "GET",
          url: "https://tenant.example/wiki/api/v2/pages/1",
          timeoutMs: 60_000,
          maxBodyBytes: 100,
        });
        served += 1;
        if (result.kind !== "response") return { kind: "skipped", reason: "unavailable" };
        return { kind: "item", item: item(ref.itemKey) };
      },
    };
    const http: AtlassianHttpBodyPort = (request) =>
      Promise.resolve({
        kind: "response",
        status: 200,
        bodyText: "x",
        bodyBytes: Math.min(100, request.maxBodyBytes),
        truncated: false,
      });
    const outcome = await runAtlassianSyncFetch({
      source,
      http,
      bounds: bounds({ maxBytes: 100, maxConcurrency: 1 }),
    });
    // First fetch consumes exactly the full budget (boundary); the second request must not run.
    expect(served).toBe(1);
    expect(outcome).toMatchObject({ status: "truncated", reason: "bounds-exceeded" });
  });

  it("terminates the run as timeout when the wall-clock budget is exhausted", async () => {
    let clock = 0;
    const source: AtlassianSyncSource = {
      enumerate: () => Promise.resolve({ ok: true, refs: [{ itemKey: "a" }], complete: true }),
      fetchItem: async (_ref, context) => {
        clock = 10_001;
        const result = await context.http({
          method: "GET",
          url: "https://tenant.example/wiki/api/v2/pages/1",
          timeoutMs: 60_000,
          maxBodyBytes: 100,
        });
        return result.kind === "response"
          ? { kind: "item", item: item("a") }
          : { kind: "skipped", reason: "timeout" };
      },
    };
    const outcome = await runAtlassianSyncFetch({
      source,
      http: idleHttp,
      bounds: bounds({ maxDurationMs: 10_000 }),
      now: () => clock,
    });
    expect(outcome).toMatchObject({ status: "truncated", reason: "timeout" });
  });
});
