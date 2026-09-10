import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import {
  appendDurableServerLogBatch,
  redactLogFields,
  serverLogLevelEnabled,
  type ServerLogEvent,
  type ServerLogThreshold,
} from "./observability/server-log.js";

const SOURCE_FILE = "update-audit.jsonl";
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_SOURCE_EVENTS = 2_048;
const MAX_LINE_BYTES = 8_192;
const MAX_LOG_FILES = 16;
const MAX_LOG_DIRECTORY_ENTRIES = 256;
const MAX_LOG_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_RELEVANT_LOG_RECORDS = MAX_SOURCE_EVENTS + 1;
const CURRENT_LOG_FILE = "server.log";
const ROTATED_LOG_FILE = /^server-\d{4}-\d{2}-\d{2}\.log$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SHA256_PREFIX = /^[0-9a-f]{12}$/u;
const SAFE_TEXT = /^[\x20-\x7e]+$/u;
const MACHINE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE_OPERATION_ID = /^[0-9a-f]{32}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SIDECAR_KIND = /^[a-z][a-z0-9-]{0,63}$/u;
const IMPORTED_EVENT_ID = /^legacy-audit-event-[0-9a-f]{64}$/u;
const INSTANCE_ID = /^[0-9a-f]{8}$/u;
const LOG_ENVELOPE_FIELDS = [
  "ts",
  "schemaVersion",
  "pid",
  "instanceId",
  "seq",
  "level",
  "category",
  "op",
] as const;

const LEGACY_FIELDS = [
  "schemaVersion",
  "eventId",
  "type",
  "occurredAt",
  "targetVersion",
  "snapshotId",
  "portableStageId",
  "portableActivationId",
  "portableTarget",
  "portableAssetName",
  "portableAssetSha256",
  "portableAssetSizeBytes",
  "portableSidecarName",
  "portableSidecarKind",
  "portableSidecarVersion",
  "portableSidecarTarget",
  "portableSidecarPayloadSha256",
  "portableSidecarPayloadSha256Prefix",
  "portableSidecarStatus",
  "portableSidecarFailureCode",
  "store",
  "remediation",
  "status",
  "warningCode",
] as const;

const LEGACY_FIELD_SET = new Set<string>(LEGACY_FIELDS);
const IMPORTED_LOG_FIELD_SET = new Set<string>([
  ...LOG_ENVELOPE_FIELDS,
  "historical",
  "sourceSchemaVersion",
  "eventId",
  "legacyEventId",
  ...LEGACY_FIELDS.slice(2),
]);
const COMPLETION_LOG_FIELD_SET = new Set<string>([
  ...LOG_ENVELOPE_FIELDS,
  "historical",
  "sourceSchemaVersion",
  "importId",
  "sourceDigest",
  "importedIdSetDigest",
  "importedCount",
]);
// Frozen schema-1 vocabulary. This is intentionally local: the current contracts evolve, while
// the only source accepted by this one-way compatibility reader is the retired schema exactly as
// it was written. Importing today's validators would silently broaden old input over time.
const EVENT_TYPES = new Set<string>([
  "update-offered",
  "user-confirmed",
  "preflight-result",
  "snapshot-created",
  "package-update-result",
  "portable-download-result",
  "portable-sidecar-verification-result",
  "portable-staging-result",
  "portable-activation-result",
  "portable-relaunch-result",
  "remediation-completed",
  "remediation-failed",
  "remediation-deferred",
]);
const TARGETS = new Set<string>(["windows-x64", "macos-arm64", "macos-x64"]);
const SIDECAR_STATUSES = new Set<string>(["verified", "failed"]);
const SIDECAR_FAILURE_CODES = new Set<string>([
  "sidecar-metadata-malformed",
  "sidecar-missing-required",
  "sidecar-platform-mismatch",
  "sidecar-payload-outside-root",
  "sidecar-payload-missing",
  "sidecar-digest-mismatch",
  "sidecar-license-evidence-incomplete",
  "sidecar-sbom-evidence-incomplete",
  "sidecar-signing-unverified",
  "sidecar-release-impact-binding-mismatch",
]);
const STORES = new Set<string>([
  "ui-layout",
  "server-runtime",
  "durable-config",
  "evidence",
  "memory-vault",
  "local-knowledge",
  "workspace-references",
  "package-install",
]);
const REMEDIATIONS = new Set<string>([
  "no-action-required",
  "restart-required",
  "repair-required",
  "local-knowledge-reindex-required",
  "migration-required",
  "manual-review-required",
]);
const STATUSES = new Set<string>([
  "pending",
  "running",
  "completed",
  "deferred",
  "succeeded",
  "failed",
  "blocked",
]);
const WARNING_CODES = new Set<string>([
  "audit-persistence-failed",
  "state-snapshot-unavailable",
  "manual-review-required",
  "remediation-execution-failed",
  "remediation-outcome-uncertain",
]);

