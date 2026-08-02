// Browser-facing governed DAP contracts (Issue #2345, Epic #2096, ADR-0136 D8-D11).
// This leaf owns strict wire vocabulary, hostile-input parsing, and bounded live projections.
// It owns no process lifecycle, launch resolution, route authority, persistence, or evidence.

export const DAP_DEBUG_CONTRACT_SCHEMA_VERSION = "1" as const;

export type DebugSessionStatus =
  "reserved" | "starting" | "running" | "paused" | "stopping" | "stopped" | "failed" | "revoked";

export const DEBUG_SESSION_STATUSES: readonly DebugSessionStatus[] = Object.freeze([
  "reserved",
  "starting",
  "running",
  "paused",
  "stopping",
  "stopped",
  "failed",
  "revoked",
] as const satisfies readonly DebugSessionStatus[]);

export type DebugEventKind =
  | "session-started"
  | "session-stopped"
  | "stopped"
  | "continued"
  | "output"
  | "exited"
  | "breakpoints-changed"
  | "projection-truncated";

export const DEBUG_EVENT_KINDS: readonly DebugEventKind[] = Object.freeze([
  "session-started",
  "session-stopped",
  "stopped",
  "continued",
  "output",
  "exited",
  "breakpoints-changed",
  "projection-truncated",
] as const satisfies readonly DebugEventKind[]);

export type SourceBreakpointKind = "line" | "conditional" | "logpoint";

export const SOURCE_BREAKPOINT_KINDS: readonly SourceBreakpointKind[] = Object.freeze([
  "line",
  "conditional",
  "logpoint",
] as const satisfies readonly SourceBreakpointKind[]);

export const DEBUG_TRUNCATION_MARKER = "[truncated]" as const;

export const DEFAULT_DEBUG_PAYLOAD_LIMITS = Object.freeze({
  maxBreakpointsPerFile: 64,
  maxBreakpointsPerWorkspace: 200,
  maxConditionBytes: 1_024,
  maxHitConditionBytes: 1_024,
  maxLogMessageBytes: 1_024,
  maxWatchExpressionBytes: 1_024,
  maxWatches: 32,
  maxWatchValueBytes: 4_096,
  maxWatchTypeBytes: 256,
  maxAggregateWatchBytes: 128 * 1_024,
  maxHttpResponseBytes: 256 * 1_024,
  maxSseEventBytes: 64 * 1_024,
  maxFramesPerPage: 64,
  maxRetainedFrames: 128,
  maxScopesPerFrame: 32,
  maxVariablesPerExpansion: 200,
  maxDepth: 4,
  maxGraphNodes: 1_000,
  maxNameBytes: 512,
  maxTypeBytes: 256,
  maxValueBytes: 4_096,
  maxOutputBytes: 16 * 1_024,
  maxExceptionFilters: 32,
  maxOpaqueIdChars: 128,
  maxFileIdBytes: 4_096,
  maxCoordinate: 2_147_483_647,
  // Conservative character ceilings are named explicitly for browser consumers. Byte caps remain
  // authoritative and can reduce the retained character count for multi-byte UTF-8 input.
  maxChildrenPerNode: 200,
  maxValueChars: 4_096,
  maxFrames: 64,
  maxOutputChars: 16 * 1_024,
} as const);

export interface BoundedDebugText {
  readonly value: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly omittedBytes: number;
}

export type DebugLaunchTarget =
  | { readonly kind: "catalog"; readonly targetId: string }
  | { readonly kind: "file"; readonly fileId: string };

export interface DebugSessionOutputStatus {
  readonly acceptedBytes: number;
  readonly truncated: boolean;
}

export interface DebugSession {
  readonly schemaVersion: typeof DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly status: DebugSessionStatus;
  readonly targetKind: DebugLaunchTarget["kind"];
  readonly activationRevision: number;
  readonly pauseGeneration: number;
  readonly startedAtMs: number;
  readonly wallDeadlineMs: number;
  readonly inactivityDeadlineMs: number;
  readonly output: DebugSessionOutputStatus;
}

export type SourceBreakpointVerification = "pending" | "verified" | "rejected";

export interface SourceBreakpoint {
  readonly id: string;
  readonly fileId: string;
  readonly line: number;
  readonly column?: number | undefined;
  readonly enabled: boolean;
  readonly condition?: string | undefined;
  readonly hitCondition?: string | undefined;
  readonly logMessage?: string | undefined;
  readonly kind: SourceBreakpointKind;
  readonly verification: SourceBreakpointVerification;
}

