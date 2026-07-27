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
import { postEditorAgentSessionSnapshot } from "./api";
import type {
  EditorAgentAction,
  EditorAgentActionResultRequest,
  EditorAgentSessionSnapshot,
  EditorAgentSnapshotResponse,
} from "./types";

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

async function attemptDecision(
  action: EditorAgentAction,
  status: "succeeded" | "failed",
  message: string | undefined,
): Promise<boolean> {
  try {
    await postEditorAgentResultRequest(action, decisionRequest(action, status, message));
    return true;
  } catch {
    return false;
  }
}

async function submitDecisionWithRetry(
  action: EditorAgentAction,
  status: "succeeded" | "failed",
  message: string | undefined,
): Promise<boolean> {
  for (const delay of DECISION_RETRY_DELAYS_MS) {
    if (await attemptDecision(action, status, message)) return true;
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
  /** The bound task workspace's absolute root, or null when no workspace is bound. */
  readonly root: string | null;
  readonly runId: string | undefined;
  /** True only while a run is live enough to receive tool-call actions. */
  readonly active: boolean;
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
}

export function useCodingWorkbenchEditorBridge(
  input: UseCodingWorkbenchEditorBridgeInput,
): UseCodingWorkbenchEditorBridgeResult {
  const { root, runId, active } = input;
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
      setPending({ ...current, deciding: true, deliveryFailed: false });
      void (async () => {
        let delivered = await submitDecisionWithRetry(current.action, status, message);
        if (!delivered) {
          await forceReconnect();
          delivered = await submitDecisionWithRetry(current.action, status, message);
        }
        decidingRef.current = false;
        if (pendingRef.current?.action.actionId !== current.action.actionId) return;
        setPending(delivered ? null : { ...current, deciding: false, deliveryFailed: true });
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
          },
    approve,
    deny,
    retry,
  };
}
