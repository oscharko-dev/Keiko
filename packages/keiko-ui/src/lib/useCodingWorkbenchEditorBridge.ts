"use client";

// A Code task run mutates files through the same governed editor-agent bridge a human's Editor
// window uses (ADR-0060/ADR-0061): the browser, not the server, owns applying a mutation, and a
// live bridge session bound to the run's workspace root must exist before `keiko_changeset_edit`
// can ever succeed. Before this hook, only the Editor window registered such a session, so a Code
// task started from the Coding Workbench alone could approve a file-edit permission forever
// without ever landing a change. This hook registers a headless bridge session for the active run's
// workspace root, so edits work without the operator separately opening the Editor.
//
// `applyChangeset` is deliberately the only action type this hook handles: it is the one write
// action type exempt from the "must match the active open buffer" precondition (contracts:
// `EDITOR_AGENT_ACTIVE_BUFFER_ACTION_TYPES`), so it needs no open file/pane to execute. Every other
// action type the generic dispatcher supports is either not applicable headless (format/save/
// applyTextEdits/applyPatch/setSelection/splitPane/moveTab) or already fails closed with a
// structured "Provider unavailable" descriptor when its controller is left undefined.

import { useCallback, useMemo, useRef, useState } from "react";
import { EDITOR_AGENT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/editor-agent";
import {
  postEditorAgentResult,
  postEditorAgentResultRequest,
  useEditorAgentBridge,
  type EditorAgentActionControllers,
} from "@/app/components/desktop/widgets/cards/editorAgentBridge";
import {
  parseUnifiedDiff,
  type DiffParseResult,
} from "@/app/components/desktop/widgets/cards/shared/diffParser";
import { ApiError, postEditorAgentSessionSnapshot } from "./api";
import { useRunLockedRoot } from "./useCodingWorkbenchChanges";
import type {
  EditorAgentAction,
  EditorAgentActionResultRequest,
  EditorAgentSessionSnapshot,
  EditorAgentSnapshotResponse,
} from "./types";

/**
 * F-09a: the machine facts of the failure that stopped a changeset decision from reaching the run.
 * Before this existed, `attemptDecision` ended in a bare `catch { return false }` that discarded the
 * error outright, so the surfaced alert could only say "something failed" — the operator had no code
 * to act on and no correlation id to report, on the one action that blocks the run's file write.
 */
export interface CodingWorkbenchDecisionFailure {
  readonly code: string;
  readonly correlationId?: string;
}

export interface CodingWorkbenchChangesetReview {
  readonly actionId: string;
  readonly diff: DiffParseResult;
  /** True while a prior decision on this same review is still being confirmed with the server. */
  readonly deciding: boolean;
  /**
   * True after a decision could not be confirmed even after the retry and forced-reconnect
   * escalation. The review stays visible with this flag set — never cleared silently — so the
   * operator sees a clear signal to retry instead of the review vanishing as if it had gone
   * through while the underlying tool call is actually still unresolved.
   */
  readonly deliveryFailed: boolean;
  /** The last delivery failure's code and correlation id. Non-null exactly when `deliveryFailed`. */
  readonly deliveryFailure: CodingWorkbenchDecisionFailure | null;
}

// The bridge's live SSE connection can be mid-reconnect (e.g. a snapshot refresh rotated its
// capability) at the exact moment a human clicks Approve/Deny; the server then answers a
// transient `BRIDGE_LEASE_INACTIVE` 409 rather than accepting the result. A short bounded retry
// absorbs that window instead of leaving the run's tool call to time out over a race the operator
// had no part in and cannot see.
const DECISION_RETRY_DELAYS_MS = [150, 400, 900] as const;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function decisionRequest(
  action: EditorAgentAction,
  status: "succeeded" | "failed",
  message: string | undefined,
): EditorAgentActionResultRequest {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    kind: "result",
    result: {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: action.actionId,
      sessionId: action.sessionId,
      ...(action.rootBinding === undefined
        ? {}
        : {
            rootAttribution: {
              rootRef: action.rootBinding.rootRef,
              rootIdentityDigest: action.rootBinding.rootIdentityDigest,
            },
          }),
      status,
      ...(message === undefined ? {} : { message }),
    },
  };
}

/** Delivered, or not delivered with the reason why — never a bare boolean that loses the reason. */
type DecisionOutcome =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly failure: CodingWorkbenchDecisionFailure };

/** A fetch that never reached the BFF: distinct from a BFF that answered and refused. */
const DECISION_UNREACHABLE_CODE = "EDITOR_CHANGESET_DECISION_UNREACHABLE";
/** Anything else, e.g. the bridge decision capability missing for this session. */
const DECISION_FAILED_CODE = "EDITOR_CHANGESET_DECISION_FAILED";

