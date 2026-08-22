// Fetch-seam and Clock replay doubles for deterministic gateway reconstruction (ADR-0173 D5, §7.3
// of the activity-log v2 design). Two related but distinct capabilities live here:
//
// `createScriptedGatewayClock` promotes the ad hoc deterministic `Clock` double that
// `gateway.test.ts` and `resilience.logging.test.ts` each independently hand-rolled (byte-identical
// copies, verified) into one shared, exported implementation, so the two call sites can no longer
// drift from each other's semantics.
//
// `createScriptedGatewayFetch` replays a scripted HTTP transcript at the `fetch` seam — one layer
// BELOW `createScriptedModelPort` (`@oscharko-dev/keiko-evaluations`), which replays at the
// `ModelPort` boundary instead. Because this seam sits under `openai-adapter.ts` and
// `resilience.ts`, both the real HTTP-status-to-error-class mapping and the real retry/circuit-
// breaker code execute for real during replay: a regression in either is caught by replay, never
// masked by a hand-authored `GatewayError`. Pass the SAME `Clock` instance to both the `Gateway`
// (`GatewayDeps.clock`) and this function: the scripted fetch calls `clock.sleep(entry.latencyMs)`
// before resolving, so the simulated retry-backoff arithmetic and the transcript's own scripted
// latency advance one identical clock in lockstep.

import type { Clock } from "./types.js";

// Overrides how much `sleep()` advances the simulated clock, keyed by call order —
// call-index / repeat-last-entry, the same replay convention `createScriptedModelPort`
// (`keiko-evaluations/src/scripted-model.ts`) uses for its own script. Absent, or exhausted early
// (the common case): `sleep(ms)` advances the clock by the caller-supplied `ms` itself, the same
// relationship a real clock has with real time.
export interface GatewayClockScript {
  readonly sleepMs?: readonly number[];
}

function scriptedAdvanceMs(
  entries: readonly number[] | undefined,
  callIndex: number,
  ms: number,
): number {
  if (entries === undefined || entries.length === 0) {
    return ms;
  }
  const index = Math.min(callIndex, entries.length - 1);
  return entries[index] ?? ms;
}

function abortError(): DOMException {
  return new DOMException("cancelled", "AbortError");
}

// A deterministic `Clock` double. `now()` never advances merely by being read — it moves forward
// only when `sleep()` is awaited, exactly mirroring the relationship `systemClock` (`resilience.ts`)
// has with real wall-clock time. `sleep()` honours an already-aborted signal (rejects, same as
// `systemClock`), otherwise advances the simulated clock by exactly the `ms` it was asked to wait,
// or by the next entry of `script.sleepMs` when one is supplied.
export function createScriptedGatewayClock(script: GatewayClockScript = {}): Clock {
  let current = 0;
  let sleepCalls = 0;
  return {
    now: (): number => current,
    sleep: (ms: number, signal?: AbortSignal): Promise<void> => {
      if (signal?.aborted === true) {
        return Promise.reject(abortError());
      }
      current += scriptedAdvanceMs(script.sleepMs, sleepCalls, ms);
      sleepCalls += 1;
      return Promise.resolve();
    },
  };
}

// One scripted HTTP outcome. The success shape carries everything `createScriptedGatewayFetch`
// needs to build a real `Response`: `bodyJson` is JSON-stringified as the body, `headers` are
// passed through verbatim (a scripted 429 sets `retry-after` here, exactly like a real provider
// does, and `openai-adapter.ts` reads it back off the real `Response`), and `latencyMs` is what
// `clock.sleep()` is asked to wait before the `Response` resolves. The `networkError` variant
// mirrors `createScriptedModelPort`'s Error-entry branch one layer lower: no HTTP response is ever
// produced, matching a real transport failure (DNS, TLS, connection refused) that never reaches an
// HTTP status line.
export type GatewayReplayScriptEntry =
  | {
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly bodyJson: unknown;
      readonly latencyMs: number;
    }
  | { readonly networkError: true };

function isNetworkError(entry: GatewayReplayScriptEntry): entry is { readonly networkError: true } {
  return "networkError" in entry;
}

function scriptEntryAt(
  script: readonly GatewayReplayScriptEntry[],
  callIndex: number,
): GatewayReplayScriptEntry {
  const index = Math.min(callIndex, script.length - 1);
  const entry = script[index];
  if (entry === undefined) {
    throw new TypeError(
      "createScriptedGatewayFetch: empty script — no scripted response to return",
    );
  }
  return entry;
}

function scriptedResponse(entry: {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly bodyJson: unknown;
}): Response {
  return new Response(JSON.stringify(entry.bodyJson), {
    status: entry.status,
    headers: { "content-type": "application/json", ...entry.headers },
  });
}

// Replays `script` at the `fetch` seam (`AdapterDeps.fetchImpl` / `GatewayDeps.fetchImpl`).
// Call-index / repeat-last-entry semantics mirror `createScriptedModelPort` exactly: once calls
// exceed the script length the last entry repeats, so a test can script only the transitions it
// cares about and let a steady-state outcome repeat for every call after. `clock` is the SAME
// instance the caller passes to `Gateway`/`OpenAiAdapter` — see the module doc above for why that
// matters. Honours the request's `AbortSignal`: an already-aborted signal rejects immediately with
// an AbortError-shaped `DOMException`, via the injected clock's own abort handling.
export function createScriptedGatewayFetch(
  script: readonly GatewayReplayScriptEntry[],
  clock: Clock,
): typeof fetch {
  let calls = 0;
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const entry = scriptEntryAt(script, calls);
    calls += 1;
    if (isNetworkError(entry)) {
      throw new TypeError("createScriptedGatewayFetch: scripted network error");
    }
    await clock.sleep(entry.latencyMs, init?.signal ?? undefined);
    return scriptedResponse(entry);
  };
}
