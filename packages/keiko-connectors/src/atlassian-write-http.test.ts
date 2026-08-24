// Hermetic tests for the write-lane transport helper (Issue #2244, ADR-0128 D3): method-aware
// retry eligibility, bounded backoff with recorded sleeps (no wall clock), request-body byte
// gate, and the closed status classification. No network anywhere — the port is a scripted
// fixture.

import { describe, expect, it } from "vitest";
import {
  ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyRequest,
  type AtlassianHttpBodyResult,
} from "./atlassian-http-port.js";
import {
  ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS,
  ATLASSIAN_SYNC_RETRY_MAX_DELAY_MS,
  retryDelayMs,
} from "./atlassian-sync-lane.js";
import {
  ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS,
  executeAtlassianWriteRequest,
  type AtlassianWriteHttpRequest,
} from "./atlassian-write-http.js";

function response(
  status: number,
  bodyText = "{}",
  extra: Partial<Extract<AtlassianHttpBodyResult, { kind: "response" }>> = {},
): AtlassianHttpBodyResult {
  return {
    kind: "response",
    status,
    bodyText,
    bodyBytes: bodyText.length,
    truncated: false,
    ...extra,
  };
}

interface ScriptedPort {
  readonly port: AtlassianHttpBodyPort;
  readonly requests: AtlassianHttpBodyRequest[];
}

function scriptedPort(results: readonly AtlassianHttpBodyResult[]): ScriptedPort {
  const requests: AtlassianHttpBodyRequest[] = [];
  const queue = [...results];
  const port: AtlassianHttpBodyPort = (request) => {
    requests.push(request);
    const next = queue.shift();
    if (next === undefined) throw new Error("scripted port exhausted");
    return Promise.resolve(next);
  };
  return { port, requests };
}

function recordedSleep(delays: number[]): (ms: number) => Promise<void> {
  return (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };
}

const URL = "https://example.atlassian.net/rest/api/3/issue";

function request(over: Partial<AtlassianWriteHttpRequest> = {}): AtlassianWriteHttpRequest {
  return { method: "PUT", url: URL, bodyJson: "{}", expect: "none", ...over };
}

