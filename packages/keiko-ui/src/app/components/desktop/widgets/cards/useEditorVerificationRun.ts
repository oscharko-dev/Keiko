"use client";

// Issue #2212 (Epic #2092, ADR-0126) — the editor's run-affordance state machine. Starts and cancels
// verification runs through Issue #2211's GOVERNED route (`/api/editor/verification/*`) and reflects
// their content-free lifecycle over a SINGLE, SHARED, ref-counted same-origin SSE stream (mirroring
// the shared EventSource pattern the epic's Architecture Invariants require). It never executes
// anything itself; every run goes through the sandboxed spawn boundary on the server.
//
// The shared stream is opened LAZILY — only while any project has a run active — and closed once no
// project does, so an idle editor holds no verification connection. Run STATE is scoped per project
// root (Epic #2092 fix-up): the desktop shell supports multiple simultaneously mounted editor windows
// bound to different project roots (see WindowsRegistry/resolveBoundRoot), so a run started in one
// project's window must not appear in another project's status bar. The one physical EventSource
// connection stays shared and ref-counted across all projects (per the epic's shared-EventSource
// invariant); only the STATE it feeds is partitioned.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  EDITOR_VERIFICATION_EVENT_KINDS,
  isEditorVerificationCatalog,
  isEditorVerificationEvent,
  isEditorVerificationRun,
  type EditorVerificationCatalog,
  type EditorVerificationEvent,
  type VerificationKind,
} from "@oscharko-dev/keiko-contracts";
import { createSameOriginApiEventSource } from "../../../../../lib/safe-event-source";
import { resolveVerificationTarget } from "./editorCommands";
import { setVerificationReport } from "./editorProblemsStore";

const RUNS_URL = "/api/editor/verification/runs";
const EVENTS_URL = "/api/editor/verification/events";
const CATALOG_URL = "/api/editor/verification/catalog";
const TRUST_URL = "/api/editor/verification/trust";
const MUTATION_HEADERS = {
  "content-type": "application/json",
  "X-Keiko-CSRF": "1",
} as const;

export interface EditorVerificationStatusRun {
  readonly label: string;
  readonly busy: boolean;
}

export interface EditorVerificationRunControls {
  readonly verificationRunning: boolean;
  readonly verifiableTarget: string | null;
  readonly statusBarRun: EditorVerificationStatusRun | null;
  readonly catalog: EditorVerificationCatalog | null;
  // `forFile` targets that file's tests instead of the active pane's file (Issue #2212 fix-up).
  readonly runFileTests: (forFile?: string) => void;
  readonly runWorkspaceVerification: (kind: VerificationKind) => void;
  readonly cancelVerification: () => void;
  readonly trustWorkspaceScripts: () => void;
  readonly revokeWorkspaceScriptTrust: () => void;
}

export interface UseEditorVerificationRunOptions {
  readonly root: string;
  readonly activeFile: string | null;
}

interface SharedRunState {
  readonly running: boolean;
  readonly label: string;
}

// Issue #2212 fix-up (Epic #2092): how long a terminal result's {label, busy} owns a project's status
// slot before it is dismissed back to IDLE, letting the status bar fall back to test-generation status
// (or any other consumer) again. Without this, the label from a single finished run would otherwise
// mask every later status update for the rest of the session.
const VERIFICATION_STATUS_DISMISS_DELAY_MS = 4_000;
const EVENT_SOURCE_READY_TIMEOUT_MS = 10_000;
const IDLE: SharedRunState = { running: false, label: "" };

interface ProjectRunState {
  state: SharedRunState;
  activeRunId: string | null;
  pendingState: SharedRunState | null;
  flushScheduled: boolean;
  dismissTimer: ReturnType<typeof setTimeout> | null;
  startToken: number | null;
  startSequence: number;
  cancelRequested: boolean;
  cancelInFlightRunId: string | null;
  readonly listeners: Set<() => void>;
}

// ─── Module-level shared store (per project root) + lazily-opened shared EventSource ─────────────
const projectStates = new Map<string, ProjectRunState>();
// Populated from a run-started event's projectId (the only event carrying it) so later step/terminal
// events — which only carry runId — still route to the correct project's state.
const projectIdByRunId = new Map<string, string>();
let sharedSource: EventSource | null = null;
let sharedSourceOpen = false;
let sharedSourceReadyPromise: Promise<boolean> | null = null;
let resolveSharedSourceReady: ((ready: boolean) => void) | null = null;
let sharedSourceReadyTimer: ReturnType<typeof setTimeout> | null = null;
let totalListenerCount = 0;

