// Unit tests for the pure refresh change-summary projection (Epic #1856, Issue #1892).

import { describe, expect, it } from "vitest";

import { validateManualRefreshChangeSummary } from "@oscharko-dev/keiko-contracts";

import type {
  ManualCrawlDeniedTally,
  ManualCrawlResult,
  ManualCrawlStatus,
} from "./crawl/index.js";
import type { IndexingResult } from "./indexing/index.js";
import { computeManualRefreshChangeSummary } from "./manual-refresh-change-summary.js";
import type { ManualPageFingerprint } from "./manual-page-fingerprints.js";

function page(relativePath: string, fingerprint: string): ManualPageFingerprint {
  return { relativePath, contentFingerprint: `sha256:${fingerprint}`, byteLength: 10 };
}

function priorMap(...pages: ManualPageFingerprint[]): ReadonlyMap<string, ManualPageFingerprint> {
  return new Map(pages.map((entry) => [entry.relativePath, entry]));
}

function crawlResult(
  status: ManualCrawlStatus,
  pages: readonly ManualPageFingerprint[],
  denied: readonly ManualCrawlDeniedTally[] = [],
): ManualCrawlResult {
  return {
    status,
    pages: pages.map((fingerprint) => ({
      canonicalKey: fingerprint.relativePath,
      relativePath: fingerprint.relativePath,
      bytes: new Uint8Array(),
      contentType: "text/html",
      depth: 0,
      title: null,
    })),
    denied,
    stats: {
      discovered: pages.length,
      fetched: pages.length,
      accepted: pages.length,
      deniedCount: denied.reduce((total, tally) => total + tally.count, 0),
      bytesFetched: 0,
    },
  };
}

