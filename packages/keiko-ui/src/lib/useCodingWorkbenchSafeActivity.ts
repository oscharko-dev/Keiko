"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  AvailableCodingSafeActivityFeed,
  CodingAppSessionSafeActivityContent,
  CodingAppSessionChannelSnapshot,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";

import { codingAppSessionPairingSettled } from "./coding-app-session-client";
import {
  getCodingAppSessionChannelSnapshot,
  streamCodingAppSessionChannelSnapshots,
} from "./coding-app-session-channel-api";

const RESYNC_DEBOUNCE_MS = 400;
const STREAM_BATCH_MS = 32;

export type CodingWorkbenchSafeActivityStatus =
  | "idle"
  | "loading"
  | "live"
  | "paused"
  | "recovery"
  | "ended"
  | "unavailable"
  | "disconnected"
  | "offline"
  | "error";

export interface CodingWorkbenchSafeActivityState {
  readonly status: CodingWorkbenchSafeActivityStatus;
  readonly feed: AvailableCodingSafeActivityFeed | null;
  readonly errorCode: string | null;
}

export interface UseCodingWorkbenchSafeActivityInput {
  readonly runId: string | undefined;
  readonly runState: CodingWorkbenchRuntimeStateName | undefined;
  readonly runtimeEventCount: number;
}

export interface UseCodingWorkbenchSafeActivityResult extends CodingWorkbenchSafeActivityState {
  readonly retry: () => void;
}

const IDLE_STATE: CodingWorkbenchSafeActivityState = {
  status: "idle",
  feed: null,
  errorCode: null,
};

export function useCodingWorkbenchSafeActivity(
  input: UseCodingWorkbenchSafeActivityInput,
): UseCodingWorkbenchSafeActivityResult {
  const { runId, runState, runtimeEventCount } = input;
  const [state, setState] = useState<CodingWorkbenchSafeActivityState>(IDLE_STATE);
  const [epoch, setEpoch] = useState(0);
  const runStateRef = useRef(runState);
  const batch = useSnapshotBatch(runId, runStateRef, setState);
  const retry = useCallback(() => setEpoch((value) => value + 1), []);

  useEffect(() => {
    runStateRef.current = runState;
    setState((current) => stateForLifecycle(current, runState));
  }, [runState]);
  useActivityConnection({ runId, epoch, batch, runStateRef, setState });
  useActivityResync({ runId, runtimeEventCount, status: state.status, retry });
  return { ...state, retry };
}

interface SnapshotBatch {
  readonly enqueue: (snapshot: CodingAppSessionChannelSnapshot) => void;
  readonly flush: () => void;
  readonly cancel: () => void;
}

function useSnapshotBatch(
  runId: string | undefined,
  runStateRef: RefObject<CodingWorkbenchRuntimeStateName | undefined>,
  setState: Dispatch<SetStateAction<CodingWorkbenchSafeActivityState>>,
): SnapshotBatch {
  const pendingRef = useRef<CodingAppSessionChannelSnapshot | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback((): void => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    pendingRef.current = null;
  }, []);
  const flush = useCallback((): void => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending !== null && runId !== undefined) {
      setState(stateFromSnapshot(pending, runId, runStateRef.current));
    }
  }, [runId, runStateRef, setState]);
  const enqueue = useCallback(
    (snapshot: CodingAppSessionChannelSnapshot): void => {
      pendingRef.current = snapshot;
      timerRef.current ??= setTimeout(flush, STREAM_BATCH_MS);
    },
    [flush],
  );
  useEffect(() => cancel, [cancel]);
  return { enqueue, flush, cancel };
}

interface ActivityConnectionInput {
  readonly runId: string | undefined;
  readonly epoch: number;
  readonly batch: SnapshotBatch;
  readonly runStateRef: RefObject<CodingWorkbenchRuntimeStateName | undefined>;
  readonly setState: Dispatch<SetStateAction<CodingWorkbenchSafeActivityState>>;
}

function useActivityConnection(input: ActivityConnectionInput): void {
  const { batch, epoch, runId, runStateRef, setState } = input;
  const { cancel, enqueue, flush } = batch;
  useEffect(() => {
    cancel();
    if (runId === undefined) {
      setState(IDLE_STATE);
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: "loading", feed: null, errorCode: null });
    void connectActivity(controller, enqueue)
      .then(() => {
        flush();
        markDisconnected(controller, runStateRef, setState);
      })
      .catch((error: unknown) => {
        flush();
        markConnectionFailure(error, controller, setState);
      });
    return () => {
      controller.abort();
      cancel();
    };
  }, [cancel, enqueue, epoch, flush, runId, runStateRef, setState]);
}