function projectState(root: string): ProjectRunState {
  let entry = projectStates.get(root);
  if (entry === undefined) {
    entry = {
      state: IDLE,
      activeRunId: null,
      pendingState: null,
      flushScheduled: false,
      dismissTimer: null,
      startToken: null,
      startSequence: 0,
      cancelRequested: false,
      cancelInFlightRunId: null,
      listeners: new Set(),
    };
    projectStates.set(root, entry);
  }
  return entry;
}

// Drops an idle, unsubscribed project entry so a long session that opens/closes many project
// windows does not accumulate unbounded empty map entries.
function pruneIfIdle(root: string): void {
  const entry = projectStates.get(root);
  if (
    entry !== undefined &&
    entry.listeners.size === 0 &&
    entry.activeRunId === null &&
    entry.startToken === null &&
    entry.dismissTimer === null
  ) {
    projectStates.delete(root);
  }
}

function clearDismissTimer(entry: ProjectRunState): void {
  if (entry.dismissTimer !== null) {
    clearTimeout(entry.dismissTimer);
    entry.dismissTimer = null;
  }
}

function scheduleDismiss(root: string, entry: ProjectRunState): void {
  clearDismissTimer(entry);
  entry.dismissTimer = setTimeout(() => {
    entry.dismissTimer = null;
    emit(root, entry, IDLE);
    pruneIfIdle(root);
  }, VERIFICATION_STATUS_DISMISS_DELAY_MS);
}

function subscribe(root: string, listener: () => void): () => void {
  const entry = projectState(root);
  entry.listeners.add(listener);
  totalListenerCount += 1;
  return (): void => {
    entry.listeners.delete(listener);
    totalListenerCount -= 1;
    pruneIfIdle(root);
    if (totalListenerCount === 0) closeSharedSource();
  };
}

function getSnapshot(root: string): SharedRunState {
  return projectStates.get(root)?.state ?? IDLE;
}

// Coalesce updates: many events in one microtask produce ONE store flush per project (one render per
// subscriber), matching the pre-existing single-project coalescing behavior.
function emit(root: string, entry: ProjectRunState, next: SharedRunState): void {
  entry.pendingState = next;
  if (entry.flushScheduled) return;
  entry.flushScheduled = true;
  queueMicrotask(() => {
    entry.flushScheduled = false;
    if (entry.pendingState === null) return;
    entry.state = entry.pendingState;
    entry.pendingState = null;
    for (const listener of [...entry.listeners]) listener();
  });
}

function labelFor(event: EditorVerificationEvent): SharedRunState & { readonly terminal: boolean } {
  switch (event.kind) {
    case "run-started":
      return { running: true, label: "Verification: starting…", terminal: false };
    case "step-started":
      return { running: true, label: `Verification: ${event.stepKind}…`, terminal: false };
    case "step-completed":
      return {
        running: true,
        label: `Verification: ${event.stepKind} ${event.status}`,
        terminal: false,
      };
    case "run-completed":
      return {
        running: false,
        label: `Verification: ${event.report.overallStatus}`,
        terminal: true,
      };
    case "run-cancelled":
      return { running: false, label: "Verification: cancelled", terminal: true };
    case "run-failed":
      return { running: false, label: "Verification: failed", terminal: true };
  }
}

function adoptStartedRun(event: Extract<EditorVerificationEvent, { kind: "run-started" }>): string {
  const root = event.projectId;
  projectIdByRunId.set(event.runId, root);
  const entry = projectState(root);
  // A fresh run supersedes any pending dismiss from a PREVIOUS run's terminal label.
  clearDismissTimer(entry);
  if (entry.activeRunId !== null && entry.activeRunId !== event.runId) {
    projectIdByRunId.delete(entry.activeRunId);
  }
  entry.activeRunId = event.runId;
  entry.startToken = null;
  if (entry.cancelRequested) void requestCancel(root, event.runId);
  return root;
}

function rootForTrackedRun(
  event: Exclude<EditorVerificationEvent, { kind: "run-started" }>,
): string | null {
  const root = projectIdByRunId.get(event.runId);
  if (root === undefined) return null;
  const entry = projectStates.get(root);
  return entry?.activeRunId === event.runId ? root : null;
}

function rootForEvent(event: EditorVerificationEvent): string | null {
  return event.kind === "run-started" ? adoptStartedRun(event) : rootForTrackedRun(event);
}

