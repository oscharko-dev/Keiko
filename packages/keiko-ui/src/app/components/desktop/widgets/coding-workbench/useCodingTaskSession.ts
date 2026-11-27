"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  CodingHistoryDetail,
  CodingHistoryTask,
} from "@oscharko-dev/keiko-contracts/bff-wire";
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
import { useCodingAppSessionRedemptions } from "@/lib/coding-app-session-client";
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
  /** Repeats the read or update that failed and raised `error`. */
  readonly retry: () => void;
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
  /** The run the person left with New task in this window; a reload does not follow it again. */
  readonly leftRun?: string | undefined;
  readonly onLeftRun?: ((runId: string | undefined) => void) | undefined;
}

/**
 * The repository the session shows. While a run is active it stays the one the run started in: a
 * Coding History pick that moves the window to another repository is held until the run ends, and
 * the running task stays on display meanwhile.
 */
function useRunRoot(root: string | undefined, active: boolean): string | undefined {
  const held = useRef(root);
  if (!active) held.current = root;
  return held.current;
}

function reportFailure(error: unknown): void {
  reportClientDiagnostic(`[keiko] coding task session failed: ${clientErrorSummary(error)}`, {
    correlationId: correlationIdOf(error),
  });
}

/**
 * Reads a task. `followed` marks a read of the run the window follows: "refresh" is a background
 * read that never raises the loading or error state, "initial" is the first read of a followed
 * run. Both announce a changed history only after the read succeeded. A repository's remembered
 * task is shown again with a "refresh" read too, so a task completed or removed meanwhile is not.
 */
type LoadTask = (id: string, activate: boolean, followed?: "initial" | "refresh") => Promise<void>;

/** A background read of the followed run's task. */
interface QueuedRefresh {
  readonly taskId: string;
  readonly runId: string | undefined;
}

interface TaskLoader {
  readonly detail: CodingHistoryDetail | null;
  readonly setDetail: Dispatch<SetStateAction<CodingHistoryDetail | null>>;
  readonly pending: boolean;
  readonly setPending: (value: boolean) => void;
  readonly error: boolean;
  readonly setError: (value: boolean) => void;
  readonly sequence: { current: number };
  readonly load: LoadTask;
  /** What `retry` repeats: the last foreground operation that failed. */
  readonly retryOperation: { current: (() => void) | undefined };
}

export function useCodingTaskSession(options: SessionInput): CodingTaskSession {
  const [forkTarget, setForkTarget] = useState<string | undefined>(undefined);
  const root = useRunRoot(
    options.root ?? options.workspace?.activeInstance?.repositoryRoot,
    options.active,
  );
  const input = { ...options, root, forkTarget };
  const ignoredRun = useRef<string | undefined>(options.leftRun);
  const awaitingRun = useRef<AwaitedRun>(undefined);
  const latest = useRef(input);
  latest.current = input;
  const controller = useTaskLoader(latest);
  const { detail, pending, error, load } = controller;
  const scopeTasks = useScopeTasks(detail);
  useTaskUpdates(controller.setDetail);
  const newTask = useNewTask(latest, ignoredRun, awaitingRun, controller, scopeTasks);
  useSessionSelection(input, load, newTask, ignoredRun, awaitingRun, scopeTasks);
  useScopeRestore(latest, scopeTasks, load);
  const { finish, retry } = useFinishAndRetry(input.active, controller, newTask);
  const scoped = detail !== null && taskScopeMatches(detail, input, false) ? detail : null;
  const fork = useTaskFork(input, scoped, setForkTarget);
  return {
    detail: scoped,
    pending,
    error,
    newTask,
    finish,
    retry,
    visibleRun: sessionRunVisible(input, scoped, ignoredRun.current),
    forkTargets: forkTargetsOf(input, scoped),
    ...fork,
    ...startPoint(scoped, input.active, fork.fork),
  };
}

