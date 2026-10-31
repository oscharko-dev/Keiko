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
import { taskWorkspaceProvisioningSource } from "@oscharko-dev/keiko-contracts/runtime/task-workspace";
import type { ActiveWorkspaceApi } from "../../context/ActiveWorkspaceContext";
import {
  CODING_HISTORY_CHANGED,
  fetchCodingTask,
  updateCodingTask,
} from "@/lib/coding-history-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { reportCodingWorkbenchInteraction } from "@/lib/coding-workbench-interaction";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import { secureRandomId } from "@/lib/secure-random";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import type { ClientDiagnosticCodingHistoryScope } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import type { WorkbenchExecutionLocation } from "./CodingWorkbenchRepositorySelector";

/** The task the person chose to fork, and where: just before a user message, or as it ended. */
export interface CodingTaskForkSource {
  readonly taskId: string;
  readonly title: string;
  readonly beforeMessageId?: string | undefined;
  /**
   * The managed workspace the fork continues in (#3903 AC4, #3902 AC3): one provisioned from the
   * task's own. Absent, the fork stays in the task's own workspace.
   */
  readonly targetWorkspace?: CodingTaskForkTarget | undefined;
  /**
   * The loaded task was imported from a saved file (#3904 AC4) and has no run of its own, so the
   * next message always continues it as a new task. Nobody asked for it, so nobody can cancel it.
   */
  readonly implicit?: true | undefined;
}

/** A managed workspace provisioned from the loaded task's own, where the task may continue. */
interface CodingTaskForkTarget {
  readonly workspaceId: string;
  /** The workspace's task name, as Task Workspaces shows it. */
  readonly name: string;
}

export interface CodingTaskSession {
  readonly detail: CodingHistoryDetail | null;
  readonly conversationId: string | undefined;
  readonly visibleRun: boolean;
  readonly pending: boolean;
  readonly error: boolean;
  readonly newTask: () => Promise<void>;
  readonly finish: () => Promise<void>;
  /**
   * The fork the person asked for (S03): the next start begins a new task from it instead of
   * continuing the loaded one. It ends with that start, a new task, another selection or a run.
   */
  readonly fork: CodingTaskForkSource | null;
  /** Forks the loaded task as it ended, or just before one of its user messages. */
  readonly beginFork: (beforeMessageId?: string) => void;
  readonly cancelFork: () => void;
  /** The workspaces provisioned from the loaded task's own, where it may continue as a fork. */
  readonly forkTargets: readonly CodingTaskForkTarget[];
  /** Switches to one of them and forks the loaded task there; nothing starts until the next message. */
  readonly continueIn: (target: CodingTaskForkTarget) => Promise<void>;
}

