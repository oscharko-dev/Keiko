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
      expect.objectContaining({ headers: { Accept: "text/event-stream" } }),
    );
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
});
