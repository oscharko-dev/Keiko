"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
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
import { subscribeSharedEventSource } from "./sharedEventSource";
import {
  applyDebugEvent,
  debugSessionSnapshot,
  markDebugStreamReady,
  replaceDebugExceptionFilters,
  replaceDebugWatches,
  setDebugInstrumentation,
  setDebugScopes,
  setDebugSession,
  setDebugStack,
  setDebugVariables,
  setDebugWatchResult,
  subscribeDebugSession,
  type DebugScopeSnapshot,
  type DebugSessionSnapshot,
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
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parseEvent(value: unknown): DebugEvent | null {
  if (!isRecord(value)) return null;
  const kind = stringValue(value.kind);
  const sessionId = stringValue(value.sessionId);
  if (kind === "output") {
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
      kind,
      sessionId,
      category,
      text,
      truncated: value.truncated,
      originalBytes,
      omittedBytes,
    };
  }
  if (kind === "continued") {
    const pauseGeneration = numberValue(value.pauseGeneration);
    return sessionId === null || pauseGeneration === null
      ? null
      : { kind, sessionId, pauseGeneration };
  }
  if (kind === "stopped") {
    const pauseGeneration = numberValue(value.pauseGeneration);
    const reason = stringValue(value.reason);
    const description =
      value.description === undefined ? undefined : boundedText(value.description);
    if (
      sessionId === null ||
      pauseGeneration === null ||
      (value.description !== undefined && description === null) ||
      typeof value.allThreadsStopped !== "boolean" ||
      (reason !== "breakpoint" &&
        reason !== "exception" &&
        reason !== "pause" &&
        reason !== "step" &&
        reason !== "entry" &&
        reason !== "restart")
    )
      return null;
    return {
      kind,
      sessionId,
      pauseGeneration,
      reason,
      allThreadsStopped: value.allThreadsStopped,
      ...(description === null || description === undefined ? {} : { description }),
    };
  }
  if (kind === "session-started") {
    const status = stringValue(value.status);
    return sessionId === null || (status !== "starting" && status !== "running")
      ? null
      : { kind, sessionId, status };
  }
  if (kind === "session-stopped") {
    const status = stringValue(value.status);
    const reason = stringValue(value.reason);
    if (
      sessionId === null ||
      (status !== "stopped" && status !== "failed" && status !== "revoked") ||
      (reason !== "requested" &&
        reason !== "exited" &&
        reason !== "failed" &&
        reason !== "revoked" &&
        reason !== "limit")
    )
      return null;
    return { kind, sessionId, status, reason };
  }
  if (kind === "exited") {
    const exitCode = numberValue(value.exitCode);
    return sessionId === null || exitCode === null ? null : { kind, sessionId, exitCode };
  }
  if (kind === "breakpoints-changed") {
    const workspaceId = stringValue(value.workspaceId);
    const revision = numberValue(value.revision);
    const breakpointCount = numberValue(value.breakpointCount);
    const verifiedCount = numberValue(value.verifiedCount);
    return workspaceId === null ||
      revision === null ||
      breakpointCount === null ||
      verifiedCount === null
      ? null
      : { kind, workspaceId, revision, breakpointCount, verifiedCount };
  }
  if (kind === "projection-truncated") {
    const originalBytes = numberValue(value.originalBytes);
    return value.reason !== "sse-event-size" || originalBytes === null
      ? null
      : { kind, reason: "sse-event-size", originalBytes };
  }
  return null;
}

