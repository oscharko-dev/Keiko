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

import {
  codingAppSessionPairingSettled,
  useCodingAppSessionRedemptions,
} from "./coding-app-session-client";
import {
  getCodingAppSessionChannelSnapshot,
  streamCodingAppSessionChannelSnapshots,
} from "./coding-app-session-channel-api";

const RESYNC_DEBOUNCE_MS = 400;
const STREAM_BATCH_MS = 32;
// A dropped live channel reconnects by itself, a bounded number of times with growing pauses, so a
// quiet run does not leave the page showing a lost connection until the next runtime event or a
// click (Keiko 1.3.0 test, #3897). After the last attempt the Reconnect action remains.
export const CODING_SAFE_ACTIVITY_RECONNECT_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000,
];
// The attempts start over only once a reconnected channel has stayed live this long, so a channel
// that closes as soon as it opens cannot reconnect forever.
export const CODING_SAFE_ACTIVITY_RECONNECT_RESET_MS = 30_000;

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
  readonly runtimeEventSignal: number;
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
  const { runId, runState, runtimeEventSignal } = input;
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
  useActivityResync({ runId, runtimeEventSignal, status: state.status, retry });
  useActivityAutoReconnect({ runId, status: state.status, retry });
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
  // A re-pair without a page load reopens the channel (F65).
  const redemptions = useCodingAppSessionRedemptions();
  useEffect(() => {
    cancel();
    if (runId === undefined) {
      setState(IDLE_STATE);
      return undefined;
    }
    const controller = new AbortController();
    // The conversation already held for this run stays on screen, captioned by the non-live
    // status, until a new snapshot replaces it; only another run's feed is dropped.
    setState((current) => ({
      status: "loading",
      feed: current.feed?.runId === runId ? current.feed : null,
      errorCode: null,
    }));
    const publish = (snapshot: CodingAppSessionChannelSnapshot): void => {
      if (!controller.signal.aborted) enqueue(snapshot);
    };
    void connectActivity(controller, publish, runStateRef)
      .then(() => {
        if (controller.signal.aborted) return;
        flush();
        markDisconnected(controller, runStateRef, setState);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        flush();
        markConnectionFailure(error, controller, setState);
      });
    return () => {
      controller.abort();
      cancel();
    };
  }, [cancel, enqueue, epoch, flush, redemptions, runId, runStateRef, setState]);
}

async function connectActivity(
  controller: AbortController,
  enqueue: (snapshot: CodingAppSessionChannelSnapshot) => void,
  runStateRef: RefObject<CodingWorkbenchRuntimeStateName | undefined>,
): Promise<void> {
  await codingAppSessionPairingSettled();
  if (controller.signal.aborted) return;
  const endedBeforeRead = terminalRunState(runStateRef.current);
  enqueue(await getCodingAppSessionChannelSnapshot(controller.signal));
  // A completed run has a final snapshot, not a live connection to maintain. Keeping an SSE
  // subscription here turns a later server restart into an error on an already finished task.
  if (controller.signal.aborted || endedBeforeRead) return;
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
  if (
    !isSafeActivityContent(content) ||
    content.feed.runId !== runId ||
    content.feed.availability === "unavailable"
  ) {
    return missingProjectionState(runState);
  }
  return { status: lifecycleStatus(runState), feed: content.feed, errorCode: null };
}

// #3610 (W17): no projection for this run. While the run lives that is a lost connection worth a
// reconnect; once it has finished it has ended — Stop purges the projection at once, and a
// Reconnect button could never bring anything back. No feed is held, so nothing stale is captioned.
function missingProjectionState(
  runState: CodingWorkbenchRuntimeStateName | undefined,
): CodingWorkbenchSafeActivityState {
  return {
    status: terminalRunState(runState) ? "ended" : "unavailable",
    feed: null,
    errorCode: null,
  };
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
  // A failed projection keeps its failure status even once the run reaches a terminal state. The
  // feed we hold was captured BEFORE the channel dropped, so calling it "ended" would caption a
  // stale snapshot as the final confirmed transcript and remove the reconnect affordance — the
  // exact "stale content presented as live" the acceptance criterion forbids. Honest failure
  // first; the operator reconnects and only then sees a real terminal feed.
  if (current.feed === null) {
    return current.status === "unavailable" && terminalRunState(runState)
      ? { ...current, status: "ended" }
      : current;
  }
  // A held feed that is still being re-read is not confirmed live (or paused, or ended) yet.
  if (failureStatus(current.status) || current.status === "loading") return current;
  return { ...current, status: lifecycleStatus(runState) };
}

function lifecycleStatus(
  runState: CodingWorkbenchRuntimeStateName | undefined,
): Extract<CodingWorkbenchSafeActivityStatus, "live" | "paused" | "recovery" | "ended"> {
  if (runState === "paused") return "paused";
  if (runState === "recovery-required") return "recovery";
  if (terminalRunState(runState)) return "ended";
  return "live";
}

function terminalRunState(runState: CodingWorkbenchRuntimeStateName | undefined): boolean {
  return (
    runState === "succeeded" ||
    runState === "failed" ||
    runState === "cancelled" ||
    runState === "taken-over"
  );
}

/**
 * The projection is not live. Two call sites need exactly this set: the lifecycle transition must
 * NOT relabel such a state as "ended" (that would caption a stale feed as final), and the resync
 * effect uses it to decide when a fresh runtime signal is worth reconnecting for.
 */
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
  readonly runtimeEventSignal: number;
  readonly status: CodingWorkbenchSafeActivityStatus;
  readonly retry: () => void;
}): void {
  const { retry, runId, runtimeEventSignal, status } = input;
  const seenRef = useRef(runtimeEventSignal);
  useEffect(() => {
    const changed = seenRef.current !== runtimeEventSignal;
    seenRef.current = runtimeEventSignal;
    if (runId === undefined || !changed || !failureStatus(status)) return undefined;
    const timer = setTimeout(retry, RESYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [retry, runId, runtimeEventSignal, status]);
}

/** A channel that was open or tried to open and stopped; `unavailable` waits for a runtime event. */
function reconnectableStatus(status: CodingWorkbenchSafeActivityStatus): boolean {
  return status === "disconnected" || status === "offline" || status === "error";
}

function useActivityAutoReconnect(input: {
  readonly runId: string | undefined;
  readonly status: CodingWorkbenchSafeActivityStatus;
  readonly retry: () => void;
}): void {
  const { retry, runId, status } = input;
  const attemptsRef = useRef(0);
  useEffect(() => {
    attemptsRef.current = 0;
  }, [runId]);
  useEffect(() => {
    if (runId === undefined) return undefined;
    if (status === "live" || status === "paused" || status === "recovery") {
      const settled = setTimeout(() => {
        attemptsRef.current = 0;
      }, CODING_SAFE_ACTIVITY_RECONNECT_RESET_MS);
      return (): void => clearTimeout(settled);
    }
    const delay = reconnectableStatus(status)
      ? CODING_SAFE_ACTIVITY_RECONNECT_DELAYS_MS[attemptsRef.current]
      : undefined;
    if (delay === undefined) return undefined;
    const timer = setTimeout(() => {
      attemptsRef.current += 1;
      retry();
    }, delay);
    return (): void => clearTimeout(timer);
  }, [retry, runId, status]);
}