describe("executeAtlassianWriteRequest — classification", () => {
  it("classifies 2xx with a parsed JSON body", async () => {
    const { port } = scriptedPort([response(201, '{"id":"10001","key":"PROJ-9"}')]);
    const outcome = await executeAtlassianWriteRequest({ http: port }, request({ expect: "json" }));
    expect(outcome).toEqual({ ok: true, status: 201, body: { id: "10001", key: "PROJ-9" } });
  });

  it.each([
    { status: 400, reason: "field-validation" },
    { status: 401, reason: "auth-failed" },
    { status: 403, reason: "permission-denied" },
    { status: 404, reason: "not-found" },
    { status: 409, reason: "conflict" },
    { status: 302, reason: "unavailable" },
  ])("maps $status to $reason without retrying", async ({ status, reason }) => {
    const delays: number[] = [];
    const { port, requests } = scriptedPort([response(status)]);
    const outcome = await executeAtlassianWriteRequest(
      { http: port, sleep: recordedSleep(delays) },
      request(),
    );
    expect(outcome).toEqual({ ok: false, reason, httpStatus: status });
    expect(requests).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("classifies transport failures as typed timeout/unavailable", async () => {
    const timeout = await executeAtlassianWriteRequest(
      { http: scriptedPort([{ kind: "timeout" }]).port },
      request({ method: "POST" }),
    );
    expect(timeout).toEqual({ ok: false, reason: "timeout" });
    const network = await executeAtlassianWriteRequest(
      { http: scriptedPort([{ kind: "network-error" }]).port },
      request({ method: "POST" }),
    );
    expect(network).toEqual({ ok: false, reason: "unavailable" });
  });

  it("classifies truncated and unparseable JSON responses as malformed-payload", async () => {
    const truncated = await executeAtlassianWriteRequest(
      { http: scriptedPort([response(200, "{...", { truncated: true })]).port },
      request({ expect: "json" }),
    );
    expect(truncated).toEqual({ ok: false, reason: "malformed-payload", httpStatus: 200 });
    const garbage = await executeAtlassianWriteRequest(
      { http: scriptedPort([response(200, "not json")]).port },
      request({ expect: "json" }),
    );
    expect(garbage).toEqual({ ok: false, reason: "malformed-payload", httpStatus: 200 });
  });

  it("rejects an oversized request body before any port call (bounds-exceeded)", async () => {
    const { port, requests } = scriptedPort([]);
    const outcome = await executeAtlassianWriteRequest(
      { http: port },
      request({ bodyJson: "x".repeat(ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES + 1) }),
    );
    expect(outcome).toEqual({ ok: false, reason: "bounds-exceeded" });
    expect(requests).toHaveLength(0);
  });
});

describe("executeAtlassianWriteRequest — D3 retry discipline", () => {
  it("retries PUT on 5xx with exponential backoff and succeeds", async () => {
    const delays: number[] = [];
    const { port, requests } = scriptedPort([response(503), response(502), response(204, "")]);
    const outcome = await executeAtlassianWriteRequest(
      { http: port, sleep: recordedSleep(delays) },
      request(),
    );
    expect(outcome).toEqual({ ok: true, status: 204, body: undefined });
    expect(requests).toHaveLength(3);
    expect(delays).toEqual([500, 1000]);
  });

  it("caps attempts at the D3 maximum: no retry storm on persistent 5xx", async () => {
    const delays: number[] = [];
    const { port, requests } = scriptedPort(
      Array.from({ length: ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS }, () => response(500)),
    );
    const outcome = await executeAtlassianWriteRequest(
      { http: port, sleep: recordedSleep(delays) },
      request(),
    );
    expect(outcome).toEqual({ ok: false, reason: "unavailable", httpStatus: 500 });
    expect(requests).toHaveLength(ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS);
    expect(delays).toEqual([500, 1000, 2000, 4000]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(ATLASSIAN_SYNC_RETRY_MAX_DELAY_MS);
  });

  it("honors Retry-After on PUT 429 and caps it at the backoff ceiling", async () => {
    const delays: number[] = [];
    const { port } = scriptedPort([
      response(429, "{}", { retryAfterMs: 60_000 }),
      response(204, ""),
    ]);
    const outcome = await executeAtlassianWriteRequest(
      { http: port, sleep: recordedSleep(delays) },
      request(),
    );
    expect(outcome).toEqual({ ok: true, status: 204, body: undefined });
    expect(delays).toEqual([ATLASSIAN_SYNC_RETRY_MAX_DELAY_MS]);
  });

  it("NEVER retries POST on 5xx (non-idempotent: the mutation may have committed)", async () => {
    const delays: number[] = [];
    const { port, requests } = scriptedPort([response(500)]);
    const outcome = await executeAtlassianWriteRequest(
      { http: port, sleep: recordedSleep(delays) },
      request({ method: "POST" }),
    );
    expect(outcome).toEqual({ ok: false, reason: "unavailable", httpStatus: 500 });
    expect(requests).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("NEVER retries POST on a 429 without Retry-After", async () => {
    const { port, requests } = scriptedPort([response(429)]);
    const outcome = await executeAtlassianWriteRequest({ http: port }, request({ method: "POST" }));
    expect(outcome).toEqual({ ok: false, reason: "rate-limited", httpStatus: 429 });
    expect(requests).toHaveLength(1);
  });

  it("retries POST only on a Retry-After-bearing 429 (server-directed pacing)", async () => {
    const delays: number[] = [];
    const { port, requests } = scriptedPort([
      response(429, "{}", { retryAfterMs: 1_500 }),
      response(201, '{"id":"1"}'),
    ]);
    const outcome = await executeAtlassianWriteRequest(
      { http: port, sleep: recordedSleep(delays) },
      request({ method: "POST", expect: "json" }),
    );
    expect(outcome).toEqual({ ok: true, status: 201, body: { id: "1" } });
    expect(requests).toHaveLength(2);
    expect(delays).toEqual([1_500]);
  });

  it("issues every attempt with the 30s write timeout and the bounded response cap", async () => {
    const { port, requests } = scriptedPort([response(204, "")]);
    await executeAtlassianWriteRequest({ http: port }, request());
    expect(requests[0]).toMatchObject({ timeoutMs: 30_000, maxBodyBytes: 262_144, method: "PUT" });
  });

  // KEIKO-0318: the retry loop must respect an aggregate deadline across attempts. Without it a
  // hostile upstream that hangs at the per-request timeout ceiling for every attempt holds the
  // governed write action for minutes. With an injected clock and injected sleep that advances
  // it, once the clock crosses the aggregate deadline the executor stops issuing further
  // requests.
  it("stops retrying once the aggregate deadline is crossed (KEIKO-0318)", async () => {
    const START = 1_000_000;
    let clock = START;
    const advancingSleep = (ms: number): Promise<void> => {
      clock += ms;
      return Promise.resolve();
    };
    // Simulate the worst-case hostile server: every request hangs for the full per-request
    // timeout, then answers with a 429 carrying an 8s Retry-After. The port ADVANCES the clock
    // by the actual timeoutMs it was given, matching real-world timeout behaviour.
    const requestCount = { n: 0 };
    const port: AtlassianHttpBodyPort = (req) => {
      requestCount.n += 1;
      clock += req.timeoutMs;
      return Promise.resolve({
        kind: "response",
        status: 429,
        bodyText: "",
        bodyBytes: 0,
        truncated: false,
        retryAfterMs: 8_000,
      });
    };
    const outcome = await executeAtlassianWriteRequest(
      { http: port, sleep: advancingSleep, now: () => clock },
      request(),
    );
    expect(outcome).toEqual({ ok: false, reason: "rate-limited", httpStatus: 429 });
    // The executor must have stopped before the D3 max-attempt count. 5 attempts at 30s + 4×8s
    // = 182 s, which is EXACTLY the aggregate deadline — so with any hostile behaviour that
    // pads the per-request time, fewer than 5 attempts must run before the deadline binds.
    expect(requestCount.n).toBeLessThan(ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS);
    // Total wall-time consumed must not exceed the aggregate ceiling by more than one in-flight
    // request's worth (which is the pre-attempt timeout clamp's floor).
    expect(clock - START).toBeLessThanOrEqual(
      ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS + ATLASSIAN_SYNC_RETRY_MAX_DELAY_MS,
    );
  });

  // KEIKO-0247: the D3 backoff formula lives in ONE canonical helper (retryDelayMs, exported from
  // atlassian-sync-lane). This lane's observed sleep delays must equal that helper's outputs so a
  // divergent local copy cannot re-appear silently.
  it("delegates to the canonical retryDelayMs — no local copy of the D3 formula", async () => {
    const delays: number[] = [];
    const { port } = scriptedPort([
      response(500),
      response(500),
      response(500),
      response(500),
      response(204, ""),
    ]);
    await executeAtlassianWriteRequest({ http: port, sleep: recordedSleep(delays) }, request());
    const expected = Array.from({ length: ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS - 1 }, (_, index) =>
      retryDelayMs(index + 1, undefined),
    );
    expect(delays).toEqual(expected);
  });
});
