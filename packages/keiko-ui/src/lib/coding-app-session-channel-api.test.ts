import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingAppSessionChannelSnapshot } from "@oscharko-dev/keiko-contracts";

import {
  getCodingAppSessionChannelSnapshot,
  streamCodingAppSessionChannelSnapshots,
  STREAM_INACTIVITY_TIMEOUT_MS,
} from "./coding-app-session-channel-api";

const AT = "2026-07-19T12:00:00.000Z";

function snapshot(runId = "run-1"): CodingAppSessionChannelSnapshot {
  return {
    schemaVersion: "1",
    content: {
      kind: "safe-activity",
      feed: {
        schemaVersion: "1",
        availability: "available",
        runId,
        updatedAt: AT,
        turns: [],
        truncated: false,
        droppedEventCount: 0,
      },
    },
  };
}

function streamResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("coding app-session channel API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads and validates the authenticated snapshot without putting authority in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(snapshot()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCodingAppSessionChannelSnapshot()).resolves.toEqual(snapshot());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/coding-workbench/app-session/channel",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("run-1");
  });

  it("parses fragmented authenticated stream snapshots and ignores heartbeats", async () => {
    const received: CodingAppSessionChannelSnapshot[] = [];
    const payload = JSON.stringify(snapshot());
    const response = streamResponse([
      ": heartbeat\n\n",
      `event: snapshot\ndata: ${payload.slice(0, 24)}`,
      `${payload.slice(24)}\n\n`,
    ]);
    const fetchMock = vi.fn().mockResolvedValue(response);

    await streamCodingAppSessionChannelSnapshots({
      signal: new AbortController().signal,
      onSnapshot: (value) => received.push(value),
      fetchImpl: fetchMock,
    });

    expect(received).toEqual([snapshot()]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/coding-workbench/app-session/channel/stream",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "text/event-stream" }),
      }),
    );
    // The stream must carry a correlation id like every other BFF request, or a stream failure
    // cannot be traced UI -> server.
    const sent = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(sent.headers["X-Keiko-Correlation-Id"]).toMatch(/^[A-Za-z0-9_-]{8,}$/u);
  });

  it("fails closed when streamed content does not satisfy the channel contract", async () => {
    const response = streamResponse([
      'event: snapshot\ndata: {"schemaVersion":"1","content":{"kind":"safe-activity","feed":{}}}\n\n',
    ]);

    await expect(
      streamCodingAppSessionChannelSnapshots({
        signal: new AbortController().signal,
        onSnapshot: vi.fn(),
        fetchImpl: vi.fn().mockResolvedValue(response),
      }),
    ).rejects.toMatchObject({ code: "CONTRACT_VALIDATION_FAILED", status: 502 });
  });

  // The four fail-closed guards in the stream consumer were previously untested; each is now
  // pinned with a negative-branch test so a regression that swallows a broken frame or an
  // over-budget buffer cannot pass CI.

  it("fails closed with the transport status when the stream response is not 2xx", async () => {
    const response = new Response(null, { status: 503 });
    await expect(
      streamCodingAppSessionChannelSnapshots({
        signal: new AbortController().signal,
        onSnapshot: vi.fn(),
        fetchImpl: vi.fn().mockResolvedValue(response),
      }),
    ).rejects.toMatchObject({
      code: "CODING_APP_SESSION_STREAM_UNAVAILABLE",
      status: 503,
    });
  });

  it("fails closed with 502 when the stream response has no readable body", async () => {
    // A 200 response with a null body is a corrupted upstream — surfacing anything less than
    // 502 would let the caller assume the projection is present when it is not.
    const response = new Response(null, { status: 200 });
    await expect(
      streamCodingAppSessionChannelSnapshots({
        signal: new AbortController().signal,
        onSnapshot: vi.fn(),
        fetchImpl: vi.fn().mockResolvedValue(response),
      }),
    ).rejects.toMatchObject({
      code: "CODING_APP_SESSION_STREAM_UNAVAILABLE",
      status: 502,
    });
  });

  it("fails closed when a frame has an empty data field", async () => {
    const response = streamResponse(["event: snapshot\ndata:\n\n"]);
    await expect(
      streamCodingAppSessionChannelSnapshots({
        signal: new AbortController().signal,
        onSnapshot: vi.fn(),
        fetchImpl: vi.fn().mockResolvedValue(response),
      }),
    ).rejects.toMatchObject({
      code: "CODING_APP_SESSION_STREAM_UNAVAILABLE",
      status: 502,
    });
  });

  it("fails closed when the parser cannot decode a frame as JSON", async () => {
    const response = streamResponse(["event: snapshot\ndata: {not-json\n\n"]);
    await expect(
      streamCodingAppSessionChannelSnapshots({
        signal: new AbortController().signal,
        onSnapshot: vi.fn(),
        fetchImpl: vi.fn().mockResolvedValue(response),
      }),
    ).rejects.toMatchObject({
      code: "CODING_APP_SESSION_STREAM_UNAVAILABLE",
      status: 502,
    });
  });

  it("fails closed when the unterminated buffer grows past the channel's declared cap", async () => {
    // Deliver a single event line (no terminating '\n\n'), padded until buffered chars exceed
    // 2 * MAX_UTF8_BYTES. This must trip the 502 guard rather than accumulate indefinitely.
    const chunk = "event: snapshot\ndata: " + "A".repeat(200_000);
    const response = streamResponse([chunk, chunk, chunk]);
    await expect(
      streamCodingAppSessionChannelSnapshots({
        signal: new AbortController().signal,
        onSnapshot: vi.fn(),
        fetchImpl: vi.fn().mockResolvedValue(response),
      }),
    ).rejects.toMatchObject({
      code: "CODING_APP_SESSION_STREAM_UNAVAILABLE",
      status: 502,
    });
  });
});

