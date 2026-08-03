// Unit proof for the manual-pod job registry + body-free progress projection (Issue #2063). The
// background create/refresh runners compose already-tested domain functions; here we pin the pure
// orchestration: registry lifecycle, coarse live-progress event application, and the domain->wire
// projection (which must stay body-free).

import { describe, expect, it, vi } from "vitest";
import type {
  HtmlManualIndexingProgress,
  ManualCrawlEvent,
} from "@oscharko-dev/keiko-local-knowledge";
import type { UiHandlerDeps } from "../deps.js";
import {
  ManualPodJobRegistry,
  applyCrawlEvent,
  buildHttpManualSource,
  createTerminalState,
  executeJob,
  getManualPodJob,
  initialJob,
  manualPodJobRegistry,
  projectJob,
  refreshTerminalState,
  startManualPodCreate,
  startManualPodRefresh,
  type ManualPodJobContext,
} from "./manual-pod-service.js";

const PROGRESS: HtmlManualIndexingProgress = {
  phase: "ready",
  crawl: { status: "completed", discovered: 3, accepted: 2, deniedCount: 1, bytesFetched: 64 },
  indexing: {
    status: "succeeded",
    totalDocuments: 2,
    processedDocuments: 2,
    failedDocuments: 0,
    skippedDocuments: 0,
    vectorsPersisted: 4,
  },
  deniedLinks: [],
  remediations: [],
};

// A context whose env/fetcher are never touched (the run thunk is injected in these tests). The
// store fakes just enough of `_internal.db` for the LK-003 running-job guard's query; by default no
// job is running for any capsule, matching every pre-existing test's expectations.
function stubContext(runningJobIdForCapsule?: string): ManualPodJobContext {
  const db = {
    prepare: (): { get: () => { readonly id: string } | undefined } => ({
      get: (): { readonly id: string } | undefined =>
        runningJobIdForCapsule === undefined ? undefined : { id: runningJobIdForCapsule },
    }),
  };
  return {
    env: {
      store: { _internal: { db } } as never,
      close: vi.fn(),
      embeddingAdapter: {} as never,
    },
    fetcher: {} as never,
  };
}

