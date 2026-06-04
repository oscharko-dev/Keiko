// Conflict and multi-way-duplicate review-item emission. Pure function.
//
// Two emission cases, mutually exclusive per cluster:
//
//   1. multi-way-duplicate (cluster.members.length > 2): one ReviewItem proposing a `merge`
//      with the newest member as winner and all older members as losers. Multi-way
//      consolidation is always operator-reviewed; the engine never auto-merges three or more
//      records (loss of provenance lineage is too easy to do silently). Multi-way takes
//      PRECEDENCE over negation detection: a 3-member cluster with one negation is still
//      surfaced as multi-way, because the operator needs to disambiguate the polarity too.
//
//   2. potential-conflict (exactly 2 members AND opposite negation polarity): one ReviewItem
//      proposing a `supersede` with the newer record replacing the older one. v1 negation
//      detection is a substring check: a "negation marker" is " not " (with surrounding
//      spaces, so it does not match "another" or "annotation") or "n't " (English
//      contraction). The pair is in conflict when exactly ONE side carries a negation
//      marker — XOR. Same-polarity pairs (both negate or both affirm) are NOT conflicts.
//
// Two-member non-conflicting clusters produce NO review item from this layer — the
// orchestrator emits a `derived-from` edge instead.

import { compareReviewItems, compareRecordsByAge } from "./_ordering.js";
import type { DuplicateCluster } from "./dedupe.js";
import { normalizeBody } from "./similarity.js";
import type { ProposedAction, ReviewItem } from "./types.js";

export interface ConflictsOptions {
  readonly nowMs: number;
  readonly newReviewItemId: () => string;
}

// Negation markers checked AFTER normalizeBody (lowercased, punctuation removed). The
// surrounding spaces make the check whole-word: " not " inside the normalized body avoids
// "another"/"annotation"/"notation". "nt " (post-strip form of "n't") catches contractions
// like don't, won't, isn't, can't, didn't, etc.
const NEGATION_MARKERS: readonly string[] = [" not ", "nt "];

function hasNegation(body: string): boolean {
  // Pad both sides with a space so a marker that would normally be position-anchored (e.g.
  // body starts with "not ") is still detected by the same indexOf check.
  const padded = ` ${normalizeBody(body)} `;
  for (const marker of NEGATION_MARKERS) {
    if (padded.includes(marker)) return true;
  }
  return false;
}

function buildMultiWayItem(cluster: DuplicateCluster, options: ConflictsOptions): ReviewItem {
  const sorted = [...cluster.members].sort(compareRecordsByAge);
  const winner = sorted[sorted.length - 1];
  const losers = sorted.slice(0, -1);
  if (winner === undefined) {
    // Caller guards on cluster.members.length > 2; this branch is unreachable structurally.
    throw new Error("buildMultiWayItem: empty cluster (unreachable)");
  }
  const action: ProposedAction = {
    kind: "merge",
    winner: winner.id,
    losers: losers.map((m) => m.id),
  };
  return {
    id: options.newReviewItemId(),
    reason: "multi-way-duplicate",
    relatedMemoryIds: sorted.map((m) => m.id),
    proposedAction: action,
    detectedAt: options.nowMs,
  };
}

function isPolarityConflict(older: { body: string }, newer: { body: string }): boolean {
  return hasNegation(older.body) !== hasNegation(newer.body);
}

function tryBuildPairConflict(
  cluster: DuplicateCluster,
  options: ConflictsOptions,
): ReviewItem | null {
  if (cluster.members.length !== 2) return null;
  const sorted = [...cluster.members].sort(compareRecordsByAge);
  const older = sorted[0];
  const newer = sorted[1];
  if (older === undefined || newer === undefined) return null;
  if (!isPolarityConflict(older, newer)) return null;
  const action: ProposedAction = { kind: "supersede", newer: newer.id, older: older.id };
  return {
    id: options.newReviewItemId(),
    reason: "potential-conflict",
    relatedMemoryIds: [older.id, newer.id],
    proposedAction: action,
    detectedAt: options.nowMs,
  };
}

// Public entry. Returns review items sorted by (reason, related-ids, id) for byte-stable
// output. Multi-way takes precedence over per-cluster conflict detection (a 3-member cluster
// with mixed polarity surfaces as ONE multi-way item, not multi-way + conflict).
export function detectConflicts(
  clusters: readonly DuplicateCluster[],
  options: ConflictsOptions,
): readonly ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const cluster of clusters) {
    if (cluster.members.length > 2) {
      items.push(buildMultiWayItem(cluster, options));
      continue;
    }
    const pair = tryBuildPairConflict(cluster, options);
    if (pair !== null) items.push(pair);
  }
  return items.sort(compareReviewItems);
}
