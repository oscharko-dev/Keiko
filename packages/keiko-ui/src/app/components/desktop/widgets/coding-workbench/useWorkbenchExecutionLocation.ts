"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { ApiError, fetchGitStatus, fetchProjects } from "@/lib/api";
import { selectFolderWorkspace, selectLocalCheckout } from "@/lib/task-workspace-api";
import { bindVerifiedTaskWorkspace } from "@/lib/verified-task-workspace-binding";
import { secureRandomId } from "@/lib/secure-random";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind, newClientCorrelationId } from "@/lib/http";
import { codingWorkbenchSetupTaskId } from "./CodingWorkbenchSetup";
import type { WorkbenchExecutionLocation } from "./CodingWorkbenchRepositorySelector";
import { locallyAvailable } from "./codingWorkbenchRepositoryAvailability";

const OPERATOR = "studio-operator";

export function activeExecutionLocation(
  instance: WorkspaceInstance | null,
  root: string | null,
  selected: WorkbenchExecutionLocation | undefined,
  offered?: readonly WorkbenchExecutionLocation[],
): WorkbenchExecutionLocation {
  return offeredExecutionLocation(preferredExecutionLocation(instance, root, selected), offered);
}

function preferredExecutionLocation(
  instance: WorkspaceInstance | null,
  root: string | null,
  selected: WorkbenchExecutionLocation | undefined,
): WorkbenchExecutionLocation {
  if (selected !== undefined) return selected;
  if (instance?.repositoryRoot === root)
    return instance.executionLocation === "local" ? "local" : "worktree";
  return "local";
}

/**
 * #4068: the location a runtime can confine wins over any preference. Behind the Windows broker the
 * runtime confines only a Keiko-managed worktree, so a saved or default `local` becomes `worktree`
 * rather than binding a checkout the server would refuse. Absent, every location is offered.
 */
function offeredExecutionLocation(
  location: WorkbenchExecutionLocation,
  offered: readonly WorkbenchExecutionLocation[] | undefined,
): WorkbenchExecutionLocation {
  if (offered === undefined || offered.includes(location)) return location;
  return offered[0] ?? location;
}

function bindingReady(
  instance: WorkspaceInstance | null,
  root: string | null,
  branch: string | undefined,
  location: WorkbenchExecutionLocation,
  folderMode: boolean,
): boolean {
  if (instance === null || root === null || instance.repositoryRoot !== root) return false;
  // An ordinary folder is bound in place as a folder workspace, and only as one (owner decision
  // 2026-10-30); a repository is never ready through a folder binding.
  if (folderMode) return instance.workspaceKind === "folder";
  if (instance.workspaceKind === "folder") return false;
  return location === "local" ? checkoutReady(instance, branch) : worktreeReady(instance, branch);
}

function checkoutReady(instance: WorkspaceInstance, branch: string | undefined): boolean {
  return (
    instance.executionLocation === "local" &&
    (branch === undefined || instance.taskBranch === branch)
  );
}

function worktreeReady(instance: WorkspaceInstance, branch: string | undefined): boolean {
  return (
    instance.executionLocation !== "local" &&
    (branch === undefined || instance.baseBranch === branch)
  );
}

async function targetBranch(
  root: string,
  selected: string | undefined,
  correlationId: string,
): Promise<string> {
  if (selected !== undefined) return selected;
  const status = await fetchGitStatus(root, { correlationId });
  if (!status.available || status.branch === undefined || status.detached) {
    throw new Error("CHECKOUT_BRANCH_UNAVAILABLE");
  }
  return status.branch;
}

async function bindWorktree(root: string, branch: string, correlationId: string): Promise<void> {
  const taskId = codingWorkbenchSetupTaskId(branch);
  const input = { root, baseBranch: branch, taskId, requestedBy: OPERATOR, correlationId };
  let result = await bindVerifiedTaskWorkspace(input);
  if (!result.ok && result.stage === "provision" && result.code === "BRANCH_CONFLICT") {
    result = await bindVerifiedTaskWorkspace({
      ...input,
      taskId: `${taskId.slice(0, 80)}-${secureRandomId("task").slice(0, 8)}`,
    });
  }
  if (!result.ok) throw new Error(`WORKTREE_BIND_${result.stage}`);
}

