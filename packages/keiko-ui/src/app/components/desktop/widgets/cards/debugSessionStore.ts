"use client";

import {
  DEFAULT_DEBUG_PAYLOAD_LIMITS,
  type BoundedDebugText,
  type DebugEvent,
  type DebugSession,
  type DebugVariableNode,
  type ExceptionBreakpointFilter,
  type InstrumentationSnapshot,
  type Scope,
  type StackFrame,
  type WatchEvaluationResult,
  type WatchExpression,
} from "@oscharko-dev/keiko-contracts";

export interface DebugStackSnapshot {
  readonly frames: readonly StackFrame[];
  readonly truncated: boolean;
  readonly omittedCount: number;
}

export interface DebugScopeSnapshot {
  readonly frameRef: string;
  readonly scopes: readonly Scope[];
  readonly truncated: boolean;
  readonly omittedCount: number;
}

export interface DebugVariableSnapshot {
  readonly parentRef: string;
  readonly nodes: readonly DebugVariableNode[];
  readonly truncated: boolean;
  readonly omittedCount: number;
}

export interface DebugPauseIdentity {
  readonly sessionId: string;
  readonly pauseGeneration: number;
}

export interface DebugPausedProjection {
  readonly stack: DebugStackSnapshot;
  readonly scopes: readonly DebugScopeSnapshot[];
  readonly variables: readonly DebugVariableSnapshot[];
}

export interface DebugConsoleEntry {
  readonly id: number;
  readonly category: "stdout" | "stderr" | "console";
  readonly text: string;
  readonly truncated: boolean;
}

export interface DebugConsoleSnapshot {
  readonly entries: readonly DebugConsoleEntry[];
  readonly retainedBytes: number;
  readonly evictedEntries: number;
  readonly evictedBytes: number;
}

export interface DebugSessionSnapshot {
  readonly instrumentation: InstrumentationSnapshot | null;
  readonly session: DebugSession | null;
  readonly stack: DebugStackSnapshot | null;
  readonly scopesByFrame: ReadonlyMap<string, DebugScopeSnapshot>;
  readonly variablesByParent: ReadonlyMap<string, DebugVariableSnapshot>;
  readonly watchResults: ReadonlyMap<string, WatchEvaluationResult>;
  readonly console: DebugConsoleSnapshot;
  readonly stopDescription: BoundedDebugText | null;
  readonly sequence: number;
  readonly streamReady: boolean;
}

interface DebugProjectState {
  snapshot: DebugSessionSnapshot;
  readonly listeners: Set<() => void>;
}

const EMPTY_MAP = new Map<string, never>();
const EMPTY_CONSOLE: DebugConsoleSnapshot = Object.freeze({
  entries: Object.freeze([]),
  retainedBytes: 0,
  evictedEntries: 0,
  evictedBytes: 0,
});
const EMPTY_SNAPSHOT: DebugSessionSnapshot = Object.freeze({
  instrumentation: null,
  session: null,
  stack: null,
  scopesByFrame: EMPTY_MAP,
  variablesByParent: EMPTY_MAP,
  watchResults: EMPTY_MAP,
  console: EMPTY_CONSOLE,
  stopDescription: null,
  sequence: 0,
  streamReady: false,
});
const TEXT_ENCODER = new TextEncoder();
const ENTRY_BYTES = new WeakMap<DebugConsoleEntry, number>();
const MAX_CONSOLE_BYTES = 512 * 1024;
const MAX_CONSOLE_ENTRIES = 2_000;
const states = new Map<string, DebugProjectState>();

function stateFor(workspaceId: string): DebugProjectState {
  const existing = states.get(workspaceId);
  if (existing !== undefined) return existing;
  const state: DebugProjectState = { snapshot: EMPTY_SNAPSHOT, listeners: new Set() };
  states.set(workspaceId, state);
  return state;
}

function publish(state: DebugProjectState, snapshot: DebugSessionSnapshot): void {
  state.snapshot = snapshot;
  for (const listener of [...state.listeners]) listener();
}

function entryBytes(entry: DebugConsoleEntry): number {
  const retained = ENTRY_BYTES.get(entry);
  if (retained !== undefined) return retained;
  const encoded = TEXT_ENCODER.encode(entry.text).length;
  ENTRY_BYTES.set(entry, encoded);
  return encoded;
}

function boundedConsole(
  current: DebugConsoleSnapshot,
  entry: DebugConsoleEntry,
): DebugConsoleSnapshot {
  const entries = [...current.entries, entry];
  let retainedBytes = current.retainedBytes + entryBytes(entry);
  let evictedEntries = current.evictedEntries;
  let evictedBytes = current.evictedBytes;
  while (entries.length > MAX_CONSOLE_ENTRIES || retainedBytes > MAX_CONSOLE_BYTES) {
    const removed = entries.shift();
    if (removed === undefined) break;
    const removedBytes = entryBytes(removed);
    retainedBytes -= removedBytes;
    evictedEntries += 1;
    evictedBytes += removedBytes;
  }
  return { entries, retainedBytes, evictedEntries, evictedBytes };
}

