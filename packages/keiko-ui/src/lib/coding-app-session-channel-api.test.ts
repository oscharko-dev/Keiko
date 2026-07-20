import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingAppSessionChannelSnapshot } from "@oscharko-dev/keiko-contracts";

import {
  getCodingAppSessionChannelSnapshot,
  streamCodingAppSessionChannelSnapshots,
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
    const response = { ok: true, status: 200, body: null } as unknown as Response;
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
