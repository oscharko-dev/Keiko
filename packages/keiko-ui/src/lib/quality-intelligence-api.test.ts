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

import {
  cancelQiRun,
  deleteQiRun,
  editQiCandidate,
  exportQiRun,
  exportQiRunTraceability,
  fetchQiRunDetail,
  fetchQiRuns,
  reCheckQiRun,
  regenerateStaleQiRun,
  reviewQiRun,
  startQiRun,
} from "./quality-intelligence-api.js";

type Frame = QualityIntelligenceRunStreamMessage;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const messages: Frame[] = [];

    await startQiRun(
      { sources: [], profileId: "regression-default", modelId: "model 1", seed: 17 },
      new AbortController().signal,
      (m) => {
        messages.push(m);
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/quality-intelligence/runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sources: [],
          profileId: "regression-default",
          modelId: "model 1",
          seed: 17,
        }),
        headers: expect.objectContaining({
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
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

  it("throws typed errors for JSON pre-stream failures and missing stream bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            { error: { code: "QI_PROFILE_DISABLED", message: "Profile disabled" } },
            409,
          ),
        )
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => "text/event-stream" },
          body: null,
        } as unknown as Response),
    );

    await expect(
      startQiRun(
        { sources: [], profileId: "regression-default" },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toMatchObject({
      code: "QI_PROFILE_DISABLED",
      message: "Profile disabled",
      status: 409,
    });
    await expect(
      startQiRun(
        { sources: [], profileId: "regression-default" },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toMatchObject({
      code: "QI_NO_STREAM",
      message: "The server did not return a progress stream.",
      status: 200,
    });
  });
});

describe("quality intelligence JSON BFF helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("encodes run lifecycle, review, edit, drift, export, and traceability routes", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          runs: [],
          run: { id: "run 1" },
          runId: "run 1",
          status: "deleted",
          removedCompanionSuffixes: [".qi.json"],
          cancelled: true,
          runState: "approved",
          candidateStates: { "candidate 1": "approved" },
          auditCount: 1,
          candidate: { id: "candidate 1", title: "Edited" },
          staleCandidates: [],
          createdRunId: "run 2",
          dryRun: true,
          adapter: "csv",
          candidateCount: 1,
          byteLen: 7,
          preview: "id,title",
          format: "csv",
          filename: "trace.csv",
          contentType: "text/csv",
          body: "id,title",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchQiRuns();
    await fetchQiRunDetail("run 1");
    await deleteQiRun("run 1");
    await cancelQiRun("run 1");
    await reviewQiRun("run 1", "approve", "candidate 1", "release reviewer");
    await editQiCandidate("run 1", "candidate 1", { title: "Edited", priority: "P1" }, "qa");
    await reCheckQiRun("run 1", []);
    await regenerateStaleQiRun("run 1", []);
    await exportQiRun("run 1", "csv", { dryRun: true, approvedOnly: true });
    await exportQiRunTraceability("run 1", "csv");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/quality-intelligence/runs",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/quality-intelligence/runs/run%201",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/quality-intelligence/runs/run%201/cancel",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/quality-intelligence/runs/run%201/review",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "approve",
          candidateId: "candidate 1",
          reviewerLabel: "release reviewer",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/quality-intelligence/runs/run%201/edit",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          candidateId: "candidate 1",
          edited: { title: "Edited", priority: "P1" },
          editorLabel: "qa",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/quality-intelligence/runs/run%201/regenerate-stale",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ sources: [] }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/quality-intelligence/runs/run%201/export",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ adapter: "csv", dryRun: true, approvedOnly: true }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/quality-intelligence/runs/run%201/traceability",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ format: "csv" }),
      }),
    );
  });

  it("maps BFF JSON errors and unparseable failures to ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ error: { code: "QI_NOT_FOUND", message: "Run not found" } }, 404),
        )
        .mockResolvedValueOnce(new Response("stack trace", { status: 500 })),
    );

    await expect(fetchQiRunDetail("missing")).rejects.toMatchObject({
      code: "QI_NOT_FOUND",
      message: "Run not found",
      status: 404,
    });
    await expect(deleteQiRun("broken")).rejects.toMatchObject({
      code: "INTERNAL",
      message: "HTTP 500",
      status: 500,
    });
  });
});
