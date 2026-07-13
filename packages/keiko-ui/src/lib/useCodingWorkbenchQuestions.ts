"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { CodingWorkbenchRuntimeQuestionRequest } from "@oscharko-dev/keiko-contracts";

import { ApiError } from "./api";
import {
  answerCodingWorkbenchRuntimeQuestion,
  getCodingWorkbenchRuntimeQuestions,
  rejectCodingWorkbenchRuntimeQuestion,
} from "./coding-workbench-runtime-api";

export const CODING_WORKBENCH_QUESTION_POLL_MS = 2_000;

export type CodingWorkbenchQuestionsStatus =
  "loading" | "empty" | "ready" | "error" | "offline" | "submitting" | "stale" | "terminal";

export interface CodingWorkbenchQuestionsState {
  readonly status: CodingWorkbenchQuestionsStatus;
  readonly questions: readonly CodingWorkbenchRuntimeQuestionRequest[];
  readonly errorCode: string | null;
}

export interface UseCodingWorkbenchQuestionsInput {
  readonly runId: string | undefined;
  readonly active: boolean;
  readonly terminal: boolean;
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

export function useCodingWorkbenchQuestions({
  runId,
  active,
  terminal,
}: UseCodingWorkbenchQuestionsInput): UseCodingWorkbenchQuestionsResult {
  const [state, setState] = useState<CodingWorkbenchQuestionsState>(EMPTY_STATE);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const submissionRef = useRef(false);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const consumedRef = useRef(new Set<string>());

  useEffect(() => {
    consumedRef.current.clear();
    cancelQuestionMutation(mutationAbortRef, submissionRef);
    return () => cancelQuestionMutation(mutationAbortRef, submissionRef);
  }, [runId]);
  useEffect(() => {
    if (active) return;
    cancelQuestionMutation(mutationAbortRef, submissionRef);
  }, [active]);

  useQuestionPolling({ runId, active, terminal, refreshEpoch, consumedRef, setState });
  const mutate = useQuestionMutation({
    runId,
    active,
    submissionRef,
    mutationAbortRef,
    consumedRef,
    setState,
  });
  return {
    ...state,
    answer: (questionId, answers) => mutate("answer", questionId, answers),
    reject: (questionId) => mutate("reject", questionId),
    retry: () => setRefreshEpoch((value) => value + 1),
  };
}

function cancelQuestionMutation(
  abortRef: MutableRefObject<AbortController | null>,
  submissionRef: MutableRefObject<boolean>,
): void {
  abortRef.current?.abort();
  abortRef.current = null;
  submissionRef.current = false;
}

interface PollingInput extends UseCodingWorkbenchQuestionsInput {
  readonly refreshEpoch: number;
  readonly consumedRef: MutableRefObject<Set<string>>;
  readonly setState: Dispatch<SetStateAction<CodingWorkbenchQuestionsState>>;
}

function useQuestionPolling(input: PollingInput): void {
  const { active, consumedRef, refreshEpoch, runId, setState, terminal } = input;
  useEffect(() => {
    if (!active || runId === undefined) {
      setState(terminal ? { ...EMPTY_STATE, status: "terminal" } : EMPTY_STATE);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    setState((current) =>
      current.status === "ready" ? current : { ...current, status: "loading", errorCode: null },
    );
    const poll = async (): Promise<void> => {
      controller = new AbortController();
      try {
        const response = await getCodingWorkbenchRuntimeQuestions(runId, controller.signal);
        if (!disposed) setState(questionResponseState(response.questions, consumedRef));
      } catch (error) {
        if (!disposed && !controller.signal.aborted) setState(questionFailureState(error));
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), CODING_WORKBENCH_QUESTION_POLL_MS);
      }
    };
    void poll();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, consumedRef, refreshEpoch, runId, setState, terminal]);
}

function questionResponseState(
  questions: readonly CodingWorkbenchRuntimeQuestionRequest[],
  consumedRef: MutableRefObject<Set<string>>,
): CodingWorkbenchQuestionsState {
  const upstreamIds = new Set(questions.map(({ id }) => id));
  for (const id of consumedRef.current) if (!upstreamIds.has(id)) consumedRef.current.delete(id);
  const visible = questions.filter(({ id }) => !consumedRef.current.has(id));
  return { status: visible.length === 0 ? "empty" : "ready", questions: visible, errorCode: null };
}

function questionFailureState(error: unknown): CodingWorkbenchQuestionsState {
  const offline = error instanceof TypeError || globalThis.navigator?.onLine === false;
  return {
    status: offline ? "offline" : "error",
    questions: [],
    errorCode: error instanceof ApiError ? error.code : "CODING_RUNTIME_QUESTION_FAILED",
  };
}

interface MutationInput {
  readonly runId: string | undefined;
  readonly active: boolean;
  readonly submissionRef: MutableRefObject<boolean>;
  readonly mutationAbortRef: MutableRefObject<AbortController | null>;
  readonly consumedRef: MutableRefObject<Set<string>>;
  readonly setState: Dispatch<SetStateAction<CodingWorkbenchQuestionsState>>;
}

function useQuestionMutation(
  input: MutationInput,
): (
  action: "answer" | "reject",
  questionId: string,
  answers?: readonly (readonly string[])[],
) => Promise<boolean> {
  return useCallback(
    async (action, questionId, answers = []): Promise<boolean> => {
      if (!input.active || input.runId === undefined || input.submissionRef.current) return false;
      input.submissionRef.current = true;
      const controller = new AbortController();
      input.mutationAbortRef.current = controller;
      input.setState((current) => ({ ...current, status: "submitting", errorCode: null }));
      try {
        if (action === "answer") {
          await answerCodingWorkbenchRuntimeQuestion(
            input.runId,
            questionId,
            { answers },
            controller.signal,
          );
        } else
          await rejectCodingWorkbenchRuntimeQuestion(input.runId, questionId, controller.signal);
        input.consumedRef.current.add(questionId);
        input.setState((current) => ({
          status: "stale",
          questions: current.questions.filter(({ id }) => id !== questionId),
          errorCode: null,
        }));
        return true;
      } catch (error) {
        if (controller.signal.aborted) return false;
        input.setState(
          error instanceof ApiError && error.status === 409
            ? staleState
            : questionFailureState(error),
        );
        return false;
      } finally {
        if (input.mutationAbortRef.current === controller) {
          input.submissionRef.current = false;
          input.mutationAbortRef.current = null;
        }
      }
    },
    [input],
  );
}

function staleState(current: CodingWorkbenchQuestionsState): CodingWorkbenchQuestionsState {
  return {
    ...current,
    status: "stale",
    questions: [],
    errorCode: "CODING_RUNTIME_QUESTION_STALE",
  };
}