export interface ExceptionBreakpointFilter {
  readonly filterId: string;
  readonly enabled: boolean;
  readonly condition?: string | undefined;
}

export interface StackFrame {
  readonly frameRef: string;
  readonly name: BoundedDebugText;
  readonly sourceFileId?: string | undefined;
  readonly line: number;
  readonly column: number;
}

export interface Scope {
  readonly scopeRef: string;
  readonly name: BoundedDebugText;
  readonly expensive: boolean;
  readonly variableCount?: number | undefined;
}

export type DebugVariablePresentation = "data" | "method" | "property" | "virtual";
export type DebugVariableTruncationReason = "depth" | "width" | "nodeLimit" | "cycle";

export interface DebugVariableInput {
  readonly variableRef?: string | undefined;
  readonly name: string;
  readonly type?: string | undefined;
  readonly value: string;
  readonly presentation?: DebugVariablePresentation | undefined;
  readonly children?: readonly DebugVariableInput[] | undefined;
}

export interface DebugVariableValueNode {
  readonly kind: "variable";
  readonly variableRef?: string | undefined;
  readonly name: BoundedDebugText;
  readonly type?: BoundedDebugText | undefined;
  readonly value: BoundedDebugText;
  readonly presentation: DebugVariablePresentation;
  readonly children: readonly DebugVariableNode[];
  readonly retainedCount: number;
  readonly omittedCount: number;
  readonly truncated: boolean;
}

export interface DebugVariableTruncatedNode {
  readonly kind: "truncated";
  readonly reason: DebugVariableTruncationReason;
  readonly omittedCount: number;
  readonly truncated: true;
}

export type DebugVariableNode = DebugVariableValueNode | DebugVariableTruncatedNode;

export interface DebugVariableTree {
  readonly nodes: readonly DebugVariableNode[];
  readonly retainedCount: number;
  readonly omittedCount: number;
  readonly nodeCount: number;
  readonly truncated: boolean;
}

export interface WatchExpression {
  readonly watchId: string;
  readonly expression: string;
  readonly enabled: boolean;
}

export type WatchEvaluationState = "value" | "error" | "truncated";

export interface WatchEvaluationResult {
  readonly watchId: string;
  readonly pauseGeneration: number;
  readonly state: WatchEvaluationState;
  readonly value?: BoundedDebugText | undefined;
  readonly type?: BoundedDebugText | undefined;
  readonly variableRef?: string | undefined;
}

export interface InstrumentationSnapshot {
  readonly schemaVersion: typeof DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly revision: number;
  readonly etag: string;
  readonly breakpoints: readonly SourceBreakpoint[];
  readonly exceptionFilters: readonly ExceptionBreakpointFilter[];
  readonly watches: readonly WatchExpression[];
}

export type DebugStopReason = "breakpoint" | "exception" | "pause" | "step" | "entry" | "restart";
export type DebugSessionStopReason = "requested" | "exited" | "failed" | "revoked" | "limit";
export type DebugOutputCategory = "stdout" | "stderr" | "console";

export interface DebugSessionStartedEvent {
  readonly kind: "session-started";
  readonly sessionId: string;
  readonly status: "starting" | "running";
}

export interface DebugSessionStoppedEvent {
  readonly kind: "session-stopped";
  readonly sessionId: string;
  readonly status: "stopped" | "failed" | "revoked";
  readonly reason: DebugSessionStopReason;
}

export interface DebugStoppedEvent {
  readonly kind: "stopped";
  readonly sessionId: string;
  readonly pauseGeneration: number;
  readonly reason: DebugStopReason;
  readonly allThreadsStopped: boolean;
  /**
   * Deliberate live-projection exception: an adapter-supplied stop description is capped before
   * leaving the server. It is never copied into debugging evidence or persisted instrumentation.
   */
  readonly description?: BoundedDebugText | undefined;
}

export interface DebugContinuedEvent {
  readonly kind: "continued";
  readonly sessionId: string;
  readonly pauseGeneration: number;
}

// Deliberate live-projection exception: `text` is capped transient debuggee output. No other event
// variant carries debuggee-produced text, and this contract is never an evidence record.
export interface DebugOutputEvent {
  readonly kind: "output";
  readonly sessionId: string;
  readonly category: DebugOutputCategory;
  readonly text: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly omittedBytes: number;
}

export interface DebugExitedEvent {
  readonly kind: "exited";
  readonly sessionId: string;
  readonly exitCode: number;
}

