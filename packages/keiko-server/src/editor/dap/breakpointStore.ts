import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
  DEFAULT_DEBUG_PAYLOAD_LIMITS,
  type ExceptionBreakpointFilter,
  type InstrumentationSnapshot,
  type SourceBreakpoint,
  type WatchExpression,
} from "@oscharko-dev/keiko-contracts";
import { containsPath } from "@oscharko-dev/keiko-git";

import { assertNoSymlinkedPathSegments, savePrivateJson } from "../../private-json.js";

const MAX_RECORD_BYTES = 512 * 1024;
const MAX_BREAKPOINTS_PER_FILE = DEFAULT_DEBUG_PAYLOAD_LIMITS.maxBreakpointsPerFile;
const MAX_BREAKPOINTS_PER_WORKSPACE = DEFAULT_DEBUG_PAYLOAD_LIMITS.maxBreakpointsPerWorkspace;
const MAX_WATCHES = DEFAULT_DEBUG_PAYLOAD_LIMITS.maxWatches;
const MAX_EXCEPTION_FILTERS = DEFAULT_DEBUG_PAYLOAD_LIMITS.maxExceptionFilters;
const MAX_INSTRUMENTATION_TEXT_BYTES = DEFAULT_DEBUG_PAYLOAD_LIMITS.maxConditionBytes;
const MAX_FILE_ID_BYTES = 4096;
const MAX_ID_ATTEMPTS = 32;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const NODE_EXCEPTION_FILTERS: readonly ExceptionBreakpointFilter[] = [
  { filterId: "uncaught", enabled: false },
  { filterId: "caught", enabled: false },
];

export const BREAKPOINT_STORE_LIMITS = Object.freeze({
  maxRecordBytes: MAX_RECORD_BYTES,
  maxBreakpointsPerFile: MAX_BREAKPOINTS_PER_FILE,
  maxBreakpointsPerWorkspace: MAX_BREAKPOINTS_PER_WORKSPACE,
  maxWatches: MAX_WATCHES,
  maxExceptionFilters: MAX_EXCEPTION_FILTERS,
  maxInstrumentationTextBytes: MAX_INSTRUMENTATION_TEXT_BYTES,
});

export interface RequestedSourceBreakpoint {
  readonly line: number;
  readonly column?: number | undefined;
  readonly enabled: boolean;
  readonly condition?: string | undefined;
  readonly hitCondition?: string | undefined;
  readonly logMessage?: string | undefined;
}

export interface BreakpointVerificationUpdate {
  readonly id: string;
  readonly verification: SourceBreakpoint["verification"];
}

export interface RequestedWatchExpression {
  readonly expression: string;
  readonly enabled: boolean;
}

export interface RequestedExceptionBreakpointFilter {
  readonly filterId: string;
  readonly enabled: boolean;
  readonly condition?: string | undefined;
}

interface InstrumentationRecord {
  readonly schemaVersion: typeof DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
  readonly workspaceFingerprint: string;
  readonly revision: number;
  readonly breakpoints: readonly SourceBreakpoint[];
  readonly exceptionFilters: readonly ExceptionBreakpointFilter[];
  readonly watches: readonly WatchExpression[];
}

export type BreakpointStoreRejectionReason =
  "state_unavailable" | "conflict" | "cap_exceeded" | "invalid";

export type BreakpointStoreSnapshotResult =
  | { readonly ok: true; readonly snapshot: InstrumentationSnapshot }
  | {
      readonly ok: false;
      readonly reason: "state_unavailable";
      readonly snapshot: InstrumentationSnapshot;
    };

export type BreakpointStoreMutationResult =
  | {
      readonly ok: true;
      readonly snapshot: InstrumentationSnapshot;
      readonly retainedCount: number;
      readonly rejectedCount: 0;
    }
  | {
      readonly ok: false;
      readonly reason: BreakpointStoreRejectionReason;
      readonly snapshot: InstrumentationSnapshot;
      readonly retainedCount: number;
      readonly rejectedCount: number;
    };

