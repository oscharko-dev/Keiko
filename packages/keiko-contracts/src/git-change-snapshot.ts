// Immutable base-to-head Git change snapshot (Issue #3397, Epic #3384, ADR-0174).
//
// ONE versioned contract for the exact comparison a pull request is reviewed against: the merge
// base of a server-resolved base ref and head ref, bound to immutable SHAs, carrying every changed
// file as a typed entry and every retained hunk as a content-free range + digest. Pull-request
// narratives (#3398), the apply lane (#3399), Git-to-Chat (#3400) and the Workbench draft (#3401)
// all consume THIS shape and nothing else.
//
// Deliberately NOT the editor diff contract (git-editor.ts) and NOT an extension of
// git-repository.ts: those describe a staged/worktree diff of the selected root — a view that
// changes under the user's hands — while this one describes two immutable commits and must stay
// byte-identical across captures of the same comparison (`snapshotDigest`). It also carries what
// the editor shape cannot: copies, mode-only changes, submodule pointer moves and binary entries
// as first-class members, each with the raw-lane identity git actually reported.
//
// CONTENT-FREE BY CONSTRUCTION. The durable snapshot carries path DIGESTS, object ids, modes,
// counts and hunk RANGES + digests — never a path, never a line of diff text. Paths and hunk bodies
// live only in the producer's transient raw lane, held for the snapshot's own TTL and never
// persisted (see keiko-server gitChangeSnapshotRegistry.ts). This is what lets a snapshot travel
// into evidence and activity logs unchanged.
//
// Leaf-package rule (ADR-0019): pure types + validation, no filesystem, no process, no clock, no
// crypto. Digest FORMULAS are owned here (`gitChangeSnapshotDigestFields`,
// `gitChangeSnapshotEntryIdentityFields`); the hashing primitive is keiko-security's sha256Hex.

import {
  isCodeTaskGitCommitSha,
  isCodeTaskIsoInstant,
  isCodeTaskSha256Digest,
  ownField,
} from "./code-task-acceptance.js";
import {
  exactKeys,
  isOneOf,
  isRecord,
  validateSafeId,
} from "./coding-workbench-runtime-api-validation.js";
import { isSafeGitRefName } from "./git-repository.js";

export const GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

// ─── Closed vocabularies ────────────────────────────────────────────────────────────

/**
 * The FROZEN outcome vocabulary for the whole epic. `stale` is deliberately not an outcome: it is
 * the result of re-checking a snapshot's digest (or its base/head/merge-base binding) against the
 * live repository later, and every consumer computes it for itself from `snapshotDigest`.
 */
export const GIT_CHANGE_SNAPSHOT_OUTCOMES = Object.freeze([
  "complete",
  "partial",
  "unavailable",
  "failed",
] as const);
export type GitChangeSnapshotOutcome = (typeof GIT_CHANGE_SNAPSHOT_OUTCOMES)[number];

/**
 * Why content is absent from a snapshot. `byte-cap` covers every size bound of the patch lane
 * (per-file bytes, total bytes, hunks per file); `file-cap` covers whole files dropped past
 * `maxFiles`; `binary` and `submodule` name content git renders no text for; `generated` is the
 * policy omission for files the head tree marks `linguist-generated`.
 */
export const GIT_CHANGE_SNAPSHOT_OMISSION_REASONS = Object.freeze([
  "byte-cap",
  "file-cap",
  "binary",
  "submodule",
  "generated",
] as const);
export type GitChangeSnapshotOmissionReason = (typeof GIT_CHANGE_SNAPSHOT_OMISSION_REASONS)[number];

export const GIT_CHANGE_SNAPSHOT_ENTRY_KINDS = Object.freeze([
  "add",
  "modify",
  "delete",
  "rename",
  "copy",
  "mode-change",
  "binary",
  "submodule",
] as const);
export type GitChangeSnapshotEntryKind = (typeof GIT_CHANGE_SNAPSHOT_ENTRY_KINDS)[number];

/** The content change a `binary` or `submodule` entry underwent; the raw lane's own status letter. */
export const GIT_CHANGE_SNAPSHOT_CONTENT_CHANGES = Object.freeze([
  "add",
  "modify",
  "delete",
  "rename",
  "copy",
] as const);
export type GitChangeSnapshotContentChange = (typeof GIT_CHANGE_SNAPSHOT_CONTENT_CHANGES)[number];

/** The comparison is well-formed but there is nothing immutable to compare. */
export const GIT_CHANGE_SNAPSHOT_UNAVAILABLE_REASONS = Object.freeze([
  "invalid-ref",
  "missing-ref",
  "identical-revisions",
  "no-merge-base",
  "head-behind-base",
  "unsupported-object-format",
  "head-mismatch",
  "revision-mismatch",
] as const);
export type GitChangeSnapshotUnavailableReason =
  (typeof GIT_CHANGE_SNAPSHOT_UNAVAILABLE_REASONS)[number];

/** A lane did not complete; the comparison may well exist, this capture could not read it. */
export const GIT_CHANGE_SNAPSHOT_FAILURE_REASONS = Object.freeze([
  "git-missing",
  "unsafe-repository",
  "git-error",
  "timeout",
  "cancelled",
  "metadata-truncated",
  "malformed-output",
] as const);
export type GitChangeSnapshotFailureReason = (typeof GIT_CHANGE_SNAPSHOT_FAILURE_REASONS)[number];

// ─── Bounds ─────────────────────────────────────────────────────────────────────────

export interface GitChangeSnapshotLimits {
  readonly maxFiles: number;
  readonly maxHunksPerFile: number;
  readonly maxPatchBytes: number;
  readonly maxTotalBytes: number;
}

export const GIT_CHANGE_SNAPSHOT_DEFAULT_LIMITS: GitChangeSnapshotLimits = Object.freeze({
  maxFiles: 400,
  maxHunksPerFile: 256,
  maxPatchBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
});

/** No caller can widen a capture past these, whatever it asks for. */
export const GIT_CHANGE_SNAPSHOT_LIMIT_CEILINGS: GitChangeSnapshotLimits = Object.freeze({
  maxFiles: 2_000,
  maxHunksPerFile: 1_024,
  maxPatchBytes: 4 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
});

export const GIT_CHANGE_SNAPSHOT_MAX_LINES_PER_HUNK = 4_096;
export const GIT_CHANGE_SNAPSHOT_MAX_HUNK_HEADER_CHARS = 512;
export const GIT_CHANGE_SNAPSHOT_MAX_LINE_CHARS = 16_384;
export const GIT_CHANGE_SNAPSHOT_DEFAULT_TTL_MS = 15 * 60_000;
export const GIT_CHANGE_SNAPSHOT_MAX_TTL_MS = 60 * 60_000;
export const GIT_CHANGE_SNAPSHOT_REPOSITORY_ID_MAX_CHARS = 128;

