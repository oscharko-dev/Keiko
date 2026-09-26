"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { CodingHistoryDetail } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type { ActiveWorkspaceApi } from "../../context/ActiveWorkspaceContext";
import {
  CODING_HISTORY_CHANGED,
  fetchCodingTask,
  updateCodingTask,
} from "@/lib/coding-history-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import { secureRandomId } from "@/lib/secure-random";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import type { ClientDiagnosticCodingHistoryScope } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";

export interface CodingTaskSession {
  readonly detail: CodingHistoryDetail | null;
  readonly conversationId: string | undefined;
  readonly visibleRun: boolean;
  readonly pending: boolean;
  readonly error: boolean;
  readonly newTask: () => Promise<void>;
  readonly finish: () => Promise<void>;
}

interface SessionInput {
  readonly snapshot: CodingWorkbenchRuntimeSnapshot | null;
  readonly active: boolean;
  readonly workspace: ActiveWorkspaceApi | null;
  readonly root: string | undefined;
  readonly selection: string | undefined;
  readonly onSelectionHandled?: (() => void) | undefined;
}

function reportFailure(error: unknown): void {
  reportClientDiagnostic(`[keiko] coding task session failed: ${clientErrorSummary(error)}`, {
    correlationId: correlationIdOf(error),
  });
}

interface TaskLoader {
  readonly detail: CodingHistoryDetail | null;
  readonly setDetail: Dispatch<SetStateAction<CodingHistoryDetail | null>>;
  readonly pending: boolean;
  readonly setPending: (value: boolean) => void;
  readonly error: boolean;
  readonly setError: (value: boolean) => void;
  readonly sequence: { current: number };
  readonly load: (id: string, activate: boolean) => Promise<void>;
}

export function useCodingTaskSession(options: SessionInput): CodingTaskSession {
  const input = {
    ...options,
    root: options.workspace?.activeInstance?.repositoryRoot ?? options.root,
  };
  const ignoredRun = useRef<string | undefined>(undefined);
  const latest = useRef(input);
  latest.current = input;
  const controller = useTaskLoader(latest);
  const { detail, pending, setPending, error, setError, load } = controller;
  const newTask = useNewTask(latest, ignoredRun, controller);
  useSessionSelection(input, load, newTask, ignoredRun);
  const finish = async (): Promise<void> => {
    if (input.active || detail === null) return;
    setPending(true);
    try {
      await updateCodingTask(detail.task.id, { status: "completed" });
      await newTask();
    } catch (cause) {
      reportFailure(cause);
      setError(true);
    } finally {
      setPending(false);
    }
  };
  const scoped = detail !== null && taskScopeMatches(detail, input, false) ? detail : null;
  return {
    detail: scoped,
    conversationId: scoped?.task.id,
    pending,
    error,
    newTask,
    finish,
    visibleRun: sessionRunVisible(input, scoped, ignoredRun.current),
  };
}

function sessionRunVisible(
  input: SessionInput,
  detail: CodingHistoryDetail | null,
  ignoredRun: string | undefined,
): boolean {
  if (input.active || input.snapshot?.state === "recovery-required") return true;
  return (
    detail !== null &&
    input.snapshot?.conversationId === detail.task.id &&
    ignoredRun !== input.snapshot.runId
  );
}

function taskScopeMatches(
  detail: CodingHistoryDetail,
  input: SessionInput,
  activate: boolean,
): boolean {
  const activeWorkspaceId = input.workspace?.activeInstance?.workspaceId;
  return (
    activate ||
    ((input.root === undefined || detail.task.projectPath === input.root) &&
      (activeWorkspaceId === undefined || detail.task.workspaceId === activeWorkspaceId))
  );
}

