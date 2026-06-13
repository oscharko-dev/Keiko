import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelMemoryConsolidationJob,
  fetchMemoryConsolidationJob,
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
