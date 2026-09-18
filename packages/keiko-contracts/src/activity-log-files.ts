// The closed file-name grammar of the one logical Activity Log directory (`<stateDir>/logs/`).
//
// The writer (keiko-server `observability/server-log.ts`) and every reader (support export and
// analyze, the state-path ownership scan, repository scripts and end-to-end harnesses) must agree on
// which names are Activity Log evidence and in which order they form the one logical log. A second
// hand-written pattern in any of those places could admit a name the writer never creates, or miss
// one it does, so the grammar and the ordering live here, in the dependency-free contracts leaf, and
// nothing else restates them.
//
// Four kinds of file belong to the log, oldest first:
//
//   server-YYYY-MM-DD.log                     legacy daily archive (read-only, retired rotation)
//   server.log                                legacy current file  (read-only, retired single file)
//   activity-<start>-<pid>-<instance>-<index>.jsonl         sealed segment (read-only, 0400)
//   activity-<start>-<pid>-<instance>-<index>.active.jsonl  active segment (one writer process)
//
// `<start>` is the segment's UTC start time as `YYYYMMDDTHHMMSSmmmZ` (no colons, so the name is
// valid on every supported filesystem), `<pid>` and `<instance>` are the owning process identity the
// envelope already carries, and `<index>` counts that process's segments from 000001. Sealing only
// drops `.active`, so a segment keeps one stable id — `<start>-<pid>-<instance>-<index>` — for its
// whole life, and a crash-recovering reader derives the sealed name without reading any content.
// Retention pins are Keiko-owned records in the same directory, named `pin-<24 hex>.json`.
//
// Pure functions only: this module performs no filesystem access.

export const ACTIVITY_LOG_DIRECTORY_NAME = "logs";
export const ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME = "server.log";

export type ActivityLogSegmentState = "active" | "sealed";

export interface ActivityLogSegmentIdentity {
  readonly startMs: number;
  readonly pid: number;
  readonly instanceId: string;
  readonly index: number;
}

export interface ActivityLogSegmentFileName extends ActivityLogSegmentIdentity {
  readonly kind: ActivityLogSegmentState;
  readonly name: string;
  readonly segmentId: string;
}

export interface ActivityLogLegacyArchiveFileName {
  readonly kind: "legacy-archive";
  readonly name: string;
  readonly dayStartMs: number;
}

export interface ActivityLogLegacyCurrentFileName {
  readonly kind: "legacy-current";
  readonly name: string;
}

export type ActivityLogFileName =
  ActivityLogLegacyArchiveFileName | ActivityLogLegacyCurrentFileName | ActivityLogSegmentFileName;

const SEGMENT_PREFIX = "activity-";
const ACTIVE_SUFFIX = ".active.jsonl";
const SEALED_SUFFIX = ".jsonl";
const START_STAMP_PATTERN = /^\d{8}T\d{9}Z$/u;
const SEGMENT_ID_PATTERN = /^(\d{8}T\d{9}Z)-([1-9]\d{0,9})-([a-f0-9]{8})-(\d{6,9})$/u;
const LEGACY_ARCHIVE_PATTERN = /^server-(\d{4})-(\d{2})-(\d{2})\.log$/u;
const PIN_FILE_PATTERN = /^pin-([a-f0-9]{24})\.json$/u;
const MAX_PROCESS_ID = 2_147_483_647;
const MAX_SEGMENT_INDEX = 999_999_999;
// Four-digit years only: `toISOString` switches to an expanded `+YYYYYY` form past 9999.
const MAX_START_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** A retention pin id: 24 lowercase hex characters (96 random bits). */
export const ACTIVITY_LOG_PIN_ID_PATTERN = /^[a-f0-9]{24}$/u;

function validStartMs(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_START_MS;
}

function validSegmentIdentity(identity: ActivityLogSegmentIdentity): boolean {
  return (
    validStartMs(identity.startMs) &&
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 0 &&
    identity.pid <= MAX_PROCESS_ID &&
    /^[a-f0-9]{8}$/u.test(identity.instanceId) &&
    Number.isSafeInteger(identity.index) &&
    identity.index > 0 &&
    identity.index <= MAX_SEGMENT_INDEX
  );
}

function formatStartStamp(startMs: number): string {
  return new Date(startMs).toISOString().replaceAll(/[-:.]/gu, "");
}

function parseStartStamp(stamp: string): number | undefined {
  if (!START_STAMP_PATTERN.test(stamp)) return undefined;
  const iso =
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
    `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`;
  const startMs = Date.parse(iso);
  // Round-tripping rejects impossible calendar values that date parsing would normalize.
  return validStartMs(startMs) && formatStartStamp(startMs) === stamp ? startMs : undefined;
}

function formatSegmentIndex(index: number): string {
  return String(index).padStart(6, "0");
}

/** The stable id of one segment, unchanged when the segment is sealed. */
export function formatActivityLogSegmentId(identity: ActivityLogSegmentIdentity): string {
  if (!validSegmentIdentity(identity)) {
    throw new RangeError("invalid Activity Log segment identity");
  }
  return [
    formatStartStamp(identity.startMs),
    String(identity.pid),
    identity.instanceId,
    formatSegmentIndex(identity.index),
  ].join("-");
}