function useTaskLoader(latest: { current: SessionInput }): TaskLoader {
  const [detail, setDetail] = useState<CodingHistoryDetail | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const sequence = useRef(0);
  const scopeRevision = useHistoryScope(latest, detail, setDetail, sequence);
  const load = useCallback(
    async (id: string, activate: boolean): Promise<void> => {
      const seq = ++sequence.current;
      const operation = historyLoad(id, scopeRevision.current.scope);
      setPending(true);
      setError(false);
      try {
        const result = await fetchCodingTask(id, operation.correlationId);
        if (seq !== sequence.current) return;
        if (historyLoadCancelled(operation, scopeRevision.current.scope)) return;
        const activated = await activateHistoryTask(
          result,
          latest,
          activate,
          operation,
          scopeRevision.current.scope,
        );
        if (seq !== sequence.current) return;
        if (activationSuperseded(result, latest.current, operation, scopeRevision.current.scope))
          return;
        if (!activated) {
          setDetail(null);
          return;
        }
        scopeRevision.current.accepted = operation;
        setDetail(result);
      } catch (cause) {
        if (seq !== sequence.current) return;
        if (operation.scope.id !== scopeRevision.current.scope.id)
          reportScopeChange(operation, scopeRevision.current.scope, "activation-cancelled");
        else {
          reportFailure(cause);
          setError(true);
        }
      } finally {
        if (seq === sequence.current) setPending(false);
      }
    },
    [latest, scopeRevision],
  );
  return { detail, setDetail, pending, setPending, error, setError, load, sequence };
}

function historyLoad(taskId: string, scope: HistoryScope): HistoryLoad {
  return { correlationId: newClientCorrelationId(), taskId, scope };
}

function historyLoadCancelled(operation: HistoryLoad, current: HistoryScope): boolean {
  if (operation.scope.id === current.id) return false;
  reportScopeChange(operation, current, "activation-cancelled");
  return true;
}

function activationSuperseded(
  result: CodingHistoryDetail,
  input: SessionInput,
  operation: HistoryLoad,
  currentScope: HistoryScope,
): boolean {
  const acknowledged =
    input.workspace?.activeInstance?.workspaceId === result.task.workspaceId &&
    input.root === result.task.projectPath;
  if (operation.scope.id === currentScope.id || acknowledged) return false;
  reportScopeChange(operation, currentScope, "activation-superseded", result.task.workspaceId);
  return true;
}

async function activateHistoryTask(
  result: CodingHistoryDetail,
  latest: { current: SessionInput },
  activate: boolean,
  operation: HistoryLoad,
  currentScope: HistoryScope,
): Promise<boolean> {
  if (!taskScopeMatches(result, latest.current, activate)) {
    reportScopeChange(
      operation,
      currentScope,
      result.task.projectPath !== latest.current.root
        ? "repository-mismatch"
        : "workspace-mismatch",
      result.task.workspaceId,
    );
    return false;
  }
  if (activate && !(await latest.current.workspace?.switchTo(result.task.workspaceId)))
    throw new Error("Workspace unavailable");
  return true;
}

interface HistoryScope {
  readonly id: string;
  readonly root: string | undefined;
  readonly workspaceId: string | undefined;
}
interface HistoryLoad {
  readonly correlationId: string;
  readonly taskId: string;
  readonly scope: HistoryScope;
}
interface HistoryScopeState {
  scope: HistoryScope;
  accepted?: HistoryLoad;
}

function reportScopeChange(
  operation: HistoryLoad,
  current: HistoryScope,
  reason: ClientDiagnosticCodingHistoryScope["reason"],
  targetWorkspaceId?: string,
): void {
  reportClientDiagnostic("[keiko] coding task history scope outcome", {
    correlationId: operation.correlationId,
    codingHistoryScope: {
      reason,
      taskId: operation.taskId,
      requestedScopeId: operation.scope.id,
      currentScopeId: current.id,
      requestedWorkspaceId: operation.scope.workspaceId,
      currentWorkspaceId: current.workspaceId,
      targetWorkspaceId,
    },
  });
}