function decisionFailure(error: unknown): CodingWorkbenchDecisionFailure {
  if (error instanceof ApiError) {
    return error.correlationId === undefined
      ? { code: error.code }
      : { code: error.code, correlationId: error.correlationId };
  }
  return { code: error instanceof TypeError ? DECISION_UNREACHABLE_CODE : DECISION_FAILED_CODE };
}

async function attemptDecision(
  action: EditorAgentAction,
  status: "succeeded" | "failed",
  message: string | undefined,
): Promise<DecisionOutcome> {
  try {
    await postEditorAgentResultRequest(action, decisionRequest(action, status, message));
    return { delivered: true };
  } catch (error) {
    return { delivered: false, failure: decisionFailure(error) };
  }
}

async function submitDecisionWithRetry(
  action: EditorAgentAction,
  status: "succeeded" | "failed",
  message: string | undefined,
): Promise<DecisionOutcome> {
  for (const delay of DECISION_RETRY_DELAYS_MS) {
    const outcome = await attemptDecision(action, status, message);
    if (outcome.delivered) return outcome;
    await wait(delay);
  }
  return attemptDecision(action, status, message);
}

// Reconnect delays: long enough for the disabled-effect's cleanup (unsubscribe, close the SSE
// stream) and the re-enabled effect's setup (fresh snapshot registration, new SSE stream) to each
// commit as their own render — two synchronous `setState` calls in one tick would just batch into
// one render and skip the teardown entirely.
const FORCE_RECONNECT_SETTLE_MS = 120;

export interface UseCodingWorkbenchEditorBridgeInput {
  /** The task workspace's currently active absolute root, or null when none is bound. This is the
   * shell's LIVE root, not necessarily the run's own — the hook locks onto the run's root itself
   * (workbench audit, 2026-09-03) via `useRunLockedRoot`. */
  readonly root: string | null;
  readonly runId: string | undefined;
  /** True only while a run is live enough to receive tool-call actions. */
  readonly active: boolean;
  /**
   * True while the active workspace binding itself is still resolving (loading or switching).
   * Optional so existing callers with no such transitional state default to `false` — the same
   * "already resolved" assumption `root` carried before this hook started locking it to the run.
   */
  readonly bindingPending?: boolean | undefined;
  /**
   * The root the run was submitted against, captured by the caller when Start was issued
   * (`useCodingWorkbenchRunWorkspace`), and forwarded to the lock's own `submittedRoot`: without
   * it, a Start whose response lands after the operator moved the workspace pointer locks this
   * session onto the WRONG workspace, and the run's real root gets no session at all (#3381).
   */
  readonly submittedRoot?: string | null | undefined;
}

export interface UseCodingWorkbenchEditorBridgeResult {
  readonly pendingReview: CodingWorkbenchChangesetReview | null;
  readonly approve: () => void;
  readonly deny: () => void;
  /** Repeats the last approve/deny decision after a `deliveryFailed` review. */
  readonly retry: () => void;
}

function headlessSnapshot(sessionId: string, root: string): EditorAgentSessionSnapshot {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId,
    windowId: "coding-workbench",
    workspaceRoot: root,
    activePaneId: null,
    panes: [],
    dirtyFiles: [],
    activeFile: null,
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    textMode: "none",
    updatedAt: Date.now(),
  };
}

// No open buffer exists headless, so every buffer-shaped controller is inert: the dispatcher only
// reaches them for action types `applyChangeset` is exempt from (see the file-level comment).
const INERT_BRIDGE_CONTROLLERS: Omit<EditorAgentActionControllers, "applyChangeset"> = {
  paneId: undefined,
  activePaneId: undefined,
  activeFile: undefined,
  verifyActiveTarget: () => true,
  verifyWritePrecondition: () => true,
  onSelectOpenFile: undefined,
  formattingEnabled: false,
  formatRequest: { increment: () => undefined },
  persist: () => Promise.resolve(false),
  currentText: () => "",
  applyTextEdits: () => undefined,
  applyPatch: () => undefined,
  onSplitPane: undefined,
  onMoveTab: undefined,
  onRequestSelectionReveal: undefined,
};

function noopConflictHandler(): void {
  // Headless bridge: a conflict on a `applyChangeset` action already reaches the run through its
  // posted result (surfaced there as a failed tool call); nothing else in this hook observes it.
}

interface PendingChangeset {
  readonly action: EditorAgentAction;
  readonly diff: DiffParseResult;
  readonly deciding: boolean;
  readonly deliveryFailed: boolean;
  readonly deliveryFailure: CodingWorkbenchDecisionFailure | null;
}

