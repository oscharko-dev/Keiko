// Provider-agnostic sync lane tests (Issue #2242, ADR-0128 D3/D5). Hermetic: injected transport
// and sleep, virtual clock, no network, no timers.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ATLASSIAN_SYNC_BOUNDS,
  type AtlassianSyncBounds,
} from "@oscharko-dev/keiko-contracts";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "./atlassian-http-port.js";
import {
  ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS,
  ATLASSIAN_SYNC_RETRY_MAX_DELAY_MS,
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
    expect(harness.requests.length).toBe(ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS);
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
    expect(flaky.requests.length).toBe(2);
    const denied = retryHarness();
    const result = await denied.run(() => ({ ...ok, status: 403 }));
    expect(result).toMatchObject({ status: 403 });
    expect(denied.requests.length).toBe(1);
  });

  it("sleeps when the delay lands exactly on the deadline — boundary exact", async () => {
    // now(0) + 500 ms delay === deadlineAt 500: not PAST the budget, so the retry proceeds.
    const harness = retryHarness();
    await harness.run((attempt) => (attempt === 1 ? rateLimited() : ok), { maxDurationMs: 500 });
    expect(harness.delays).toEqual([500]);
    expect(harness.requests.length).toBe(2);
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
