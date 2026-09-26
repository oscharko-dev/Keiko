import type { CodingWorkbenchRuntimeQuestionsResponse } from "@oscharko-dev/keiko-contracts";
import type { CodingRuntimeRunOperation } from "./productionCodingRuntimeHost.js";

export interface CodingRuntimeQuestionTarget extends CodingRuntimeRunOperation {
  readonly questionId: string;
}

export interface CodingRuntimeQuestionAnswerOperation extends CodingRuntimeQuestionTarget {
  readonly answers: readonly (readonly string[])[];
}

/** Only a validated pending question can establish that the answer itself is incompatible. */
export class CodingRuntimeQuestionAnswerRejectedError extends Error {
  public constructor() {
    super("question-answer-rejected");
    this.name = "CodingRuntimeQuestionAnswerRejectedError";
  }
}

/** Transient active-run question controls. Implementations must not retain question content. */
export interface CodingRuntimeQuestionPort {
  readonly list: (
    request: CodingRuntimeRunOperation,
  ) => Promise<CodingWorkbenchRuntimeQuestionsResponse | undefined>;
  // False means unavailable/unauthorized; only the typed error denotes an incompatible answer.
  readonly answer: (request: CodingRuntimeQuestionAnswerOperation) => Promise<boolean>;
  readonly reject: (request: CodingRuntimeQuestionTarget) => Promise<boolean>;
}