function useHistoryScope(
  latest: { current: SessionInput },
  detail: CodingHistoryDetail | null,
  setDetail: TaskLoader["setDetail"],
  sequence: TaskLoader["sequence"],
): { current: HistoryScopeState } {
  const root = latest.current.root;
  const workspaceId = latest.current.workspace?.activeInstance?.workspaceId;
  const tracker = useRef<HistoryScopeState>({
    scope: { id: secureRandomId("history-scope"), root, workspaceId },
  });
  if (tracker.current.scope.root !== root || tracker.current.scope.workspaceId !== workspaceId)
    tracker.current.scope = { id: secureRandomId("history-scope"), root, workspaceId };
  useEffect(
    () => (): void => {
      sequence.current += 1;
    },
    [sequence],
  );
  const stored = useRef(detail);
  stored.current = detail;
  useEffect(() => {
    if (stored.current !== null && !taskScopeMatches(stored.current, latest.current, false)) {
      const accepted = tracker.current.accepted;
      if (accepted !== undefined)
        reportScopeChange(
          accepted,
          tracker.current.scope,
          "detail-cleared",
          stored.current.task.workspaceId,
        );
      setDetail(null);
    }
  }, [root, workspaceId, latest, setDetail]);
  return tracker;
}

function useNewTask(
  latest: { current: SessionInput },
  ignoredRun: { current: string | undefined },
  controller: TaskLoader,
): () => Promise<void> {
  const { sequence, setDetail, setError, setPending } = controller;
  const newTask = useCallback(async (): Promise<void> => {
    const current = latest.current;
    if (current.active) return;
    ignoredRun.current = current.snapshot?.runId;
    sequence.current += 1;
    setDetail(null);
    setError(false);
    setPending(true);
    try {
      const ok = await provisionNewTask(current);
      reportClientDiagnostic("[keiko] coding task new workspace requested");
      setError(!ok);
    } catch (cause) {
      reportFailure(cause);
      setError(true);
    } finally {
      setPending(false);
    }
  }, [latest, ignoredRun, sequence, setDetail, setError, setPending]);
  return newTask;
}

async function provisionNewTask(current: SessionInput): Promise<boolean | undefined> {
  const root = current.root ?? current.workspace?.activeInstance?.repositoryRoot;
  const baseBranch = current.workspace?.activeInstance?.baseBranch;
  return root !== undefined && baseBranch !== undefined
    ? await current.workspace?.provision({
        root,
        baseBranch,
        taskId: `coding-${secureRandomId("task")}`,
      })
    : await current.workspace?.clearActive();
}

function useSessionSelection(
  input: SessionInput,
  load: (id: string, activate: boolean) => Promise<void>,
  newTask: () => Promise<void>,
  ignoredRun: { current: string | undefined },
): void {
  const { selection, snapshot, active } = input;
  const activeWorkspaceId = input.workspace?.activeInstance?.workspaceId;
  const selectionHandled = useRef(input.onSelectionHandled);
  selectionHandled.current = input.onSelectionHandled;
  const lastSelection = useRef<string | undefined>(undefined);
  useEffect(() => {
    // #3631: the host consumes a selection by clearing it, so picking the same task again is a new
    // pick — a failed activation can be retried from Coding History without choosing another task.
    if (selection === undefined) {
      lastSelection.current = undefined;
      return;
    }
    if (lastSelection.current === selection || active) return;
    lastSelection.current = selection;
    selectionHandled.current?.();
    if (selection.startsWith("new:")) void newTask();
    else {
      ignoredRun.current = snapshot?.runId;
      void load(selection, true);
    }
  }, [selection, active, snapshot?.runId, load, newTask, ignoredRun]);
  useEffect(() => {
    const id = snapshot?.conversationId;
    if (id === undefined || snapshot?.runId === ignoredRun.current) return;
    void load(id, false);
    window.dispatchEvent(new Event(CODING_HISTORY_CHANGED));
  }, [
    snapshot?.conversationId,
    snapshot?.runId,
    snapshot?.state,
    activeWorkspaceId,
    load,
    ignoredRun,
  ]);
}
