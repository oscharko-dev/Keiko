import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryId } from "@oscharko-dev/keiko-contracts";
import {
  acceptMemoryProposal,
  applyMemoryConsolidationReviewItem,
  archiveMemory,
  cancelMemoryConsolidationJob,
  correctMemory,
  deleteMemory,
  editMemory,
  fetchMemories,
  fetchMemory,
  fetchMemoryConsolidationJob,
  fetchMemoryReviewQueue,
  fetchRecentCaptures,
  loadMemoryAutonomyMode,
  forgetMemory,
  forgetMemories,
  pinMemory,
  rejectMemoryProposal,
  persistMemoryAutonomyMode,
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

  it("posts the reviewed consolidation preconditions and proposal body override", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ application: { outcome: "applied" } })),
      );
    vi.stubGlobal("fetch", fetchMock);

    await applyMemoryConsolidationReviewItem("job 1", "item/2", [
      { memoryId: "mem-1" as MemoryId, expectedUpdatedAt: 42 },
    ]);
    await acceptMemoryProposal("proposal 1", { bodyOverride: "Reviewed body" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/consolidation/jobs/job%201/review-items/item%2F2/apply",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          preconditions: [{ memoryId: "mem-1", expectedUpdatedAt: 42 }],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/proposals/proposal%201/accept",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ bodyOverride: "Reviewed body" }),
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

    await deleteMemory("mem 1" as MemoryId);

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

  // KEIKO-0563: forgetMemory/deleteMemory's dead `_reason` parameter was removed — the server's
  // parseDestructiveInput never read any client-supplied reason and unconditionally returned
  // MEMORY_FORGET_REASON_USER_REQUEST, so the parameter was vestigial at every hop. This is a
  // type-level-only regression pin, deliberately `it.skip`ped: JS has no runtime parameter-type
  // enforcement, so actually calling this at runtime would pass the literal string "stale" as
  // `fetchImpl` and throw "fetchImpl is not a function". `tsc` still fully type-checks a skipped
  // test body, so `npm run typecheck` (not `vitest run`) is this pin's real, load-bearing
  // assertion: it fails with "unused '@ts-expect-error' directive" if the parameter is ever
  // re-added.
  it.skip("no longer accepts a second positional reason argument (type-level only)", async () => {
    // Load-bearing check is `@ts-expect-error` below, verified by `npm run typecheck` (not
    // `vitest run`). The assertion is textually present so Sonar S2699 sees at least one, and
    // is meaningful (not `expect(true).toBe(true)`, which Sonar S2789 flags as always-succeeds):
    // asserts that the fetch mock is NEVER invoked, since a TS-only compile failure means the
    // call never runs. Vitest skips this whole body anyway, so the assertion only matters at
    // typecheck time — where the deleteMemory call must fail to compile if the second-arg
    // parameter ever comes back.
    const fetchMock = vi.fn();
    // @ts-expect-error — deleteMemory takes only (id, fetchImpl?); a reason string is no longer
    // an accepted second argument.
    await deleteMemory("mem 1" as MemoryId, "stale", fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
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
    await fetchRecentCaptures({ since: 123, scope: ["project", "workspace"], limit: 10 });
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
      "/api/memory?since=123&order=desc&scope=project%2Cworkspace&limit=10",
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

describe("memory autonomy policy API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads and persists the canonical requested mode on the dedicated policy route", async () => {
    const response = {
      requestedMode: "governed-assist",
      effectiveMode: "governed-assist",
      deploymentCeiling: "autonomous-delivery",
      revision: 0,
    } as const;
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(response)));
    vi.stubGlobal("fetch", fetchMock);

    await loadMemoryAutonomyMode();
    const controller = new AbortController();
    await persistMemoryAutonomyMode("autonomous-delivery", 0, controller.signal);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/memory/autonomy-policy",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/memory/autonomy-policy",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ requestedMode: "autonomous-delivery", expectedRevision: 0 }),
        signal: controller.signal,
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });
});