export interface WorkbenchExecutionLocationState {
  readonly ready: boolean;
  readonly pending: boolean;
  readonly error: boolean;
  /**
   * The checkout failed because the server refused the folder as an access decision (the closed
   * `DENIED` reason), not because of a branch or a failed bind. The cause is known, so the notice
   * does not guess another one (#4371).
   */
  readonly denied: boolean;
  /**
   * The cause the server named for a failed checkout, when its closed code has exactly one plain
   * explanation; absent for every other failure, which keeps the generic sentence (#4404).
   */
  readonly reason?: LocationFailureReason;
  readonly retry: () => void;
}

/** A failed checkout whose closed server code tells the person what to do. */
export type LocationFailureReason = "unregistered" | "git-unreadable";

const LOCATION_FAILURE_REASONS: Readonly<Record<string, LocationFailureReason>> = {
  // The folder is no longer among the registered folders under its real path.
  MISSING_REPOSITORY: "unregistered",
  // Git could not be run for the checkout, or did not report the selected folder as the
  // repository's top folder: the two answers the server gives under this code.
  REPOSITORY_UNREACHABLE: "git-unreadable",
};

function locationFailureReason(error: unknown): LocationFailureReason | undefined {
  return error instanceof ApiError ? LOCATION_FAILURE_REASONS[error.code] : undefined;
}

interface LocationInput {
  readonly root: string | null;
  readonly branch: string | undefined;
  readonly location: WorkbenchExecutionLocation;
  /** The root is an ordinary folder (not a Git repository): bound in place, without a branch. */
  readonly folderMode: boolean;
  readonly activeInstance: WorkspaceInstance | null;
  readonly branchLoading: boolean;
  readonly branchError: boolean;
  /** The branch read was refused as an access decision. */
  readonly branchDenied: boolean;
  readonly workspaceLoading: boolean;
  readonly workspaceError: boolean;
  readonly runIsActive: boolean;
  /**
   * The runtime has not yet said which work locations it can confine (#4068). Until it does, no
   * location is known to be safe: nothing is bound and the selection stays pending.
   */
  readonly locationsPending?: boolean | undefined;
  readonly refresh: () => Promise<boolean>;
}

function useStableLocationInput(input: LocationInput): LocationInput {
  const {
    root,
    branch,
    location,
    folderMode,
    activeInstance,
    branchLoading,
    branchError,
    branchDenied,
    workspaceLoading,
    workspaceError,
    runIsActive,
    locationsPending,
    refresh,
  } = input;
  return useMemo(
    () => ({
      root,
      branch,
      location,
      folderMode,
      activeInstance,
      branchLoading,
      branchError,
      branchDenied,
      workspaceLoading,
      workspaceError,
      runIsActive,
      locationsPending,
      refresh,
    }),
    [
      root,
      branch,
      location,
      folderMode,
      activeInstance,
      branchLoading,
      branchError,
      branchDenied,
      workspaceLoading,
      workspaceError,
      runIsActive,
      locationsPending,
      refresh,
    ],
  );
}

function selectionChanged(previous: LocationInput, current: LocationInput): boolean {
  return (
    current.root !== previous.root ||
    current.branch !== previous.branch ||
    current.location !== previous.location ||
    current.folderMode !== previous.folderMode
  );
}

function shouldBind(
  input: LocationInput,
  ready: boolean,
  errorKey: string | null,
  key: string,
): boolean {
  return (
    !ready &&
    input.locationsPending !== true &&
    !input.branchLoading &&
    !input.branchError &&
    !input.workspaceLoading &&
    !input.workspaceError &&
    !input.runIsActive &&
    input.root !== null &&
    errorKey !== key
  );
}

function selectionNeedsBinding(previous: LocationInput, current: LocationInput): boolean {
  return (
    !selectionChanged(previous, current) &&
    current.locationsPending !== true &&
    !current.branchLoading &&
    !current.branchError &&
    !current.workspaceLoading &&
    !current.workspaceError &&
    !current.runIsActive &&
    !bindingReady(
      current.activeInstance,
      current.root,
      current.branch,
      current.location,
      current.folderMode,
    )
  );
}

