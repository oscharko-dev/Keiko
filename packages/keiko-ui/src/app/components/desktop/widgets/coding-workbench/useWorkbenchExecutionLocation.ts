"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

export function useWorkbenchExecutionLocation(input: {
  readonly root: string | null;
  readonly branch: string | undefined;
  readonly location: WorkbenchExecutionLocation;
  readonly activeInstance: WorkspaceInstance | null;
  readonly workspaceLoading: boolean;
  readonly workspaceError: boolean;
  readonly runIsActive: boolean;
  readonly refresh: () => Promise<boolean>;
}): WorkbenchExecutionLocationState {
  const [pending, setPending] = useState(false);
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const inFlight = useRef<string | null>(null);
  const key = `${input.root ?? ""}\0${input.branch ?? ""}\0${input.location}`;
  const latest = useRef(input);
  latest.current = input;
  const ready =
    !input.workspaceLoading &&
    !input.workspaceError &&
    bindingReady(input.activeInstance, input.root, input.branch, input.location);
  useEffect(() => {
    if (
      ready ||
      input.workspaceLoading ||
      input.workspaceError ||
      input.runIsActive ||
      input.root === null ||
      inFlight.current !== null ||
      errorKey === key
    ) {
      return;
    }
    const root = input.root;
    inFlight.current = key;
    setPending(true);
    void (async (): Promise<void> => {
      try {
        const branch = await targetBranch(root, input.branch);
        const current = latest.current;
        if (
          current.root !== root ||
          current.branch !== input.branch ||
          current.location !== input.location ||
          current.workspaceLoading ||
          current.workspaceError ||
          current.runIsActive ||
          bindingReady(current.activeInstance, current.root, current.branch, current.location)
        )
          return;
        if (input.location === "local") {
          await selectLocalCheckout({ root, branch, requestedBy: OPERATOR });
        } else {
          await bindWorktree(root, branch);
        }
        if (!(await input.refresh())) throw new Error("WORKSPACE_REFRESH_UNAVAILABLE");
        setErrorKey(null);
      } catch (error) {
        const correlationId = correlationIdOf(error);
        reportClientDiagnostic("[keiko] coding workbench checkout selection failed", {
          kind: "other",
          errorKind: bffRequestErrorKind(error),
          errorEvidence: clientErrorEvidence(error),
          ...(correlationId === undefined ? {} : { correlationId }),
        });
        setErrorKey(key);
      } finally {
        inFlight.current = null;
        setPending(false);
        const current = latest.current;
        if (
          current.root !== input.root ||
          current.branch !== input.branch ||
          current.location !== input.location
        )
          setSelectionEpoch((epoch) => epoch + 1);
      }
    })();
  }, [
    errorKey,
    input.branch,
    input.location,
    input.refresh,
    input.root,
    input.runIsActive,
    input.workspaceError,
    input.workspaceLoading,
    key,
    ready,
    selectionEpoch,
  ]);
  const retry = useCallback((): void => {
    setErrorKey(null);
    if (input.workspaceError) void input.refresh();
  }, [input.refresh, input.workspaceError]);
  return {
    ready,
    pending: pending || input.workspaceLoading,
    error: errorKey === key || input.workspaceError,
    retry,
  };
}
