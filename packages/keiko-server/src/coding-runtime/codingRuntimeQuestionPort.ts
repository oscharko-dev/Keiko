import type {
  CodingWorkbenchRuntimeQuestionAnswerRequest,
  CodingWorkbenchRuntimeQuestionsResponse,
} from "@oscharko-dev/keiko-contracts";

/** Transient active-run question controls. Implementations must not retain question content. */
export interface CodingRuntimeQuestionPort {
  readonly list: (runId: string) => Promise<CodingWorkbenchRuntimeQuestionsResponse | undefined>;
  readonly answer: (
    runId: string,
    questionId: string,
    answers: CodingWorkbenchRuntimeQuestionAnswerRequest["answers"],
  ) => Promise<boolean>;
  readonly reject: (runId: string, questionId: string) => Promise<boolean>;
}
