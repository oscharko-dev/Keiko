// Stream-lifecycle tests for startQiRun (Issue #280, pr-reviewer M1).
//
// The browser cancels a Quality Intelligence run by aborting the fetch, which closes the SSE
// connection; that close is what fires the server's res.on("close") cancel hook to stop model
// work. For the close to happen promptly the reader must be CANCELLED (not merely released) in the
// finally block — releaseLock() alone leaves the body stream (and HTTP connection) open until GC.
// These tests pin: (a) frames are parsed and delivered, and (b) the stream is cancelled before the
// lock is released, on both normal completion and abort.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { QualityIntelligenceRunStreamMessage } from "@oscharko-dev/keiko-contracts";

import { startQiRun } from "./quality-intelligence-api.js";

type Frame = QualityIntelligenceRunStreamMessage;

function makeStreamResponse(frames: readonly Frame[]): {
  response: Response;
  calls: string[];
  read: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  let i = 0;
  const encoder = new TextEncoder();
  const read = vi.fn(async () => {
    if (i < frames.length) {
      const chunk = encoder.encode(`data: ${JSON.stringify(frames[i++])}\n\n`);
      return { done: false, value: chunk };
    }
    return { done: true, value: undefined };
  });
  const reader = {
    read,
    cancel: vi.fn(async () => {
      calls.push("cancel");
    }),
    releaseLock: vi.fn(() => {
      calls.push("releaseLock");
    }),
    closed: Promise.resolve(undefined),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;

  const response = {
    ok: true,
    status: 200,
    headers: {
      get: (h: string) => (h.toLowerCase() === "content-type" ? "text/event-stream" : null),
    },
    body: { getReader: () => reader } as unknown as ReadableStream<Uint8Array>,
  } as unknown as Response;

  return { response, calls, read };
}

const ACCEPTED: Frame = {
  type: "accepted",
  runId: "run-1",
  requestedAt: "2026-01-01T00:00:00.000Z",
  sourceCount: 1,
  atomCount: 1,
};
const DONE: Frame = {
  type: "done",
  runId: "run-1",
  status: "succeeded",
  totals: { candidates: 0, findings: 0, exports: 0 },
};

describe("startQiRun — stream lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses and delivers each SSE frame to onMessage", async () => {
    const { response } = makeStreamResponse([ACCEPTED, DONE]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const messages: Frame[] = [];

    await startQiRun(
      { sources: [], profileId: "regression-default" },
      new AbortController().signal,
      (m) => {
        messages.push(m);
      },
    );

    expect(messages).toEqual([ACCEPTED, DONE]);
  });

  it("cancels the body stream BEFORE releasing the lock on normal completion", async () => {
    const { response, calls } = makeStreamResponse([ACCEPTED, DONE]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await startQiRun(
      { sources: [], profileId: "regression-default" },
      new AbortController().signal,
      () => {},
    );

    // releaseLock() alone would leave the HTTP connection open until GC; cancel() must run first.
    expect(calls).toEqual(["cancel", "releaseLock"]);
  });

  it("cancels the stream when the signal is already aborted (prompt server-side cancel)", async () => {
    const { response, calls } = makeStreamResponse([ACCEPTED, DONE]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const controller = new AbortController();
    controller.abort();

    await startQiRun({ sources: [], profileId: "regression-default" }, controller.signal, () => {});

    // The read loop never runs (signal pre-aborted), but the finally still cancels then releases.
    expect(calls).toEqual(["cancel", "releaseLock"]);
  });

  it("still cancels the stream when the reader rejects mid-read", async () => {
    const { response, calls, read } = makeStreamResponse([ACCEPTED]);
    // Force read() to reject, mimicking an AbortError thrown by the platform reader on abort.
    read.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      startQiRun(
        { sources: [], profileId: "regression-default" },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow();

    // The finally block must still cancel the body stream even when read() threw.
    expect(calls).toContain("cancel");
  });
});