export interface BreakpointStore {
  readonly stateDir: string;
  readonly snapshot: (realRoot: string) => BreakpointStoreSnapshotResult;
  readonly setBreakpointsForFile: (
    realRoot: string,
    expectedRevision: number,
    expectedEtag: string,
    fileId: string,
    requested: readonly RequestedSourceBreakpoint[],
  ) => BreakpointStoreMutationResult;
  readonly setWatches: (
    realRoot: string,
    expectedRevision: number,
    expectedEtag: string,
    requested: readonly RequestedWatchExpression[],
  ) => BreakpointStoreMutationResult;
  readonly setExceptionBreakpoints: (
    realRoot: string,
    expectedRevision: number,
    expectedEtag: string,
    requested: readonly RequestedExceptionBreakpointFilter[],
  ) => BreakpointStoreMutationResult;
  readonly setBreakpointVerifications: (
    realRoot: string,
    expectedRevision: number,
    expectedEtag: string,
    fileId: string,
    updates: readonly BreakpointVerificationUpdate[],
  ) => BreakpointStoreMutationResult;
  readonly clearAll: (
    realRoot: string,
    expectedRevision: number,
    expectedEtag: string,
  ) => BreakpointStoreMutationResult;
}

export interface BreakpointStoreOptions {
  readonly stateDir: string;
  readonly save?: ((path: string, value: Record<string, unknown>) => void) | undefined;
  readonly read?: ((path: string) => string) | undefined;
  readonly size?: ((path: string) => number) | undefined;
  readonly idFactory?: (() => string) | undefined;
}

type UnknownRecord = Readonly<Record<string, unknown>>;
type LoadResult =
  | { readonly state: "absent" | "ready"; readonly record: InstrumentationRecord }
  | { readonly state: "unavailable"; readonly record: InstrumentationRecord };
type RawLoadResult =
  { readonly kind: "missing" } | { readonly kind: "text"; readonly text: string };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function breakpointStoreWorkspaceFingerprint(realRoot: string): string {
  return sha256(realRoot);
}

export function breakpointStoreRecordPath(stateDir: string, realRoot: string): string {
  return join(
    stateDir,
    `debug-instrumentation-${breakpointStoreWorkspaceFingerprint(realRoot)}.json`,
  );
}

function emptyRecord(realRoot: string): InstrumentationRecord {
  return {
    schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
    workspaceFingerprint: breakpointStoreWorkspaceFingerprint(realRoot),
    revision: 0,
    breakpoints: [],
    exceptionFilters: NODE_EXCEPTION_FILTERS.map((filter) => ({ ...filter })),
    watches: [],
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === value.length && keys.every((key, index) => key === String(index));
}

function isNonnegativeRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validBoundedText(value: unknown, allowEmpty = true): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    !value.includes("\u0000") &&
    utf8Bytes(value) <= MAX_INSTRUMENTATION_TEXT_BYTES
  );
}

function validOptionalText(value: unknown): value is string | undefined {
  return value === undefined || validBoundedText(value);
}

function validFileId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || utf8Bytes(value) > MAX_FILE_ID_BYTES) {
    return false;
  }
  if (isAbsolute(value) || value.includes("\\") || value.includes("\0")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function parseBreakpoint(value: unknown): SourceBreakpoint | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, breakpointKeys())) return undefined;
  if (!validBreakpointFields(value)) return undefined;
  return {
    id: value.id,
    fileId: value.fileId,
    line: value.line,
    enabled: value.enabled,
    kind: value.kind,
    verification: value.verification,
    ...(value.column === undefined ? {} : { column: value.column }),
    ...(value.condition === undefined ? {} : { condition: value.condition }),
    ...(value.hitCondition === undefined ? {} : { hitCondition: value.hitCondition }),
    ...(value.logMessage === undefined ? {} : { logMessage: value.logMessage }),
  };
}

function breakpointKeys(): readonly string[] {
  return [
    "id",
    "fileId",
    "line",
    "column",
    "enabled",
    "kind",
    "condition",
    "hitCondition",
    "logMessage",
    "verification",
  ];
}

function validBreakpointFields(value: UnknownRecord): value is UnknownRecord & SourceBreakpoint {
  return (
    validOpaqueId(value.id) &&
    validFileId(value.fileId) &&
    validBreakpointPosition(value) &&
    validBreakpointVocabulary(value) &&
    validBreakpointText(value)
  );
}

function validBreakpointPosition(value: UnknownRecord): boolean {
  return (
    isPositiveInteger(value.line) && (value.column === undefined || isPositiveInteger(value.column))
  );
}

