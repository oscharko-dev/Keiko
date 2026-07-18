// Unit proof for the manual-pod job registry + body-free progress projection (Issue #2063). The
// background create/refresh runners compose already-tested domain functions; here we pin the pure
// orchestration: registry lifecycle, coarse live-progress event application, and the domain->wire
// projection (which must stay body-free).

import { describe, expect, it } from "vitest";
import type {
  HtmlManualIndexingProgress,
  ManualCrawlEvent,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  ManualPodJobRegistry,
  applyCrawlEvent,
  initialJob,
  projectJob,
} from "./manual-pod-service.js";

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
