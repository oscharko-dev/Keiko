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

import { timingSafeEqual } from "node:crypto";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  isMutatingEditorAgentAction,
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
export const EDITOR_AGENT_REVIEW_TIMEOUT_MS = 30 * 60 * 1_000;
export const EDITOR_AGENT_MAX_QUEUED_PER_SESSION = 64;
export const EDITOR_AGENT_MAX_SESSIONS = 256;

export type EditorAgentSubscriber = (event: EditorAgentEvent) => void;

export interface EditorAgentRegistryOptions {
  // Milliseconds before an unacknowledged queued action is failed with TIMED_OUT.
  readonly actionTimeoutMs?: number | undefined;
  // Human diff review is intentionally much longer than immediate controller actions.
  readonly reviewTimeoutMs?: number | undefined;
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
  registerSnapshot(snapshot: EditorAgentSessionSnapshot, capabilityDigest?: string): boolean;
  refreshSnapshot(snapshot: EditorAgentSessionSnapshot, capabilityDigest: string): boolean;
  rotateSnapshotCapability(snapshot: EditorAgentSessionSnapshot, capabilityDigest: string): boolean;
  listSessions(): readonly EditorAgentSessionSnapshot[];
  snapshotFor(sessionId: string): EditorAgentSessionSnapshot | undefined;
  selectSnapshot(sessionId?: string): EditorAgentSessionSnapshot | undefined;
  hasLiveBridge(sessionId: string): boolean;
  liveBridgeCount(sessionId: string): number;
  matchesBridgeDecisionCapabilityDigest(sessionId: string, capabilityDigest: string): boolean;
  hasValidBridgeLease(sessionId: string, capabilityDigest: string): boolean;
  connect(sessionId: string | undefined, send: EditorAgentSubscriber): () => void;
  connectAuthenticated(
    sessionId: string,
    capabilityDigest: string,
    send: EditorAgentSubscriber,
  ): (() => void) | undefined;
  // Admits `action` to the bounded per-session queue (arming its timeout) and fans out `emitAction` —
  // the route passes the possibly patch-derived envelope to broadcast, keyed for lifecycle by the
  // original action's (sessionId, actionId). The caller MUST have already cleared preflight policy.
  // A second admit for an actionId already in flight for that session is rejected (no silent
  // supersede), so the first action's deadline is preserved.
  queueAction(
    action: EditorAgentAction,
    emitAction: EditorAgentAction,
    options?: { readonly runtimeOwned?: boolean | undefined },
  ): EditorAgentQueueOutcome;
  // Atomically removes and returns the exact original action for one pending session/action pair.
  // Result requests use this one-use claim before any server-side commit can run.
  takePendingAction(
    sessionId: string,
    actionId: string,
    capabilityDigest: string,
  ): EditorAgentAction | undefined;
  // Removes only runtime-originated actions for the exact server-owned authority run. This is used
  // during runtime revocation so a later browser review result cannot claim a stale mutation.
  cancelPendingByAuthorityRun(runId: string): number;
  isRuntimeOwnedAction(action: EditorAgentAction): boolean;
  // Fans out a result event after the route has authenticated and claimed any pending action.
  // Reporting alone never clears a queue slot.
  reportResult(result: EditorAgentActionResult): void;
  pendingCount(sessionId: string): number;
  reset(): void;
}

interface PendingAction {
  readonly action: EditorAgentAction;
  readonly timer: unknown;
  readonly runtimeOwned: boolean;
}

type EditorAgentEventPayload =
  | { readonly type: "session"; readonly snapshot: EditorAgentSessionSnapshot }
  | { readonly type: "action"; readonly action: EditorAgentAction }
  | { readonly type: "result"; readonly result: EditorAgentActionResult };