function validBreakpointVocabulary(value: UnknownRecord): boolean {
  const validKind =
    value.kind === "line" || value.kind === "conditional" || value.kind === "logpoint";
  const verification = value.verification;
  const validVerification =
    verification === "pending" || verification === "verified" || verification === "rejected";
  return (
    typeof value.enabled === "boolean" &&
    validKind &&
    validVerification &&
    breakpointKindMatchesText(value)
  );
}

function breakpointKindMatchesText(value: UnknownRecord): boolean {
  if (value.kind === "line") {
    return (
      value.condition === undefined &&
      value.hitCondition === undefined &&
      value.logMessage === undefined
    );
  }
  if (value.kind === "conditional") {
    return (
      (value.condition !== undefined || value.hitCondition !== undefined) &&
      value.logMessage === undefined
    );
  }
  return value.kind === "logpoint" && value.logMessage !== undefined;
}

function validBreakpointText(value: UnknownRecord): boolean {
  return (
    validOptionalText(value.condition) &&
    validOptionalText(value.hitCondition) &&
    validOptionalText(value.logMessage)
  );
}

function parseWatch(value: unknown): WatchExpression | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["watchId", "expression", "enabled"])) {
    return undefined;
  }
  if (!validOpaqueId(value.watchId) || !validBoundedText(value.expression, false)) return undefined;
  if (typeof value.enabled !== "boolean") return undefined;
  return { watchId: value.watchId, expression: value.expression, enabled: value.enabled };
}

function parseBreakpoints(value: unknown): readonly SourceBreakpoint[] | undefined {
  if (!isDenseArray(value) || value.length > MAX_BREAKPOINTS_PER_WORKSPACE) return undefined;
  const parsed = value.map(parseBreakpoint);
  if (parsed.includes(undefined)) return undefined;
  const breakpoints = parsed as readonly SourceBreakpoint[];
  return validBreakpointCollection(breakpoints) ? breakpoints : undefined;
}

function validBreakpointCollection(breakpoints: readonly SourceBreakpoint[]): boolean {
  const ids = new Set<string>();
  const perFile = new Map<string, number>();
  for (const breakpoint of breakpoints) {
    if (ids.has(breakpoint.id)) return false;
    ids.add(breakpoint.id);
    const count = (perFile.get(breakpoint.fileId) ?? 0) + 1;
    if (count > MAX_BREAKPOINTS_PER_FILE) return false;
    perFile.set(breakpoint.fileId, count);
  }
  return true;
}

function parseWatches(value: unknown): readonly WatchExpression[] | undefined {
  if (!isDenseArray(value) || value.length > MAX_WATCHES) return undefined;
  const parsed = value.map(parseWatch);
  if (parsed.includes(undefined)) return undefined;
  const watches = parsed as readonly WatchExpression[];
  const ids = new Set(watches.map((watch) => watch.watchId));
  return ids.size === watches.length ? watches : undefined;
}

function parseExceptionFilter(value: unknown): ExceptionBreakpointFilter | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["filterId", "enabled", "condition"])) {
    return undefined;
  }
  if (
    !validOpaqueId(value.filterId) ||
    typeof value.enabled !== "boolean" ||
    !validOptionalText(value.condition)
  ) {
    return undefined;
  }
  return {
    filterId: value.filterId,
    enabled: value.enabled,
    ...(value.condition === undefined ? {} : { condition: value.condition }),
  };
}

function parseExceptionFilters(value: unknown): readonly ExceptionBreakpointFilter[] | undefined {
  if (!isDenseArray(value) || value.length > MAX_EXCEPTION_FILTERS) return undefined;
  const parsed = value.map(parseExceptionFilter);
  if (parsed.includes(undefined)) return undefined;
  const filters = parsed as readonly ExceptionBreakpointFilter[];
  return new Set(filters.map((filter) => filter.filterId)).size === filters.length
    ? filters
    : undefined;
}

