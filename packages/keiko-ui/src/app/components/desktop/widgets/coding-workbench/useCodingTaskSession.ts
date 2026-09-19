"use client";
import { useCallback, useEffect, useRef, useState } from "react";
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
  readonly setDetail: (value: CodingHistoryDetail | null) => void;
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
  const { detail, setDetail, pending, setPending, error, setError, load } = controller;
  const newTask = useNewTask(latest, ignoredRun, controller);
  useSessionSelection(input, load, newTask, ignoredRun, setDetail);
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
  const scoped =
    detail?.task.projectPath === input.root || input.root === undefined ? detail : null;
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
    activate || activeWorkspaceId === undefined || detail.task.workspaceId === activeWorkspaceId
  );
}

function useTaskLoader(latest: { current: SessionInput }): TaskLoader {
  const [detail, setDetail] = useState<CodingHistoryDetail | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(
    async (id: string, activate: boolean): Promise<void> => {
      const seq = ++sequence.current;
      setPending(true);
      setError(false);
      try {
        const result = await fetchCodingTask(id);
        if (seq !== sequence.current) return;
        if (!taskScopeMatches(result, latest.current, activate)) return;
        if (activate && !(await latest.current.workspace?.switchTo(result.task.workspaceId)))
          throw new Error("Workspace unavailable");
        if (seq === sequence.current) setDetail(result);
      } catch (cause) {
        if (seq === sequence.current) {
          reportFailure(cause);
          setError(true);
        }
      } finally {
        if (seq === sequence.current) setPending(false);
      }
    },
    [latest],
  );
  return { detail, setDetail, pending, setPending, error, setError, load, sequence };
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
  setDetail: (value: CodingHistoryDetail | null) => void,
): void {
  const { selection, snapshot, root, active } = input;
  const activeWorkspaceId = input.workspace?.activeInstance?.workspaceId;
  const selectionHandled = useRef(input.onSelectionHandled);
  selectionHandled.current = input.onSelectionHandled;
  const lastSelection = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (selection === undefined || lastSelection.current === selection || active) return;
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
  useEffect(() => {
    setDetail(null);
  }, [root, setDetail]);
}
