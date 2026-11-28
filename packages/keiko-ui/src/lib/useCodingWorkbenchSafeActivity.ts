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
import { ApiError } from "./api";
import {
  getCodingAppSessionChannelSnapshot,
  streamCodingAppSessionChannelSnapshots,
} from "./coding-app-session-channel-api";
import { admitDirectBrowserStreamAsync } from "./browser-stream-capacity";
import { reportClientDiagnostic } from "./client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "./client-error-summary";
import {
  terminalRunState,
  useCodingWorkbenchEarlierRunFeeds,
} from "./useCodingWorkbenchEarlierRunFeeds";
import {
  useCodingWorkbenchModelTexts,
  type CodingWorkbenchAnswers,
  type UseCodingWorkbenchModelTextsResult,
} from "./useCodingWorkbenchAnswers";

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
  /**
   * True only when `feed` was read after its run had settled, so no later tool call can be missing
   * from it. A feed held from the live stream is relabelled `ended` when the run settles but stays
   * unconfirmed until it is read again.
   */
  readonly finalConfirmed?: true;
}

export interface UseCodingWorkbenchSafeActivityInput {
  readonly runId: string | undefined;
  readonly runState: CodingWorkbenchRuntimeStateName | undefined;
  readonly runtimeEventSignal: number;
  /** The task the run belongs to; the feeds of its earlier runs are kept for the timeline. */
  readonly conversationId?: string | undefined;
}

export interface UseCodingWorkbenchSafeActivityResult extends CodingWorkbenchSafeActivityState {
  readonly retry: () => void;
  /**
   * The last feed of each earlier run of the same task, oldest first (U-11): its tool rows and
   * messages stay in the timeline when a continuation starts, as in standalone OpenCode. Empty for
   * the task's first run; `feed` is always the shown run's own.
   */
  readonly earlierFeeds?: readonly AvailableCodingSafeActivityFeed[];
  /**
   * The complete text of every answer the feed names as longer than it carries, by message id.
   * Absent or without an entry: the feed's segments are the whole answer.
   */
  readonly answers?: CodingWorkbenchAnswers;
  /** The same for the model's reasoning; read only once someone opens it. */
  readonly reasoning?: CodingWorkbenchAnswers;
  readonly readReasoning?: UseCodingWorkbenchModelTextsResult["readReasoning"];
  readonly retryText?: UseCodingWorkbenchModelTextsResult["retryText"];
}

const IDLE_STATE: CodingWorkbenchSafeActivityState = {
  status: "idle",
  feed: null,
  errorCode: null,
};

export function useCodingWorkbenchSafeActivity(
  input: UseCodingWorkbenchSafeActivityInput,
): UseCodingWorkbenchSafeActivityResult {
  const { runId, runState, runtimeEventSignal, conversationId } = input;
  const [state, setState] = useState<CodingWorkbenchSafeActivityState>(IDLE_STATE);
  const [epoch, setEpoch] = useState(0);
  const runStateRef = useRef(runState);
  const batch = useSnapshotBatch(runId, runStateRef, setState);
  const retry = useCallback(() => setEpoch((value) => value + 1), []);

  useEffect(() => {
    runStateRef.current = runState;
    setState((current) => stateForLifecycle(current, runState));
  }, [runState]);
  useSettledActivityConfirmation({ runId, runState, state, setState });
  const earlierFeeds = useCodingWorkbenchEarlierRunFeeds({
    runId,
    runState,
    conversationId,
    feed: state.feed,
  });
  const texts = useCodingWorkbenchModelTexts(runId, state.feed);
  const { ingestDeltas } = texts;
  useActivityConnection({ runId, epoch, batch, runStateRef, setState, ingestDeltas });
  useActivityResync({ runId, runtimeEventSignal, status: state.status, retry });
  useActivityAutoReconnect({ runId, status: state.status, retry });
  return {
    ...state,
    earlierFeeds,
    answers: texts.answers,
    reasoning: texts.reasoning,
    readReasoning: texts.readReasoning,
    retryText: texts.retryText,
    retry,
  };
}

interface SnapshotBatch {
  readonly enqueue: (snapshot: CodingAppSessionChannelSnapshot, final?: boolean) => void;
  readonly flush: () => void;
  readonly cancel: () => void;
}

