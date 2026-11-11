// Standing profile selection (MemoriaViva 1.5, #4228).
//
// A small, bounded set of the person's standing facts is supplied with every Chat answer,
// independently of the question. Retrieval by relevance decides everything else. Membership is
// deterministic and needs no model: the person's own private preferences and procedures, the facts
// capture marked as standing (role, language, a standing constraint), ordered by how often the person confirmed them and then by how recently they were stated (a
// supersession inserts a new record, so its creation time is the statement's recency). A pinned
// fact always competes for a place; a fact the person removed from the profile carries
// PROFILE_EXCLUDED_MEMORY_TAG and stays out until pinned again. The profile does not decay: it changes only through supersession,
// forgetting, pinning and unpinning.
//
// Pure: no IO and no clock. The caller supplies the candidates, their confirmation counts and nowMs.

import {
  PROFILE_EXCLUDED_MEMORY_TAG,
  STANDING_FACT_RETENTION_POLICY_KEY,
  type MemoryId,
  type MemoryRecord,
  type MemoryType,
} from "@oscharko-dev/keiko-contracts/memory";

import { clipToTokenBudget, estimateTokens } from "./context.js";
import { isMemorySuppressed } from "./suppression.js";
import { DEFAULT_STALE_CONFIDENCE_THRESHOLD } from "./types.js";

// Record types that describe how the person works: format and way of working. Other facts about
// the person enter when capture marked them standing or the person pinned them: taking every fact
// would supply a small vault whole to every answer, which is what retrieval by relevance is for.
export const STANDING_PROFILE_TYPES: readonly MemoryType[] = Object.freeze([
  "preference",
  "procedural",
]);

export interface StandingProfileCaps {
  /** Most entries the profile holds. */
  readonly maxEntries: number;
  /** Most tokens all entries together may cost. */
  readonly maxTokens: number;
  /** Most tokens one entry may cost; a longer fact is clipped. */
  readonly entryMaxTokens: number;
}

// Provisional caps, small enough that the profile reads in one glance. Lab measurement of answer
// accuracy against over-application sets the final values (#4228); they are not guessed again.
export const DEFAULT_STANDING_PROFILE_CAPS: StandingProfileCaps = Object.freeze({
  maxEntries: 8,
  maxTokens: 200,
  entryMaxTokens: 40,
});

export interface StandingProfileCandidate {
  readonly record: MemoryRecord;
  /** How often the person stated the fact again; 0 when never confirmed. */
  readonly confirmations: number;
}

export interface StandingProfileEntry {
  readonly id: MemoryId;
  readonly type: MemoryType;
  readonly text: string;
  readonly tokens: number;
  readonly pinned: boolean;
}

export type StandingProfileDropReason =
  | "not-private"
  | "not-standing-type"
  | "not-accepted"
  | "not-public"
  | "suppressed"
  | "excluded"
  | "empty"
  | "entry-cap"
  | "token-cap";

export interface StandingProfile {
  readonly entries: readonly StandingProfileEntry[];
  readonly tokens: number;
  readonly dropped: Readonly<Partial<Record<StandingProfileDropReason, number>>>;
}

/**
 * The profile one answer receives once recall supplied some of its facts. A fact the question is
 * about reaches the answer once, in the question's own memory context, and leaves the profile for
 * this answer: a model applies a fact there more reliably than a background profile line it is told
 * not to mention unprompted (lab 2026-11-11, Gemma: "Wie sollst du mir Zahlen zeigen?" missed a
 * profile-only preference in two of three runs). Facts recall did not supply stay where they are.
 */
export function standingProfileWithout(
  profile: StandingProfile,
  retrievedIds: ReadonlySet<MemoryId>,
): StandingProfile {
  const entries = profile.entries.filter((entry) => !retrievedIds.has(entry.id));
  if (entries.length === profile.entries.length) return profile;
  const tokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  return { entries, tokens, dropped: profile.dropped };
}

/** A fact of a standing type, or one capture marked standing. Pinning is checked separately. */
export function isStandingFact(record: MemoryRecord): boolean {
  return (
    STANDING_PROFILE_TYPES.includes(record.type) ||
    record.retentionHint?.policyKey === STANDING_FACT_RETENTION_POLICY_KEY
  );
}

/**
 * What a fact that supersedes another takes over from it, so a correction keeps the corrected
 * fact's place in the standing profile (or its removal from it). A pinned or standing origin marks
 * the successor standing; an origin the person removed from the profile passes the removal on.
 */