export type LegacyUpdateAuditImportDeferredReason =
  | "log-level-filtered"
  | "source-unsafe"
  | "source-too-large"
  | "source-invalid"
  | "source-mutated"
  | "destination-unsafe"
  | "destination-too-large"
  | "destination-invalid"
  | "destination-mutated"
  | "append-failed"
  | "durability-uncertain";

export type LegacyUpdateAuditImportOutcome =
  | { readonly status: "absent" }
  | {
      readonly status: "imported";
      readonly importId: string;
      readonly importedCount: number;
    }
  | { readonly status: "already-imported"; readonly importId: string }
  | { readonly status: "deferred"; readonly reason: LegacyUpdateAuditImportDeferredReason };

export interface ImportLegacyUpdateAuditSnapshotOptions {
  readonly stateDir: string;
  readonly level: ServerLogThreshold;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

interface DirectoryGuard {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly descriptor: number | undefined;
}

interface SourceSnapshot {
  readonly path: string;
  readonly descriptor: number;
  readonly identity: FileIdentity;
  readonly guards: readonly DirectoryGuard[];
  readonly bytes: Buffer;
}

type SourceOpenResult =
  | { readonly status: "ready"; readonly snapshot: SourceSnapshot }
  | { readonly status: "absent" }
  | { readonly status: "deferred"; readonly reason: LegacyUpdateAuditImportDeferredReason };

interface LegacyEvent {
  readonly value: Readonly<Record<string, unknown>>;
  readonly canonical: string;
  readonly importedId: string;
}

interface PreparedImport {
  readonly events: readonly LegacyEvent[];
  readonly importId: string;
  readonly sourceDigest: string;
  readonly importedIdSetDigest: string;
}

interface DestinationScan {
  readonly status: "ready" | "complete" | "deferred";
  readonly representedIds?: ReadonlySet<string>;
  readonly reason?: LegacyUpdateAuditImportDeferredReason;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function fileIdentity(stat: ReturnType<typeof fstatSync>): FileIdentity {
  return {
    dev: BigInt(stat.dev),
    ino: BigInt(stat.ino),
    size: BigInt(stat.size),
    mtimeNs: BigInt(Math.trunc(Number(stat.mtimeMs) * 1_000_000)),
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function sameDirectoryIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeFileStat(stat: ReturnType<typeof fstatSync>): boolean {
  return stat.isFile() && stat.nlink === 1 && Number.isSafeInteger(stat.size) && stat.size >= 0;
}

function safeDirectoryStat(stat: ReturnType<typeof fstatSync>): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function directoryFlag(): number {
  return typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
}

function openDirectoryGuard(path: string): DirectoryGuard | undefined {
  const before = lstatSync(path);
  if (!safeDirectoryStat(before)) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | directoryFlag() | noFollowFlag());
    const opened = fstatSync(descriptor);
    const after = lstatSync(path);
    if (!safeDirectoryStat(opened) || !safeDirectoryStat(after))
      throw new Error("unsafe directory");
    const identity = fileIdentity(opened);
    if (!sameDirectoryIdentity(identity, fileIdentity(after))) throw new Error("directory changed");
    return { path, identity, descriptor };
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    // Node cannot open directory descriptors on every supported Windows filesystem. Repeated
    // no-symlink identity checks remain fail-closed for ordinary rebinding; POSIX keeps the
    // descriptor too, closing the component-replacement window.
    if (process.platform !== "win32") return undefined;
    const after = lstatSync(path);
    return safeDirectoryStat(after) &&
      sameDirectoryIdentity(fileIdentity(before), fileIdentity(after))
      ? { path, identity: fileIdentity(after), descriptor: undefined }
      : undefined;
  }
}

function directoryStillSame(guard: DirectoryGuard): boolean {
  try {
    const pathStat = lstatSync(guard.path);
    if (
      !safeDirectoryStat(pathStat) ||
      !sameDirectoryIdentity(guard.identity, fileIdentity(pathStat))
    ) {
      return false;
    }
    if (guard.descriptor === undefined) return process.platform === "win32";
    const descriptorStat = fstatSync(guard.descriptor);
    return (
      safeDirectoryStat(descriptorStat) &&
      sameDirectoryIdentity(guard.identity, fileIdentity(descriptorStat))
    );
  } catch {
    return false;
  }
}

function closeGuards(guards: readonly DirectoryGuard[]): void {
  for (const guard of guards) {
    if (guard.descriptor !== undefined) closeSync(guard.descriptor);
  }
}

function readExact(descriptor: number, size: number): Buffer | undefined {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, bytes, offset, size - offset, null);
    if (count <= 0) return undefined;
    offset += count;
  }
  const extra = Buffer.allocUnsafe(1);
  return readSync(descriptor, extra, 0, 1, null) === 0 ? bytes : undefined;
}

