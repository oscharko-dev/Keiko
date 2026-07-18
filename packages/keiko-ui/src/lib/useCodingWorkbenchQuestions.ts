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
  CodingWorkbenchRuntimeQuestionRequest,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";

import { ApiError } from "./api";
import {
  answerCodingWorkbenchRuntimeQuestion,
  listCodingWorkbenchRuntimeQuestions,
  newCodingWorkbenchRuntimeRequestId,
  rejectCodingWorkbenchRuntimeQuestion,
} from "./coding-workbench-runtime-api";

const TERMINAL_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
]);

export type CodingWorkbenchQuestionsStatus =
  | "loading"
  | "empty"
  | "ready"
  | "error"
  | "offline"
  | "submitting"
  | "stale"
  | "terminal"
  /** The presented app-session cookie is not valid (#2478): honest re-pair state, never a silent empty list. */
  | "unpaired";

export interface CodingWorkbenchQuestionsState {
  readonly status: CodingWorkbenchQuestionsStatus;
  readonly questions: readonly CodingWorkbenchRuntimeQuestionRequest[];
  readonly errorCode: string | null;
}

export interface UseCodingWorkbenchQuestionsInput {
  readonly runId: string | undefined;
  readonly revision: number | undefined;
  readonly runState: CodingWorkbenchRuntimeStateName | undefined;
  /**
   * Count of content-free runtime events observed on the run's SSE stream. Question state only
   * changes alongside runtime activity (the managed runtime publishes a content-free observation
   * when a question is raised or settled), so a change here re-lists the pending questions.
   */
  readonly runtimeEventCount: number;
  /** Re-anchor the parent snapshot after the server advances its own revision on every operation. */
  readonly refreshSnapshot: () => Promise<void>;
}

export interface UseCodingWorkbenchQuestionsResult extends CodingWorkbenchQuestionsState {
  readonly answer: (
    questionId: string,
    answers: readonly (readonly string[])[],
  ) => Promise<boolean>;
  readonly reject: (questionId: string) => Promise<boolean>;
  readonly retry: () => void;
}

const EMPTY_STATE: CodingWorkbenchQuestionsState = {
  status: "empty",
  questions: [],
  errorCode: null,
};

interface QuestionContext {
  readonly runId: string;
  readonly revisionRef: RefObject<number>;
  readonly refreshSnapshot: () => Promise<void>;
  readonly submissionRef: RefObject<boolean>;
  readonly abortRef: RefObject<AbortController | null>;
  readonly consumedRef: RefObject<Set<string>>;
  readonly setState: Dispatch<SetStateAction<CodingWorkbenchQuestionsState>>;
  readonly bumpEpoch: () => void;
}

export function useCodingWorkbenchQuestions(
  input: UseCodingWorkbenchQuestionsInput,
): UseCodingWorkbenchQuestionsResult {
  const { runId, revision, runState, runtimeEventCount, refreshSnapshot } = input;
  const active = isActive(runState, revision, runId);
  const terminal = runId !== undefined && TERMINAL_STATES.has(runState ?? "idle");
  const [state, setState] = useState<CodingWorkbenchQuestionsState>(EMPTY_STATE);
  const [epoch, setEpoch] = useState(0);
  const bumpEpoch = useCallback(() => {
    setEpoch((value) => value + 1);
  }, []);
  const revisionRef = useRef(revision ?? 0);
  const submissionRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const consumedRef = useRef(new Set<string>());
  useEffect(() => {
    revisionRef.current = revision ?? 0;
  }, [revision]);
  useEffect(() => {
    consumedRef.current.clear();
    cancelMutation(abortRef, submissionRef);
    return () => cancelMutation(abortRef, submissionRef);
  }, [runId]);

  useQuestionListing({
    active,
    terminal,
    epoch,
    runId,
    revisionRef,
    refreshSnapshot,
    consumedRef,
    setState,
  });
  useQuestionResync({ active, runState, runtimeEventCount, bumpEpoch });
  const context: QuestionContext | null =
    active && runId !== undefined
      ? {
          runId,
          revisionRef,
          refreshSnapshot,
          submissionRef,
          abortRef,
          consumedRef,
          setState,
          bumpEpoch,
        }
      : null;
  const mutate = useQuestionMutation(context);
  return {
    ...state,
    answer: (questionId, answers) => mutate("answer", questionId, answers),
    reject: (questionId) => mutate("reject", questionId),
    retry: bumpEpoch,
  };
}

const RESYNC_DEBOUNCE_MS = 400;

/**
 * Question state changes are pushed only as content-free runtime events (a question raised or
 * settled inside the managed runtime), and pausing/resuming can also settle or reveal questions.
 * Re-list shortly after such a signal instead of polling; the debounce coalesces event bursts.
 */