/** Completes the displayed task and leaves it; `retry` repeats whichever foreground step failed. */
function useFinishAndRetry(
  active: boolean,
  controller: TaskLoader,
  newTask: () => Promise<void>,
): Pick<CodingTaskSession, "finish" | "retry"> {
  const { detail, setPending, setError, retryOperation } = controller;
  const finish = async (): Promise<void> => {
    if (active || detail === null) return;
    setPending(true);
    try {
      await updateCodingTask(detail.task.id, { status: "completed" });
      await newTask();
    } catch (cause) {
      reportFailure(cause);
      retryOperation.current = (): void => void finish();
      setError(true);
    } finally {
      setPending(false);
    }
  };
  const retry = (): void => {
    const operation = retryOperation.current;
    retryOperation.current = undefined;
    setError(false);
    operation?.();
  };
  return { finish, retry };
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
  if (input.active) return true;
  // A run that needs recovery stays in view so its panel is read, until the person leaves it with
  // New task (F30): the run remains reachable from Coding History and never locks the window.
  if (input.snapshot?.state === "recovery-required" && ignoredRun !== input.snapshot.runId) {
    return true;
  }
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
  const retryOperation = useRef<(() => void) | undefined>(undefined);
  const shown = useRef(detail);
  shown.current = detail;
  const scopeRevision = useHistoryScope(latest, detail, setDetail, sequence);
  const load = useCallback(
    async (id: string, activate: boolean, followed?: "initial" | "refresh"): Promise<void> => {
      const seq = ++sequence.current;
      const operation = historyLoad(id, scopeRevision.current.scope);
      const background = followed === "refresh";
      // A failed read for another task must never leave the previous task's conversation id
      // attached to the composer. A refresh of the same task may retain its visible history.
      setDetail((current) => (current?.task.id === id ? current : null));
      if (!background) {
        retryOperation.current = (): void => void load(id, activate, followed);
        setPending(true);
        setError(false);
      }
      try {
        await readTask(id, activate, operation, {
          latest,
          scopeRevision,
          setDetail,
          isCurrent: () => seq === sequence.current,
          followed,
          openedCompleted: isCompletedTask(shown.current, id),
        });
      } catch (cause) {
        if (seq === sequence.current)
          reportLoadFailure(cause, operation, scopeRevision.current.scope, background, setError);
      } finally {
        if (seq === sequence.current) setPending(false);
      }
    },
    [latest, scopeRevision],
  );
  return {
    detail,
    setDetail,
    pending,
    setPending,
    error,
    setError,
    load,
    sequence,
    retryOperation,
  };
}

interface TaskReadContext {
  readonly latest: { current: SessionInput };
  readonly scopeRevision: { current: HistoryScopeState };
  readonly setDetail: TaskLoader["setDetail"];
  readonly isCurrent: () => boolean;
  readonly followed: "initial" | "refresh" | undefined;
  /** The read task is a completed one already on display, opened from Coding History. */
  readonly openedCompleted: boolean;
}

function isCompletedTask(task: CodingHistoryDetail | null, id: string): boolean {
  return task?.task.id === id && task.task.status === "completed";
}

async function readTask(
  id: string,
  activate: boolean,
  operation: HistoryLoad,
  context: TaskReadContext,
): Promise<void> {
  const result = await fetchCodingTask(id, operation.correlationId);
  const accepted = await acceptTaskRead(result, activate, operation, context);
  if (accepted && context.followed !== undefined)
    window.dispatchEvent(new Event(CODING_HISTORY_CHANGED));
}

/** Shows a read task when it is still the current read of the current scope; says whether it did. */
async function acceptTaskRead(
  result: CodingHistoryDetail,
  activate: boolean,
  operation: HistoryLoad,
  context: TaskReadContext,
): Promise<boolean> {
  const { latest, scopeRevision, setDetail, isCurrent } = context;
  if (!isCurrent() || historyLoadCancelled(operation, scopeRevision.current.scope)) return false;
  // A completed task is never the current task by following its run: after a reload the next
  // message would reopen it instead of starting a new task. Coding History still opens it (#4491).
  if (
    context.followed !== undefined &&
    !context.openedCompleted &&
    result.task.status === "completed"
  ) {
    setDetail(null);
    return false;
  }
  const activated = await activateHistoryTask(
    result,
    latest,
    activate,
    operation,
    scopeRevision.current.scope,
  );
  if (!isCurrent()) return false;
  if (activationSuperseded(result, latest.current, operation, scopeRevision.current.scope))
    return false;
  if (!activated) {
    setDetail(null);
    return false;
  }
  scopeRevision.current.accepted = operation;
  setDetail(result);
  return true;
}