function settleTerminalRun(root: string, entry: ProjectRunState, runId: string): void {
  entry.activeRunId = null;
  entry.startToken = null;
  entry.cancelRequested = false;
  if (entry.cancelInFlightRunId !== runId) entry.cancelInFlightRunId = null;
  projectIdByRunId.delete(runId);
  if (!hasActiveRun()) closeSharedSource();
  // Issue #2212 fix-up: dismiss the terminal label after a short delay so it does not permanently
  // mask a later status update (e.g. test-generation) in the project's shared status-bar `run` slot.
  scheduleDismiss(root, entry);
}

function onEvent(event: EditorVerificationEvent): void {
  const root = rootForEvent(event);
  if (root === null) return;
  const entry = projectState(root);
  // Feed the latest completed report to the Problems panel (Issue #2213) — the run store is the one
  // authoritative source of the report, so the problems store never opens a second stream.
  if (event.kind === "run-completed") setVerificationReport(root, event.report);
  const view = labelFor(event);
  if (view.terminal) settleTerminalRun(root, entry, event.runId);
  emit(root, entry, { running: view.running, label: view.label });
}

function onMessage(message: MessageEvent<string>): void {
  try {
    const parsed: unknown = JSON.parse(message.data);
    if (isEditorVerificationEvent(parsed)) onEvent(parsed);
  } catch {
    // A malformed frame is ignored; the shared stream stays open for the next event.
  }
}

function settleSharedSourceReady(ready: boolean): void {
  if (sharedSourceReadyTimer !== null) clearTimeout(sharedSourceReadyTimer);
  sharedSourceReadyTimer = null;
  const resolve = resolveSharedSourceReady;
  resolveSharedSourceReady = null;
  sharedSourceReadyPromise = null;
  resolve?.(ready);
}

function waitForSharedSource(source: EventSource): Promise<boolean> {
  if (sharedSourceOpen) return Promise.resolve(true);
  if (sharedSourceReadyPromise !== null) return sharedSourceReadyPromise;
  sharedSourceReadyPromise = new Promise<boolean>((resolve) => {
    resolveSharedSourceReady = resolve;
  });
  sharedSourceReadyTimer = setTimeout(() => {
    if (sharedSource !== source || sharedSourceOpen) return;
    // A reconnect waiter must fail closed without tearing down the one stream that an already
    // adopted run still needs for its terminal event. A stream with only pending starts is safe to
    // close, preserving the ordinary never-open handshake behavior.
    if (projectIdByRunId.size > 0) settleSharedSourceReady(false);
    else closeSharedSource();
  }, EVENT_SOURCE_READY_TIMEOUT_MS);
  return sharedSourceReadyPromise;
}

function openSharedSource(): Promise<boolean> {
  if (sharedSource !== null) return waitForSharedSource(sharedSource);
  let source: EventSource | null;
  try {
    source = createSameOriginApiEventSource(EVENTS_URL);
  } catch {
    source = null;
  }
  if (source === null) return Promise.resolve(false);
  sharedSource = source;
  sharedSourceOpen = false;
  source.addEventListener("open", () => {
    if (sharedSource !== source) return;
    sharedSourceOpen = true;
    settleSharedSourceReady(true);
  });
  source.addEventListener("error", () => {
    if (sharedSource === source) sharedSourceOpen = false;
  });
  for (const kind of EDITOR_VERIFICATION_EVENT_KINDS) {
    source.addEventListener(`verification:${kind}`, onMessage as EventListener);
  }
  return waitForSharedSource(source);
}

function closeSharedSource(): void {
  const source = sharedSource;
  sharedSource = null;
  sharedSourceOpen = false;
  source?.close();
  settleSharedSourceReady(false);
}

function hasActiveRun(): boolean {
  return [...projectStates.values()].some(
    (entry) => entry.activeRunId !== null || entry.startToken !== null,
  );
}

function showTransientStatus(root: string, label: string): void {
  const entry = projectState(root);
  emit(root, entry, { running: false, label });
  scheduleDismiss(root, entry);
}

function failStart(root: string, entry: ProjectRunState, token: number): void {
  if (entry.startToken !== token) return;
  entry.startToken = null;
  entry.activeRunId = null;
  entry.cancelRequested = false;
  if (!hasActiveRun()) closeSharedSource();
  showTransientStatus(root, "Verification: failed to start");
}