function indexingResult(overrides: Partial<IndexingResult> = {}): IndexingResult {
  return {
    jobId: "job-1",
    capsuleId: "cap-1" as IndexingResult["capsuleId"],
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

describe("computeManualRefreshChangeSummary", () => {
  it("classifies added, changed, removed, and unchanged pages against the prior fingerprints", () => {
    const prior = priorMap(page("index.html", "a"), page("old.html", "b"), page("guide.html", "c"));
    const newPages = [page("index.html", "a"), page("guide.html", "c2"), page("new.html", "d")];
    const summary = computeManualRefreshChangeSummary({
      priorFingerprints: prior,
      newPages,
      crawl: crawlResult("completed", newPages),
      indexing: indexingResult(),
      sourceKind: "html-manual-http",
      applied: true,
      refreshedAt: 1000,
    });

    expect(summary.counts).toStrictEqual({
      addedPages: 1,
      changedPages: 1,
      removedPages: 1,
      unchangedPages: 1,
      failedPages: 0,
      deniedLinks: 0,
    });
    expect(summary.outcome).toBe("updated");
    expect(summary.removalDetection).toBe("evaluated");
    expect([...summary.reasonCodes].sort()).toStrictEqual([
      "pages-added",
      "pages-changed",
      "pages-removed",
      "scope-preserved",
    ]);
    expect(validateManualRefreshChangeSummary(summary).ok).toBe(true);
  });

  it("reports unchanged when nothing changed", () => {
    const pages = [page("index.html", "a"), page("guide.html", "c")];
    const summary = computeManualRefreshChangeSummary({
      priorFingerprints: priorMap(...pages),
      newPages: pages,
      crawl: crawlResult("completed", pages),
      indexing: indexingResult({ skippedDocuments: 2 }),
      sourceKind: "html-manual-local",
      applied: true,
      refreshedAt: 1,
    });
    expect(summary.outcome).toBe("unchanged");
    expect(summary.counts.unchangedPages).toBe(2);
    expect(summary.reasonCodes).toStrictEqual(["scope-preserved"]);
  });

  it("does not report removals and flags detection-skipped when the crawl reached its limit", () => {
    const prior = priorMap(
      page("index.html", "a"),
      page("guide.html", "c"),
      page("gone.html", "z"),
    );
    const newPages = [page("index.html", "a")];
    const summary = computeManualRefreshChangeSummary({
      priorFingerprints: prior,
      newPages,
      crawl: crawlResult("limit-reached", newPages),
      indexing: undefined,
      sourceKind: "html-manual-http",
      applied: false,
      refreshedAt: 1,
    });
    // Two prior pages are absent, but a truncated crawl cannot claim they were removed.
    expect(summary.counts.removedPages).toBe(0);
    expect(summary.removalDetection).toBe("not-evaluated-page-limit");
    expect(summary.outcome).toBe("partial");
    expect(summary.reasonCodes).toContain("scope-limit-reached");
    expect(summary.reasonCodes).toContain("removal-detection-skipped");
  });

  it("marks the refresh partial when some pages failed to index", () => {
    const pages = [page("index.html", "a2")];
    const summary = computeManualRefreshChangeSummary({
      priorFingerprints: priorMap(page("index.html", "a")),
      newPages: pages,
      crawl: crawlResult("completed", pages),
      indexing: indexingResult({ failedDocuments: 1, status: "succeeded" }),
      sourceKind: "html-manual-http",
      applied: true,
      refreshedAt: 1,
    });
    expect(summary.outcome).toBe("partial");
    expect(summary.counts.failedPages).toBe(1);
    expect(summary.reasonCodes).toContain("pages-failed");
  });

  it("reports failed when indexing failed, and does not claim scope-preserved application", () => {
    const pages = [page("index.html", "a2")];
    const summary = computeManualRefreshChangeSummary({
      priorFingerprints: priorMap(page("index.html", "a")),
      newPages: pages,
      crawl: crawlResult("completed", pages),
      indexing: indexingResult({
        status: "failed",
        lastError: { code: "PERSISTENCE_FAILED", message: "x" },
      }),
      sourceKind: "html-manual-http",
      applied: true,
      refreshedAt: 1,
    });
    expect(summary.outcome).toBe("failed");
    expect(summary.reasonCodes).toContain("index-failed");
    // Scope preservation is the invariant of every refresh, even a failed one.
    expect(summary.reasonCodes).toContain("scope-preserved");
  });

  it("surfaces an embedding-incompatible refresh", () => {
    const pages = [page("index.html", "a2")];
    const summary = computeManualRefreshChangeSummary({
      priorFingerprints: priorMap(page("index.html", "a")),
      newPages: pages,
      crawl: crawlResult("completed", pages),
      indexing: indexingResult({
        status: "failed",
        lastError: { code: "INCOMPATIBLE_EMBEDDING_IDENTITY", message: "identity changed" },
      }),
      sourceKind: "html-manual-http",
      applied: true,
      refreshedAt: 1,
    });
    expect(summary.reasonCodes).toContain("embedding-incompatible");
    expect(summary.outcome).toBe("failed");
  });

  it("reports cancelled without claiming any change", () => {
    const summary = computeManualRefreshChangeSummary({
      priorFingerprints: priorMap(page("index.html", "a")),
      newPages: [],
      crawl: crawlResult("cancelled", []),
      indexing: undefined,
      sourceKind: "html-manual-http",
      applied: false,
      refreshedAt: 1,
    });
    expect(summary.outcome).toBe("cancelled");
    expect(summary.reasonCodes).toContain("crawl-cancelled");
  });

  it("counts denied links from the crawl deny tally", () => {
    const pages = [page("index.html", "a")];
    const summary = computeManualRefreshChangeSummary({
      priorFingerprints: priorMap(...pages),
      newPages: pages,
      crawl: crawlResult("completed", pages, [
        { reason: "cross-origin", count: 2 },
        { reason: "non-html", count: 1 },
      ]),
      indexing: indexingResult({ skippedDocuments: 1 }),
      sourceKind: "html-manual-http",
      applied: true,
      refreshedAt: 1,
    });
    expect(summary.counts.deniedLinks).toBe(3);
    expect(summary.reasonCodes).toContain("links-denied");
  });

  it("produces a validation-safe summary carrying no raw path or content", () => {
    const pages = [page("secret/private-page.html", "a")];
    const summary = computeManualRefreshChangeSummary({
      priorFingerprints: new Map(),
      newPages: pages,
      crawl: crawlResult("completed", pages),
      indexing: indexingResult({ totalDocuments: 1, processedDocuments: 1, vectorsPersisted: 2 }),
      sourceKind: "html-manual-local",
      applied: true,
      refreshedAt: 1,
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("secret/private-page.html");
    expect(serialized).not.toContain("private-page");
    expect(validateManualRefreshChangeSummary(summary).ok).toBe(true);
  });
});