function eventConsoleEntry(
  event: Extract<DebugEvent, { readonly kind: "output" }>,
  id: number,
): DebugConsoleEntry {
  return {
    id,
    category: event.category,
    text: event.text,
    truncated: event.truncated,
  };
}

function resetPausedProjections(snapshot: DebugSessionSnapshot): DebugSessionSnapshot {
  return {
    ...snapshot,
    stack: null,
    scopesByFrame: new Map(),
    variablesByParent: new Map(),
    watchResults: new Map(),
  };
}

export function debugSessionSnapshot(workspaceId: string): DebugSessionSnapshot {
  return states.get(workspaceId)?.snapshot ?? EMPTY_SNAPSHOT;
}

export function subscribeDebugSession(workspaceId: string, listener: () => void): () => void {
  if (workspaceId.length === 0) return (): void => {};
  const state = stateFor(workspaceId);
  state.listeners.add(listener);
  return (): void => {
    state.listeners.delete(listener);
    if (state.listeners.size === 0 && state.snapshot === EMPTY_SNAPSHOT) states.delete(workspaceId);
  };
}

export function setDebugInstrumentation(
  workspaceId: string,
  instrumentation: InstrumentationSnapshot,
): boolean {
  const state = stateFor(workspaceId);
  const current = state.snapshot.instrumentation;
  if (
    instrumentation.workspaceId !== workspaceId ||
    (current !== null && instrumentation.revision < current.revision)
  ) {
    return false;
  }
  publish(state, { ...state.snapshot, instrumentation });
  return true;
}

interface DebugSessionUpdateOptions {
  readonly allowSameGenerationResume?: boolean | undefined;
}

function stalePauseProjection(
  current: DebugSession | null,
  next: DebugSession | null,
  allowSameGenerationResume: boolean,
): boolean {
  return (
    current !== null &&
    next !== null &&
    current.sessionId === next.sessionId &&
    (next.pauseGeneration < current.pauseGeneration ||
      (current.status === "paused" &&
        next.status !== "paused" &&
        next.pauseGeneration === current.pauseGeneration &&
        !allowSameGenerationResume))
  );
}

function progressedBeyondPause(
  current: DebugSession | null,
  next: DebugSession | null,
  allowSameGenerationResume: boolean,
): boolean {
  return (
    current?.status === "paused" &&
    next !== null &&
    next.sessionId === current.sessionId &&
    next.status !== "paused" &&
    (next.pauseGeneration > current.pauseGeneration ||
      (allowSameGenerationResume && next.pauseGeneration === current.pauseGeneration))
  );
}

export function setDebugSession(
  workspaceId: string,
  session: DebugSession | null,
  options: DebugSessionUpdateOptions = {},
): void {
  const state = stateFor(workspaceId);
  const allowSameGenerationResume = options.allowSameGenerationResume ?? false;
  if (session !== null && session.workspaceId !== workspaceId) return;
  if (stalePauseProjection(state.snapshot.session, session, allowSameGenerationResume)) return;
  const changedPause =
    session === null ||
    state.snapshot.session?.sessionId !== session.sessionId ||
    state.snapshot.session.pauseGeneration !== session.pauseGeneration ||
    session.status !== "paused";
  const next = changedPause ? resetPausedProjections(state.snapshot) : state.snapshot;
  publish(state, {
    ...next,
    session,
    ...(session === null ||
    progressedBeyondPause(state.snapshot.session, session, allowSameGenerationResume)
      ? { stopDescription: null }
      : {}),
  });
}

export function setDebugStack(
  workspaceId: string,
  identity: DebugPauseIdentity,
  input: {
    readonly frames: readonly StackFrame[];
    readonly truncated: boolean;
    readonly omittedCount: number;
  },
): boolean {
  const state = stateFor(workspaceId);
  if (!currentPauseMatches(state.snapshot, identity)) return false;
  publish(state, { ...state.snapshot, stack: { ...input } });
  return true;
}

export function setDebugScopes(
  workspaceId: string,
  identity: DebugPauseIdentity,
  snapshot: DebugScopeSnapshot,
): boolean {
  const state = stateFor(workspaceId);
  if (!currentPauseMatches(state.snapshot, identity)) return false;
  const scopesByFrame = new Map(state.snapshot.scopesByFrame);
  scopesByFrame.set(snapshot.frameRef, snapshot);
  publish(state, { ...state.snapshot, scopesByFrame });
  return true;
}

export function setDebugVariables(
  workspaceId: string,
  identity: DebugPauseIdentity,
  snapshot: DebugVariableSnapshot,
): boolean {
  const state = stateFor(workspaceId);
  if (!currentPauseMatches(state.snapshot, identity)) return false;
  const variablesByParent = new Map(state.snapshot.variablesByParent);
  variablesByParent.set(snapshot.parentRef, snapshot);
  publish(state, { ...state.snapshot, variablesByParent });
  return true;
}

export function setDebugWatchResult(
  workspaceId: string,
  identity: DebugPauseIdentity,
  result: WatchEvaluationResult,
): boolean {
  const state = stateFor(workspaceId);
  if (
    result.pauseGeneration !== identity.pauseGeneration ||
    !currentPauseMatches(state.snapshot, identity)
  ) {
    return false;
  }
  const watchResults = new Map(state.snapshot.watchResults);
  watchResults.set(result.watchId, result);
  publish(state, { ...state.snapshot, watchResults });
  return true;
}

