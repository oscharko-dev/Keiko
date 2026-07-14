import { describe, expect, it } from "vitest";

import {
  parseCodingWorkbenchRuntimeQuestionAnswerRequest,
  validateCodingWorkbenchRuntimeQuestionsResponse,
} from "./coding-workbench-runtime-questions.js";

const response = {
  questions: [
    {
      id: "que_1",
      questions: [
        {
          question: "Choose a bounded action",
          header: "Action",
          options: [{ label: "Continue", description: "Continue the active run." }],
        },
      ],
    },
  ],
};

describe("coding workbench runtime questions", () => {
  it("accepts bounded exact transient projections and internal answers", () => {
    expect(validateCodingWorkbenchRuntimeQuestionsResponse(response).ok).toBe(true);
    expect(parseCodingWorkbenchRuntimeQuestionAnswerRequest({ answers: [["Continue"]] }).ok).toBe(
      true,
    );
  });

  it("rejects unknown fields, duplicate identities, and unbounded text", () => {
    expect(
      validateCodingWorkbenchRuntimeQuestionsResponse({
        questions: [response.questions[0], response.questions[0]],
      }).ok,
    ).toBe(false);
    expect(
      validateCodingWorkbenchRuntimeQuestionsResponse({
        questions: [
          {
            ...response.questions[0],
            questions: [{ ...response.questions[0]?.questions[0], question: "x".repeat(4_097) }],
          },
        ],
      }).ok,
    ).toBe(false);
    expect(parseCodingWorkbenchRuntimeQuestionAnswerRequest({ answers: [["x", "x"]] }).ok).toBe(
      false,
    );
  });
});