const LIMIT_KEYS = ["maxFiles", "maxHunksPerFile", "maxPatchBytes", "maxTotalBytes"] as const;

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function clampLimit(key: keyof GitChangeSnapshotLimits, requested: unknown): number {
  const fallback = GIT_CHANGE_SNAPSHOT_DEFAULT_LIMITS[key];
  const ceiling = GIT_CHANGE_SNAPSHOT_LIMIT_CEILINGS[key];
  if (!isPositiveSafeInteger(requested)) return fallback;
  return Math.min(requested, ceiling);
}

/**
 * The limits a capture actually applies. A missing or non-conforming override (not a positive
 * safe integer) falls back to the default; a conforming one is clamped to the ceiling. The
 * per-file byte bound can never exceed the total, so `maxPatchBytes` is folded under
 * `maxTotalBytes` last.
 */
export function resolveGitChangeSnapshotLimits(
  overrides?: Partial<Readonly<Record<keyof GitChangeSnapshotLimits, unknown>>>,
): GitChangeSnapshotLimits {
  const maxTotalBytes = clampLimit("maxTotalBytes", overrides?.maxTotalBytes);
  return {
    maxFiles: clampLimit("maxFiles", overrides?.maxFiles),
    maxHunksPerFile: clampLimit("maxHunksPerFile", overrides?.maxHunksPerFile),
    maxPatchBytes: Math.min(clampLimit("maxPatchBytes", overrides?.maxPatchBytes), maxTotalBytes),
    maxTotalBytes,
  };
}

// ─── Shapes ─────────────────────────────────────────────────────────────────────────

/** One retained hunk: its range and a digest of its text. The text itself stays in the raw lane. */
export interface GitChangeSnapshotHunk {
  readonly hunkDigest: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly additions: number;
  readonly deletions: number;
}

interface GitChangeSnapshotEntryBase {
  /** Stable, content-free id: digest of `gitChangeSnapshotEntryIdentityFields`. */
  readonly evidenceId: string;
  /** sha256 of the repository-relative path (the new path for renames and copies). */
  readonly pathDigest: string;
  /** Six-digit octal modes from the raw lane; `000000` on the absent side of an add/delete. */
  readonly oldMode: string;
  readonly newMode: string;
  /** Git object ids from the raw lane; forty zeros on the absent side. Commit ids for submodules. */
  readonly oldObjectId: string;
  readonly newObjectId: string;
  /** Per-file line statistics from the numstat lane; zero for binary, submodule and mode-only. */
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly GitChangeSnapshotHunk[];
  /** Hunks the producer parsed and dropped (hunk cap). Exact. */
  readonly omittedHunks: number;
  /** The producer did not see this file's whole patch: hunks past the cut are uncounted. */
  readonly truncated: boolean;
  readonly omission?: GitChangeSnapshotOmissionReason;
}

export interface GitChangeSnapshotAddEntry extends GitChangeSnapshotEntryBase {
  readonly kind: "add";
}
export interface GitChangeSnapshotModifyEntry extends GitChangeSnapshotEntryBase {
  readonly kind: "modify";
}
export interface GitChangeSnapshotDeleteEntry extends GitChangeSnapshotEntryBase {
  readonly kind: "delete";
}
export interface GitChangeSnapshotRenameEntry extends GitChangeSnapshotEntryBase {
  readonly kind: "rename";
  readonly oldPathDigest: string;
  readonly similarity: number;
}
export interface GitChangeSnapshotCopyEntry extends GitChangeSnapshotEntryBase {
  readonly kind: "copy";
  readonly oldPathDigest: string;
  readonly similarity: number;
}
/** Same blob on both sides, different mode: no content to render. */
export interface GitChangeSnapshotModeChangeEntry extends GitChangeSnapshotEntryBase {
  readonly kind: "mode-change";
}
export interface GitChangeSnapshotBinaryEntry extends GitChangeSnapshotEntryBase {
  readonly kind: "binary";
  readonly change: GitChangeSnapshotContentChange;
  readonly oldPathDigest?: string;
  readonly similarity?: number;
}
export interface GitChangeSnapshotSubmoduleEntry extends GitChangeSnapshotEntryBase {
  readonly kind: "submodule";
  readonly change: GitChangeSnapshotContentChange;
  readonly oldPathDigest?: string;
  readonly similarity?: number;
}

export type GitChangeSnapshotEntry =
  | GitChangeSnapshotAddEntry
  | GitChangeSnapshotModifyEntry
  | GitChangeSnapshotDeleteEntry
  | GitChangeSnapshotRenameEntry
  | GitChangeSnapshotCopyEntry
  | GitChangeSnapshotModeChangeEntry
  | GitChangeSnapshotBinaryEntry
  | GitChangeSnapshotSubmoduleEntry;

export interface GitChangeSnapshotOmission {
  readonly reason: GitChangeSnapshotOmissionReason;
  readonly files: number;
  readonly hunks: number;
}

export interface GitChangeSnapshotCompleteness {
  /** Files the raw lane reported for the comparison, before any cap. */
  readonly totalFiles: number;
  /** Entries carried (`entries.length`). */
  readonly files: number;
  /** Hunks carried across all entries. */
  readonly hunks: number;
  /** Patch bytes retained in the transient raw lane. */
  readonly bytes: number;
  readonly omittedFiles: number;
  readonly omittedHunks: number;
  readonly truncatedFiles: number;
  /** Per-kind retained file counts; omittedFiles separately discloses unclassified omissions. */
  readonly kinds: Readonly<Record<GitChangeSnapshotEntryKind, number>>;
  /** One record per reason present, in `GIT_CHANGE_SNAPSHOT_OMISSION_REASONS` order. */
  readonly omissions: readonly GitChangeSnapshotOmission[];
}

/**
 * Disclosed, never binding: the state of the working tree at capture time. A dirty tree does not
 * change what two commits differ by, so this is excluded from `snapshotDigest` and can never
 * invalidate the snapshot. Publishability of a governed commit belongs to #3386/#3387.
 */
export interface GitChangeSnapshotLocalDivergence {
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  readonly conflictedCount: number;
}

export interface GitChangeSnapshot {
  readonly schemaVersion: typeof GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION;
  readonly repositoryId: string;
  readonly remoteDigest?: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly mergeBaseSha: string;
  readonly capturedAt: string;
  readonly expiresAt: string;
  readonly outcome: "complete" | "partial";
  readonly limits: GitChangeSnapshotLimits;
  readonly completeness: GitChangeSnapshotCompleteness;
  readonly entries: readonly GitChangeSnapshotEntry[];
  readonly localDivergence: GitChangeSnapshotLocalDivergence;
  /** sha256 over `gitChangeSnapshotDigestFields(this)`. */
  readonly snapshotDigest: string;
}

/**
 * A ref is absent from an unavailable or failed result exactly when the supplied value failed
 * `isSafeGitRefName`: a hostile string is never echoed back.
 */
export interface GitChangeSnapshotUnavailable {
  readonly schemaVersion: typeof GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION;
  readonly repositoryId: string;
  readonly baseRef?: string;
  readonly headRef?: string;
  readonly capturedAt: string;
  readonly outcome: "unavailable";
  readonly reason: GitChangeSnapshotUnavailableReason;
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly mergeBaseSha?: string;
}