function useQuestionResync(input: {
  readonly active: boolean;
  readonly runState: CodingWorkbenchRuntimeStateName | undefined;
  readonly runtimeEventCount: number;
  readonly bumpEpoch: () => void;
}): void {
  const { active, runState, runtimeEventCount, bumpEpoch } = input;
  const seenRef = useRef({ count: runtimeEventCount, state: runState });
  useEffect(() => {
    const changed =
      seenRef.current.count !== runtimeEventCount || seenRef.current.state !== runState;
    seenRef.current = { count: runtimeEventCount, state: runState };
    if (!active || !changed) return undefined;
    const timer = setTimeout(bumpEpoch, RESYNC_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [active, runState, runtimeEventCount, bumpEpoch]);
}

function isActive(
  runState: CodingWorkbenchRuntimeStateName | undefined,
  revision: number | undefined,
  runId: string | undefined,
): boolean {
  return (
    runId !== undefined &&
    revision !== undefined &&
    (runState === "running" || runState === "paused")
  );
}

function cancelMutation(
  abortRef: RefObject<AbortController | null>,
  submissionRef: RefObject<boolean>,
): void {
  abortRef.current?.abort();
  abortRef.current = null;
  submissionRef.current = false;
}

interface ListingInput {
  readonly active: boolean;
  readonly terminal: boolean;
  readonly epoch: number;
  readonly runId: string | undefined;
  readonly revisionRef: RefObject<number>;
  readonly refreshSnapshot: () => Promise<void>;
  readonly consumedRef: RefObject<Set<string>>;
  readonly setState: Dispatch<SetStateAction<CodingWorkbenchQuestionsState>>;
}

function useQuestionListing(input: ListingInput): void {
  const { active, consumedRef, epoch, refreshSnapshot, runId, revisionRef, setState, terminal } =
    input;
  useEffect(() => {
    if (!active || runId === undefined) {
      setState(terminal ? { ...EMPTY_STATE, status: "terminal" } : EMPTY_STATE);
      return;
    }
    let disposed = false;
    const controller = new AbortController();
    setState((current) =>
      current.status === "ready" ? current : { ...current, status: "loading", errorCode: null },
    );
    void (async (): Promise<void> => {
      try {
        const response = await listCodingWorkbenchRuntimeQuestions(
          runId,
          {
            requestId: newCodingWorkbenchRuntimeRequestId(),
            expectedRevision: revisionRef.current,
          },
          controller.signal,
        );
        if (response.session === "unpaired") {
          // #2478: the server answered before touching the run, so the revision did not advance —
          // no snapshot re-anchor is needed; surface the honest re-pair state instead.
          if (!disposed) setState({ status: "unpaired", questions: [], errorCode: null });
          return;
        }
        if (!disposed) setState(listedState(response.questions, consumedRef));
        await refreshSnapshot();
      } catch (error) {
        if (!disposed && !controller.signal.aborted) setState(failureState(error));
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [active, consumedRef, epoch, refreshSnapshot, runId, revisionRef, setState, terminal]);
}

function listedState(
  questions: readonly CodingWorkbenchRuntimeQuestionRequest[],
  consumedRef: RefObject<Set<string>>,
): CodingWorkbenchQuestionsState {
  const upstream = new Set(questions.map(({ id }) => id));
  for (const id of consumedRef.current) if (!upstream.has(id)) consumedRef.current.delete(id);
  const visible = questions.filter(({ id }) => !consumedRef.current.has(id));
  return {
    status: visible.length === 0 ? "empty" : "ready",
    questions: visible,
    errorCode: null,
  };
}

function failureState(error: unknown): CodingWorkbenchQuestionsState {
  const offline = error instanceof TypeError || globalThis.navigator?.onLine === false;
  return {
    status: offline ? "offline" : "error",
    questions: [],
    errorCode: error instanceof ApiError ? error.code : "CODING_RUNTIME_QUESTION_FAILED",
  };
}

function useQuestionMutation(
  context: QuestionContext | null,
): (
  action: "answer" | "reject",
  questionId: string,
  answers?: readonly (readonly string[])[],
) => Promise<boolean> {
  return useCallback(
    async (action, questionId, answers = []): Promise<boolean> => {
      if (context === null || context.submissionRef.current) return false;
      context.submissionRef.current = true;
      const controller = new AbortController();
      context.abortRef.current = controller;
      context.setState((current) => ({ ...current, status: "submitting", errorCode: null }));
      try {
        await runQuestionMutation(context, controller, action, questionId, answers);
        context.consumedRef.current.add(questionId);
        context.setState((current) => ({
          status: "stale",
          questions: current.questions.filter(({ id }) => id !== questionId),
          errorCode: null,
        }));
        await context.refreshSnapshot();
        context.bumpEpoch();
        return true;
      } catch (error) {
        if (controller.signal.aborted) return false;
        context.setState(mutationFailureState(error));
        return false;
      } finally {
        if (context.abortRef.current === controller) {
          context.submissionRef.current = false;
          context.abortRef.current = null;
        }
      }
    },
    [context],
  );
}

function runQuestionMutation(
  context: QuestionContext,
  controller: AbortController,
  action: "answer" | "reject",
  questionId: string,
  answers: readonly (readonly string[])[],
): Promise<unknown> {
  const envelope = {
    requestId: newCodingWorkbenchRuntimeRequestId(),
    expectedRevision: context.revisionRef.current,
    questionId,
  };
  return action === "answer"
    ? answerCodingWorkbenchRuntimeQuestion(
        context.runId,
        { ...envelope, answers },
        controller.signal,
      )
    : rejectCodingWorkbenchRuntimeQuestion(context.runId, envelope, controller.signal);
}

function mutationFailureState(error: unknown): CodingWorkbenchQuestionsState {
  if (error instanceof ApiError && (error.status === 409 || error.status === 400)) {
    return { status: "stale", questions: [], errorCode: "CODING_RUNTIME_QUESTION_STALE" };
  }
  return failureState(error);
}
