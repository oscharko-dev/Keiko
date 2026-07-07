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

  it("does not report removals, additions, or changes when the crawl reached its limit", () => {
    const prior = priorMap(
      page("index.html", "a"),
      page("guide.html", "c"),
      page("gone.html", "z"),
    );
    // "index.html" is unchanged, "guide.html" would look changed, and "brand-new.html" would look
    // added if the diff were taken at face value — but a limit-reached crawl is never applied
    // (manual-pod-refresh.ts's `shouldApply`), so none of that partial page set is the pod's new
    // state.
    const newPages = [
      page("index.html", "a"),
      page("guide.html", "c2"),
      page("brand-new.html", "d"),
    ];
    const summary = computeManualRefreshChangeSummary({
      priorFingerprints: prior,
      newPages,
      crawl: crawlResult("limit-reached", newPages),
      indexing: undefined,
      sourceKind: "html-manual-http",
      applied: false,
      refreshedAt: 1,
    });
    // Two prior pages are absent and one page looks new/changed, but a truncated, unapplied crawl
    // cannot claim any of that as real pod change.
    expect(summary.counts).toStrictEqual({
      addedPages: 0,
      changedPages: 0,
      removedPages: 0,
      unchangedPages: 1,
      failedPages: 0,
      deniedLinks: 0,
    });
    expect(summary.removalDetection).toBe("not-evaluated-page-limit");
    expect(summary.outcome).toBe("partial");
    expect(summary.reasonCodes).toContain("scope-limit-reached");
    expect(summary.reasonCodes).toContain("removal-detection-skipped");
    expect(summary.reasonCodes).not.toContain("pages-added");
    expect(summary.reasonCodes).not.toContain("pages-changed");
    expect(summary.reasonCodes).not.toContain("pages-removed");
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

  it("reports cancelled without claiming any change, including no false page removal", () => {
    // Three pages were previously fingerprinted; a cancelled crawl produces no new page set at all.
    // manual-pod-refresh.ts's `shouldApply` never applies a cancelled crawl, so a naive diff against
    // an empty `newPages` would claim all three prior pages were removed from the pod.
    const prior = priorMap(page("index.html", "a"), page("guide.html", "c"), page("old.html", "b"));
    const summary = computeManualRefreshChangeSummary({
      priorFingerprints: prior,
      newPages: [],
      crawl: crawlResult("cancelled", []),
      indexing: undefined,
      sourceKind: "html-manual-http",
      applied: false,
      refreshedAt: 1,
    });
    expect(summary.outcome).toBe("cancelled");
    expect(summary.reasonCodes).toContain("crawl-cancelled");
    // Nothing was applied, so the pod's page set is unchanged: no removal, addition, or change may
    // be claimed, and the false-positive "pages-removed" code must not fire.
    expect(summary.counts).toStrictEqual({
      addedPages: 0,
      changedPages: 0,
      removedPages: 0,
      unchangedPages: 0,
      failedPages: 0,
      deniedLinks: 0,
    });
    expect(summary.reasonCodes).not.toContain("pages-removed");
    expect(summary.reasonCodes).not.toContain("pages-added");
    expect(summary.reasonCodes).not.toContain("pages-changed");
    // The "reached its page limit" guidance is specific to a limit-reached crawl; a cancelled crawl
    // must not fire it even though removal detection was equally skipped.
    expect(summary.reasonCodes).not.toContain("removal-detection-skipped");
    expect(summary.removalDetection).toBe("not-evaluated-page-limit");
  });

  it("reports an empty crawl without claiming any prior page was removed", () => {
    // An empty crawl (e.g. every fetch failed) is never applied either, and its `newPages` is also
    // empty — the same false-mass-removal shape as a cancelled crawl, but reached via a different
    // crawl status.
    const prior = priorMap(page("index.html", "a"), page("guide.html", "c"), page("old.html", "b"));
    const summary = computeManualRefreshChangeSummary({
      priorFingerprints: prior,
      newPages: [],
      crawl: crawlResult("empty", []),
      indexing: undefined,
      sourceKind: "html-manual-http",
      applied: false,
      refreshedAt: 1,
    });
    expect(summary.outcome).toBe("failed");
    expect(summary.reasonCodes).toContain("crawl-empty");
    expect(summary.counts).toStrictEqual({
      addedPages: 0,
      changedPages: 0,
      removedPages: 0,
      unchangedPages: 0,
      failedPages: 0,
      deniedLinks: 0,
    });
    expect(summary.reasonCodes).not.toContain("pages-removed");
    expect(summary.removalDetection).toBe("not-evaluated-page-limit");
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

  it("excludes budget-exhaustion bookkeeping entries from the denied-link count", () => {
    // crawl-runner.ts tallies "page-limit"/"byte-budget"/"time-limit" once whenever the crawl loop
    // stops on a governed bound — it is loop-termination bookkeeping, not a real scope/safety
    // denial, and must not inflate deniedLinks or fire the scope-safety "links-denied" code.
    const pages = [page("index.html", "a"), page("guide.html", "b")];
    const summary = computeManualRefreshChangeSummary({
      priorFingerprints: priorMap(...pages),
      newPages: pages,
      crawl: crawlResult("limit-reached", pages, [{ reason: "page-limit", count: 1 }]),
      indexing: undefined,
      sourceKind: "html-manual-http",
      applied: false,
      refreshedAt: 1,
    });
    expect(summary.counts.deniedLinks).toBe(0);
    expect(summary.reasonCodes).not.toContain("links-denied");
  });

  it("still counts real denials alongside a budget-exhaustion bookkeeping entry", () => {
    const pages = [page("index.html", "a")];
    const summary = computeManualRefreshChangeSummary({
      priorFingerprints: priorMap(...pages),
      newPages: pages,
      crawl: crawlResult("limit-reached", pages, [
        { reason: "page-limit", count: 1 },
        { reason: "cross-origin", count: 2 },
      ]),
      indexing: undefined,
      sourceKind: "html-manual-http",
      applied: false,
      refreshedAt: 1,
    });
    expect(summary.counts.deniedLinks).toBe(2);
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
