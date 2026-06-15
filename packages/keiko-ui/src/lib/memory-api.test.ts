import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryId } from "@oscharko-dev/keiko-contracts";
import {
  cancelMemoryConsolidationJob,
  deleteMemory,
  fetchMemoryConsolidationJob,
  forgetMemories,
  resolveMemoryConflict,
  startMemoryConsolidation,
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
          reason: "remove global stale preferences",
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
        body: JSON.stringify({ acknowledged: true, reason: "stale" }),
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
