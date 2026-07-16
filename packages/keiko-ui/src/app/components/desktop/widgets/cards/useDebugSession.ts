"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
  DEFAULT_DEBUG_PAYLOAD_LIMITS,
  type DebugEvent,
  type DebugLaunchTarget,
  type DebugSession,
  type DebugSessionControlAction,
  type DebugVariableNode,
  type BoundedDebugText,
  type ExceptionBreakpointFilter,
  type InstrumentationSnapshot,
  type SourceBreakpoint,
  type Scope,
  type StackFrame,
  type WatchEvaluationResult,
  type WatchExpression,
} from "@oscharko-dev/keiko-contracts";
import { sharedEventSourceGeneration, subscribeSharedEventSource } from "./sharedEventSource";
import {
  abandonDebugStreamResync,
  applyDebugEvent,
  beginDebugStreamResync,
  captureDebugSessionLifecycleFence,
  debugSessionSnapshot,
  debugStreamSnapshotRequiresCanonicalResync,
  exhaustDebugStreamResync,
  invalidateDebugPausedProjections,
  markDebugStreamReady,
  replaceDebugExceptionFilters,
  replaceDebugPausedProjections,
  replaceDebugWatches,
  setDebugInstrumentation,
  setDebugScopes,
  setDebugSession,
  setDebugSessionIfLifecycleCurrent,
  setDebugStack,
  setDebugVariables,
  setDebugWatchResult,
  subscribeDebugSession,
  synchronizeDebugSequence,
  type DebugPauseIdentity,
  type DebugPausedProjection,
  type DebugScopeSnapshot,
  type DebugSessionSnapshot,
  type DebugStackSnapshot,
  type DebugVariableSnapshot,
} from "./debugSessionStore";

interface DebugEventEnvelope {
  readonly sequence: number;
  readonly event: DebugEvent;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

interface MutationProjection {
  readonly snapshot: InstrumentationSnapshot;
}

interface DebugReplaySnapshot {
  readonly sequence: number;
  readonly retainedCount: number;
  readonly retainedBytes: number;
  readonly evictedCount: number;
  readonly evictedBytes: number;
}

interface SetVariableProjection {
  readonly sessionId: string;
  readonly pauseGeneration: number;
  readonly result: DebugVariableNode;
}

interface ExpandedFramePlan {
  readonly frameIndex: number;
  readonly expandedScopeIndexes: readonly number[];
}

const DEBUG_EVENTS = Object.freeze([
  "editor-debug:session-started",
  "editor-debug:session-stopped",
  "editor-debug:stopped",
  "editor-debug:continued",
  "editor-debug:output",
  "editor-debug:exited",
  "editor-debug:breakpoints-changed",
  "editor-debug:projection-truncated",
  "editor-debug:snapshot",
  "editor-debug:snapshot-required",
  "ready",
] as const);

const bootstrapRequests = new Map<string, Promise<void>>();
const instrumentationRequests = new Map<string, Promise<InstrumentationSnapshot | null>>();

interface SharedSessionRequest {
  readonly lifecycleFence: symbol;
  readonly promise: Promise<DebugSession | null>;
}

const sessionRequests = new Map<string, SharedSessionRequest>();

interface SharedProjectionRequest<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T | null>;
  readonly workspaceId: string;
}

type SharedProjectionRequests<T> = Map<string, SharedProjectionRequest<T>>;

const stackProjectionRequests: SharedProjectionRequests<DebugStackSnapshot> = new Map();
const scopeProjectionRequests: SharedProjectionRequests<DebugScopeSnapshot> = new Map();
const variableProjectionRequests: SharedProjectionRequests<DebugVariableSnapshot> = new Map();
const projectionConsumerCounts = new Map<string, number>();
const MAX_CANONICAL_RESYNC_ATTEMPTS = 2;

interface SharedStreamResync {
  readonly generation: number;
  readonly sequence: number;
  readonly promise: Promise<void>;
}

const streamResyncRequests = new Map<string, SharedStreamResync>();

interface TrackedRequestRecord {
  readonly controller: AbortController;
  readonly lifecycleFence: symbol;
  readonly owner: Set<AbortController>;
}

const trackedRequestsByWorkspace = new Map<string, Set<TrackedRequestRecord>>();

async function runCanonicalResyncAttempts(
  workspaceId: string,
  generation: number,
  sequence: number,
  task: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CANONICAL_RESYNC_ATTEMPTS; attempt += 1) {
    try {
      await task();
      return;
    } catch (error: unknown) {
      if (attempt !== MAX_CANONICAL_RESYNC_ATTEMPTS - 1) continue;
      exhaustDebugStreamResync(workspaceId, generation, sequence);
      throw error;
    }
  }
}

function sharedStreamResync(
  workspaceId: string,
  generation: number,
  sequence: number,
  task: () => Promise<void>,
): Promise<void> {
  const current = streamResyncRequests.get(workspaceId);
  if (
    current !== undefined &&
    (generation < current.generation ||
      (generation === current.generation && sequence <= current.sequence))
  ) {
    return current.promise;
  }
  let promise: Promise<void>;
  promise = Promise.resolve()
    .then(() => runCanonicalResyncAttempts(workspaceId, generation, sequence, task))
    .finally(() => {
      if (streamResyncRequests.get(workspaceId)?.promise === promise) {
        streamResyncRequests.delete(workspaceId);
      }
    });
  streamResyncRequests.set(workspaceId, { generation, sequence, promise });
  return promise;
}

async function awaitSharedStreamResync(workspaceId: string, generation: number): Promise<void> {
  const current = streamResyncRequests.get(workspaceId);
  if (current !== undefined && generation <= current.generation) await current.promise;
}

function debugUrl(workspaceId: string, suffix: string): string {
  return `/api/editor/debug/${suffix}?workspaceId=${encodeURIComponent(workspaceId)}`;
}

function sharedBootstrap(workspaceId: string): Promise<void> {
  const pending = bootstrapRequests.get(workspaceId);
  if (pending !== undefined) return pending;
  const request = requestJson(
    "/api/editor/debug/bootstrap",
    debugMutation({ schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION, workspaceId }),
  ).then((): void => undefined);
  bootstrapRequests.set(workspaceId, request);
  void request.then(
    (): void => {
      if (bootstrapRequests.get(workspaceId) === request) bootstrapRequests.delete(workspaceId);
    },
    (): void => {
      if (bootstrapRequests.get(workspaceId) === request) bootstrapRequests.delete(workspaceId);
    },
  );
  return request;
}

export function resetDebugBootstrapRequestsForTests(): void {
  bootstrapRequests.clear();
  instrumentationRequests.clear();
  sessionRequests.clear();
  abortSharedProjectionRequests();
  projectionConsumerCounts.clear();
  streamResyncRequests.clear();
  abortAllTrackedRequests();
}