function parseInstrumentationRecord(
  value: unknown,
  fingerprint: string,
): InstrumentationRecord | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = [
    "schemaVersion",
    "workspaceFingerprint",
    "revision",
    "breakpoints",
    "exceptionFilters",
    "watches",
  ];
  if (!hasOnlyKeys(value, allowed)) return undefined;
  if (value.schemaVersion !== DAP_DEBUG_CONTRACT_SCHEMA_VERSION) return undefined;
  if (value.workspaceFingerprint !== fingerprint || !isNonnegativeRevision(value.revision)) {
    return undefined;
  }
  const breakpoints = parseBreakpoints(value.breakpoints);
  const exceptionFilters = parseExceptionFilters(value.exceptionFilters);
  const watches = parseWatches(value.watches);
  if (breakpoints === undefined || exceptionFilters === undefined || watches === undefined) {
    return undefined;
  }
  return {
    schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
    workspaceFingerprint: fingerprint,
    revision: value.revision,
    breakpoints,
    exceptionFilters,
    watches,
  };
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function readPersistedText(path: string, options: BreakpointStoreOptions): RawLoadResult {
  try {
    assertPersistedSize(path, options);
    const text = options.read?.(path) ?? readFileSync(path, "utf8");
    if (utf8Bytes(text) > MAX_RECORD_BYTES) throw new Error("instrumentation state is oversized");
    return { kind: "text", text };
  } catch (error) {
    if (isMissingError(error)) return { kind: "missing" };
    throw error;
  }
}

function assertPersistedSize(path: string, options: BreakpointStoreOptions): void {
  const injectedSize = options.size?.(path);
  const diskSize =
    options.read === undefined && injectedSize === undefined ? statSync(path).size : 0;
  if ((injectedSize ?? diskSize) > MAX_RECORD_BYTES) {
    throw new Error("instrumentation state exceeds its private record limit");
  }
}

function safeRecordPath(path: string, stateDir: string, realRoot: string): boolean {
  if (containsPath(realRoot, stateDir)) return false;
  try {
    assertNoSymlinkedPathSegments(path);
    return true;
  } catch {
    return false;
  }
}

function loadRecord(realRoot: string, options: BreakpointStoreOptions): LoadResult {
  const empty = emptyRecord(realRoot);
  const path = breakpointStoreRecordPath(options.stateDir, realRoot);
  if (!safeRecordPath(path, options.stateDir, realRoot)) {
    return { state: "unavailable", record: empty };
  }
  try {
    const raw = readPersistedText(path, options);
    if (raw.kind === "missing") return { state: "absent", record: empty };
    const parsed = parseInstrumentationRecord(
      JSON.parse(raw.text) as unknown,
      empty.workspaceFingerprint,
    );
    return parsed === undefined
      ? { state: "unavailable", record: empty }
      : { state: "ready", record: parsed };
  } catch {
    return { state: "unavailable", record: empty };
  }
}

function recordForWrite(record: InstrumentationRecord): Record<string, unknown> {
  return {
    schemaVersion: record.schemaVersion,
    workspaceFingerprint: record.workspaceFingerprint,
    revision: record.revision,
    breakpoints: record.breakpoints.map(canonicalBreakpoint),
    exceptionFilters: record.exceptionFilters.map(canonicalExceptionFilter),
    watches: record.watches.map(canonicalWatch),
  };
}

function canonicalBreakpoint(value: SourceBreakpoint): SourceBreakpoint {
  return {
    id: value.id,
    fileId: value.fileId,
    line: value.line,
    enabled: value.enabled,
    kind: value.kind,
    verification: value.verification,
    ...(value.column === undefined ? {} : { column: value.column }),
    ...(value.condition === undefined ? {} : { condition: value.condition }),
    ...(value.hitCondition === undefined ? {} : { hitCondition: value.hitCondition }),
    ...(value.logMessage === undefined ? {} : { logMessage: value.logMessage }),
  };
}

function canonicalExceptionFilter(value: ExceptionBreakpointFilter): ExceptionBreakpointFilter {
  return {
    filterId: value.filterId,
    enabled: value.enabled,
    ...(value.condition === undefined ? {} : { condition: value.condition }),
  };
}

function canonicalWatch(value: WatchExpression): WatchExpression {
  return { watchId: value.watchId, expression: value.expression, enabled: value.enabled };
}

function recordEtag(record: InstrumentationRecord): string {
  return `"${sha256(JSON.stringify(recordForWrite(record)))}"`;
}

function freezeSnapshot(record: InstrumentationRecord): InstrumentationSnapshot {
  const breakpoints = record.breakpoints.map((breakpoint) => Object.freeze({ ...breakpoint }));
  const exceptionFilters = record.exceptionFilters.map((filter) => Object.freeze({ ...filter }));
  const watches = record.watches.map((watch) => Object.freeze({ ...watch }));
  Object.freeze(breakpoints);
  Object.freeze(exceptionFilters);
  Object.freeze(watches);
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    workspaceId: record.workspaceFingerprint,
    revision: record.revision,
    etag: recordEtag(record),
    breakpoints,
    exceptionFilters,
    watches,
  });
}

