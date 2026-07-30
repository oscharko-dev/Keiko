"use client";

// Active task-workspace binding state machine (Issue #446, Epic #443, ADR-0090).
//
// Owns the reducer state behind ActiveWorkspaceContext and is the ONLY value-importer of
// lib/task-workspace-api. Every mutation (switch/pause/resume/handoff/clear/provision) follows the
// same shape: mark `switching`, perform the wire call, then re-fetch the active binding + inventory
// and commit them in ONE state update so the bound surfaces flip atomically (AC2) and never observe a
// half-applied mixed context (AC6). The active root stays on the previous workspace until the new
// binding lands; on error the previous binding is preserved and the error surfaced.

import { useCallback, useMemo, useReducer, useRef } from "react";
import type { WorkspaceBinding, WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import {
  clearActiveTaskWorkspace,
  listTaskWorkspaces,
  pauseTaskWorkspace,
  prepareHandoffTaskWorkspace,
  resumeTaskWorkspace,
  setActiveTaskWorkspace,
  type ActiveWorkspaceView,
} from "@/lib/task-workspace-api";
import {
  bindVerifiedTaskWorkspace,
  restoreVerifiedActiveTaskWorkspace,
  TaskWorkspaceRestoreVerificationError,
} from "@/lib/verified-task-workspace-binding";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import type { ActiveWorkspaceApi } from "../context/ActiveWorkspaceContext";

// The opaque actor identity for this single-operator Studio session. Held constant so lock ownership
// is stable across calls (a pause/handoff after a switch is recognised as the same actor). The server
// treats it as an opaque id only — never a credential.
const STUDIO_OPERATOR = "studio-operator";

interface State {
  readonly instances: readonly WorkspaceInstance[];
  readonly active: ActiveWorkspaceView | null;
  readonly loading: boolean;
  readonly switching: boolean;
  readonly error: string | null;
}

type Action =
  | { readonly kind: "load-start" }
  | { readonly kind: "mutate-start" }
  | {
      readonly kind: "settle";
      readonly instances: readonly WorkspaceInstance[];
      readonly active: ActiveWorkspaceView | null;
    }
  | { readonly kind: "fail"; readonly error: string };

const INITIAL: State = {
  instances: [],
  active: null,
  loading: false,
  switching: false,
  error: null,
};

function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case "load-start":
      return { ...state, loading: true, error: null };
    case "mutate-start":
      return { ...state, switching: true, error: null };
    case "settle":
      return {
        instances: action.instances,
        active: action.active,
        loading: false,
        switching: false,
        error: null,
      };
    case "fail":
      return { ...state, loading: false, switching: false, error: action.error };
    default:
      return state;
  }
}

function messageFor(error: unknown, t: I18nTranslate): string {
  // The restore-verification sentinel is UI-authored text and must speak the operator's locale;
  // its Error message is only a non-localized safety net (review finding on #2841).
  if (error instanceof TaskWorkspaceRestoreVerificationError) {
    return t("workspace.binding.restoreVerificationFailed");
  }
  // ApiError extends Error and already carries the redacted server message, so a single Error check
  // covers it. Avoids importing ApiError here so AppShell's import graph does not require the @/lib/api
  // `ApiError` export to exist on every test mock of that module.
  if (error instanceof Error) return error.message;
  return "Task workspace action failed.";
}

