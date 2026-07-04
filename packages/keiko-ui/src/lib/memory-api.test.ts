import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryId } from "@oscharko-dev/keiko-contracts";
import {
  acceptMemoryProposal,
  archiveMemory,
  cancelMemoryConsolidationJob,
  correctMemory,
  deleteMemory,
  editMemory,
  fetchMemories,
  fetchMemory,
  fetchMemoryConsolidationJob,
  fetchMemoryReviewQueue,
  forgetMemory,
  forgetMemories,
  pinMemory,
  rejectMemoryProposal,
  resolveMemoryConflict,
  startMemoryConsolidation,
  unpinMemory,
} from "./memory-api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("memory consolidation API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts explicit settings when starting a consolidation job", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ job: { job: { id: "job-1", state: "queued" } } }));
    vi.stubGlobal("fetch", fetchMock);

    await startMemoryConsolidation({
      jaccardThreshold: 0.9,
      staleConfidenceThreshold: 0.2,
      maxAgeMs: 1_000,
      maxClustersPerRun: 25,
      maxRecordsPerRun: 500,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/consolidation/jobs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          settings: {
            jaccardThreshold: 0.9,
            staleConfidenceThreshold: 0.2,
            maxAgeMs: 1_000,
            maxClustersPerRun: 25,
            maxRecordsPerRun: 500,
          },
        }),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });

  it("fetches a consolidation job by id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ job: { job: { id: "job-2", state: "running" } } }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchMemoryConsolidationJob("job 2");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/consolidation/jobs/job%202",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/json",
        }),
      }),
    );
  });

  it("posts to the cancel endpoint for a consolidation job", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ job: { job: { id: "job-3", state: "canceled" } } }));
    vi.stubGlobal("fetch", fetchMock);

    await cancelMemoryConsolidationJob("job/3");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/consolidation/jobs/job%2F3/cancel",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });
});

describe("memory governance API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts selector-based forget requests with explicit acknowledgement", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ forgotten: true, memoryIds: ["m-1"], count: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await forgetMemories({
      selector: { kind: "by-type", scope: { kind: "global" }, type: "preference" },
      reason: "remove global stale preferences",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/forget",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          acknowledged: true,
          selector: { kind: "by-type", scope: { kind: "global" }, type: "preference" },
        }),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });

  it("sends delete requests as acknowledged tombstone deletions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ deleted: true, memoryId: "mem 1", memoryIds: ["mem 1"], count: 1 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await deleteMemory("mem 1" as MemoryId, "stale");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/mem%201",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ acknowledged: true }),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });

  it("posts conflict-resolution requests to the literal conflict route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        resolved: true,
        winner: "m-new",
        losers: ["m-old"],
        supersessionEdgeIds: ["edge-1"],
        transitions: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await resolveMemoryConflict({
      winner: "m-new" as MemoryId,
      losers: ["m-old" as MemoryId],
      reason: "reviewed by operator",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/conflicts/resolve",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          winner: "m-new",
          losers: ["m-old"],
          reason: "reviewed by operator",
        }),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });
});

describe("memory BFF boundary helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("encodes list, detail, lifecycle, correction, and proposal routes", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ memory: { id: "mem 1" } })));
    vi.stubGlobal("fetch", fetchMock);

    await fetchMemories({
      query: "atlas rust",
      scope: ["global", "workspace"],
      type: ["preference", "semantic-fact"],
      status: ["accepted"],
      sensitivity: ["public", "confidential"],
      limit: 25,
      offset: 50,
    });
    await fetchMemoryReviewQueue();
    await fetchMemory("mem 1" as MemoryId);
    await editMemory("mem 1" as MemoryId, {
      body: "corrected preference",
      tags: ["release", "rag"],
      sensitivity: "confidential",
    });
    await pinMemory("mem 1" as MemoryId);
    await unpinMemory("mem 1" as MemoryId);
    await archiveMemory("mem 1" as MemoryId);
    await forgetMemory("mem 1" as MemoryId);
    await correctMemory("mem 1" as MemoryId, "new canonical body");
    await acceptMemoryProposal("proposal 1");
    await rejectMemoryProposal("proposal 1", "not applicable");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory?q=atlas+rust&scope=global%2Cworkspace&type=preference%2Csemantic-fact&status=accepted&sensitivity=public%2Cconfidential&limit=25&offset=50",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/review-queue",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/mem%201",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/mem%201",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          body: "corrected preference",
          tags: ["release", "rag"],
          sensitivity: "confidential",
        }),
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/mem%201/pin",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/mem%201/archive",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/mem%201/forget",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ acknowledged: true }),
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/mem%201/correct",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ body: "new canonical body" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/proposals/proposal%201/accept",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/proposals/proposal%201/reject",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reason: "not applicable" }),
      }),
    );
  });

  it("surfaces typed server errors without leaking unparseable bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ error: { code: "MEMORY_DENIED", message: "Review required" } }, 403),
        )
        .mockResolvedValueOnce(new Response("secret stack", { status: 500 })),
    );

    await expect(fetchMemory("mem denied" as MemoryId)).rejects.toMatchObject({
      code: "MEMORY_DENIED",
      message: "Review required",
      status: 403,
    });
    await expect(fetchMemory("mem broken" as MemoryId)).rejects.toMatchObject({
      code: "INTERNAL",
      message: "HTTP 500",
      status: 500,
    });
  });

  // The former memory-local fetchJson had no 204 short-circuit and would call res.json() on an empty
  // body (throwing). Routing through the shared bffFetchJson folds in 204 → undefined (safe-forward).
  it("resolves undefined when a mutation route returns 204 No Content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(deleteMemory("mem 1" as MemoryId)).resolves.toBeUndefined();
  });
});