async function postRun(
  root: string,
  kinds: readonly VerificationKind[],
  token: number,
  targetPath?: string,
): Promise<void> {
  const entry = projectState(root);
  try {
    const response = await fetch(RUNS_URL, {
      method: "POST",
      headers: MUTATION_HEADERS,
      body: JSON.stringify({
        projectId: root,
        kinds,
        ...(targetPath === undefined ? {} : { targetPath }),
      }),
    });
    if (!response.ok) throw new Error("verification start rejected");
    const payload: unknown = await response.json();
    if (!isEditorVerificationRun(payload) || payload.projectId !== root) {
      throw new Error("malformed verification run");
    }
    if (entry.startToken !== token) return;
    entry.startToken = null;
    entry.activeRunId = payload.runId;
    projectIdByRunId.set(payload.runId, root);
    if (entry.cancelRequested) void requestCancel(root, payload.runId);
  } catch {
    failStart(root, entry, token);
  }
}

async function startAfterStreamReady(
  root: string,
  kinds: readonly VerificationKind[],
  entry: ProjectRunState,
  token: number,
  targetPath?: string,
): Promise<void> {
  if (!(await openSharedSource())) {
    failStart(root, entry, token);
    return;
  }
  if (entry.startToken !== token) return;
  await postRun(root, kinds, token, targetPath);
}

function startRun(root: string, kinds: readonly VerificationKind[], targetPath?: string): void {
  if (root.length === 0) return;
  const entry = projectState(root);
  if (entry.startToken !== null || entry.activeRunId !== null || entry.state.running) return;
  clearDismissTimer(entry);
  entry.startSequence += 1;
  entry.startToken = entry.startSequence;
  entry.cancelRequested = false;
  emit(root, entry, { running: true, label: "Verification: starting…" });
  void startAfterStreamReady(root, kinds, entry, entry.startToken, targetPath);
}

function isDeleteAcknowledgement(value: unknown): value is { readonly ok: true } {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}

function acknowledgeCancel(root: string, entry: ProjectRunState, runId: string): void {
  if (entry.activeRunId !== null && entry.activeRunId !== runId) return;
  if (entry.startToken !== null && entry.cancelInFlightRunId !== runId) return;
  if (entry.activeRunId === runId) {
    entry.activeRunId = null;
    projectIdByRunId.delete(runId);
    if (!hasActiveRun()) closeSharedSource();
  }
  entry.cancelRequested = false;
  if (entry.cancelInFlightRunId === runId) entry.cancelInFlightRunId = null;
  clearDismissTimer(entry);
  emit(root, entry, { running: false, label: "Verification: cancelled" });
  scheduleDismiss(root, entry);
}

async function requestCancel(root: string, runId: string): Promise<void> {
  const entry = projectStates.get(root);
  if (entry === undefined || entry.cancelInFlightRunId === runId) return;
  entry.cancelInFlightRunId = runId;
  try {
    const response = await fetch(`${RUNS_URL}/${encodeURIComponent(runId)}`, {
      method: "DELETE",
      headers: MUTATION_HEADERS,
    });
    if (!response.ok) throw new Error("verification cancel rejected");
    const payload: unknown = await response.json();
    if (!isDeleteAcknowledgement(payload)) throw new Error("malformed cancel response");
    acknowledgeCancel(root, entry, runId);
  } catch {
    if (entry.activeRunId === runId) {
      emit(root, entry, { running: true, label: "Verification: cancel failed" });
    }
  } finally {
    if (entry.cancelInFlightRunId === runId) entry.cancelInFlightRunId = null;
  }
}

function cancelRun(root: string): void {
  const entry = projectStates.get(root);
  if (entry === undefined) return;
  entry.cancelRequested = true;
  if (entry.activeRunId !== null) {
    clearDismissTimer(entry);
    emit(root, entry, { running: true, label: "Verification: cancelling…" });
    void requestCancel(root, entry.activeRunId);
  }
}

// Exposed for hermetic tests to reset the module singleton between cases.
export function resetEditorVerificationRunStateForTests(): void {
  closeSharedSource();
  for (const entry of projectStates.values()) clearDismissTimer(entry);
  projectStates.clear();
  projectIdByRunId.clear();
  totalListenerCount = 0;
}