function useSnapshotBatch(
  runId: string | undefined,
  runStateRef: RefObject<CodingWorkbenchRuntimeStateName | undefined>,
  setState: Dispatch<SetStateAction<CodingWorkbenchSafeActivityState>>,
): SnapshotBatch {
  const pendingRef = useRef<CodingAppSessionChannelSnapshot | null>(null);
  const finalRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback((): void => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    pendingRef.current = null;
    finalRef.current = false;
  }, []);
  const flush = useCallback((): void => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    const pending = pendingRef.current;
    const final = finalRef.current;
    pendingRef.current = null;
    finalRef.current = false;
    if (pending !== null && runId !== undefined) {
      setState(stateFromSnapshot(pending, runId, runStateRef.current, final));
    }
  }, [runId, runStateRef, setState]);
  const enqueue = useCallback(
    (snapshot: CodingAppSessionChannelSnapshot, final = false): void => {
      pendingRef.current = snapshot;
      finalRef.current = final;
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
  readonly ingestDeltas: UseCodingWorkbenchModelTextsResult["ingestDeltas"];
}

function useActivityConnection(input: ActivityConnectionInput): void {
  const { batch, epoch, runId, runStateRef, setState, ingestDeltas } = input;
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
    const publish = (snapshot: CodingAppSessionChannelSnapshot, final?: boolean): void => {
      if (controller.signal.aborted) return;
      // Deltas are appended as they arrive: the batch below keeps only the newest snapshot.
      const content = snapshot.content;
      if (content !== null && "feed" in content) ingestDeltas(content.textDeltas);
      enqueue(snapshot, final);
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
  }, [cancel, enqueue, epoch, flush, ingestDeltas, redemptions, runId, runStateRef, setState]);
}

async function connectActivity(
  controller: AbortController,
  enqueue: (snapshot: CodingAppSessionChannelSnapshot, final?: boolean) => void,
  runStateRef: RefObject<CodingWorkbenchRuntimeStateName | undefined>,
): Promise<void> {
  await codingAppSessionPairingSettled();
  if (controller.signal.aborted) return;
  const endedBeforeRead = terminalRunState(runStateRef.current);
  // A read made once the run had settled is the run's last word on its activity.
  enqueue(await getCodingAppSessionChannelSnapshot(controller.signal), endedBeforeRead);
  // A completed run has a final snapshot, not a live connection to maintain. Keeping an SSE
  // subscription here turns a later server restart into an error on an already finished task.
  if (controller.signal.aborted || endedBeforeRead) return;
  // While this document is hidden the stream gives its connection to a visible tab's essential
  // stream; it is then reopened from a fresh snapshot once a slot is granted again.
  let resumed = false;
  while (await streamUntilYielded(controller, enqueue, resumed)) resumed = true;
}

// Resolves true when the stream gave its slot up and has to be opened again.
async function streamUntilYielded(
  controller: AbortController,
  enqueue: (snapshot: CodingAppSessionChannelSnapshot) => void,
  resumed: boolean,
): Promise<boolean> {
  const yielded = new AbortController();
  const release = await admitDirectBrowserStreamAsync(controller.signal, {
    yieldWhenHidden: true,
    onYield: () => yielded.abort(),
  });
  if (release === null) {
    if (controller.signal.aborted) return false;
    throw new Error("Workbench activity stream capacity unavailable");
  }
  try {
    // What happened while the stream was closed is read again, never assumed.
    if (resumed) enqueue(await getCodingAppSessionChannelSnapshot(controller.signal));
    await streamCodingAppSessionChannelSnapshots({
      signal: AbortSignal.any([controller.signal, yielded.signal]),
      onSnapshot: enqueue,
    });
  } catch (error) {
    // An abort the yield caused is the intended end of this connection, not a failure.
    if (!yielded.signal.aborted || controller.signal.aborted) throw error;
  } finally {
    release();
  }
  return yielded.signal.aborted && !controller.signal.aborted;
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

// A closed error identifier as the BFF names it; anything else is left out of the diagnostic.
const API_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

function markConnectionFailure(
  error: unknown,
  controller: AbortController,
  setState: Dispatch<SetStateAction<CodingWorkbenchSafeActivityState>>,
): void {
  if (controller.signal.aborted) return;
  const offline = error instanceof TypeError || globalThis.navigator?.onLine === false;
  // The timeline shows only "Activity unavailable"; the cause stays readable in the Activity Log.
  // An ApiError's code names the failure class (a snapshot the page's own contract rejects reads
  // CONTRACT_VALIDATION_FAILED, for example after an update left an old page open). It arrives in
  // a response body, so only an identifier-shaped code is recorded.
  const code = error instanceof ApiError && API_ERROR_CODE.test(error.code) ? ` ${error.code}` : "";
  reportClientDiagnostic(
    `[keiko] coding safe activity connection failed: ${clientErrorSummary(error)}${code}`,
    { correlationId: correlationIdOf(error) },
  );
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
  final: boolean,
): CodingWorkbenchSafeActivityState {
  const content = snapshot.content;
  if (
    !isSafeActivityContent(content) ||
    content.feed.runId !== runId ||
    content.feed.availability === "unavailable"
  ) {
    return missingProjectionState(runState);
  }
  return {
    status: lifecycleStatus(runState),
    feed: content.feed,
    errorCode: null,
    ...(final && terminalRunState(runState) ? { finalConfirmed: true as const } : {}),
  };
}

// #3610 (W17): no projection for this run. While the run lives that is a lost connection worth a
// reconnect; once it has finished it has ended — Stop purges the projection at once, and a
// Reconnect button could never bring anything back. No feed is held, so nothing stale is captioned.
function missingProjectionState(
  runState: CodingWorkbenchRuntimeStateName | undefined,
): CodingWorkbenchSafeActivityState {
  return {
    status: missingProjectionStatus(runState),
    feed: null,
    errorCode: null,
  };
}

// U-23: a run in recovery-required lost its projection with the process that held it (a server
// restart); Reconnect cannot bring it back, so it reads as the run needing attention, not as a lost
// connection. The channel stays open, so a projection that is rebuilt later still replaces this.
function missingProjectionStatus(
  runState: CodingWorkbenchRuntimeStateName | undefined,
): CodingWorkbenchSafeActivityStatus {
  if (terminalRunState(runState)) return "ended";
  return runState === "recovery-required" ? "recovery" : "unavailable";
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
    return (current.status === "unavailable" || current.status === "recovery") &&
      terminalRunState(runState)
      ? { ...current, status: "ended" }
      : current;
  }
  // A held feed that is still being re-read is not confirmed live (or paused, or ended) yet.
  if (failureStatus(current.status) || current.status === "loading") return current;
  const { finalConfirmed, ...rest } = current;
  return {
    ...rest,
    status: lifecycleStatus(runState),
    ...(finalConfirmed === true && terminalRunState(runState) ? { finalConfirmed } : {}),
  };
}

