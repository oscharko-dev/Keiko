// Conflict detection + status transitions.
//
// detectConflictPair — pure pairwise predicate over two MemoryRecords. The detection is
// deliberately narrow:
//
//   - "negation-flip"      one side carries a negation PARTICLE that the other does not, and
//                          the non-negated tokens otherwise align (Jaccard >= 0.4). The word
//                          list is not defined here: it is the "english-particle" tier of
//                          MEMORY_NEGATION_VOCABULARY in keiko-contracts, the same table the
//                          consolidation layer (#208 conflicts.ts) reads, so the two layers
//                          cannot drift apart. Matching is WHOLE-TOKEN over the normalized
//                          body — a word merely ending in "nt" ("important") is not a
//                          negation. This layer reads that tier ONLY: the negative
//                          quantifiers ("no", "never", "none", "without") and the German
//                          particles belong to consolidation's fused detector, because here
//                          a "no"/"false" flip is the separate "polarity-mismatch" reason
//                          below and folding it into negation would erase that distinction.
//   - "polarity-mismatch"  the bodies share the same subject (Jaccard >= 0.4) and one
//                          side has a "yes"/"true" affirmation marker while the other has
//                          a "no"/"false" denial marker. Distinct from negation: this is
//                          a vocabulary-level flip, not a grammatical-particle flip.
//   - "value-mismatch"     the records share scope AND type AND key tokens but resolve to
//                          different bodies entirely. This is the catch-all for "two
//                          decisions about the same thing that contradict structurally".
//                          Only fires when Jaccard is in [0.4, 0.85) — at >= 0.85 we let
//                          consolidation collapse the duplicates instead.
//
// The detection ORDER above is the precedence order: a pair that matches negation-flip
// is not also reported as value-mismatch.
//
// buildConflictTransitions — pure: takes a list of memories plus an explicit
// {winner, losers} resolution and emits a StatusTransition per loser plus a Supersession
// per loser linking loser→winner. Every transition is checked against
// MEMORY_STATUS_TRANSITIONS via the contracts `checkStatusTransition` helper; an illegal
// transition throws GovernanceError("illegal-status-transition") with the offending
// from/to pair in details.

import type {
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  MemorySupersession,
} from "@oscharko-dev/keiko-contracts/memory";
import {
  checkStatusTransition,
  hasMemoryNegationToken,
  memoryNegationTokens,
  validateMemorySupersession,
} from "@oscharko-dev/keiko-contracts/memory";

import { GovernanceError } from "./errors.js";
import type {
  ConflictPair,
  ConflictResolution,
  GovernanceContext,
  StatusTransition,
} from "./types.js";

// ─── Body-normalisation helpers (no regex, no external deps) ──────────────────
function mapCharToSafe(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  const isLetter = code >= 97 && code <= 122;
  const isDigit = code >= 48 && code <= 57;
  if (isLetter || isDigit) return ch;
  const isSpace = ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  return isSpace ? " " : "";
}

function collapseSpaces(input: string): string {
  let collapsed = "";
  let prevSpace = false;
  for (const ch of input) {
    const sp = ch === " ";
    if (sp && prevSpace) continue;
    collapsed += ch;
    prevSpace = sp;
  }
  return collapsed.trim();
}

function normalizeBody(body: string): string {
  let out = "";
  for (const ch of body.toLowerCase()) {
    out += mapCharToSafe(ch);
  }
  return collapseSpaces(out);
}

function tokenize(body: string): readonly string[] {
  const norm = normalizeBody(body);
  if (norm.length === 0) return [];
  return norm.split(" ");
}

// Exported for reuse by health-scan.ts (Issue #2129) — same partition key used by every pairwise
// memory scan in this package, kept as the single definition rather than a second copy.
export function scopeCoordinateKey(scope: MemoryScope): string {
  switch (scope.kind) {
    case "user":
      return `user:${scope.userId}`;
    case "workspace":
      return `workspace:${scope.workspaceId}`;
    case "project":
      return `project:${scope.projectId}`;
    case "workflow":
      return `workflow:${scope.workflowDefinitionId}`;
    case "global":
      return "global";
  }
}

// Exported for reuse by health-scan.ts (Issue #2129) — the missing-cross-reference detector needs
// the same body-similarity primitive; kept as the single definition rather than a second copy.
export function jaccardSimilarity(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 && bTokens.size === 0) return 1;
  let intersect = 0;
  for (const tok of aTokens) {
    if (bTokens.has(tok)) intersect += 1;
  }
  const union = aTokens.size + bTokens.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

// Exported for the drift guard in conflict.test.ts: the pin derives the tier this layer reads from
// the value the production code actually resolved, never from a second copy of the tier name.
export const GOVERNANCE_NEGATION_TIERS = ["english-particle"] as const;
const NEGATION_TOKENS = memoryNegationTokens(GOVERNANCE_NEGATION_TIERS);

function hasNegation(body: string): boolean {
  return hasMemoryNegationToken(tokenize(body), NEGATION_TOKENS);
}

const AFFIRM_MARKERS: readonly string[] = [" yes ", " true ", " correct ", " confirmed "];
const DENY_MARKERS: readonly string[] = [" no ", " false ", " wrong ", " denied "];
function hasAnyMarker(body: string, markers: readonly string[]): boolean {
  const padded = ` ${normalizeBody(body)} `;
  for (const marker of markers) {
    if (padded.includes(marker)) return true;
  }
  return false;
}