function reportBindingFailure(error: unknown, attemptCorrelationId: string): void {
  const correlationId = correlationIdOf(error) ?? attemptCorrelationId;
  reportClientDiagnostic("[keiko] coding workbench checkout selection failed", {
    kind: "other",
    errorKind: bffRequestErrorKind(error),
    errorEvidence: clientErrorEvidence(error),
    correlationId,
  });
}

interface BindingAttempt {
  readonly input: LocationInput;
  readonly key: string;
  readonly latest: RefObject<LocationInput>;
  readonly inFlight: RefObject<string | null>;
  readonly setPending: Dispatch<SetStateAction<boolean>>;
  readonly setErrorKey: Dispatch<SetStateAction<string | null>>;
  readonly setErrorReason: Dispatch<SetStateAction<LocationFailureReason | undefined>>;
  readonly setSelectionEpoch: Dispatch<SetStateAction<number>>;
}

async function runBindingAttempt(attempt: BindingAttempt): Promise<void> {
  const { input, key, latest, inFlight, setPending, setErrorKey, setSelectionEpoch } = attempt;
  const { setErrorReason } = attempt;
  if (input.root === null) return;
  const correlationId = newClientCorrelationId();
  try {
    // A folder has no branch to resolve: it is bound in place as it is.
    const branch = input.folderMode
      ? ""
      : await targetBranch(input.root, input.branch, correlationId);
    if (!selectionNeedsBinding(input, latest.current)) {
      reportClientDiagnostic("[keiko] coding workbench checkout selection superseded", {
        correlationId,
        gitClientOperation: { operation: "checkout-selection", outcome: "discarded-succeeded" },
      });
      return;
    }
    if (input.folderMode) {
      await selectFolderWorkspace({ root: input.root, requestedBy: OPERATOR, correlationId });
    } else if (input.location === "local") {
      await selectLocalCheckout({
        root: input.root,
        branch,
        requestedBy: OPERATOR,
        correlationId,
      });
    } else {
      await bindWorktree(input.root, branch, correlationId);
    }
    if (!(await input.refresh())) throw new Error("WORKSPACE_REFRESH_UNAVAILABLE");
    setErrorKey(null);
  } catch (error) {
    reportBindingFailure(error, correlationId);
    setErrorReason(locationFailureReason(error));
    setErrorKey(key);
  } finally {
    inFlight.current = null;
    setPending(false);
    if (selectionChanged(input, latest.current)) setSelectionEpoch((epoch) => epoch + 1);
  }
}

interface BindingAttemptState {
  readonly pending: boolean;
  readonly errorKey: string | null;
  readonly errorReason: LocationFailureReason | undefined;
  readonly handledKey: string | null;
  readonly retry: () => void;
}