// A feed held from the live stream is only relabelled `ended` when its run settles. Read it once
// more then, silently: the shown feed and status stay, no loading caption and no error appears for
// this read. A failed read leaves the feed unconfirmed (the no-tools notice stays hidden) and is
// retried within the reconnect delays.
function useSettledActivityConfirmation(input: {
  readonly runId: string | undefined;
  readonly runState: CodingWorkbenchRuntimeStateName | undefined;
  readonly state: CodingWorkbenchSafeActivityState;
  readonly setState: Dispatch<SetStateAction<CodingWorkbenchSafeActivityState>>;
}): void {
  const { runId, runState, setState, state } = input;
  const unconfirmed =
    runId !== undefined &&
    terminalRunState(runState) &&
    state.status === "ended" &&
    state.feed !== null &&
    state.finalConfirmed !== true;
  useEffect(() => {
    if (!unconfirmed || runId === undefined) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (index: number): void => {
      void confirmSettledActivity(controller.signal, runId, runState, setState).then((done) => {
        if (done || controller.signal.aborted) return;
        const delay = CODING_SAFE_ACTIVITY_RECONNECT_DELAYS_MS[index];
        if (delay === undefined) {
          reportClientDiagnostic("[keiko] coding settled activity confirmation gave up");
          return;
        }
        timer = setTimeout(() => attempt(index + 1), delay);
      });
    };
    attempt(0);
    return (): void => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [unconfirmed, runId, runState, setState]);
}

// True once the run's activity was read after it settled and is held as confirmed. A read that
// fails or names no projection returns false and changes nothing on screen.
async function confirmSettledActivity(
  signal: AbortSignal,
  runId: string,
  runState: CodingWorkbenchRuntimeStateName | undefined,
  setState: Dispatch<SetStateAction<CodingWorkbenchSafeActivityState>>,
): Promise<boolean> {
  const snapshot = await getCodingAppSessionChannelSnapshot(signal).then(
    (value) => value,
    () => undefined,
  );
  if (signal.aborted) return true;
  if (snapshot === undefined) return false;
  const next = stateFromSnapshot(snapshot, runId, runState, true);
  if (next.feed === null) return false;
  setState((current) => (current.feed?.runId === runId ? next : current));
  return true;
}

function lifecycleStatus(
  runState: CodingWorkbenchRuntimeStateName | undefined,
): Extract<CodingWorkbenchSafeActivityStatus, "live" | "paused" | "recovery" | "ended"> {
  if (runState === "paused") return "paused";
  if (runState === "recovery-required") return "recovery";
  if (terminalRunState(runState)) return "ended";
  return "live";
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