export interface DebugBreakpointsChangedEvent {
  readonly kind: "breakpoints-changed";
  readonly workspaceId: string;
  readonly revision: number;
  readonly breakpointCount: number;
  readonly verifiedCount: number;
}

export interface DebugProjectionTruncatedEvent {
  readonly kind: "projection-truncated";
  readonly reason: "sse-event-size";
  readonly originalBytes: number;
}

export type DebugEvent =
  | DebugSessionStartedEvent
  | DebugSessionStoppedEvent
  | DebugStoppedEvent
  | DebugContinuedEvent
  | DebugOutputEvent
  | DebugExitedEvent
  | DebugBreakpointsChangedEvent
  | DebugProjectionTruncatedEvent;

export type DebugSessionControlAction =
  "pause" | "continue" | "next" | "stepIn" | "stepOut" | "stop";

export interface DebugBootstrapRequest {
  readonly schemaVersion: typeof DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
  readonly workspaceId: string;
}

export interface DebugSessionStartRequest {
  readonly schemaVersion: typeof DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly target: DebugLaunchTarget;
  readonly activationRevision: number;
}

export interface DebugSessionControlRequest {
  readonly schemaVersion: typeof DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly action: DebugSessionControlAction;
  readonly pauseGeneration: number;
}

export interface SetBreakpointsRequest {
  readonly schemaVersion: typeof DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly fileId: string;
  readonly breakpoints: readonly SourceBreakpoint[];
}

export interface SetExceptionBreakpointsRequest {
  readonly schemaVersion: typeof DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly filters: readonly ExceptionBreakpointFilter[];
}

export interface StackTraceRequest {
  readonly schemaVersion: typeof DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly pauseGeneration: number;
  readonly startFrame?: number | undefined;
  readonly cursor?: string | undefined;
  readonly levels: number;
}

export interface ScopesRequest {
  readonly schemaVersion: typeof DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly pauseGeneration: number;
  readonly frameRef: string;
}

export interface VariablesRequest {
  readonly schemaVersion: typeof DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly pauseGeneration: number;
  readonly variableRef: string;
}

export interface SetVariableRequest extends VariablesRequest {
  readonly value: string;
}

export interface SetWatchesRequest {
  readonly schemaVersion: typeof DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly watches: readonly WatchExpression[];
}

export interface EvaluateWatchRequest {
  readonly schemaVersion: typeof DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly pauseGeneration: number;
  readonly watchId: string;
  readonly frameRef?: string | undefined;
}

export type DebugParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

type UnknownRecord = Readonly<Record<string, unknown>>;
type RecordValidator = (value: UnknownRecord) => boolean;
type RecordBuilder<T> = (value: UnknownRecord) => T;

const TEXT_ENCODER = new TextEncoder();
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const CATALOG_TARGET_ID = /^npm-script:[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:/u;
const BREAKPOINT_VERIFICATIONS: readonly SourceBreakpointVerification[] = [
  "pending",
  "verified",
  "rejected",
];
const CONTROL_ACTIONS: readonly DebugSessionControlAction[] = [
  "pause",
  "continue",
  "next",
  "stepIn",
  "stepOut",
  "stop",
];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function memberOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= DEFAULT_DEBUG_PAYLOAD_LIMITS.maxCoordinate
  );
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function isCatalogTargetId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= DEFAULT_DEBUG_PAYLOAD_LIMITS.maxOpaqueIdChars &&
    CATALOG_TARGET_ID.test(value)
  );
}

function isCanonicalFileId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes("\u0000")) return false;
  if (WINDOWS_ABSOLUTE_PATH.test(value)) return false;
  if (TEXT_ENCODER.encode(value).length > DEFAULT_DEBUG_PAYLOAD_LIMITS.maxFileIdBytes) return false;
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isBoundedText(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    !value.includes("\u0000") &&
    TEXT_ENCODER.encode(value).length <= maxBytes
  );
}

function isDenseArray<T>(
  value: unknown,
  maxLength: number,
  predicate: (entry: unknown) => entry is T,
): value is readonly T[] {
  return (
    Array.isArray(value) &&
    value.length <= maxLength &&
    Object.keys(value).length === value.length &&
    value.every(predicate)
  );
}

function parseSafely<T>(parser: () => DebugParseResult<T>): DebugParseResult<T> {
  try {
    return parser();
  } catch (error: unknown) {
    return {
      ok: false,
      errors: [
        `payload could not be inspected: ${error instanceof Error ? error.name : "unknown"}`,
      ],
    };
  }
}

