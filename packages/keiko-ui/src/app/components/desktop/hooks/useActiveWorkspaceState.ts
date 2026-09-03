"use client";

// Active task-workspace binding state machine (Issue #446, Epic #443, ADR-0090).
//
// Owns the reducer state behind ActiveWorkspaceContext and is the ONLY value-importer of
// lib/task-workspace-api. Every mutation (switch/pause/resume/handoff/clear/provision) follows the
// same shape: mark `switching`, perform the wire call, then re-fetch the active binding + inventory
// and commit them in ONE state update so the bound surfaces flip atomically (AC2) and never observe a
// half-applied mixed context (AC6). The active root stays on the previous workspace until the new
// binding lands; on error the previous binding is preserved and the error surfaced.
//
// Mutations are non-commutative and the client cannot un-apply one the server is already running,
// so the state is made to CONVERGE instead: the last applied request of a burst re-reads the server
// and commits that read, whether or not a newer click superseded it. The surface therefore ends on
// the server's pointer, never on the click order (#3381 review).

import { useCallback, useMemo, useReducer, useRef } from "react";
import type {
  WorkspaceBinding,
  WorkspaceInstance,
  WorkspaceRecoveryStrategy,
} from "@oscharko-dev/keiko-contracts";
import {
  clearActiveTaskWorkspace,
  listTaskWorkspaces,
  pauseTaskWorkspace,
  prepareHandoffTaskWorkspace,
  repairTaskWorkspace,
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
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
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
  readonly inventoryUnavailable: boolean;
}

interface ReadCommit {
  readonly instances: readonly WorkspaceInstance[];
  readonly inventoryUnavailable: boolean;
  readonly active: ActiveWorkspaceView | null;
}

// `settle` commits the read of the operation the surface is waiting for and clears the error with
// it. `reconcile` commits the same read WITHOUT clearing it: it is the authoritative re-read that
// follows the last applied mutation to settle, which may be an older one whose newer sibling was
// refused — dropping that refusal would leave the operator with no sign it happened (AGENTS.md §7).
type ReloadMode = "settle" | "reconcile";

type Action =
  | { readonly kind: "load-start" }
  | { readonly kind: "mutate-start" }
  | ({ readonly kind: ReloadMode } & ReadCommit)
  | { readonly kind: "fail"; readonly error: string };

const INITIAL: State = {
  instances: [],
  active: null,
  loading: false,
  switching: false,
  error: null,
  inventoryUnavailable: false,
};

function committed(read: ReadCommit, error: string | null): State {
  return {
    instances: read.instances,
    active: read.active,
    loading: false,
    switching: false,
    error,
    inventoryUnavailable: read.inventoryUnavailable,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case "load-start":
      return { ...state, loading: true, error: null };
    case "mutate-start":
      return { ...state, switching: true, error: null };
    case "settle":
      return committed(action, null);
    case "reconcile":
      return committed(action, state.error);
    case "fail":
      return { ...state, loading: false, switching: false, error: action.error };
    default:
      return state;
  }
}

// UI-authored outcomes of the bind and repair sequences. Like the restore-verification sentinel,
// each is a typed error whose message is only a non-localized safety net: `messageFor` maps the
// class to the operator's locale, so no surface renders the fallback text verbatim.
class TaskWorkspaceProvisionError extends Error {
  public constructor() {
    super("The task workspace could not be verified and activated.");
    this.name = "TaskWorkspaceProvisionError";
  }
}

class TaskWorkspaceRepairOperatorRequiredError extends Error {
  public constructor() {
    super("The recovery needs an operator before this workspace can be repaired automatically.");
    this.name = "TaskWorkspaceRepairOperatorRequiredError";
  }
}

interface InventoryRead {
  readonly instances: readonly WorkspaceInstance[];
  readonly unavailable: boolean;
}

// The inventory degrades to empty so a listing failure never hides the active binding, but the
// failure itself is not silent: an empty list from a 503 must be distinguishable in the console
// from a repository that genuinely has no managed workspaces (AGENTS.md §7/§8) — and on the
// surface too, which is what `unavailable` carries. The console diagnostic alone left the panel
// rendering "No managed task workspaces yet." under a bound workspace (#3381 review).
function inventoryUnavailable(error: unknown): InventoryRead {
  reportClientDiagnostic(
    `[keiko] task workspace inventory refresh failed: ${clientErrorSummary(error)}`,
    { correlationId: correlationIdOf(error) },
  );
  return { instances: [], unavailable: true };
}

function readInventory(): Promise<InventoryRead> {
  return listTaskWorkspaces()
    .then((instances): InventoryRead => ({ instances, unavailable: false }))
    .catch(inventoryUnavailable);
}

type MutationOutcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

// The wire call as an outcome rather than a throw, so the envelope can decrement the in-flight
// count once, on the one path both results share, instead of in two branches that can drift.
async function runMutation(action: () => Promise<unknown>): Promise<MutationOutcome> {
  try {
    await action();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function messageFor(error: unknown, t: I18nTranslate): string {
  // The restore-verification sentinel is UI-authored text and must speak the operator's locale;
  // its Error message is only a non-localized safety net (review finding on #2841).
  if (error instanceof TaskWorkspaceRestoreVerificationError) {
    return t("workspace.binding.restoreVerificationFailed");
  }
  if (error instanceof TaskWorkspaceProvisionError) {
    return t("workspace.binding.provisionFailed");
  }
  if (error instanceof TaskWorkspaceRepairOperatorRequiredError) {
    return t("workspace.binding.repairOperatorRequired");
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
  const operationSeqRef = useRef(0);
  const mutationSeqRef = useRef(0);
  // How many mutations have reached the server and not yet answered. Zero at the moment one
  // answers means that mutation is the last applied request of the burst — the one whose effect
  // the server ends on, and therefore the one that owns the authoritative re-read.
  const inFlightMutationsRef = useRef(0);
  // The workspace identity whose restore verification this session holds — NOT a per-session "has
  // verified once" flag. Restore-time verification exists for the case where a pointer is claimed
  // without runtime start authority (release-audit F-09b), and `switchTo` routes through the same
  // `reload`, so a session-wide latch would let every workspace activated after the first claim its
  // binding unverified (`setActiveTaskWorkspace` does not reconcile). Keying on the identity keeps
  // repeated reloads of the SAME workspace off the heavy git/filesystem pass (#2841 review) while
  // every newly activated binding is verified before a surface claims it.
  const verifiedWorkspaceIdRef = useRef<string | null>(null);

  // Re-reads the active binding plus the inventory, committing both in one settle. An inventory
  // failure never hides the active binding — the list degrades to empty (and leaves a diagnostic).
  // Every active view whose workspace identity this session has not already verified is RE-VERIFIED
  // through the shared reconciliation sequence before it is claimed (release-audit F-09b): neither a
  // persisted nor a freshly activated pointer is runtime start authority by itself, so a binding that
  // fails re-verification surfaces as an error instead of a ready-looking workspace. Reloads of an
  // already-verified identity read state without re-running the pass.
  const reload = useCallback(async (operationSeq: number, mode: ReloadMode): Promise<void> => {
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
    const active = await readActive();
    // A superseded operation stops here: its inventory would be discarded anyway.
    if (operationSeqRef.current !== operationSeq) return;
    // The inventory is EVERY managed workspace, not the selected folder's: the active pointer is
    // global, so a switch may target any repository, and a workspace paused in one repository
    // must stay resumable from this panel whatever folder is selected. Scoping the list to the
    // folder left the panel saying "no managed task workspaces yet" right under a bound or
    // just-paused workspace whenever the two differed (observed live, 2026-09-03).
    const inventory = await readInventory();
    if (operationSeqRef.current !== operationSeq) return;
    dispatch({
      kind: mode,
      instances: inventory.instances,
      inventoryUnavailable: inventory.unavailable,
      active,
    });
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    const operationSeq = (operationSeqRef.current += 1);
    dispatch({ kind: "load-start" });
    try {
      await reload(operationSeq, "settle");
      return operationSeqRef.current === operationSeq;
    } catch (error) {
      if (operationSeqRef.current !== operationSeq) return false;
      dispatch({ kind: "fail", error: messageFor(error, t) });
      return false;
    }
  }, [reload, t]);

  // The post-mutation read, committed under its own operation sequence so a newer operation still
  // wins the state. A read that fails after an APPLIED mutation surfaces as the error without
  // denying that the mutation happened.
  const commitServerTruth = useCallback(
    async (mode: ReloadMode): Promise<void> => {
      const operationSeq = (operationSeqRef.current += 1);
      try {
        await reload(operationSeq, mode);
      } catch (error) {
        if (operationSeqRef.current === operationSeq) {
          dispatch({ kind: "fail", error: messageFor(error, t) });
        }
      }
    },
    [reload, t],
  );

  // Shared mutation envelope: guard with `switching`, run the wire call, then reload + commit
  // atomically. Surfaces keep the previous active root until reload lands (no mixed transient state).
  // A failure is dispatched as the redacted `error` and reported as `false`, never thrown — a caller
  // that must not proceed on a refused mutation reads the outcome (audit finding, 2026-09-03: the
  // folder switcher awaited `clearActive()` and could not observe that the clear had been refused).
  //
  // `false` means REFUSED — and only that. It used to also mean "a newer mutation or refresh
  // superseded this one's reload", two outcomes with opposite consequences collapsed into one
  // boolean: the server HAS applied a superseded mutation, so the folder switcher reported an
  // override clear as unreleasable and aborted the folder change on a quick double-click or a
  // concurrent workbench bind refresh (#3381 review). A superseded mutation resolves `true`; the
  // newer operation owns the state commit while any request is still executing, and the last one to
  // answer owns the final one. A reload that itself fails after an applied mutation surfaces as
  // `error` without denying that the mutation happened.
  const mutate = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      const mutationSeq = (mutationSeqRef.current += 1);
      const operationSeq = (operationSeqRef.current += 1);
      inFlightMutationsRef.current += 1;
      dispatch({ kind: "mutate-start" });
      const outcome = await runMutation(action);
      inFlightMutationsRef.current -= 1;
      if (!outcome.ok) {
        if (mutationSeqRef.current === mutationSeq && operationSeqRef.current === operationSeq) {
          dispatch({ kind: "fail", error: messageFor(outcome.error, t) });
        }
        return false;
      }
      // `mutationSeqRef` orders the CLIENT's commits; it cannot un-apply a request the server is
      // already executing. Two switches in flight settle in whatever order the server answers, so
      // the newest CLICK is not necessarily the newest server pointer: if ws-2 answers first and
      // reloads, and ws-1's POST lands last, the server is on ws-1 while the surface advertises
      // ws-2 — every bound surface then claims a root the runtime does not have (#3381 review).
      // The LAST applied request to settle therefore always re-reads, superseded or not, and that
      // read is what the surface ends on: the state converges on the server, never on click order.
      const superseded = mutationSeqRef.current !== mutationSeq;
      if (superseded && inFlightMutationsRef.current > 0) return true;
      await commitServerTruth(superseded ? "reconcile" : "settle");
      return true;
    },
    [commitServerTruth, t],
  );

  const switchTo = useCallback(
    (workspaceId: string): Promise<boolean> =>
      mutate(() => setActiveTaskWorkspace({ workspaceId, requestedBy: STUDIO_OPERATOR })),
    [mutate],
  );

  const clearActive = useCallback(
    (): Promise<boolean> => mutate(() => clearActiveTaskWorkspace()),
    [mutate],
  );

  const pause = useCallback(
    (workspaceId: string): Promise<boolean> =>
      mutate(() => pauseTaskWorkspace({ workspaceId, requestedBy: STUDIO_OPERATOR })),
    [mutate],
  );

  const resume = useCallback(
    (workspaceId: string): Promise<boolean> =>
      mutate(() => resumeTaskWorkspace({ workspaceId, requestedBy: STUDIO_OPERATOR })),
    [mutate],
  );

  const prepareHandoff = useCallback(
    (workspaceId: string): Promise<boolean> =>
      mutate(() => prepareHandoffTaskWorkspace({ workspaceId, requestedBy: STUDIO_OPERATOR })),
    [mutate],
  );

  // A repair that the server answers with `applied: false` is a successful, audited no-mutation
  // outcome on the wire ("operator-required"), but for the surface it is the same as any other
  // refusal: the row is unchanged and the operator has to act, so it is surfaced as an error.
  const repair = useCallback(
    (workspaceId: string, strategy: WorkspaceRecoveryStrategy): Promise<boolean> =>
      mutate(async () => {
        const result = await repairTaskWorkspace({
          workspaceId,
          requestedBy: STUDIO_OPERATOR,
          strategy,
          operatorApproved: true,
        });
        if (!result.applied) throw new TaskWorkspaceRepairOperatorRequiredError();
      }),
    [mutate],
  );

  const provision = useCallback(
    (input: { root: string; taskId: string; baseBranch: string }): Promise<boolean> =>
      mutate(async () => {
        const result = await bindVerifiedTaskWorkspace({
          ...input,
          requestedBy: STUDIO_OPERATOR,
        });
        if (!result.ok) throw new TaskWorkspaceProvisionError();
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
      inventoryUnavailable: state.inventoryUnavailable,
      refresh,
      switchTo,
      clearActive,
      pause,
      resume,
      prepareHandoff,
      repair,
      provision,
    }),
    [
      state.instances,
      state.loading,
      state.switching,
      state.error,
      state.inventoryUnavailable,
      activeBinding,
      activeInstance,
      refresh,
      switchTo,
      clearActive,
      pause,
      resume,
      prepareHandoff,
      repair,
      provision,
    ],
  );
}