function sourceStillSame(snapshot: SourceSnapshot): boolean {
  try {
    const opened = fstatSync(snapshot.descriptor);
    const pathname = lstatSync(snapshot.path);
    return (
      safeFileStat(opened) &&
      safeFileStat(pathname) &&
      sameIdentity(snapshot.identity, fileIdentity(opened)) &&
      sameIdentity(snapshot.identity, fileIdentity(pathname)) &&
      snapshot.guards.every(directoryStillSame)
    );
  } catch {
    return false;
  }
}

interface SourceDirectories {
  readonly status: "ready";
  readonly updatesPath: string;
  readonly guards: readonly DirectoryGuard[];
}

function openSourceDirectories(stateDir: string): SourceDirectories | SourceOpenResult {
  const stateGuard = openDirectoryGuard(stateDir);
  if (stateGuard === undefined) return { status: "deferred", reason: "source-unsafe" };
  const updatesPath = join(stateDir, "updates");
  let updatesGuard: DirectoryGuard | undefined;
  try {
    updatesGuard = openDirectoryGuard(updatesPath);
  } catch (error) {
    closeGuards([stateGuard]);
    return errorCode(error) === "ENOENT"
      ? { status: "absent" }
      : { status: "deferred", reason: "source-unsafe" };
  }
  if (updatesGuard === undefined) {
    closeGuards([stateGuard]);
    return { status: "deferred", reason: "source-unsafe" };
  }
  return { status: "ready", updatesPath, guards: [stateGuard, updatesGuard] };
}

function invalidSourceStatReason(
  stat: ReturnType<typeof fstatSync>,
): LegacyUpdateAuditImportDeferredReason | undefined {
  if (!safeFileStat(stat)) return "source-unsafe";
  if (stat.size <= 0) return "source-invalid";
  if (stat.size > MAX_SOURCE_BYTES) return "source-too-large";
  return undefined;
}

function openSourceFile(directories: SourceDirectories): SourceOpenResult {
  const { guards, updatesPath } = directories;
  const path = join(updatesPath, SOURCE_FILE);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag());
  } catch (error) {
    closeGuards(guards);
    return errorCode(error) === "ENOENT"
      ? { status: "absent" }
      : { status: "deferred", reason: "source-unsafe" };
  }
  try {
    const opened = fstatSync(descriptor);
    const invalidReason = invalidSourceStatReason(opened);
    if (invalidReason !== undefined) {
      closeSync(descriptor);
      closeGuards(guards);
      return { status: "deferred", reason: invalidReason };
    }
    const identity = fileIdentity(opened);
    const bytes = readExact(descriptor, opened.size);
    const snapshot = { path, descriptor, identity, guards, bytes: bytes ?? Buffer.alloc(0) };
    if (bytes === undefined || !sourceStillSame(snapshot)) {
      closeSync(descriptor);
      closeGuards(guards);
      return { status: "deferred", reason: "source-mutated" };
    }
    return { status: "ready", snapshot };
  } catch {
    closeSync(descriptor);
    closeGuards(guards);
    return { status: "deferred", reason: "source-unsafe" };
  }
}

function openSourceSnapshot(stateDir: string): SourceOpenResult {
  const directories = openSourceDirectories(stateDir);
  return directories.status === "ready" && "updatesPath" in directories
    ? openSourceFile(directories)
    : directories;
}