async function connectActivity(
  controller: AbortController,
  enqueue: (snapshot: CodingAppSessionChannelSnapshot) => void,
): Promise<void> {
  await codingAppSessionPairingSettled();
  if (controller.signal.aborted) return;
  enqueue(await getCodingAppSessionChannelSnapshot(controller.signal));
  if (controller.signal.aborted) return;
  await streamCodingAppSessionChannelSnapshots({ signal: controller.signal, onSnapshot: enqueue });
}

function markDisconnected(
  controller: AbortController,
  runStateRef: RefObject<CodingWorkbenchRuntimeStateName | undefined>,
  setState: Dispatch<SetStateAction<CodingWorkbenchSafeActivityState>>,
): void {
  if (controller.signal.aborted) return;
  setState((current) => {
    if (current.status === "unavailable" || current.feed === null) return current;
    const terminal = lifecycleStatus(runStateRef.current) === "ended";
    return { ...current, status: terminal ? "ended" : "disconnected" };
  });
}

function markConnectionFailure(
  error: unknown,
  controller: AbortController,
  setState: Dispatch<SetStateAction<CodingWorkbenchSafeActivityState>>,
): void {
  if (controller.signal.aborted) return;
  const offline = error instanceof TypeError || globalThis.navigator?.onLine === false;
  setState((current) => ({
    ...current,
    status: offline ? "offline" : "error",
    errorCode: "CODING_SAFE_ACTIVITY_STREAM_FAILED",
  }));
}

function stateFromSnapshot(
  snapshot: CodingAppSessionChannelSnapshot,
  runId: string,
  runState: CodingWorkbenchRuntimeStateName | undefined,
): CodingWorkbenchSafeActivityState {
  const content = snapshot.content;
  if (!isSafeActivityContent(content) || content.feed.runId !== runId) {
    return { status: "unavailable", feed: null, errorCode: null };
  }
  if (content.feed.availability === "unavailable") {
    return { status: "unavailable", feed: null, errorCode: null };
  }
  return { status: lifecycleStatus(runState), feed: content.feed, errorCode: null };
}

function isSafeActivityContent(
  content: CodingAppSessionChannelSnapshot["content"],
): content is CodingAppSessionSafeActivityContent {
  return content !== null && content.kind === "safe-activity" && "feed" in content;
}

function stateForLifecycle(
  current: CodingWorkbenchSafeActivityState,
  runState: CodingWorkbenchRuntimeStateName | undefined,
): CodingWorkbenchSafeActivityState {
  if (current.feed !== null && lifecycleStatus(runState) === "ended") {
    return { ...current, status: "ended" };
  }
  if (current.feed === null || failureStatus(current.status)) return current;
  return { ...current, status: lifecycleStatus(runState) };
}

function lifecycleStatus(
  runState: CodingWorkbenchRuntimeStateName | undefined,
): Extract<CodingWorkbenchSafeActivityStatus, "live" | "paused" | "recovery" | "ended"> {
  if (runState === "paused") return "paused";
  if (runState === "recovery-required") return "recovery";
  if (terminalState(runState)) return "ended";
  return "live";
}

function terminalState(runState: CodingWorkbenchRuntimeStateName | undefined): boolean {
  return (
    runState === "succeeded" ||
    runState === "failed" ||
    runState === "cancelled" ||
    runState === "taken-over"
  );
}

function failureStatus(status: CodingWorkbenchSafeActivityStatus): boolean {
  return (
    status === "unavailable" ||
    status === "disconnected" ||
    status === "offline" ||
    status === "error"
  );
}

function useActivityResync(input: {
  readonly runId: string | undefined;
  readonly runtimeEventCount: number;
  readonly status: CodingWorkbenchSafeActivityStatus;
  readonly retry: () => void;
}): void {
  const { retry, runId, runtimeEventCount, status } = input;
  const seenRef = useRef(runtimeEventCount);
  useEffect(() => {
    const changed = seenRef.current !== runtimeEventCount;
    seenRef.current = runtimeEventCount;
    if (runId === undefined || !changed || !resyncStatus(status)) return undefined;
    const timer = setTimeout(retry, RESYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [retry, runId, runtimeEventCount, status]);
}

function resyncStatus(status: CodingWorkbenchSafeActivityStatus): boolean {
  return (
    status === "unavailable" ||
    status === "disconnected" ||
    status === "offline" ||
    status === "error"
  );
}