// A context whose LK-003 running-job query throws (a DB error), to prove the guard still closes
// the store on the query's own failure, not just on the "job already running" branch.
function stubContextWithThrowingQuery(): ManualPodJobContext {
  const db = {
    prepare: (): { get: () => never } => ({
      get: (): never => {
        throw new Error("db unavailable");
      },
    }),
  };
  return {
    env: {
      store: { _internal: { db } } as never,
      close: vi.fn(),
      embeddingAdapter: {} as never,
    },
    fetcher: {} as never,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("ManualPodJobRegistry", () => {
  it("registers, reads back, and patches a job", () => {
    const registry = new ManualPodJobRegistry();
    const job = initialJob("job-1", "refresh", "cap-1", "src-1");
    registry.register(job, new AbortController());
    expect(registry.get("job-1")?.state).toBe("running");
    registry.patch("job-1", { ...job, state: "succeeded" });
    expect(registry.get("job-1")?.state).toBe("succeeded");
    expect(registry.get("missing")).toBeUndefined();
  });

  it("caps retained jobs, evicting a terminal job before a running one", () => {
    const registry = new ManualPodJobRegistry();
    // Fill beyond the cap: the first job is terminal (succeeded), the rest are running.
    registry.register(
      { ...initialJob("old-terminal", "refresh", "c", "s"), state: "succeeded" },
      new AbortController(),
    );
    for (let i = 0; i < 64; i += 1) {
      registry.register(initialJob(`run-${String(i)}`, "refresh", "c", "s"), new AbortController());
    }
    // The terminal job is evicted first; a running job survives.
    expect(registry.get("old-terminal")).toBeUndefined();
    expect(registry.get("run-63")?.state).toBe("running");
  });
});

describe("initialJob", () => {
  it("starts running in the crawling phase with zeroed counts", () => {
    const job = initialJob("j", "create", "cap", "src");
    expect(job).toMatchObject({
      jobId: "j",
      operation: "create",
      state: "running",
      phase: "crawling",
      capsuleId: "cap",
      sourceId: "src",
      crawl: { discovered: 0, accepted: 0, deniedCount: 0, bytesFetched: 0 },
      indexing: null,
    });
  });
});

describe("applyCrawlEvent", () => {
  const base = initialJob("j", "refresh", "cap", "src");

  it("ticks accepted on page-accepted and denied on link-denied", () => {
    const accepted = applyCrawlEvent(base, {
      kind: "page-accepted",
      relativePath: "a.html",
      depth: 1,
    });
    expect(accepted.crawl.accepted).toBe(1);
    const denied = applyCrawlEvent(base, { kind: "link-denied", reason: "cross-origin" });
    expect(denied.crawl.deniedCount).toBe(1);
  });

  it("ignores non-count events", () => {
    const event: ManualCrawlEvent = { kind: "cancelled" };
    expect(applyCrawlEvent(base, event)).toBe(base);
  });
});

describe("projectJob", () => {
  const base = initialJob("j", "refresh", "cap", "src");
  const progress: HtmlManualIndexingProgress = {
    phase: "ready",
    crawl: { status: "completed", discovered: 5, accepted: 4, deniedCount: 1, bytesFetched: 2048 },
    indexing: {
      status: "succeeded",
      totalDocuments: 4,
      processedDocuments: 4,
      failedDocuments: 0,
      skippedDocuments: 0,
      vectorsPersisted: 12,
    },
    deniedLinks: [{ reason: "cross-origin", count: 1 }],
    remediations: [{ reason: "links-denied", guidance: "Some links were skipped." }],
  };

  it("maps the domain progress onto the wire job and stamps the terminal state", () => {
    const job = projectJob(base, progress, "succeeded");
    expect(job.state).toBe("succeeded");
    expect(job.phase).toBe("ready");
    expect(job.crawl).toEqual({ discovered: 5, accepted: 4, deniedCount: 1, bytesFetched: 2048 });
    expect(job.indexing?.vectorsPersisted).toBe(12);
    expect(job.remediations).toEqual([
      { reason: "links-denied", guidance: "Some links were skipped." },
    ]);
  });

  it("stays body-free: the projection never carries a status field or raw content", () => {
    const job = projectJob(base, progress, "succeeded");
    const serialised = JSON.stringify(job);
    // The domain crawl/indexing `status` fields are intentionally dropped from the wire projection.
    expect(job.crawl).not.toHaveProperty("status");
    expect(job.indexing).not.toHaveProperty("status");
    expect(serialised).not.toContain("html");
  });
});

describe("executeJob", () => {
  it("projects a successful run (with a crawl event) onto the registry as succeeded", async () => {
    const base = initialJob("exec-ok", "refresh", "c", "s");
    manualPodJobRegistry.register(base, new AbortController());
    await executeJob("exec-ok", base, new AbortController(), (onCrawlEvent) => {
      onCrawlEvent({ kind: "page-accepted", relativePath: "a.html", depth: 1 });
      return Promise.resolve({ progress: PROGRESS, state: "succeeded" });
    });
    const job = getManualPodJob("exec-ok");
    expect(job?.state).toBe("succeeded");
    expect(job?.crawl.accepted).toBe(2);
    expect(job?.indexing?.vectorsPersisted).toBe(4);
  });

  it("projects a resolved-but-failed run as failed (a fail-closed refresh is not a success)", async () => {
    const base = initialJob("exec-noapply", "refresh", "c", "s");
    manualPodJobRegistry.register(base, new AbortController());
    // The domain run resolved (no throw) but the operation did not take effect — the runner reports
    // state=failed, and executeJob must honor it rather than defaulting to succeeded.
    await executeJob("exec-noapply", base, new AbortController(), () =>
      Promise.resolve({ progress: { ...PROGRESS, phase: "degraded" }, state: "failed" }),
    );
    const job = getManualPodJob("exec-noapply");
    expect(job?.state).toBe("failed");
    expect(job?.phase).toBe("degraded");
  });

  it("fails closed to a failed job (body-free) when the run rejects", async () => {
    const base = initialJob("exec-fail", "refresh", "c", "s");
    const diagnostics = { record: vi.fn() };
    manualPodJobRegistry.register(base, new AbortController());
    await executeJob(
      "exec-fail",
      base,
      new AbortController(),
      () => Promise.reject(new Error("secret crawl detail")),
      diagnostics,
    );
    const job = getManualPodJob("exec-fail");
    expect(job?.state).toBe("failed");
    expect(JSON.stringify(job)).not.toContain("secret crawl detail");
    expect(diagnostics.record).toHaveBeenCalledOnce();
    expect(diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "exec-fail",
        operation: "manual-pod.job",
        errorClass: "Error",
      }),
    );
    expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain("secret crawl detail");
  });
});