export function standingProfileSuccession(
  origin: MemoryRecord,
  successor: Pick<MemoryRecord, "tags" | "retentionHint">,
): Pick<Partial<MemoryRecord>, "tags" | "retentionHint"> {
  const standing = origin.pinned || isStandingFact(origin);
  const markStanding = standing && successor.retentionHint === undefined;
  const removed =
    origin.tags.includes(PROFILE_EXCLUDED_MEMORY_TAG) &&
    !successor.tags.includes(PROFILE_EXCLUDED_MEMORY_TAG);
  return {
    ...(markStanding ? { retentionHint: { policyKey: STANDING_FACT_RETENTION_POLICY_KEY } } : {}),
    ...(removed ? { tags: [...successor.tags, PROFILE_EXCLUDED_MEMORY_TAG] } : {}),
  };
}

function ineligibility(
  candidate: StandingProfileCandidate,
  nowMs: number,
  staleConfidenceThreshold: number,
): StandingProfileDropReason | undefined {
  const { record } = candidate;
  if (record.scope.kind !== "user") return "not-private";
  if (record.status !== "accepted") return "not-accepted";
  // A confidential or restricted fact never rides along with every answer, pinned or not.
  if (record.provenance.sensitivity !== "public") return "not-public";
  if (isMemorySuppressed(record, nowMs, staleConfidenceThreshold).suppressed) return "suppressed";
  if (record.pinned) return undefined;
  if (!isStandingFact(record)) return "not-standing-type";
  if (record.tags.includes(PROFILE_EXCLUDED_MEMORY_TAG)) return "excluded";
  return undefined;
}

/** The fields that order the standing profile; also enough to order vault metadata before reads. */
export interface StandingProfileOrderKey {
  readonly id: MemoryId;
  readonly pinned: boolean;
  readonly confirmations: number;
  readonly createdAt: number;
}

/** Pinned first, then more confirmations, then the newest statement, then the id. */
export function compareStandingProfileOrder(
  a: StandingProfileOrderKey,
  b: StandingProfileOrderKey,
): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.confirmations !== b.confirmations) return b.confirmations - a.confirmations;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function orderKey(candidate: StandingProfileCandidate): StandingProfileOrderKey {
  const { id, pinned, createdAt } = candidate.record;
  return { id, pinned, createdAt, confirmations: candidate.confirmations };
}

function compareCandidates(a: StandingProfileCandidate, b: StandingProfileCandidate): number {
  return compareStandingProfileOrder(orderKey(a), orderKey(b));
}

function entryText(body: string, entryMaxTokens: number): string {
  return clipToTokenBudget(body.replace(/\s+/gu, " ").trim(), entryMaxTokens);
}

function assertCaps(caps: StandingProfileCaps): void {
  const valid = [caps.maxEntries, caps.maxTokens, caps.entryMaxTokens].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  if (!valid) throw new RangeError("Standing profile caps must be non-negative integers.");
}

function eligibleCandidates(
  candidates: readonly StandingProfileCandidate[],
  nowMs: number,
  staleConfidenceThreshold: number,
  drop: (reason: StandingProfileDropReason) => void,
): StandingProfileCandidate[] {
  const eligible: StandingProfileCandidate[] = [];
  const seen = new Set<MemoryId>();
  for (const candidate of candidates) {
    if (seen.has(candidate.record.id)) continue;
    seen.add(candidate.record.id);
    const reason = ineligibility(candidate, nowMs, staleConfidenceThreshold);
    if (reason === undefined) eligible.push(candidate);
    else drop(reason);
  }
  return eligible;
}

/**
 * Selects the standing profile from the person's candidate facts. Deterministic for equal input:
 * pinned first, then confirmations, then the newest statement, then the id.
 */
export function selectStandingProfile(
  candidates: readonly StandingProfileCandidate[],
  nowMs: number,
  caps: StandingProfileCaps = DEFAULT_STANDING_PROFILE_CAPS,
  staleConfidenceThreshold: number = DEFAULT_STALE_CONFIDENCE_THRESHOLD,
): StandingProfile {
  assertCaps(caps);
  const dropped: Partial<Record<StandingProfileDropReason, number>> = {};
  const drop = (reason: StandingProfileDropReason): void => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const eligible = eligibleCandidates(candidates, nowMs, staleConfidenceThreshold, drop);
  eligible.sort(compareCandidates);
  const entries: StandingProfileEntry[] = [];
  let tokens = 0;
  for (const { record } of eligible) {
    if (entries.length >= caps.maxEntries) {
      drop("entry-cap");
      continue;
    }
    const text = entryText(record.body, caps.entryMaxTokens);
    const cost = estimateTokens(text);
    if (text.length === 0) drop("empty");
    else if (tokens + cost > caps.maxTokens) drop("token-cap");
    else {
      entries.push({
        id: record.id,
        type: record.type,
        text,
        tokens: cost,
        pinned: record.pinned,
      });
      tokens += cost;
    }
  }
  return { entries, tokens, dropped };
}