// A background refresh never raises the foreground error: the visible task is still current.
function reportLoadFailure(
  cause: unknown,
  operation: HistoryLoad,
  scope: HistoryScope,
  background: boolean,
  setError: (value: boolean) => void,
): void {
  if (operation.scope.id !== scope.id) {
    reportScopeChange(operation, scope, "activation-cancelled");
    return;
  }
  reportFailure(cause);
  if (!background) setError(true);
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

/**
 * Shows a rename or status change of the displayed task made elsewhere (Coding History) at once.
 * The event carries the server's updated record, so nothing is read again (#4491).
 */
function useTaskUpdates(setDetail: TaskLoader["setDetail"]): void {
  useEffect(() => {
    const apply = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const task: unknown = event.detail;
      setDetail((current) => {
        if (current === null || !sameTask(task, current.task)) return current;
        return task.status === "completed" && current.task.status !== "completed"
          ? null
          : { ...current, task };
      });
    };
    window.addEventListener(CODING_HISTORY_CHANGED, apply);
    return (): void => {
      window.removeEventListener(CODING_HISTORY_CHANGED, apply);
    };
  }, [setDetail]);
}

// `updateCodingTask` sends the server's record of the task; a plain history change carries none.
function sameTask(value: unknown, task: CodingHistoryTask): value is CodingHistoryTask {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    value.id === task.id &&
    "title" in value &&
    typeof value.title === "string"
  );
}

/** The task each repository showed last in this window, bounded; in memory only (#4491). */
interface ScopeTask {
  readonly taskId: string;
  readonly workspaceId: string;
}
type ScopeTasks = { readonly current: Map<string, ScopeTask> };
const MAX_SCOPE_TASKS = 32;

/**
 * Remembers the task a repository showed, for `useScopeRestore` to show it again when the window
 * switches back to that repository. The server follows one latest run for every window, so without
 * it a run in the other repository left the first one's open task unreachable outside Coding
 * History.
 */
function useScopeTasks(detail: CodingHistoryDetail | null): ScopeTasks {
  const scopeTasks = useRef(new Map<string, ScopeTask>());
  useEffect(() => {
    if (detail === null) return;
    const { id: taskId, projectPath, workspaceId, status } = detail.task;
    const tasks = scopeTasks.current;
    // A completed task opened from Coding History is no repository's open task any more.
    if (status === "completed") {
      if (tasks.get(projectPath)?.taskId === taskId) tasks.delete(projectPath);
      return;
    }
    tasks.delete(projectPath);
    tasks.set(projectPath, { taskId, workspaceId });
    const oldest = tasks.keys().next().value;
    if (tasks.size > MAX_SCOPE_TASKS && oldest !== undefined) tasks.delete(oldest);
  }, [detail]);
  return scopeTasks;
}

/**
 * Shows a repository's remembered task again when the window switches back to it. It runs after
 * the selection and followed-run effects, so in one commit its read is the current one: a
 * followed run of a task no repository remembers cannot supersede it. The read is a background
 * one the completed guard covers, so a task completed or removed meanwhile is not shown. It reads
 * only once the task's own workspace is active again: the repository selector binds it a render
 * after the root moved, and a read before that would be refused as another workspace's task.
 */
function useScopeRestore(
  latest: { current: SessionInput },
  scopeTasks: ScopeTasks,
  load: LoadTask,
): void {
  const root = latest.current.root;
  const workspaceId = latest.current.workspace?.activeInstance?.workspaceId;
  useEffect(() => {
    const current = latest.current;
    const task = root === undefined ? undefined : scopeTasks.current.get(root);
    if (task === undefined || current.active || current.selection !== undefined) return;
    if (workspaceId !== undefined && workspaceId !== task.workspaceId) return;
    void load(task.taskId, false, "refresh");
  }, [root, workspaceId, latest, scopeTasks, load]);
}