function closeSource(snapshot: SourceSnapshot): void {
  closeSync(snapshot.descriptor);
  closeGuards(snapshot.guards);
}

function skipWhitespace(text: string, offset: number): number {
  let next = offset;
  while (next < text.length && /\s/u.test(text[next] ?? "")) next += 1;
  return next;
}

function stringTokenEnd(text: string, offset: number): number | undefined {
  if (text[offset] !== '"') return undefined;
  let escaped = false;
  for (let index = offset + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === '"') return index + 1;
  }
  return undefined;
}

function primitiveEnd(text: string, offset: number): number | undefined {
  if (text[offset] === '"') return stringTokenEnd(text, offset);
  const delimiters = [text.indexOf(",", offset), text.indexOf("}", offset)].filter(
    (index) => index >= 0,
  );
  const delimiter = Math.min(...delimiters);
  if (!Number.isFinite(delimiter)) return undefined;
  const token = text.slice(offset, delimiter).trimEnd();
  if (token.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(token);
    return parsed === null || typeof parsed === "boolean" || typeof parsed === "number"
      ? offset + token.length
      : undefined;
  } catch {
    return undefined;
  }
}

interface FlatObjectKey {
  readonly key: string;
  readonly end: number;
}

function flatObjectKey(
  text: string,
  offset: number,
  seen: ReadonlySet<string>,
): FlatObjectKey | undefined {
  const end = stringTokenEnd(text, offset);
  if (end === undefined) return undefined;
  try {
    const key: unknown = JSON.parse(text.slice(offset, end));
    return typeof key === "string" && !seen.has(key) ? { key, end } : undefined;
  } catch {
    return undefined;
  }
}

function completedFlatKeys(
  text: string,
  offset: number,
  keys: readonly string[],
): readonly string[] | undefined {
  return skipWhitespace(text, offset + 1) === text.length ? keys : undefined;
}

function flatObjectKeys(text: string): readonly string[] | undefined {
  let offset = skipWhitespace(text, 0);
  if (text[offset] !== "{") return undefined;
  offset = skipWhitespace(text, offset + 1);
  const keys: string[] = [];
  const seen = new Set<string>();
  if (text[offset] === "}") return completedFlatKeys(text, offset, keys);
  while (offset < text.length) {
    const decoded = flatObjectKey(text, offset, seen);
    if (decoded === undefined) return undefined;
    seen.add(decoded.key);
    keys.push(decoded.key);
    offset = skipWhitespace(text, decoded.end);
    if (text[offset] !== ":") return undefined;
    offset = skipWhitespace(text, offset + 1);
    const valueEnd = primitiveEnd(text, offset);
    if (valueEnd === undefined) return undefined;
    offset = skipWhitespace(text, valueEnd);
    if (text[offset] === "}") {
      return completedFlatKeys(text, offset, keys);
    }
    if (text[offset] !== ",") return undefined;
    offset = skipWhitespace(text, offset + 1);
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function safeText(value: unknown, max = 256): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max && SAFE_TEXT.test(value)
  );
}

