// Issue #1392 — live editor-agent session registry, bounded action queue, and SSE event bus.
//
// The server COORDINATES; the browser bridge OWNS live editor mutation (ADR-0060). This module is the
// single owner of the in-memory, non-persistent control-plane state that the BFF routes operate over:
//
//   1. Session registry  — the latest snapshot each browser bridge has published (bounded).
//   2. Bridge liveness    — which sessions currently hold at least one live SSE connection. A queued
//                           action is only meaningful when a live bridge can execute it; otherwise the
//                           route answers a structured NO_ACTIVE_BRIDGE conflict (AC1).
//   3. Bounded action queue — in-flight actions awaiting a browser result, each armed with a timeout so
//                           a silent bridge cannot strand the queue (AC2). The queue is keyed PER
//                           SESSION so a result, timeout, or re-queue for one session can never touch
//                           another session's slots; the per-session depth is bounded (perf).
//   4. Event bus          — fan-out of session/action/result events, scoped per session so an action
//                           for one session never reaches another session's bridge (bounded fan-out).
//
// The registry NEVER mutates editor/React state and NEVER executes an action — it records, bounds,
// times out, and fans out (AC5). It produces only post-admission *lifecycle* failures (TIMED_OUT /
// QUEUE_FULL); preflight *conflicts* are the route's policy. No raw source content (snapshot text,
// edits, patch bodies) is logged here. The factory mirrors the `createRunRegistry` idiom: a small
// state record plus module-level operations, so each operation stays short and explicitly typed.

import {
  EDITOR_AGENT_SCHEMA_VERSION,
  type EditorAgentAction,
  type EditorAgentActionResult,
  type EditorAgentEvent,
  type EditorAgentFailureCode,
  type EditorAgentSessionSnapshot,
} from "@oscharko-dev/keiko-contracts";

// A queued action the bridge never acknowledges within ACTION_TIMEOUT_MS is failed and evicted so the
// bounded queue self-heals (AC2). MAX_QUEUED_PER_SESSION bounds the in-flight depth per session;
// MAX_SESSIONS bounds the snapshot registry so a long-lived server cannot grow it without limit.
export const EDITOR_AGENT_ACTION_TIMEOUT_MS = 15_000;
export const EDITOR_AGENT_MAX_QUEUED_PER_SESSION = 64;
export const EDITOR_AGENT_MAX_SESSIONS = 256;

export type EditorAgentSubscriber = (event: EditorAgentEvent) => void;

export interface EditorAgentRegistryOptions {
  // Milliseconds before an unacknowledged queued action is failed with TIMED_OUT.
  readonly actionTimeoutMs?: number | undefined;
  // Maximum in-flight (queued, not yet resolved) actions per session before QUEUE_FULL backpressure.
  readonly maxQueuedPerSession?: number | undefined;
  // Maximum registered session snapshots before the oldest idle session is evicted.
  readonly maxSessions?: number | undefined;
  // Injection seams so unit tests drive the action timeout deterministically. Production uses an
  // unref'd setTimeout so a pending action never keeps the process alive.
  readonly setTimer?: ((handler: () => void, ms: number) => unknown) | undefined;
  readonly clearTimer?: ((handle: unknown) => void) | undefined;
}

export type EditorAgentQueueOutcome =
  | { readonly kind: "queued"; readonly result: EditorAgentActionResult }
  | { readonly kind: "rejected"; readonly result: EditorAgentActionResult };

export interface EditorAgentRegistry {
  registerSnapshot(snapshot: EditorAgentSessionSnapshot): void;
  listSessions(): readonly EditorAgentSessionSnapshot[];
  snapshotFor(sessionId: string): EditorAgentSessionSnapshot | undefined;
  selectSnapshot(sessionId?: string): EditorAgentSessionSnapshot | undefined;
  hasLiveBridge(sessionId: string): boolean;
  liveBridgeCount(sessionId: string): number;
  connect(sessionId: string | undefined, send: EditorAgentSubscriber): () => void;
  // Admits `action` to the bounded per-session queue (arming its timeout) and fans out `emitAction` —
  // the route passes the possibly patch-derived envelope to broadcast, keyed for lifecycle by the
  // original action's (sessionId, actionId). The caller MUST have already cleared preflight policy.
  // A second admit for an actionId already in flight for that session is rejected (no silent
  // supersede), so the first action's deadline is preserved.
  queueAction(action: EditorAgentAction, emitAction: EditorAgentAction): EditorAgentQueueOutcome;
  // Fans out a result event. A result whose (sessionId, actionId) matches a queued action also clears
  // its timeout and frees that session's slot; any other result (preflight conflicts, late or
  // cross-session acks) is fanned out as-is without touching the queue.
  reportResult(result: EditorAgentActionResult): void;
  pendingCount(sessionId: string): number;
  reset(): void;
}

