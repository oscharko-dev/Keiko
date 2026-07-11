// Redacted change-summary computation for an HTML Manual Knowledge Pod refresh (Epic #1856,
// Issue #1892).
//
// Pure projection: it diffs the previous crawl run's per-page fingerprints against the new run and
// combines that with the crawl deny tally and the indexing counters to produce the body-free
// `ManualRefreshChangeSummary` contract (counts + reason codes + an opaque crawl-run fingerprint).
// No raw page path, URL, body, or diagnostic string ever appears — only the redaction-safe contract
// fields. Added/changed/removed counts and removal detection are reported as not-evaluated/zero
// whenever the refresh did not apply (a limit-reached, empty, or cancelled crawl): the crawl's page
// set in that case is truncated, partial, or absent, not the pod's new state, so a diff against it
// cannot distinguish "removed/changed upstream" from "not part of this run".

import {
  HTML_MANUAL_REFRESH_SCHEMA_VERSION,
  type HtmlManualSourceKind,
  type ManualRefreshChangeCounts,
  type ManualRefreshChangeSummary,
  type ManualRefreshOutcome,
  type ManualRefreshReasonCode,
  type ManualRefreshRemovalDetection,
} from "@oscharko-dev/keiko-contracts";

import type { ManualCrawlDenyReason, ManualCrawlResult } from "./crawl/index.js";
import { diffFingerprintSets, type FingerprintSetDelta } from "./fingerprint-diff.js";
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

type PageDelta = FingerprintSetDelta;

// Delegates to the SHARED fingerprint-diff engine (`fingerprint-diff.ts`) — the same
// implementation the connector sync lane uses with `detectMoves: false` (Issue #2242). Manual
// pages are keyed by resolved paths, so move detection stays on here.
function diffPages(
  prior: ReadonlyMap<string, ManualPageFingerprint>,
  newPages: readonly ManualPageFingerprint[],
): PageDelta {
  const priorByPath = new Map<string, string>();
  for (const [path, fingerprint] of prior) {
    priorByPath.set(path, fingerprint.contentFingerprint);
  }
  const nextByPath = new Map<string, string>();
  for (const page of newPages) {
    nextByPath.set(page.relativePath, page.contentFingerprint);
  }
  return diffFingerprintSets(priorByPath, nextByPath, { detectMoves: true });
}

// Crawl-runtime bookkeeping entries tallied when the crawl loop stops because it hit a governed
// page/byte/time budget (crawl-runner.ts's `exhaustedBudgetReason`). Each one fires at most once
// per crawl and marks *where the loop stopped*, not a link-level scope or safety refusal — folding
// it into the same tally as real denials (cross-origin, credentialed-url, non-html, …) would make a
// budget-limited crawl with zero actual scope violations report "links were denied".
const BUDGET_EXHAUSTION_DENY_REASONS: ReadonlySet<ManualCrawlDenyReason> = new Set([
  "page-limit",
  "byte-budget",
  "time-limit",
]);

function removalDetectionFor(applied: boolean): ManualRefreshRemovalDetection {
  // Removal is only evaluable against a page set that was actually applied to the pod: a
  // limit-reached crawl is truncated by a budget, and an empty or cancelled crawl was never applied
  // at all (manual-pod-refresh.ts's `shouldApply` requires a completed, non-empty crawl) — in every
  // one of those cases the crawl's page set does not represent the pod's current content, so a diff
  // against it cannot tell "removed upstream" apart from "not part of this run".
  return applied ? "evaluated" : "not-evaluated-page-limit";
}

function deniedLinkCount(crawl: ManualCrawlResult): number {
  return crawl.denied
    .filter((tally) => !BUDGET_EXHAUSTION_DENY_REASONS.has(tally.reason))
    .reduce((total, tally) => total + tally.count, 0);
}

function countsFor(
  delta: PageDelta,
  crawl: ManualCrawlResult,
  indexing: IndexingResult | undefined,
  applied: boolean,
): ManualRefreshChangeCounts {
  // A refresh that never applied never touched the pod's indexed content: the crawl's page set is
  // partial or absent, not the pod's new state, so an added/changed/removed diff against it would
  // claim indexing or removal that did not happen. Report 0 for all three and let the outcome +
  // reason codes carry the "not applied" signal instead of an inaccurate count.
  const appliedDelta = applied
    ? delta
    : { added: 0, changed: 0, removed: 0, moved: 0, unchanged: delta.unchanged };
  return {
    addedPages: appliedDelta.added,
    changedPages: appliedDelta.changed,
    removedPages: appliedDelta.removed,
    movedPages: appliedDelta.moved,
    unchangedPages: appliedDelta.unchanged,
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
  if (counts.addedPages + counts.changedPages + counts.removedPages + counts.movedPages === 0) {
    return "unchanged";
  }
  return "updated";
}

function scopeReasonCodes(
  input: ManualRefreshChangeInput,
  codes: Set<ManualRefreshReasonCode>,
): void {
  // Scope preservation is the headline governance guarantee of every refresh: the scope + limits are
  // always reconstructed from persisted approved state, never widened.
  codes.add("scope-preserved");
  if (input.crawl.status === "limit-reached") {
    // "removal-detection-skipped" guidance text specifically says the crawl reached its page limit
    // (see MANUAL_REFRESH_REASON_GUIDANCE), so it is only fired for that exact status — an empty or
    // cancelled crawl is also not-applied (see `removalDetectionFor`), but for a different reason,
    // and already gets its own accurate "crawl-empty"/"crawl-cancelled" code from
    // `statusReasonCodes`.
    codes.add("scope-limit-reached");
    codes.add("removal-detection-skipped");
  }
}

function countReasonCodes(
  counts: ManualRefreshChangeCounts,
  codes: Set<ManualRefreshReasonCode>,
): void {
  if (counts.addedPages > 0) codes.add("pages-added");
  if (counts.changedPages > 0) codes.add("pages-changed");
  if (counts.removedPages > 0) codes.add("pages-removed");
  if (counts.movedPages > 0) codes.add("pages-moved");
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
): readonly ManualRefreshReasonCode[] {
  const codes = new Set<ManualRefreshReasonCode>();
  scopeReasonCodes(input, codes);
  countReasonCodes(counts, codes);
  statusReasonCodes(input, codes);
  return [...codes];
}

// Project a completed (or failed-closed) refresh run into the redacted change summary contract.
export function computeManualRefreshChangeSummary(
  input: ManualRefreshChangeInput,
): ManualRefreshChangeSummary {
  const removalDetection = removalDetectionFor(input.applied);
  const delta = diffPages(input.priorFingerprints, input.newPages);
  const counts = countsFor(delta, input.crawl, input.indexing, input.applied);
  return {
    schemaVersion: HTML_MANUAL_REFRESH_SCHEMA_VERSION,
    outcome: resolveOutcome(input, counts),
    sourceKind: input.sourceKind,
    counts,
    removalDetection,
    crawlRunFingerprint: computeManualCrawlRunFingerprint(input.newPages),
    reasonCodes: collectReasonCodes(input, counts),
    refreshedAt: input.refreshedAt,
  };
}
