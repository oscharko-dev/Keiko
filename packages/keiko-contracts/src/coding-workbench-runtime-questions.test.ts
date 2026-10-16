import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { CodingWorkbenchValidationResult } from "@oscharko-dev/keiko-contracts";
import {
  parseCodingWorkbenchRuntimeQuestionAnswerRequest as publicQuestionAnswer,
  validateCodingWorkbenchRuntimeQuestionsChannelPayload as publicQuestionsChannel,
  validateCodingWorkbenchRuntimeQuestionsResponse as publicQuestionsResponse,
  type CodingWorkbenchRuntimeQuestionAnswerRequest,
  type CodingWorkbenchRuntimeQuestionsChannelPayload,
  type CodingWorkbenchRuntimeQuestionsResponse,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-questions";

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

// Bound to the observed revision and the exact question-request id (KEIKO-0411), matching the
// approval-decision and research-revoke request contracts.
const VALID_ANSWER_BASE = {
  requestId: "req-1",
  expectedRevision: 0,
  questionId: "que_1",
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
    expect(
      parseCodingWorkbenchRuntimeQuestionAnswerRequest({
        ...VALID_ANSWER_BASE,
        answers: [["Continue"]],
      }).ok,
    ).toBe(true);
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
    expect(
      parseCodingWorkbenchRuntimeQuestionAnswerRequest({
        ...VALID_ANSWER_BASE,
        answers: [["x", "x"]],
      }).ok,
    ).toBe(false);
  });

  it.each(
    UNSAFE_UNICODE_FORMAT_CHARACTERS.flatMap(([characterName, character]) =>
      RUNTIME_QUESTION_TEXT_SURFACES.map((surface) => [surface, characterName, character] as const),
    ),
  )("rejects %s text containing %s", (surface, _characterName, character) => {
    const unsafe = `visible${character}spoof`;
    if (surface === "answer") {
      expect(
        parseCodingWorkbenchRuntimeQuestionAnswerRequest({
          ...VALID_ANSWER_BASE,
          answers: [[unsafe]],
        }).ok,
      ).toBe(false);
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
    expect(
      parseCodingWorkbenchRuntimeQuestionAnswerRequest({ ...VALID_ANSWER_BASE, answers: "yes" }),
    ).toMatchObject({
      ok: false,
      errors: ["answers must be a bounded non-empty array"],
    });
    expect(
      parseCodingWorkbenchRuntimeQuestionAnswerRequest({ ...VALID_ANSWER_BASE, answers: [] }),
    ).toMatchObject({
      ok: false,
      errors: ["answers must be a bounded non-empty array"],
    });
    expect(
      parseCodingWorkbenchRuntimeQuestionAnswerRequest({
        ...VALID_ANSWER_BASE,
        answers: Array.from({ length: 33 }, () => ["ok"]),
      }),
    ).toMatchObject({ ok: false, errors: ["answers must be a bounded non-empty array"] });
  });

  it("rejects a body lacking expectedRevision, a malformed requestId, or an invalid questionId (KEIKO-0411)", () => {
    expect(
      parseCodingWorkbenchRuntimeQuestionAnswerRequest({
        requestId: VALID_ANSWER_BASE.requestId,
        questionId: VALID_ANSWER_BASE.questionId,
        answers: [["Continue"]],
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseCodingWorkbenchRuntimeQuestionAnswerRequest({
        ...VALID_ANSWER_BASE,
        expectedRevision: -1,
        answers: [["Continue"]],
      }),
    ).toMatchObject({
      ok: false,
      errors: ["expectedRevision must be a non-negative safe integer"],
    });
    expect(
      parseCodingWorkbenchRuntimeQuestionAnswerRequest({
        ...VALID_ANSWER_BASE,
        requestId: "../forged",
        answers: [["Continue"]],
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseCodingWorkbenchRuntimeQuestionAnswerRequest({
        ...VALID_ANSWER_BASE,
        questionId: "not-a-question-id",
        answers: [["Continue"]],
      }),
    ).toMatchObject({ ok: false, errors: ["questionId is invalid"] });
  });

  it("rejects answers whose serialized size exceeds the aggregate UTF-8 byte budget even though every individual array is within its own per-item caps (KEIKO-0411)", () => {
    // 32 answer arrays x 32 selections x 4096 chars each is within every per-item bound this
    // module already enforced, and is still ~65x CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES
    // (64 KiB) — exactly the asymmetry KEIKO-0411 reported against the outbound budget
    // checkBoundedQuestionRequests already applies.
    const oversized = Array.from({ length: 32 }, (_, arrayIndex) =>
      Array.from(
        { length: 32 },
        (_, selectionIndex) =>
          `${String(arrayIndex)}-${String(selectionIndex)}-${"a".repeat(4_090)}`,
      ),
    );
    expect(
      parseCodingWorkbenchRuntimeQuestionAnswerRequest({
        ...VALID_ANSWER_BASE,
        answers: oversized,
      }),
    ).toMatchObject({ ok: false, errors: ["answers exceed the aggregate UTF-8 byte budget"] });
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

describe("coding workbench runtime questions module structure (KEIKO-0532)", () => {
  it("does not re-declare a local isQuestionId now that isCodeTaskQuestionId is imported from code-task-governance.ts", () => {
    // isQuestionId used to be a local copy of code-task-governance.ts's isCodeTaskQuestionId
    // (same `que_...` pattern). This module now imports the shared guard instead of keeping its
    // own copy; a re-introduced local declaration must fail this pin.
    const source = readFileSync(
      fileURLToPath(new URL("./coding-workbench-runtime-questions.ts", import.meta.url)),
      "utf8",
    );
    expect(/^function isQuestionId/m.test(source)).toBe(false);
  });
});

describe("C2 owning question member admissions", () => {
  it.each(["requests", "questions", "options"] as const)(
    "refuses skipped malformed %s",
    (surface) => {
      const entries: unknown[] = [null];
      Object.defineProperty(entries, "forEach", { value: (): void => undefined });
      const request = response.questions[0];
      const question = request?.questions[0];
      if (request === undefined || question === undefined)
        throw new Error("expected question fixture");
      const value =
        surface === "requests"
          ? { questions: entries }
          : surface === "questions"
            ? { questions: [{ ...request, questions: entries }] }
            : { questions: [{ ...request, questions: [{ ...question, options: entries }] }] };
      expect(validateCodingWorkbenchRuntimeQuestionsResponse(value).ok).toBe(false);
    },
  );

  it("refuses skipped malformed answer lists", () => {
    const answers: unknown[] = [null];
    Object.defineProperty(answers, "forEach", { value: (): void => undefined });
    expect(
      parseCodingWorkbenchRuntimeQuestionAnswerRequest({ ...VALID_ANSWER_BASE, answers }).ok,
    ).toBe(false);
  });

  it("refuses a numeric selection hidden by the caller's every", () => {
    const answer: unknown[] = [3];
    Object.defineProperty(answer, "every", { value: (): boolean => true });
    expect(
      parseCodingWorkbenchRuntimeQuestionAnswerRequest({ ...VALID_ANSWER_BASE, answers: [answer] })
        .ok,
    ).toBe(false);
  });

  it("retains a healthy response and its nested collection references", () => {
    const result = validateCodingWorkbenchRuntimeQuestionsResponse(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(response);
      expect(result.value.questions).toBe(response.questions);
    }
  });

  it.each(["0", null, Number.NaN, Number.POSITIVE_INFINITY, 0.5])(
    "refuses an invalid observed second revision",
    (second) => {
      let reads = 0;
      const value = { ...VALID_ANSWER_BASE, answers: [["Continue"]] };
      Object.defineProperty(value, "expectedRevision", {
        get: (): unknown => (++reads === 1 ? 0 : second),
      });
      expect(parseCodingWorkbenchRuntimeQuestionAnswerRequest(value).ok).toBe(false);
      expect(reads).toBe(2);
    },
  );
});

type PublicQuestionAnswerParse =
  CodingWorkbenchValidationResult<CodingWorkbenchRuntimeQuestionAnswerRequest>;
type PublicQuestionsResponseParse =
  CodingWorkbenchValidationResult<CodingWorkbenchRuntimeQuestionsResponse>;
type PublicQuestionsChannelParse =
  CodingWorkbenchValidationResult<CodingWorkbenchRuntimeQuestionsChannelPayload>;

export function parsePublicRuntimeQuestionAnswer(input: unknown): PublicQuestionAnswerParse {
  const result = publicQuestionAnswer(input);
  return result;
}

export function parsePublicRuntimeQuestionsResponse(input: unknown): PublicQuestionsResponseParse {
  const result = publicQuestionsResponse(input);
  return result;
}

export function parsePublicRuntimeQuestionsChannel(input: unknown): PublicQuestionsChannelParse {
  const result = publicQuestionsChannel(input);
  return result;
}

describe("runtime question answer public parser (#3918)", () => {
  it("forwards the checked original answer and nested selections", () => {
    const input = { ...VALID_ANSWER_BASE, answers: [["Continue"]] };
    const result = parsePublicRuntimeQuestionAnswer(input);
    expect(result).toEqual({ ok: true, value: input });
    if (!result.ok) throw new TypeError("healthy public answer refused");
    expect(result.value).toBe(input);
    expect(result.value.answers).toBe(input.answers);
    expect(result.value.answers[0]).toBe(input.answers[0]);
  });

  it("refuses malformed bodies with exact eager ordered diagnostics", () => {
    for (const input of [null, [], "answer", 1])
      expect(parsePublicRuntimeQuestionAnswer(input)).toEqual({
        ok: false,
        errors: ["question answer must be an object"],
      });
    expect(
      parsePublicRuntimeQuestionAnswer({
        requestId: "!",
        expectedRevision: -1,
        questionId: "",
        answers: "invalid",
        extra: true,
      }),
    ).toEqual({
      ok: false,
      errors: [
        "questionAnswer.extra is not allowed",
        "requestId must be a bounded safe identifier",
        "expectedRevision must be a non-negative safe integer",
        "questionId is invalid",
        "answers must be a bounded non-empty array",
      ],
    });
  });

  it("retains the public second revision observation refusal", () => {
    let reads = 0;
    const input = {
      ...VALID_ANSWER_BASE,
      answers: [["Continue"]],
      get expectedRevision(): unknown {
        return ++reads === 1 ? 0 : "0";
      },
    };
    expect(parsePublicRuntimeQuestionAnswer(input)).toEqual({
      ok: false,
      errors: ["expectedRevision must be a non-negative safe integer"],
    });
    expect(reads).toBe(2);
  });

  it("pins source public and forwarding checked return types", () => {
    expectTypeOf(
      parseCodingWorkbenchRuntimeQuestionAnswerRequest,
    ).returns.toEqualTypeOf<PublicQuestionAnswerParse>();
    expectTypeOf(publicQuestionAnswer).returns.toEqualTypeOf<PublicQuestionAnswerParse>();
    expectTypeOf(
      parsePublicRuntimeQuestionAnswer,
    ).returns.toEqualTypeOf<PublicQuestionAnswerParse>();
    const result = parsePublicRuntimeQuestionAnswer({
      ...VALID_ANSWER_BASE,
      answers: [["Continue"]],
    });
    if (!result.ok) throw new TypeError("healthy public answer types refused");
    expectTypeOf(result.value.expectedRevision).toEqualTypeOf<number>();
    expectTypeOf(result.value.answers).toEqualTypeOf<readonly (readonly string[])[]>();
    type Failure = Extract<ReturnType<typeof publicQuestionAnswer>, { readonly ok: false }>;
    expectTypeOf<Failure["errors"]>().toEqualTypeOf<readonly string[]>();
  });
});

describe("runtime questions response public parser (#3918)", () => {
  it("retains the admitted response and nested question references", () => {
    const result = parsePublicRuntimeQuestionsResponse(response);
    expect(result).toEqual({ ok: true, value: response });
    if (!result.ok) throw new TypeError("healthy public response refused");
    expect(result.value).toBe(response);
    expect(result.value.questions).toBe(response.questions);
    expect(result.value.questions[0]?.questions).toBe(response.questions[0]?.questions);
  });

  it("refuses malformed responses with exact ordered diagnostics", () => {
    for (const input of [null, [], "response", 1])
      expect(parsePublicRuntimeQuestionsResponse(input)).toEqual({
        ok: false,
        errors: ["questions response must be an object"],
      });
    expect(parsePublicRuntimeQuestionsResponse({ questions: "invalid", extra: true })).toEqual({
      ok: false,
      errors: ["questionsResponse.extra is not allowed", "questions must be a bounded array"],
    });
  });

  it("pins source public and forwarding checked return types", () => {
    expectTypeOf(
      validateCodingWorkbenchRuntimeQuestionsResponse,
    ).returns.toEqualTypeOf<PublicQuestionsResponseParse>();
    expectTypeOf(publicQuestionsResponse).returns.toEqualTypeOf<PublicQuestionsResponseParse>();
    expectTypeOf(
      parsePublicRuntimeQuestionsResponse,
    ).returns.toEqualTypeOf<PublicQuestionsResponseParse>();
    type Success = Extract<ReturnType<typeof publicQuestionsResponse>, { readonly ok: true }>;
    expectTypeOf<Success["value"]>().toEqualTypeOf<CodingWorkbenchRuntimeQuestionsResponse>();
    type Failure = Extract<ReturnType<typeof publicQuestionsResponse>, { readonly ok: false }>;
    expectTypeOf<Failure["errors"]>().toEqualTypeOf<readonly string[]>();
  });
});

describe("runtime questions channel public parser (#3918)", () => {
  it("retains active and unpaired payload identity and optional flag presence", () => {
    const base = { question: "Continue?", header: "Action", options: [] };
    for (const question of [base, { ...base, multiple: undefined, custom: undefined }]) {
      const input = { session: "active", questions: [{ id: "que_1", questions: [question] }] };
      const result = parsePublicRuntimeQuestionsChannel(input);
      expect(result).toEqual({ ok: true, value: input });
      if (!result.ok) throw new TypeError("healthy public channel refused");
      expect(result.value).toBe(input);
      const observed = result.value.questions[0]?.questions[0];
      expect(observed).toBe(question);
      expect(Object.hasOwn(observed ?? {}, "multiple")).toBe(Object.hasOwn(question, "multiple"));
      expect(Object.hasOwn(observed ?? {}, "custom")).toBe(Object.hasOwn(question, "custom"));
    }
    const unpaired = unpairedCodingWorkbenchRuntimeQuestionsChannelPayload();
    const result = parsePublicRuntimeQuestionsChannel(unpaired);
    expect(result).toEqual({ ok: true, value: { session: "unpaired", questions: [] } });
    if (!result.ok) throw new TypeError("healthy unpaired public channel refused");
    expect(result.value).toBe(unpaired);
  });

  it("refuses malformed and content-bearing unpaired channels", () => {
    for (const input of [null, [], "channel", 1])
      expect(parsePublicRuntimeQuestionsChannel(input)).toEqual({
        ok: false,
        errors: ["questions channel payload must be an object"],
      });
    expect(
      parsePublicRuntimeQuestionsChannel({ session: "guest", questions: "invalid", extra: true }),
    ).toEqual({
      ok: false,
      errors: [
        "questionsChannelPayload.extra is not allowed",
        "questionsChannelPayload.session is invalid",
        "questions must be a bounded array",
      ],
    });
    expect(
      parsePublicRuntimeQuestionsChannel({ session: "unpaired", questions: response.questions }),
    ).toEqual({
      ok: false,
      errors: ["questionsChannelPayload.questions must be empty when the session is unpaired"],
    });
  });

  it("pins source public and forwarding checked return types", () => {
    expectTypeOf(
      validateCodingWorkbenchRuntimeQuestionsChannelPayload,
    ).returns.toEqualTypeOf<PublicQuestionsChannelParse>();
    expectTypeOf(publicQuestionsChannel).returns.toEqualTypeOf<PublicQuestionsChannelParse>();
    expectTypeOf(
      parsePublicRuntimeQuestionsChannel,
    ).returns.toEqualTypeOf<PublicQuestionsChannelParse>();
    type Success = Extract<ReturnType<typeof publicQuestionsChannel>, { readonly ok: true }>;
    expectTypeOf<Success["value"]>().toEqualTypeOf<CodingWorkbenchRuntimeQuestionsChannelPayload>();
    type Failure = Extract<ReturnType<typeof publicQuestionsChannel>, { readonly ok: false }>;
    expectTypeOf<Failure["errors"]>().toEqualTypeOf<readonly string[]>();
  });
});