function validIsoTimestamp(value: unknown): value is string {
  if (!safeText(value, 32)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function hasOnlyFields(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(record).every((field) => allowed.has(field));
}

function optionalVocabulary(
  record: Readonly<Record<string, unknown>>,
  name: string,
  vocabulary: ReadonlySet<string>,
): boolean {
  const value = record[name];
  return value === undefined || (typeof value === "string" && vocabulary.has(value));
}

function canonicalLegacyValue(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const field of LEGACY_FIELDS) {
    if (record[field] !== undefined) ordered[field] = record[field];
  }
  return ordered;
}

function validLegacyTextFields(record: Readonly<Record<string, unknown>>): boolean {
  const patterns: readonly [string, RegExp][] = [
    ["targetVersion", SEMVER],
    ["snapshotId", MACHINE_UUID],
    ["portableStageId", PORTABLE_OPERATION_ID],
    ["portableActivationId", PORTABLE_OPERATION_ID],
    ["portableAssetName", SAFE_BASENAME],
    ["portableSidecarName", SAFE_BASENAME],
    ["portableSidecarKind", SIDECAR_KIND],
    ["portableSidecarVersion", SEMVER],
  ];
  return patterns.every(([field, pattern]) => optionalPattern(record[field], pattern));
}

function validLegacyVocabularyFields(record: Readonly<Record<string, unknown>>): boolean {
  const fields: readonly [string, ReadonlySet<string>][] = [
    ["portableTarget", TARGETS],
    ["portableSidecarTarget", TARGETS],
    ["portableSidecarStatus", SIDECAR_STATUSES],
    ["portableSidecarFailureCode", SIDECAR_FAILURE_CODES],
    ["store", STORES],
    ["remediation", REMEDIATIONS],
    ["status", STATUSES],
    ["warningCode", WARNING_CODES],
  ];
  return fields.every(([field, vocabulary]) => optionalVocabulary(record, field, vocabulary));
}

function optionalPattern(value: unknown, pattern: RegExp): boolean {
  return value === undefined || (typeof value === "string" && pattern.test(value));
}

function validLegacyDigestFields(record: Readonly<Record<string, unknown>>): boolean {
  return (
    optionalPattern(record.portableAssetSha256, SHA256) &&
    optionalPattern(record.portableSidecarPayloadSha256, SHA256) &&
    optionalPattern(record.portableSidecarPayloadSha256Prefix, SHA256_PREFIX)
  );
}

function validLegacyRequiredFields(record: Readonly<Record<string, unknown>>): boolean {
  return (
    record.schemaVersion === 1 &&
    typeof record.eventId === "string" &&
    MACHINE_UUID.test(record.eventId) &&
    typeof record.type === "string" &&
    EVENT_TYPES.has(record.type) &&
    validIsoTimestamp(record.occurredAt)
  );
}

function validLegacyAssetSize(record: Readonly<Record<string, unknown>>): boolean {
  return (
    record.portableAssetSizeBytes === undefined ||
    (Number.isSafeInteger(record.portableAssetSizeBytes) &&
      Number(record.portableAssetSizeBytes) >= 0)
  );
}

function validLegacyRecord(record: Readonly<Record<string, unknown>>): boolean {
  const validators = [
    validLegacyRequiredFields,
    (value: Readonly<Record<string, unknown>>): boolean => hasOnlyFields(value, LEGACY_FIELD_SET),
    validLegacyTextFields,
    validLegacyVocabularyFields,
    validLegacyDigestFields,
    validLegacyAssetSize,
  ];
  return validators.every((validate) => validate(record));
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseLegacyLine(line: string): LegacyEvent | undefined {
  const keys = flatObjectKeys(line);
  if (keys === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    !isPlainRecord(parsed) ||
    keys.length !== Object.keys(parsed).length ||
    !validLegacyRecord(parsed)
  ) {
    return undefined;
  }
  const value = canonicalLegacyValue(parsed);
  const canonical = JSON.stringify(value);
  const digest = hash(`KLA1\n${canonical}`);
  const importedId = `legacy-audit-event-${digest}`;
  return { value, canonical, importedId };
}

function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function addLegacyLine(byLegacyId: Map<string, LegacyEvent>, line: string): boolean {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return false;
  const event = parseLegacyLine(line);
  if (event === undefined) return false;
  const legacyId = event.value.eventId as string;
  const prior = byLegacyId.get(legacyId);
  if (prior !== undefined && prior.canonical !== event.canonical) return false;
  if (prior === undefined) byLegacyId.set(legacyId, event);
  return true;
}

function parseSnapshot(bytes: Buffer): readonly LegacyEvent[] | undefined {
  const text = decodeUtf8(bytes);
  if (!text?.endsWith("\n")) return undefined;
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.length > MAX_SOURCE_EVENTS) return undefined;
  const byLegacyId = new Map<string, LegacyEvent>();
  for (const line of lines) {
    if (!addLegacyLine(byLegacyId, line)) return undefined;
  }
  return [...byLegacyId.values()];
}

function idSetDigest(ids: readonly string[]): string {
  const framed = ids.map((id) => `${String(Buffer.byteLength(id, "utf8"))}:${id}`).join("");
  return hash(`KLI1\n${framed}`);
}

function prepareImport(snapshot: SourceSnapshot): PreparedImport | undefined {
  const events = parseSnapshot(snapshot.bytes);
  if (events === undefined) return undefined;
  const sourceDigest = hash(snapshot.bytes);
  const ids = events.map((event) => event.importedId);
  return {
    events,
    sourceDigest,
    importId: `legacy-audit-${sourceDigest}`,
    importedIdSetDigest: idSetDigest(ids),
  };
}

function importedEventExtra(event: LegacyEvent): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {
    historical: true,
    sourceSchemaVersion: 1,
    eventId: event.importedId,
    legacyEventId: event.value.eventId,
  };
  for (const field of LEGACY_FIELDS.slice(2)) {
    if (event.value[field] !== undefined) extra[field] = event.value[field];
  }
  const redacted = redactLogFields(extra);
  return redacted !== undefined && JSON.stringify(redacted) === JSON.stringify(extra)
    ? extra
    : undefined;
}