export function parseActivityLogSegmentId(id: string): ActivityLogSegmentIdentity | undefined {
  const match = SEGMENT_ID_PATTERN.exec(id);
  if (match === null) return undefined;
  const [, stamp = "", pidText = "", instanceId = "", indexText = ""] = match;
  const startMs = parseStartStamp(stamp);
  if (startMs === undefined) return undefined;
  const identity = { startMs, pid: Number(pidText), instanceId, index: Number(indexText) };
  // Canonical spelling only: one segment must never be reachable under two names.
  return validSegmentIdentity(identity) && formatSegmentIndex(identity.index) === indexText
    ? identity
    : undefined;
}

export function activityLogSegmentFileName(
  identity: ActivityLogSegmentIdentity,
  state: ActivityLogSegmentState,
): string {
  const suffix = state === "active" ? ACTIVE_SUFFIX : SEALED_SUFFIX;
  return `${SEGMENT_PREFIX}${formatActivityLogSegmentId(identity)}${suffix}`;
}

function parseSegmentFileName(name: string): ActivityLogSegmentFileName | undefined {
  if (!name.startsWith(SEGMENT_PREFIX)) return undefined;
  const state: ActivityLogSegmentState = name.endsWith(ACTIVE_SUFFIX) ? "active" : "sealed";
  const suffix = state === "active" ? ACTIVE_SUFFIX : SEALED_SUFFIX;
  if (!name.endsWith(suffix)) return undefined;
  const segmentId = name.slice(SEGMENT_PREFIX.length, name.length - suffix.length);
  const identity = parseActivityLogSegmentId(segmentId);
  return identity === undefined ? undefined : { kind: state, name, segmentId, ...identity };
}

function parseLegacyArchiveName(name: string): ActivityLogLegacyArchiveFileName | undefined {
  const match = LEGACY_ARCHIVE_PATTERN.exec(name);
  if (match === null) return undefined;
  const day = `${match[1] ?? ""}-${match[2] ?? ""}-${match[3] ?? ""}`;
  const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(dayStartMs) || new Date(dayStartMs).toISOString().slice(0, 10) !== day) {
    return undefined;
  }
  return { kind: "legacy-archive", name, dayStartMs };
}

/** Classifies one directory entry name; anything outside the closed grammar is `undefined`. */
export function parseActivityLogFileName(name: string): ActivityLogFileName | undefined {
  if (name === ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME) return { kind: "legacy-current", name };
  return parseLegacyArchiveName(name) ?? parseSegmentFileName(name);
}

const KIND_RANK: Readonly<Record<ActivityLogFileName["kind"], number>> = {
  "legacy-archive": 0,
  "legacy-current": 1,
  sealed: 2,
  active: 2,
};

function compareNumbers(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareCodepoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareSegments(
  left: ActivityLogSegmentFileName,
  right: ActivityLogSegmentFileName,
): number {
  return (
    compareNumbers(left.startMs, right.startMs) ||
    compareNumbers(left.pid, right.pid) ||
    compareCodepoints(left.instanceId, right.instanceId) ||
    compareNumbers(left.index, right.index) ||
    // A sealed name and its active twin exist together only inside an interrupted seal.
    compareNumbers(left.kind === "sealed" ? 0 : 1, right.kind === "sealed" ? 0 : 1)
  );
}

function isSegmentFileName(file: ActivityLogFileName): file is ActivityLogSegmentFileName {
  return file.kind === "active" || file.kind === "sealed";
}

function compareSameRank(left: ActivityLogFileName, right: ActivityLogFileName): number {
  if (isSegmentFileName(left) && isSegmentFileName(right)) return compareSegments(left, right);
  if (left.kind === "legacy-archive" && right.kind === "legacy-archive") {
    return compareNumbers(left.dayStartMs, right.dayStartMs);
  }
  return 0;
}

/**
 * Chronological order of the logical log: legacy archives by day, the legacy current file, then
 * segments by start time and owning process. Within one process instance the order is exact
 * (segment index); across processes the start time is a best-effort hint, exactly like `ts`.
 */
export function compareActivityLogFileNames(
  left: ActivityLogFileName,
  right: ActivityLogFileName,
): number {
  return (
    compareNumbers(KIND_RANK[left.kind], KIND_RANK[right.kind]) ||
    compareSameRank(left, right) ||
    compareCodepoints(left.name, right.name)
  );
}

/** Filters a directory listing to the closed grammar and returns it in logical-log order. */
export function orderActivityLogFileNames(names: Iterable<string>): readonly ActivityLogFileName[] {
  const parsed: ActivityLogFileName[] = [];
  for (const name of names) {
    const file = parseActivityLogFileName(name);
    if (file !== undefined) parsed.push(file);
  }
  return parsed.sort(compareActivityLogFileNames);
}

export function activityLogPinFileName(pinId: string): string {
  if (!ACTIVITY_LOG_PIN_ID_PATTERN.test(pinId)) {
    throw new RangeError("invalid Activity Log pin id");
  }
  return `pin-${pinId}.json`;
}

/** The pin id named by a retention-pin record file, or `undefined` outside the grammar. */
export function parseActivityLogPinFileName(name: string): string | undefined {
  return PIN_FILE_PATTERN.exec(name)?.[1];
}

/** True for every name the Activity Log store may create, rename, or delete in its directory. */
export function isActivityLogOwnedFileName(name: string): boolean {
  return (
    parseActivityLogFileName(name) !== undefined || parseActivityLogPinFileName(name) !== undefined
  );
}