describe("refreshTerminalState", () => {
  it("is succeeded only for an applied refresh whose index-apply did not fail and covered the manual", () => {
    expect(refreshTerminalState(true, "updated", PROGRESS)).toBe("succeeded");
    expect(refreshTerminalState(true, "unchanged", PROGRESS)).toBe("succeeded");
    expect(refreshTerminalState(true, "partial", PROGRESS)).toBe("succeeded");
    expect(refreshTerminalState(true, "failed", PROGRESS)).toBe("failed");
  });

  it("is partial for an applied refresh that left gaps (same honesty rule as create)", () => {
    const degraded: HtmlManualIndexingProgress = { ...PROGRESS, phase: "degraded" };
    expect(refreshTerminalState(true, "updated", degraded)).toBe("partial");
    expect(refreshTerminalState(true, "unchanged", degraded)).toBe("partial");
  });

  it("is failed for every not-applied refresh (prior pod intact), whatever the outcome", () => {
    // The regression: a limit-reached crawl reports outcome "partial" but never applied, so the
    // prior pod is intact — it must read as failed, not as a successful refresh.
    expect(refreshTerminalState(false, "partial", PROGRESS)).toBe("failed");
    expect(refreshTerminalState(false, "failed", PROGRESS)).toBe("failed");
    expect(refreshTerminalState(false, "cancelled", PROGRESS)).toBe("failed");
    expect(refreshTerminalState(false, "unchanged", PROGRESS)).toBe("failed");
  });
});

describe("createTerminalState", () => {
  it("is succeeded only when at least one document's vectors were persisted", () => {
    expect(createTerminalState(PROGRESS)).toBe("succeeded");
  });

  // Audit regression (0.3.0): a partially crawled / partially indexed import persisted SOME vectors,
  // so the terminal state was "succeeded" and the UI showed its success message — while pages of the
  // approved manual had been skipped or had failed to index. A usable-but-incomplete pod is neither a
  // success nor a failure; it is `partial`, and the operator has to be told so.
  it("is partial when a usable pod exists but the import did not cover the whole manual", () => {
    expect(
      createTerminalState({
        ...PROGRESS,
        phase: "degraded",
        indexing: {
          status: "succeeded",
          totalDocuments: 4,
          processedDocuments: 3,
          failedDocuments: 1,
          skippedDocuments: 0,
          vectorsPersisted: 6,
        },
      }),
    ).toBe("partial");
  });

  it("is failed when nothing was indexed or the index persisted no vectors", () => {
    expect(createTerminalState({ ...PROGRESS, indexing: null })).toBe("failed");
    expect(
      createTerminalState({
        ...PROGRESS,
        phase: "degraded",
        indexing: {
          status: "failed",
          totalDocuments: 2,
          processedDocuments: 2,
          failedDocuments: 2,
          skippedDocuments: 0,
          vectorsPersisted: 0,
        },
      }),
    ).toBe("failed");
  });
});

