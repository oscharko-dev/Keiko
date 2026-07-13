import { describe, expect, it } from "vitest";

import {
  CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES,
  parseCodingWorkbenchRuntimeQuestionAnswerRequest,
  parseCodingWorkbenchRuntimeQuestionPath,
  parseCodingWorkbenchRuntimeQuestionRejectRequest,
  parseCodingWorkbenchRuntimeQuestionsPath,
  validateCodingWorkbenchRuntimeQuestionAcceptedResponse,
  validateCodingWorkbenchRuntimeQuestionsResponse,
} from "./index.js";

describe("Coding Workbench runtime question contracts", () => {
  it("accepts bounded untrusted question content without exposing runtime internals", () => {
    const response = {
      questions: [
        {
          id: "que_1",
          questions: [
            {
              header: "Decision",
              question: "Select <script>alert('untrusted')</script>",
              options: [{ label: "Continue", description: "Proceed with the active run" }],
              multiple: false,
              custom: true,
            },
          ],
        },
      ],
    };

    expect(validateCodingWorkbenchRuntimeQuestionsResponse(response)).toEqual({
      ok: true,
      value: response,
    });
    expect(JSON.stringify(response)).not.toContain("sessionID");
    expect(JSON.stringify(response)).not.toContain("messageID");
  });

  it("rejects runtime internals, forged ids, extra keys, and out-of-bound text", () => {
    const question = {
      id: "que_1",
      questions: [{ header: "Decision", question: "Continue?", options: [] }],
    };
    for (const malformed of [
      { questions: [{ ...question, sessionID: "ses_private" }] },
      { questions: [{ ...question, tool: { messageID: "msg_private", callID: "call" } }] },
      { questions: [{ ...question, id: "../forged" }] },
      {
        questions: [
          {
            ...question,
            questions: [{ ...question.questions[0], question: "x".repeat(4_097) }],
          },
        ],
      },
      { questions: [{ ...question, questions: [] }] },
      { questions: [question, question] },
      {
        questions: [
          {
            ...question,
            questions: [
              {
                ...question.questions[0],
                options: [
                  { label: "Same", description: "First" },
                  { label: "Same", description: "Second" },
                ],
              },
            ],
          },
        ],
      },
      { questions: [], extra: true },
    ]) {
      expect(validateCodingWorkbenchRuntimeQuestionsResponse(malformed)).toMatchObject({
        ok: false,
      });
    }
  });

  it("enforces the exact aggregate UTF-8 response budget without materializing a giant body", () => {
    expect(CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES).toBe(65_536);
    const exact = questionResponseAtBytes(CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES);
    expect(jsonBytes(exact)).toBe(CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES);
    expect(validateCodingWorkbenchRuntimeQuestionsResponse(exact)).toMatchObject({ ok: true });

    const multibyte = structuredClone(exact);
    const multibyteOption = firstOption(multibyte);
    multibyteOption.description = multibyteOption.description.replace("xx", "é");
    expect(jsonBytes(multibyte)).toBe(CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES);
    expect(validateCodingWorkbenchRuntimeQuestionsResponse(multibyte)).toMatchObject({ ok: true });

    const oversized = structuredClone(exact);
    const oversizedOption = firstOption(oversized);
    oversizedOption.description = oversizedOption.description.replace("x", "é");
    expect(jsonBytes(oversized)).toBe(CODING_WORKBENCH_RUNTIME_QUESTIONS_MAX_UTF8_BYTES + 1);
    expect(validateCodingWorkbenchRuntimeQuestionsResponse(oversized)).toMatchObject({
      ok: false,
      errors: ["questions response exceeds the aggregate UTF-8 byte budget"],
    });
  });

  it("accepts only exact bounded path, answer, reject, and acknowledgement payloads", () => {
    expect(parseCodingWorkbenchRuntimeQuestionsPath({ runId: "run-1" })).toMatchObject({
      ok: true,
    });
    expect(
      parseCodingWorkbenchRuntimeQuestionPath({ runId: "run-1", questionId: "que_1" }),
    ).toMatchObject({ ok: true });
    expect(
      parseCodingWorkbenchRuntimeQuestionAnswerRequest({ answers: [["Continue"], []] }),
    ).toMatchObject({ ok: true });
    expect(parseCodingWorkbenchRuntimeQuestionRejectRequest({})).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeQuestionAcceptedResponse({ accepted: true }),
    ).toMatchObject({ ok: true });

    for (const malformed of [
      { answers: [] },
      { answers: [["x".repeat(4_097)]] },
      { answers: [["Continue", "Continue"]] },
      { answers: [["Continue"]], approval: true },
    ]) {
      expect(parseCodingWorkbenchRuntimeQuestionAnswerRequest(malformed)).toMatchObject({
        ok: false,
      });
    }
    expect(parseCodingWorkbenchRuntimeQuestionRejectRequest({ reason: "private" })).toMatchObject({
      ok: false,
    });
    expect(parseCodingWorkbenchRuntimeQuestionsPath({ runId: "../forged" })).toMatchObject({
      ok: false,
    });
    expect(
      parseCodingWorkbenchRuntimeQuestionPath({ runId: "run-1", questionId: "forged" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeQuestionAcceptedResponse({ accepted: false }),
    ).toMatchObject({ ok: false });
  });
});

interface MutableQuestionResponse {
  readonly questions: {
    readonly id: string;
    readonly questions: {
      readonly header: string;
      readonly question: string;
      readonly options: { readonly label: string; description: string }[];
    }[];
  }[];
}

function questionResponseAtBytes(targetBytes: number): MutableQuestionResponse {
  const response = {
    questions: [
      {
        id: "que_1",
        questions: [
          {
            header: "Decision",
            question: "Choose one",
            options: Array.from({ length: 16 }, (_, index) => ({
              label: `Option ${String(index)}`,
              description: "x",
            })),
          },
        ],
      },
    ],
  };
  let remaining = targetBytes - jsonBytes(response);
  const question = response.questions[0]?.questions[0];
  if (question === undefined) throw new Error("missing question fixture");
  for (const option of question.options) {
    const added = Math.min(4_095, remaining);
    option.description += "x".repeat(added);
    remaining -= added;
  }
  expect(remaining).toBe(0);
  return response;
}

function firstOption(response: MutableQuestionResponse): { description: string } {
  const option = response.questions[0]?.questions[0]?.options[0];
  if (option === undefined) throw new Error("missing question option fixture");
  return option;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