function parseObject<T>(
  value: unknown,
  label: string,
  keys: readonly string[],
  validate: RecordValidator,
  build: RecordBuilder<T>,
): DebugParseResult<T> {
  if (!isRecord(value)) return { ok: false, errors: [`${label} must be an object`] };
  if (!hasOnlyKeys(value, keys) || !validate(value)) {
    return { ok: false, errors: [`${label} is invalid or contains unknown fields`] };
  }
  return { ok: true, value: build(value) };
}

function hasSchema(value: UnknownRecord): boolean {
  return value.schemaVersion === DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
}

function isDebugLaunchTarget(value: unknown): value is DebugLaunchTarget {
  if (!isRecord(value)) return false;
  if (value.kind === "catalog") {
    return hasOnlyKeys(value, ["kind", "targetId"]) && isCatalogTargetId(value.targetId);
  }
  return (
    value.kind === "file" &&
    hasOnlyKeys(value, ["kind", "fileId"]) &&
    isCanonicalFileId(value.fileId)
  );
}

function buildDebugLaunchTarget(value: DebugLaunchTarget): DebugLaunchTarget {
  return value.kind === "catalog"
    ? { kind: "catalog", targetId: value.targetId }
    : { kind: "file", fileId: value.fileId };
}

function isBreakpointKindConsistent(value: UnknownRecord): boolean {
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
  return (
    value.kind === "logpoint" &&
    isBoundedText(value.logMessage, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxLogMessageBytes)
  );
}

function hasValidBreakpointIdentity(value: UnknownRecord): boolean {
  return (
    isOpaqueId(value.id) &&
    isCanonicalFileId(value.fileId) &&
    isPositiveCoordinate(value.line) &&
    (value.column === undefined || isPositiveCoordinate(value.column)) &&
    typeof value.enabled === "boolean"
  );
}

function hasValidBreakpointVocabulary(value: UnknownRecord): boolean {
  return (
    memberOf(value.kind, SOURCE_BREAKPOINT_KINDS) &&
    memberOf(value.verification, BREAKPOINT_VERIFICATIONS) &&
    (value.condition === undefined ||
      isBoundedText(value.condition, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxConditionBytes)) &&
    (value.hitCondition === undefined ||
      isBoundedText(value.hitCondition, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxHitConditionBytes)) &&
    isBreakpointKindConsistent(value)
  );
}

function isSourceBreakpoint(value: unknown): value is SourceBreakpoint {
  if (!isRecord(value)) return false;
  const keys = [
    "id",
    "fileId",
    "line",
    "column",
    "enabled",
    "condition",
    "hitCondition",
    "logMessage",
    "kind",
    "verification",
  ];
  return (
    hasOnlyKeys(value, keys) &&
    hasValidBreakpointIdentity(value) &&
    hasValidBreakpointVocabulary(value)
  );
}

function canonicalBreakpoint(value: SourceBreakpoint): SourceBreakpoint {
  return {
    id: value.id,
    fileId: value.fileId,
    line: value.line,
    ...(value.column === undefined ? {} : { column: value.column }),
    enabled: value.enabled,
    ...(value.condition === undefined ? {} : { condition: value.condition }),
    ...(value.hitCondition === undefined ? {} : { hitCondition: value.hitCondition }),
    ...(value.logMessage === undefined ? {} : { logMessage: value.logMessage }),
    kind: value.kind,
    verification: value.verification,
  };
}

function isExceptionFilter(value: unknown): value is ExceptionBreakpointFilter {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["filterId", "enabled", "condition"]) &&
    isOpaqueId(value.filterId) &&
    typeof value.enabled === "boolean" &&
    (value.condition === undefined ||
      isBoundedText(value.condition, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxConditionBytes))
  );
}

function canonicalExceptionFilter(value: ExceptionBreakpointFilter): ExceptionBreakpointFilter {
  return {
    filterId: value.filterId,
    enabled: value.enabled,
    ...(value.condition === undefined ? {} : { condition: value.condition }),
  };
}

function isWatch(value: unknown): value is WatchExpression {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["watchId", "expression", "enabled"]) &&
    isOpaqueId(value.watchId) &&
    isBoundedText(value.expression, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxWatchExpressionBytes) &&
    typeof value.enabled === "boolean"
  );
}

function canonicalWatch(value: WatchExpression): WatchExpression {
  return { watchId: value.watchId, expression: value.expression, enabled: value.enabled };
}

function hasSessionGeneration(value: UnknownRecord): boolean {
  return isOpaqueId(value.sessionId) && isNonnegativeSafeInteger(value.pauseGeneration);
}