// ─── Detection thresholds ─────────────────────────────────────────────────────
const CONFLICT_OVERLAP_THRESHOLD = 0.4;
const DEDUP_OVERLAP_THRESHOLD = 0.85;

// ─── Pairwise conflict detection ──────────────────────────────────────────────
function differentScopeOrType(a: MemoryRecord, b: MemoryRecord): boolean {
  if (a.type !== b.type) return true;
  if (scopeCoordinateKey(a.scope) !== scopeCoordinateKey(b.scope)) return true;
  return false;
}

function classifyConflict(a: MemoryRecord, b: MemoryRecord): ConflictPair {
  if (differentScopeOrType(a, b)) return { hasConflict: false };
  const overlap = jaccardSimilarity(a.body, b.body);
  if (overlap < CONFLICT_OVERLAP_THRESHOLD) return { hasConflict: false };
  if (hasNegation(a.body) !== hasNegation(b.body)) {
    return { hasConflict: true, reason: "negation-flip" };
  }
  const aAffirm = hasAnyMarker(a.body, AFFIRM_MARKERS);
  const bAffirm = hasAnyMarker(b.body, AFFIRM_MARKERS);
  const aDeny = hasAnyMarker(a.body, DENY_MARKERS);
  const bDeny = hasAnyMarker(b.body, DENY_MARKERS);
  if ((aAffirm && bDeny) || (aDeny && bAffirm)) {
    return { hasConflict: true, reason: "polarity-mismatch" };
  }
  if (a.body !== b.body && overlap < DEDUP_OVERLAP_THRESHOLD) {
    return { hasConflict: true, reason: "value-mismatch" };
  }
  return { hasConflict: false };
}

export function detectConflictPair(a: MemoryRecord, b: MemoryRecord): ConflictPair {
  return classifyConflict(a, b);
}

// ─── Conflict resolution transitions + supersessions ──────────────────────────
function indexById(memories: readonly MemoryRecord[]): ReadonlyMap<MemoryId, MemoryRecord> {
  const map = new Map<MemoryId, MemoryRecord>();
  for (const m of memories) map.set(m.id, m);
  return map;
}

function assertResolutionWellFormed(
  resolution: ConflictResolution,
  index: ReadonlyMap<MemoryId, MemoryRecord>,
): void {
  if (resolution.losers.length === 0) {
    throw new GovernanceError("invalid-resolution", "losers list must be non-empty");
  }
  if (!index.has(resolution.winner)) {
    throw new GovernanceError("invalid-resolution", "winner is not in the conflicted set");
  }
  for (const loserId of resolution.losers) {
    if (loserId === resolution.winner) {
      throw new GovernanceError("invalid-resolution", "losers list must not contain the winner");
    }
    if (!index.has(loserId)) {
      throw new GovernanceError(
        "invalid-resolution",
        `loser ${loserId} is not in the conflicted set`,
      );
    }
  }
}

function buildLoserTransition(
  loser: MemoryRecord,
  nowMs: number,
  targetStatus: MemoryStatus,
): StatusTransition {
  const check = checkStatusTransition(loser.status, targetStatus);
  if (!check.ok) {
    throw new GovernanceError(
      "illegal-status-transition",
      check.reason ?? `illegal transition: ${loser.status} -> ${targetStatus}`,
      [`memoryId: ${loser.id}`, `from: ${loser.status}`, `to: ${targetStatus}`],
    );
  }
  return {
    memoryId: loser.id,
    from: loser.status,
    to: targetStatus,
    transitionedAt: nowMs,
  };
}

function buildLoserSupersession(
  loserId: MemoryId,
  winnerId: MemoryId,
  context: GovernanceContext,
): MemorySupersession {
  const env: MemorySupersession = {
    schemaVersion: "1",
    oldMemoryId: loserId,
    newMemoryId: winnerId,
    reviewerId: context.reviewerId,
    supersededAt: context.nowMs,
    reason: "conflict-resolution",
    edgeKind: "supersedes",
  };
  const v = validateMemorySupersession(env);
  if (!v.ok) {
    throw new GovernanceError(
      "envelope-validation-failed",
      "conflict supersession failed contracts validation",
      v.errors,
    );
  }
  return env;
}

export interface ConflictTransitionResult {
  readonly supersessions: readonly MemorySupersession[];
  readonly statusTransitions: readonly StatusTransition[];
}

export function buildConflictTransitions(
  conflictedMemories: readonly MemoryRecord[],
  resolution: ConflictResolution,
  context: GovernanceContext,
): ConflictTransitionResult {
  const index = indexById(conflictedMemories);
  assertResolutionWellFormed(resolution, index);
  const supersessions: MemorySupersession[] = [];
  const transitions: StatusTransition[] = [];
  for (const loserId of resolution.losers) {
    const loser = index.get(loserId);
    if (loser === undefined) {
      // Guarded by assertResolutionWellFormed above; the explicit branch satisfies
      // noUncheckedIndexedAccess without a non-null assertion.
      throw new GovernanceError("invalid-resolution", `loser ${loserId} missing after index`);
    }
    transitions.push(buildLoserTransition(loser, context.nowMs, "conflicted"));
    supersessions.push(buildLoserSupersession(loserId, resolution.winner, context));
  }
  return { supersessions, statusTransitions: transitions };
}
