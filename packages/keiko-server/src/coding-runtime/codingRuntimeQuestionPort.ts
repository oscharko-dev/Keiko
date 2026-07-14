import type { CodingWorkbenchRuntimeQuestionsResponse } from "@oscharko-dev/keiko-contracts";
import type { CodingRuntimeRunOperation } from "./productionCodingRuntimeHost.js";

export interface CodingRuntimeQuestionTarget extends CodingRuntimeRunOperation {
  readonly questionId: string;
}

export interface CodingRuntimeQuestionAnswerOperation extends CodingRuntimeQuestionTarget {
  readonly answers: readonly (readonly string[])[];
}

/** Transient active-run question controls. Implementations must not retain question content. */
export interface CodingRuntimeQuestionPort {
  readonly list: (
    request: CodingRuntimeRunOperation,
  ) => Promise<CodingWorkbenchRuntimeQuestionsResponse | undefined>;
  readonly answer: (request: CodingRuntimeQuestionAnswerOperation) => Promise<boolean>;
  readonly reject: (request: CodingRuntimeQuestionTarget) => Promise<boolean>;
}
