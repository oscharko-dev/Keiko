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

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  EDITOR_VERIFICATION_EVENT_KINDS,
  isEditorVerificationEvent,
  type EditorVerificationEvent,
  type EditorVerificationRun,
  type VerificationKind,
} from "@oscharko-dev/keiko-contracts";
import { createSameOriginApiEventSource } from "../../../../../lib/safe-event-source";
import { resolveVerificationTarget } from "./editorCommands";
import { setVerificationReport } from "./editorProblemsStore";

const RUNS_URL = "/api/editor/verification/runs";
const EVENTS_URL = "/api/editor/verification/events";

export interface EditorVerificationStatusRun {
  readonly label: string;
  readonly busy: boolean;
}

export interface EditorVerificationRunControls {
  readonly verificationRunning: boolean;
  readonly verifiableTarget: string | null;
  readonly statusBarRun: EditorVerificationStatusRun | null;
  // `forFile` targets that file's tests instead of the active pane's file (Issue #2212 fix-up).
  readonly runFileTests: (forFile?: string) => void;
  readonly runWorkspaceVerification: (kind: VerificationKind) => void;
  readonly cancelVerification: () => void;
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
const IDLE: SharedRunState = { running: false, label: "" };

interface ProjectRunState {
  state: SharedRunState;
  activeRunId: string | null;
  pendingState: SharedRunState | null;
  flushScheduled: boolean;
  dismissTimer: ReturnType<typeof setTimeout> | null;
  readonly listeners: Set<() => void>;
}

// ─── Module-level shared store (per project root) + lazily-opened shared EventSource ─────────────
const projectStates = new Map<string, ProjectRunState>();
// Populated from a run-started event's projectId (the only event carrying it) so later step/terminal
// events — which only carry runId — still route to the correct project's state.
const projectIdByRunId = new Map<string, string>();
let sharedSource: EventSource | null = null;
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

function onEvent(event: EditorVerificationEvent): void {
  let root: string;
  if (event.kind === "run-started") {
    root = event.projectId;
    projectIdByRunId.set(event.runId, root);
    const entry = projectState(root);
    // A fresh run supersedes any pending dismiss from a PREVIOUS run's terminal label.
    clearDismissTimer(entry);
    entry.activeRunId = event.runId;
  } else {
    const knownRoot = projectIdByRunId.get(event.runId);
    if (knownRoot === undefined) return;
    const entry = projectStates.get(knownRoot);
    if (entry === undefined || entry.activeRunId !== event.runId) return;
    root = knownRoot;
  }
  const entry = projectState(root);
  // Feed the latest completed report to the Problems panel (Issue #2213) — the run store is the one
  // authoritative source of the report, so the problems store never opens a second stream.
  if (event.kind === "run-completed") setVerificationReport(root, event.report);
  const view = labelFor(event);
  if (view.terminal) {
    entry.activeRunId = null;
    projectIdByRunId.delete(event.runId);
    if (![...projectStates.values()].some((e) => e.activeRunId !== null)) closeSharedSource();
    // Issue #2212 fix-up: dismiss the terminal label after a short delay so it does not permanently
    // mask a later status update (e.g. test-generation) in the project's shared status-bar `run` slot.
    scheduleDismiss(root, entry);
  }
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

function openSharedSource(): void {
  if (sharedSource !== null) return;
  sharedSource = createSameOriginApiEventSource(EVENTS_URL);
  if (sharedSource === null) return;
  for (const kind of EDITOR_VERIFICATION_EVENT_KINDS) {
    sharedSource.addEventListener(`verification:${kind}`, onMessage as EventListener);
  }
}

function closeSharedSource(): void {
  sharedSource?.close();
  sharedSource = null;
}

function startRun(root: string, kinds: readonly VerificationKind[], targetPath?: string): void {
  if (root.length === 0) return;
  const entry = projectState(root);
  emit(root, entry, { running: true, label: "Verification: starting…" });
  openSharedSource();
  void fetch(RUNS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: root,
      kinds,
      ...(targetPath === undefined ? {} : { targetPath }),
    }),
  })
    .then((response) => response.json())
    .then((run: EditorVerificationRun) => {
      entry.activeRunId = run.runId;
      projectIdByRunId.set(run.runId, root);
    })
    .catch(() => {
      entry.activeRunId = null;
      if (![...projectStates.values()].some((e) => e.activeRunId !== null)) closeSharedSource();
      emit(root, entry, { running: false, label: "Verification: failed to start" });
    });
}

function cancelRun(root: string): void {
  const entry = projectStates.get(root);
  const runId = entry?.activeRunId;
  if (runId === undefined || runId === null) return;
  void fetch(`${RUNS_URL}/${encodeURIComponent(runId)}`, { method: "DELETE" }).catch(() => {
    // The terminal SSE event settles the UI; a failed cancel leaves the run to finish on its own.
  });
}

// Exposed for hermetic tests to reset the module singleton between cases.
export function resetEditorVerificationRunStateForTests(): void {
  closeSharedSource();
  for (const entry of projectStates.values()) clearDismissTimer(entry);
  projectStates.clear();
  projectIdByRunId.clear();
  totalListenerCount = 0;
}

export function useEditorVerificationRun(
  options: UseEditorVerificationRunOptions,
): EditorVerificationRunControls {
  const { root, activeFile } = options;
  const rootSubscribe = useCallback((listener: () => void) => subscribe(root, listener), [root]);
  const rootGetSnapshot = useCallback(() => getSnapshot(root), [root]);
  const state = useSyncExternalStore(rootSubscribe, rootGetSnapshot, rootGetSnapshot);
  const verifiableTarget = useMemo(() => resolveVerificationTarget(activeFile), [activeFile]);

  const runWorkspaceVerification = useCallback(
    (kind: VerificationKind): void => {
      startRun(root, [kind]);
    },
    [root],
  );

  // Issue #2212 fix-up: an optional `forFile` targets a SPECIFIC file (e.g. the file a diff-review
  // surface is actually reviewing) instead of the pane's active file, so a multi-surface reviewer
  // (agent changeset/patch review, rename review) never silently verifies the wrong file. Omitting it
  // preserves the original "verify the active pane's file" behavior for the palette/status-bar case.
  const runFileTests = useCallback(
    (forFile?: string): void => {
      const target = forFile === undefined ? verifiableTarget : resolveVerificationTarget(forFile);
      if (target !== null) startRun(root, ["targeted-test"], target);
    },
    [root, verifiableTarget],
  );

  const cancelVerification = useCallback((): void => {
    cancelRun(root);
  }, [root]);

  const statusBarRun = useMemo<EditorVerificationStatusRun | null>(
    () => (state.label.length === 0 ? null : { label: state.label, busy: state.running }),
    [state],
  );

  return {
    verificationRunning: state.running,
    verifiableTarget,
    statusBarRun,
    runFileTests,
    runWorkspaceVerification,
    cancelVerification,
  };
}