export function useCodingWorkbenchEditorBridge(
  input: UseCodingWorkbenchEditorBridgeInput,
): UseCodingWorkbenchEditorBridgeResult {
  const { runId, active } = input;
  // Workbench audit, 2026-09-03: lock to the run's own workspace root for its entire lifetime rather
  // than following whatever workspace the shell's active binding drifts to later — an unrelated
  // workspace switch mid-run must never re-register this session against another root.
  //
  // #3381 review: the lock arms from the SUBMISSION-time root, and the session it registers stays
  // bound to that root even once the shell's pointer names something else. Both halves are the
  // same invariant — this session serves the run, whose authority the server bound to one root —
  // and dropping either one breaks every governed edit the run still has to make: arming from the
  // live root at response time binds another workspace entirely, and going inert on a pointer move
  // leaves the run's `applyChangeset` calls with no session to reach. The presentation surfaces
  // (`CodingWorkbenchChanges`, the composer chips) keep the opposite rule via `useRunBoundRoot`:
  // they report the divergence instead of showing one workspace's state under another's name.
  const root = useRunLockedRoot({
    runId: input.runId,
    root: input.root,
    bindingPending: input.bindingPending ?? false,
    submittedRoot: input.submittedRoot ?? null,
  });
  const [pending, setPending] = useState<PendingChangeset | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  // Set synchronously inside `decide()` itself: `pending.deciding` only reflects reality after
  // React commits the next render, so a second click landing before that commit (no `await`
  // between them) would read the stale `false` and double-submit. This ref has no such lag.
  const decidingRef = useRef(false);
  // Forces a full unsubscribe/resubscribe of the underlying bridge (see `forceReconnect` below)
  // when the live SSE stream has silently gone stale — the shared registry has no signal of its
  // own for "connected but no longer actually live", so a full remount is the only lever available
  // from this hook's side of that boundary.
  const [suspended, setSuspended] = useState(false);

  const sessionId = runId === undefined ? "" : `coding-workbench-edit-${runId}`;
  const enabled = active && root !== null && sessionId !== "" && !suspended;

  const handleApplyChangeset = useCallback((action: EditorAgentAction): void => {
    if (action.requiresReview === false) {
      postEditorAgentResult(action, "succeeded");
      return;
    }
    decidingRef.current = false;
    setPending({
      action,
      diff: parseUnifiedDiff(action.changeset?.patch ?? ""),
      deciding: false,
      deliveryFailed: false,
      deliveryFailure: null,
    });
  }, []);

  const controllers = useMemo<EditorAgentActionControllers>(
    () => ({ ...INERT_BRIDGE_CONTROLLERS, applyChangeset: handleApplyChangeset }),
    [handleApplyChangeset],
  );

  const registerSnapshot = useCallback(
    (capability: string | undefined): Promise<EditorAgentSnapshotResponse | void> =>
      root === null || sessionId === ""
        ? Promise.resolve()
        : postEditorAgentSessionSnapshot(headlessSnapshot(sessionId, root), capability),
    [root, sessionId],
  );

  useEditorAgentBridge({
    agentSessionId: sessionId,
    controllers,
    enabled,
    registerSnapshot,
    onConflict: noopConflictHandler,
  });

  const forceReconnect = useCallback(async (): Promise<void> => {
    setSuspended(true);
    await wait(FORCE_RECONNECT_SETTLE_MS);
    setSuspended(false);
    await wait(FORCE_RECONNECT_SETTLE_MS);
  }, []);

  // `lastDecisionRef` remembers which decision to retry: a failed Approve must resurface as a
  // retryable Approve, never silently as a Deny (or vice versa).
  const lastDecisionRef = useRef<{
    readonly status: "succeeded" | "failed";
    readonly message?: string;
  }>({ status: "succeeded" });

  const decide = useCallback(
    (status: "succeeded" | "failed", message?: string): void => {
      const current = pendingRef.current;
      if (current === null || decidingRef.current) return;
      lastDecisionRef.current = { status, ...(message === undefined ? {} : { message }) };
      decidingRef.current = true;
      setPending({ ...current, deciding: true, deliveryFailed: false, deliveryFailure: null });
      void (async () => {
        let outcome = await submitDecisionWithRetry(current.action, status, message);
        if (!outcome.delivered) {
          await forceReconnect();
          outcome = await submitDecisionWithRetry(current.action, status, message);
        }
        decidingRef.current = false;
        if (pendingRef.current?.action.actionId !== current.action.actionId) return;
        setPending(
          outcome.delivered
            ? null
            : {
                ...current,
                deciding: false,
                deliveryFailed: true,
                deliveryFailure: outcome.failure,
              },
        );
      })();
    },
    [forceReconnect],
  );
  const approve = useCallback((): void => decide("succeeded"), [decide]);
  const deny = useCallback((): void => decide("failed", "Rejected by the operator."), [decide]);
  const retry = useCallback((): void => {
    const { status, message } = lastDecisionRef.current;
    decide(status, message);
  }, [decide]);

  return {
    pendingReview:
      pending === null
        ? null
        : {
            actionId: pending.action.actionId,
            diff: pending.diff,
            deciding: pending.deciding,
            deliveryFailed: pending.deliveryFailed,
            deliveryFailure: pending.deliveryFailure,
          },
    approve,
    deny,
    retry,
  };
}
