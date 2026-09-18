// Storage mechanics of the segmented Activity Log (#3530): configuration, the ordered directory
// listing, retention-pin records, the retention and pin-quota plan, and crash-recovery inspection.
//
// This module decides and inspects; it never emits evidence. `server-log.ts` owns the one writer,
// calls into these functions, and turns every outcome into registered, body-free Activity Log
// evidence. Keeping the arithmetic here — pure functions over a directory listing — is what lets the
// byte bound be proven directly: `applyActivityLogRetention` is the one place that decides which
// files may exist, and it is the same function the writer, the pin API, and the health probe use.
//
// THE BOUND. Every file in the closed grammar counts: legacy archives and the legacy `server.log`,
// sealed segments, every process's active segment, and the small pin records. Active segments are
// counted at their reservation — the larger of their size and the configured segment size — because
// they may still grow to that size before their owner seals them. A process may open a new segment
// only after retention has brought the unprotected total, including the new reservation, within the
// byte budget. Sealed segments protected by an unexpired pin are counted against the separate pin
// quota instead, oldest pin first, and only while that quota lasts. Total disk use is therefore at
// most budget + pin quota; concurrent admissions by several processes can each observe the same free
// reservation, which is the documented residual of a lock-free design (ADR-0173 D14).

import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  readSync,
  readdirSync,
  statfsSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  SafeArtifactFileError,
  openSafeArtifactFile,
  removeSafeArtifactFile,
} from "@oscharko-dev/keiko-security/fs-hardening";
import {
  ACTIVITY_LOG_PIN_ID_PATTERN,
  ACTIVITY_LOG_STORE_POLICY_FILE_NAME,
  activityLogPinFileName,
  orderActivityLogFileNames,
  parseActivityLogPinFileName,
  parseActivityLogSegmentId,
  type ActivityLogFileName,
  type ActivityLogSegmentFileName,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import type { ServerLogEnv } from "./log-level.js";

// A hard ceiling on one serialised line. Every field guard runs first, so reaching this means a
// caller passed an unexpected shape; the line is replaced rather than written, so one pathological
// event cannot fill a disk or blow a log shipper's line limit.
export const MAX_LOG_LINE_BYTES = 8192;

export const ACTIVITY_LOG_SEGMENT_BYTES_ENV = "KEIKO_LOG_SEGMENT_BYTES";
export const ACTIVITY_LOG_SEGMENT_SECONDS_ENV = "KEIKO_LOG_SEGMENT_SECONDS";
export const ACTIVITY_LOG_RETENTION_BYTES_ENV = "KEIKO_LOG_RETENTION_BYTES";
export const ACTIVITY_LOG_RETENTION_DAYS_ENV = "KEIKO_LOG_RETENTION_DAYS";
export const ACTIVITY_LOG_PIN_QUOTA_BYTES_ENV = "KEIKO_LOG_PIN_QUOTA_BYTES";

export const DEFAULT_ACTIVITY_LOG_SEGMENT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_ACTIVITY_LOG_SEGMENT_SECONDS = 60 * 60;
export const DEFAULT_ACTIVITY_LOG_RETENTION_BYTES = 256 * 1024 * 1024;
export const DEFAULT_ACTIVITY_LOG_RETENTION_DAYS = 14;
export const DEFAULT_ACTIVITY_LOG_PIN_QUOTA_BYTES = 64 * 1024 * 1024;

// Four maximal lines: one record plus the seal line always fit, with room to spare.
export const MIN_ACTIVITY_LOG_SEGMENT_BYTES = 4 * MAX_LOG_LINE_BYTES;
export const MIN_ACTIVITY_LOG_RETENTION_BYTES = 2 * MIN_ACTIVITY_LOG_SEGMENT_BYTES;
const MAX_ACTIVITY_LOG_SEGMENT_SECONDS = 7 * 24 * 60 * 60;
const MAX_ACTIVITY_LOG_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ActivityLogStorageConfig {
  readonly segmentBytes: number;
  readonly segmentSeconds: number;
  readonly retentionBytes: number;
  readonly retentionDays: number;
  readonly pinQuotaBytes: number;
}

const POSITIVE_DECIMAL = /^[1-9]\d{0,15}$/u;

// An operator setting is a positive decimal integer inside its bounds, or it is ignored in favor of
// the documented default. A typo must never disable the bound or crash the process.
function boundedSetting(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const text = value?.trim();
  if (text === undefined || !POSITIVE_DECIMAL.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

/**
 * A segment never exceeds a quarter of the (possibly store-governed, #3554) byte budget, so a
 * small budget still holds history instead of one segment filling it. Exported so the store-policy
 * merge in `server-log.ts` re-clamps against the GOVERNING `retentionBytes` with the exact same
 * invariant, instead of restating it.
 */
export function clampActivityLogSegmentBytes(segmentBytes: number, retentionBytes: number): number {
  return Math.max(
    MIN_ACTIVITY_LOG_SEGMENT_BYTES,
    Math.min(segmentBytes, Math.floor(retentionBytes / 4)),
  );
}

/** Resolves the Activity Log storage bounds from the one configuration surface every sink sees. */
export function resolveActivityLogStorageConfig(env: ServerLogEnv): ActivityLogStorageConfig {
  const retentionBytes = boundedSetting(
    env[ACTIVITY_LOG_RETENTION_BYTES_ENV],
    DEFAULT_ACTIVITY_LOG_RETENTION_BYTES,
    MIN_ACTIVITY_LOG_RETENTION_BYTES,
    Number.MAX_SAFE_INTEGER,
  );
  const segmentBytes = boundedSetting(
    env[ACTIVITY_LOG_SEGMENT_BYTES_ENV],
    DEFAULT_ACTIVITY_LOG_SEGMENT_BYTES,
    MIN_ACTIVITY_LOG_SEGMENT_BYTES,
    Number.MAX_SAFE_INTEGER,
  );
  return {
    segmentBytes: clampActivityLogSegmentBytes(segmentBytes, retentionBytes),
    segmentSeconds: boundedSetting(
      env[ACTIVITY_LOG_SEGMENT_SECONDS_ENV],
      DEFAULT_ACTIVITY_LOG_SEGMENT_SECONDS,
      1,
      MAX_ACTIVITY_LOG_SEGMENT_SECONDS,
    ),
    retentionBytes,
    retentionDays: boundedSetting(
      env[ACTIVITY_LOG_RETENTION_DAYS_ENV],
      DEFAULT_ACTIVITY_LOG_RETENTION_DAYS,
      1,
      MAX_ACTIVITY_LOG_RETENTION_DAYS,
    ),
    pinQuotaBytes: boundedSetting(
      env[ACTIVITY_LOG_PIN_QUOTA_BYTES_ENV],
      DEFAULT_ACTIVITY_LOG_PIN_QUOTA_BYTES,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

// ─── The ordered directory listing ─────────────────────────────────────────────────────────────

export interface ActivityLogFileEntry {
  readonly file: ActivityLogFileName;
  readonly path: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export interface ActivityLogPinFileEntry {
  readonly pinId: string;
  readonly path: string;
  readonly sizeBytes: number;
}

export interface ActivityLogDirectoryListing {
  readonly files: readonly ActivityLogFileEntry[];
  readonly pins: readonly ActivityLogPinFileEntry[];
}

interface RegularFileStat {
  readonly size: number;
  readonly mtimeMs: number;
}

// `lstat`, never `stat`: a symlink planted at a grammar name is not Activity Log evidence, is never
// counted, and is never a retention target.
function regularFileStat(path: string): RegularFileStat | undefined {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

function readDirectoryNames(directory: string): readonly string[] {
  try {
    return readdirSync(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

/** Every closed-grammar regular file in the Activity Log directory, in logical-log order. */
export function listActivityLogDirectory(directory: string): ActivityLogDirectoryListing {
  const names = readDirectoryNames(directory);
  const files: ActivityLogFileEntry[] = [];
  for (const file of orderActivityLogFileNames(names)) {
    const path = join(directory, file.name);
    const stat = regularFileStat(path);
    if (stat !== undefined) files.push({ file, path, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
  }
  const pins: ActivityLogPinFileEntry[] = [];
  for (const name of names) {
    const pinId = parseActivityLogPinFileName(name);
    if (pinId === undefined) continue;
    const path = join(directory, name);
    const stat = regularFileStat(path);
    if (stat !== undefined) pins.push({ pinId, path, sizeBytes: stat.size });
  }
  return { files, pins };
}

export function isActivityLogSegmentEntry(
  entry: ActivityLogFileEntry,
): entry is ActivityLogFileEntry & { readonly file: ActivityLogSegmentFileName } {
  return entry.file.kind === "active" || entry.file.kind === "sealed";
}

// ─── Retention pins ────────────────────────────────────────────────────────────────────────────

export type ActivityLogPinReason = "incident" | "durable-batch";

export type ActivityLogPinScope =
  | { readonly kind: "window"; readonly fromMs: number; readonly toMs: number }
  | { readonly kind: "segments"; readonly segmentIds: readonly string[] };

export interface ActivityLogPinRecord {
  readonly schemaVersion: 1;
  readonly pinId: string;
  readonly reason: ActivityLogPinReason;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly scope: ActivityLogPinScope;
}

/** A window pin covers at most one week of evidence. */
export const MAX_ACTIVITY_LOG_PIN_WINDOW_MS = 7 * DAY_MS;
/** A pin expires at the latest ten years after it was created. */
export const MAX_ACTIVITY_LOG_PIN_DURATION_MS = 3650 * DAY_MS;
export const MAX_ACTIVITY_LOG_PIN_SEGMENTS = 64;
/** Unexpired pin records one Activity Log directory may hold. */
export const MAX_ACTIVITY_LOG_PINS = 64;
const MAX_PIN_RECORD_BYTES = 8 * 1024;
const PIN_RECORD_KEYS = ["schemaVersion", "pinId", "reason", "createdAtMs", "expiresAtMs", "scope"];
const PIN_REASONS: ReadonlySet<unknown> = new Set(["incident", "durable-batch"]);

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validSegmentIdList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_ACTIVITY_LOG_PIN_SEGMENTS &&
    value.every((id) => typeof id === "string" && parseActivityLogSegmentId(id) !== undefined)
  );
}

function validWindowScope(value: Readonly<Record<string, unknown>>): boolean {
  return (
    hasExactKeys(value, ["kind", "fromMs", "toMs"]) &&
    validTimestamp(value.fromMs) &&
    validTimestamp(value.toMs) &&
    value.fromMs <= value.toMs &&
    value.toMs - value.fromMs <= MAX_ACTIVITY_LOG_PIN_WINDOW_MS
  );
}

/** True for a closed, bounded pin scope; shared by request validation and record parsing. */
export function isActivityLogPinScope(value: unknown): value is ActivityLogPinScope {
  if (!isPlainObject(value)) return false;
  if (value.kind === "window") return validWindowScope(value);
  return (
    value.kind === "segments" &&
    hasExactKeys(value, ["kind", "segmentIds"]) &&
    validSegmentIdList(value.segmentIds)
  );
}

function validPinTimes(value: Readonly<Record<string, unknown>>): boolean {
  return (
    validTimestamp(value.createdAtMs) &&
    validTimestamp(value.expiresAtMs) &&
    value.expiresAtMs > value.createdAtMs &&
    value.expiresAtMs - value.createdAtMs <= MAX_ACTIVITY_LOG_PIN_DURATION_MS
  );
}

function isPinRecord(value: unknown, pinId: string): value is ActivityLogPinRecord {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, PIN_RECORD_KEYS) &&
    value.schemaVersion === 1 &&
    value.pinId === pinId &&
    PIN_REASONS.has(value.reason) &&
    validPinTimes(value) &&
    isActivityLogPinScope(value.scope)
  );
}

export interface ActivityLogPinRead {
  readonly entry: ActivityLogPinFileEntry;
  // `undefined` when the record is unreadable or outside the closed schema: it protects nothing.
  readonly record: ActivityLogPinRecord | undefined;
}

function readBoundedText(descriptor: number, sizeBytes: number): string | undefined {
  if (sizeBytes <= 0 || sizeBytes > MAX_PIN_RECORD_BYTES) return undefined;
  const buffer = Buffer.alloc(sizeBytes);
  let offset = 0;
  while (offset < sizeBytes) {
    const count = readSync(descriptor, buffer, offset, sizeBytes - offset, offset);
    if (count <= 0) return undefined;
    offset += count;
  }
  return buffer.toString("utf8");
}

function readPinRecord(
  entry: ActivityLogPinFileEntry,
  trustedRoot: string,
): ActivityLogPinRecord | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSafeArtifactFile(entry.path, {
      artifactClass: "activity-log",
      mode: "read",
      trustedRoot,
    });
    const text = readBoundedText(descriptor, fstatSync(descriptor).size);
    if (text === undefined) return undefined;
    const value: unknown = JSON.parse(text);
    return isPinRecord(value, entry.pinId) ? value : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readActivityLogPins(
  listing: ActivityLogDirectoryListing,
  trustedRoot: string,
): readonly ActivityLogPinRead[] {
  return listing.pins.map((entry) => ({ entry, record: readPinRecord(entry, trustedRoot) }));
}

/** Unexpired, valid pins in protection priority: oldest first, ties broken by id. */
export function activeActivityLogPins(
  reads: readonly ActivityLogPinRead[],
  nowMs: number,
): readonly ActivityLogPinRecord[] {
  return reads
    .map((read) => read.record)
    .filter(
      (record): record is ActivityLogPinRecord =>
        record !== undefined && record.expiresAtMs > nowMs,
    )
    .sort((left, right) =>
      left.createdAtMs === right.createdAtMs
        ? left.pinId.localeCompare(right.pinId, "en-US")
        : left.createdAtMs - right.createdAtMs,
    );
}

function writeAllBytes(descriptor: number, payload: Buffer): void {
  let offset = 0;
  while (offset < payload.length) {
    const written = writeSync(descriptor, payload, offset, payload.length - offset);
    if (written <= 0) throw new SafeArtifactFileError("activity-log", "write-failed");
    offset += written;
  }
}

/** Publishes one pin record exclusively; an existing name is never replaced. */
export function writeActivityLogPinRecord(
  directory: string,
  trustedRoot: string,
  record: ActivityLogPinRecord,
): void {
  const path = join(directory, activityLogPinFileName(record.pinId));
  const descriptor = openSafeArtifactFile(path, {
    artifactClass: "activity-log",
    mode: "exclusive-create",
    trustedRoot,
  });
  try {
    writeAllBytes(descriptor, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function isActivityLogPinId(value: unknown): value is string {
  return typeof value === "string" && ACTIVITY_LOG_PIN_ID_PATTERN.test(value);
}

/** True when `pin` asks to retain the sealed segment `entry` (time overlap or explicit id). */
export function activityLogPinCovers(
  pin: ActivityLogPinRecord,
  entry: ActivityLogFileEntry & { readonly file: ActivityLogSegmentFileName },
): boolean {
  if (pin.scope.kind === "segments") return pin.scope.segmentIds.includes(entry.file.segmentId);
  return entry.file.startMs <= pin.scope.toMs && entry.mtimeMs >= pin.scope.fromMs;
}

// ─── Store policy (#3554) ──────────────────────────────────────────────────────────────────────
//
// `resolveActivityLogStorageConfig` reads bounds from the CALLING process's own env; nothing
// previously recorded which configuration a shared `<stateDir>/logs/` directory is actually
// governed by. Several cooperating processes (a long-running server plus a one-off CLI, or two
// server instances across a restart) can therefore each run `applyActivityLogRetention` under a
// different view of the budget: a smaller one prunes segments a larger one relies on to keep, and
// a larger one is never capped by a stricter peer's limit — the #3530 bound (total disk use never
// exceeds the configured budget plus the pin quota) does not hold once processes disagree.
//
// The fix: exactly one closed-grammar record (`ACTIVITY_LOG_STORE_POLICY_FILE_NAME`, never log
// content — see `activity-log-files.ts`) holds the store-level bounds every cooperating process
// enforces. The first process that finds no valid record publishes its own, race-safe through the
// same exclusive-create primitive the pin records use. Every later process applies the STORED
// bounds, whatever its own env says, and — the one case an operator needs to see — records ONE
// body-free evidence line per process lifetime when its own env disagreed (`server-log.ts` turns
// the outcome below into that registered event). A process may replace a stale or corrupt record
// only while it is the store's SOLE live writer (every other active segment belongs to a
// confirmed-exited instance): that is what lets an operator's changed `KEIKO_LOG_RETENTION_BYTES`
// take effect on the next clean restart, without letting a stray concurrent process silently
// override a running server's governance.

export const ACTIVITY_LOG_POLICY_SETTINGS = [
  "retentionBytes",
  "retentionDays",
  "pinQuotaBytes",
] as const;
export type ActivityLogPolicySetting = (typeof ACTIVITY_LOG_POLICY_SETTINGS)[number];

export interface ActivityLogPolicyValues {
  readonly retentionBytes: number;
  readonly retentionDays: number;
  readonly pinQuotaBytes: number;
}

export interface ActivityLogPolicyRecord extends ActivityLogPolicyValues {
  readonly schemaVersion: 1;
}

const POLICY_RECORD_KEYS = ["schemaVersion", "retentionBytes", "retentionDays", "pinQuotaBytes"];

function validPolicyBound(value: unknown, minimum: number, maximum: number): boolean {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function isActivityLogPolicyRecord(value: unknown): value is ActivityLogPolicyRecord {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, POLICY_RECORD_KEYS) &&
    value.schemaVersion === 1 &&
    validPolicyBound(
      value.retentionBytes,
      MIN_ACTIVITY_LOG_RETENTION_BYTES,
      Number.MAX_SAFE_INTEGER,
    ) &&
    validPolicyBound(value.retentionDays, 1, MAX_ACTIVITY_LOG_RETENTION_DAYS) &&
    validPolicyBound(value.pinQuotaBytes, 1, Number.MAX_SAFE_INTEGER)
  );
}

function policyRecordPath(directory: string): string {
  return join(directory, ACTIVITY_LOG_STORE_POLICY_FILE_NAME);
}

/** Reads the store's governing policy record, or `undefined` when absent, unreadable, or corrupt. */
export function readActivityLogPolicyRecord(
  directory: string,
  trustedRoot: string,
): ActivityLogPolicyRecord | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSafeArtifactFile(policyRecordPath(directory), {
      artifactClass: "activity-log",
      mode: "read",
      trustedRoot,
    });
    const text = readBoundedText(descriptor, fstatSync(descriptor).size);
    if (text === undefined) return undefined;
    const value: unknown = JSON.parse(text);
    return isActivityLogPolicyRecord(value) ? value : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Publishes the store's governing policy record exclusively; an existing name is never replaced. */
export function writeActivityLogPolicyRecord(
  directory: string,
  trustedRoot: string,
  record: ActivityLogPolicyRecord,
): void {
  const descriptor = openSafeArtifactFile(policyRecordPath(directory), {
    artifactClass: "activity-log",
    mode: "exclusive-create",
    trustedRoot,
  });
  try {
    writeAllBytes(descriptor, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export interface ActivityLogWriterIdentity {
  readonly pid: number;
  readonly instanceId: string;
  readonly isAlive: (pid: number) => boolean;
}

/**
 * True when every active segment already in the directory belongs to this process or one
 * `isAlive` reports gone: no confirmed-live peer is writing, so this process may replace the
 * store's governing policy. A segment whose owner cannot be confirmed dead does NOT count as
 * gone — replacing shared governance deserves a stricter bar than sealing an abandoned segment
 * (`activityLogOrphanOwner`'s "stale" branch is a time-based guess, not a confirmed exit).
 */
export function isSoleActivityLogWriter(
  files: readonly ActivityLogFileEntry[],
  identity: ActivityLogWriterIdentity,
): boolean {
  return files.every((entry) => {
    if (entry.file.kind !== "active") return true;
    if (entry.file.instanceId === identity.instanceId || entry.file.pid === identity.pid) {
      return true;
    }
    return !identity.isAlive(entry.file.pid);
  });
}

export interface ActivityLogPolicyConflict {
  readonly resolution: "adopted" | "replaced";
  readonly conflictingSettings: readonly ActivityLogPolicySetting[];
  readonly stored: ActivityLogPolicyValues;
  readonly requested: ActivityLogPolicyValues;
}

export interface ActivityLogPolicyOutcome extends ActivityLogPolicyValues {
  // `undefined` when the governing values need no evidence: nothing existed yet, a corrupt record
  // was silently repaired, or this process's own requested values already matched the record.
  readonly conflict: ActivityLogPolicyConflict | undefined;
}

function differingPolicySettings(
  left: ActivityLogPolicyValues,
  right: ActivityLogPolicyValues,
): readonly ActivityLogPolicySetting[] {
  return ACTIVITY_LOG_POLICY_SETTINGS.filter((setting) => left[setting] !== right[setting]);
}

// A record read from disk carries `schemaVersion`; every outcome and conflict field below is
// documented as the three governed values alone, so a read is always narrowed back down before it
// is spread into one.
function policyValuesOnly(values: ActivityLogPolicyValues): ActivityLogPolicyValues {
  return {
    retentionBytes: values.retentionBytes,
    retentionDays: values.retentionDays,
    pinQuotaBytes: values.pinQuotaBytes,
  };
}

function matchingOutcome(values: ActivityLogPolicyValues): ActivityLogPolicyOutcome {
  return { ...values, conflict: undefined };
}

function adoptedOutcome(
  stored: ActivityLogPolicyValues,
  requested: ActivityLogPolicyValues,
): ActivityLogPolicyOutcome {
  const conflictingSettings = differingPolicySettings(stored, requested);
  if (conflictingSettings.length === 0) return matchingOutcome(stored);
  return { ...stored, conflict: { resolution: "adopted", conflictingSettings, stored, requested } };
}

function publishPolicy(
  directory: string,
  trustedRoot: string,
  requested: ActivityLogPolicyValues,
): boolean {
  try {
    writeActivityLogPolicyRecord(directory, trustedRoot, { schemaVersion: 1, ...requested });
    return true;
  } catch {
    return false;
  }
}

// A corrupt or unreadable record is treated as absent and repaired: whatever occupies the name
// cannot be a live peer's governing record (a valid one would have been read above), so it is
// removed and republished. Losing the exclusive-create race here to a peer publishing between
// this repair and that create is the same documented residual as the store's other lock-free
// admissions (ADR-0173 D14): the next resolution converges on whichever record won.
function repairPolicy(
  directory: string,
  trustedRoot: string,
  requested: ActivityLogPolicyValues,
): void {
  try {
    removeActivityLogFile(policyRecordPath(directory), trustedRoot);
  } catch {
    // Nothing there to remove, or this process cannot safely remove it; the create below still
    // decides who actually governs.
  }
  publishPolicy(directory, trustedRoot, requested);
}

function establishPolicy(
  directory: string,
  trustedRoot: string,
  requested: ActivityLogPolicyValues,
): ActivityLogPolicyOutcome {
  if (publishPolicy(directory, trustedRoot, requested)) return matchingOutcome(requested);
  const winner = readActivityLogPolicyRecord(directory, trustedRoot);
  if (winner !== undefined) return adoptedOutcome(policyValuesOnly(winner), requested);
  repairPolicy(directory, trustedRoot, requested);
  return matchingOutcome(requested);
}

function replacePolicy(
  directory: string,
  trustedRoot: string,
  requested: ActivityLogPolicyValues,
  stored: ActivityLogPolicyValues,
  conflictingSettings: readonly ActivityLogPolicySetting[],
): ActivityLogPolicyOutcome {
  try {
    removeActivityLogFile(policyRecordPath(directory), trustedRoot);
  } catch {
    // The create below still decides who actually governs.
  }
  if (publishPolicy(directory, trustedRoot, requested)) {
    return {
      ...requested,
      conflict: { resolution: "replaced", conflictingSettings, stored, requested },
    };
  }
  // Lost the race to a peer's own publish between the removal and this create.
  const winner = readActivityLogPolicyRecord(directory, trustedRoot);
  return winner === undefined
    ? matchingOutcome(requested)
    : adoptedOutcome(policyValuesOnly(winner), requested);
}

function resolveStorePolicyUnsafe(
  directory: string,
  trustedRoot: string,
  requested: ActivityLogPolicyValues,
  identity: ActivityLogWriterIdentity,
): ActivityLogPolicyOutcome {
  const existingRecord = readActivityLogPolicyRecord(directory, trustedRoot);
  if (existingRecord === undefined) return establishPolicy(directory, trustedRoot, requested);
  const existing = policyValuesOnly(existingRecord);
  const conflictingSettings = differingPolicySettings(existing, requested);
  if (conflictingSettings.length === 0) return matchingOutcome(existing);
  if (!isSoleActivityLogWriter(listActivityLogDirectory(directory).files, identity)) {
    return adoptedOutcome(existing, requested);
  }
  return replacePolicy(directory, trustedRoot, requested, existing, conflictingSettings);
}

/**
 * Establishes or adopts the ONE store-level policy every cooperating process must enforce
 * (retention bytes/days, pin quota bytes): see the section header above for the full design. Never
 * throws — any filesystem failure falls back to `requested`, unpersisted, exactly how an
 * ungoverned store behaved before this policy existed, never worse.
 */
export function resolveActivityLogStorePolicy(
  directory: string,
  trustedRoot: string,
  requested: ActivityLogPolicyValues,
  identity: ActivityLogWriterIdentity,
): ActivityLogPolicyOutcome {
  try {
    return resolveStorePolicyUnsafe(directory, trustedRoot, requested, identity);
  } catch {
    return matchingOutcome(requested);
  }
}

// ─── Pin protection within the quota ───────────────────────────────────────────────────────────

export interface ActivityLogPinProtection {
  // Sealed segment names retention must keep.
  readonly protectedNames: ReadonlySet<string>;
  readonly protectedBytes: number;
  // Sealed segments some pin asks to keep but the quota cannot hold: ordinary retention targets.
  readonly unprotected: readonly ActivityLogFileEntry[];
  readonly requestedBytes: number;
}

function sealedSegments(
  files: readonly ActivityLogFileEntry[],
): readonly (ActivityLogFileEntry & { readonly file: ActivityLogSegmentFileName })[] {
  return files.filter(
    (entry): entry is ActivityLogFileEntry & { readonly file: ActivityLogSegmentFileName } =>
      entry.file.kind === "sealed",
  );
}

/** Oldest pin first, oldest segment first: a greedy fill of the reserved pin quota. */
export function planActivityLogPinProtection(
  files: readonly ActivityLogFileEntry[],
  pins: readonly ActivityLogPinRecord[],
  quotaBytes: number,
): ActivityLogPinProtection {
  const protectedNames = new Set<string>();
  const unprotectedNames = new Set<string>();
  const unprotected: ActivityLogFileEntry[] = [];
  let protectedBytes = 0;
  let requestedBytes = 0;
  const sealed = sealedSegments(files);
  for (const pin of pins) {
    for (const entry of sealed) {
      const name = entry.file.name;
      if (
        protectedNames.has(name) ||
        unprotectedNames.has(name) ||
        !activityLogPinCovers(pin, entry)
      ) {
        continue;
      }
      requestedBytes += entry.sizeBytes;
      if (protectedBytes + entry.sizeBytes <= quotaBytes) {
        protectedNames.add(name);
        protectedBytes += entry.sizeBytes;
      } else {
        unprotectedNames.add(name);
        unprotected.push(entry);
      }
    }
  }
  return { protectedNames, protectedBytes, unprotected, requestedBytes };
}

// ─── Retention ────────────────────────────────────────────────────────────────────────────────

export type ActivityLogRetentionReason = "age" | "budget";

export interface ActivityLogRetentionInput {
  readonly files: readonly ActivityLogFileEntry[];
  readonly pins: readonly ActivityLogPinRecord[];
  readonly pinRecordBytes: number;
  readonly config: ActivityLogStorageConfig;
  readonly nowMs: number;
  // The reservation of the segment about to be opened (0 when none will be opened).
  readonly reserveBytes: number;
  // Names this process already failed to delete; counted, never retried in the same process.
  readonly skipNames: ReadonlySet<string>;
}

export interface ActivityLogRetentionOutcome {
  readonly protection: ActivityLogPinProtection;
  readonly prunedSegmentCount: number;
  readonly prunedLegacyFileCount: number;
  readonly prunedBytes: number;
  readonly prunedByAgeCount: number;
  readonly prunedByBudgetCount: number;
  readonly failedNames: readonly string[];
  readonly retainedFileCount: number;
  readonly retainedBytes: number;
  // Unprotected usage after retention, including active reservations and `reserveBytes`.
  readonly usageBytes: number;
  readonly admitted: boolean;
}

function activeReservation(entry: ActivityLogFileEntry, segmentBytes: number): number {
  return Math.max(entry.sizeBytes, segmentBytes);
}

function unprotectedUsage(
  input: ActivityLogRetentionInput,
  protectedNames: ReadonlySet<string>,
): number {
  let usage = input.pinRecordBytes + input.reserveBytes;
  for (const entry of input.files) {
    if (protectedNames.has(entry.file.name)) continue;
    usage +=
      entry.file.kind === "active"
        ? activeReservation(entry, input.config.segmentBytes)
        : entry.sizeBytes;
  }
  return usage;
}

// Active segments belong to a live writer (orphans are sealed before retention runs), protected
// segments to the pin quota, and names this process failed to delete are not retried.
function deletable(
  entry: ActivityLogFileEntry,
  input: ActivityLogRetentionInput,
  protectedNames: ReadonlySet<string>,
): boolean {
  return (
    entry.file.kind !== "active" &&
    !protectedNames.has(entry.file.name) &&
    !input.skipNames.has(entry.file.name)
  );
}

function retentionReason(
  entry: ActivityLogFileEntry,
  input: ActivityLogRetentionInput,
  usage: number,
): ActivityLogRetentionReason | undefined {
  if (entry.mtimeMs < input.nowMs - input.config.retentionDays * DAY_MS) return "age";
  return usage > input.config.retentionBytes ? "budget" : undefined;
}

interface MutableRetentionTally {
  prunedSegmentCount: number;
  prunedLegacyFileCount: number;
  prunedBytes: number;
  prunedByAgeCount: number;
  prunedByBudgetCount: number;
  readonly failedNames: string[];
  readonly prunedNames: Set<string>;
}

function recordPruned(
  tally: MutableRetentionTally,
  entry: ActivityLogFileEntry,
  reason: ActivityLogRetentionReason,
): void {
  tally.prunedNames.add(entry.file.name);
  tally.prunedBytes += entry.sizeBytes;
  if (entry.file.kind === "sealed") tally.prunedSegmentCount += 1;
  else tally.prunedLegacyFileCount += 1;
  if (reason === "age") tally.prunedByAgeCount += 1;
  else tally.prunedByBudgetCount += 1;
}

function emptyTally(): MutableRetentionTally {
  return {
    prunedSegmentCount: 0,
    prunedLegacyFileCount: 0,
    prunedBytes: 0,
    prunedByAgeCount: 0,
    prunedByBudgetCount: 0,
    failedNames: [],
    prunedNames: new Set<string>(),
  };
}

/**
 * Deletes, oldest first, every unprotected sealed or legacy file that is past the age bound, then as
 * many further files as the byte budget (plus `reserveBytes`) requires. `remove` performs one
 * guarded deletion and reports whether it succeeded; a failure is recorded and the next candidate is
 * tried, so one undeletable file never defers retention of the rest.
 */
export function applyActivityLogRetention(
  input: ActivityLogRetentionInput,
  remove: (entry: ActivityLogFileEntry) => boolean,
): ActivityLogRetentionOutcome {
  const protection = planActivityLogPinProtection(
    input.files,
    input.pins,
    input.config.pinQuotaBytes,
  );
  let usage = unprotectedUsage(input, protection.protectedNames);
  const tally = emptyTally();
  for (const entry of input.files) {
    if (!deletable(entry, input, protection.protectedNames)) continue;
    const reason = retentionReason(entry, input, usage);
    if (reason === undefined) continue;
    if (!remove(entry)) {
      tally.failedNames.push(entry.file.name);
      continue;
    }
    usage -= entry.sizeBytes;
    recordPruned(tally, entry, reason);
  }
  return retentionOutcome(input, protection, tally, usage);
}

function retentionOutcome(
  input: ActivityLogRetentionInput,
  protection: ActivityLogPinProtection,
  tally: MutableRetentionTally,
  usage: number,
): ActivityLogRetentionOutcome {
  const retained = input.files.filter((entry) => !tally.prunedNames.has(entry.file.name));
  return {
    protection,
    prunedSegmentCount: tally.prunedSegmentCount,
    prunedLegacyFileCount: tally.prunedLegacyFileCount,
    prunedBytes: tally.prunedBytes,
    prunedByAgeCount: tally.prunedByAgeCount,
    prunedByBudgetCount: tally.prunedByBudgetCount,
    failedNames: tally.failedNames,
    retainedFileCount: retained.length,
    retainedBytes: retained.reduce((total, entry) => total + entry.sizeBytes, 0),
    usageBytes: usage,
    admitted: usage <= input.config.retentionBytes,
  };
}

/** Removes one closed-grammar file through the guarded, identity-bound unlink. */
export function removeActivityLogFile(path: string, trustedRoot: string): void {
  removeSafeArtifactFile(path, { artifactClass: "activity-log", trustedRoot });
}

// ─── Crash recovery inspection ─────────────────────────────────────────────────────────────────

export type ActivityLogOrphanOwner = "exited" | "stale" | "same-process";

export interface ActivityLogOrphanContext {
  readonly pid: number;
  readonly instanceId: string;
  readonly currentName: string | undefined;
  readonly nowMs: number;
  readonly segmentSeconds: number;
  readonly isAlive: (pid: number) => boolean;
}

/**
 * Whether an active segment has lost its writer. A live foreign owner seals its own segment within
 * one segment window, so an active segment is only taken over when its owner has exited, when it is
 * older than two windows and unwritten for one (pid reuse), or when it is this process's own
 * abandoned segment. A process runs exactly one writer instance, so an active segment under this
 * process's pid with another instance id can only be a dead predecessor whose pid was reused.
 * `undefined` means: leave it alone.
 */
export function activityLogOrphanOwner(
  entry: ActivityLogFileEntry & { readonly file: ActivityLogSegmentFileName },
  context: ActivityLogOrphanContext,
): ActivityLogOrphanOwner | undefined {
  if (entry.file.kind !== "active" || entry.file.name === context.currentName) return undefined;
  if (entry.file.instanceId === context.instanceId) return "same-process";
  if (entry.file.pid === context.pid || !context.isAlive(entry.file.pid)) return "exited";
  const windowMs = context.segmentSeconds * 1000;
  const stale =
    context.nowMs - entry.file.startMs > 2 * windowMs && context.nowMs - entry.mtimeMs > windowMs;
  return stale ? "stale" : undefined;
}

/** `process.kill(pid, 0)` probes existence; only ESRCH proves the owner is gone. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

export interface ActivityLogSegmentTail {
  readonly sizeBytes: number;
  readonly tailState: "terminated" | "truncated";
  readonly truncatedBytes: number;
  // The last complete line is the segment's own seal line: only the rename was interrupted.
  readonly sealLinePresent: boolean;
}

const NEWLINE = 0x0a;
const TAIL_WINDOW_BYTES = 2 * MAX_LOG_LINE_BYTES + 2;

function readWindow(descriptor: number, start: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(descriptor, buffer, offset, length - offset, start + offset);
    if (count <= 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset);
}

function lastCompleteLineOp(window: Buffer, lastNewline: number): string | undefined {
  if (lastNewline < 0) return undefined;
  const previous = window.lastIndexOf(NEWLINE, lastNewline - 1);
  try {
    const value: unknown = JSON.parse(window.toString("utf8", previous + 1, lastNewline));
    return isPlainObject(value) && typeof value.op === "string" ? value.op : undefined;
  } catch {
    return undefined;
  }
}

/** Bounded read of a segment's end: never more than two maximal lines, whatever its size. */
export function inspectActivityLogSegmentTail(
  descriptor: number,
  sealOp: string,
): ActivityLogSegmentTail {
  const sizeBytes = fstatSync(descriptor).size;
  if (sizeBytes === 0) {
    return { sizeBytes, tailState: "terminated", truncatedBytes: 0, sealLinePresent: false };
  }
  const length = Math.min(sizeBytes, TAIL_WINDOW_BYTES);
  const window = readWindow(descriptor, sizeBytes - length, length);
  const lastNewline = window.lastIndexOf(NEWLINE);
  const terminated = lastNewline === window.length - 1;
  return {
    sizeBytes,
    tailState: terminated ? "terminated" : "truncated",
    truncatedBytes: terminated ? 0 : window.length - 1 - lastNewline,
    sealLinePresent: lastCompleteLineOp(window, lastNewline) === sealOp,
  };
}

function lineSeq(text: string): number | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value)) return undefined;
    const seq = value.seq;
    return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
  } catch {
    return undefined;
  }
}

function firstLineSeq(descriptor: number): number | undefined {
  const head = readWindow(descriptor, 0, MAX_LOG_LINE_BYTES + 1);
  const end = head.indexOf(NEWLINE);
  return end < 0 ? undefined : lineSeq(head.toString("utf8", 0, end));
}

function lastLineSeq(descriptor: number, sizeBytes: number): number | undefined {
  const length = Math.min(sizeBytes, TAIL_WINDOW_BYTES);
  const window = readWindow(descriptor, sizeBytes - length, length);
  const lastNewline = window.lastIndexOf(NEWLINE);
  if (lastNewline < 0) return undefined;
  const previous = window.lastIndexOf(NEWLINE, lastNewline - 1);
  return lineSeq(window.toString("utf8", previous + 1, lastNewline));
}

/**
 * The inclusive `seq` span one sealed segment covers, read from its first and last complete line
 * (both bounded reads), or `undefined` when either line carries no valid v2 sequence.
 */
export function activityLogSegmentSeqSpan(path: string, trustedRoot: string): number | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSafeArtifactFile(path, {
      artifactClass: "activity-log",
      mode: "read",
      trustedRoot,
    });
    const first = firstLineSeq(descriptor);
    const last = lastLineSeq(descriptor, fstatSync(descriptor).size);
    return first !== undefined && last !== undefined && last >= first
      ? last - first + 1
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

// ─── Free space ───────────────────────────────────────────────────────────────────────────────

/** Bytes available to this user on the log directory's filesystem, where the platform reports it. */
export function activityLogFreeBytes(directory: string): number | undefined {
  try {
    const stat = statfsSync(directory);
    const free = stat.bavail * stat.bsize;
    return Number.isSafeInteger(free) && free >= 0 ? free : undefined;
  } catch {
    return undefined;
  }
}

/** Below this much free space the store reports `low-disk-space` pressure. */
export function activityLogLowDiskThresholdBytes(config: ActivityLogStorageConfig): number {
  return Math.max(4 * config.segmentBytes, 64 * 1024 * 1024);
}