function rejected(
  reason: BreakpointStoreRejectionReason,
  record: InstrumentationRecord,
  retainedCount: number,
  rejectedCount: number,
): BreakpointStoreMutationResult {
  return { ok: false, reason, snapshot: freezeSnapshot(record), retainedCount, rejectedCount };
}

function expectedStateMatches(
  record: InstrumentationRecord,
  expectedRevision: number,
  expectedEtag: string,
): boolean {
  return record.revision === expectedRevision && recordEtag(record) === expectedEtag;
}

function validExpectedState(expectedRevision: number, expectedEtag: string): boolean {
  return isNonnegativeRevision(expectedRevision) && /^"[a-f0-9]{64}"$/u.test(expectedEtag);
}

function parseRequestedBreakpoint(value: unknown): RequestedSourceBreakpoint | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = ["line", "column", "enabled", "condition", "hitCondition", "logMessage"];
  if (!hasOnlyKeys(value, allowed) || !validRequestedBreakpointFields(value)) {
    return undefined;
  }
  return {
    line: value.line,
    enabled: value.enabled,
    ...(value.column === undefined ? {} : { column: value.column }),
    ...(value.condition === undefined ? {} : { condition: value.condition }),
    ...(value.hitCondition === undefined ? {} : { hitCondition: value.hitCondition }),
    ...(value.logMessage === undefined ? {} : { logMessage: value.logMessage }),
  };
}

function validRequestedBreakpointFields(
  value: UnknownRecord,
): value is UnknownRecord & RequestedSourceBreakpoint {
  return (
    isPositiveInteger(value.line) &&
    (value.column === undefined || isPositiveInteger(value.column)) &&
    typeof value.enabled === "boolean" &&
    validBreakpointText(value)
  );
}

function parseRequestedArray<T>(
  value: unknown,
  parser: (candidate: unknown) => T | undefined,
): readonly T[] | undefined {
  if (!isDenseArray(value)) return undefined;
  const parsed = value.map(parser);
  return parsed.includes(undefined) ? undefined : (parsed as readonly T[]);
}

function parseRequestedBreakpoints(
  value: unknown,
): readonly RequestedSourceBreakpoint[] | undefined {
  return parseRequestedArray(value, parseRequestedBreakpoint);
}

function parseRequestedWatch(value: unknown): RequestedWatchExpression | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["expression", "enabled"])) return undefined;
  if (!validBoundedText(value.expression, false) || typeof value.enabled !== "boolean") {
    return undefined;
  }
  return { expression: value.expression, enabled: value.enabled };
}

function parseRequestedWatches(value: unknown): readonly RequestedWatchExpression[] | undefined {
  return parseRequestedArray(value, parseRequestedWatch);
}

function parseRequestedExceptionFilter(
  value: unknown,
): RequestedExceptionBreakpointFilter | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["filterId", "enabled", "condition"])) {
    return undefined;
  }
  if (
    !validOpaqueId(value.filterId) ||
    typeof value.enabled !== "boolean" ||
    !validOptionalText(value.condition)
  ) {
    return undefined;
  }
  return {
    filterId: value.filterId,
    enabled: value.enabled,
    ...(value.condition === undefined ? {} : { condition: value.condition }),
  };
}

function parseRequestedExceptionFilters(
  value: unknown,
): readonly RequestedExceptionBreakpointFilter[] | undefined {
  if (!isDenseArray(value)) return undefined;
  const parsed = value.map(parseRequestedExceptionFilter);
  if (parsed.includes(undefined)) return undefined;
  const filters = parsed as readonly RequestedExceptionBreakpointFilter[];
  return new Set(filters.map((filter) => filter.filterId)).size === filters.length
    ? filters
    : undefined;
}

function sameBreakpointDrafts(
  current: readonly SourceBreakpoint[],
  requested: readonly RequestedSourceBreakpoint[],
): boolean {
  const projected = current.map(
    ({ id: _id, fileId: _fileId, kind: _kind, verification: _verification, ...draft }) => draft,
  );
  return JSON.stringify(projected) === JSON.stringify(requested);
}

