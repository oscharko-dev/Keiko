import {
  validateCodingWorkbenchRuntimeQuestionsResponse,
  type CodingWorkbenchRuntimeQuestionsResponse,
} from "@oscharko-dev/keiko-contracts";

import type {
  CodingRuntimeQuestionAnswerOperation,
  CodingRuntimeQuestionPort,
  CodingRuntimeQuestionTarget,
} from "./codingRuntimeQuestionPort.js";
import type { OpenCodeRunPort } from "./opencodeRuntimeComposition.js";
import type { CodingRuntimeRunOperation } from "./productionCodingRuntimeHost.js";
import type { ProductionRuntimeOperationGuard } from "./productionCodingRuntimePorts.js";

export function createOpenCodeRuntimeQuestionPort(
  runPort: Pick<OpenCodeRunPort, "listQuestions" | "answerQuestion" | "rejectQuestion">,
): CodingRuntimeQuestionPort {
  return {
    list: async (request): Promise<CodingWorkbenchRuntimeQuestionsResponse | undefined> => {
      const response = {
        questions: (await runPort.listQuestions(request.runId)).map(({ id, questions }) => ({
          id,
          questions,
        })),
      };
      return validateCodingWorkbenchRuntimeQuestionsResponse(response).ok ? response : undefined;
    },
    answer: (request) => runPort.answerQuestion(request.runId, request.questionId, request.answers),
    reject: (request) => runPort.rejectQuestion(request.runId, request.questionId),
  };
}

interface QuestionRunRecord {
  readonly questionPort?: CodingRuntimeQuestionPort | undefined;
  readonly operationGuard: ProductionRuntimeOperationGuard;
}

export function createProductionRuntimeQuestionPort(
  runs: ReadonlyMap<string, QuestionRunRecord>,
): CodingRuntimeQuestionPort {
  return {
    list: (request) => listRuntimeQuestions(runs, request),
    answer: (request) => answerRuntimeQuestion(runs, request),
    reject: (request) => rejectRuntimeQuestion(runs, request),
  };
}

async function listRuntimeQuestions(
  runs: ReadonlyMap<string, QuestionRunRecord>,
  request: CodingRuntimeRunOperation,
): ReturnType<CodingRuntimeQuestionPort["list"]> {
  const record = runs.get(request.runId);
  const reservation = record?.operationGuard.reserve(request);
  if (reservation === undefined) return undefined;
  if (record?.questionPort === undefined) {
    reservation.release();
    return undefined;
  }
  try {
    const questions = await record.questionPort.list(request);
    if (questions === undefined || !reservation.commit()) {
      reservation.release();
      return undefined;
    }
    return questions;
  } catch {
    reservation.release();
    return undefined;
  }
}

async function answerRuntimeQuestion(
  runs: ReadonlyMap<string, QuestionRunRecord>,
  request: CodingRuntimeQuestionAnswerOperation,
): Promise<boolean> {
  return mutateRuntimeQuestion(runs, request, (port) => port.answer(request));
}

async function rejectRuntimeQuestion(
  runs: ReadonlyMap<string, QuestionRunRecord>,
  request: CodingRuntimeQuestionTarget,
): Promise<boolean> {
  return mutateRuntimeQuestion(runs, request, (port) => port.reject(request));
}

async function mutateRuntimeQuestion(
  runs: ReadonlyMap<string, QuestionRunRecord>,
  request: CodingRuntimeQuestionTarget,
  mutate: (port: CodingRuntimeQuestionPort) => Promise<boolean>,
): Promise<boolean> {
  const record = runs.get(request.runId);
  const reservation = record?.operationGuard.reserve(request);
  if (reservation === undefined) return false;
  if (record?.questionPort === undefined) {
    reservation.release();
    return false;
  }
  try {
    const accepted = await mutate(record.questionPort);
    if (!accepted) reservation.release();
    return accepted && reservation.commit();
  } catch {
    reservation.release();
    return false;
  }
}