export interface GitChangeSnapshotFailed {
  readonly schemaVersion: typeof GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION;
  readonly repositoryId: string;
  readonly baseRef?: string;
  readonly headRef?: string;
  readonly capturedAt: string;
  readonly outcome: "failed";
  readonly reason: GitChangeSnapshotFailureReason;
  readonly errorKind: string;
}

export type GitChangeSnapshotResult =
  GitChangeSnapshot | GitChangeSnapshotUnavailable | GitChangeSnapshotFailed;

export interface GitChangeSnapshotValidationOk {
  readonly ok: true;
  readonly value: GitChangeSnapshotResult;
}
export interface GitChangeSnapshotValidationFail {
  readonly ok: false;
  readonly reasons: readonly string[];
}
export type GitChangeSnapshotValidation =
  GitChangeSnapshotValidationOk | GitChangeSnapshotValidationFail;

// ─── Digest formulas (one owner) ────────────────────────────────────────────────────

/** The durable fields `snapshotDigest` covers: no timestamps, no divergence, no digest itself. */
export type GitChangeSnapshotDurableFields = Pick<
  GitChangeSnapshot,
  | "schemaVersion"
  | "repositoryId"
  | "remoteDigest"
  | "baseRef"
  | "baseSha"
  | "headRef"
  | "headSha"
  | "mergeBaseSha"
  | "limits"
  | "completeness"
  | "entries"
>;

export function gitChangeSnapshotDigestFields(
  snapshot: GitChangeSnapshotDurableFields,
): Omit<GitChangeSnapshotDurableFields, "repositoryId"> & { readonly repositoryId?: string } {
  return {
    schemaVersion: snapshot.schemaVersion,
    // A checkout is only a locator when a canonical repository identity is available.
    ...(snapshot.remoteDigest === undefined ? { repositoryId: snapshot.repositoryId } : {}),
    ...(snapshot.remoteDigest === undefined ? {} : { remoteDigest: snapshot.remoteDigest }),
    baseRef: snapshot.baseRef,
    baseSha: snapshot.baseSha,
    headRef: snapshot.headRef,
    headSha: snapshot.headSha,
    mergeBaseSha: snapshot.mergeBaseSha,
    limits: snapshot.limits,
    completeness: snapshot.completeness,
    entries: snapshot.entries,
  };
}

/** The identity `evidenceId` digests: what changed and between which objects, never any content. */
export interface GitChangeSnapshotEntryIdentity {
  readonly kind: GitChangeSnapshotEntryKind;
  readonly pathDigest: string;
  readonly oldPathDigest: string | null;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldObjectId: string;
  readonly newObjectId: string;
}

export function gitChangeSnapshotEntryIdentityFields(
  entry: Omit<GitChangeSnapshotEntry, "evidenceId">,
): GitChangeSnapshotEntryIdentity {
  return {
    kind: entry.kind,
    pathDigest: entry.pathDigest,
    oldPathDigest:
      "oldPathDigest" in entry && typeof entry.oldPathDigest === "string"
        ? entry.oldPathDigest
        : null,
    oldMode: entry.oldMode,
    newMode: entry.newMode,
    oldObjectId: entry.oldObjectId,
    newObjectId: entry.newObjectId,
  };
}

const LIMITING_OMISSIONS: ReadonlySet<GitChangeSnapshotOmissionReason> = new Set([
  "byte-cap",
  "file-cap",
  "generated",
]);

/**
 * `complete` means every textual hunk git renders for the comparison is carried. Binary and
 * submodule entries render no text, so their recorded omissions do not reduce completeness; a
 * limit or the generated-file policy does. Keiko never labels a truncated snapshot complete.
 */
export function deriveGitChangeSnapshotOutcome(
  completeness: GitChangeSnapshotCompleteness,
): "complete" | "partial" {
  const limited =
    completeness.omittedFiles > 0 ||
    completeness.omittedHunks > 0 ||
    completeness.truncatedFiles > 0 ||
    completeness.omissions.some((omission) => LIMITING_OMISSIONS.has(omission.reason));
  return limited ? "partial" : "complete";
}

export interface GitChangeSnapshotCompletenessInput {
  readonly entries: readonly GitChangeSnapshotEntry[];
  /** Files the raw lane reported before the file cap; never below `entries.length`. */
  readonly totalFiles: number;
  /** Patch bytes retained in the transient raw lane. */
  readonly bytes: number;
}

function omissionRollUp(
  entries: readonly GitChangeSnapshotEntry[],
  omittedFiles: number,
): readonly GitChangeSnapshotOmission[] {
  const omissions: GitChangeSnapshotOmission[] = [];
  for (const reason of GIT_CHANGE_SNAPSHOT_OMISSION_REASONS) {
    if (reason === "file-cap") {
      if (omittedFiles > 0) omissions.push({ reason, files: omittedFiles, hunks: 0 });
      continue;
    }
    // Preserve the own-only omission observation on the admitted entry union without
    // changing the shared record ingress helper or reading an inherited omission.
    const affected = entries.filter(
      (entry) => (Object.hasOwn(entry, "omission") ? entry.omission : undefined) === reason,
    );
    if (affected.length === 0) continue;
    const hunks = affected.reduce((sum, entry) => sum + entry.omittedHunks, 0);
    omissions.push({ reason, files: affected.length, hunks });
  }
  return omissions;
}

/**
 * THE completeness formula. The producer builds its record with this, the validator re-derives the
 * record with it and rejects any that disagrees, and a test fixture calls it rather than restating
 * it (AGENTS.md §7): one owner, so the counts can never drift from the entries they describe.
 */
export function summarizeGitChangeSnapshotCompleteness(
  input: GitChangeSnapshotCompletenessInput,
): GitChangeSnapshotCompleteness {
  const { entries, totalFiles, bytes } = input;
  const omittedFiles = Math.max(0, totalFiles - entries.length);
  return {
    totalFiles,
    files: entries.length,
    hunks: entries.reduce((sum, entry) => sum + entry.hunks.length, 0),
    bytes,
    omittedFiles,
    omittedHunks: entries.reduce((sum, entry) => sum + entry.omittedHunks, 0),
    truncatedFiles: entries.filter((entry) => entry.truncated).length,
    kinds: snapshotKindCounts(entries),
    omissions: omissionRollUp(entries, omittedFiles),
  };
}

function snapshotKindCounts(
  entries: readonly GitChangeSnapshotEntry[],
): Record<GitChangeSnapshotEntryKind, number> {
  const counts: Record<GitChangeSnapshotEntryKind, number> = {
    add: 0,
    modify: 0,
    delete: 0,
    rename: 0,
    copy: 0,
    "mode-change": 0,
    binary: 0,
    submodule: 0,
  };
  for (const entry of entries) counts[entry.kind] += 1;
  return counts;
}

