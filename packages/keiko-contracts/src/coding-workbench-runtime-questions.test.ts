import { describe, expect, it } from "vitest";

import {
  parseCodingWorkbenchRuntimeQuestionAnswerRequest,
  unpairedCodingWorkbenchRuntimeQuestionsChannelPayload,
  validateCodingWorkbenchRuntimeQuestionsChannelPayload,
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

const RUNTIME_QUESTION_TEXT_SURFACES = [
  "question",
  "header",
  "label",
  "description",
  "answer",
] as const;

const UNSAFE_UNICODE_FORMAT_CHARACTERS = [
  ["RIGHT-TO-LEFT OVERRIDE", "\u202E"],
  ["ZERO WIDTH SPACE", "\u200B"],
] as const;

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

  it.each(
    UNSAFE_UNICODE_FORMAT_CHARACTERS.flatMap(([characterName, character]) =>
      RUNTIME_QUESTION_TEXT_SURFACES.map((surface) => [surface, characterName, character] as const),
    ),
  )("rejects %s text containing %s", (surface, _characterName, character) => {
    const unsafe = `visible${character}spoof`;
    if (surface === "answer") {
      expect(parseCodingWorkbenchRuntimeQuestionAnswerRequest({ answers: [[unsafe]] }).ok).toBe(
        false,
      );
      return;
    }
    const question = response.questions[0]?.questions[0];
    if (question === undefined) throw new Error("expected question fixture");
    const option = question.options[0];
    if (option === undefined) throw new Error("expected option fixture");
    const changed =
      surface === "label" || surface === "description"
        ? { ...question, options: [{ ...option, [surface]: unsafe }] }
        : { ...question, [surface]: unsafe };
    expect(
      validateCodingWorkbenchRuntimeQuestionsResponse({
        questions: [{ ...response.questions[0], questions: [changed] }],
      }).ok,
    ).toBe(false);
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

describe("coding workbench runtime questions channel payload (#2478)", () => {
  it("provides the constant content-free unpaired projection", () => {
    const unpaired = unpairedCodingWorkbenchRuntimeQuestionsChannelPayload();
    expect(unpaired).toEqual({ session: "unpaired", questions: [] });
    expect(validateCodingWorkbenchRuntimeQuestionsChannelPayload(unpaired).ok).toBe(true);
  });

  it("accepts an active payload carrying the unchanged question bounds", () => {
    expect(
      validateCodingWorkbenchRuntimeQuestionsChannelPayload({
        session: "active",
        questions: response.questions,
      }).ok,
    ).toBe(true);
    expect(
      validateCodingWorkbenchRuntimeQuestionsChannelPayload({ session: "active", questions: [] })
        .ok,
    ).toBe(true);
  });

  it("rejects question text riding on an unpaired payload", () => {
    expect(
      validateCodingWorkbenchRuntimeQuestionsChannelPayload({
        session: "unpaired",
        questions: response.questions,
      }),
    ).toMatchObject({
      ok: false,
      errors: ["questionsChannelPayload.questions must be empty when the session is unpaired"],
    });
  });

  it("rejects unknown session facets, extra keys, and unbounded questions", () => {
    expect(
      validateCodingWorkbenchRuntimeQuestionsChannelPayload({ session: "guest", questions: [] }).ok,
    ).toBe(false);
    expect(
      validateCodingWorkbenchRuntimeQuestionsChannelPayload({
        session: "active",
        questions: [],
        extra: 1,
      }).ok,
    ).toBe(false);
    expect(
      validateCodingWorkbenchRuntimeQuestionsChannelPayload({ session: "active", questions: "x" })
        .ok,
    ).toBe(false);
  });
});