// KEIKO-0308 — a stalled or half-broken TCP connection can leave `reader.read()` pending forever;
// the server-emitted heartbeat (every 15s, see codingAppSessionRoutes.ts) only protects the client
// if something here actually notices silence. These tests pin: (a) no bytes at all — heartbeat or
// snapshot — for longer than STREAM_INACTIVITY_TIMEOUT_MS aborts the reader and rejects with a typed
// error, and (b) heartbeat-only chunks reset the clock, so a quiet-but-alive stream is never
// mistaken for a dead one.
describe("KEIKO-0308 — stream inactivity guard", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Hand-rolled fake reader (mirrors quality-intelligence-api.test.ts's makeStreamResponse): a real
  // ReadableStream cannot have its chunk timing driven deterministically by fake timers, and the
  // "never resolves" case cannot be expressed as a real stream at all.
  function fakeReaderResponse(read: ReturnType<typeof vi.fn>): {
    response: Response;
    cancel: ReturnType<typeof vi.fn>;
  } {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read,
      cancel,
      releaseLock: vi.fn(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const response = {
      ok: true,
      status: 200,
      body: { getReader: () => reader } as unknown as ReadableStream<Uint8Array>,
    } as unknown as Response;
    return { response, cancel };
  }

  it("aborts a stalled stream and rejects with a typed error after the inactivity threshold", async () => {
    vi.useFakeTimers();
    // Never resolves — the exact "stalled or half-broken TCP connection" symptom from KEIKO-0308.
    const read = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}));
    const { response, cancel } = fakeReaderResponse(read);

    const promise = streamCodingAppSessionChannelSnapshots({
      signal: new AbortController().signal,
      onSnapshot: vi.fn(),
      fetchImpl: vi.fn().mockResolvedValue(response),
    });
    // Attach the rejection expectation BEFORE advancing time so it is a real handler, not a race
    // against an unhandled-rejection warning.
    const assertion = expect(promise).rejects.toMatchObject({
      code: "CODING_APP_SESSION_STREAM_STALLED",
      status: 504,
    });

    await vi.advanceTimersByTimeAsync(STREAM_INACTIVITY_TIMEOUT_MS + 1);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("resets the inactivity timer on every heartbeat-only chunk instead of aborting", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    // Each chunk arrives just under the threshold; only a broken (non-resetting) guard would abort.
    const interval = STREAM_INACTIVITY_TIMEOUT_MS - 5_000;
    const heartbeatCount = 5;
    let calls = 0;
    const doneResult = { done: true } satisfies Omit<
      ReadableStreamReadDoneResult<Uint8Array>,
      "value"
    >;
    const read = vi.fn(
      () =>
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
          setTimeout(() => {
            calls += 1;
            if (calls > heartbeatCount) {
              resolve(doneResult);
              return;
            }
            resolve({ done: false, value: encoder.encode(": heartbeat\n\n") });
          }, interval);
        }),
    );
    const { response } = fakeReaderResponse(read);
    const onSnapshot = vi.fn();

    const promise = streamCodingAppSessionChannelSnapshots({
      signal: new AbortController().signal,
      onSnapshot,
      fetchImpl: vi.fn().mockResolvedValue(response),
    });

    // Cumulatively far past the threshold (5 * 40s = 200s vs. a 45s threshold) — only correct
    // per-chunk resets, not a fixed one-shot timer, could let this reach a clean finish.
    await vi.advanceTimersByTimeAsync(interval * (heartbeatCount + 1));

    await expect(promise).resolves.toBeUndefined();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(heartbeatCount + 1);
  });

  // Codex PR #3089 (comment 3764844733): a native ReadableStream's `cancel()` resolves the
  // pending `read()` with `{ done: true }` — if that microtask wins the race, the stall becomes
  // a silent clean EOF and CODING_APP_SESSION_STREAM_STALLED never surfaces. This pin uses a
  // faithful producer (a real ReadableStream that never enqueues past the initial handshake
  // but whose reader.cancel() DOES resolve the pending read) to ensure the typed rejection wins
  // even against the microtask-level ordering the earlier fake-cancel test could not exercise.
  it("wins the stall verdict even when reader.cancel() would fulfil the pending read with EOF", async () => {
    vi.useFakeTimers();
    // Producer that opens the stream, sends nothing, and lets `cancel()` fulfil the pending read.
    // This mirrors the DOM-standard behavior of a real ReadableStream: pull is never called after
    // start returns, and cancel({ reason }) causes the reader.read() promise to resolve — not
    // reject — with { value: undefined, done: true }. The KEIKO-0308 guard has to reject FIRST.
    const stream = new ReadableStream<Uint8Array>({
      start(): void {
        // Deliberately empty — the read stays pending until cancel arrives.
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const promise = streamCodingAppSessionChannelSnapshots({
      signal: new AbortController().signal,
      onSnapshot: vi.fn(),
      fetchImpl: vi.fn().mockResolvedValue(response),
    });
    const assertion = expect(promise).rejects.toMatchObject({
      code: "CODING_APP_SESSION_STREAM_STALLED",
      status: 504,
    });

    await vi.advanceTimersByTimeAsync(STREAM_INACTIVITY_TIMEOUT_MS + 1);
    await assertion;
  });
});
