"use client";

// Issue #2212 (Epic #2092, ADR-0126) — the editor's run-affordance state machine. Starts and cancels
// verification runs through Issue #2211's GOVERNED route (`/api/editor/verification/*`) and reflects
// their content-free lifecycle over a SINGLE, SHARED, ref-counted same-origin SSE stream (mirroring
// the shared EventSource pattern the epic's Architecture Invariants require). It never executes
// anything itself; every run goes through the sandboxed spawn boundary on the server.
//
// The shared stream is opened LAZILY — only while a run is active — and closed on the terminal event,
// so an idle editor holds no verification connection. All hook instances (palette host + per-pane
// status bar/diff-review) read one module-level store, so a run started from any surface is reflected
// everywhere without a second connection. SSE-driven updates are coalesced to at most one store flush
// per microtask so a burst cannot flood the status bar's aria-live region (perf budgets B5/B6).

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
  readonly runFileTests: () => void;
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

// ─── Module-level shared store + lazily-opened shared EventSource ─────────────────────
const IDLE: SharedRunState = { running: false, label: "" };
let sharedState: SharedRunState = IDLE;
let activeRunId: string | null = null;
let sharedSource: EventSource | null = null;
let pendingState: SharedRunState | null = null;
let flushScheduled = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
    if (listeners.size === 0) closeSharedSource();
  };
}

function getSnapshot(): SharedRunState {
  return sharedState;
}

// Coalesce updates: many events in one microtask produce ONE store flush (one render per subscriber).
function emit(next: SharedRunState): void {
  pendingState = next;
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    if (pendingState === null) return;
    sharedState = pendingState;
    pendingState = null;
    for (const listener of [...listeners]) listener();
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
  if (event.kind === "run-started") {
    activeRunId = event.runId;
  } else if (activeRunId === null || event.runId !== activeRunId) {
    return;
  }
  // Feed the latest completed report to the Problems panel (Issue #2213) — the run store is the one
  // authoritative source of the report, so the problems store never opens a second stream.
  if (event.kind === "run-completed") setVerificationReport(event.report);
  const view = labelFor(event);
  if (view.terminal) {
    activeRunId = null;
    closeSharedSource();
  }
  emit({ running: view.running, label: view.label });
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
  emit({ running: true, label: "Verification: starting…" });
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
      activeRunId = run.runId;
    })
    .catch(() => {
      activeRunId = null;
      closeSharedSource();
      emit({ running: false, label: "Verification: failed to start" });
    });
}

function cancelRun(): void {
  if (activeRunId === null) return;
  void fetch(`${RUNS_URL}/${encodeURIComponent(activeRunId)}`, { method: "DELETE" }).catch(() => {
    // The terminal SSE event settles the UI; a failed cancel leaves the run to finish on its own.
  });
}

// Exposed for hermetic tests to reset the module singleton between cases.
export function resetEditorVerificationRunStateForTests(): void {
  closeSharedSource();
  sharedState = IDLE;
  pendingState = null;
  flushScheduled = false;
  activeRunId = null;
  listeners.clear();
}

export function useEditorVerificationRun(
  options: UseEditorVerificationRunOptions,
): EditorVerificationRunControls {
  const { root, activeFile } = options;
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const verifiableTarget = useMemo(() => resolveVerificationTarget(activeFile), [activeFile]);

  const runWorkspaceVerification = useCallback(
    (kind: VerificationKind): void => {
      startRun(root, [kind]);
    },
    [root],
  );

  const runFileTests = useCallback((): void => {
    if (verifiableTarget !== null) startRun(root, ["targeted-test"], verifiableTarget);
  }, [root, verifiableTarget]);

  const cancelVerification = useCallback((): void => {
    cancelRun();
  }, []);

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
