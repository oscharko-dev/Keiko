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
  GitChangedFile,
  GitHistoryResponse,
  GitRepositoryDiffResponse,
  GitRepositoryStatusResponse,
} from "@oscharko-dev/keiko-contracts";

import { fetchGitDiff, fetchGitHistory, fetchGitStatus } from "./api";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";
import {
  parseUnifiedDiff,
  type DiffParseResult,
} from "@/app/components/desktop/widgets/cards/shared/diffParser";

const CHANGE_SIGNAL_DEBOUNCE_MS = 400;

export interface CodingWorkbenchChangesClient {
  readonly getStatus: (root: string) => Promise<GitRepositoryStatusResponse>;
  readonly getHistory: (root: string) => Promise<GitHistoryResponse>;
  readonly getDiff: (root: string, path: string) => Promise<GitRepositoryDiffResponse>;
}

const DEFAULT_CLIENT: CodingWorkbenchChangesClient = {
  getStatus: fetchGitStatus,
  getHistory: (root) => fetchGitHistory({ root, limit: 1, skip: 0 }),
  getDiff: (root, path) => fetchGitDiff({ root, path, scope: "all" }),
};

export type CodingWorkbenchChangesStatus =
  "idle" | "loading" | "ready" | "binding-lost" | "unavailable" | "error";

export type CodingWorkbenchDiffStatus = "idle" | "loading" | "ready" | "empty" | "error";

export interface CodingWorkbenchChangesState {
  readonly status: CodingWorkbenchChangesStatus;
  readonly files: readonly GitChangedFile[];
  readonly selectedPath: string | null;
  readonly head: string | null;
  readonly truncated: boolean;
  readonly diffStatus: CodingWorkbenchDiffStatus;
  readonly diff: DiffParseResult | null;
  readonly diffTruncated: boolean;
}

export interface UseCodingWorkbenchChangesInput {
  readonly root: string | null;
  readonly runId: string | undefined;
  readonly changeSignal: string | null;
  readonly bindingPending: boolean;
  readonly client?: CodingWorkbenchChangesClient | undefined;
}

export interface UseCodingWorkbenchChangesResult extends CodingWorkbenchChangesState {
  readonly selectPath: (path: string) => void;
  readonly retry: () => void;
}

const EMPTY_STATE: CodingWorkbenchChangesState = {
  status: "idle",
  files: [],
  selectedPath: null,
  head: null,
  truncated: false,
  diffStatus: "idle",
  diff: null,
  diffTruncated: false,
};

function unavailable(status: CodingWorkbenchChangesStatus): CodingWorkbenchChangesState {
  return { ...EMPTY_STATE, status };
}

function headLabel(status: GitRepositoryStatusResponse, history: GitHistoryResponse): string {
  return history.entries[0]?.shortSha ?? status.branch ?? "HEAD";
}

function nextSelectedPath(
  current: CodingWorkbenchChangesState,
  files: readonly GitChangedFile[],
): string | null {
  if (files.some((file) => file.path === current.selectedPath)) return current.selectedPath;
  return files[0]?.path ?? null;
}

// Stale-while-revalidate merge: keep the previously rendered diff visible when the same file is
// still selected after a refresh. Blanking it would unmount the diff pane on every change signal,
// destroying keyboard focus and re-announcing the polite live region during a run.
function readyState(
  current: CodingWorkbenchChangesState,
  status: GitRepositoryStatusResponse,
  history: GitHistoryResponse,
): CodingWorkbenchChangesState {
  const selectedPath = nextSelectedPath(current, status.changes);
  const sameSelection = selectedPath !== null && selectedPath === current.selectedPath;
  return {
    status: "ready",
    files: status.changes,
    selectedPath,
    head: headLabel(status, history),
    truncated: status.truncated,
    diffStatus: diffStatusForMerge(current, selectedPath, sameSelection),
    diff: sameSelection ? current.diff : null,
    diffTruncated: sameSelection ? current.diffTruncated : false,
  };
}

function diffStatusForMerge(
  current: CodingWorkbenchChangesState,
  selectedPath: string | null,
  sameSelection: boolean,
): CodingWorkbenchDiffStatus {
  if (selectedPath === null) return "idle";
  if (sameSelection) return current.diffStatus === "idle" ? "loading" : current.diffStatus;
  return "loading";
}

async function loadChanges(
  client: CodingWorkbenchChangesClient,
  root: string,
): Promise<readonly [GitRepositoryStatusResponse, GitHistoryResponse]> {
  await codingAppSessionPairingSettled();
  return Promise.all([client.getStatus(root), client.getHistory(root)]);
}