async function fetchVerificationCatalog(
  root: string,
  signal?: AbortSignal,
): Promise<EditorVerificationCatalog> {
  const url = `${CATALOG_URL}?projectId=${encodeURIComponent(root)}`;
  const response = await fetch(url, signal === undefined ? undefined : { signal });
  if (!response.ok) throw new Error("verification catalog rejected");
  const payload: unknown = await response.json();
  if (!isEditorVerificationCatalog(payload) || payload.projectId !== root) {
    throw new Error("malformed verification catalog");
  }
  return payload;
}

function catalogAllows(catalog: EditorVerificationCatalog | null, kind: VerificationKind): boolean {
  const entry = catalog?.kinds.find((candidate) => candidate.kind === kind);
  return entry?.available === true && entry.trustState === "trusted";
}

function explainUnavailable(
  catalog: EditorVerificationCatalog | null,
  kind: VerificationKind,
): string {
  const entry = catalog?.kinds.find((candidate) => candidate.kind === kind);
  if (entry?.trustState === "approval-required") {
    return "Verification: workspace script trust required";
  }
  return `Verification: ${kind} unavailable`;
}

async function updateWorkspaceTrust(
  root: string,
  method: "POST" | "DELETE",
  onCatalog: (catalog: EditorVerificationCatalog) => void,
): Promise<void> {
  try {
    const response = await fetch(TRUST_URL, {
      method,
      headers: MUTATION_HEADERS,
      body: JSON.stringify({ projectId: root }),
    });
    if (!response.ok) throw new Error("workspace trust update rejected");
    onCatalog(await fetchVerificationCatalog(root));
  } catch {
    showTransientStatus(root, "Verification: workspace trust update failed");
  }
}

export function useEditorVerificationRun(
  options: UseEditorVerificationRunOptions,
): EditorVerificationRunControls {
  const { root, activeFile } = options;
  const rootSubscribe = useCallback((listener: () => void) => subscribe(root, listener), [root]);
  const rootGetSnapshot = useCallback(() => getSnapshot(root), [root]);
  const state = useSyncExternalStore(rootSubscribe, rootGetSnapshot, rootGetSnapshot);
  const verifiableTarget = useMemo(() => resolveVerificationTarget(activeFile), [activeFile]);
  const [catalog, setCatalog] = useState<EditorVerificationCatalog | null>(null);

  useEffect(() => {
    setCatalog(null);
    if (root.length === 0) return undefined;
    const controller = new AbortController();
    void fetchVerificationCatalog(root, controller.signal)
      .then(setCatalog)
      .catch(() => {
        if (!controller.signal.aborted) setCatalog(null);
      });
    return () => controller.abort();
  }, [root]);

  const runKind = useCallback(
    (kind: VerificationKind, targetPath?: string): void => {
      if (catalogAllows(catalog, kind)) startRun(root, [kind], targetPath);
      else showTransientStatus(root, explainUnavailable(catalog, kind));
    },
    [catalog, root],
  );

  const runWorkspaceVerification = useCallback(
    (kind: VerificationKind): void => {
      runKind(kind);
    },
    [runKind],
  );

  // Issue #2212 fix-up: an optional `forFile` targets a SPECIFIC file (e.g. the file a diff-review
  // surface is actually reviewing) instead of the pane's active file, so a multi-surface reviewer
  // (agent changeset/patch review, rename review) never silently verifies the wrong file. Omitting it
  // preserves the original "verify the active pane's file" behavior for the palette/status-bar case.
  const runFileTests = useCallback(
    (forFile?: string): void => {
      const target = forFile === undefined ? verifiableTarget : resolveVerificationTarget(forFile);
      if (target !== null) runKind("targeted-test", target);
    },
    [runKind, verifiableTarget],
  );

  const cancelVerification = useCallback((): void => {
    cancelRun(root);
  }, [root]);

  const trustWorkspaceScripts = useCallback((): void => {
    if (root.length > 0) void updateWorkspaceTrust(root, "POST", setCatalog);
  }, [root]);

  const revokeWorkspaceScriptTrust = useCallback((): void => {
    if (root.length > 0) void updateWorkspaceTrust(root, "DELETE", setCatalog);
  }, [root]);

  const statusBarRun = useMemo<EditorVerificationStatusRun | null>(
    () => (state.label.length === 0 ? null : { label: state.label, busy: state.running }),
    [state],
  );

  return {
    verificationRunning: state.running,
    verifiableTarget,
    statusBarRun,
    catalog,
    runFileTests,
    runWorkspaceVerification,
    cancelVerification,
    trustWorkspaceScripts,
    revokeWorkspaceScriptTrust,
  };
}