/** The followed task, unless this window already showed it under another repository. */
function inRepository(
  taskId: string | undefined,
  scopeTasks: ScopeTasks,
  root: string | undefined,
): string | undefined {
  if (taskId === undefined || root === undefined) return taskId;
  for (const [taskRoot, task] of scopeTasks.current)
    if (task.taskId === taskId) return taskRoot === root ? taskId : undefined;
  return taskId;
}

function useNewTask(
  latest: { current: SessionInput },
  ignoredRun: { current: string | undefined },
  awaitingRun: { current: AwaitedRun },
  controller: TaskLoader,
  scopeTasks: ScopeTasks,
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
    if (current.snapshot?.state === "recovery-required") {
      reportCodingWorkbenchInteraction({ interaction: "recovery-left" }, newClientCorrelationId());
    }
    ignoredRun.current = current.snapshot?.runId;
    current.onLeftRun?.(ignoredRun.current);
    if (current.root !== undefined) scopeTasks.current.delete(current.root);
    awaitingRun.current = current.snapshot === null ? {} : undefined;
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
  }, [latest, ignoredRun, awaitingRun, sequence, setDetail, setError, setPending, scopeTasks]);
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
  awaitingRun: { current: AwaitedRun },
  scopeTasks: ScopeTasks,
): void {
  const { selection, snapshot, active } = input;
  const statusRead = snapshot !== null;
  const selectionHandled = useRef(input.onSelectionHandled);
  selectionHandled.current = input.onSelectionHandled;
  const lastSelection = useRemountedSelection();
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
      awaitingRun.current = statusRead ? undefined : { taskId: selection };
      void load(selection, true);
    }
  }, [
    selection,
    active,
    statusRead,
    snapshot?.runId,
    load,
    newTask,
    ignoredRun,
    awaitingRun,
    lastSelection,
  ]);
  useFollowedRun(input, load, ignoredRun, awaitingRun, scopeTasks);
}

/** The task of the run the window follows right now, or undefined when it follows none. */
function followedTaskId(
  status: { readonly read: boolean; readonly conversationId?: string; readonly runId?: string },
  ignoredRun: { current: string | undefined },
  awaitingRun: { current: AwaitedRun },
  active: boolean,
): string | undefined {
  const id = status.conversationId;
  // A status read without a run tells the window no other task's run is pending.
  if (status.read && status.runId === undefined) awaitingRun.current = undefined;
  if (id === undefined || status.runId === ignoredRun.current) return undefined;
  const run = { conversationId: id, runId: status.runId };
  return followsRun(awaitingRun, ignoredRun, run, active) ? id : undefined;
}

/** Loads the task of the runtime's run when the window follows it (see `followsRun`). */
function useFollowedRun(
  input: SessionInput,
  load: LoadTask,
  ignoredRun: { current: string | undefined },
  awaitingRun: { current: AwaitedRun },
  scopeTasks: ScopeTasks,
): void {
  const { snapshot, active } = input;
  const refresh = useCoalescedRefresh(load, ignoredRun);
  const root = useRef(input.root);
  root.current = input.root;
  // The run's identity as the window follows it; only a revision bump within it is a refresh.
  const followed = useRef<string | undefined>(undefined);
  const statusRead = snapshot !== null;
  const activeWorkspaceId = input.workspace?.activeInstance?.workspaceId;
  // #4068 W9: after a server restart the restored run's task was read before the browser was
  // paired again. The server answers an unpaired caller exactly like an unknown task, so that read
  // failed, and nothing read it again once the pairing arrived without a page load. The restore
  // re-runs on each later pairing, like every other session-bound read (F65).
  const redemptions = useCodingAppSessionRedemptions();
  useEffect(() => {
    const status = {
      read: statusRead,
      ...(snapshot?.conversationId === undefined
        ? {}
        : { conversationId: snapshot.conversationId }),
      ...(snapshot?.runId === undefined ? {} : { runId: snapshot.runId }),
    };
    const id = inRepository(
      followedTaskId(status, ignoredRun, awaitingRun, active),
      scopeTasks,
      root.current,
    );
    if (id === undefined) return;
    const key = [id, snapshot?.runId, snapshot?.state, activeWorkspaceId, active, redemptions];
    const same = followed.current === key.join("|");
    followed.current = key.join("|");
    if (same) refresh({ taskId: id, runId: snapshot?.runId });
    else void load(id, false, "initial");
  }, [
    statusRead,
    snapshot?.conversationId,
    snapshot?.runId,
    snapshot?.state,
    // Native input can be published while the same run stays running. Its durable transcript
    // is re-read on the existing server revision; the UI never invents a pending turn.
    snapshot?.revision,
    activeWorkspaceId,
    active,
    redemptions,
    load,
    refresh,
    ignoredRun,
    awaitingRun,
    scopeTasks,
  ]);
}

