import {
  validateCodingWorkbenchRuntimeQuestionsResponse,
  type CodingWorkbenchRuntimeQuestionsResponse,
} from "@oscharko-dev/keiko-contracts";

import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";
import type { OpenCodeRunPort } from "./opencodeRuntimeComposition.js";

interface ProductionQuestionRun {
  readonly composition: {
    readonly runPort: Pick<OpenCodeRunPort, "listQuestions" | "answerQuestion" | "rejectQuestion">;
  };
}

export function createProductionOpenCodeQuestionPort(
  runs: ReadonlyMap<string, ProductionQuestionRun>,
): CodingRuntimeQuestionPort {
  return {
    list: async (runId): Promise<CodingWorkbenchRuntimeQuestionsResponse | undefined> => {
      const run = runs.get(runId);
      if (run === undefined) return undefined;
      const questions = (await run.composition.runPort.listQuestions(runId)).map(
        ({ id, questions: prompts }) => ({ id, questions: prompts }),
      );
      const response = { questions };
      return validateCodingWorkbenchRuntimeQuestionsResponse(response).ok ? response : undefined;
    },
    answer: (runId, questionId, answers) =>
      runs.get(runId)?.composition.runPort.answerQuestion(runId, questionId, answers) ??
      Promise.resolve(false),
    reject: (runId, questionId) =>
      runs.get(runId)?.composition.runPort.rejectQuestion(runId, questionId) ??
      Promise.resolve(false),
  };
}