export function parseDebugBootstrapRequest(
  value: unknown,
): DebugParseResult<DebugBootstrapRequest> {
  return parseSafely(() =>
    parseObject(
      value,
      "debug bootstrap request",
      ["schemaVersion", "workspaceId"],
      (record) => hasSchema(record) && isOpaqueId(record.workspaceId),
      (record) => ({
        schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
        workspaceId: record.workspaceId as string,
      }),
    ),
  );
}

export function parseDebugSessionStartRequest(
  value: unknown,
): DebugParseResult<DebugSessionStartRequest> {
  return parseSafely(() =>
    parseObject(
      value,
      "debug session start request",
      ["schemaVersion", "workspaceId", "target", "activationRevision"],
      (record) =>
        hasSchema(record) &&
        isOpaqueId(record.workspaceId) &&
        isDebugLaunchTarget(record.target) &&
        isNonnegativeSafeInteger(record.activationRevision),
      (record) => ({
        schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
        workspaceId: record.workspaceId as string,
        target: buildDebugLaunchTarget(record.target as DebugLaunchTarget),
        activationRevision: record.activationRevision as number,
      }),
    ),
  );
}

export function parseDebugSessionControlRequest(
  value: unknown,
): DebugParseResult<DebugSessionControlRequest> {
  return parseSafely(() =>
    parseObject(
      value,
      "debug session control request",
      ["schemaVersion", "sessionId", "action", "pauseGeneration"],
      (record) =>
        hasSchema(record) &&
        hasSessionGeneration(record) &&
        memberOf(record.action, CONTROL_ACTIONS),
      (record) => ({
        schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
        sessionId: record.sessionId as string,
        action: record.action as DebugSessionControlAction,
        pauseGeneration: record.pauseGeneration as number,
      }),
    ),
  );
}

function validSetBreakpointsRequest(value: UnknownRecord): boolean {
  if (!hasSchema(value) || !isOpaqueId(value.workspaceId)) return false;
  if (!isNonnegativeSafeInteger(value.expectedRevision) || !isCanonicalFileId(value.fileId)) {
    return false;
  }
  if (
    !isDenseArray(
      value.breakpoints,
      DEFAULT_DEBUG_PAYLOAD_LIMITS.maxBreakpointsPerFile,
      isSourceBreakpoint,
    )
  ) {
    return false;
  }
  return value.breakpoints.every((breakpoint) => breakpoint.fileId === value.fileId);
}

export function parseSetBreakpointsRequest(
  value: unknown,
): DebugParseResult<SetBreakpointsRequest> {
  return parseSafely(() =>
    parseObject(
      value,
      "set breakpoints request",
      ["schemaVersion", "workspaceId", "expectedRevision", "fileId", "breakpoints"],
      validSetBreakpointsRequest,
      (record) => ({
        schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
        workspaceId: record.workspaceId as string,
        expectedRevision: record.expectedRevision as number,
        fileId: record.fileId as string,
        breakpoints: (record.breakpoints as readonly SourceBreakpoint[]).map(canonicalBreakpoint),
      }),
    ),
  );
}

function validSetExceptionBreakpointsRequest(value: UnknownRecord): boolean {
  return (
    hasSchema(value) &&
    isOpaqueId(value.workspaceId) &&
    isNonnegativeSafeInteger(value.expectedRevision) &&
    isDenseArray(value.filters, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxExceptionFilters, isExceptionFilter)
  );
}

export function parseSetExceptionBreakpointsRequest(
  value: unknown,
): DebugParseResult<SetExceptionBreakpointsRequest> {
  return parseSafely(() =>
    parseObject(
      value,
      "set exception breakpoints request",
      ["schemaVersion", "workspaceId", "expectedRevision", "filters"],
      validSetExceptionBreakpointsRequest,
      (record) => ({
        schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
        workspaceId: record.workspaceId as string,
        expectedRevision: record.expectedRevision as number,
        filters: (record.filters as readonly ExceptionBreakpointFilter[]).map(
          canonicalExceptionFilter,
        ),
      }),
    ),
  );
}

