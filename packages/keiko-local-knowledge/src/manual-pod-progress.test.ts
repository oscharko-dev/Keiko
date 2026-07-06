import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";
import type {
  ManualCrawlDeniedTally,
  ManualCrawlResult,
  ManualCrawlStatus,
} from "./crawl/index.js";
import type { IndexingResult } from "./indexing/index.js";
import { buildHtmlManualIndexingProgress } from "./manual-pod-progress.js";

function crawlResult(
  status: ManualCrawlStatus,
  denied: readonly ManualCrawlDeniedTally[] = [],
  accepted = 3,
): ManualCrawlResult {
  const deniedCount = denied.reduce((sum, tally) => sum + tally.count, 0);
  return {
    status,
    pages: [],
    denied,
    stats: {
      discovered: accepted + deniedCount,
      fetched: accepted,
      accepted,
      deniedCount,
      bytesFetched: 4096,
    },
  };
}

function indexingResult(overrides: Partial<IndexingResult> = {}): IndexingResult {
  return {
    jobId: "job-1",
    capsuleId: "cap-1" as KnowledgeCapsuleId,
    status: "succeeded",
    totalDocuments: 3,
    processedDocuments: 3,
    failedDocuments: 0,
    skippedDocuments: 0,
    vectorsPersisted: 6,
    startedAt: 0,
    finishedAt: 1,
    ...overrides,
  };
}

describe("buildHtmlManualIndexingProgress", () => {
  it("reports a fully indexed manual as ready with safe counts", () => {
    const progress = buildHtmlManualIndexingProgress(crawlResult("completed"), indexingResult());
    expect(progress.phase).toBe("ready");
    expect(progress.indexing).toMatchObject({ processedDocuments: 3, vectorsPersisted: 6 });
    expect(progress.crawl.accepted).toBe(3);
    expect(progress.remediations).toEqual([]);
  });

  it("surfaces remediation guidance for denied-link reason codes only", () => {
    const progress = buildHtmlManualIndexingProgress(
      crawlResult("completed", [
        { reason: "cross-origin", count: 2 },
        { reason: "action-link", count: 1 },
      ]),
      indexingResult(),
    );
    const reasons = progress.remediations.map((entry) => entry.reason);
    expect(reasons).toContain("cross-origin");
    expect(reasons).toContain("action-link");
    expect(progress.deniedLinks).toHaveLength(2);
  });

  it("reports a cancelled crawl as cancelled, never ready", () => {
    const progress = buildHtmlManualIndexingProgress(crawlResult("cancelled"));
    expect(progress.phase).toBe("cancelled");
    expect(progress.indexing).toBeNull();
  });

  it("reports partial indexing failure as degraded, not ready", () => {
    const progress = buildHtmlManualIndexingProgress(
      crawlResult("completed"),
      indexingResult({ status: "succeeded", processedDocuments: 2, failedDocuments: 1 }),
    );
    expect(progress.phase).toBe("degraded");
  });

  it("reports an empty crawl as empty", () => {
    const progress = buildHtmlManualIndexingProgress(crawlResult("empty", [], 0));
    expect(progress.phase).toBe("empty");
  });

  it("maps an indexing policy denial to remediation guidance", () => {
    const progress = buildHtmlManualIndexingProgress(
      crawlResult("completed"),
      indexingResult({
        status: "failed",
        processedDocuments: 0,
        failedDocuments: 0,
        vectorsPersisted: 0,
        lastError: { code: "POLICY_DENIED", message: "denied" },
      }),
    );
    expect(progress.phase).toBe("degraded");
    expect(progress.remediations.map((entry) => entry.reason)).toContain("POLICY_DENIED");
  });

  it("keeps the progress projection body-free", () => {
    const progress = buildHtmlManualIndexingProgress(
      crawlResult("completed", [{ reason: "path-traversal", count: 1 }]),
      indexingResult(),
    );
    const serialized = JSON.stringify(progress);
    expect(serialized).not.toMatch(/https?:\/\//u);
    expect(serialized).not.toMatch(/\/(?:keiko|Users|home|var|etc)/u);
    expect(serialized).not.toContain("<");
  });
});