/** The opaque, server-issued handle a registry returns for a snapshot. Random, never path-derived. */
const SNAPSHOT_REFERENCE = /^gcs_[0-9a-f]{32}$/u;

export function isGitChangeSnapshotReference(value: unknown): value is string {
  return typeof value === "string" && SNAPSHOT_REFERENCE.test(value);
}

// ─── Validation ─────────────────────────────────────────────────────────────────────

const OBJECT_MODE = /^[0-7]{6}$/u;
const ERROR_KIND = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

const SNAPSHOT_KEYS: readonly string[] = [
  "schemaVersion",
  "repositoryId",
  "remoteDigest",
  "baseRef",
  "baseSha",
  "headRef",
  "headSha",
  "mergeBaseSha",
  "capturedAt",
  "expiresAt",
  "outcome",
  "limits",
  "completeness",
  "entries",
  "localDivergence",
  "snapshotDigest",
];
const UNAVAILABLE_KEYS: readonly string[] = [
  "schemaVersion",
  "repositoryId",
  "baseRef",
  "headRef",
  "capturedAt",
  "outcome",
  "reason",
  "baseSha",
  "headSha",
  "mergeBaseSha",
];
const FAILED_KEYS: readonly string[] = [
  "schemaVersion",
  "repositoryId",
  "baseRef",
  "headRef",
  "capturedAt",
  "outcome",
  "reason",
  "errorKind",
];
const COMPLETENESS_KEYS: readonly string[] = [
  "totalFiles",
  "files",
  "hunks",
  "bytes",
  "omittedFiles",
  "omittedHunks",
  "truncatedFiles",
  "kinds",
  "omissions",
];
const OMISSION_KEYS: readonly string[] = ["reason", "files", "hunks"];
const DIVERGENCE_KEYS: readonly string[] = [
  "stagedCount",
  "unstagedCount",
  "untrackedCount",
  "conflictedCount",
];
const HUNK_KEYS: readonly string[] = [
  "hunkDigest",
  "oldStart",
  "oldCount",
  "newStart",
  "newCount",
  "additions",
  "deletions",
];
const ENTRY_BASE_KEYS: readonly string[] = [
  "kind",
  "evidenceId",
  "pathDigest",
  "oldMode",
  "newMode",
  "oldObjectId",
  "newObjectId",
  "additions",
  "deletions",
  "hunks",
  "omittedHunks",
  "truncated",
  "omission",
];
const PAIRED_ENTRY_KEYS: readonly string[] = [...ENTRY_BASE_KEYS, "oldPathDigest", "similarity"];
const CONTENT_ENTRY_KEYS: readonly string[] = [...PAIRED_ENTRY_KEYS, "change"];
const TEXTUAL_KINDS: ReadonlySet<string> = new Set(["add", "modify", "delete", "rename", "copy"]);

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Prototype-resolved fields never count: a hostile `Object.prototype.outcome` must not validate.
function field(record: Record<string, unknown>, key: string): unknown {
  return ownField(record, key);
}

// Closed key set on OWN names (not only enumerable keys) plus a symbol guard, so a non-enumerable
// or symbol-keyed extra cannot ride along past `exactKeys`.
function rejectObservedSnapshotField(reasons: string[], message: string): false {
  if (!reasons.includes(message)) reasons.push(message);
  return false;
}

function rejectSnapshotField(reasons: string[], message: string): false {
  reasons.push(message);
  return false;
}

function closedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  reasons: string[],
): boolean {
  const issues = exactKeys(record, allowed, path);
  reasons.push(...issues);
  let valid = issues.length === 0;
  for (const key of Object.getOwnPropertyNames(record)) {
    if (!allowed.includes(key))
      valid = rejectSnapshotField(reasons, `${path}.${key} is not allowed`);
  }
  if (Object.getOwnPropertySymbols(record).length > 0) {
    valid = rejectSnapshotField(reasons, `${path} must not carry symbol-keyed properties`);
  }
  return valid;
}

function requireCounts(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  reasons: string[],
): boolean {
  let valid = true;
  for (const key of keys) {
    if (!isNonNegativeSafeInteger(field(record, key))) {
      valid = rejectSnapshotField(reasons, `${path}.${key} must be a non-negative safe integer`);
    }
  }
  return valid;
}

function requireDigest(value: unknown, path: string, reasons: string[]): boolean {
  let valid = true;
  if (!isCodeTaskSha256Digest(value))
    valid = rejectSnapshotField(reasons, `${path} must be a sha256 hex digest`);
  return valid;
}

function requireObjectId(value: unknown, path: string, reasons: string[]): boolean {
  let valid = true;
  if (!isCodeTaskGitCommitSha(value))
    valid = rejectSnapshotField(reasons, `${path} must be a 40-hex git object id`);
  return valid;
}

function requireMode(value: unknown, path: string, reasons: string[]): boolean {
  let valid = true;
  if (typeof value !== "string" || !OBJECT_MODE.test(value)) {
    valid = rejectSnapshotField(reasons, `${path} must be a six-digit octal mode`);
  }
  return valid;
}

function requireInstant(value: unknown, path: string, reasons: string[]): boolean {
  let valid = true;
  if (!isCodeTaskIsoInstant(value))
    valid = rejectSnapshotField(reasons, `${path} must be a UTC ISO-8601 instant`);
  return valid;
}

function isSafeRef(value: unknown): value is string {
  return typeof value === "string" && isSafeGitRefName(value);
}

function validateOptionalRef(value: unknown, path: string, reasons: string[]): boolean {
  let valid = true;
  if (value !== undefined && !isSafeRef(value))
    valid = rejectSnapshotField(reasons, `${path} must be a safe git ref`);
  return valid;
}

function validateLimits(value: unknown, reasons: string[]): value is GitChangeSnapshotLimits {
  if (!isRecord(value)) {
    reasons.push("limits must be an object");
    return false;
  }
  closedKeys(value, LIMIT_KEYS, "limits", reasons);
  let ok = true;
  for (const key of LIMIT_KEYS) {
    const limit = field(value, key);
    if (!isPositiveSafeInteger(limit) || limit > GIT_CHANGE_SNAPSHOT_LIMIT_CEILINGS[key]) {
      reasons.push(`limits.${key} must be a positive safe integer within the ceiling`);
      ok = false;
    }
  }
  const patch = field(value, "maxPatchBytes");
  const total = field(value, "maxTotalBytes");
  if (typeof patch === "number" && typeof total === "number" && patch > total) {
    reasons.push("limits.maxPatchBytes must not exceed limits.maxTotalBytes");
    ok = false;
  }
  return ok;
}

function validateHunk(
  value: unknown,
  path: string,
  reasons: string[],
): value is GitChangeSnapshotHunk {
  let valid = true;
  if (!isRecord(value)) {
    valid = rejectSnapshotField(reasons, `${path} must be an object`);
    return valid;
  }
  valid = closedKeys(value, HUNK_KEYS, path, reasons) && valid;
  valid = requireDigest(field(value, "hunkDigest"), `${path}.hunkDigest`, reasons) && valid;
  valid =
    requireCounts(
      value,
      ["oldStart", "oldCount", "newStart", "newCount", "additions", "deletions"],
      path,
      reasons,
    ) && valid;
  return valid;
}