interface RegistryState {
  readonly sessions: Map<string, EditorAgentSessionSnapshot>;
  readonly capabilityDigests: Map<string, string>;
  readonly bridges: Map<string, Set<EditorAgentSubscriber>>;
  readonly observers: Set<EditorAgentSubscriber>;
  // sessionId -> actionId -> pending entry. Session-scoped so no cross-session interference is possible
  // and the per-session depth is exactly the inner map's size (no separate counter to drift).
  readonly pending: Map<string, Map<string, PendingAction>>;
  runtimeOwnedActions: WeakSet<EditorAgentAction>;
  readonly actionTimeoutMs: number;
  readonly reviewTimeoutMs: number;
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

function bodyFreeConflict(
  conflict: NonNullable<EditorAgentActionResult["conflict"]>,
): NonNullable<EditorAgentActionResult["conflict"]> {
  return {
    code: conflict.code,
    message: "Result detail is available only on the session-scoped bridge.",
    ...(conflict.file === undefined ? {} : { file: conflict.file }),
  };
}

function bodyFreeResult(result: EditorAgentActionResult): EditorAgentActionResult {
  return {
    schemaVersion: result.schemaVersion,
    actionId: result.actionId,
    sessionId: result.sessionId,
    status: result.status,
    ...(result.conflict === undefined ? {} : { conflict: bodyFreeConflict(result.conflict) }),
    ...(result.failure === undefined
      ? {}
      : {
          failure: {
            code: result.failure.code,
            message: "Result detail is available only on the session-scoped bridge.",
          },
        }),
    ...(result.files === undefined
      ? {}
      : {
          files: result.files.map((file) => ({
            file: file.file,
            status: file.status,
            ...(file.conflict === undefined ? {} : { conflict: bodyFreeConflict(file.conflict) }),
          })),
        }),
    // Server-resolved navigation/search data is returned only to the direct action caller; global
    // observers and bridge streams remain content-free by construction.
  };
}

function observerEvent(event: EditorAgentEvent): EditorAgentEvent | null {
  if (event.type === "result") return { ...event, result: bodyFreeResult(event.result) };
  return event.type === "heartbeat" ? event : null;
}

// Content-bearing session/action events reach only the matching bridge. Global observers retain a
// body-free result projection; a session-less heartbeat reaches every live bridge.
function deliver(state: RegistryState, event: EditorAgentEvent): void {
  const observable = observerEvent(event);
  if (observable !== null) {
    for (const send of state.observers) send(observable);
  }
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

function takePendingActionImpl(
  state: RegistryState,
  sessionId: string,
  actionId: string,
  capabilityDigest: string,
): EditorAgentAction | undefined {
  if (!hasValidBridgeLeaseImpl(state, sessionId, capabilityDigest)) return undefined;
  const action = state.pending.get(sessionId)?.get(actionId)?.action;
  if (action === undefined) return undefined;
  clearPending(state, sessionId, actionId);
  return action;
}

function cancelPendingByAuthorityRunImpl(state: RegistryState, runId: string): number {
  let cancelled = 0;
  for (const [sessionId, inner] of state.pending) {
    for (const [actionId, entry] of inner) {
      if (!isRuntimeActionForRun(entry, runId)) continue;
      state.clearTimer(entry.timer);
      inner.delete(actionId);
      cancelled += 1;
      emit(state, { type: "result", result: cancelledRuntimeResult(entry.action) });
    }
    if (inner.size === 0) state.pending.delete(sessionId);
  }
  return cancelled;
}

function isRuntimeActionForRun(entry: PendingAction, runId: string): boolean {
  return entry.runtimeOwned && entry.action.authorityRef?.runId === runId;
}

function cancelledRuntimeResult(action: EditorAgentAction): EditorAgentActionResult {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: action.actionId,
    sessionId: action.sessionId,
    status: "failed",
    message: "The runtime action was cancelled.",
  };
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

function connectAuthenticatedImpl(
  state: RegistryState,
  sessionId: string,
  capabilityDigest: string,
  send: EditorAgentSubscriber,
): (() => void) | undefined {
  if (!digestMatches(state.capabilityDigests.get(sessionId), capabilityDigest)) return undefined;
  return connectImpl(state, sessionId, send);
}

function hasPendingMutation(inner: ReadonlyMap<string, PendingAction> | undefined): boolean {
  if (inner === undefined) return false;
  return [...inner.values()].some((entry) => isMutatingEditorAgentAction(entry.action.type));
}

function actionTimeoutMs(state: RegistryState, action: EditorAgentAction): number {
  return action.type === "applyPatch" || action.type === "applyChangeset"
    ? state.reviewTimeoutMs
    : state.actionTimeoutMs;
}

function rejectedQueueOutcome(action: EditorAgentAction, message: string): EditorAgentQueueOutcome {
  return {
    kind: "rejected",
    result: {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: action.actionId,
      sessionId: action.sessionId,
      status: "failed",
      message,
    },
  };
}

function queueActionImpl(
  state: RegistryState,
  action: EditorAgentAction,
  emitAction: EditorAgentAction,
  options?: { readonly runtimeOwned?: boolean | undefined },
): EditorAgentQueueOutcome {
  const inner = state.pending.get(action.sessionId);
  const rejection = queueRejection(state, action, inner);
  if (rejection !== undefined) return rejection;
  const slots = inner ?? new Map<string, PendingAction>();
  if (inner === undefined) state.pending.set(action.sessionId, slots);
  const timer = state.setTimer(
    () => {
      onTimeout(state, action);
    },
    actionTimeoutMs(state, action),
  );
  slots.set(action.actionId, { action, timer, runtimeOwned: options?.runtimeOwned === true });
  if (options?.runtimeOwned === true) state.runtimeOwnedActions.add(action);
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

function queueRejection(
  state: RegistryState,
  action: EditorAgentAction,
  inner: ReadonlyMap<string, PendingAction> | undefined,
): EditorAgentQueueOutcome | undefined {
  if (inner?.get(action.actionId) !== undefined)
    return rejectedQueueOutcome(
      action,
      "An action with this id is already in flight for this session.",
    );
  if (isMutatingEditorAgentAction(action.type) && hasPendingMutation(inner))
    return rejectedQueueOutcome(
      action,
      "A mutating editor action is already awaiting a terminal result.",
    );
  if ((inner?.size ?? 0) < state.maxQueuedPerSession) return undefined;
  return {
    kind: "rejected",
    result: lifecycleFailure(
      action,
      "QUEUE_FULL",
      "The editor action queue for this session is full; retry once an action completes.",
    ),
  };
}

function reportResultImpl(state: RegistryState, result: EditorAgentActionResult): void {
  emit(state, { type: "result", result });
}

function digestMatches(stored: string | undefined, candidate: string): boolean {
  if (
    stored === undefined ||
    !/^[a-f0-9]{64}$/u.test(stored) ||
    !/^[a-f0-9]{64}$/u.test(candidate)
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(candidate, "hex"));
}

function hasValidBridgeLeaseImpl(
  state: RegistryState,
  sessionId: string,
  capabilityDigest: string,
): boolean {
  return (
    (state.bridges.get(sessionId)?.size ?? 0) > 0 &&
    digestMatches(state.capabilityDigests.get(sessionId), capabilityDigest)
  );
}

function registerSnapshotImpl(
  state: RegistryState,
  snapshot: EditorAgentSessionSnapshot,
  capabilityDigest: string | undefined,
): boolean {
  if (
    state.sessions.has(snapshot.sessionId) ||
    (capabilityDigest !== undefined && !/^[a-f0-9]{64}$/u.test(capabilityDigest))
  ) {
    return false;
  }
  state.sessions.set(snapshot.sessionId, snapshot);
  // Internal read-only consumers may seed snapshots without a bridge capability. Such sessions
  // cannot refresh, establish a valid decision lease, or claim pending actions.
  if (capabilityDigest !== undefined) {
    state.capabilityDigests.set(snapshot.sessionId, capabilityDigest);
  }
  if (state.sessions.size > state.maxSessions) {
    evictOldestIdleSession(state, snapshot.sessionId);
  }
  emit(state, { type: "session", snapshot });
  return true;
}

function refreshSnapshotImpl(
  state: RegistryState,
  snapshot: EditorAgentSessionSnapshot,
  capabilityDigest: string,
): boolean {
  if (!digestMatches(state.capabilityDigests.get(snapshot.sessionId), capabilityDigest))
    return false;
  state.sessions.set(snapshot.sessionId, snapshot);
  emit(state, { type: "session", snapshot });
  return true;
}

function rotateSnapshotCapabilityImpl(
  state: RegistryState,
  snapshot: EditorAgentSessionSnapshot,
  capabilityDigest: string,
): boolean {
  if (!state.sessions.has(snapshot.sessionId)) return false;
  if (!/^[a-f0-9]{64}$/u.test(capabilityDigest)) return false;
  if ((state.bridges.get(snapshot.sessionId)?.size ?? 0) > 0) return false;
  if ((state.pending.get(snapshot.sessionId)?.size ?? 0) > 0) return false;
  state.sessions.set(snapshot.sessionId, snapshot);
  state.capabilityDigests.set(snapshot.sessionId, capabilityDigest);
  emit(state, { type: "session", snapshot });
  return true;
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
    state.capabilityDigests.delete(sessionId);
    return;
  }
}

function resetImpl(state: RegistryState): void {
  for (const inner of state.pending.values()) {
    for (const entry of inner.values()) state.clearTimer(entry.timer);
  }
  state.sessions.clear();
  state.capabilityDigests.clear();
  state.bridges.clear();
  state.observers.clear();
  state.pending.clear();
  state.runtimeOwnedActions = new WeakSet<EditorAgentAction>();
  state.eventSeq = 0;
}

function createRegistryState(options: EditorAgentRegistryOptions): RegistryState {
  return {
    sessions: new Map(),
    capabilityDigests: new Map(),
    bridges: new Map(),
    observers: new Set(),
    pending: new Map(),
    runtimeOwnedActions: new WeakSet<EditorAgentAction>(),
    actionTimeoutMs: options.actionTimeoutMs ?? EDITOR_AGENT_ACTION_TIMEOUT_MS,
    reviewTimeoutMs: options.reviewTimeoutMs ?? EDITOR_AGENT_REVIEW_TIMEOUT_MS,
    maxQueuedPerSession: options.maxQueuedPerSession ?? EDITOR_AGENT_MAX_QUEUED_PER_SESSION,
    maxSessions: options.maxSessions ?? EDITOR_AGENT_MAX_SESSIONS,
    setTimer: options.setTimer ?? defaultSetTimer,
    clearTimer: options.clearTimer ?? defaultClearTimer,
    eventSeq: 0,
  };
}

export function createEditorAgentRegistry(
  options: EditorAgentRegistryOptions = {},
): EditorAgentRegistry {
  const state = createRegistryState(options);
  return {
    registerSnapshot: (snapshot, capabilityDigest): boolean =>
      registerSnapshotImpl(state, snapshot, capabilityDigest),
    refreshSnapshot: (snapshot, capabilityDigest): boolean =>
      refreshSnapshotImpl(state, snapshot, capabilityDigest),
    rotateSnapshotCapability: (snapshot, capabilityDigest): boolean =>
      rotateSnapshotCapabilityImpl(state, snapshot, capabilityDigest),
    listSessions: (): readonly EditorAgentSessionSnapshot[] => [...state.sessions.values()],
    snapshotFor: (sessionId): EditorAgentSessionSnapshot | undefined =>
      state.sessions.get(sessionId),
    selectSnapshot: (sessionId): EditorAgentSessionSnapshot | undefined =>
      sessionId === undefined ? [...state.sessions.values()][0] : state.sessions.get(sessionId),
    hasLiveBridge: (sessionId): boolean => (state.bridges.get(sessionId)?.size ?? 0) > 0,
    liveBridgeCount: (sessionId): number => state.bridges.get(sessionId)?.size ?? 0,
    matchesBridgeDecisionCapabilityDigest: (sessionId, capabilityDigest): boolean =>
      digestMatches(state.capabilityDigests.get(sessionId), capabilityDigest),
    hasValidBridgeLease: (sessionId, capabilityDigest): boolean =>
      hasValidBridgeLeaseImpl(state, sessionId, capabilityDigest),
    connect: (sessionId, send): (() => void) => connectImpl(state, sessionId, send),
    connectAuthenticated: (sessionId, capabilityDigest, send): (() => void) | undefined =>
      connectAuthenticatedImpl(state, sessionId, capabilityDigest, send),
    queueAction: (action, emitAction, options): EditorAgentQueueOutcome =>
      queueActionImpl(state, action, emitAction, options),
    takePendingAction: (sessionId, actionId, capabilityDigest): EditorAgentAction | undefined =>
      takePendingActionImpl(state, sessionId, actionId, capabilityDigest),
    cancelPendingByAuthorityRun: (runId): number => cancelPendingByAuthorityRunImpl(state, runId),
    isRuntimeOwnedAction: (action): boolean => state.runtimeOwnedActions.has(action),
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
