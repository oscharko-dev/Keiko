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
): GitChangeSnapshotDurableFields {
  return {
    schemaVersion: snapshot.schemaVersion,
    repositoryId: snapshot.repositoryId,
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
      "oldPathDigest" in entry && entry.oldPathDigest !== undefined ? entry.oldPathDigest : null,
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
    const affected = entries.filter((entry) => entry.omission === reason);
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
    omissions: omissionRollUp(entries, omittedFiles),
  };
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
function closedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  reasons: string[],
): void {
  reasons.push(...exactKeys(record, allowed, path));
  for (const key of Object.getOwnPropertyNames(record)) {
    if (!allowed.includes(key)) reasons.push(`${path}.${key} is not allowed`);
  }
  if (Object.getOwnPropertySymbols(record).length > 0) {
    reasons.push(`${path} must not carry symbol-keyed properties`);
  }
}

function requireCounts(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  reasons: string[],
): void {
  for (const key of keys) {
    if (!isNonNegativeSafeInteger(field(record, key))) {
      reasons.push(`${path}.${key} must be a non-negative safe integer`);
    }
  }
}

function requireDigest(value: unknown, path: string, reasons: string[]): void {
  if (!isCodeTaskSha256Digest(value)) reasons.push(`${path} must be a sha256 hex digest`);
}

function requireObjectId(value: unknown, path: string, reasons: string[]): void {
  if (!isCodeTaskGitCommitSha(value)) reasons.push(`${path} must be a 40-hex git object id`);
}

function requireMode(value: unknown, path: string, reasons: string[]): void {
  if (typeof value !== "string" || !OBJECT_MODE.test(value)) {
    reasons.push(`${path} must be a six-digit octal mode`);
  }
}

function requireInstant(value: unknown, path: string, reasons: string[]): void {
  if (!isCodeTaskIsoInstant(value)) reasons.push(`${path} must be a UTC ISO-8601 instant`);
}

function isSafeRef(value: unknown): value is string {
  return typeof value === "string" && isSafeGitRefName(value);
}