export function parseStackTraceRequest(value: unknown): DebugParseResult<StackTraceRequest> {
  return parseSafely(() =>
    parseObject(
      value,
      "stack trace request",
      ["schemaVersion", "sessionId", "pauseGeneration", "startFrame", "cursor", "levels"],
      (record) =>
        hasSchema(record) &&
        hasSessionGeneration(record) &&
        ((record.startFrame === 0 && record.cursor === undefined) ||
          (record.startFrame === undefined && isOpaqueId(record.cursor))) &&
        isPositiveCoordinate(record.levels) &&
        record.levels <= DEFAULT_DEBUG_PAYLOAD_LIMITS.maxFramesPerPage,
      (record) => ({
        schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
        sessionId: record.sessionId as string,
        pauseGeneration: record.pauseGeneration as number,
        ...(record.startFrame === undefined ? {} : { startFrame: record.startFrame as number }),
        ...(record.cursor === undefined ? {} : { cursor: record.cursor as string }),
        levels: record.levels as number,
      }),
    ),
  );
}

function parseReferenceRequest<T extends ScopesRequest | VariablesRequest>(
  value: unknown,
  label: string,
  referenceKey: "frameRef" | "variableRef",
): DebugParseResult<T> {
  return parseObject(
    value,
    label,
    ["schemaVersion", "sessionId", "pauseGeneration", referenceKey],
    (record) =>
      hasSchema(record) && hasSessionGeneration(record) && isOpaqueId(record[referenceKey]),
    (record) =>
      ({
        schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
        sessionId: record.sessionId as string,
        pauseGeneration: record.pauseGeneration as number,
        [referenceKey]: record[referenceKey] as string,
      }) as unknown as T,
  );
}

export function parseScopesRequest(value: unknown): DebugParseResult<ScopesRequest> {
  return parseSafely(() => parseReferenceRequest(value, "scopes request", "frameRef"));
}

export function parseVariablesRequest(value: unknown): DebugParseResult<VariablesRequest> {
  return parseSafely(() => parseReferenceRequest(value, "variables request", "variableRef"));
}

export function parseSetVariableRequest(value: unknown): DebugParseResult<SetVariableRequest> {
  return parseSafely(() =>
    parseObject(
      value,
      "set variable request",
      ["schemaVersion", "sessionId", "pauseGeneration", "variableRef", "value"],
      (record) =>
        hasSchema(record) &&
        hasSessionGeneration(record) &&
        isOpaqueId(record.variableRef) &&
        isBoundedText(record.value, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxValueBytes, true),
      (record) => ({
        schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
        sessionId: record.sessionId as string,
        pauseGeneration: record.pauseGeneration as number,
        variableRef: record.variableRef as string,
        value: record.value as string,
      }),
    ),
  );
}

function validSetWatchesRequest(value: UnknownRecord): boolean {
  return (
    hasSchema(value) &&
    isOpaqueId(value.workspaceId) &&
    isNonnegativeSafeInteger(value.expectedRevision) &&
    isDenseArray(value.watches, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxWatches, isWatch)
  );
}

export function parseSetWatchesRequest(value: unknown): DebugParseResult<SetWatchesRequest> {
  return parseSafely(() =>
    parseObject(
      value,
      "set watches request",
      ["schemaVersion", "workspaceId", "expectedRevision", "watches"],
      validSetWatchesRequest,
      (record) => ({
        schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
        workspaceId: record.workspaceId as string,
        expectedRevision: record.expectedRevision as number,
        watches: (record.watches as readonly WatchExpression[]).map(canonicalWatch),
      }),
    ),
  );
}

export function parseEvaluateWatchRequest(value: unknown): DebugParseResult<EvaluateWatchRequest> {
  return parseSafely(() =>
    parseObject(
      value,
      "evaluate watch request",
      ["schemaVersion", "sessionId", "pauseGeneration", "watchId", "frameRef"],
      (record) =>
        hasSchema(record) &&
        hasSessionGeneration(record) &&
        isOpaqueId(record.watchId) &&
        (record.frameRef === undefined || isOpaqueId(record.frameRef)),
      (record) => ({
        schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
        sessionId: record.sessionId as string,
        pauseGeneration: record.pauseGeneration as number,
        watchId: record.watchId as string,
        ...(record.frameRef === undefined ? {} : { frameRef: record.frameRef as string }),
      }),
    ),
  );
}

function utf8Prefix(value: string, maxBytes: number): { value: string; bytes: number } {
  let prefix = "";
  let bytes = 0;
  for (const codePoint of value) {
    const codePointBytes = TEXT_ENCODER.encode(codePoint).length;
    if (bytes + codePointBytes > maxBytes) break;
    prefix += codePoint;
    bytes += codePointBytes;
  }
  return { value: prefix, bytes };
}