function currentPauseMatches(
  snapshot: DebugSessionSnapshot,
  identity: DebugPauseIdentity,
): boolean {
  return (
    snapshot.session?.status === "paused" &&
    snapshot.session.sessionId === identity.sessionId &&
    snapshot.session.pauseGeneration === identity.pauseGeneration
  );
}

export function invalidateDebugPausedProjections(
  workspaceId: string,
  identity: DebugPauseIdentity,
): boolean {
  const state = stateFor(workspaceId);
  if (!currentPauseMatches(state.snapshot, identity)) return false;
  publish(state, resetPausedProjections(state.snapshot));
  return true;
}

export function replaceDebugPausedProjections(
  workspaceId: string,
  identity: DebugPauseIdentity,
  projection: DebugPausedProjection,
): boolean {
  const state = stateFor(workspaceId);
  if (!currentPauseMatches(state.snapshot, identity)) return false;
  const scopesByFrame = new Map(
    projection.scopes.map((snapshot) => [snapshot.frameRef, snapshot] as const),
  );
  const variablesByParent = new Map(
    projection.variables.map((snapshot) => [snapshot.parentRef, snapshot] as const),
  );
  publish(state, {
    ...state.snapshot,
    stack: projection.stack,
    scopesByFrame,
    variablesByParent,
    watchResults: new Map(),
  });
  return true;
}

export function beginDebugStreamResync(workspaceId: string): void {
  const state = stateFor(workspaceId);
  publish(state, {
    ...resetPausedProjections(state.snapshot),
    console: EMPTY_CONSOLE,
    stopDescription: null,
    streamReady: false,
  });
}

export function synchronizeDebugSequence(workspaceId: string, sequence: number): void {
  const state = stateFor(workspaceId);
  if (sequence === state.snapshot.sequence) return;
  publish(state, { ...state.snapshot, sequence });
}

export function applyDebugEvent(workspaceId: string, sequence: number, event: DebugEvent): void {
  const state = stateFor(workspaceId);
  if (sequence <= state.snapshot.sequence) return;
  let next: DebugSessionSnapshot = { ...state.snapshot, sequence };
  if (event.kind === "output") {
    next = {
      ...next,
      console: boundedConsole(next.console, eventConsoleEntry(event, sequence)),
    };
  } else if (event.kind === "session-started" || event.kind === "continued") {
    next = { ...resetPausedProjections(next), stopDescription: null };
    if (next.session?.sessionId === event.sessionId) {
      next = {
        ...next,
        session: {
          ...next.session,
          status: event.kind === "continued" ? "running" : event.status,
          ...(event.kind === "continued" ? { pauseGeneration: event.pauseGeneration } : {}),
        },
      };
    } else if (event.kind === "session-started") {
      next = { ...next, session: null };
    }
  } else if (event.kind === "stopped") {
    next = {
      ...resetPausedProjections(next),
      stopDescription: event.reason === "exception" ? (event.description ?? null) : null,
    };
    if (next.session?.sessionId === event.sessionId) {
      next = {
        ...next,
        session: {
          ...next.session,
          status: "paused",
          pauseGeneration: event.pauseGeneration,
        },
      };
    }
  } else if (event.kind === "session-stopped" || event.kind === "exited") {
    next = {
      ...resetPausedProjections(next),
      session: next.session?.sessionId === event.sessionId ? null : next.session,
      stopDescription: null,
    };
  }
  publish(state, next);
}

export function markDebugStreamReady(workspaceId: string): void {
  const state = stateFor(workspaceId);
  if (state.snapshot.streamReady) return;
  publish(state, { ...state.snapshot, streamReady: true });
}

export function replaceDebugWatches(
  workspaceId: string,
  watches: readonly WatchExpression[],
  revision: number,
  etag: string,
): void {
  const state = stateFor(workspaceId);
  const instrumentation = state.snapshot.instrumentation;
  if (instrumentation === null) return;
  publish(state, {
    ...state.snapshot,
    instrumentation: { ...instrumentation, watches, revision, etag },
  });
}

export function replaceDebugExceptionFilters(
  workspaceId: string,
  exceptionFilters: readonly ExceptionBreakpointFilter[],
  revision: number,
  etag: string,
): void {
  const state = stateFor(workspaceId);
  const instrumentation = state.snapshot.instrumentation;
  if (instrumentation === null) return;
  publish(state, {
    ...state.snapshot,
    instrumentation: { ...instrumentation, exceptionFilters, revision, etag },
  });
}

export function resetDebugSessionStoreForTests(): void {
  states.clear();
}

export const DEBUG_CONSOLE_LIMITS = Object.freeze({
  maxBytes: MAX_CONSOLE_BYTES,
  maxEntries: MAX_CONSOLE_ENTRIES,
  upstreamMaxOutputBytes: DEFAULT_DEBUG_PAYLOAD_LIMITS.maxOutputBytes,
});