function entryKeysFor(kind: GitChangeSnapshotEntryKind): readonly string[] {
  if (kind === "rename" || kind === "copy") return PAIRED_ENTRY_KEYS;
  if (kind === "binary" || kind === "submodule") return CONTENT_ENTRY_KEYS;
  return ENTRY_BASE_KEYS;
}

function validateEntryIdentity(
  entry: Record<string, unknown>,
  path: string,
  reasons: string[],
): boolean {
  let valid = true;
  valid = requireDigest(field(entry, "evidenceId"), `${path}.evidenceId`, reasons) && valid;
  valid = requireDigest(field(entry, "pathDigest"), `${path}.pathDigest`, reasons) && valid;
  valid = requireMode(field(entry, "oldMode"), `${path}.oldMode`, reasons) && valid;
  valid = requireMode(field(entry, "newMode"), `${path}.newMode`, reasons) && valid;
  valid = requireObjectId(field(entry, "oldObjectId"), `${path}.oldObjectId`, reasons) && valid;
  valid = requireObjectId(field(entry, "newObjectId"), `${path}.newObjectId`, reasons) && valid;
  valid = requireCounts(entry, ["additions", "deletions", "omittedHunks"], path, reasons) && valid;
  if (typeof field(entry, "truncated") !== "boolean") {
    valid = rejectSnapshotField(reasons, `${path}.truncated must be a boolean`);
  }
  return valid;
}

// The paired half of a rename/copy: a distinct source path digest and a similarity percentage.
function validatePairing(
  entry: Record<string, unknown>,
  path: string,
  paired: boolean,
  reasons: string[],
): boolean {
  let valid = true;
  const oldPathDigest = field(entry, "oldPathDigest");
  const similarity = field(entry, "similarity");
  if (!paired) {
    if (oldPathDigest !== undefined || similarity !== undefined) {
      valid = rejectSnapshotField(reasons, `${path} must not carry oldPathDigest or similarity`);
    }
    return valid;
  }
  valid = requireDigest(oldPathDigest, `${path}.oldPathDigest`, reasons) && valid;
  if (oldPathDigest !== undefined && oldPathDigest === field(entry, "pathDigest")) {
    valid = rejectSnapshotField(reasons, `${path}.oldPathDigest must differ from pathDigest`);
  }
  if (!isNonNegativeSafeInteger(similarity) || similarity > 100) {
    valid = rejectSnapshotField(reasons, `${path}.similarity must be an integer percentage`);
  }
  return valid;
}

function entryIsPaired(entry: Record<string, unknown>, kind: GitChangeSnapshotEntryKind): boolean {
  if (kind === "rename" || kind === "copy") return true;
  const change = field(entry, "change");
  return (kind === "binary" || kind === "submodule") && (change === "rename" || change === "copy");
}

function isContentFree(entry: Record<string, unknown>): boolean {
  const hunks = field(entry, "hunks");
  return (
    Array.isArray(hunks) &&
    hunks.length === 0 &&
    field(entry, "omittedHunks") === 0 &&
    field(entry, "additions") === 0 &&
    field(entry, "deletions") === 0 &&
    field(entry, "truncated") === false
  );
}

function validateContentless(
  entry: Record<string, unknown>,
  kind: GitChangeSnapshotEntryKind,
  path: string,
  reasons: string[],
): boolean {
  let valid = true;
  if (!isContentFree(entry)) {
    valid = rejectSnapshotField(reasons, `${path} must carry no hunks, statistics or truncation`);
  }
  if (kind === "mode-change") {
    if (field(entry, "omission") !== undefined) {
      valid = rejectSnapshotField(reasons, `${path}.omission is not allowed on a mode change`);
    }
    return valid;
  }
  if (!isOneOf(field(entry, "change"), GIT_CHANGE_SNAPSHOT_CONTENT_CHANGES)) {
    valid = rejectSnapshotField(reasons, `${path}.change must be a content change`);
  }
  if (field(entry, "omission") !== kind)
    valid = rejectSnapshotField(reasons, `${path}.omission must be ${kind}`);
  return valid;
}

function validateEntryKindRules(
  entry: Record<string, unknown>,
  kind: GitChangeSnapshotEntryKind,
  path: string,
  reasons: string[],
): boolean {
  let valid = true;
  if (!TEXTUAL_KINDS.has(kind)) valid = validateContentless(entry, kind, path, reasons) && valid;
  valid = validatePairing(entry, path, entryIsPaired(entry, kind), reasons) && valid;
  return valid;
}

// A generated-omission entry must leave exactly the trace its own contract promises: a cut, and
// nothing else -- no hunks, no dropped-hunk count, no line statistics. Split out to keep
// `validateTextualOmission`'s cyclomatic complexity under the repository ceiling.
function isContentFreeGeneratedOmission(
  entry: Record<string, unknown>,
  omittedHunks: unknown,
): boolean {
  const hunks = field(entry, "hunks");
  return (
    Array.isArray(hunks) &&
    hunks.length === 0 &&
    omittedHunks === 0 &&
    field(entry, "additions") === 0 &&
    field(entry, "deletions") === 0
  );
}

// A textual entry's omission can only be a limit or the generated policy, and each must leave a
// trace: byte-cap shows as a cut or dropped hunks, generated always as a cut (no patch lane ran)
// with zero hunks and zero statistics -- never a cut that still carries content.
function validateTextualOmission(
  entry: Record<string, unknown>,
  path: string,
  reasons: string[],
): boolean {
  let valid = true;
  const omission = field(entry, "omission");
  const truncated = field(entry, "truncated") === true;
  const omittedHunks = field(entry, "omittedHunks");
  if (omission === undefined) {
    if (truncated)
      valid = rejectSnapshotField(reasons, `${path}.truncated requires an omission reason`);
    if (omittedHunks !== 0)
      valid = rejectSnapshotField(reasons, `${path}.omittedHunks requires an omission reason`);
    return valid;
  }
  if (omission === "byte-cap") {
    if (!truncated && omittedHunks === 0)
      valid = rejectSnapshotField(reasons, `${path} byte-cap omission left no trace`);
    return valid;
  }
  if (omission === "generated") {
    if (!truncated)
      valid = rejectSnapshotField(reasons, `${path} generated omission must be truncated`);
    if (!isContentFreeGeneratedOmission(entry, omittedHunks)) {
      valid = rejectSnapshotField(
        reasons,
        `${path} generated omission must carry no hunks or statistics`,
      );
    }
    return valid;
  }
  valid = rejectSnapshotField(reasons, `${path}.omission is not valid for a textual entry`);
  return valid;
}