export function pendingDebugStreamResyncRequestsForTests(): number {
  return streamResyncRequests.size;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function arrayOf<T>(value: unknown, guard: (entry: unknown) => entry is T): value is readonly T[] {
  return Array.isArray(value) && value.every(guard);
}

function sourceBreakpoint(value: unknown): value is SourceBreakpoint {
  if (!isRecord(value)) return false;
  const kind = stringValue(value.kind);
  const verification = stringValue(value.verification);
  return (
    stringValue(value.id) !== null &&
    stringValue(value.fileId) !== null &&
    numberValue(value.line) !== null &&
    typeof value.enabled === "boolean" &&
    (kind === "line" || kind === "conditional" || kind === "logpoint") &&
    (verification === "pending" || verification === "verified" || verification === "rejected") &&
    (value.column === undefined || numberValue(value.column) !== null) &&
    (value.condition === undefined || stringValue(value.condition) !== null) &&
    (value.hitCondition === undefined || stringValue(value.hitCondition) !== null) &&
    (value.logMessage === undefined || stringValue(value.logMessage) !== null)
  );
}

function exceptionFilter(value: unknown): value is ExceptionBreakpointFilter {
  return (
    isRecord(value) &&
    stringValue(value.filterId) !== null &&
    typeof value.enabled === "boolean" &&
    (value.condition === undefined || stringValue(value.condition) !== null)
  );
}

function watchExpression(value: unknown): value is WatchExpression {
  return (
    isRecord(value) &&
    stringValue(value.watchId) !== null &&
    stringValue(value.expression) !== null &&
    typeof value.enabled === "boolean"
  );
}

function boundedText(value: unknown): BoundedDebugText | null {
  if (!isRecord(value)) return null;
  const text = stringValue(value.value);
  const originalBytes = numberValue(value.originalBytes);
  const retainedBytes = numberValue(value.retainedBytes);
  const omittedBytes = numberValue(value.omittedBytes);
  if (
    text === null ||
    originalBytes === null ||
    retainedBytes === null ||
    omittedBytes === null ||
    typeof value.truncated !== "boolean"
  ) {
    return null;
  }
  return { value: text, truncated: value.truncated, originalBytes, retainedBytes, omittedBytes };
}

function stackFrame(value: unknown): value is StackFrame {
  return (
    isRecord(value) &&
    stringValue(value.frameRef) !== null &&
    boundedText(value.name) !== null &&
    numberValue(value.line) !== null &&
    numberValue(value.column) !== null &&
    (value.sourceFileId === undefined || stringValue(value.sourceFileId) !== null)
  );
}

function scope(value: unknown): value is Scope {
  return (
    isRecord(value) &&
    stringValue(value.scopeRef) !== null &&
    boundedText(value.name) !== null &&
    typeof value.expensive === "boolean" &&
    (value.variableCount === undefined || numberValue(value.variableCount) !== null)
  );
}

function debugVariableNode(value: unknown): value is DebugVariableNode {
  if (!isRecord(value)) return false;
  if (value.kind === "truncated") {
    return (
      (value.reason === "depth" ||
        value.reason === "width" ||
        value.reason === "nodeLimit" ||
        value.reason === "cycle") &&
      numberValue(value.omittedCount) !== null &&
      value.truncated === true
    );
  }
  return (
    value.kind === "variable" &&
    boundedText(value.name) !== null &&
    boundedText(value.value) !== null &&
    (value.type === undefined || boundedText(value.type) !== null) &&
    (value.variableRef === undefined || stringValue(value.variableRef) !== null) &&
    (value.presentation === "data" ||
      value.presentation === "method" ||
      value.presentation === "property" ||
      value.presentation === "virtual") &&
    arrayOf(value.children, debugVariableNode) &&
    numberValue(value.retainedCount) !== null &&
    numberValue(value.omittedCount) !== null &&
    typeof value.truncated === "boolean"
  );
}

function parseSession(value: unknown): DebugSession | null {
  if (!isRecord(value)) return null;
  const status = stringValue(value.status);
  const sessionId = stringValue(value.sessionId);
  const workspaceId = stringValue(value.workspaceId);
  if (
    sessionId === null ||
    workspaceId === null ||
    (status !== "reserved" &&
      status !== "starting" &&
      status !== "running" &&
      status !== "paused" &&
      status !== "stopping" &&
      status !== "stopped" &&
      status !== "failed" &&
      status !== "revoked")
  ) {
    return null;
  }
  const pauseGeneration = numberValue(value.pauseGeneration);
  const activationRevision = numberValue(value.activationRevision);
  const startedAtMs = numberValue(value.startedAtMs);
  const wallDeadlineMs = numberValue(value.wallDeadlineMs);
  const inactivityDeadlineMs = numberValue(value.inactivityDeadlineMs);
  const targetKind = stringValue(value.targetKind);
  const output = value.output;
  if (
    pauseGeneration === null ||
    activationRevision === null ||
    startedAtMs === null ||
    wallDeadlineMs === null ||
    inactivityDeadlineMs === null ||
    (targetKind !== "catalog" && targetKind !== "file") ||
    !isRecord(output) ||
    numberValue(output.acceptedBytes) === null ||
    typeof output.truncated !== "boolean"
  ) {
    return null;
  }
  return {
    schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
    sessionId,
    workspaceId,
    status,
    targetKind,
    activationRevision,
    pauseGeneration,
    startedAtMs,
    wallDeadlineMs,
    inactivityDeadlineMs,
    output: { acceptedBytes: output.acceptedBytes as number, truncated: output.truncated },
  };
}

function sharedSession(
  workspaceId: string,
  sessionId: string,
  lifecycleFence: symbol,
): Promise<DebugSession | null> {
  const key = `${workspaceId}\u0000${sessionId}`;
  const pending = sessionRequests.get(key);
  if (pending?.lifecycleFence === lifecycleFence) return pending.promise;
  const request = requestJson(`/api/editor/debug/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { "x-keiko-csrf": "1" },
  })
    .then(parseSession)
    .finally(() => {
      if (sessionRequests.get(key)?.promise === request) sessionRequests.delete(key);
    });
  sessionRequests.set(key, { lifecycleFence, promise: request });
  return request;
}

function projectionRequestKey(
  workspaceId: string,
  identity: DebugPauseIdentity,
  reference = "",
): string {
  return JSON.stringify([workspaceId, identity.sessionId, identity.pauseGeneration, reference]);
}

async function runSharedProjectionTask<T>(
  controller: AbortController,
  task: (signal: AbortSignal) => Promise<T | null>,
): Promise<T | null> {
  try {
    const result = await task(controller.signal);
    return controller.signal.aborted ? null : result;
  } catch (error: unknown) {
    if (controller.signal.aborted) return null;
    throw error;
  }
}

function sharedProjection<T>(
  requests: SharedProjectionRequests<T>,
  key: string,
  workspaceId: string,
  task: (signal: AbortSignal) => Promise<T | null>,
): Promise<T | null> {
  const pending = requests.get(key);
  if (pending !== undefined) return pending.promise;
  const controller = new AbortController();
  let promise: Promise<T | null>;
  promise = runSharedProjectionTask(controller, task).finally(() => {
    if (requests.get(key)?.promise === promise) requests.delete(key);
  });
  requests.set(key, { controller, promise, workspaceId });
  return promise;
}

function abortProjectionRequests<T>(
  requests: SharedProjectionRequests<T>,
  workspaceId?: string,
): void {
  for (const [key, request] of requests) {
    if (workspaceId !== undefined && request.workspaceId !== workspaceId) continue;
    request.controller.abort();
    requests.delete(key);
  }
}

function abortSharedProjectionRequests(workspaceId?: string): void {
  abortProjectionRequests(stackProjectionRequests, workspaceId);
  abortProjectionRequests(scopeProjectionRequests, workspaceId);
  abortProjectionRequests(variableProjectionRequests, workspaceId);
}

function retainProjectionConsumer(workspaceId: string): () => void {
  projectionConsumerCounts.set(workspaceId, (projectionConsumerCounts.get(workspaceId) ?? 0) + 1);
  let retained = true;
  return (): void => {
    if (!retained) return;
    retained = false;
    const remaining = (projectionConsumerCounts.get(workspaceId) ?? 1) - 1;
    if (remaining > 0) {
      projectionConsumerCounts.set(workspaceId, remaining);
      return;
    }
    projectionConsumerCounts.delete(workspaceId);
    abortSharedProjectionRequests(workspaceId);
  };
}

function parseOutputEvent(
  value: Readonly<Record<string, unknown>>,
  sessionId: string | null,
): Extract<DebugEvent, { readonly kind: "output" }> | null {
  const category = stringValue(value.category);
  const text = stringValue(value.text);
  const originalBytes = numberValue(value.originalBytes);
  const omittedBytes = numberValue(value.omittedBytes);
  if (
    sessionId === null ||
    text === null ||
    originalBytes === null ||
    omittedBytes === null ||
    typeof value.truncated !== "boolean" ||
    (category !== "stdout" && category !== "stderr" && category !== "console")
  ) {
    return null;
  }
  return {
    kind: "output",
    sessionId,
    category,
    text,
    truncated: value.truncated,
    originalBytes,
    omittedBytes,
  };
}

function parseContinuedEvent(
  value: Readonly<Record<string, unknown>>,
  sessionId: string | null,
): Extract<DebugEvent, { readonly kind: "continued" }> | null {
  const pauseGeneration = numberValue(value.pauseGeneration);
  return sessionId === null || pauseGeneration === null
    ? null
    : { kind: "continued", sessionId, pauseGeneration };
}

const STOP_REASONS = new Set(["breakpoint", "exception", "pause", "step", "entry", "restart"]);

function parseStoppedEvent(
  value: Readonly<Record<string, unknown>>,
  sessionId: string | null,
): Extract<DebugEvent, { readonly kind: "stopped" }> | null {
  const pauseGeneration = numberValue(value.pauseGeneration);
  const reason = stringValue(value.reason);
  const description = value.description === undefined ? undefined : boundedText(value.description);
  if (
    sessionId === null ||
    pauseGeneration === null ||
    (value.description !== undefined && description === null) ||
    typeof value.allThreadsStopped !== "boolean" ||
    reason === null ||
    !STOP_REASONS.has(reason)
  )
    return null;
  const event = {
    kind: "stopped" as const,
    sessionId,
    pauseGeneration,
    reason: reason as Extract<DebugEvent, { readonly kind: "stopped" }>["reason"],
    allThreadsStopped: value.allThreadsStopped,
  };
  return description === null || description === undefined ? event : { ...event, description };
}

function parseSessionStartedEvent(
  value: Readonly<Record<string, unknown>>,
  sessionId: string | null,
): Extract<DebugEvent, { readonly kind: "session-started" }> | null {
  const status = stringValue(value.status);
  return sessionId === null || (status !== "starting" && status !== "running")
    ? null
    : { kind: "session-started", sessionId, status };
}

const TERMINAL_REASONS = new Set(["requested", "exited", "failed", "revoked", "limit"]);

function parseSessionStoppedEvent(
  value: Readonly<Record<string, unknown>>,
  sessionId: string | null,
): Extract<DebugEvent, { readonly kind: "session-stopped" }> | null {
  const status = stringValue(value.status);
  const reason = stringValue(value.reason);
  if (
    sessionId === null ||
    (status !== "stopped" && status !== "failed" && status !== "revoked") ||
    reason === null ||
    !TERMINAL_REASONS.has(reason)
  )
    return null;
  return {
    kind: "session-stopped",
    sessionId,
    status,
    reason: reason as Extract<DebugEvent, { readonly kind: "session-stopped" }>["reason"],
  };
}

function parseExitedEvent(
  value: Readonly<Record<string, unknown>>,
  sessionId: string | null,
): Extract<DebugEvent, { readonly kind: "exited" }> | null {
  const exitCode = numberValue(value.exitCode);
  return sessionId === null || exitCode === null ? null : { kind: "exited", sessionId, exitCode };
}

function parseBreakpointsChangedEvent(
  value: Readonly<Record<string, unknown>>,
): Extract<DebugEvent, { readonly kind: "breakpoints-changed" }> | null {
  const workspaceId = stringValue(value.workspaceId);
  const revision = numberValue(value.revision);
  const breakpointCount = numberValue(value.breakpointCount);
  const verifiedCount = numberValue(value.verifiedCount);
  return workspaceId === null ||
    revision === null ||
    breakpointCount === null ||
    verifiedCount === null
    ? null
    : { kind: "breakpoints-changed", workspaceId, revision, breakpointCount, verifiedCount };
}

function parseProjectionTruncatedEvent(
  value: Readonly<Record<string, unknown>>,
): Extract<DebugEvent, { readonly kind: "projection-truncated" }> | null {
  const originalBytes = numberValue(value.originalBytes);
  return value.reason !== "sse-event-size" || originalBytes === null
    ? null
    : { kind: "projection-truncated", reason: "sse-event-size", originalBytes };
}

function parseEvent(value: unknown): DebugEvent | null {
  if (!isRecord(value)) return null;
  const sessionId = stringValue(value.sessionId);
  switch (stringValue(value.kind)) {
    case "output":
      return parseOutputEvent(value, sessionId);
    case "continued":
      return parseContinuedEvent(value, sessionId);
    case "stopped":
      return parseStoppedEvent(value, sessionId);
    case "session-started":
      return parseSessionStartedEvent(value, sessionId);
    case "session-stopped":
      return parseSessionStoppedEvent(value, sessionId);
    case "exited":
      return parseExitedEvent(value, sessionId);
    case "breakpoints-changed":
      return parseBreakpointsChangedEvent(value);
    case "projection-truncated":
      return parseProjectionTruncatedEvent(value);
    default:
      return null;
  }
}

function parseEnvelope(value: unknown): DebugEventEnvelope | null {
  if (!isRecord(value)) return null;
  const sequence = numberValue(value.sequence);
  const event = parseEvent(value.event);
  return sequence === null || event === null ? null : { sequence, event };
}

function parseReplaySnapshot(value: unknown): DebugReplaySnapshot | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "sequence",
      "retainedCount",
      "retainedBytes",
      "evictedCount",
      "evictedBytes",
    ])
  )
    return null;
  const sequence = numberValue(value.sequence);
  const retainedCount = numberValue(value.retainedCount);
  const retainedBytes = numberValue(value.retainedBytes);
  const evictedCount = numberValue(value.evictedCount);
  const evictedBytes = numberValue(value.evictedBytes);
  return sequence === null ||
    retainedCount === null ||
    retainedBytes === null ||
    evictedCount === null ||
    evictedBytes === null
    ? null
    : { sequence, retainedCount, retainedBytes, evictedCount, evictedBytes };
}

function instrument(value: unknown): InstrumentationSnapshot | null {
  if (
    !isRecord(value) ||
    !arrayOf(value.breakpoints, sourceBreakpoint) ||
    !arrayOf(value.exceptionFilters, exceptionFilter) ||
    !arrayOf(value.watches, watchExpression)
  )
    return null;
  const workspaceId = stringValue(value.workspaceId);
  const etag = stringValue(value.etag);
  const revision = numberValue(value.revision);
  if (
    workspaceId === null ||
    etag === null ||
    revision === null ||
    value.schemaVersion !== DAP_DEBUG_CONTRACT_SCHEMA_VERSION
  )
    return null;
  return {
    schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
    workspaceId,
    revision,
    etag,
    breakpoints: value.breakpoints,
    exceptionFilters: value.exceptionFilters,
    watches: value.watches,
  };
}

function sharedInstrumentation(workspaceId: string): Promise<InstrumentationSnapshot | null> {
  const pending = instrumentationRequests.get(workspaceId);
  if (pending !== undefined) return pending;
  const request = requestJson(debugUrl(workspaceId, "instrumentation"))
    .then(instrument)
    .finally(() => {
      if (instrumentationRequests.get(workspaceId) === request) {
        instrumentationRequests.delete(workspaceId);
      }
    });
  instrumentationRequests.set(workspaceId, request);
  return request;
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  const body = (await response.json()) as unknown;
  if (!response.ok) throw new Error("Debug request was rejected.");
  return body;
}

function debugMutation(body: object, method = "POST", etag?: string): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      "x-keiko-csrf": "1",
      ...(etag === undefined ? {} : { "if-match": etag }),
    },
    body: JSON.stringify(body),
  };
}

function mutationProjection(value: unknown): MutationProjection | null {
  if (!isRecord(value)) return null;
  const snapshot = instrument(value.snapshot);
  return snapshot === null ? null : { snapshot };
}

interface DebugStackPage extends DebugStackSnapshot {
  readonly nextCursor?: string | undefined;
}

const MAX_DEBUG_STACK_PAGE_REQUESTS = Math.ceil(
  DEFAULT_DEBUG_PAYLOAD_LIMITS.maxRetainedFrames / DEFAULT_DEBUG_PAYLOAD_LIMITS.maxFramesPerPage,
);

function parseStack(value: unknown): DebugStackPage | null {
  if (
    !isRecord(value) ||
    !arrayOf(value.frames, stackFrame) ||
    typeof value.truncated !== "boolean"
  )
    return null;
  const omittedCount = numberValue(value.omittedCount);
  const nextCursor = typeof value.nextCursor === "string" ? value.nextCursor : undefined;
  if (value.nextCursor !== undefined && nextCursor === undefined) return null;
  return omittedCount === null
    ? null
    : {
        frames: value.frames,
        truncated: value.truncated,
        omittedCount,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
}

function appendStackPage(current: DebugStackSnapshot, page: DebugStackPage): DebugStackSnapshot {
  return {
    frames: [...current.frames, ...page.frames].slice(
      0,
      DEFAULT_DEBUG_PAYLOAD_LIMITS.maxRetainedFrames,
    ),
    truncated: page.truncated,
    omittedCount: page.omittedCount,
  };
}

function parseScopes(value: unknown, frameRef: string): DebugScopeSnapshot | null {
  if (!isRecord(value) || !arrayOf(value.scopes, scope) || typeof value.truncated !== "boolean")
    return null;
  const omittedCount = numberValue(value.omittedCount);
  return omittedCount === null
    ? null
    : {
        frameRef,
        scopes: value.scopes,
        truncated: value.truncated,
        omittedCount,
      };
}

function parseVariables(value: unknown, parentRef: string): DebugVariableSnapshot | null {
  if (
    !isRecord(value) ||
    !arrayOf(value.nodes, debugVariableNode) ||
    typeof value.truncated !== "boolean"
  )
    return null;
  const omittedCount = numberValue(value.omittedCount);
  return omittedCount === null
    ? null
    : {
        parentRef,
        nodes: value.nodes,
        truncated: value.truncated,
        omittedCount,
      };
}

function parseWatchResult(value: unknown): WatchEvaluationResult | null {
  if (!isRecord(value)) return null;
  const watchId = stringValue(value.watchId);
  const pauseGeneration = numberValue(value.pauseGeneration);
  const state = stringValue(value.state);
  if (
    watchId === null ||
    pauseGeneration === null ||
    (state !== "value" && state !== "error" && state !== "truncated")
  )
    return null;
  const watchedValue = value.value === undefined ? undefined : boundedText(value.value);
  const type = value.type === undefined ? undefined : boundedText(value.type);
  if (
    (value.value !== undefined && watchedValue === null) ||
    (value.type !== undefined && type === null)
  )
    return null;
  const variableRef = value.variableRef === undefined ? undefined : stringValue(value.variableRef);
  if (value.variableRef !== undefined && variableRef === null) return null;
  return {
    watchId,
    pauseGeneration,
    state,
    ...(watchedValue === null ? {} : { value: watchedValue }),
    ...(type === null ? {} : { type }),
    ...(variableRef === null ? {} : { variableRef }),
  };
}

function parseSetVariableProjection(value: unknown): SetVariableProjection | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "sessionId", "pauseGeneration", "result"]) ||
    value.schemaVersion !== DAP_DEBUG_CONTRACT_SCHEMA_VERSION
  )
    return null;
  const sessionId = stringValue(value.sessionId);
  const pauseGeneration = numberValue(value.pauseGeneration);
  if (sessionId === null || pauseGeneration === null || !debugVariableNode(value.result))
    return null;
  return { sessionId, pauseGeneration, result: value.result };
}

function pauseIdentity(session: DebugSession): DebugPauseIdentity {
  return { sessionId: session.sessionId, pauseGeneration: session.pauseGeneration };
}

function currentPauseMatches(workspaceId: string, identity: DebugPauseIdentity): boolean {
  const current = debugSessionSnapshot(workspaceId).session;
  return (
    current?.status === "paused" &&
    current.sessionId === identity.sessionId &&
    current.pauseGeneration === identity.pauseGeneration
  );
}

function expandedFramePlan(snapshot: DebugSessionSnapshot): readonly ExpandedFramePlan[] {
  if (snapshot.stack === null) return [];
  return snapshot.stack.frames.flatMap((frame, frameIndex) => {
    const scopes = snapshot.scopesByFrame.get(frame.frameRef)?.scopes;
    if (scopes === undefined) return [];
    const expandedScopeIndexes = scopes.flatMap((scope, scopeIndex) =>
      snapshot.variablesByParent.has(scope.scopeRef) ? [scopeIndex] : [],
    );
    return [{ frameIndex, expandedScopeIndexes }];
  });
}

function removeTrackedRequest(workspaceId: string, request: TrackedRequestRecord): void {
  request.owner.delete(request.controller);
  const workspaceRequests = trackedRequestsByWorkspace.get(workspaceId);
  workspaceRequests?.delete(request);
  if (workspaceRequests?.size === 0) trackedRequestsByWorkspace.delete(workspaceId);
}

async function runTrackedAbortable<T>(
  workspaceId: string,
  owner: Set<AbortController>,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  const controller = new AbortController();
  const request: TrackedRequestRecord = {
    controller,
    lifecycleFence: captureDebugSessionLifecycleFence(workspaceId),
    owner,
  };
  owner.add(controller);
  const workspaceRequests = trackedRequestsByWorkspace.get(workspaceId) ?? new Set();
  workspaceRequests.add(request);
  trackedRequestsByWorkspace.set(workspaceId, workspaceRequests);
  try {
    const result = await task(controller.signal);
    return controller.signal.aborted ? undefined : result;
  } catch (error: unknown) {
    if (controller.signal.aborted) return undefined;
    throw error;
  } finally {
    removeTrackedRequest(workspaceId, request);
  }
}

function abortOwnedRequests(workspaceId: string, owner: Set<AbortController>): void {
  const workspaceRequests = trackedRequestsByWorkspace.get(workspaceId);
  if (workspaceRequests === undefined) return;
  for (const request of [...workspaceRequests]) {
    if (request.owner !== owner) continue;
    request.controller.abort();
    removeTrackedRequest(workspaceId, request);
  }
}

function abortTrackedRequestsOutsideFence(workspaceId: string, currentFence: symbol): void {
  const workspaceRequests = trackedRequestsByWorkspace.get(workspaceId);
  if (workspaceRequests === undefined) return;
  for (const request of [...workspaceRequests]) {
    if (request.lifecycleFence === currentFence) continue;
    request.controller.abort();
    removeTrackedRequest(workspaceId, request);
  }
}

function abortAllTrackedRequests(): void {
  for (const [workspaceId, requests] of trackedRequestsByWorkspace) {
    for (const request of [...requests]) {
      request.controller.abort();
      removeTrackedRequest(workspaceId, request);
    }
  }
}

function inspectionMutation(identity: DebugPauseIdentity, extra: object): RequestInit {
  return debugMutation({
    schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
    sessionId: identity.sessionId,
    pauseGeneration: identity.pauseGeneration,
    ...extra,
  });
}

async function requestStackProjection(
  identity: DebugPauseIdentity,
  signal: AbortSignal,
): Promise<DebugPausedProjection["stack"] | null> {
  const response = await requestJson("/api/editor/debug/stack", {
    ...inspectionMutation(identity, {
      startFrame: 0,
      levels: DEFAULT_DEBUG_PAYLOAD_LIMITS.maxFramesPerPage,
    }),
    signal,
  });
  const first = parseStack(response);
  if (first === null) return null;
  let stack: DebugStackSnapshot = first;
  let cursor = first.nextCursor;
  let pageRequests = 1;
  while (
    cursor !== undefined &&
    stack.frames.length < DEFAULT_DEBUG_PAYLOAD_LIMITS.maxRetainedFrames &&
    pageRequests < MAX_DEBUG_STACK_PAGE_REQUESTS
  ) {
    const next = parseStack(
      await requestJson("/api/editor/debug/stack", {
        ...inspectionMutation(identity, {
          cursor,
          levels: DEFAULT_DEBUG_PAYLOAD_LIMITS.maxFramesPerPage,
        }),
        signal,
      }),
    );
    if (next === null || (next.frames.length === 0 && next.nextCursor !== undefined)) return null;
    stack = appendStackPage(stack, next);
    cursor = next.nextCursor;
    pageRequests += 1;
  }
  return cursor === undefined ||
    stack.frames.length >= DEFAULT_DEBUG_PAYLOAD_LIMITS.maxRetainedFrames
    ? stack
    : null;
}

async function requestScopeProjection(
  identity: DebugPauseIdentity,
  frameRef: string,
  signal: AbortSignal,
): Promise<DebugScopeSnapshot | null> {
  const response = await requestJson("/api/editor/debug/scopes", {
    ...inspectionMutation(identity, { frameRef }),
    signal,
  });
  return parseScopes(response, frameRef);
}

async function requestVariableProjection(
  identity: DebugPauseIdentity,
  variableRef: string,
  signal: AbortSignal,
): Promise<DebugVariableSnapshot | null> {
  const response = await requestJson("/api/editor/debug/variables", {
    ...inspectionMutation(identity, { variableRef }),
    signal,
  });
  return parseVariables(response, variableRef);
}

async function rebuildPausedProjection(
  identity: DebugPauseIdentity,
  plan: readonly ExpandedFramePlan[],
  signal: AbortSignal,
): Promise<DebugPausedProjection> {
  const stack = await requestStackProjection(identity, signal);
  if (stack === null) throw new Error("Debug stack projection was invalid.");
  const scopes: DebugScopeSnapshot[] = [];
  const variables: DebugVariableSnapshot[] = [];
  for (const framePlan of plan) {
    const frame = stack.frames[framePlan.frameIndex];
    if (frame === undefined) continue;
    const scopeProjection = await requestScopeProjection(identity, frame.frameRef, signal);
    if (scopeProjection === null) throw new Error("Debug scope projection was invalid.");
    scopes.push(scopeProjection);
    for (const scopeIndex of framePlan.expandedScopeIndexes) {
      const scopeEntry = scopeProjection.scopes[scopeIndex];
      if (scopeEntry === undefined) continue;
      const variableProjection = await requestVariableProjection(
        identity,
        scopeEntry.scopeRef,
        signal,
      );
      if (variableProjection === null) throw new Error("Debug variable projection was invalid.");
      variables.push(variableProjection);
    }
  }
  return { stack, scopes, variables };
}

export interface DebugSessionActions {
  readonly refreshInstrumentation: () => Promise<void>;
  readonly refreshSession: (sessionId: string) => Promise<void>;
  readonly start: (target: DebugLaunchTarget, activationRevision: number) => Promise<void>;
  readonly control: (session: DebugSession, action: DebugSessionControlAction) => Promise<void>;
  readonly saveBreakpoints: (
    fileId: string,
    breakpoints: readonly SourceBreakpoint[],
  ) => Promise<void>;
  readonly loadStack: (session: DebugSession) => Promise<void>;
  readonly loadScopes: (session: DebugSession, frameRef: string) => Promise<void>;
  readonly loadVariables: (session: DebugSession, variableRef: string) => Promise<void>;
  readonly saveWatches: (watches: readonly WatchExpression[]) => Promise<void>;
  readonly saveExceptionFilters: (filters: readonly ExceptionBreakpointFilter[]) => Promise<void>;
  readonly evaluateWatch: (
    session: DebugSession,
    watchId: string,
    frameRef?: string,
  ) => Promise<WatchEvaluationResult | null>;
  readonly setVariable: (
    session: DebugSession,
    variableRef: string,
    value: string,
  ) => Promise<void>;
}

export interface UseDebugSessionResult {
  readonly snapshot: DebugSessionSnapshot;
  readonly actions: DebugSessionActions;
}

const ABORTING_EVENT_KINDS = new Set<DebugEvent["kind"]>([
  "session-started",
  "session-stopped",
  "stopped",
  "continued",
  "exited",
]);

interface DebugStreamLifecycle {
  cancelled: boolean;
  eventQueue: Promise<void>;
}

function enqueueDebugStreamMessage(
  lifecycle: DebugStreamLifecycle,
  message: MessageEvent<string>,
  handler: (message: MessageEvent<string>) => Promise<void>,
): void {
  lifecycle.eventQueue = lifecycle.eventQueue
    .then(() => (lifecycle.cancelled ? undefined : handler(message)))
    .catch((): void => {
      // The server returns redacted envelopes; keep the stream alive without logging.
    });
}

export function useDebugSession(
  workspaceId: string | undefined,
  enabled = false,
): UseDebugSessionResult {
  const stableWorkspaceId = workspaceId ?? "";
  const subscribe = useCallback(
    (listener: () => void) => subscribeDebugSession(stableWorkspaceId, listener),
    [stableWorkspaceId],
  );
  const getSnapshot = useCallback(
    () => debugSessionSnapshot(stableWorkspaceId),
    [stableWorkspaceId],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const requestControllers = useRef<Set<AbortController>>(new Set());
  const streamResyncRequired = useRef(false);

  const abortPendingRequests = useCallback((): void => {
    abortOwnedRequests(stableWorkspaceId, requestControllers.current);
  }, [stableWorkspaceId]);

  const trackedRequest = useCallback(
    async (url: string, init?: RequestInit): Promise<unknown> => {
      const response = await runTrackedAbortable(
        stableWorkspaceId,
        requestControllers.current,
        (signal) => requestJson(url, { ...init, signal }),
      );
      return response ?? null;
    },
    [stableWorkspaceId],
  );

  const bootstrap = useCallback(async (): Promise<void> => {
    if (!enabled || stableWorkspaceId.length === 0) return;
    await sharedBootstrap(stableWorkspaceId);
  }, [enabled, stableWorkspaceId]);

  const refreshInstrumentationAtLeast = useCallback(
    async (minimumRevision = 0): Promise<boolean> => {
      if (!enabled || stableWorkspaceId.length === 0) return false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const parsed = await sharedInstrumentation(stableWorkspaceId);
        if (parsed === null) return false;
        if (parsed.revision >= minimumRevision) {
          return setDebugInstrumentation(stableWorkspaceId, parsed);
        }
      }
      return false;
    },
    [enabled, stableWorkspaceId],
  );

  const refreshInstrumentation = useCallback(async (): Promise<void> => {
    await refreshInstrumentationAtLeast();
  }, [refreshInstrumentationAtLeast]);

  const mutationInstrumentation = useCallback(async (): Promise<InstrumentationSnapshot | null> => {
    if (!enabled || stableWorkspaceId.length === 0) return null;
    const current = debugSessionSnapshot(stableWorkspaceId).instrumentation;
    if (current !== null) return current;
    await bootstrap();
    if (!(await refreshInstrumentationAtLeast())) {
      throw new Error("Debug instrumentation is unavailable.");
    }
    const refreshed = debugSessionSnapshot(stableWorkspaceId).instrumentation;
    if (refreshed === null) throw new Error("Debug instrumentation is unavailable.");
    return refreshed;
  }, [bootstrap, enabled, refreshInstrumentationAtLeast, stableWorkspaceId]);

  const refreshSessionAtFence = useCallback(
    async (sessionId: string, lifecycleFence: symbol): Promise<boolean> => {
      if (!enabled) return false;
      const session = await sharedSession(stableWorkspaceId, sessionId, lifecycleFence);
      const current = debugSessionSnapshot(stableWorkspaceId).session;
      if (
        session !== null &&
        session.workspaceId === stableWorkspaceId &&
        session.sessionId === sessionId &&
        (current === null || current.sessionId === sessionId)
      ) {
        return setDebugSessionIfLifecycleCurrent(stableWorkspaceId, lifecycleFence, session);
      }
      return false;
    },
    [enabled, stableWorkspaceId],
  );

  const refreshSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const lifecycleFence = captureDebugSessionLifecycleFence(stableWorkspaceId);
      await refreshSessionAtFence(sessionId, lifecycleFence);
    },
    [refreshSessionAtFence, stableWorkspaceId],
  );

  const refreshOrClearResyncSession = useCallback(
    async (sessionId: string, lifecycleFence: symbol): Promise<void> => {
      let refreshed = false;
      try {
        refreshed = await refreshSessionAtFence(sessionId, lifecycleFence);
      } catch {
        // Canonical recovery must not retain a session the server can no longer project.
        refreshed = false;
      }
      if (!refreshed && captureDebugSessionLifecycleFence(stableWorkspaceId) === lifecycleFence) {
        setDebugSession(stableWorkspaceId, null);
      }
    },
    [refreshSessionAtFence, stableWorkspaceId],
  );

  useEffect(() => {
    if (!enabled || stableWorkspaceId.length === 0) return;
    return retainProjectionConsumer(stableWorkspaceId);
  }, [enabled, stableWorkspaceId]);

  useEffect(() => (): void => abortPendingRequests(), [abortPendingRequests, stableWorkspaceId]);

  const canonicalResync = useCallback(
    async (sequence: number, generation: number): Promise<void> => {
      const current = debugSessionSnapshot(stableWorkspaceId).session;
      const resyncToken = beginDebugStreamResync(stableWorkspaceId, generation, sequence);
      if (resyncToken === null) return;
      const resyncFence = captureDebugSessionLifecycleFence(stableWorkspaceId);
      abortTrackedRequestsOutsideFence(stableWorkspaceId, resyncFence);
      abortSharedProjectionRequests(stableWorkspaceId);
      try {
        const refreshed = await refreshInstrumentationAtLeast();
        if (!refreshed) throw new Error("Debug instrumentation resync was rejected.");
        if (
          current !== null &&
          captureDebugSessionLifecycleFence(stableWorkspaceId) === resyncFence
        ) {
          await refreshOrClearResyncSession(current.sessionId, resyncFence);
        }
        synchronizeDebugSequence(stableWorkspaceId, sequence, resyncToken, generation);
      } catch (error: unknown) {
        abandonDebugStreamResync(stableWorkspaceId, sequence, resyncToken, generation);
        throw error;
      }
    },
    [refreshInstrumentationAtLeast, refreshOrClearResyncSession, stableWorkspaceId],
  );

  const resyncFromReplaySnapshot = useCallback(
    async (replay: DebugReplaySnapshot, generation: number): Promise<void> => {
      streamResyncRequired.current = true;
      try {
        await sharedStreamResync(stableWorkspaceId, generation, replay.sequence, () =>
          canonicalResync(replay.sequence, generation),
        );
      } finally {
        streamResyncRequired.current = false;
      }
    },
    [canonicalResync, stableWorkspaceId],
  );

  const handleStreamMessage = useCallback(
    async (message: MessageEvent<string>): Promise<void> => {
      const generation = sharedEventSourceGeneration(message);
      if (message.type === "ready") {
        if (!streamResyncRequired.current) markDebugStreamReady(stableWorkspaceId, generation);
        return;
      }
      if (
        message.type === "editor-debug:snapshot" ||
        message.type === "editor-debug:snapshot-required"
      ) {
        const replay = parseReplaySnapshot(parseJson(message.data));
        if (
          replay !== null &&
          debugStreamSnapshotRequiresCanonicalResync(
            stableWorkspaceId,
            generation,
            replay.sequence,
            message.type === "editor-debug:snapshot-required",
          )
        ) {
          await resyncFromReplaySnapshot(replay, generation);
        }
        return;
      }
      if (streamResyncRequired.current) return;
      await awaitSharedStreamResync(stableWorkspaceId, generation);
      const parsed = parseEnvelope(parseJson(message.data));
      if (parsed === null) return;
      const event = parsed.event;
      const aborting = ABORTING_EVENT_KINDS.has(event.kind);
      if (!applyDebugEvent(stableWorkspaceId, parsed.sequence, event, generation)) return;
      if (aborting) {
        abortTrackedRequestsOutsideFence(
          stableWorkspaceId,
          captureDebugSessionLifecycleFence(stableWorkspaceId),
        );
        abortSharedProjectionRequests(stableWorkspaceId);
      }
      if (event.kind === "session-stopped" || event.kind === "exited") return;
      if (event.kind === "breakpoints-changed") {
        if (event.workspaceId === stableWorkspaceId) {
          await refreshInstrumentationAtLeast(event.revision);
        }
        return;
      }
      if (
        event.kind === "session-started" ||
        event.kind === "stopped" ||
        event.kind === "continued"
      ) {
        await refreshSession(event.sessionId);
      }
    },
    [refreshInstrumentationAtLeast, refreshSession, resyncFromReplaySnapshot, stableWorkspaceId],
  );

  useEffect(() => {
    if (!enabled || stableWorkspaceId.length === 0) return;
    let unsubscribe: (() => void) | undefined;
    const lifecycle: DebugStreamLifecycle = { cancelled: false, eventQueue: Promise.resolve() };
    const start = async (): Promise<void> => {
      try {
        await bootstrap();
        if (lifecycle.cancelled) return;
        await refreshInstrumentation();
        if (lifecycle.cancelled) return;
        unsubscribe = subscribeSharedEventSource(
          debugUrl(stableWorkspaceId, "events"),
          DEBUG_EVENTS,
          (message) => enqueueDebugStreamMessage(lifecycle, message, handleStreamMessage),
        );
      } catch {
        // The server returns a redacted error envelope. Do not log debuggee output or projections.
      }
    };
    start().catch(() => {
      // Startup already returns only redacted failures; no debug payload is logged here.
    });
    return (): void => {
      lifecycle.cancelled = true;
      streamResyncRequired.current = false;
      abortPendingRequests();
      unsubscribe?.();
    };
  }, [
    abortPendingRequests,
    bootstrap,
    enabled,
    handleStreamMessage,
    refreshInstrumentation,
    stableWorkspaceId,
  ]);

  const start = useCallback(
    async (target: DebugLaunchTarget, activationRevision: number): Promise<void> => {
      if (!enabled || stableWorkspaceId.length === 0) return;
      const response = await trackedRequest(
        "/api/editor/debug/sessions",
        debugMutation({
          schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
          workspaceId: stableWorkspaceId,
          target,
          activationRevision,
        }),
      );
      const session = parseSession(response);
      if (session !== null) {
        setDebugSession(stableWorkspaceId, session);
        await refreshSession(session.sessionId);
      }
    },
    [enabled, refreshSession, stableWorkspaceId, trackedRequest],
  );

  const saveBreakpoints = useCallback(
    async (fileId: string, breakpoints: readonly SourceBreakpoint[]): Promise<void> => {
      const instrumentation = await mutationInstrumentation();
      if (instrumentation === null) return;
      const response = await trackedRequest(
        "/api/editor/debug/breakpoints",
        debugMutation(
          {
            schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
            workspaceId: stableWorkspaceId,
            expectedRevision: instrumentation.revision,
            fileId,
            breakpoints,
          },
          "PUT",
          instrumentation.etag,
        ),
      );
      const result = mutationProjection(response);
      if (result !== null) setDebugInstrumentation(stableWorkspaceId, result.snapshot);
    },
    [mutationInstrumentation, stableWorkspaceId, trackedRequest],
  );

  const control = useCallback(
    async (session: DebugSession, action: DebugSessionControlAction): Promise<void> => {
      if (!enabled) return;
      const response = await trackedRequest(
        "/api/editor/debug/control",
        debugMutation({
          schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
          sessionId: session.sessionId,
          action,
          pauseGeneration: session.pauseGeneration,
        }),
      );
      if (response !== null && action !== "pause") {
        abortPendingRequests();
        abortSharedProjectionRequests(stableWorkspaceId);
        setDebugSession(
          stableWorkspaceId,
          action === "stop" ? null : { ...session, status: "running" },
          { allowSameGenerationResume: true },
        );
      }
    },
    [abortPendingRequests, enabled, stableWorkspaceId, trackedRequest],
  );

  const loadStackProjection = useCallback(
    async (session: DebugSession, signal: AbortSignal): Promise<DebugStackSnapshot | null> => {
      const identity = pauseIdentity(session);
      if (
        !enabled ||
        session.status !== "paused" ||
        !currentPauseMatches(stableWorkspaceId, identity)
      ) {
        return null;
      }
      const response = await requestJson("/api/editor/debug/stack", {
        ...inspectionMutation(identity, {
          startFrame: 0,
          levels: DEFAULT_DEBUG_PAYLOAD_LIMITS.maxFramesPerPage,
        }),
        signal,
      });
      const first = parseStack(response);
      if (first === null) return null;
      let parsed: DebugStackSnapshot = first;
      let cursor = first.nextCursor;
      let pageRequests = 1;
      while (
        cursor !== undefined &&
        parsed.frames.length < DEFAULT_DEBUG_PAYLOAD_LIMITS.maxRetainedFrames &&
        pageRequests < MAX_DEBUG_STACK_PAGE_REQUESTS
      ) {
        const next = parseStack(
          await requestJson("/api/editor/debug/stack", {
            ...inspectionMutation(identity, {
              cursor,
              levels: DEFAULT_DEBUG_PAYLOAD_LIMITS.maxFramesPerPage,
            }),
            signal,
          }),
        );
        if (
          next === null ||
          (next.frames.length === 0 && next.nextCursor !== undefined) ||
          !currentPauseMatches(stableWorkspaceId, identity)
        )
          return null;
        parsed = appendStackPage(parsed, next);
        cursor = next.nextCursor;
        pageRequests += 1;
      }
      if (
        cursor !== undefined &&
        parsed.frames.length < DEFAULT_DEBUG_PAYLOAD_LIMITS.maxRetainedFrames
      )
        return null;
      if (signal.aborted || !currentPauseMatches(stableWorkspaceId, identity)) return null;
      return setDebugStack(stableWorkspaceId, identity, parsed) ? parsed : null;
    },
    [enabled, stableWorkspaceId],
  );

  const loadStack = useCallback(
    async (session: DebugSession): Promise<void> => {
      const identity = pauseIdentity(session);
      const current = debugSessionSnapshot(stableWorkspaceId);
      if (!currentPauseMatches(stableWorkspaceId, identity) || current.stack !== null) return;
      await sharedProjection(
        stackProjectionRequests,
        projectionRequestKey(stableWorkspaceId, identity),
        stableWorkspaceId,
        (signal) => loadStackProjection(session, signal),
      );
    },
    [loadStackProjection, stableWorkspaceId],
  );

  const loadScopesProjection = useCallback(
    async (
      session: DebugSession,
      frameRef: string,
      signal: AbortSignal,
    ): Promise<DebugScopeSnapshot | null> => {
      const identity = pauseIdentity(session);
      if (
        !enabled ||
        session.status !== "paused" ||
        !currentPauseMatches(stableWorkspaceId, identity)
      ) {
        return null;
      }
      const response = await requestJson("/api/editor/debug/scopes", {
        ...inspectionMutation(identity, { frameRef }),
        signal,
      });
      const parsed = parseScopes(response, frameRef);
      return parsed !== null &&
        !signal.aborted &&
        currentPauseMatches(stableWorkspaceId, identity) &&
        setDebugScopes(stableWorkspaceId, identity, parsed)
        ? parsed
        : null;
    },
    [enabled, stableWorkspaceId],
  );

  const loadScopes = useCallback(
    async (session: DebugSession, frameRef: string): Promise<void> => {
      const identity = pauseIdentity(session);
      const current = debugSessionSnapshot(stableWorkspaceId);
      if (!currentPauseMatches(stableWorkspaceId, identity) || current.scopesByFrame.has(frameRef))
        return;
      await sharedProjection(
        scopeProjectionRequests,
        projectionRequestKey(stableWorkspaceId, identity, frameRef),
        stableWorkspaceId,
        (signal) => loadScopesProjection(session, frameRef, signal),
      );
    },
    [loadScopesProjection, stableWorkspaceId],
  );

  const loadVariablesProjection = useCallback(
    async (
      session: DebugSession,
      variableRef: string,
      signal: AbortSignal,
    ): Promise<DebugVariableSnapshot | null> => {
      const identity = pauseIdentity(session);
      if (
        !enabled ||
        session.status !== "paused" ||
        !currentPauseMatches(stableWorkspaceId, identity)
      ) {
        return null;
      }
      const response = await requestJson("/api/editor/debug/variables", {
        ...inspectionMutation(identity, { variableRef }),
        signal,
      });
      const parsed = parseVariables(response, variableRef);
      return parsed !== null &&
        !signal.aborted &&
        currentPauseMatches(stableWorkspaceId, identity) &&
        setDebugVariables(stableWorkspaceId, identity, parsed)
        ? parsed
        : null;
    },
    [enabled, stableWorkspaceId],
  );

  const loadVariables = useCallback(
    async (session: DebugSession, variableRef: string): Promise<void> => {
      const identity = pauseIdentity(session);
      const current = debugSessionSnapshot(stableWorkspaceId);
      if (
        !currentPauseMatches(stableWorkspaceId, identity) ||
        current.variablesByParent.has(variableRef)
      )
        return;
      await sharedProjection(
        variableProjectionRequests,
        projectionRequestKey(stableWorkspaceId, identity, variableRef),
        stableWorkspaceId,
        (signal) => loadVariablesProjection(session, variableRef, signal),
      );
    },
    [loadVariablesProjection, stableWorkspaceId],
  );

  const saveWatches = useCallback(
    async (watches: readonly WatchExpression[]): Promise<void> => {
      const instrumentation = await mutationInstrumentation();
      if (instrumentation === null) return;
      const response = await trackedRequest(
        "/api/editor/debug/watches",
        debugMutation(
          {
            schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
            workspaceId: stableWorkspaceId,
            expectedRevision: instrumentation.revision,
            watches,
          },
          "PUT",
          instrumentation.etag,
        ),
      );
      const result = mutationProjection(response);
      if (result !== null)
        replaceDebugWatches(
          stableWorkspaceId,
          result.snapshot.watches,
          result.snapshot.revision,
          result.snapshot.etag,
        );
    },
    [mutationInstrumentation, stableWorkspaceId, trackedRequest],
  );

  const saveExceptionFilters = useCallback(
    async (filters: readonly ExceptionBreakpointFilter[]): Promise<void> => {
      const instrumentation = await mutationInstrumentation();
      if (instrumentation === null) return;
      const response = await trackedRequest(
        "/api/editor/debug/exception-breakpoints",
        debugMutation(
          {
            schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
            workspaceId: stableWorkspaceId,
            expectedRevision: instrumentation.revision,
            filters,
          },
          "PUT",
          instrumentation.etag,
        ),
      );
      const result = mutationProjection(response);
      if (result !== null)
        replaceDebugExceptionFilters(
          stableWorkspaceId,
          result.snapshot.exceptionFilters,
          result.snapshot.revision,
          result.snapshot.etag,
        );
    },
    [mutationInstrumentation, stableWorkspaceId, trackedRequest],
  );

  const evaluateWatch = useCallback(
    async (
      session: DebugSession,
      watchId: string,
      frameRef?: string,
    ): Promise<WatchEvaluationResult | null> => {
      const identity = pauseIdentity(session);
      if (
        !enabled ||
        session.status !== "paused" ||
        !currentPauseMatches(stableWorkspaceId, identity)
      ) {
        return null;
      }
      const response = await trackedRequest(
        "/api/editor/debug/watches/evaluate",
        debugMutation({
          schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
          sessionId: session.sessionId,
          pauseGeneration: session.pauseGeneration,
          watchId,
          ...(frameRef === undefined ? {} : { frameRef }),
        }),
      );
      const parsed = parseWatchResult(response);
      return parsed !== null && setDebugWatchResult(stableWorkspaceId, identity, parsed)
        ? parsed
        : null;
    },
    [enabled, stableWorkspaceId, trackedRequest],
  );

  const setVariable = useCallback(
    async (session: DebugSession, variableRef: string, value: string): Promise<void> => {
      const identity = pauseIdentity(session);
      if (
        !enabled ||
        session.status !== "paused" ||
        !currentPauseMatches(stableWorkspaceId, identity)
      ) {
        return;
      }
      const plan = expandedFramePlan(debugSessionSnapshot(stableWorkspaceId));
      const response = await trackedRequest(
        "/api/editor/debug/variables/set",
        debugMutation({
          schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
          sessionId: session.sessionId,
          pauseGeneration: session.pauseGeneration,
          variableRef,
          value,
        }),
      );
      if (response === null) return;
      const projection = parseSetVariableProjection(response);
      if (
        projection?.sessionId !== identity.sessionId ||
        projection.pauseGeneration !== identity.pauseGeneration
      ) {
        throw new Error("Debug variable projection was invalid.");
      }
      abortPendingRequests();
      abortSharedProjectionRequests(stableWorkspaceId);
      if (!invalidateDebugPausedProjections(stableWorkspaceId, identity)) return;
      const rebuilt = await runTrackedAbortable(
        stableWorkspaceId,
        requestControllers.current,
        (signal) => rebuildPausedProjection(identity, plan, signal),
      );
      if (rebuilt !== undefined) {
        replaceDebugPausedProjections(stableWorkspaceId, identity, rebuilt);
      }
    },
    [abortPendingRequests, enabled, stableWorkspaceId, trackedRequest],
  );

  return useMemo(
    () => ({
      snapshot,
      actions: {
        refreshInstrumentation,
        refreshSession,
        start,
        control,
        saveBreakpoints,
        loadStack,
        loadScopes,
        loadVariables,
        saveWatches,
        saveExceptionFilters,
        evaluateWatch,
        setVariable,
      },
    }),
    [
      control,
      evaluateWatch,
      loadScopes,
      loadStack,
      loadVariables,
      refreshInstrumentation,
      refreshSession,
      saveBreakpoints,
      saveExceptionFilters,
      saveWatches,
      setVariable,
      start,
      snapshot,
    ],
  );
}