function importedEventLog(event: LegacyEvent): ServerLogEvent | undefined {
  const extra = importedEventExtra(event);
  return extra === undefined
    ? undefined
    : { level: "info", category: "diagnostic", op: "update.runtime.event", extra };
}

function completionLog(prepared: PreparedImport): ServerLogEvent {
  return {
    level: "info",
    category: "diagnostic",
    op: "update.runtime.legacy-snapshot-imported",
    extra: {
      historical: true,
      sourceSchemaVersion: 1,
      importId: prepared.importId,
      sourceDigest: prepared.sourceDigest,
      importedIdSetDigest: prepared.importedIdSetDigest,
      importedCount: prepared.events.length,
    },
  };
}

function logFileNames(directory: string): readonly string[] | undefined {
  const names: string[] = [];
  let entries = 0;
  const stream = opendirSync(directory);
  try {
    for (;;) {
      const entry = stream.readSync();
      if (entry === null) break;
      entries += 1;
      if (entries > MAX_LOG_DIRECTORY_ENTRIES) return undefined;
      if (entry.name !== CURRENT_LOG_FILE && !ROTATED_LOG_FILE.test(entry.name)) continue;
      names.push(entry.name);
      if (names.length > MAX_LOG_FILES) return undefined;
    }
  } finally {
    stream.closeSync();
  }
  return names.sort((left, right) => left.localeCompare(right, "en-US"));
}

function readStableLogFile(path: string, remainingBytes: number): Buffer | "too-large" | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDWR | constants.O_NONBLOCK | noFollowFlag());
    const before = fstatSync(descriptor);
    if (!safeFileStat(before)) return undefined;
    if (before.size > remainingBytes) return "too-large";
    const identity = fileIdentity(before);
    const bytes = readExact(descriptor, before.size);
    fsyncSync(descriptor);
    const after = fstatSync(descriptor);
    const pathname = lstatSync(path);
    return bytes !== undefined &&
      safeFileStat(after) &&
      safeFileStat(pathname) &&
      sameIdentity(identity, fileIdentity(after)) &&
      sameIdentity(identity, fileIdentity(pathname))
      ? bytes
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validEnvelopeIdentity(record: Readonly<Record<string, unknown>>): boolean {
  return (
    record.schemaVersion === 2 &&
    Number.isSafeInteger(record.pid) &&
    Number(record.pid) >= 1 &&
    typeof record.instanceId === "string" &&
    INSTANCE_ID.test(record.instanceId) &&
    Number.isSafeInteger(record.seq) &&
    Number(record.seq) >= 1
  );
}

function validEnvelope(record: Readonly<Record<string, unknown>>, op: string): boolean {
  return (
    validEnvelopeIdentity(record) &&
    validIsoTimestamp(record.ts) &&
    record.level === "info" &&
    record.category === "diagnostic" &&
    record.op === op
  );
}

function validImportedRecordHeader(record: Readonly<Record<string, unknown>>): boolean {
  return (
    validEnvelope(record, "update.runtime.event") &&
    hasOnlyFields(record, IMPORTED_LOG_FIELD_SET) &&
    record.historical === true &&
    record.sourceSchemaVersion === 1 &&
    safeText(record.legacyEventId, 128) &&
    typeof record.eventId === "string" &&
    IMPORTED_EVENT_ID.test(record.eventId)
  );
}

function legacyFromImportedRecord(
  record: Readonly<Record<string, unknown>>,
): LegacyEvent | undefined {
  if (!validImportedRecordHeader(record)) return undefined;
  const legacy: Record<string, unknown> = { schemaVersion: 1, eventId: record.legacyEventId };
  for (const field of LEGACY_FIELDS.slice(2)) {
    if (record[field] !== undefined) legacy[field] = record[field];
  }
  const event = parseLegacyLine(JSON.stringify(legacy));
  return event?.importedId === record.eventId ? event : undefined;
}