function validateEntryHunks(
  entry: Record<string, unknown>,
  limits: GitChangeSnapshotLimits | undefined,
  path: string,
  reasons: string[],
): boolean {
  const hunks = field(entry, "hunks");
  if (!Array.isArray(hunks)) return rejectSnapshotField(reasons, `${path}.hunks must be an array`);
  let valid = true;
  if (limits !== undefined && hunks.length > limits.maxHunksPerFile) {
    valid = rejectSnapshotField(reasons, `${path}.hunks exceeds limits.maxHunksPerFile`);
  }
  const extent = hunks.length;
  for (let index = 0; index < extent; index += 1) {
    const hunkPath = `${path}.hunks[${String(index)}]`;
    if (!(index in hunks)) return rejectSnapshotField(reasons, `${hunkPath} must be an object`);
    valid = validateHunk(hunks[index], hunkPath, reasons) && valid;
  }
  return valid;
}

function validateEntry(
  value: unknown,
  limits: GitChangeSnapshotLimits | undefined,
  path: string,
  reasons: string[],
): value is GitChangeSnapshotEntry {
  if (!isRecord(value)) return rejectSnapshotField(reasons, `${path} must be an object`);
  const kind = field(value, "kind");
  if (!isOneOf(kind, GIT_CHANGE_SNAPSHOT_ENTRY_KINDS)) {
    return rejectSnapshotField(reasons, `${path}.kind must be a snapshot entry kind`);
  }
  let valid = closedKeys(value, entryKeysFor(kind), path, reasons);
  valid = validateEntryIdentity(value, path, reasons) && valid;
  const omission = field(value, "omission");
  if (omission !== undefined && !isOneOf(omission, GIT_CHANGE_SNAPSHOT_OMISSION_REASONS)) {
    valid = rejectSnapshotField(reasons, `${path}.omission must be an omission reason`);
  }
  valid = validateEntryHunks(value, limits, path, reasons) && valid;
  valid = validateEntryKindRules(value, kind, path, reasons) && valid;
  if (TEXTUAL_KINDS.has(kind)) valid = validateTextualOmission(value, path, reasons) && valid;
  return valid;
}

function validateEntries(
  value: unknown,
  limits: GitChangeSnapshotLimits | undefined,
  reasons: string[],
): value is readonly GitChangeSnapshotEntry[] {
  if (!Array.isArray(value)) return rejectSnapshotField(reasons, "entries must be an array");
  let valid = true;
  if (limits !== undefined && value.length > limits.maxFiles) {
    reasons.push("entries exceeds limits.maxFiles");
  }
  const extent = value.length;
  const evidenceIds = new Set<unknown>();
  for (let index = 0; index < extent; index += 1) {
    if (!(index in value)) {
      valid = rejectSnapshotField(reasons, `entries[${String(index)}] must be an object`);
      break;
    }
    const entry: unknown = value[index];
    valid = validateEntry(entry, limits, `entries[${String(index)}]`, reasons) && valid;
    if (isRecord(entry)) evidenceIds.add(field(entry, "evidenceId"));
  }
  if (evidenceIds.size !== value.length) {
    valid = rejectSnapshotField(reasons, "entries must carry unique evidenceIds");
  }
  return valid;
}

function validateOmissionRecord(
  value: unknown,
  path: string,
  reasons: string[],
): value is GitChangeSnapshotOmission {
  let valid = true;
  if (!isRecord(value)) {
    valid = rejectSnapshotField(reasons, `${path} must be an object`);
    return valid;
  }
  valid = closedKeys(value, OMISSION_KEYS, path, reasons) && valid;
  if (!isOneOf(field(value, "reason"), GIT_CHANGE_SNAPSHOT_OMISSION_REASONS)) {
    valid = rejectSnapshotField(reasons, `${path}.reason must be an omission reason`);
  }
  valid = requireCounts(value, ["files", "hunks"], path, reasons) && valid;
  return valid;
}

function sameOmissions(
  actual: readonly unknown[],
  expected: readonly GitChangeSnapshotOmission[],
): boolean {
  return (
    actual.length === expected.length &&
    expected.every((omission, index) => {
      const candidate = actual[index];
      return (
        isRecord(candidate) &&
        field(candidate, "reason") === omission.reason &&
        field(candidate, "files") === omission.files &&
        field(candidate, "hunks") === omission.hunks
      );
    })
  );
}

// The completeness record must be exactly what `summarizeGitChangeSnapshotCompleteness` derives
// from the entries it accompanies — the same producer formula, not a second copy of it. Only
// `totalFiles` and `bytes` are facts the entries cannot carry, so they are taken from the record.
function validateCompletenessRollUp(
  completeness: Record<string, unknown>,
  entries: readonly GitChangeSnapshotEntry[],
  omissions: readonly unknown[],
  reasons: string[],
): boolean {
  let valid = true;
  const totalFiles = field(completeness, "totalFiles");
  const bytes = field(completeness, "bytes");
  if (!isNonNegativeSafeInteger(totalFiles))
    return rejectObservedSnapshotField(
      reasons,
      "completeness.totalFiles must be a non-negative safe integer",
    );
  if (!isNonNegativeSafeInteger(bytes))
    return rejectObservedSnapshotField(
      reasons,
      "completeness.bytes must be a non-negative safe integer",
    );
  if (totalFiles < entries.length) {
    valid = rejectSnapshotField(reasons, "completeness.totalFiles must be at least entries.length");
    return valid;
  }
  const expected = summarizeGitChangeSnapshotCompleteness({ entries, totalFiles, bytes });
  const scalarKeys = ["files", "hunks", "omittedFiles", "omittedHunks", "truncatedFiles"] as const;
  for (const key of scalarKeys) {
    if (field(completeness, key) !== expected[key]) {
      valid = rejectSnapshotField(reasons, `completeness.${key} must equal the roll-up of entries`);
    }
  }
  if (!sameOmissions(omissions, expected.omissions)) {
    valid = rejectSnapshotField(
      reasons,
      "completeness.omissions must roll up the entries' omissions in vocabulary order",
    );
  }
  return validateCompletenessKinds(field(completeness, "kinds"), expected.kinds, reasons) && valid;
}

function validateCompletenessKinds(
  kinds: unknown,
  expected: Readonly<Record<GitChangeSnapshotEntryKind, number>>,
  reasons: string[],
): boolean {
  if (!isRecord(kinds)) return rejectSnapshotField(reasons, "completeness.kinds must be an object");
  let valid = closedKeys(kinds, GIT_CHANGE_SNAPSHOT_ENTRY_KINDS, "completeness.kinds", reasons);
  for (const kind of GIT_CHANGE_SNAPSHOT_ENTRY_KINDS) {
    if (field(kinds, kind) !== expected[kind])
      valid = rejectSnapshotField(reasons, "completeness.kinds must roll up entries");
  }
  return valid;
}

