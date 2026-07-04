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
  getActiveTaskWorkspace,
  listTaskWorkspaces,
  pauseTaskWorkspace,
  prepareHandoffTaskWorkspace,
  provisionTaskWorkspace,
  resumeTaskWorkspace,
  setActiveTaskWorkspace,
  type ActiveWorkspaceView,
} from "@/lib/task-workspace-api";
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

function messageFor(error: unknown): string {
  // ApiError extends Error and already carries the redacted server message, so a single Error check
  // covers it. Avoids importing ApiError here so AppShell's import graph does not require the @/lib/api
  // `ApiError` export to exist on every test mock of that module.
  if (error instanceof Error) return error.message;
  return "Task workspace action failed.";
}

export function useActiveWorkspaceState(): ActiveWorkspaceApi {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  // The repository root the inventory is listed for. Updated by refresh(root); reused by post-mutation
  // refreshes so they re-list the same repository without the caller re-supplying it.
  const rootRef = useRef<string | null>(null);
  const operationSeqRef = useRef(0);

  // Re-reads the active binding plus (when a repository root is known) the inventory, committing both
  // in one settle. An inventory failure never hides the active binding — the list degrades to empty.
  const reload = useCallback(async (operationSeq: number): Promise<void> => {
    const root = rootRef.current;
    const [active, instances] = await Promise.all([
      getActiveTaskWorkspace(),
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
        dispatch({ kind: "fail", error: messageFor(error) });
      }
    },
    [reload],
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
        dispatch({ kind: "fail", error: messageFor(error) });
      }
    },
    [reload],
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
        await provisionTaskWorkspace({ ...input, requestedBy: STUDIO_OPERATOR });
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