function matchingCompletion(
  record: Readonly<Record<string, unknown>>,
  prepared: PreparedImport,
): boolean | "conflict" {
  if (record.op !== "update.runtime.legacy-snapshot-imported") return false;
  if (record.importId !== prepared.importId) return false;
  return validEnvelope(record, "update.runtime.legacy-snapshot-imported") &&
    hasOnlyFields(record, COMPLETION_LOG_FIELD_SET) &&
    record.historical === true &&
    record.sourceSchemaVersion === 1 &&
    record.sourceDigest === prepared.sourceDigest &&
    record.importedIdSetDigest === prepared.importedIdSetDigest &&
    record.importedCount === prepared.events.length
    ? true
    : "conflict";
}

function inspectLogRecord(
  record: Readonly<Record<string, unknown>>,
  prepared: PreparedImport,
  represented: Map<string, string>,
): "complete" | "continue" | "invalid" {
  const completion = matchingCompletion(record, prepared);
  if (completion === true) return "complete";
  if (completion === "conflict") return "invalid";
  if (record.op !== "update.runtime.event" || record.historical !== true) return "continue";
  const event = legacyFromImportedRecord(record);
  if (event === undefined) return "invalid";
  const prior = represented.get(event.importedId);
  if (prior !== undefined && prior !== event.canonical) return "invalid";
  represented.set(event.importedId, event.canonical);
  return "continue";
}

type RelevantLogLine = Readonly<Record<string, unknown>> | "skip" | "invalid";

function parseRelevantLogLine(line: string): RelevantLogLine {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return "invalid";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return "skip";
  }
  if (!isPlainRecord(parsed)) return "skip";
  const relevant =
    parsed.op === "update.runtime.event" || parsed.op === "update.runtime.legacy-snapshot-imported";
  if (!relevant) return "skip";
  const keys = flatObjectKeys(line);
  return keys?.length === Object.keys(parsed).length ? parsed : "invalid";
}

function countsTowardRelevantCap(record: Readonly<Record<string, unknown>>): boolean {
  return (
    (record.op === "update.runtime.event" && record.historical === true) ||
    record.op === "update.runtime.legacy-snapshot-imported"
  );
}

function inspectScannedLine(
  line: string,
  prepared: PreparedImport,
  represented: Map<string, string>,
  relevantCount: { value: number },
): "complete" | "continue" | "invalid" {
  const parsed = parseRelevantLogLine(line);
  if (parsed === "invalid") return "invalid";
  if (parsed === "skip") return "continue";
  if (countsTowardRelevantCap(parsed)) {
    relevantCount.value += 1;
    if (relevantCount.value > MAX_RELEVANT_LOG_RECORDS) return "invalid";
  }
  return inspectLogRecord(parsed, prepared, represented);
}

function scanLogBytes(
  bytes: Buffer,
  prepared: PreparedImport,
  represented: Map<string, string>,
  relevantCount: { value: number },
): "complete" | "ready" | "invalid" {
  if (bytes.length === 0) return "ready";
  const text = decodeUtf8(bytes);
  if (!text?.endsWith("\n")) return "invalid";
  let complete = false;
  for (const line of text.slice(0, -1).split("\n")) {
    const result = inspectScannedLine(line, prepared, represented, relevantCount);
    if (result === "invalid") return "invalid";
    if (result === "complete") complete = true;
  }
  return complete ? "complete" : "ready";
}

function scanDestinationFiles(
  directory: string,
  names: readonly string[],
  prepared: PreparedImport,
): DestinationScan {
  const represented = new Map<string, string>();
  const relevantCount = { value: 0 };
  let totalBytes = 0;
  let complete = false;
  for (const name of names) {
    const bytes = readStableLogFile(join(directory, name), MAX_LOG_SCAN_BYTES - totalBytes);
    if (bytes === "too-large") return { status: "deferred", reason: "destination-too-large" };
    if (bytes === undefined) return { status: "deferred", reason: "destination-unsafe" };
    totalBytes += bytes.length;
    const result = scanLogBytes(bytes, prepared, represented, relevantCount);
    if (result === "complete") complete = true;
    if (result === "invalid") return { status: "deferred", reason: "destination-invalid" };
  }
  return complete
    ? { status: "complete" }
    : { status: "ready", representedIds: new Set(represented.keys()) };
}