function validateOmissions(omissions: readonly unknown[], reasons: string[]): boolean {
  let valid = true;
  const extent = omissions.length;
  for (let index = 0; index < extent; index += 1) {
    const path = `completeness.omissions[${String(index)}]`;
    if (!(index in omissions)) {
      valid = rejectSnapshotField(reasons, `${path} must be an object`);
      break;
    }
    valid = validateOmissionRecord(omissions[index], path, reasons) && valid;
  }
  return valid;
}

function validateCompletenessByteBudget(
  bytes: unknown,
  limits: GitChangeSnapshotLimits | undefined,
  reasons: string[],
): boolean {
  if (limits !== undefined && typeof bytes === "number" && bytes > limits.maxTotalBytes) {
    return rejectSnapshotField(reasons, "completeness.bytes must not exceed limits.maxTotalBytes");
  }
  return true;
}

function validateCompleteness(
  value: unknown,
  entries: readonly GitChangeSnapshotEntry[] | undefined,
  limits: GitChangeSnapshotLimits | undefined,
  reasons: string[],
): value is GitChangeSnapshotCompleteness {
  if (!isRecord(value)) return rejectSnapshotField(reasons, "completeness must be an object");
  let valid = closedKeys(value, COMPLETENESS_KEYS, "completeness", reasons);
  valid = requireCounts(value, COMPLETENESS_KEYS.slice(0, -2), "completeness", reasons) && valid;
  const omissions = field(value, "omissions");
  if (!Array.isArray(omissions))
    return rejectSnapshotField(reasons, "completeness.omissions must be an array");
  valid = validateOmissions(omissions, reasons) && valid;
  valid = validateCompletenessByteBudget(field(value, "bytes"), limits, reasons) && valid;
  if (entries !== undefined)
    valid = validateCompletenessRollUp(value, entries, omissions, reasons) && valid;
  return entries !== undefined && valid;
}

function validateDivergence(value: unknown, reasons: string[]): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = rejectSnapshotField(reasons, "localDivergence must be an object");
    return valid;
  }
  valid = closedKeys(value, DIVERGENCE_KEYS, "localDivergence", reasons) && valid;
  valid = requireCounts(value, DIVERGENCE_KEYS, "localDivergence", reasons) && valid;
  return valid;
}

function validateBinding(record: Record<string, unknown>, reasons: string[]): boolean {
  let valid = true;
  if (field(record, "schemaVersion") !== GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION) {
    valid = rejectSnapshotField(reasons, "schemaVersion invalid");
  }
  const repositoryId = field(record, "repositoryId");
  validateSafeId(
    repositoryId,
    "repositoryId",
    reasons,
    GIT_CHANGE_SNAPSHOT_REPOSITORY_ID_MAX_CHARS,
  );
  valid = typeof repositoryId === "string" && valid;
  valid = requireInstant(field(record, "capturedAt"), "capturedAt", reasons) && valid;
  return valid;
}

function validateSnapshotRevisions(record: Record<string, unknown>, reasons: string[]): boolean {
  let valid = true;
  if (!isSafeRef(field(record, "baseRef")))
    valid = rejectSnapshotField(reasons, "baseRef must be a safe git ref");
  if (!isSafeRef(field(record, "headRef")))
    valid = rejectSnapshotField(reasons, "headRef must be a safe git ref");
  valid = requireObjectId(field(record, "baseSha"), "baseSha", reasons) && valid;
  valid = requireObjectId(field(record, "headSha"), "headSha", reasons) && valid;
  valid = requireObjectId(field(record, "mergeBaseSha"), "mergeBaseSha", reasons) && valid;
  if (field(record, "baseSha") === field(record, "headSha")) {
    valid = rejectSnapshotField(reasons, "baseSha and headSha must differ");
  }
  if (field(record, "mergeBaseSha") === field(record, "headSha")) {
    valid = rejectSnapshotField(reasons, "mergeBaseSha must differ from headSha");
  }
  return validateSnapshotDigests(record, reasons) && valid;
}

function validateSnapshotDigests(record: Record<string, unknown>, reasons: string[]): boolean {
  let valid = true;
  const remoteDigest = field(record, "remoteDigest");
  if (remoteDigest !== undefined)
    valid = requireDigest(remoteDigest, "remoteDigest", reasons) && valid;
  valid = requireDigest(field(record, "snapshotDigest"), "snapshotDigest", reasons) && valid;
  return valid;
}

function validateSnapshotWindow(record: Record<string, unknown>, reasons: string[]): boolean {
  let valid = true;
  valid = requireInstant(field(record, "expiresAt"), "expiresAt", reasons) && valid;
  const capturedAt = field(record, "capturedAt");
  const expiresAt = field(record, "expiresAt");
  if (!isCodeTaskIsoInstant(capturedAt))
    return rejectObservedSnapshotField(reasons, "capturedAt must be a UTC ISO-8601 instant");
  if (!isCodeTaskIsoInstant(expiresAt))
    return rejectObservedSnapshotField(reasons, "expiresAt must be a UTC ISO-8601 instant");
  const ttlMs = Date.parse(expiresAt) - Date.parse(capturedAt);
  if (ttlMs <= 0 || ttlMs > GIT_CHANGE_SNAPSHOT_MAX_TTL_MS) {
    valid = rejectSnapshotField(reasons, "expiresAt must follow capturedAt within the maximum TTL");
  }
  return valid;
}

function validateSnapshotCompleteness(
  record: Record<string, unknown>,
  entries: readonly GitChangeSnapshotEntry[] | undefined,
  limits: GitChangeSnapshotLimits | undefined,
  reasons: string[],
): boolean {
  let valid = true;
  const completenessValue = field(record, "completeness");
  const completenessValid = validateCompleteness(completenessValue, entries, limits, reasons);
  valid = completenessValid && valid;
  if (completenessValid) {
    const derived = deriveGitChangeSnapshotOutcome(completenessValue);
    if (field(record, "outcome") !== derived) {
      valid = rejectSnapshotField(reasons, `outcome must be ${derived} for this completeness`);
    }
  }
  return valid;
}

function validateSnapshot(record: Record<string, unknown>, reasons: string[]): boolean {
  let valid = true;
  valid = closedKeys(record, SNAPSHOT_KEYS, "snapshot", reasons) && valid;
  valid = validateBinding(record, reasons) && valid;
  valid = validateSnapshotRevisions(record, reasons) && valid;
  valid = validateSnapshotWindow(record, reasons) && valid;
  const limitsValue = field(record, "limits");
  const limits = validateLimits(limitsValue, reasons) ? limitsValue : undefined;
  const entriesValue = field(record, "entries");
  const entries = validateEntries(entriesValue, limits, reasons) ? entriesValue : undefined;
  valid = [limits !== undefined, entries !== undefined, valid].every(Boolean);
  valid = validateSnapshotCompleteness(record, entries, limits, reasons) && valid;
  valid = validateDivergence(field(record, "localDivergence"), reasons) && valid;
  return valid;
}