describe("buildHttpManualSource", () => {
  it("builds a valid http manual source from an approved origin + path prefix", () => {
    const built = buildHttpManualSource({
      displayName: "Ops",
      origin: "https://manual.example.com",
      pathPrefix: "/docs/",
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.source.scope).toEqual({
        kind: "html-manual-http",
        origin: "https://manual.example.com",
        pathPrefix: "/docs/",
      });
      expect(built.source.proposedPodName).toBe("Ops");
    }
  });
});

describe("startManualPodRefresh (injected seams)", () => {
  it("registers a running job and executes the injected run", async () => {
    const run = vi.fn().mockResolvedValue({ progress: PROGRESS, state: "succeeded" });
    const result = startManualPodRefresh(
      {} as UiHandlerDeps,
      { capsuleId: "cap", sourceId: "src" },
      { context: stubContext(), run },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job.state).toBe("running");
      await flush();
      expect(run).toHaveBeenCalledTimes(1);
      expect(getManualPodJob(result.job.jobId)?.state).toBe("succeeded");
    }
  });

  // LK-003 (Epic #189): the general reindex/repair paths already refuse a second concurrent
  // indexer for the same capsule (local-knowledge-handlers.ts, local-knowledge-remediation.ts). The
  // manual create/refresh trigger shared the same `indexing_jobs` table but never checked it, so a
  // double-click, a reload-and-retry, or a general reindex from another tab could race an in-flight
  // manual refresh and silently corrupt the persisted fingerprint baseline (last-writer-wins, no
  // version check). This must fail closed with no second job ever starting.
  it("refuses to start when a job is already running for the capsule (LK-003)", () => {
    const run = vi.fn().mockResolvedValue({ progress: PROGRESS, state: "succeeded" });
    const conflictContext = stubContext("already-running-job");
    const result = startManualPodRefresh(
      {} as UiHandlerDeps,
      { capsuleId: "cap", sourceId: "src" },
      { context: conflictContext, run },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("job-already-running");
    expect(run).not.toHaveBeenCalled();
    // The conflict path opened no background job, so nothing else will ever close this store —
    // the guard itself must close it, or the store handle leaks on every refused refresh.
    expect(conflictContext.env.close).toHaveBeenCalledTimes(1);
  });

  it("closes the store when the LK-003 running-job query itself throws", () => {
    const run = vi.fn();
    const throwingContext = stubContextWithThrowingQuery();
    expect(() =>
      startManualPodRefresh(
        {} as UiHandlerDeps,
        { capsuleId: "cap", sourceId: "src" },
        { context: throwingContext, run },
      ),
    ).toThrow("db unavailable");
    expect(run).not.toHaveBeenCalled();
    expect(throwingContext.env.close).toHaveBeenCalledTimes(1);
  });
});

describe("startManualPodCreate (injected seams)", () => {
  it("rejects an invalid source before starting a job", async () => {
    // A create request whose derived source cannot be validated fails closed as invalid-source.
    const result = await startManualPodCreate(
      {} as UiHandlerDeps,
      { displayName: "", origin: "not-a-url", pathPrefix: null },
      { context: stubContext(), run: vi.fn(), identity: {} as never },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-source");
  });

  it("registers a running create job and executes the injected run", async () => {
    const run = vi.fn().mockResolvedValue({ progress: PROGRESS, state: "succeeded" });
    const result = await startManualPodCreate(
      {} as UiHandlerDeps,
      { displayName: "Ops", origin: "https://manual.example.com", pathPrefix: null },
      { context: stubContext(), run, identity: {} as never },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job.operation).toBe("create");
      await flush();
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
});

describe("startManualPodRefresh (real-deps context resolution)", () => {
  it("returns no-embedding-model when no embedding model is configured", () => {
    // No gateway config -> createEmbeddingAdapter yields a RouteResult -> openManualEnv is undefined.
    const result = startManualPodRefresh({ config: undefined } as unknown as UiHandlerDeps, {
      capsuleId: "cap",
      sourceId: "src",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-embedding-model");
  });
});