function useBindingAttempt(input: LocationInput, ready: boolean, key: string): BindingAttemptState {
  const stableInput = useStableLocationInput(input);
  const [pending, setPending] = useState(false);
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  const [handledKey, setHandledKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [errorReason, setErrorReason] = useState<LocationFailureReason | undefined>(undefined);
  const inFlight = useRef<string | null>(null);
  const latest = useRef(stableInput);
  useLayoutEffect(() => {
    latest.current = stableInput;
  }, [stableInput]);
  const { refresh, workspaceError, branchError } = input;
  useEffect(() => {
    if (ready) {
      setHandledKey(key);
      return;
    }
    if (
      handledKey === key ||
      !shouldBind(stableInput, ready, errorKey, key) ||
      inFlight.current !== null
    )
      return;
    setHandledKey(key);
    inFlight.current = key;
    setPending(true);
    void runBindingAttempt({
      input: stableInput,
      key,
      latest,
      inFlight,
      setPending,
      setErrorKey,
      setErrorReason,
      setSelectionEpoch,
    });
  }, [errorKey, handledKey, stableInput, key, ready, selectionEpoch]);
  const retry = useCallback((): void => {
    setHandledKey(null);
    setErrorKey(null);
    setSelectionEpoch((epoch) => epoch + 1);
    if (workspaceError || branchError) void refresh();
  }, [refresh, workspaceError, branchError]);
  return { pending, errorKey, errorReason, handledKey, retry };
}

function bindingError(
  input: LocationInput,
  ready: boolean,
  pending: boolean,
  key: string,
  attempt: BindingAttemptState,
): boolean {
  return (
    attempt.errorKey === key ||
    input.workspaceError ||
    (!ready && !pending && (input.branchError || attempt.handledKey === key))
  );
}

/** The named cause of THIS selection's failed attempt; a reason of an earlier selection is not. */
function failureReason(
  attempt: BindingAttemptState,
  key: string,
): { readonly reason?: LocationFailureReason } {
  const reason = attempt.errorKey === key ? attempt.errorReason : undefined;
  return reason === undefined ? {} : { reason };
}

/** A failure is a refusal only when the server named the folder's branch read as one. */
function bindingDenied(error: boolean, input: LocationInput): boolean {
  return error && input.branchDenied;
}

/**
 * Whether the registered folder lost its workspace while the held binding still names it. Read on
 * every selection and whenever the window regains focus; a failed read changes nothing, so the
 * binding the person already has keeps working.
 */
function useUnboundSelection(root: string | null): {
  readonly unbound: boolean;
  readonly recheck: () => Promise<void>;
} {
  const [unbound, setUnbound] = useState(false);
  const selected = useRef(root);
  useLayoutEffect(() => {
    selected.current = root;
  }, [root]);
  const recheck = useCallback(async (): Promise<void> => {
    const at = selected.current;
    if (at === null) {
      setUnbound(false);
      return;
    }
    try {
      const { projects } = await fetchProjects();
      const project = projects.find((entry) => entry.path === at);
      if (selected.current === at) setUnbound(project !== undefined && !locallyAvailable(project));
    } catch (error) {
      reportClientDiagnostic("[keiko] coding workbench repository availability read failed", {
        kind: "other",
        errorKind: bffRequestErrorKind(error),
        correlationId: correlationIdOf(error) ?? newClientCorrelationId(),
      });
    }
  }, []);
  useEffect(() => {
    void recheck();
    const onFocus = (): void => void recheck();
    window.addEventListener("focus", onFocus);
    return (): void => {
      window.removeEventListener("focus", onFocus);
    };
  }, [root, recheck]);
  return { unbound, recheck };
}

function selectionReady(input: LocationInput): boolean {
  return (
    input.locationsPending !== true &&
    !input.workspaceLoading &&
    !input.workspaceError &&
    bindingReady(input.activeInstance, input.root, input.branch, input.location, input.folderMode)
  );
}

export function useWorkbenchExecutionLocation(
  rawInput: LocationInput,
): WorkbenchExecutionLocationState {
  const { unbound, recheck } = useUnboundSelection(rawInput.root);
  const { refresh: refreshWorkspace } = rawInput;
  // A bind is confirmed by the folder's own availability, read before the attempt settles, so a
  // successful bind never shows the stale selection's error in between.
  const refresh = useCallback(async (): Promise<boolean> => {
    const refreshed = await refreshWorkspace();
    await recheck();
    return refreshed;
  }, [refreshWorkspace, recheck]);
  // A held binding the folder no longer backs is stale: it counts as no binding at all.
  const input = { ...rawInput, activeInstance: unbound ? null : rawInput.activeInstance, refresh };
  const key = `${input.root ?? ""}\0${input.branch ?? ""}\0${input.location}\0${String(input.folderMode)}\0${String(unbound)}`;
  const ready = selectionReady(input);
  const attempt = useBindingAttempt(input, ready, key);
  const pending =
    attempt.pending ||
    input.locationsPending === true ||
    input.workspaceLoading ||
    (!ready && input.branchLoading);
  const error = bindingError(input, ready, pending, key, attempt);
  return {
    ready,
    pending,
    error,
    denied: bindingDenied(error, input),
    ...failureReason(attempt, key),
    retry: attempt.retry,
  };
}
