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
  /** See {@link RunBoundRootInput.submittedRoot}: the run's submission-time root, so a delayed
   * Start response cannot caption another workspace's changes as this run's. */
  readonly submittedRoot?: string | null | undefined;
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

/** The minimal shape the run-root lock needs. Any hook whose input carries these fields —
 * `UseCodingWorkbenchChangesInput` and `UseCodingWorkbenchEditorBridgeInput` both do — can pass
 * itself straight through; extra fields are ignored structurally. */
export interface RunBoundRootInput {
  readonly runId: string | undefined;
  readonly root: string | null;
  readonly bindingPending: boolean;
  /**
   * The root the run was SUBMITTED against, captured when Start was issued rather than when its
   * response landed (`useCodingWorkbenchRunWorkspace`). The server binds a new run to the active
   * pointer synchronously and only then awaits runtime startup, so by the time the response
   * carries a `runId` the operator may already have moved that pointer: locking onto the live root
   * at that moment captures the WRONG workspace for the run's whole lifetime (#3381 review).
   * Optional — a caller with no submission capture keeps the previous behaviour and locks onto the
   * live root at the first render that carries the run id.
   */
  readonly submittedRoot?: string | null | undefined;
}

/**
 * Locks a workspace root to the run that is using it, for that run's entire lifetime (workbench
 * audit, 2026-09-03 finding 2), and keeps reporting it even after the shell's active
 * workspace/repository moves elsewhere — an ordinary, reachable UI action nothing warns the
 * operator not to take. The run's authority is server-side and bound to the root it started in, so
 * the lock follows the RUN, never the singleton pointer: it never re-binds to the new root while
 * the same `runId` is current, and a new `runId` re-arms it from scratch.
 *
 * Use this where the run's own root is the correct target (the headless editor bridge serving the
 * run's `applyChangeset` calls). Where the answer must instead be "the live pointer no longer
 * names this run's workspace", use {@link useRunBoundRoot}, which adds that divergence check.
 */
export function useRunLockedRoot(input: RunBoundRootInput): string | null {
  const bound = useRef<{ readonly runId: string; readonly root: string | null } | null>(null);
  if (input.runId === undefined) {
    bound.current = null;
    return null;
  }
  if (bound.current?.runId !== input.runId) {
    bound.current = { runId: input.runId, root: armedRoot(input) };
  } else if (bound.current.root === null && !input.bindingPending && input.root !== null) {
    bound.current = { runId: input.runId, root: input.root };
  }
  return bound.current.root;
}

/** The root the lock arms with for a newly seen run: its submission-time root when the caller
 * captured one, else the live root once the binding has settled. */
function armedRoot(input: RunBoundRootInput): string | null {
  const submitted = input.submittedRoot ?? null;
  if (submitted !== null) return submitted;
  return input.bindingPending ? null : input.root;
}

/**
 * {@link useRunLockedRoot} plus a divergence check: the run's locked root is reported only for as
 * long as the live `root` keeps naming it, and the moment the two diverge this returns `null` —
 * "binding lost" — instead of presenting another workspace's state as the run's.
 */
export function useRunBoundRoot(input: RunBoundRootInput): string | null {
  const locked = useRunLockedRoot(input);
  return locked === input.root ? locked : null;
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