function sameWatchDrafts(
  current: readonly WatchExpression[],
  requested: readonly RequestedWatchExpression[],
): boolean {
  const projected = current.map(({ watchId: _watchId, ...draft }) => draft);
  return JSON.stringify(projected) === JSON.stringify(requested);
}

function sameExceptionFilterDrafts(
  current: readonly ExceptionBreakpointFilter[],
  requested: readonly RequestedExceptionBreakpointFilter[],
): boolean {
  return JSON.stringify(current) === JSON.stringify(requested);
}

function mintIds(
  count: number,
  used: ReadonlySet<string>,
  idFactory: () => string,
): readonly string[] | undefined {
  const ids: string[] = [];
  const reserved = new Set(used);
  try {
    for (let index = 0; index < count; index += 1) {
      const id = mintOneId(reserved, idFactory);
      if (id === undefined) return undefined;
      reserved.add(id);
      ids.push(id);
    }
  } catch {
    return undefined;
  }
  return ids;
}

function mintOneId(reserved: ReadonlySet<string>, idFactory: () => string): string | undefined {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const candidate = idFactory();
    if (validOpaqueId(candidate) && !reserved.has(candidate)) return candidate;
  }
  return undefined;
}

function buildBreakpoints(
  fileId: string,
  requested: readonly RequestedSourceBreakpoint[],
  ids: readonly string[],
): readonly SourceBreakpoint[] {
  return requested.map((draft, index) => {
    const id = ids[index];
    if (id === undefined) throw new Error("breakpoint id allocation mismatch");
    return {
      id,
      fileId,
      ...draft,
      kind: breakpointKind(draft),
      verification: "pending",
    };
  });
}

function breakpointKind(draft: RequestedSourceBreakpoint): SourceBreakpoint["kind"] {
  if (draft.logMessage !== undefined) return "logpoint";
  return draft.condition !== undefined || draft.hitCondition !== undefined ? "conditional" : "line";
}

function buildWatches(
  requested: readonly RequestedWatchExpression[],
  ids: readonly string[],
): readonly WatchExpression[] {
  return requested.map((draft, index) => {
    const watchId = ids[index];
    if (watchId === undefined) throw new Error("watch id allocation mismatch");
    return { watchId, ...draft };
  });
}

function serializedRecordFits(record: InstrumentationRecord): boolean {
  return utf8Bytes(JSON.stringify(recordForWrite(record))) <= MAX_RECORD_BYTES;
}

function commitRecord(
  realRoot: string,
  record: InstrumentationRecord,
  options: BreakpointStoreOptions,
): boolean {
  const path = breakpointStoreRecordPath(options.stateDir, realRoot);
  if (!safeRecordPath(path, options.stateDir, realRoot) || !serializedRecordFits(record))
    return false;
  try {
    (options.save ?? savePrivateJson)(path, recordForWrite(record));
    return true;
  } catch {
    return false;
  }
}

function success(
  record: InstrumentationRecord,
  retainedCount: number,
): BreakpointStoreMutationResult {
  return { ok: true, snapshot: freezeSnapshot(record), retainedCount, rejectedCount: 0 };
}

function preflightMutation(
  load: LoadResult,
  expectedRevision: number,
  expectedEtag: string,
  rejectedCount: number,
): BreakpointStoreMutationResult | undefined {
  if (load.state === "unavailable") {
    return rejected("state_unavailable", load.record, 0, rejectedCount);
  }
  if (!validExpectedState(expectedRevision, expectedEtag)) {
    return rejected("invalid", load.record, 0, rejectedCount);
  }
  if (!expectedStateMatches(load.record, expectedRevision, expectedEtag)) {
    return rejected("conflict", load.record, 0, rejectedCount);
  }
  return undefined;
}

function setBreakpoints(
  options: BreakpointStoreOptions,
  realRoot: string,
  expectedRevision: number,
  expectedEtag: string,
  fileId: string,
  input: readonly RequestedSourceBreakpoint[],
): BreakpointStoreMutationResult {
  const load = loadRecord(realRoot, options);
  const preflight = preflightMutation(load, expectedRevision, expectedEtag, input.length);
  if (preflight !== undefined) return preflight;
  const requested = parseRequestedBreakpoints(input);
  if (!validFileId(fileId) || requested === undefined)
    return rejected("invalid", load.record, 0, input.length);
  const current = load.record.breakpoints.filter((entry) => entry.fileId === fileId);
  if (requested.length > MAX_BREAKPOINTS_PER_FILE) {
    return rejected("cap_exceeded", load.record, current.length, requested.length);
  }
  const retainedElsewhere = load.record.breakpoints.length - current.length;
  if (retainedElsewhere + requested.length > MAX_BREAKPOINTS_PER_WORKSPACE) {
    return rejected("cap_exceeded", load.record, current.length, requested.length);
  }
  if (sameBreakpointDrafts(current, requested)) return success(load.record, current.length);
  return commitBreakpointReplacement(options, realRoot, load.record, fileId, requested);
}