interface PendingAction {
  readonly timer: unknown;
}

type EditorAgentEventPayload =
  | { readonly type: "session"; readonly snapshot: EditorAgentSessionSnapshot }
  | { readonly type: "action"; readonly action: EditorAgentAction }
  | { readonly type: "result"; readonly result: EditorAgentActionResult };

interface RegistryState {
  readonly sessions: Map<string, EditorAgentSessionSnapshot>;
  readonly bridges: Map<string, Set<EditorAgentSubscriber>>;
  readonly observers: Set<EditorAgentSubscriber>;
  // sessionId -> actionId -> pending entry. Session-scoped so no cross-session interference is possible
  // and the per-session depth is exactly the inner map's size (no separate counter to drift).
  readonly pending: Map<string, Map<string, PendingAction>>;
  readonly actionTimeoutMs: number;
  readonly maxQueuedPerSession: number;
  readonly maxSessions: number;
  readonly setTimer: (handler: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  eventSeq: number;
}

function defaultSetTimer(handler: () => void, ms: number): unknown {
  const handle = setTimeout(handler, ms);
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function lifecycleFailure(
  action: EditorAgentAction,
  code: EditorAgentFailureCode,
  message: string,
): EditorAgentActionResult {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "failed",
    message,
    failure: { code, message },
  };
}

function eventSessionId(event: EditorAgentEvent): string | undefined {
  switch (event.type) {
    case "session":
      return event.snapshot.sessionId;
    case "action":
      return event.action.sessionId;
    case "result":
      return event.result.sessionId;
    case "heartbeat":
      return undefined;
  }
}

// Bounded fan-out: a session-scoped event reaches the global observers plus that session's own bridge
// connections, never every bridge. A session-less event (heartbeat) reaches everyone.
function deliver(state: RegistryState, event: EditorAgentEvent): void {
  for (const send of state.observers) send(event);
  const sessionId = eventSessionId(event);
  if (sessionId === undefined) {
    for (const set of state.bridges.values()) {
      for (const send of set) send(event);
    }
    return;
  }
  const set = state.bridges.get(sessionId);
  if (set === undefined) return;
  for (const send of set) send(event);
}

function emit(state: RegistryState, payload: EditorAgentEventPayload): void {
  state.eventSeq += 1;
  deliver(state, {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    eventId: `editor-agent-${String(state.eventSeq)}`,
    ...payload,
  });
}

function clearPending(state: RegistryState, sessionId: string, actionId: string): boolean {
  const inner = state.pending.get(sessionId);
  const entry = inner?.get(actionId);
  if (inner === undefined || entry === undefined) return false;
  state.clearTimer(entry.timer);
  inner.delete(actionId);
  if (inner.size === 0) state.pending.delete(sessionId);
  return true;
}

function onTimeout(state: RegistryState, action: EditorAgentAction): void {
  const inner = state.pending.get(action.sessionId);
  if (inner?.get(action.actionId) === undefined) return;
  inner.delete(action.actionId);
  if (inner.size === 0) state.pending.delete(action.sessionId);
  emit(state, {
    type: "result",
    result: lifecycleFailure(
      action,
      "TIMED_OUT",
      "The browser bridge did not report a result before the deadline.",
    ),
  });
}

function connectImpl(
  state: RegistryState,
  sessionId: string | undefined,
  send: EditorAgentSubscriber,
): () => void {
  if (sessionId === undefined) {
    state.observers.add(send);
    return () => {
      state.observers.delete(send);
    };
  }
  let set = state.bridges.get(sessionId);
  if (set === undefined) {
    set = new Set();
    state.bridges.set(sessionId, set);
  }
  set.add(send);
  return () => {
    const current = state.bridges.get(sessionId);
    if (current === undefined) return;
    current.delete(send);
    if (current.size === 0) state.bridges.delete(sessionId);
  };
}

function queueActionImpl(
  state: RegistryState,
  action: EditorAgentAction,
  emitAction: EditorAgentAction,
): EditorAgentQueueOutcome {
  const inner = state.pending.get(action.sessionId);
  if (inner?.get(action.actionId) !== undefined) {
    // A second admit for an actionId already in flight would otherwise strand the first action's
    // deadline; reject it instead so the first action still self-heals (AC2). Pure rejection — the
    // existing slot/timer are untouched.
    return {
      kind: "rejected",
      result: {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        actionId: action.actionId,
        sessionId: action.sessionId,
        status: "failed",
        message: "An action with this id is already in flight for this session.",
      },
    };
  }
  if ((inner?.size ?? 0) >= state.maxQueuedPerSession) {
    return {
      kind: "rejected",
      result: lifecycleFailure(
        action,
        "QUEUE_FULL",
        "The editor action queue for this session is full; retry once an action completes.",
      ),
    };
  }
  const slots = inner ?? new Map<string, PendingAction>();
  if (inner === undefined) state.pending.set(action.sessionId, slots);
  const timer = state.setTimer(() => {
    onTimeout(state, action);
  }, state.actionTimeoutMs);
  slots.set(action.actionId, { timer });
  emit(state, { type: "action", action: emitAction });
  return {
    kind: "queued",
    result: {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: action.actionId,
      sessionId: action.sessionId,
      status: "queued",
    },
  };
}

function reportResultImpl(state: RegistryState, result: EditorAgentActionResult): void {
  // Correlate strictly by (sessionId, actionId): a result can only resolve its own session's slot, so
  // a mismatched or cross-session result is fanned out for visibility without disturbing the queue.
  clearPending(state, result.sessionId, result.actionId);
  emit(state, { type: "result", result });
}

// Bound the snapshot registry: when over the cap, evict the oldest session that is neither bridged nor
// has in-flight actions (so active work is never disrupted), preferring the just-registered session
// last. If every other session is busy the registry is left slightly over the soft cap.
function evictOldestIdleSession(state: RegistryState, keepSessionId: string): void {
  for (const sessionId of state.sessions.keys()) {
    if (sessionId === keepSessionId) continue;
    if ((state.bridges.get(sessionId)?.size ?? 0) > 0) continue;
    if ((state.pending.get(sessionId)?.size ?? 0) > 0) continue;
    state.sessions.delete(sessionId);
    return;
  }
}

function resetImpl(state: RegistryState): void {
  for (const inner of state.pending.values()) {
    for (const entry of inner.values()) state.clearTimer(entry.timer);
  }
  state.sessions.clear();
  state.bridges.clear();
  state.observers.clear();
  state.pending.clear();
  state.eventSeq = 0;
}

export function createEditorAgentRegistry(
  options: EditorAgentRegistryOptions = {},
): EditorAgentRegistry {
  const state: RegistryState = {
    sessions: new Map(),
    bridges: new Map(),
    observers: new Set(),
    pending: new Map(),
    actionTimeoutMs: options.actionTimeoutMs ?? EDITOR_AGENT_ACTION_TIMEOUT_MS,
    maxQueuedPerSession: options.maxQueuedPerSession ?? EDITOR_AGENT_MAX_QUEUED_PER_SESSION,
    maxSessions: options.maxSessions ?? EDITOR_AGENT_MAX_SESSIONS,
    setTimer: options.setTimer ?? defaultSetTimer,
    clearTimer: options.clearTimer ?? defaultClearTimer,
    eventSeq: 0,
  };
  return {
    registerSnapshot: (snapshot): void => {
      state.sessions.set(snapshot.sessionId, snapshot);
      if (state.sessions.size > state.maxSessions) {
        evictOldestIdleSession(state, snapshot.sessionId);
      }
      emit(state, { type: "session", snapshot });
    },
    listSessions: (): readonly EditorAgentSessionSnapshot[] => [...state.sessions.values()],
    snapshotFor: (sessionId): EditorAgentSessionSnapshot | undefined =>
      state.sessions.get(sessionId),
    selectSnapshot: (sessionId): EditorAgentSessionSnapshot | undefined =>
      sessionId === undefined ? [...state.sessions.values()][0] : state.sessions.get(sessionId),
    hasLiveBridge: (sessionId): boolean => (state.bridges.get(sessionId)?.size ?? 0) > 0,
    liveBridgeCount: (sessionId): number => state.bridges.get(sessionId)?.size ?? 0,
    connect: (sessionId, send): (() => void) => connectImpl(state, sessionId, send),
    queueAction: (action, emitAction): EditorAgentQueueOutcome =>
      queueActionImpl(state, action, emitAction),
    reportResult: (result): void => {
      reportResultImpl(state, result);
    },
    pendingCount: (sessionId): number => state.pending.get(sessionId)?.size ?? 0,
    reset: (): void => {
      resetImpl(state);
    },
  };
}

// Process-wide singleton used by the BFF routes. Unit tests construct isolated instances with injected
// timers; the route integration/security tests share this singleton and reset it between cases.
export const editorAgentRegistry: EditorAgentRegistry = createEditorAgentRegistry();