export function useActiveWorkspaceState(): ActiveWorkspaceApi {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const t = useTranslate();
  // The repository root the inventory is listed for. Updated by refresh(root); reused by post-mutation
  // refreshes so they re-list the same repository without the caller re-supplying it.
  const rootRef = useRef<string | null>(null);
  const operationSeqRef = useRef(0);
  // The workspace identity whose restore verification this session holds — NOT a per-session "has
  // verified once" flag. Restore-time verification exists for the case where a pointer is claimed
  // without runtime start authority (release-audit F-09b), and `switchTo` routes through the same
  // `reload`, so a session-wide latch would let every workspace activated after the first claim its
  // binding unverified (`setActiveTaskWorkspace` does not reconcile). Keying on the identity keeps
  // repeated reloads of the SAME workspace off the heavy git/filesystem pass (#2841 review) while
  // every newly activated binding is verified before a surface claims it.
  const verifiedWorkspaceIdRef = useRef<string | null>(null);

  // Re-reads the active binding plus (when a repository root is known) the inventory, committing both
  // in one settle. An inventory failure never hides the active binding — the list degrades to empty.
  // Every active view whose workspace identity this session has not already verified is RE-VERIFIED
  // through the shared reconciliation sequence before it is claimed (release-audit F-09b): neither a
  // persisted nor a freshly activated pointer is runtime start authority by itself, so a binding that
  // fails re-verification surfaces as an error instead of a ready-looking workspace. Reloads of an
  // already-verified identity read state without re-running the pass.
  const reload = useCallback(async (operationSeq: number): Promise<void> => {
    const root = rootRef.current;
    // The held identity is consumed and cleared around every attempt, so only a view the pass has
    // actually granted is cached: a rejected or failed verification leaves nothing held and the next
    // load re-verifies whatever is active (fail closed). Switching away and back therefore verifies
    // again — the earlier workspace may have drifted while another one was bound.
    const readActive = async (): Promise<ActiveWorkspaceView | null> => {
      const verifiedWorkspaceId = verifiedWorkspaceIdRef.current;
      verifiedWorkspaceIdRef.current = null;
      const verified = await restoreVerifiedActiveTaskWorkspace({ verifiedWorkspaceId });
      verifiedWorkspaceIdRef.current = verified?.instance.workspaceId ?? null;
      return verified;
    };
    const [active, instances] = await Promise.all([
      readActive(),
      root === null || root.length === 0
        ? Promise.resolve<readonly WorkspaceInstance[]>([])
        : listTaskWorkspaces(root).catch(() => [] as readonly WorkspaceInstance[]),
    ]);
    if (operationSeqRef.current !== operationSeq) return;
    dispatch({ kind: "settle", instances, active });
  }, []);

  const refresh = useCallback(
    async (root?: string): Promise<void> => {
      if (root !== undefined) rootRef.current = root;
      const operationSeq = (operationSeqRef.current += 1);
      dispatch({ kind: "load-start" });
      try {
        await reload(operationSeq);
      } catch (error) {
        if (operationSeqRef.current !== operationSeq) return;
        dispatch({ kind: "fail", error: messageFor(error, t) });
      }
    },
    [reload, t],
  );

  // Shared mutation envelope: guard with `switching`, run the wire call, then reload + commit
  // atomically. Surfaces keep the previous active root until reload lands (no mixed transient state).
  const mutate = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      const operationSeq = (operationSeqRef.current += 1);
      dispatch({ kind: "mutate-start" });
      try {
        await action();
        if (operationSeqRef.current !== operationSeq) return;
        await reload(operationSeq);
      } catch (error) {
        if (operationSeqRef.current !== operationSeq) return;
        dispatch({ kind: "fail", error: messageFor(error, t) });
      }
    },
    [reload, t],
  );

  const switchTo = useCallback(
    (workspaceId: string): Promise<void> =>
      mutate(() => setActiveTaskWorkspace({ workspaceId, requestedBy: STUDIO_OPERATOR })),
    [mutate],
  );

  const clearActive = useCallback(
    (): Promise<void> => mutate(() => clearActiveTaskWorkspace()),
    [mutate],
  );

  const pause = useCallback(
    (workspaceId: string): Promise<void> =>
      mutate(() => pauseTaskWorkspace({ workspaceId, requestedBy: STUDIO_OPERATOR })),
    [mutate],
  );

  const resume = useCallback(
    (workspaceId: string): Promise<void> =>
      mutate(() => resumeTaskWorkspace({ workspaceId, requestedBy: STUDIO_OPERATOR })),
    [mutate],
  );

  const prepareHandoff = useCallback(
    (workspaceId: string): Promise<void> =>
      mutate(() => prepareHandoffTaskWorkspace({ workspaceId, requestedBy: STUDIO_OPERATOR })),
    [mutate],
  );

  const provision = useCallback(
    (input: { root: string; taskId: string; baseBranch: string }): Promise<void> =>
      mutate(async () => {
        rootRef.current = input.root;
        const result = await bindVerifiedTaskWorkspace({
          ...input,
          requestedBy: STUDIO_OPERATOR,
        });
        if (!result.ok) {
          throw new Error("The task workspace could not be verified and activated.");
        }
      }),
    [mutate],
  );

  const activeBinding: WorkspaceBinding | null = state.active?.binding ?? null;
  const activeInstance: WorkspaceInstance | null = state.active?.instance ?? null;

  return useMemo<ActiveWorkspaceApi>(
    () => ({
      instances: state.instances,
      activeBinding,
      activeInstance,
      activeRoot: activeBinding?.activeRoot ?? null,
      loading: state.loading,
      switching: state.switching,
      error: state.error,
      refresh,
      switchTo,
      clearActive,
      pause,
      resume,
      prepareHandoff,
      provision,
    }),
    [
      state.instances,
      state.loading,
      state.switching,
      state.error,
      activeBinding,
      activeInstance,
      refresh,
      switchTo,
      clearActive,
      pause,
      resume,
      prepareHandoff,
      provision,
    ],
  );
}