function commitBreakpointReplacement(
  options: BreakpointStoreOptions,
  realRoot: string,
  record: InstrumentationRecord,
  fileId: string,
  requested: readonly RequestedSourceBreakpoint[],
): BreakpointStoreMutationResult {
  const used = new Set(record.breakpoints.map((entry) => entry.id));
  const ids = mintIds(requested.length, used, options.idFactory ?? randomUUID);
  if (ids === undefined) return rejected("invalid", record, 0, requested.length);
  const retained = record.breakpoints.filter((entry) => entry.fileId !== fileId);
  const next = {
    ...record,
    revision: record.revision + 1,
    breakpoints: [...retained, ...buildBreakpoints(fileId, requested, ids)],
  };
  if (!serializedRecordFits(next)) return rejected("cap_exceeded", record, 0, requested.length);
  return commitRecord(realRoot, next, options)
    ? success(next, requested.length)
    : rejected("state_unavailable", record, 0, requested.length);
}

function parseVerificationUpdates(
  value: unknown,
): readonly BreakpointVerificationUpdate[] | undefined {
  if (!isDenseArray(value)) return undefined;
  const updates: BreakpointVerificationUpdate[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["id", "verification"])) return undefined;
    if (
      !validOpaqueId(entry.id) ||
      (entry.verification !== "pending" &&
        entry.verification !== "verified" &&
        entry.verification !== "rejected")
    ) {
      return undefined;
    }
    updates.push({ id: entry.id, verification: entry.verification });
  }
  return new Set(updates.map((update) => update.id)).size === updates.length ? updates : undefined;
}

function setBreakpointVerifications(
  options: BreakpointStoreOptions,
  realRoot: string,
  expectedRevision: number,
  expectedEtag: string,
  fileId: string,
  input: readonly BreakpointVerificationUpdate[],
): BreakpointStoreMutationResult {
  const load = loadRecord(realRoot, options);
  const preflight = preflightMutation(load, expectedRevision, expectedEtag, input.length);
  if (preflight !== undefined) return preflight;
  const updates = parseVerificationUpdates(input);
  const current = load.record.breakpoints.filter((breakpoint) => breakpoint.fileId === fileId);
  if (!validFileId(fileId) || updates?.length !== current.length) {
    return rejected("invalid", load.record, current.length, input.length);
  }
  const byId = new Map(updates.map((update) => [update.id, update.verification]));
  if (current.some((breakpoint) => !byId.has(breakpoint.id))) {
    return rejected("invalid", load.record, current.length, input.length);
  }
  const nextBreakpoints = load.record.breakpoints.map((breakpoint) =>
    breakpoint.fileId === fileId
      ? { ...breakpoint, verification: byId.get(breakpoint.id) ?? "pending" }
      : breakpoint,
  );
  if (JSON.stringify(nextBreakpoints) === JSON.stringify(load.record.breakpoints)) {
    return success(load.record, current.length);
  }
  const next = { ...load.record, revision: load.record.revision + 1, breakpoints: nextBreakpoints };
  return commitRecord(realRoot, next, options)
    ? success(next, current.length)
    : rejected("state_unavailable", load.record, current.length, input.length);
}

function setWatchExpressions(
  options: BreakpointStoreOptions,
  realRoot: string,
  expectedRevision: number,
  expectedEtag: string,
  input: readonly RequestedWatchExpression[],
): BreakpointStoreMutationResult {
  const load = loadRecord(realRoot, options);
  const preflight = preflightMutation(load, expectedRevision, expectedEtag, input.length);
  if (preflight !== undefined) return preflight;
  const requested = parseRequestedWatches(input);
  if (requested === undefined) return rejected("invalid", load.record, 0, input.length);
  if (requested.length > MAX_WATCHES) {
    return rejected("cap_exceeded", load.record, load.record.watches.length, requested.length);
  }
  if (sameWatchDrafts(load.record.watches, requested)) {
    return success(load.record, load.record.watches.length);
  }
  return commitWatchReplacement(options, realRoot, load.record, requested);
}

