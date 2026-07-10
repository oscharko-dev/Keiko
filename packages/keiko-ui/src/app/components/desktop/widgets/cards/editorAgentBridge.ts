"use client";

/**
 * Browser-side editor-agent bridge (Issue #1393, ADR-0061).
 *
 * Splits the per-pane agent wiring into a pure, React-free action dispatcher
 * ({@link dispatchEditorAgentAction}) and a thin React hook ({@link useEditorAgentBridge}) that
 * owns the session id, the snapshot-register effect, the SSE connection, and result posting.
 *
 * The pure dispatcher maps a validated {@link EditorAgentAction} to a controller call and returns a
 * synchronous {@link EditorAgentActionDescriptor} — or a Promise of one (`save`) — without touching
 * React or the DOM, so the full action protocol is unit-testable in isolation. The write actions
 * (`applyTextEdits`/`applyPatch`/`applyChangeset`) need React setters, so they return a `"deferred"`
 * marker and self-report from inside their component callbacks via the shared result-posting helper.
 *
 * The three layout-controller actions (`moveTab`, `splitPane`, `setSelection`) are completed here:
 * `moveTab`/`splitPane` delegate to the layout controllers injected by `EditorWidget`; `setSelection`
 * sets a one-shot `revealRequest` payload the host merges into the editor surface.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { postEditorAgentActionResult, queueEditorAgentBridgeAction } from "../../../../../lib/api";
import { createSameOriginApiEventSource } from "../../../../../lib/safe-event-source";
import type {
  EditorAgentAction,
  EditorAgentActionQueuedResponse,
  EditorAgentEvent,
  EditorAgentActionResult,
  EditorAgentActionResultRequest,
  EditorAgentSnapshotResponse,
  EditorAgentConflictCode,
} from "../../../../../lib/types";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  isContainedAgentPath,
  isEditorAgentActiveBufferActionType,
  isEditorAgentBridgeDecisionCapability,
  isEditorAgentEvent,
  isEditorAgentWriteActionType,
} from "../../../../../lib/types";

/**
 * GEN-PERF-EDITOR-002 — trailing debounce (ms) for the agent-session snapshot POST. Long
 * enough to collapse a cursor/selection burst into one POST, short enough that the agent
 * sees the settled state promptly.
 */
export const EDITOR_SNAPSHOT_DEBOUNCE_MS = 300;

/**
 * Issue #2120 (ADR-0058 through ADR-0062) — action/result traffic is considered recent for one
 * minute. This deliberately measures observed agent activity, not the browser's own SSE liveness.
 */
export const EDITOR_AGENT_ACTIVITY_RECENCY_MS = 60_000;

/**
 * Maximum content-free action identifiers retained by one mounted bridge hook. A newly observed
 * action evicts the oldest retained identifier when this FIFO bound is full.
 */
export const MAX_EDITOR_AGENT_IN_FLIGHT_ACTIONS = 64;