interface SessionInput {
  readonly snapshot: CodingWorkbenchRuntimeSnapshot | null;
  readonly active: boolean;
  readonly workspace: ActiveWorkspaceApi | null;
  readonly root: string | undefined;
  readonly location?: WorkbenchExecutionLocation;
  readonly selection: string | undefined;
  readonly onSelectionHandled?: (() => void) | undefined;
  readonly onDraftReset?: (() => void) | undefined;
  /** The workspace a pending fork continues in, while it is the active one. */
  readonly forkTarget?: string | undefined;
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
  const [forkTarget, setForkTarget] = useState<string | undefined>(undefined);
  const input = {
    ...options,
    root: options.root ?? options.workspace?.activeInstance?.repositoryRoot,
    forkTarget,
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
  const fork = useTaskFork(input, scoped, setForkTarget);
  return {
    detail: scoped,
    pending,
    error,
    newTask,
    finish,
    visibleRun: sessionRunVisible(input, scoped, ignoredRun.current),
    forkTargets: forkTargetsOf(input, scoped),
    ...fork,
    ...startPoint(scoped, input.active, fork.fork),
  };
}

/**
 * What the next message continues: the loaded task itself, or the fork the person asked for. An
 * imported task has no run to continue, so it is forked as it ended unless the person chose a
 * fork of their own.
 */
function startPoint(
  detail: CodingHistoryDetail | null,
  active: boolean,
  requested: CodingTaskForkSource | null,
): Pick<CodingTaskSession, "conversationId" | "fork"> {
  if (detail?.task.origin !== "imported")
    return { conversationId: detail?.task.id, fork: requested };
  const implicit = active
    ? null
    : { taskId: detail.task.id, title: detail.task.title, implicit: true as const };
  return { conversationId: undefined, fork: requested ?? implicit };
}

/** The managed workspaces provisioned from the task's own (#3903 AC4, #3902 AC3). */
function forkTargetsOf(
  input: SessionInput,
  detail: CodingHistoryDetail | null,
): readonly CodingTaskForkTarget[] {
  const instances = input.workspace?.instances ?? [];
  if (detail === null || input.forkTarget !== undefined) return [];
  return instances.flatMap((instance) =>
    taskWorkspaceProvisioningSource(instances, instance.workspaceId)?.workspaceId ===
    detail.task.workspaceId
      ? [{ workspaceId: instance.workspaceId, name: instance.taskId }]
      : [],
  );
}

interface PendingFork {
  readonly source: CodingTaskForkSource;
  /** The run on display when the person asked: a different one ends the request. */
  readonly runId: string | undefined;
}

/**
 * A fork is a standing request of the person, made against the task and the run on display. It ends
 * when either changes, when a run is active, and when the person cancels it; it is never inferred.
 */
function useTaskFork(
  input: SessionInput,
  detail: CodingHistoryDetail | null,
  setForkTarget: (workspaceId: string | undefined) => void,
): Pick<CodingTaskSession, "fork" | "beginFork" | "cancelFork" | "continueIn"> {
  const [pending, setPending] = useState<PendingFork | null>(null);
  const runId = input.snapshot?.runId;
  const taskId = detail?.task.id;
  useEffect(() => {
    if (pending === null) return;
    if (input.active || taskId !== pending.source.taskId || forkRunChanged(pending, runId)) {
      setPending(null);
      setForkTarget(undefined);
    }
  }, [pending, input.active, taskId, runId, setForkTarget]);
  const beginFork = useCallback(
    (beforeMessageId?: string): void => {
      if (input.active || detail === null) return;
      const userMessage = detail.messages.some(
        (message) => message.id === beforeMessageId && message.role === "user",
      );
      if (beforeMessageId !== undefined && !userMessage) return;
      setPending({
        runId,
        source: {
          taskId: detail.task.id,
          title: detail.task.title,
          ...(beforeMessageId === undefined ? {} : { beforeMessageId }),
        },
      });
    },
    [detail, input.active, runId],
  );
  const cancelFork = useCallback((): void => {
    setPending(null);
    setForkTarget(undefined);
  }, [setForkTarget]);
  const continueIn = useContinueIn(input, detail, setPending, setForkTarget);
  return { fork: pending?.source ?? null, beginFork, cancelFork, continueIn };
}

/** Requests the fork in the target workspace and switches there; a refused switch drops it. */
function useContinueIn(
  input: SessionInput,
  detail: CodingHistoryDetail | null,
  setPending: (pending: PendingFork | null) => void,
  setForkTarget: (workspaceId: string | undefined) => void,
): CodingTaskSession["continueIn"] {
  const runId = input.snapshot?.runId;
  return useCallback(
    async (target: CodingTaskForkTarget): Promise<void> => {
      if (input.active || detail === null || input.workspace === null) return;
      setPending({
        runId,
        source: { taskId: detail.task.id, title: detail.task.title, targetWorkspace: target },
      });
      setForkTarget(target.workspaceId);
      if (await input.workspace.switchTo(target.workspaceId)) return;
      setPending(null);
      setForkTarget(undefined);
    },
    [detail, input.active, input.workspace, runId, setPending, setForkTarget],
  );
}

// A different run ends a fork request; the workspace switch of a continuation may hide the run.
function forkRunChanged(pending: PendingFork, runId: string | undefined): boolean {
  if (runId === pending.runId) return false;
  return !(pending.source.targetWorkspace !== undefined && runId === undefined);
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
      (activeWorkspaceId === undefined ||
        detail.task.workspaceId === activeWorkspaceId ||
        continuesInto(detail, input, activeWorkspaceId)))
  );
}

// A task stays on display while a pending fork continues it in a workspace provisioned from its own.
function continuesInto(
  detail: CodingHistoryDetail,
  input: SessionInput,
  activeWorkspaceId: string,
): boolean {
  return (
    input.forkTarget === activeWorkspaceId &&
    taskWorkspaceProvisioningSource(input.workspace?.instances ?? [], activeWorkspaceId)
      ?.workspaceId === detail.task.workspaceId
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
      // A failed read for another task must never leave the previous task's conversation id
      // attached to the composer. A refresh of the same task may retain its visible history.
      setDetail((current) => (current?.task.id === id ? current : null));
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

const ROUTINE_SCOPE_SWITCHES: Partial<
  Record<
    ClientDiagnosticCodingHistoryScope["reason"],
    "history-repository-switched" | "history-workspace-switched"
  >
> = {
  "repository-mismatch": "history-repository-switched",
  "workspace-mismatch": "history-workspace-switched",
};

function reportScopeChange(
  operation: HistoryLoad,
  current: HistoryScope,
  reason: ClientDiagnosticCodingHistoryScope["reason"],
  targetWorkspaceId?: string,
): void {
  // A task of another repository or workspace returned while the scope never changed is the
  // operator working elsewhere: routine evidence on the info line, not a warn/unknown browser
  // diagnostic (#4118). Any scope that moved meanwhile, and every other reason, keeps the
  // diagnostic with its ids.
  const switched = ROUTINE_SCOPE_SWITCHES[reason];
  if (switched !== undefined && operation.scope.id === current.id) {
    reportCodingWorkbenchInteraction({ interaction: switched }, operation.correlationId);
    return;
  }
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
    if (current.onDraftReset !== undefined) {
      current.onDraftReset();
      reportClientDiagnostic("[keiko] coding task draft reset", {
        correlationId: newClientCorrelationId(),
        composerActivity: "coding-task-reset",
      });
    }
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
  if (current.location === "local") return true;
  const workspace = current.workspace;
  if (workspace === null) return undefined;
  const root = current.root ?? workspace.activeInstance?.repositoryRoot;
  const baseBranch = workspace.activeInstance?.baseBranch;
  if (root === undefined || baseBranch === undefined) return await workspace.clearActive();
  return await workspace.provision({
    root,
    baseBranch,
    taskId: `coding-${secureRandomId("task")}`,
  });
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