function commitWatchReplacement(
  options: BreakpointStoreOptions,
  realRoot: string,
  record: InstrumentationRecord,
  requested: readonly RequestedWatchExpression[],
): BreakpointStoreMutationResult {
  const used = new Set(record.watches.map((watch) => watch.watchId));
  const ids = mintIds(requested.length, used, options.idFactory ?? randomUUID);
  if (ids === undefined) return rejected("invalid", record, 0, requested.length);
  const next = { ...record, revision: record.revision + 1, watches: buildWatches(requested, ids) };
  if (!serializedRecordFits(next)) return rejected("cap_exceeded", record, 0, requested.length);
  return commitRecord(realRoot, next, options)
    ? success(next, requested.length)
    : rejected("state_unavailable", record, 0, requested.length);
}

function setExceptionFilters(
  options: BreakpointStoreOptions,
  realRoot: string,
  expectedRevision: number,
  expectedEtag: string,
  input: readonly RequestedExceptionBreakpointFilter[],
): BreakpointStoreMutationResult {
  const load = loadRecord(realRoot, options);
  const preflight = preflightMutation(load, expectedRevision, expectedEtag, input.length);
  if (preflight !== undefined) return preflight;
  const requested = parseRequestedExceptionFilters(input);
  if (requested === undefined) return rejected("invalid", load.record, 0, input.length);
  if (requested.length > MAX_EXCEPTION_FILTERS) {
    return rejected(
      "cap_exceeded",
      load.record,
      load.record.exceptionFilters.length,
      requested.length,
    );
  }
  if (sameExceptionFilterDrafts(load.record.exceptionFilters, requested)) {
    return success(load.record, load.record.exceptionFilters.length);
  }
  const next = {
    ...load.record,
    revision: load.record.revision + 1,
    exceptionFilters: requested,
  };
  if (!serializedRecordFits(next)) return rejected("cap_exceeded", load.record, 0, input.length);
  return commitRecord(realRoot, next, options)
    ? success(next, requested.length)
    : rejected("state_unavailable", load.record, 0, input.length);
}

function clearInstrumentation(
  options: BreakpointStoreOptions,
  realRoot: string,
  expectedRevision: number,
  expectedEtag: string,
): BreakpointStoreMutationResult {
  const load = loadRecord(realRoot, options);
  const preflight = preflightMutation(load, expectedRevision, expectedEtag, 0);
  if (preflight !== undefined) return preflight;
  if (
    load.record.breakpoints.length === 0 &&
    sameExceptionFilterDrafts(load.record.exceptionFilters, NODE_EXCEPTION_FILTERS) &&
    load.record.watches.length === 0
  ) {
    return success(load.record, 0);
  }
  const next = {
    ...load.record,
    revision: load.record.revision + 1,
    breakpoints: [],
    exceptionFilters: NODE_EXCEPTION_FILTERS.map((filter) => ({ ...filter })),
    watches: [],
  };
  return commitRecord(realRoot, next, options)
    ? success(next, 0)
    : rejected("state_unavailable", load.record, 0, 0);
}

export function createBreakpointStore(options: BreakpointStoreOptions): BreakpointStore {
  return {
    stateDir: options.stateDir,
    snapshot: (realRoot): BreakpointStoreSnapshotResult => {
      const load = loadRecord(realRoot, options);
      const snapshot = freezeSnapshot(load.record);
      return load.state === "unavailable"
        ? { ok: false, reason: "state_unavailable", snapshot }
        : { ok: true, snapshot };
    },
    setBreakpointsForFile: (realRoot, revision, etag, fileId, requested) =>
      setBreakpoints(options, realRoot, revision, etag, fileId, requested),
    setWatches: (realRoot, revision, etag, requested) =>
      setWatchExpressions(options, realRoot, revision, etag, requested),
    setExceptionBreakpoints: (realRoot, revision, etag, requested) =>
      setExceptionFilters(options, realRoot, revision, etag, requested),
    setBreakpointVerifications: (realRoot, revision, etag, fileId, updates) =>
      setBreakpointVerifications(options, realRoot, revision, etag, fileId, updates),
    clearAll: (realRoot, revision, etag) => clearInstrumentation(options, realRoot, revision, etag),
  };
}