function validateOptionalRef(value: unknown, path: string, reasons: string[]): void {
  if (value !== undefined && !isSafeRef(value)) reasons.push(`${path} must be a safe git ref`);
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

function validateHunk(value: unknown, path: string, reasons: string[]): void {
  if (!isRecord(value)) {
    reasons.push(`${path} must be an object`);
    return;
  }
  closedKeys(value, HUNK_KEYS, path, reasons);
  requireDigest(field(value, "hunkDigest"), `${path}.hunkDigest`, reasons);
  requireCounts(
    value,
    ["oldStart", "oldCount", "newStart", "newCount", "additions", "deletions"],
    path,
    reasons,
  );
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
): void {
  requireDigest(field(entry, "evidenceId"), `${path}.evidenceId`, reasons);
  requireDigest(field(entry, "pathDigest"), `${path}.pathDigest`, reasons);
  requireMode(field(entry, "oldMode"), `${path}.oldMode`, reasons);
  requireMode(field(entry, "newMode"), `${path}.newMode`, reasons);
  requireObjectId(field(entry, "oldObjectId"), `${path}.oldObjectId`, reasons);
  requireObjectId(field(entry, "newObjectId"), `${path}.newObjectId`, reasons);
  requireCounts(entry, ["additions", "deletions", "omittedHunks"], path, reasons);
  if (typeof field(entry, "truncated") !== "boolean") {
    reasons.push(`${path}.truncated must be a boolean`);
  }
}

// The paired half of a rename/copy: a distinct source path digest and a similarity percentage.
function validatePairing(
  entry: Record<string, unknown>,
  path: string,
  paired: boolean,
  reasons: string[],
): void {
  const oldPathDigest = field(entry, "oldPathDigest");
  const similarity = field(entry, "similarity");
  if (!paired) {
    if (oldPathDigest !== undefined || similarity !== undefined) {
      reasons.push(`${path} must not carry oldPathDigest or similarity`);
    }
    return;
  }
  requireDigest(oldPathDigest, `${path}.oldPathDigest`, reasons);
  if (oldPathDigest !== undefined && oldPathDigest === field(entry, "pathDigest")) {
    reasons.push(`${path}.oldPathDigest must differ from pathDigest`);
  }
  if (!isNonNegativeSafeInteger(similarity) || similarity > 100) {
    reasons.push(`${path}.similarity must be an integer percentage`);
  }
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
): void {
  if (!isContentFree(entry)) {
    reasons.push(`${path} must carry no hunks, statistics or truncation`);
  }
  if (kind === "mode-change") {
    if (field(entry, "omission") !== undefined) {
      reasons.push(`${path}.omission is not allowed on a mode change`);
    }
    return;
  }
  if (!isOneOf(field(entry, "change"), GIT_CHANGE_SNAPSHOT_CONTENT_CHANGES)) {
    reasons.push(`${path}.change must be a content change`);
  }
  if (field(entry, "omission") !== kind) reasons.push(`${path}.omission must be ${kind}`);
}

function validateEntryKindRules(
  entry: Record<string, unknown>,
  kind: GitChangeSnapshotEntryKind,
  path: string,
  reasons: string[],
): void {
  if (!TEXTUAL_KINDS.has(kind)) validateContentless(entry, kind, path, reasons);
  validatePairing(entry, path, entryIsPaired(entry, kind), reasons);
}

// A textual entry's omission can only be a limit or the generated policy, and each must leave a
// trace: byte-cap shows as a cut or dropped hunks, generated always as a cut (no patch lane ran).
function validateTextualOmission(
  entry: Record<string, unknown>,
  path: string,
  reasons: string[],
): void {
  const omission = field(entry, "omission");
  const truncated = field(entry, "truncated") === true;
  const omittedHunks = field(entry, "omittedHunks");
  if (omission === undefined) {
    if (truncated) reasons.push(`${path}.truncated requires an omission reason`);
    if (omittedHunks !== 0) reasons.push(`${path}.omittedHunks requires an omission reason`);
    return;
  }
  if (omission === "byte-cap") {
    if (!truncated && omittedHunks === 0) reasons.push(`${path} byte-cap omission left no trace`);
    return;
  }
  if (omission === "generated") {
    if (!truncated) reasons.push(`${path} generated omission must be truncated`);
    return;
  }
  reasons.push(`${path}.omission is not valid for a textual entry`);
}

function validateEntryHunks(
  entry: Record<string, unknown>,
  limits: GitChangeSnapshotLimits | undefined,
  path: string,
  reasons: string[],
): void {
  const hunks = field(entry, "hunks");
  if (!Array.isArray(hunks)) {
    reasons.push(`${path}.hunks must be an array`);
    return;
  }
  if (limits !== undefined && hunks.length > limits.maxHunksPerFile) {
    reasons.push(`${path}.hunks exceeds limits.maxHunksPerFile`);
  }
  hunks.forEach((hunk, index) => {
    validateHunk(hunk, `${path}.hunks[${String(index)}]`, reasons);
  });
}

function validateEntry(
  value: unknown,
  limits: GitChangeSnapshotLimits | undefined,
  path: string,
  reasons: string[],
): void {
  if (!isRecord(value)) {
    reasons.push(`${path} must be an object`);
    return;
  }
  const kind = field(value, "kind");
  if (!isOneOf(kind, GIT_CHANGE_SNAPSHOT_ENTRY_KINDS)) {
    reasons.push(`${path}.kind must be a snapshot entry kind`);
    return;
  }
  closedKeys(value, entryKeysFor(kind), path, reasons);
  validateEntryIdentity(value, path, reasons);
  const omission = field(value, "omission");
  if (omission !== undefined && !isOneOf(omission, GIT_CHANGE_SNAPSHOT_OMISSION_REASONS)) {
    reasons.push(`${path}.omission must be an omission reason`);
  }
  validateEntryHunks(value, limits, path, reasons);
  validateEntryKindRules(value, kind, path, reasons);
  if (TEXTUAL_KINDS.has(kind)) validateTextualOmission(value, path, reasons);
}

function validateEntries(
  value: unknown,
  limits: GitChangeSnapshotLimits | undefined,
  reasons: string[],
): readonly GitChangeSnapshotEntry[] | undefined {
  if (!Array.isArray(value)) {
    reasons.push("entries must be an array");
    return undefined;
  }
  if (limits !== undefined && value.length > limits.maxFiles) {
    reasons.push("entries exceeds limits.maxFiles");
  }
  const before = reasons.length;
  const evidenceIds = new Set<unknown>();
  value.forEach((entry, index) => {
    validateEntry(entry, limits, `entries[${String(index)}]`, reasons);
    if (isRecord(entry)) evidenceIds.add(field(entry, "evidenceId"));
  });
  if (evidenceIds.size !== value.length) reasons.push("entries must carry unique evidenceIds");
  // Only entries that passed every rule above are handed to the roll-up: it is typed against the
  // contract, and feeding it an unproven record would let a malformed entry shape its own summary.
  return reasons.length === before ? (value as readonly GitChangeSnapshotEntry[]) : undefined;
}

function validateOmissionRecord(value: unknown, path: string, reasons: string[]): void {
  if (!isRecord(value)) {
    reasons.push(`${path} must be an object`);
    return;
  }
  closedKeys(value, OMISSION_KEYS, path, reasons);
  if (!isOneOf(field(value, "reason"), GIT_CHANGE_SNAPSHOT_OMISSION_REASONS)) {
    reasons.push(`${path}.reason must be an omission reason`);
  }
  requireCounts(value, ["files", "hunks"], path, reasons);
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
): void {
  const totalFiles = field(completeness, "totalFiles");
  const bytes = field(completeness, "bytes");
  if (!isNonNegativeSafeInteger(totalFiles) || !isNonNegativeSafeInteger(bytes)) return;
  if (totalFiles < entries.length) {
    reasons.push("completeness.totalFiles must be at least entries.length");
    return;
  }
  const expected = summarizeGitChangeSnapshotCompleteness({ entries, totalFiles, bytes });
  const scalarKeys = ["files", "hunks", "omittedFiles", "omittedHunks", "truncatedFiles"] as const;
  for (const key of scalarKeys) {
    if (field(completeness, key) !== expected[key]) {
      reasons.push(`completeness.${key} must equal the roll-up of entries`);
    }
  }
  if (!sameOmissions(omissions, expected.omissions)) {
    reasons.push("completeness.omissions must roll up the entries' omissions in vocabulary order");
  }
}

function validateCompleteness(
  value: unknown,
  entries: readonly GitChangeSnapshotEntry[] | undefined,
  limits: GitChangeSnapshotLimits | undefined,
  reasons: string[],
): value is GitChangeSnapshotCompleteness {
  if (!isRecord(value)) {
    reasons.push("completeness must be an object");
    return false;
  }
  const before = reasons.length;
  closedKeys(value, COMPLETENESS_KEYS, "completeness", reasons);
  requireCounts(value, COMPLETENESS_KEYS.slice(0, -1), "completeness", reasons);
  const omissions = field(value, "omissions");
  if (!Array.isArray(omissions)) {
    reasons.push("completeness.omissions must be an array");
    return false;
  }
  omissions.forEach((omission, index) => {
    validateOmissionRecord(omission, `completeness.omissions[${String(index)}]`, reasons);
  });
  const bytes = field(value, "bytes");
  if (limits !== undefined && typeof bytes === "number" && bytes > limits.maxTotalBytes) {
    reasons.push("completeness.bytes must not exceed limits.maxTotalBytes");
  }
  if (entries !== undefined) validateCompletenessRollUp(value, entries, omissions, reasons);
  return reasons.length === before && entries !== undefined;
}

function validateDivergence(value: unknown, reasons: string[]): void {
  if (!isRecord(value)) {
    reasons.push("localDivergence must be an object");
    return;
  }
  closedKeys(value, DIVERGENCE_KEYS, "localDivergence", reasons);
  requireCounts(value, DIVERGENCE_KEYS, "localDivergence", reasons);
}

function validateBinding(record: Record<string, unknown>, reasons: string[]): void {
  if (field(record, "schemaVersion") !== GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION) {
    reasons.push("schemaVersion invalid");
  }
  validateSafeId(
    field(record, "repositoryId"),
    "repositoryId",
    reasons,
    GIT_CHANGE_SNAPSHOT_REPOSITORY_ID_MAX_CHARS,
  );
  requireInstant(field(record, "capturedAt"), "capturedAt", reasons);
}

function validateSnapshotRevisions(record: Record<string, unknown>, reasons: string[]): void {
  if (!isSafeRef(field(record, "baseRef"))) reasons.push("baseRef must be a safe git ref");
  if (!isSafeRef(field(record, "headRef"))) reasons.push("headRef must be a safe git ref");
  requireObjectId(field(record, "baseSha"), "baseSha", reasons);
  requireObjectId(field(record, "headSha"), "headSha", reasons);
  requireObjectId(field(record, "mergeBaseSha"), "mergeBaseSha", reasons);
  if (field(record, "baseSha") === field(record, "headSha")) {
    reasons.push("baseSha and headSha must differ");
  }
  if (field(record, "mergeBaseSha") === field(record, "headSha")) {
    reasons.push("mergeBaseSha must differ from headSha");
  }
  const remoteDigest = field(record, "remoteDigest");
  if (remoteDigest !== undefined) requireDigest(remoteDigest, "remoteDigest", reasons);
  requireDigest(field(record, "snapshotDigest"), "snapshotDigest", reasons);
}

function validateSnapshotWindow(record: Record<string, unknown>, reasons: string[]): void {
  requireInstant(field(record, "expiresAt"), "expiresAt", reasons);
  const capturedAt = field(record, "capturedAt");
  const expiresAt = field(record, "expiresAt");
  if (!isCodeTaskIsoInstant(capturedAt) || !isCodeTaskIsoInstant(expiresAt)) return;
  const ttlMs = Date.parse(expiresAt) - Date.parse(capturedAt);
  if (ttlMs <= 0 || ttlMs > GIT_CHANGE_SNAPSHOT_MAX_TTL_MS) {
    reasons.push("expiresAt must follow capturedAt within the maximum TTL");
  }
}

function validateSnapshot(record: Record<string, unknown>, reasons: string[]): void {
  closedKeys(record, SNAPSHOT_KEYS, "snapshot", reasons);
  validateBinding(record, reasons);
  validateSnapshotRevisions(record, reasons);
  validateSnapshotWindow(record, reasons);
  const limitsValue = field(record, "limits");
  const limits = validateLimits(limitsValue, reasons) ? limitsValue : undefined;
  const entries = validateEntries(field(record, "entries"), limits, reasons);
  const completenessValue = field(record, "completeness");
  if (validateCompleteness(completenessValue, entries, limits, reasons)) {
    const derived = deriveGitChangeSnapshotOutcome(completenessValue);
    if (field(record, "outcome") !== derived) {
      reasons.push(`outcome must be ${derived} for this completeness`);
    }
  }
  validateDivergence(field(record, "localDivergence"), reasons);
}

// Each unavailable reason implies exactly which revisions could be resolved before it was reached.
function validateUnresolvedReason(
  record: Record<string, unknown>,
  reason: "invalid-ref" | "missing-ref",
  reasons: string[],
): void {
  const bothResolved =
    field(record, "baseSha") !== undefined && field(record, "headSha") !== undefined;
  if (field(record, "mergeBaseSha") !== undefined) {
    reasons.push("mergeBaseSha is not allowed for this reason");
  }
  if (reason === "invalid-ref" && bothResolved) reasons.push("invalid-ref resolves no revisions");
  if (reason === "missing-ref" && bothResolved) reasons.push("missing-ref leaves a ref unresolved");
}

function validateDivergentReason(
  record: Record<string, unknown>,
  reason: "no-merge-base" | "head-behind-base",
  reasons: string[],
): void {
  const headSha = field(record, "headSha");
  const mergeBaseSha = field(record, "mergeBaseSha");
  if (field(record, "baseSha") === headSha) {
    reasons.push(`${reason} requires baseSha and headSha to differ`);
  }
  if (reason === "no-merge-base" && mergeBaseSha !== undefined) {
    reasons.push("mergeBaseSha is not allowed for no-merge-base");
  }
  if (reason === "head-behind-base" && mergeBaseSha !== headSha) {
    reasons.push("head-behind-base requires mergeBaseSha to equal headSha");
  }
}

function validateResolvedReason(
  record: Record<string, unknown>,
  reason: "identical-revisions" | "no-merge-base" | "head-behind-base",
  reasons: string[],
): void {
  const baseSha = field(record, "baseSha");
  const headSha = field(record, "headSha");
  if (baseSha === undefined || headSha === undefined) {
    reasons.push(`${reason} requires baseSha and headSha`);
  }
  if (reason !== "identical-revisions") {
    validateDivergentReason(record, reason, reasons);
    return;
  }
  if (baseSha !== headSha) reasons.push("identical-revisions requires baseSha to equal headSha");
  if (field(record, "mergeBaseSha") !== undefined) {
    reasons.push("mergeBaseSha is not allowed for identical-revisions");
  }
}

function validateUnavailableConsistency(
  record: Record<string, unknown>,
  reason: GitChangeSnapshotUnavailableReason,
  reasons: string[],
): void {
  if (reason === "invalid-ref" || reason === "missing-ref") {
    validateUnresolvedReason(record, reason, reasons);
  } else {
    validateResolvedReason(record, reason, reasons);
  }
}

function validateUnavailable(record: Record<string, unknown>, reasons: string[]): void {
  closedKeys(record, UNAVAILABLE_KEYS, "snapshot", reasons);
  validateBinding(record, reasons);
  validateOptionalRef(field(record, "baseRef"), "baseRef", reasons);
  validateOptionalRef(field(record, "headRef"), "headRef", reasons);
  for (const key of ["baseSha", "headSha", "mergeBaseSha"]) {
    const value = field(record, key);
    if (value !== undefined) requireObjectId(value, key, reasons);
  }
  const reason = field(record, "reason");
  if (!isOneOf(reason, GIT_CHANGE_SNAPSHOT_UNAVAILABLE_REASONS)) {
    reasons.push("reason must be an unavailable reason");
    return;
  }
  if (
    reason !== "invalid-ref" &&
    (!isSafeRef(field(record, "baseRef")) || !isSafeRef(field(record, "headRef")))
  ) {
    reasons.push(`${reason} requires both refs`);
  }
  validateUnavailableConsistency(record, reason, reasons);
}

function validateFailed(record: Record<string, unknown>, reasons: string[]): void {
  closedKeys(record, FAILED_KEYS, "snapshot", reasons);
  validateBinding(record, reasons);
  validateOptionalRef(field(record, "baseRef"), "baseRef", reasons);
  validateOptionalRef(field(record, "headRef"), "headRef", reasons);
  if (!isOneOf(field(record, "reason"), GIT_CHANGE_SNAPSHOT_FAILURE_REASONS)) {
    reasons.push("reason must be a failure reason");
  }
  const errorKind = field(record, "errorKind");
  if (typeof errorKind !== "string" || !ERROR_KIND.test(errorKind)) {
    reasons.push("errorKind must be a bounded machine token");
  }
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
  const outcome = field(input, "outcome");
  if (outcome === "complete" || outcome === "partial") validateSnapshot(input, reasons);
  else if (outcome === "unavailable") validateUnavailable(input, reasons);
  else if (outcome === "failed") validateFailed(input, reasons);
  else return { ok: false, reasons: ["outcome must be a snapshot outcome"] };
  return reasons.length === 0
    ? { ok: true, value: input as unknown as GitChangeSnapshotResult }
    : { ok: false, reasons };
}

export function isGitChangeSnapshot(value: GitChangeSnapshotResult): value is GitChangeSnapshot {
  return value.outcome === "complete" || value.outcome === "partial";
}