function useChangesSnapshot(input: {
  readonly client: CodingWorkbenchChangesClient;
  readonly root: string | null;
  readonly runId: string | undefined;
  readonly bindingPending: boolean;
  readonly epoch: number;
  readonly setState: Dispatch<SetStateAction<CodingWorkbenchChangesState>>;
}): void {
  const { bindingPending, client, epoch, root, runId, setState } = input;
  const seenRunIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    // A runId change is a hard boundary: the stale-while-revalidate preservation only applies
    // within a single run, otherwise switching runs while the same file path is selected would
    // caption the previous run's diff, files and head as the new run's.
    const runIdChanged = seenRunIdRef.current !== runId;
    seenRunIdRef.current = runId;
    if (runId === undefined) {
      setState(EMPTY_STATE);
      return undefined;
    }
    if (bindingPending) {
      setState((current) =>
        !runIdChanged && current.status === "ready" ? current : unavailable("loading"),
      );
      return undefined;
    }
    if (root === null) {
      setState(unavailable("binding-lost"));
      return undefined;
    }
    let cancelled = false;
    setState((current) =>
      !runIdChanged && current.status === "ready"
        ? current
        : { ...unavailable("loading"), selectedPath: runIdChanged ? null : current.selectedPath },
    );
    void loadChanges(client, root).then(
      ([status, history]) => {
        if (cancelled) return;
        if (!status.available || !history.available) setState(unavailable("unavailable"));
        else setState((current) => readyState(current, status, history));
      },
      () => {
        if (!cancelled) setState(unavailable("error"));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bindingPending, client, epoch, root, runId, setState]);
}

function diffState(
  response: GitRepositoryDiffResponse,
): Pick<CodingWorkbenchChangesState, "diff" | "diffStatus" | "diffTruncated"> {
  if (!response.available) return { diff: null, diffStatus: "error", diffTruncated: false };
  const parsed = parseUnifiedDiff(response.diff);
  return {
    diff: parsed,
    diffStatus: parsed.files.length === 0 ? "empty" : "ready",
    diffTruncated: response.truncated || parsed.truncated,
  };
}

function useSelectedDiff(input: {
  readonly client: CodingWorkbenchChangesClient;
  readonly root: string | null;
  readonly epoch: number;
  readonly state: CodingWorkbenchChangesState;
  readonly setState: Dispatch<SetStateAction<CodingWorkbenchChangesState>>;
}): void {
  const { client, epoch, root, setState, state } = input;
  const path = state.selectedPath;
  useEffect(() => {
    if (state.status !== "ready" || root === null || path === null) return undefined;
    let cancelled = false;
    // Stale-while-revalidate: leave the previously rendered diff visible while a background
    // refresh fetches the new one. Only surface the loading placeholder when there is nothing
    // to fall back to (initial load or a fresh file selection); otherwise the diff pane would
    // unmount on every change signal, taking any focused control with it.
    setState((current) =>
      current.diff === null && current.diffStatus !== "loading"
        ? { ...current, diffStatus: "loading" }
        : current,
    );
    void client.getDiff(root, path).then(
      (response) => {
        if (cancelled) return;
        if (!response.available) setState(unavailable("unavailable"));
        else setState((current) => ({ ...current, ...diffState(response) }));
      },
      () => {
        if (!cancelled) {
          setState((current) => ({ ...current, diffStatus: "error", diff: null }));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, epoch, path, root, setState, state.status]);
}

function useRunBoundRoot(input: UseCodingWorkbenchChangesInput): string | null {
  const bound = useRef<{ readonly runId: string; readonly root: string | null } | null>(null);
  if (input.runId === undefined) {
    bound.current = null;
    return null;
  }
  if (bound.current?.runId !== input.runId) {
    bound.current = {
      runId: input.runId,
      root: input.bindingPending ? null : input.root,
    };
  } else if (bound.current.root === null && !input.bindingPending && input.root !== null) {
    bound.current = { runId: input.runId, root: input.root };
  }
  return bound.current.root === input.root ? bound.current.root : null;
}

function useChangeSignalRefresh(input: {
  readonly runId: string | undefined;
  readonly changeSignal: string | null;
  readonly refresh: () => void;
}): void {
  const { changeSignal, refresh, runId } = input;
  const seen = useRef({ runId, changeSignal });
  useEffect(() => {
    const sameRun = seen.current.runId === runId;
    const changed = seen.current.changeSignal !== changeSignal;
    seen.current = { runId, changeSignal };
    if (!sameRun || !changed || runId === undefined || changeSignal === null) return undefined;
    const timer = setTimeout(refresh, CHANGE_SIGNAL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [changeSignal, refresh, runId]);
}

export function useCodingWorkbenchChanges(
  input: UseCodingWorkbenchChangesInput,
): UseCodingWorkbenchChangesResult {
  const client = input.client ?? DEFAULT_CLIENT;
  const root = useRunBoundRoot(input);
  const [state, setState] = useState<CodingWorkbenchChangesState>(EMPTY_STATE);
  const [epoch, setEpoch] = useState(0);
  const retry = useCallback((): void => setEpoch((value) => value + 1), []);
  const selectPath = useCallback((path: string): void => {
    setState((current) => {
      if (current.selectedPath === path) return current;
      if (!current.files.some((file) => file.path === path)) return current;
      return { ...current, selectedPath: path, diffStatus: "loading", diff: null };
    });
  }, []);
  useChangesSnapshot({ ...input, client, root, epoch, setState });
  useSelectedDiff({ client, root, epoch, state, setState });
  useChangeSignalRefresh({ ...input, refresh: retry });
  return { ...state, retry, selectPath };
}