export function projectDebugText(value: string, maxBytes: number): BoundedDebugText {
  const markerBytes = TEXT_ENCODER.encode(DEBUG_TRUNCATION_MARKER).length;
  const originalBytes = TEXT_ENCODER.encode(value).length;
  if (originalBytes <= maxBytes && Number.isSafeInteger(maxBytes) && maxBytes >= 0) {
    return {
      value,
      truncated: false,
      originalBytes,
      retainedBytes: originalBytes,
      omittedBytes: 0,
    };
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < markerBytes) {
    throw new RangeError("maxBytes must fit the fixed debug truncation marker");
  }
  const prefix = utf8Prefix(value, maxBytes - markerBytes);
  const projectedValue = `${prefix.value}${DEBUG_TRUNCATION_MARKER}`;
  return {
    value: projectedValue,
    truncated: true,
    originalBytes,
    retainedBytes: prefix.bytes + markerBytes,
    omittedBytes: originalBytes - prefix.bytes,
  };
}

interface VariableProjectionContext {
  nodeCount: number;
  readonly active: WeakSet<object>;
}

interface VariableChildrenProjection {
  readonly children: readonly DebugVariableNode[];
  readonly retainedCount: number;
  readonly omittedCount: number;
  readonly truncated: boolean;
}

function variableSentinel(
  reason: DebugVariableTruncationReason,
  omittedCount: number,
  context: VariableProjectionContext,
): DebugVariableTruncatedNode | undefined {
  if (context.nodeCount >= DEFAULT_DEBUG_PAYLOAD_LIMITS.maxGraphNodes) return undefined;
  context.nodeCount += 1;
  return { kind: "truncated", reason, omittedCount: Math.max(1, omittedCount), truncated: true };
}

function requiredVariableSentinel(
  reason: DebugVariableTruncationReason,
  context: VariableProjectionContext,
): DebugVariableTruncatedNode {
  const sentinel = variableSentinel(reason, 1, context);
  if (sentinel === undefined) throw new RangeError("debug variable node budget exhausted");
  return sentinel;
}

function projectVariableFields(
  input: DebugVariableInput,
): Pick<DebugVariableValueNode, "variableRef" | "name" | "type" | "value" | "presentation"> {
  return {
    ...(input.variableRef === undefined ? {} : { variableRef: input.variableRef }),
    name: projectDebugText(input.name, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxNameBytes),
    ...(input.type === undefined
      ? {}
      : { type: projectDebugText(input.type, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxTypeBytes) }),
    value: projectDebugText(input.value, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxValueBytes),
    presentation: input.presentation ?? "data",
  };
}

function projectionReason(inputLength: number): DebugVariableTruncationReason {
  return inputLength > DEFAULT_DEBUG_PAYLOAD_LIMITS.maxChildrenPerNode ? "width" : "nodeLimit";
}

function projectVariableChildren(
  inputs: readonly DebugVariableInput[],
  depth: number,
  context: VariableProjectionContext,
): VariableChildrenProjection {
  const output: DebugVariableNode[] = [];
  const widthLimited = inputs.length > DEFAULT_DEBUG_PAYLOAD_LIMITS.maxChildrenPerNode;
  const regularLimit = Math.min(
    inputs.length,
    widthLimited
      ? DEFAULT_DEBUG_PAYLOAD_LIMITS.maxChildrenPerNode - 1
      : DEFAULT_DEBUG_PAYLOAD_LIMITS.maxChildrenPerNode,
  );
  let index = 0;
  while (
    index < regularLimit &&
    context.nodeCount < DEFAULT_DEBUG_PAYLOAD_LIMITS.maxGraphNodes - 1
  ) {
    const input = inputs[index];
    if (input === undefined) break;
    output.push(projectVariableNode(input, depth, context));
    index += 1;
  }
  const omittedCount = inputs.length - index;
  if (omittedCount > 0) {
    const sentinel = variableSentinel(projectionReason(inputs.length), omittedCount, context);
    if (sentinel !== undefined && output.length < DEFAULT_DEBUG_PAYLOAD_LIMITS.maxChildrenPerNode) {
      output.push(sentinel);
    }
  }
  return {
    children: output,
    retainedCount: index,
    omittedCount,
    truncated: omittedCount > 0 || output.some((node) => node.truncated),
  };
}

function projectVariableNode(
  input: DebugVariableInput,
  depth: number,
  context: VariableProjectionContext,
): DebugVariableNode {
  if (depth >= DEFAULT_DEBUG_PAYLOAD_LIMITS.maxDepth) {
    return requiredVariableSentinel("depth", context);
  }
  if (context.active.has(input)) {
    return requiredVariableSentinel("cycle", context);
  }
  context.nodeCount += 1;
  context.active.add(input);
  const projected = projectVariableChildren(input.children ?? [], depth + 1, context);
  context.active.delete(input);
  return {
    kind: "variable",
    ...projectVariableFields(input),
    children: projected.children,
    retainedCount: projected.retainedCount,
    omittedCount: projected.omittedCount,
    truncated: projected.truncated,
  };
}