/**
 * Background refresh of the followed task: one read in flight and at most one trailing read, so a
 * burst of revision bumps costs a bounded number of reads.
 */
function useCoalescedRefresh(
  load: LoadTask,
  ignoredRun: { current: string | undefined },
): (refresh: QueuedRefresh) => void {
  const state = useRef<{ inflight: boolean; trailing: QueuedRefresh | undefined }>({
    inflight: false,
    trailing: undefined,
  });
  return useCallback(
    (refresh: QueuedRefresh): void => {
      const current = state.current;
      const request = (target: QueuedRefresh): void => {
        if (current.inflight) {
          current.trailing = target;
          return;
        }
        current.inflight = true;
        void load(target.taskId, false, "refresh").finally(() => {
          current.inflight = false;
          const next = current.trailing;
          current.trailing = undefined;
          // A task picked meanwhile leaves the followed run: its queued read is not replayed, or it
          // would replace the picked task (#4491 audit).
          if (next !== undefined && next.runId !== ignoredRun.current) request(next);
        });
      };
      request(refresh);
    },
    [load, ignoredRun],
  );
}

/**
 * The last selection the window handled. An unmount discards the read of a picked task as stale;
 * when React mounts the window again (development StrictMode, a preserved subtree), the pick is
 * read anew instead of leaving the window on "Loading task…" (#4271). A New task pick is not
 * repeated: it provisions a workspace.
 */
function useRemountedSelection(): { current: string | undefined } {
  const lastSelection = useRef<string | undefined>(undefined);
  useEffect(
    () => (): void => {
      if (lastSelection.current?.startsWith("new:") !== true) lastSelection.current = undefined;
    },
    [],
  );
  return lastSelection;
}

/**
 * Set while the window waits for its first status read (#4271): `taskId` is the task picked from
 * Coding History, absent for New task. Undefined once the window follows every run.
 */
type AwaitedRun = { readonly taskId?: string } | undefined;

/**
 * Whether the window follows the runtime's run (#4271). The runtime status names the process's
 * latest run, not this window's task. A task picked before the window ever read that status, as in
 * a window opened from Coding History, ignores the run the first status read reports when it has
 * already settled: it belongs to another task and must not replace the picked one. A run already
 * active, a settled run of the picked task itself, and every later run (the window's own start
 * among them) is followed as before; so is every run after a first status read that reported none.
 */
function followsRun(
  awaitingRun: { current: AwaitedRun },
  ignoredRun: { current: string | undefined },
  run: { readonly conversationId: string; readonly runId: string | undefined },
  active: boolean,
): boolean {
  const awaited = awaitingRun.current;
  if (awaited === undefined) return true;
  awaitingRun.current = undefined;
  if (active || awaited.taskId === run.conversationId) return true;
  ignoredRun.current = run.runId;
  reportCodingWorkbenchInteraction({ interaction: "history-run-held" }, newClientCorrelationId());
  return false;
}