/** A content-free agent selection-reveal request the host merges into the editor surface. */
export interface EditorAgentSelectionRequest {
  readonly actionId: string;
  readonly selection: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

/**
 * The execution dependencies the pure dispatcher needs, grouped so {@link dispatchEditorAgentAction}
 * takes a single argument. Every dependency is a plain function or value — no React types leak in.
 */
export interface EditorAgentActionControllers {
  /** The pane this bridge serves; used as the default pane target for layout actions. */
  readonly paneId: string | undefined;
  /** The snapshot/browser target against which active-buffer actions are checked. */
  readonly activePaneId: string | undefined;
  readonly activeFile: string | undefined;
  /** Runtime-owned repeat check immediately before a controller mutation. */
  readonly verifyActiveTarget: (action: EditorAgentAction) => boolean;
  /** Runtime-owned optimistic-concurrency check immediately before a write action. */
  readonly verifyWritePrecondition: (action: EditorAgentAction) => boolean;
  /** Open/focus a file tab in this pane. */
  readonly onSelectOpenFile: ((file: string) => void) | undefined;
  /** Whether the host's deterministic formatter is available for the active language. */
  readonly formattingEnabled: boolean;
  /** Bump the host's format-request nonce to trigger a Monaco format pass. */
  readonly formatRequest: { readonly increment: () => void };
  /** Persist the current buffer; resolves true on success. */
  readonly persist: (text: string) => Promise<boolean>;
  /** The current buffer text (read from a ref so it is always live). */
  readonly currentText: () => string;
  /** Apply agent text edits in place; self-reports via the shared helper. */
  readonly applyTextEdits: (action: EditorAgentAction) => void;
  /** Stage an agent patch for explicit review; self-reports via the shared helper. */
  readonly applyPatch: (action: EditorAgentAction) => void;
  /** Stage a prepared multi-file changeset for review; self-reports via the shared helper. */
  readonly applyChangeset?: ((action: EditorAgentAction) => void) | undefined;
  /** Split the given pane; injected by EditorWidget. Undefined when rendered standalone. */
  readonly onSplitPane: ((paneId: string, direction: "row" | "column") => void) | undefined;
  /** Move a file tab across panes; injected by EditorWidget. Undefined when rendered standalone. */
  readonly onMoveTab: ((fromPaneId: string, file: string, toPaneId: string) => void) | undefined;
  /** Request a selection reveal on the editor surface (one-shot, host-consumed). */
  readonly onRequestSelectionReveal: ((request: EditorAgentSelectionRequest) => void) | undefined;
}

/** The result of executing a single agent action. */
export type EditorAgentActionDescriptor =
  | {
      readonly status: "succeeded" | "failed" | "conflict";
      readonly message?: string;
      readonly conflictCode?: EditorAgentConflictCode;
    }
  | { readonly status: "deferred" }
  | { readonly status: "async"; readonly promise: Promise<EditorAgentActionDescriptor> };

const DEFERRED: EditorAgentActionDescriptor = { status: "deferred" };
const MAX_BROWSER_BRIDGE_CAPABILITIES = 256;
interface BrowserBridgeCapability {
  readonly value: string;
  readonly generation: number;
}

const editorAgentDecisionCapabilities = new Map<string, BrowserBridgeCapability>();
const editorAgentSnapshotRegistrations = new Map<string, Promise<boolean>>();
const editorAgentReadySessions = new Set<string>();
let editorAgentCapabilityGeneration = 0;

function evictIdleBridgeCapability(): boolean {
  for (const sessionId of editorAgentDecisionCapabilities.keys()) {
    if (editorAgentSubscribersBySession.has(sessionId)) continue;
    editorAgentDecisionCapabilities.delete(sessionId);
    return true;
  }
  return false;
}

function rememberBridgeCapability(sessionId: string, capability: string): boolean {
  const current = editorAgentDecisionCapabilities.get(sessionId);
  if (current?.value === capability) return true;
  if (
    current === undefined &&
    editorAgentDecisionCapabilities.size >= MAX_BROWSER_BRIDGE_CAPABILITIES &&
    !evictIdleBridgeCapability()
  ) {
    return false;
  }
  editorAgentCapabilityGeneration += 1;
  editorAgentDecisionCapabilities.set(sessionId, {
    value: capability,
    generation: editorAgentCapabilityGeneration,
  });
  return true;
}

/** Queue an explicit local UI action without exposing the bridge capability to its caller. */
export function queueLocalEditorAgentAction(
  action: EditorAgentAction,
): Promise<EditorAgentActionQueuedResponse> {
  const capability = editorAgentDecisionCapabilities.get(action.sessionId)?.value;
  if (capability === undefined) {
    return Promise.reject(new Error("The browser bridge decision capability is unavailable."));
  }
  return queueEditorAgentBridgeAction(action, capability);
}

function normalizeActiveTarget(path: string): string {
  return path
    .replace(/\\/gu, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

function activeTargetConflict(
  action: EditorAgentAction,
  controllers: EditorAgentActionControllers,
): EditorAgentActionDescriptor | null {
  if (!isEditorAgentActiveBufferActionType(action.type)) return null;
  const claimedFile = action.target?.file;
  const claimedPane = action.target?.paneId;
  const fileMismatch =
    claimedFile === undefined ||
    controllers.activeFile === undefined ||
    normalizeActiveTarget(claimedFile) !== normalizeActiveTarget(controllers.activeFile);
  const paneMismatch =
    claimedPane === undefined ||
    controllers.activePaneId === undefined ||
    claimedPane !== controllers.activePaneId;
  if (!fileMismatch && !paneMismatch && controllers.verifyActiveTarget(action)) return null;
  return {
    status: "conflict",
    conflictCode: "OUT_OF_SCOPE",
    message: "Action target does not match the active editor buffer.",
  };
}

function writePreconditionConflict(
  action: EditorAgentAction,
  controllers: EditorAgentActionControllers,
): EditorAgentActionDescriptor | null {
  if (!isEditorAgentWriteActionType(action.type) || controllers.verifyWritePrecondition(action)) {
    return null;
  }
  return {
    status: "conflict",
    conflictCode: "VERSION_MISMATCH",
    message: "The active editor buffer changed after action admission.",
  };
}

function dispatchOpenOrFocus(
  action: EditorAgentAction,
  controllers: EditorAgentActionControllers,
): EditorAgentActionDescriptor {
  const file = action.target?.file;
  if (file === undefined) return { status: "failed", message: "Missing target file." };
  controllers.onSelectOpenFile?.(file);
  return { status: "succeeded" };
}

function dispatchFormat(controllers: EditorAgentActionControllers): EditorAgentActionDescriptor {
  if (!controllers.formattingEnabled) {
    return { status: "failed", message: "Formatting is unavailable for this language." };
  }
  controllers.formatRequest.increment();
  return { status: "succeeded" };
}

function dispatchSave(controllers: EditorAgentActionControllers): EditorAgentActionDescriptor {
  const promise = controllers
    .persist(controllers.currentText())
    .then((ok): EditorAgentActionDescriptor =>
      ok ? { status: "succeeded" } : { status: "failed", message: "Save failed." },
    );
  return { status: "async", promise };
}

function dispatchSplitPane(
  action: EditorAgentAction,
  controllers: EditorAgentActionControllers,
): EditorAgentActionDescriptor {
  if (controllers.onSplitPane === undefined) {
    return { status: "failed", message: "Provider unavailable." };
  }
  const direction = action.target?.splitDirection ?? "row";
  const targetPaneId = action.target?.paneId ?? controllers.paneId;
  if (targetPaneId === undefined) return { status: "failed", message: "Missing target pane." };
  controllers.onSplitPane(targetPaneId, direction);
  return { status: "succeeded" };
}

function dispatchMoveTab(
  action: EditorAgentAction,
  controllers: EditorAgentActionControllers,
): EditorAgentActionDescriptor {
  const file = action.target?.file;
  if (file === undefined) return { status: "failed", message: "Missing target file." };
  if (!isContainedAgentPath(file)) {
    return {
      status: "conflict",
      conflictCode: "OUT_OF_SCOPE",
      message: "File target is outside the workspace root.",
    };
  }
  if (controllers.onMoveTab === undefined) {
    return { status: "failed", message: "Provider unavailable." };
  }
  const fromPaneId = action.target?.paneId ?? controllers.paneId;
  const toPaneId = action.target?.toPaneId;
  if (fromPaneId === undefined || toPaneId === undefined) {
    return { status: "failed", message: "Missing pane target." };
  }
  controllers.onMoveTab(fromPaneId, file, toPaneId);
  return { status: "succeeded" };
}

function dispatchSetSelection(
  action: EditorAgentAction,
  controllers: EditorAgentActionControllers,
): EditorAgentActionDescriptor {
  const selection = action.target?.selection;
  if (selection === undefined) {
    return { status: "failed", message: "Missing selection target." };
  }
  if (controllers.onRequestSelectionReveal === undefined) {
    return { status: "failed", message: "Provider unavailable." };
  }
  controllers.onRequestSelectionReveal({ actionId: action.actionId, selection });
  return { status: "succeeded" };
}

/**
 * Pure, React-free dispatcher: map a validated agent action to a controller call and return a
 * descriptor. Write-review actions return `"deferred"` (they self-report inside the
 * component); `save` returns `"async"` with a Promise of the final descriptor.
 */
export function dispatchEditorAgentAction(
  action: EditorAgentAction,
  controllers: EditorAgentActionControllers,
): EditorAgentActionDescriptor {
  const targetConflict = activeTargetConflict(action, controllers);
  if (targetConflict !== null) return targetConflict;
  const preconditionConflict = writePreconditionConflict(action, controllers);
  if (preconditionConflict !== null) return preconditionConflict;
  switch (action.type) {
    case "openFile":
    case "focusTab":
      return dispatchOpenOrFocus(action, controllers);
    case "format":
      return dispatchFormat(controllers);
    case "save":
      return dispatchSave(controllers);
    case "applyTextEdits":
      controllers.applyTextEdits(action);
      return DEFERRED;
    case "applyPatch":
      controllers.applyPatch(action);
      return DEFERRED;
    case "applyChangeset":
      if (controllers.applyChangeset === undefined) {
        return { status: "failed", message: "Provider unavailable." };
      }
      controllers.applyChangeset(action);
      return DEFERRED;
    case "splitPane":
      return dispatchSplitPane(action, controllers);
    case "moveTab":
      return dispatchMoveTab(action, controllers);
    case "setSelection":
      return dispatchSetSelection(action, controllers);
  }
}

/**
 * Build an {@link EditorAgentActionResultRequest} and post it best-effort. Shared by the hook (for
 * synchronously resolved descriptors) and the component's applyText/applyPatch callbacks, so the
 * result envelope is built in exactly one place.
 */
export function postEditorAgentResult(
  action: EditorAgentAction,
  status: "succeeded" | "failed" | "conflict",
  message?: string,
  conflictCode?: EditorAgentConflictCode,
): void {
  const conflict: EditorAgentActionResult["conflict"] =
    conflictCode !== undefined ? { code: conflictCode, message: message ?? "" } : undefined;
  const body: EditorAgentActionResultRequest = {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    kind: "result",
    result: {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: action.actionId,
      sessionId: action.sessionId,
      status,
      ...(message === undefined ? {} : { message }),
      ...(conflict === undefined ? {} : { conflict }),
    },
  };
  void postEditorAgentResultRequest(action, body).catch(() => {
    // Best-effort action reporting; the local UI action already happened or was rejected.
  });
}

export function postEditorAgentResultRequest(
  action: EditorAgentAction,
  request: EditorAgentActionResultRequest,
): Promise<EditorAgentActionQueuedResponse> {
  const capability = editorAgentDecisionCapabilities.get(action.sessionId)?.value;
  if (capability === undefined) {
    return Promise.reject(new Error("The browser bridge decision capability is unavailable."));
  }
  return postEditorAgentActionResult({ ...request, bridgeDecisionCapability: capability });
}

function reportDescriptor(
  action: EditorAgentAction,
  descriptor: EditorAgentActionDescriptor,
): void {
  if (descriptor.status === "deferred") return;
  if (descriptor.status === "async") {
    void descriptor.promise.then((resolved) => reportDescriptor(action, resolved));
    return;
  }
  postEditorAgentResult(action, descriptor.status, descriptor.message, descriptor.conflictCode);
}

export interface UseEditorAgentBridgeParams {
  readonly agentSessionId: string;
  readonly controllers: EditorAgentActionControllers;
  readonly enabled?: boolean | undefined;
  /**
   * Posts the current pane snapshot to the BFF. The host wraps this in `useCallback` with its full
   * snapshot dependency list, so its identity changes exactly when a snapshot dimension changes and
   * the hook re-fires the register effect.
   */
  readonly registerSnapshot: (
    capability: string | undefined,
  ) => Promise<EditorAgentSnapshotResponse | void> | EditorAgentSnapshotResponse | void;
  readonly onConflict: (conflict: {
    readonly code: EditorAgentConflictCode;
    readonly message: string;
  }) => void;
  /**
   * Issue #1395 — fired whenever the bridge observes agent activity for this session (an action
   * dispatch or a result). The recent-actions audit panel uses it to re-fetch the bounded audit feed
   * so the governance surface stays live without widening the frozen `EditorAgentEvent` union.
   */
  readonly onAgentActivity?: (() => void) | undefined;
  /** Receives validated terminal SSE results for this exact session without retaining a history. */
  readonly onTerminalResult?: ((result: EditorAgentActionResult) => void) | undefined;
}

export interface UseEditorAgentBridgeResult {
  readonly agentSelectionRequest: EditorAgentSelectionRequest | null;
  readonly consumeSelectionRequest: () => void;
  readonly bridgeState: EditorAgentBridgeState;
}

/** Bounded, content-free state derived only from action/result frames already observed by the hook. */
export interface EditorAgentBridgeState {
  /** Epoch milliseconds for the most recently observed valid action or result frame. */
  readonly lastActivityAt: number | null;
  /** True only during the finite recency window following the latest observed frame. */
  readonly recentlyAttached: boolean;
  /** Bounded action metadata retained until a matching terminal result or lifecycle reset. */
  readonly inFlightActionIds: readonly string[];
  readonly inFlightActionCount: number;
}

interface EditorAgentSessionHandlers {
  readonly onAction: (action: EditorAgentAction) => void;
  readonly onResult: (result: EditorAgentActionResult) => void;
}

const EMPTY_EDITOR_AGENT_BRIDGE_STATE: EditorAgentBridgeState = {
  lastActivityAt: null,
  recentlyAttached: false,
  inFlightActionIds: [],
  inFlightActionCount: 0,
};

function recentBridgeState(
  lastActivityAt: number,
  inFlightActionIds: readonly string[],
): EditorAgentBridgeState {
  return {
    lastActivityAt,
    recentlyAttached: true,
    inFlightActionIds,
    inFlightActionCount: inFlightActionIds.length,
  };
}

function retainInFlightAction(current: readonly string[], actionId: string): readonly string[] {
  if (current.includes(actionId)) return current;
  const firstRetainedIndex = Math.max(0, current.length - MAX_EDITOR_AGENT_IN_FLIGHT_ACTIONS + 1);
  return [...current.slice(firstRetainedIndex), actionId];
}

function stateAfterActionFrame(
  current: EditorAgentBridgeState,
  actionId: string,
  observedAt: number,
): EditorAgentBridgeState {
  return recentBridgeState(observedAt, retainInFlightAction(current.inFlightActionIds, actionId));
}

function stateAfterResultFrame(
  current: EditorAgentBridgeState,
  result: EditorAgentActionResult,
  observedAt: number,
): EditorAgentBridgeState {
  const inFlightActionIds =
    result.status === "queued"
      ? current.inFlightActionIds
      : current.inFlightActionIds.filter((actionId) => actionId !== result.actionId);
  return recentBridgeState(observedAt, inFlightActionIds);
}

function inactiveBridgeState(current: EditorAgentBridgeState): EditorAgentBridgeState {
  return current.recentlyAttached ? { ...current, recentlyAttached: false } : current;
}

interface EditorAgentBridgeStateObserver {
  readonly bridgeState: EditorAgentBridgeState;
  readonly observeAction: (actionId: string) => void;
  readonly observeResult: (result: EditorAgentActionResult) => void;
}

function useEditorAgentBridgeState(
  agentSessionId: string,
  enabled: boolean,
): EditorAgentBridgeStateObserver {
  const [bridgeState, setBridgeState] = useState(EMPTY_EDITOR_AGENT_BRIDGE_STATE);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearInactivityTimer = useCallback((): void => {
    if (inactivityTimerRef.current === null) return;
    clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = null;
  }, []);
  const restartInactivityTimer = useCallback((): void => {
    clearInactivityTimer();
    inactivityTimerRef.current = setTimeout(() => {
      inactivityTimerRef.current = null;
      setBridgeState(inactiveBridgeState);
    }, EDITOR_AGENT_ACTIVITY_RECENCY_MS);
  }, [clearInactivityTimer]);
  const observeAction = useCallback(
    (actionId: string): void => {
      const observedAt = Date.now();
      setBridgeState((current) => stateAfterActionFrame(current, actionId, observedAt));
      restartInactivityTimer();
    },
    [restartInactivityTimer],
  );
  const observeResult = useCallback(
    (result: EditorAgentActionResult): void => {
      const observedAt = Date.now();
      setBridgeState((current) => stateAfterResultFrame(current, result, observedAt));
      restartInactivityTimer();
    },
    [restartInactivityTimer],
  );
  useEffect(() => {
    clearInactivityTimer();
    setBridgeState(EMPTY_EDITOR_AGENT_BRIDGE_STATE);
    return clearInactivityTimer;
  }, [agentSessionId, clearInactivityTimer, enabled]);
  return { bridgeState, observeAction, observeResult };
}

async function performBridgeSnapshotRegistration(
  sessionId: string,
  registerSnapshot: UseEditorAgentBridgeParams["registerSnapshot"],
): Promise<boolean> {
  try {
    const current = editorAgentDecisionCapabilities.get(sessionId)?.value;
    const response = await registerSnapshot(current);
    const issued = response?.bridgeDecisionCapability;
    if (issued === undefined) return editorAgentDecisionCapabilities.has(sessionId);
    return isEditorAgentBridgeDecisionCapability(issued)
      ? rememberBridgeCapability(sessionId, issued)
      : false;
  } catch {
    // Registration is availability-only; mutation remains server-gated without a valid lease.
    return false;
  }
}

function registerBridgeSnapshot(
  sessionId: string,
  registerSnapshot: UseEditorAgentBridgeParams["registerSnapshot"],
): Promise<boolean> {
  const prior = editorAgentSnapshotRegistrations.get(sessionId);
  if (
    prior === undefined &&
    editorAgentSnapshotRegistrations.size >= MAX_BROWSER_BRIDGE_CAPABILITIES &&
    !editorAgentDecisionCapabilities.has(sessionId)
  ) {
    return Promise.resolve(false);
  }
  const pending = (prior ?? Promise.resolve(true))
    .then(() => performBridgeSnapshotRegistration(sessionId, registerSnapshot))
    .then((ready) => {
      if (ready && editorAgentSubscribersBySession.has(sessionId)) {
        editorAgentReadySessions.add(sessionId);
        scheduleEditorAgentReconcile();
      }
      return ready;
    });
  editorAgentSnapshotRegistrations.set(sessionId, pending);
  void pending.then(() => {
    if (editorAgentSnapshotRegistrations.get(sessionId) === pending) {
      editorAgentSnapshotRegistrations.delete(sessionId);
    }
  });
  return pending;
}

const editorAgentSubscribersBySession = new Map<string, Set<EditorAgentSessionHandlers>>();
let editorAgentEventSource: EventSource | null = null;
let editorAgentActionListener: EventListener | null = null;
let editorAgentResultListener: EventListener | null = null;
// GEN-PERF-EDITOR-008 — the effective session-id SET (not membership churn) is what the
// EventSource URL encodes. Remember the last connected set so subscribe/unsubscribe events
// that do not change the set (duplicate handlers, extra panes on the same session) do not
// tear down and re-open the stream. `null` means "no stream is currently open".
let editorAgentConnectedSessionKey: string | null = null;
let editorAgentRestartScheduled = false;

interface ReadySubscribedSession {
  readonly sessionId: string;
  readonly capability: BrowserBridgeCapability;
}

function readySubscribedSessions(): readonly ReadySubscribedSession[] {
  const ready: ReadySubscribedSession[] = [];
  for (const sessionId of [...editorAgentSubscribersBySession.keys()].sort()) {
    const capability = editorAgentDecisionCapabilities.get(sessionId);
    if (!editorAgentReadySessions.has(sessionId) || capability === undefined) continue;
    ready.push({ sessionId, capability });
  }
  return ready;
}

function currentSessionKey(sessions: readonly ReadySubscribedSession[]): string {
  return sessions
    .map(({ sessionId, capability }) => `${sessionId}:${String(capability.generation)}`)
    .join("\u0000");
}

function editorAgentEventUrl(sessions: readonly ReadySubscribedSession[]): string | null {
  const params = new URLSearchParams();
  for (const { sessionId, capability } of sessions) {
    params.append("sessionId", sessionId);
    params.append("bridgeDecisionCapability", capability.value);
  }
  const query = params.toString();
  return query.length > 0 ? `/api/editor/agent/events?${query}` : null;
}

function eventSessionId(event: EditorAgentEvent): string | undefined {
  switch (event.type) {
    case "action":
      return event.action.sessionId;
    case "result":
      return event.result.sessionId;
    case "session":
      return event.snapshot.sessionId;
    case "heartbeat":
      return undefined;
  }
}

function dispatchEditorAgentEvent(event: EditorAgentEvent): void {
  const sessionId = eventSessionId(event);
  if (sessionId === undefined) return;
  const subscribers = editorAgentSubscribersBySession.get(sessionId);
  if (subscribers === undefined) return;
  for (const subscriber of subscribers) {
    if (event.type === "action") {
      subscriber.onAction(event.action);
    } else if (event.type === "result") {
      subscriber.onResult(event.result);
    }
  }
}

function handleEditorAgentFrame(event: Event): void {
  try {
    const parsed: unknown = JSON.parse((event as MessageEvent<string>).data);
    if (!isEditorAgentEvent(parsed)) return;
    dispatchEditorAgentEvent(parsed);
  } catch {
    // Ignore malformed SSE frames; the server owns validation before enqueueing.
  }
}

function closeEditorAgentEventSource(): void {
  if (editorAgentEventSource === null) return;
  if (editorAgentActionListener !== null) {
    editorAgentEventSource.removeEventListener("editor-agent:action", editorAgentActionListener);
  }
  if (editorAgentResultListener !== null) {
    editorAgentEventSource.removeEventListener("editor-agent:result", editorAgentResultListener);
  }
  editorAgentEventSource.close();
  editorAgentEventSource = null;
  editorAgentActionListener = null;
  editorAgentResultListener = null;
  editorAgentConnectedSessionKey = null;
}

/**
 * Reconcile the live EventSource with the current subscriber set. Behavior-preserving but
 * idempotent: when the effective session-id set is unchanged from the last connection it
 * returns without touching the stream (GEN-PERF-EDITOR-008), so duplicate-handler churn and
 * extra panes on an already-subscribed session no longer force a reconnect.
 */
function reconcileEditorAgentEventSource(): void {
  const readySessions = readySubscribedSessions();
  const nextKey = currentSessionKey(readySessions);
  if (readySessions.length === 0) {
    // No authenticated subscriber is ready — tear the stream down.
    closeEditorAgentEventSource();
    return;
  }
  if (editorAgentEventSource !== null && editorAgentConnectedSessionKey === nextKey) {
    // The connected set already matches; nothing to do.
    return;
  }
  closeEditorAgentEventSource();
  if (typeof EventSource === "undefined") return;
  const url = editorAgentEventUrl(readySessions);
  if (url === null) return;
  const source = createSameOriginApiEventSource(url);
  if (source === null) return;
  editorAgentActionListener = handleEditorAgentFrame;
  editorAgentResultListener = handleEditorAgentFrame;
  source.addEventListener("editor-agent:action", editorAgentActionListener);
  source.addEventListener("editor-agent:result", editorAgentResultListener);
  editorAgentEventSource = source;
  editorAgentConnectedSessionKey = nextKey;
}

/**
 * Debounce reconciliation to a microtask so a burst of N pane mounts/unmounts in one tick
 * collapses into a single stream (re)connect instead of N restarts (GEN-PERF-EDITOR-008).
 */
function scheduleEditorAgentReconcile(): void {
  if (editorAgentRestartScheduled) return;
  editorAgentRestartScheduled = true;
  const flush = (): void => {
    editorAgentRestartScheduled = false;
    reconcileEditorAgentEventSource();
  };
  if (typeof queueMicrotask === "function") {
    queueMicrotask(flush);
  } else {
    setTimeout(flush, 0);
  }
}

function subscribeEditorAgentSession(
  sessionId: string,
  handlers: EditorAgentSessionHandlers,
): () => void {
  const existing = editorAgentSubscribersBySession.get(sessionId) ?? new Set();
  existing.add(handlers);
  editorAgentSubscribersBySession.set(sessionId, existing);
  scheduleEditorAgentReconcile();
  return (): void => {
    const subscribers = editorAgentSubscribersBySession.get(sessionId);
    if (subscribers === undefined) return;
    subscribers.delete(handlers);
    if (subscribers.size === 0) {
      editorAgentSubscribersBySession.delete(sessionId);
      editorAgentReadySessions.delete(sessionId);
    }
    if (editorAgentSubscribersBySession.size === 0) {
      // Last subscriber left — tear the stream down synchronously so unmount closes the
      // connection deterministically (no deferred socket lingering after the pane is gone).
      closeEditorAgentEventSource();
      return;
    }
    // The set only shrank (a pane left but others remain) — reconcile on a microtask so a
    // burst of unsubscribes collapses; a no-op set change won't restart the stream.
    scheduleEditorAgentReconcile();
  };
}

/** Test-only reset for module-scoped capability and EventSource state. */
export function _resetEditorAgentBridgeStateForTests(): void {
  closeEditorAgentEventSource();
  editorAgentSubscribersBySession.clear();
  editorAgentDecisionCapabilities.clear();
  editorAgentSnapshotRegistrations.clear();
  editorAgentReadySessions.clear();
  editorAgentCapabilityGeneration = 0;
  editorAgentRestartScheduled = false;
}

/**
 * The single exported React artifact of the bridge: owns the snapshot-register effect, the SSE
 * connection (action + result listeners, both validated with `isEditorAgentEvent`), result posting,
 * conflict surfacing, and the one-shot `setSelection` reveal state.
 */
export function useEditorAgentBridge(
  params: UseEditorAgentBridgeParams,
): UseEditorAgentBridgeResult {
  const {
    agentSessionId,
    controllers,
    enabled = true,
    registerSnapshot,
    onConflict,
    onAgentActivity,
    onTerminalResult,
  } = params;
  const [agentSelectionRequest, setAgentSelectionRequest] =
    useState<EditorAgentSelectionRequest | null>(null);
  const { bridgeState, observeAction, observeResult } = useEditorAgentBridgeState(
    agentSessionId,
    enabled,
  );

  // Refs keep the SSE effect stable across re-renders so the live onConflictRef and
  // dispatchControllersRef are used without tearing down and re-opening the EventSource on every keystroke.
  const onConflictRef = useRef(onConflict);
  onConflictRef.current = onConflict;
  const onAgentActivityRef = useRef(onAgentActivity);
  onAgentActivityRef.current = onAgentActivity;
  const onTerminalResultRef = useRef(onTerminalResult);
  onTerminalResultRef.current = onTerminalResult;

  const requestSelectionReveal = useCallback((request: EditorAgentSelectionRequest): void => {
    setAgentSelectionRequest(request);
  }, []);

  const consumeSelectionRequest = useCallback((): void => {
    setAgentSelectionRequest(null);
  }, []);

  // The `setSelection` controller is owned by the hook (it drives hook state); merge it onto the
  // host-provided controllers so the dispatcher sees a complete set.
  const dispatchControllers = useMemo<EditorAgentActionControllers>(
    () => ({ ...controllers, onRequestSelectionReveal: requestSelectionReveal }),
    [controllers, requestSelectionReveal],
  );
  const dispatchControllersRef = useRef(dispatchControllers);
  dispatchControllersRef.current = dispatchControllers;

  // GEN-PERF-EDITOR-002 — the host wraps registerSnapshot in a useCallback whose deps
  // include cursor/selection, so its identity churns on every cursor/selection delta
  // (tens/sec during drag-select or key-repeat). Post the snapshot on a trailing debounce
  // so a burst collapses into a single POST while the settled state is still delivered.
  const registerSnapshotRef = useRef(registerSnapshot);
  registerSnapshotRef.current = registerSnapshot;
  useEffect(() => {
    if (!enabled) return;
    // `registerSnapshot` is a dependency so a new snapshot dimension re-arms the timer;
    // the ref indirection means we always invoke the latest closure on the trailing edge.
    const handle = setTimeout(() => {
      void registerBridgeSnapshot(agentSessionId, registerSnapshotRef.current);
    }, EDITOR_SNAPSHOT_DEBOUNCE_MS);
    return (): void => {
      clearTimeout(handle);
    };
  }, [agentSessionId, enabled, registerSnapshot]);

  useEffect(() => {
    if (!enabled) return;
    const handlers: EditorAgentSessionHandlers = {
      onAction: (action): void => {
        observeAction(action.actionId);
        const descriptor = dispatchEditorAgentAction(action, dispatchControllersRef.current);
        reportDescriptor(action, descriptor);
        // Issue #1395 — an action for this session was dispatched; refresh the audit panel.
        onAgentActivityRef.current?.();
      },
      onResult: (result): void => {
        observeResult(result);
        // Issue #1395 — any result for this session is audit-relevant; refresh the audit panel.
        onAgentActivityRef.current?.();
        if (result.status !== "queued") onTerminalResultRef.current?.(result);
        if (result.status !== "conflict") return;
        const { conflict } = result;
        if (conflict === undefined) return;
        onConflictRef.current({ code: conflict.code, message: conflict.message });
      },
    };
    const unsubscribe = subscribeEditorAgentSession(agentSessionId, handlers);
    void registerBridgeSnapshot(agentSessionId, registerSnapshotRef.current);
    return unsubscribe;
  }, [agentSessionId, enabled, observeAction, observeResult]);

  return { agentSelectionRequest, consumeSelectionRequest, bridgeState };
}