// Each unavailable reason implies exactly which revisions could be resolved before it was reached.
function validateUnresolvedReason(
  record: Record<string, unknown>,
  reason: "invalid-ref" | "missing-ref",
  reasons: string[],
): boolean {
  let valid = true;
  const bothResolved =
    field(record, "baseSha") !== undefined && field(record, "headSha") !== undefined;
  if (field(record, "mergeBaseSha") !== undefined) {
    valid = rejectSnapshotField(reasons, "mergeBaseSha is not allowed for this reason");
  }
  if (reason === "invalid-ref" && bothResolved)
    valid = rejectSnapshotField(reasons, "invalid-ref resolves no revisions");
  if (reason === "missing-ref" && bothResolved)
    valid = rejectSnapshotField(reasons, "missing-ref leaves a ref unresolved");
  return valid;
}

function validateDivergentReason(
  record: Record<string, unknown>,
  reason: "no-merge-base" | "head-behind-base",
  reasons: string[],
): boolean {
  let valid = true;
  const headSha = field(record, "headSha");
  const mergeBaseSha = field(record, "mergeBaseSha");
  if (field(record, "baseSha") === headSha) {
    valid = rejectSnapshotField(reasons, `${reason} requires baseSha and headSha to differ`);
  }
  if (reason === "no-merge-base" && mergeBaseSha !== undefined) {
    valid = rejectSnapshotField(reasons, "mergeBaseSha is not allowed for no-merge-base");
  }
  if (reason === "head-behind-base" && mergeBaseSha !== headSha) {
    valid = rejectSnapshotField(reasons, "head-behind-base requires mergeBaseSha to equal headSha");
  }
  return valid;
}

function validateResolvedReason(
  record: Record<string, unknown>,
  reason: "identical-revisions" | "no-merge-base" | "head-behind-base",
  reasons: string[],
): boolean {
  let valid = true;
  const baseSha = field(record, "baseSha");
  const headSha = field(record, "headSha");
  if (baseSha === undefined || headSha === undefined) {
    valid = rejectSnapshotField(reasons, `${reason} requires baseSha and headSha`);
  }
  if (reason !== "identical-revisions") {
    valid = validateDivergentReason(record, reason, reasons) && valid;
    return valid;
  }
  if (baseSha !== headSha)
    valid = rejectSnapshotField(reasons, "identical-revisions requires baseSha to equal headSha");
  if (field(record, "mergeBaseSha") !== undefined) {
    valid = rejectSnapshotField(reasons, "mergeBaseSha is not allowed for identical-revisions");
  }
  return valid;
}

function validateUnavailableConsistency(
  record: Record<string, unknown>,
  reason: GitChangeSnapshotUnavailableReason,
  reasons: string[],
): boolean {
  let valid = true;
  if (reason === "unsupported-object-format") {
    if (["baseSha", "headSha", "mergeBaseSha"].some((key) => field(record, key) !== undefined)) {
      valid = rejectSnapshotField(reasons, "unsupported-object-format resolves no revisions");
    }
    return valid;
  }
  if (reason === "head-mismatch" || reason === "revision-mismatch") {
    if (field(record, "headSha") === undefined)
      valid = rejectSnapshotField(reasons, `${reason} requires headSha`);
    return valid;
  }
  if (reason === "invalid-ref" || reason === "missing-ref") {
    valid = validateUnresolvedReason(record, reason, reasons) && valid;
  } else {
    valid = validateResolvedReason(record, reason, reasons) && valid;
  }
  return valid;
}

function validateUnavailableRevisions(record: Record<string, unknown>, reasons: string[]): boolean {
  let valid = true;
  valid = validateOptionalRef(field(record, "baseRef"), "baseRef", reasons) && valid;
  valid = validateOptionalRef(field(record, "headRef"), "headRef", reasons) && valid;
  for (const key of ["baseSha", "headSha", "mergeBaseSha"]) {
    const value = field(record, key);
    if (value !== undefined) valid = requireObjectId(value, key, reasons) && valid;
  }
  return valid;
}

function validateUnavailable(record: Record<string, unknown>, reasons: string[]): boolean {
  let valid = true;
  valid = closedKeys(record, UNAVAILABLE_KEYS, "snapshot", reasons) && valid;
  valid = validateBinding(record, reasons) && valid;
  valid = validateUnavailableRevisions(record, reasons) && valid;
  const reason = field(record, "reason");
  if (!isOneOf(reason, GIT_CHANGE_SNAPSHOT_UNAVAILABLE_REASONS)) {
    valid = rejectSnapshotField(reasons, "reason must be an unavailable reason");
    return valid;
  }
  if (
    reason !== "invalid-ref" &&
    (!isSafeRef(field(record, "baseRef")) || !isSafeRef(field(record, "headRef")))
  ) {
    valid = rejectSnapshotField(reasons, `${reason} requires both refs`);
  }
  valid = validateUnavailableConsistency(record, reason, reasons) && valid;
  return valid;
}

function validateFailed(record: Record<string, unknown>, reasons: string[]): boolean {
  let valid = true;
  valid = closedKeys(record, FAILED_KEYS, "snapshot", reasons) && valid;
  valid = validateBinding(record, reasons) && valid;
  valid = validateOptionalRef(field(record, "baseRef"), "baseRef", reasons) && valid;
  valid = validateOptionalRef(field(record, "headRef"), "headRef", reasons) && valid;
  if (!isOneOf(field(record, "reason"), GIT_CHANGE_SNAPSHOT_FAILURE_REASONS)) {
    valid = rejectSnapshotField(reasons, "reason must be a failure reason");
  }
  const errorKind = field(record, "errorKind");
  if (typeof errorKind !== "string" || !ERROR_KIND.test(errorKind)) {
    valid = rejectSnapshotField(reasons, "errorKind must be a bounded machine token");
  }
  return valid;
}

function validateSnapshotResultFields(
  input: Record<string, unknown>,
  reasons: string[],
): input is Record<string, unknown> & GitChangeSnapshotResult {
  const outcome = field(input, "outcome");
  if (outcome === "complete" || outcome === "partial") return validateSnapshot(input, reasons);
  if (outcome === "unavailable") return validateUnavailable(input, reasons);
  if (outcome === "failed") return validateFailed(input, reasons);
  return rejectSnapshotField(reasons, "outcome must be a snapshot outcome");
}

/**
 * Validates any member of `GitChangeSnapshotResult` from an untrusted value: closed key sets on
 * own property names, every bound, every cross-field consistency rule, and the frozen vocabularies.
 * Returns the input by reference on success — callers narrow, never copy.
 */
export function validateGitChangeSnapshotResult(input: unknown): GitChangeSnapshotValidation {
  if (!isRecord(input)) return { ok: false, reasons: ["snapshot must be an object"] };
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
    return { ok: false, reasons: ["snapshot must be a plain object"] };
  }
  const reasons: string[] = [];
  return validateSnapshotResultFields(input, reasons) && reasons.length === 0
    ? { ok: true, value: input }
    : { ok: false, reasons };
}

export function isGitChangeSnapshot(value: GitChangeSnapshotResult): value is GitChangeSnapshot {
  return value.outcome === "complete" || value.outcome === "partial";
}