function parseEnvelope(value: unknown): DebugEventEnvelope | null {
  if (!isRecord(value)) return null;
  const sequence = numberValue(value.sequence);
  const event = parseEvent(value.event);
  return sequence === null || event === null ? null : { sequence, event };
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

function parseStack(value: unknown): {
  readonly frames: readonly StackFrame[];
  readonly truncated: boolean;
  readonly omittedCount: number;
} | null {
  if (
    !isRecord(value) ||
    !arrayOf(value.frames, stackFrame) ||
    typeof value.truncated !== "boolean"
  )
    return null;
  const omittedCount = numberValue(value.omittedCount);
  return omittedCount === null
    ? null
    : { frames: value.frames, truncated: value.truncated, omittedCount };
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

  const bootstrap = useCallback(async (): Promise<void> => {
    if (!enabled || stableWorkspaceId.length === 0) return;
    await sharedBootstrap(stableWorkspaceId);
  }, [enabled, stableWorkspaceId]);

  const refreshInstrumentation = useCallback(async (): Promise<void> => {
    if (!enabled || stableWorkspaceId.length === 0) return;
    const response = await requestJson(debugUrl(stableWorkspaceId, "instrumentation"));
    const parsed = instrument(response);
    if (parsed !== null) setDebugInstrumentation(stableWorkspaceId, parsed);
  }, [enabled, stableWorkspaceId]);

  const refreshSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!enabled) return;
      const response = await requestJson(
        `/api/editor/debug/sessions/${encodeURIComponent(sessionId)}`,
        { headers: { "x-keiko-csrf": "1" } },
      );
      const session = parseSession(response);
      if (session !== null) setDebugSession(stableWorkspaceId, session);
    },
    [enabled, stableWorkspaceId],
  );

  useEffect(() => {
    if (!enabled || stableWorkspaceId.length === 0) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    const start = async (): Promise<void> => {
      try {
        await bootstrap();
        if (cancelled) return;
        await refreshInstrumentation();
        if (cancelled) return;
        unsubscribe = subscribeSharedEventSource(
          debugUrl(stableWorkspaceId, "events"),
          DEBUG_EVENTS,
          (message) => {
            if (message.type === "ready") {
              markDebugStreamReady(stableWorkspaceId);
              return;
            }
            const parsed = parseEnvelope(parseJson(message.data));
            if (parsed === null) return;
            applyDebugEvent(stableWorkspaceId, parsed.sequence, parsed.event);
            if (parsed.event.kind === "session-stopped" || parsed.event.kind === "exited") {
              const current = debugSessionSnapshot(stableWorkspaceId).session;
              if (current?.sessionId === parsed.event.sessionId) {
                setDebugSession(stableWorkspaceId, null);
              }
              return;
            }
            if (
              parsed.event.kind === "session-started" ||
              parsed.event.kind === "stopped" ||
              parsed.event.kind === "continued"
            ) {
              void refreshSession(parsed.event.sessionId);
            }
          },
        );
      } catch {
        // The server returns a redacted error envelope. Do not log debuggee output or projections.
      }
    };
    void start();
    return (): void => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [bootstrap, enabled, refreshInstrumentation, refreshSession, stableWorkspaceId]);

  const start = useCallback(
    async (target: DebugLaunchTarget, activationRevision: number): Promise<void> => {
      if (!enabled || stableWorkspaceId.length === 0) return;
      const response = await requestJson(
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
    [enabled, refreshSession, stableWorkspaceId],
  );

  const saveBreakpoints = useCallback(
    async (fileId: string, breakpoints: readonly SourceBreakpoint[]): Promise<void> => {
      const instrumentation = debugSessionSnapshot(stableWorkspaceId).instrumentation;
      if (!enabled || instrumentation === null) return;
      const response = await requestJson(
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
    [enabled, stableWorkspaceId],
  );

  const control = useCallback(
    async (session: DebugSession, action: DebugSessionControlAction): Promise<void> => {
      if (!enabled) return;
      await requestJson(
        "/api/editor/debug/control",
        debugMutation({
          schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
          sessionId: session.sessionId,
          action,
          pauseGeneration: session.pauseGeneration,
        }),
      );
    },
    [enabled],
  );

  const loadStack = useCallback(
    async (session: DebugSession): Promise<void> => {
      if (!enabled || session.status !== "paused") return;
      const response = await requestJson(
        "/api/editor/debug/stack",
        debugMutation({
          schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
          sessionId: session.sessionId,
          pauseGeneration: session.pauseGeneration,
          startFrame: 0,
          levels: DEFAULT_DEBUG_PAYLOAD_LIMITS.maxFramesPerPage,
        }),
      );
      const parsed = parseStack(response);
      if (parsed !== null) setDebugStack(stableWorkspaceId, parsed);
    },
    [enabled, stableWorkspaceId],
  );

  const loadScopes = useCallback(
    async (session: DebugSession, frameRef: string): Promise<void> => {
      if (!enabled || session.status !== "paused") return;
      const response = await requestJson(
        "/api/editor/debug/scopes",
        debugMutation({
          schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
          sessionId: session.sessionId,
          pauseGeneration: session.pauseGeneration,
          frameRef,
        }),
      );
      const parsed = parseScopes(response, frameRef);
      if (parsed !== null) setDebugScopes(stableWorkspaceId, parsed);
    },
    [enabled, stableWorkspaceId],
  );

  const loadVariables = useCallback(
    async (session: DebugSession, variableRef: string): Promise<void> => {
      if (!enabled || session.status !== "paused") return;
      const response = await requestJson(
        "/api/editor/debug/variables",
        debugMutation({
          schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
          sessionId: session.sessionId,
          pauseGeneration: session.pauseGeneration,
          variableRef,
        }),
      );
      const parsed = parseVariables(response, variableRef);
      if (parsed !== null) setDebugVariables(stableWorkspaceId, parsed);
    },
    [enabled, stableWorkspaceId],
  );

  const saveWatches = useCallback(
    async (watches: readonly WatchExpression[]): Promise<void> => {
      const instrumentation = debugSessionSnapshot(stableWorkspaceId).instrumentation;
      if (!enabled || instrumentation === null) return;
      const response = await requestJson(
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
    [enabled, stableWorkspaceId],
  );

  const saveExceptionFilters = useCallback(
    async (filters: readonly ExceptionBreakpointFilter[]): Promise<void> => {
      const instrumentation = debugSessionSnapshot(stableWorkspaceId).instrumentation;
      if (!enabled || instrumentation === null) return;
      const response = await requestJson(
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
    [enabled, stableWorkspaceId],
  );

  const evaluateWatch = useCallback(
    async (
      session: DebugSession,
      watchId: string,
      frameRef?: string,
    ): Promise<WatchEvaluationResult | null> => {
      if (!enabled || session.status !== "paused") return null;
      const response = await requestJson(
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
      if (parsed !== null) setDebugWatchResult(stableWorkspaceId, parsed);
      return parsed;
    },
    [enabled, stableWorkspaceId],
  );

  const setVariable = useCallback(
    async (session: DebugSession, variableRef: string, value: string): Promise<void> => {
      if (!enabled || session.status !== "paused") return;
      await requestJson(
        "/api/editor/debug/variables/set",
        debugMutation({
          schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
          sessionId: session.sessionId,
          pauseGeneration: session.pauseGeneration,
          variableRef,
          value,
        }),
      );
    },
    [enabled],
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
