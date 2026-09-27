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
import { fetchGitStatus } from "@/lib/api";
import { selectLocalCheckout } from "@/lib/task-workspace-api";
import { bindVerifiedTaskWorkspace } from "@/lib/verified-task-workspace-binding";
import { secureRandomId } from "@/lib/secure-random";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind } from "@/lib/http";
import { codingWorkbenchSetupTaskId } from "./CodingWorkbenchSetup";
import type { WorkbenchExecutionLocation } from "./CodingWorkbenchRepositorySelector";

const OPERATOR = "studio-operator";

export function activeExecutionLocation(
  instance: WorkspaceInstance | null,
  root: string | null,
  selected: WorkbenchExecutionLocation | undefined,
): WorkbenchExecutionLocation {
  if (selected !== undefined) return selected;
  if (instance?.repositoryRoot === root)
    return instance.executionLocation === "local" ? "local" : "worktree";
  return "local";
}

function bindingReady(
  instance: WorkspaceInstance | null,
  root: string | null,
  branch: string | undefined,
  location: WorkbenchExecutionLocation,
): boolean {
  if (instance === null || root === null || instance.repositoryRoot !== root) return false;
  if (location === "local") {
    return (
      instance.executionLocation === "local" &&
      (branch === undefined || instance.taskBranch === branch)
    );
  }
  return (
    instance.executionLocation !== "local" &&
    (branch === undefined || instance.baseBranch === branch)
  );
}

async function targetBranch(root: string, selected: string | undefined): Promise<string> {
  if (selected !== undefined) return selected;
  const status = await fetchGitStatus(root);
  if (!status.available || status.branch === undefined || status.detached) {
    throw new Error("CHECKOUT_BRANCH_UNAVAILABLE");
  }
  return status.branch;
}

async function bindWorktree(root: string, branch: string): Promise<void> {
  const taskId = codingWorkbenchSetupTaskId(branch);
  const input = { root, baseBranch: branch, taskId, requestedBy: OPERATOR };
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
  readonly retry: () => void;
}

interface LocationInput {
  readonly root: string | null;
  readonly branch: string | undefined;
  readonly location: WorkbenchExecutionLocation;
  readonly activeInstance: WorkspaceInstance | null;
  readonly workspaceLoading: boolean;
  readonly workspaceError: boolean;
  readonly runIsActive: boolean;
  readonly refresh: () => Promise<boolean>;
}

function useStableLocationInput(input: LocationInput): LocationInput {
  const {
    root,
    branch,
    location,
    activeInstance,
    workspaceLoading,
    workspaceError,
    runIsActive,
    refresh,
  } = input;
  return useMemo(
    () => ({
      root,
      branch,
      location,
      activeInstance,
      workspaceLoading,
      workspaceError,
      runIsActive,
      refresh,
    }),
    [
      root,
      branch,
      location,
      activeInstance,
      workspaceLoading,
      workspaceError,
      runIsActive,
      refresh,
    ],
  );
}

function selectionChanged(previous: LocationInput, current: LocationInput): boolean {
  return (
    current.root !== previous.root ||
    current.branch !== previous.branch ||
    current.location !== previous.location
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
    !current.workspaceLoading &&
    !current.workspaceError &&
    !current.runIsActive &&
    !bindingReady(current.activeInstance, current.root, current.branch, current.location)
  );
}

function reportBindingFailure(error: unknown): void {
  const correlationId = correlationIdOf(error);
  reportClientDiagnostic("[keiko] coding workbench checkout selection failed", {
    kind: "other",
    errorKind: bffRequestErrorKind(error),
    errorEvidence: clientErrorEvidence(error),
    ...(correlationId === undefined ? {} : { correlationId }),
  });
}

interface BindingAttempt {
  readonly input: LocationInput;
  readonly key: string;
  readonly latest: RefObject<LocationInput>;
  readonly inFlight: RefObject<string | null>;
  readonly setPending: Dispatch<SetStateAction<boolean>>;
  readonly setErrorKey: Dispatch<SetStateAction<string | null>>;
  readonly setSelectionEpoch: Dispatch<SetStateAction<number>>;
}

async function runBindingAttempt(attempt: BindingAttempt): Promise<void> {
  const { input, key, latest, inFlight, setPending, setErrorKey, setSelectionEpoch } = attempt;
  if (input.root === null) return;
  try {
    const branch = await targetBranch(input.root, input.branch);
    if (!selectionNeedsBinding(input, latest.current)) return;
    if (input.location === "local") {
      await selectLocalCheckout({ root: input.root, branch, requestedBy: OPERATOR });
    } else {
      await bindWorktree(input.root, branch);
    }
    if (!(await input.refresh())) throw new Error("WORKSPACE_REFRESH_UNAVAILABLE");
    setErrorKey(null);
  } catch (error) {
    reportBindingFailure(error);
    setErrorKey(key);
  } finally {
    inFlight.current = null;
    setPending(false);
    if (selectionChanged(input, latest.current)) setSelectionEpoch((epoch) => epoch + 1);
  }
}

function useBindingAttempt(
  input: LocationInput,
  ready: boolean,
  key: string,
): {
  readonly pending: boolean;
  readonly errorKey: string | null;
  readonly retry: () => void;
} {
  const stableInput = useStableLocationInput(input);
  const [pending, setPending] = useState(false);
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const inFlight = useRef<string | null>(null);
  const latest = useRef(stableInput);
  useLayoutEffect(() => {
    latest.current = stableInput;
  }, [stableInput]);
  const { refresh, workspaceError } = input;
  useEffect(() => {
    if (!shouldBind(stableInput, ready, errorKey, key) || inFlight.current !== null) return;
    inFlight.current = key;
    setPending(true);
    void runBindingAttempt({
      input: stableInput,
      key,
      latest,
      inFlight,
      setPending,
      setErrorKey,
      setSelectionEpoch,
    });
  }, [errorKey, stableInput, key, ready, selectionEpoch]);
  const retry = useCallback((): void => {
    setErrorKey(null);
    if (workspaceError) void refresh();
  }, [refresh, workspaceError]);
  return { pending, errorKey, retry };
}

export function useWorkbenchExecutionLocation(
  input: LocationInput,
): WorkbenchExecutionLocationState {
  const key = `${input.root ?? ""}\0${input.branch ?? ""}\0${input.location}`;
  const ready =
    !input.workspaceLoading &&
    !input.workspaceError &&
    bindingReady(input.activeInstance, input.root, input.branch, input.location);
  const { pending, errorKey, retry } = useBindingAttempt(input, ready, key);
  return {
    ready,
    pending: pending || input.workspaceLoading,
    error: errorKey === key || input.workspaceError,
    retry,
  };
}
