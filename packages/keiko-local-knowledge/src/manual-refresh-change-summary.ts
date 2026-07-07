// Redacted change-summary computation for an HTML Manual Knowledge Pod refresh (Epic #1856,
// Issue #1892).
//
// Pure projection: it diffs the previous crawl run's per-page fingerprints against the new run and
// combines that with the crawl deny tally and the indexing counters to produce the body-free
// `ManualRefreshChangeSummary` contract (counts + reason codes + an opaque crawl-run fingerprint).
// No raw page path, URL, body, or diagnostic string ever appears — only the redaction-safe contract
// fields. Removal detection is reported as not-evaluated when the crawl reached its page/byte/depth
// limit, because a truncated crawl cannot distinguish "removed upstream" from "beyond the budget".

import {
  HTML_MANUAL_REFRESH_SCHEMA_VERSION,
  type HtmlManualSourceKind,
  type ManualRefreshChangeCounts,
  type ManualRefreshChangeSummary,
  type ManualRefreshOutcome,
  type ManualRefreshReasonCode,
  type ManualRefreshRemovalDetection,
} from "@oscharko-dev/keiko-contracts";

import type { ManualCrawlResult } from "./crawl/index.js";
import type { IndexingResult } from "./indexing/index.js";
import {
  computeManualCrawlRunFingerprint,
  type ManualPageFingerprint,
} from "./manual-page-fingerprints.js";

export interface ManualRefreshChangeInput {
  readonly priorFingerprints: ReadonlyMap<string, ManualPageFingerprint>;
  readonly newPages: readonly ManualPageFingerprint[];
  readonly crawl: ManualCrawlResult;
  // Absent when indexing did not run (an empty crawl, a cancelled crawl, or a limit-reached crawl
  // that was not applied).
  readonly indexing: IndexingResult | undefined;
  readonly sourceKind: HtmlManualSourceKind;
  // Whether the refresh ran its index apply path (update scope + re-index). False when it failed
  // closed before applying (a limit-reached, empty, or cancelled crawl).
  readonly applied: boolean;
  readonly refreshedAt: number;
}

interface PageDelta {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly unchanged: number;
}

function diffPages(
  prior: ReadonlyMap<string, ManualPageFingerprint>,
  newPages: readonly ManualPageFingerprint[],
): PageDelta {
  const newPaths = new Set<string>();
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const page of newPages) {
    newPaths.add(page.relativePath);
    const previous = prior.get(page.relativePath);
    if (previous === undefined) {
      added += 1;
    } else if (previous.contentFingerprint === page.contentFingerprint) {
      unchanged += 1;
    } else {
      changed += 1;
    }
  }
  let removed = 0;
  for (const path of prior.keys()) {
    if (!newPaths.has(path)) removed += 1;
  }
  return { added, changed, removed, unchanged };
}

function removalDetectionFor(crawl: ManualCrawlResult): ManualRefreshRemovalDetection {
  // A truncated crawl cannot tell "removed upstream" apart from "beyond the page/byte/depth budget".
  return crawl.status === "limit-reached" ? "not-evaluated-page-limit" : "evaluated";
}

function deniedLinkCount(crawl: ManualCrawlResult): number {
  return crawl.denied.reduce((total, tally) => total + tally.count, 0);
}

function countsFor(
  delta: PageDelta,
  crawl: ManualCrawlResult,
  indexing: IndexingResult | undefined,
  removalDetection: ManualRefreshRemovalDetection,
): ManualRefreshChangeCounts {
  // When removal detection is skipped we report 0 removed rather than under-reporting an uncertain
  // number; the removalDetection field and the reason code carry the "not evaluated" signal.
  const removedPages = removalDetection === "evaluated" ? delta.removed : 0;
  return {
    addedPages: delta.added,
    changedPages: delta.changed,
    removedPages,
    unchangedPages: delta.unchanged,
    failedPages: indexing?.failedDocuments ?? 0,
    deniedLinks: deniedLinkCount(crawl),
  };
}

function resolveOutcome(
  input: ManualRefreshChangeInput,
  counts: ManualRefreshChangeCounts,
): ManualRefreshOutcome {
  const { crawl, indexing, applied } = input;
  if (crawl.status === "cancelled" || indexing?.status === "cancelled") return "cancelled";
  if (!applied) return crawl.status === "limit-reached" ? "partial" : "failed";
  if (indexing === undefined || indexing.status === "failed") return "failed";
  if (counts.failedPages > 0) return "partial";
  if (counts.addedPages + counts.changedPages + counts.removedPages === 0) return "unchanged";
  return "updated";
}

function scopeReasonCodes(
  input: ManualRefreshChangeInput,
  removalDetection: ManualRefreshRemovalDetection,
  codes: Set<ManualRefreshReasonCode>,
): void {
  // Scope preservation is the headline governance guarantee of every refresh: the scope + limits are
  // always reconstructed from persisted approved state, never widened.
  codes.add("scope-preserved");
  if (input.crawl.status === "limit-reached") codes.add("scope-limit-reached");
  if (removalDetection === "not-evaluated-page-limit") codes.add("removal-detection-skipped");
}

function countReasonCodes(
  counts: ManualRefreshChangeCounts,
  codes: Set<ManualRefreshReasonCode>,
): void {
  if (counts.addedPages > 0) codes.add("pages-added");
  if (counts.changedPages > 0) codes.add("pages-changed");
  if (counts.removedPages > 0) codes.add("pages-removed");
  if (counts.failedPages > 0) codes.add("pages-failed");
  if (counts.deniedLinks > 0) codes.add("links-denied");
}

function statusReasonCodes(
  input: ManualRefreshChangeInput,
  codes: Set<ManualRefreshReasonCode>,
): void {
  const indexingStatus = input.indexing?.status;
  if (input.indexing?.lastError?.code === "INCOMPATIBLE_EMBEDDING_IDENTITY") {
    codes.add("embedding-incompatible");
  }
  if (input.crawl.status === "empty") codes.add("crawl-empty");
  if (input.crawl.status === "cancelled" || indexingStatus === "cancelled") {
    codes.add("crawl-cancelled");
  }
  if (input.applied && indexingStatus === "failed") codes.add("index-failed");
}

function collectReasonCodes(
  input: ManualRefreshChangeInput,
  counts: ManualRefreshChangeCounts,
  removalDetection: ManualRefreshRemovalDetection,
): readonly ManualRefreshReasonCode[] {
  const codes = new Set<ManualRefreshReasonCode>();
  scopeReasonCodes(input, removalDetection, codes);
  countReasonCodes(counts, codes);
  statusReasonCodes(input, codes);
  return [...codes];
}

// Project a completed (or failed-closed) refresh run into the redacted change summary contract.
export function computeManualRefreshChangeSummary(
  input: ManualRefreshChangeInput,
): ManualRefreshChangeSummary {
  const removalDetection = removalDetectionFor(input.crawl);
  const delta = diffPages(input.priorFingerprints, input.newPages);
  const counts = countsFor(delta, input.crawl, input.indexing, removalDetection);
  return {
    schemaVersion: HTML_MANUAL_REFRESH_SCHEMA_VERSION,
    outcome: resolveOutcome(input, counts),
    sourceKind: input.sourceKind,
    counts,
    removalDetection,
    crawlRunFingerprint: computeManualCrawlRunFingerprint(input.newPages),
    reasonCodes: collectReasonCodes(input, counts, removalDetection),
    refreshedAt: input.refreshedAt,
  };
}