function scanDestination(directory: string, prepared: PreparedImport): DestinationScan {
  const guard = openDirectoryGuard(directory);
  if (guard === undefined) return { status: "deferred", reason: "destination-unsafe" };
  try {
    const names = logFileNames(directory);
    if (names === undefined) return { status: "deferred", reason: "destination-too-large" };
    const result = scanDestinationFiles(directory, names, prepared);
    if (!directoryStillSame(guard)) {
      return { status: "deferred", reason: "destination-mutated" };
    }
    return result;
  } catch {
    return { status: "deferred", reason: "destination-unsafe" };
  } finally {
    closeGuards([guard]);
  }
}

function destinationReason(reason: string): LegacyUpdateAuditImportDeferredReason {
  if (reason === "destination-mutated") return "destination-mutated";
  if (reason === "append-failed") return "append-failed";
  if (reason === "durability-uncertain") return "durability-uncertain";
  return "destination-unsafe";
}

function importPrepared(
  options: ImportLegacyUpdateAuditSnapshotOptions,
  snapshot: SourceSnapshot,
  prepared: PreparedImport,
): LegacyUpdateAuditImportOutcome {
  let scanReason: LegacyUpdateAuditImportDeferredReason = "destination-invalid";
  const result = appendDurableServerLogBatch(options.stateDir, {
    level: options.level,
    inspect: (directory) => {
      const scan = scanDestination(directory, prepared);
      if (!sourceStillSame(snapshot)) {
        scanReason = "source-mutated";
        return { status: "deferred" };
      }
      if (scan.status === "complete") return { status: "already-complete" };
      if (scan.status === "deferred") {
        scanReason = scan.reason ?? "destination-invalid";
        return { status: "deferred" };
      }
      const represented = scan.representedIds ?? new Set<string>();
      const events = prepared.events
        .filter((event) => !represented.has(event.importedId))
        .map(importedEventLog);
      if (events.includes(undefined)) {
        scanReason = "source-invalid";
        return { status: "deferred" };
      }
      return {
        status: "append",
        events: [...(events as ServerLogEvent[]), completionLog(prepared)],
      };
    },
  });
  if (result.status === "already-complete") {
    return sourceStillSame(snapshot)
      ? { status: "already-imported", importId: prepared.importId }
      : { status: "deferred", reason: "source-mutated" };
  }
  if (result.status === "inspection-deferred") return { status: "deferred", reason: scanReason };
  if (result.status === "deferred") {
    return { status: "deferred", reason: destinationReason(result.reason) };
  }
  if (!sourceStillSame(snapshot)) return { status: "deferred", reason: "source-mutated" };
  return { status: "imported", importId: prepared.importId, importedCount: prepared.events.length };
}

function runLegacyUpdateAuditImport(
  options: ImportLegacyUpdateAuditSnapshotOptions,
): LegacyUpdateAuditImportOutcome {
  // The source is intentionally not even inspected when info records are disabled. A successful
  // import means durable representation in the canonical log; silently filtering the records
  // cannot satisfy that contract.
  if (!serverLogLevelEnabled("info", options.level)) {
    return { status: "deferred", reason: "log-level-filtered" };
  }
  const opened = openSourceSnapshot(options.stateDir);
  if (opened.status !== "ready") return opened;
  const { snapshot } = opened;
  try {
    if (snapshot.bytes.length > MAX_SOURCE_BYTES) {
      return { status: "deferred", reason: "source-too-large" };
    }
    const prepared = prepareImport(snapshot);
    if (prepared === undefined) return { status: "deferred", reason: "source-invalid" };
    return importPrepared(options, snapshot, prepared);
  } finally {
    closeSource(snapshot);
  }
}

export function importLegacyUpdateAuditSnapshot(
  options: ImportLegacyUpdateAuditSnapshotOptions,
): LegacyUpdateAuditImportOutcome {
  try {
    return runLegacyUpdateAuditImport(options);
  } catch {
    // Compatibility import is evidence maintenance, never startup authority. Unexpected
    // filesystem/runtime failures therefore retain the source and defer to a later launch.
    return { status: "deferred", reason: "source-unsafe" };
  }
}