export function buildDebugVariableTree(inputs: readonly DebugVariableInput[]): DebugVariableTree {
  const context: VariableProjectionContext = { nodeCount: 0, active: new WeakSet() };
  const projected = projectVariableChildren(inputs, 0, context);
  return {
    nodes: projected.children,
    retainedCount: projected.retainedCount,
    omittedCount: projected.omittedCount,
    nodeCount: context.nodeCount,
    truncated: projected.truncated,
  };
}

export interface StackFrameInput {
  readonly frameRef: string;
  readonly name: string;
  readonly sourceFileId?: string | undefined;
  readonly line: number;
  readonly column: number;
}

export interface DebugStackPage {
  readonly frames: readonly StackFrame[];
  readonly totalCount: number;
  readonly retainedCount: number;
  readonly omittedCount: number;
  readonly truncated: boolean;
}

function projectStackFrame(input: StackFrameInput): StackFrame {
  return {
    frameRef: input.frameRef,
    name: projectDebugText(input.name, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxNameBytes),
    ...(input.sourceFileId === undefined ? {} : { sourceFileId: input.sourceFileId }),
    line: input.line,
    column: input.column,
  };
}

export function buildStackPage(
  inputs: readonly StackFrameInput[],
  startFrame: number,
): DebugStackPage {
  const retainedCount = Math.min(inputs.length, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxRetainedFrames);
  const pageEnd = Math.min(
    retainedCount,
    startFrame + DEFAULT_DEBUG_PAYLOAD_LIMITS.maxFramesPerPage,
  );
  const frames = inputs.slice(Math.min(startFrame, retainedCount), pageEnd).map(projectStackFrame);
  return {
    frames,
    totalCount: inputs.length,
    retainedCount,
    omittedCount: inputs.length - retainedCount,
    truncated: retainedCount < inputs.length,
  };
}

export interface ScopeInput {
  readonly scopeRef: string;
  readonly name: string;
  readonly expensive: boolean;
  readonly variableCount?: number | undefined;
}

export interface DebugScopeProjection {
  readonly scopes: readonly Scope[];
  readonly retainedCount: number;
  readonly omittedCount: number;
  readonly truncated: boolean;
}

function projectScope(input: ScopeInput): Scope {
  return {
    scopeRef: input.scopeRef,
    name: projectDebugText(input.name, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxNameBytes),
    expensive: input.expensive,
    ...(input.variableCount === undefined ? {} : { variableCount: input.variableCount }),
  };
}

export function buildScopeProjection(inputs: readonly ScopeInput[]): DebugScopeProjection {
  const retained = inputs
    .slice(0, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxScopesPerFrame)
    .map(projectScope);
  return {
    scopes: retained,
    retainedCount: retained.length,
    omittedCount: inputs.length - retained.length,
    truncated: retained.length < inputs.length,
  };
}

export interface WatchEvaluationInput {
  readonly watchId: string;
  readonly pauseGeneration: number;
  readonly state: WatchEvaluationState;
  readonly value?: string | undefined;
  readonly type?: string | undefined;
  readonly variableRef?: string | undefined;
}

export function buildWatchEvaluationResult(input: WatchEvaluationInput): WatchEvaluationResult {
  return {
    watchId: input.watchId,
    pauseGeneration: input.pauseGeneration,
    state: input.state,
    ...(input.value === undefined
      ? {}
      : {
          value: projectDebugText(input.value, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxWatchValueBytes),
        }),
    ...(input.type === undefined
      ? {}
      : { type: projectDebugText(input.type, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxWatchTypeBytes) }),
    ...(input.variableRef === undefined ? {} : { variableRef: input.variableRef }),
  };
}

export function buildDebugOutputEvent(
  sessionId: string,
  category: DebugOutputCategory,
  output: string,
): DebugOutputEvent {
  const projected = projectDebugText(output, DEFAULT_DEBUG_PAYLOAD_LIMITS.maxOutputBytes);
  return {
    kind: "output",
    sessionId,
    category,
    text: projected.value,
    truncated: projected.truncated,
    originalBytes: projected.originalBytes,
    omittedBytes: projected.omittedBytes,
  };
}
