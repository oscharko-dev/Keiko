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

describe("coding workbench runtime questions failure branches", () => {
  function request(id: string, question: string): Record<string, unknown> {
    return {
      id,
      questions: [
        { question, header: "Action", options: [{ label: "Go", description: "Proceed." }] },
      ],
    };
  }

  it("rejects a non-array or overflowing question request list", () => {
    expect(validateCodingWorkbenchRuntimeQuestionsResponse({ questions: "none" })).toMatchObject({
      ok: false,
      errors: ["questions must be a bounded array"],
    });
    const overflowing = Array.from({ length: 257 }, (_, index) =>
      request(`que_${String(index)}`, "Pick one"),
    );
    expect(
      validateCodingWorkbenchRuntimeQuestionsResponse({ questions: overflowing }),
    ).toMatchObject({ ok: false, errors: ["questions must be a bounded array"] });
  });

  it("rejects responses whose bounded fields still exceed the aggregate byte budget", () => {
    const questions = Array.from({ length: 20 }, (_, index) =>
      request(`que_${String(index)}`, "q".repeat(4_096)),
    );
    expect(validateCodingWorkbenchRuntimeQuestionsResponse({ questions })).toMatchObject({
      ok: false,
      errors: ["questions response exceeds the aggregate UTF-8 byte budget"],
    });
  });

  it("treats a serialization-hostile response as exceeding the byte budget", () => {
    let reads = 0;
    const hostile = {
      id: "que_1",
      get questions(): readonly Record<string, unknown>[] {
        reads += 1;
        if (reads > 1) throw new Error("hostile serialization");
        return [
          {
            question: "Pick one",
            header: "Action",
            options: [{ label: "Go", description: "Proceed." }],
          },
        ];
      },
    };
    expect(validateCodingWorkbenchRuntimeQuestionsResponse({ questions: [hostile] })).toMatchObject(
      {
        ok: false,
        errors: ["questions response exceeds the aggregate UTF-8 byte budget"],
      },
    );
  });

  it("rejects malformed request entries, question lists, and questions", () => {
    expect(validateCodingWorkbenchRuntimeQuestionsResponse({ questions: ["nope"] })).toMatchObject({
      ok: false,
      errors: ["questions[0] must be an object"],
    });
    expect(
      validateCodingWorkbenchRuntimeQuestionsResponse({
        questions: [{ id: "que_1", questions: [] }],
      }),
    ).toMatchObject({
      ok: false,
      errors: ["questions[0].questions must be a bounded non-empty array"],
    });
    expect(
      validateCodingWorkbenchRuntimeQuestionsResponse({
        questions: [{ id: "que_1", questions: ["nope"] }],
      }),
    ).toMatchObject({ ok: false, errors: ["questions[0].questions[0] must be an object"] });
  });

  it("rejects malformed flags, option lists, and option entries", () => {
    const flagged = request("que_1", "Pick one");
    const [question] = flagged.questions as Record<string, unknown>[];
    expect(
      validateCodingWorkbenchRuntimeQuestionsResponse({
        questions: [{ ...flagged, questions: [{ ...question, multiple: "yes" }] }],
      }),
    ).toMatchObject({
      ok: false,
      errors: ["questions[0].questions[0].multiple must be a boolean"],
    });
    expect(
      validateCodingWorkbenchRuntimeQuestionsResponse({
        questions: [{ ...flagged, questions: [{ ...question, options: "none" }] }],
      }),
    ).toMatchObject({
      ok: false,
      errors: ["questions[0].questions[0].options must be a bounded array"],
    });
    expect(
      validateCodingWorkbenchRuntimeQuestionsResponse({
        questions: [{ ...flagged, questions: [{ ...question, options: ["nope"] }] }],
      }),
    ).toMatchObject({
      ok: false,
      errors: ["questions[0].questions[0].options[0] must be an object"],
    });
  });

  it("rejects non-array and overflowing answers", () => {
    expect(parseCodingWorkbenchRuntimeQuestionAnswerRequest({ answers: "yes" })).toMatchObject({
      ok: false,
      errors: ["answers must be a bounded non-empty array"],
    });
    expect(parseCodingWorkbenchRuntimeQuestionAnswerRequest({ answers: [] })).toMatchObject({
      ok: false,
      errors: ["answers must be a bounded non-empty array"],
    });
    expect(
      parseCodingWorkbenchRuntimeQuestionAnswerRequest({
        answers: Array.from({ length: 33 }, () => ["ok"]),
      }),
    ).toMatchObject({ ok: false, errors: ["answers must be a bounded non-empty array"] });
  });
});
