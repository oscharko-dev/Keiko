// @vitest-environment jsdom
// #3390 / Keiko for Quality on #3394: the lane answers a runtime question through the workbench's
// own controls, one question at a time. The component renders one fieldset per question (with
// `data-question-index`), the option text as the `aria-label` of the wrapping `<label>` (never of
// the input), and -- when the question allows it -- that question's own "Custom answer for <header>"
// field, whose non-empty value REPLACES the picked option of a single-choice question. Two questions
// in one form may legitimately offer the same option text. This reproduces that markup exactly.
import { describe, expect, it } from "vitest";
import { planQuestionAnswers, questionFieldFacts } from "./coding-issue-journey-live.js";

interface RenderedQuestion {
  readonly header: string;
  readonly type?: "radio" | "checkbox";
  readonly options: readonly string[];
  readonly custom?: boolean;
}

function questionMarkup(question: RenderedQuestion, index: number): string {
  const name = `coding-question-req-${String(index)}`;
  const type = question.type ?? "radio";
  const options = question.options
    .map(
      (label, option) =>
        `<label aria-label="${label}" for="${name}-option-${String(option)}">` +
        `<input id="${name}-option-${String(option)}" type="${type}" name="${name}" />` +
        `<span><strong>${label}</strong></span></label>`,
    )
    .join("");
  const custom =
    question.custom === true
      ? `<label for="${name}-custom">Custom answer for ${question.header}` +
        `<input id="${name}-custom" value="" /></label>`
      : "";
  return (
    `<fieldset data-question-index="${String(index)}"><legend>${question.header}</legend>` +
    `<div>${options}</div>${custom}</fieldset>`
  );
}

function render(questions: readonly RenderedQuestion[]): readonly Element[] {
  document.body.innerHTML = `<form>${questions.map(questionMarkup).join("")}</form>`;
  return [...document.querySelectorAll("fieldset[data-question-index]")];
}

function plan(questions: readonly RenderedQuestion[]): ReturnType<typeof planQuestionAnswers> {
  return planQuestionAnswers(questionFieldFacts(render(questions)));
}

describe("runtime questions, answered per question", () => {
  it("reads each question's options from the wrapping labels and whether it has its own free-text field", () => {
    expect(
      questionFieldFacts(
        render([
          { header: "Next step", options: ["Hand off to the operator", "Keep probing"] },
          { header: "Scope", type: "checkbox", options: ["Yes", "No"], custom: true },
          { header: "Anything else", options: [], custom: true },
        ]),
      ),
    ).toEqual([
      { field: 0, options: ["Hand off to the operator", "Keep probing"], custom: false },
      { field: 1, options: ["Yes", "No"], custom: true },
      { field: 2, options: [], custom: true },
    ]);
  });

  it("picks the option that hands the decision back to the run, else the first, once per question", () => {
    expect(
      plan([
        { header: "Next step", options: ["Hand off to the operator", "Keep probing"] },
        { header: "Scope", type: "checkbox", options: ["Yes", "No"] },
        { header: "Tests", options: ["Yes", "No"] },
      ]),
    ).toEqual([
      { kind: "option", field: 0, option: 1, label: "Keep probing" },
      { kind: "option", field: 1, option: 0, label: "Yes" },
      { kind: "option", field: 2, option: 0, label: "Yes" },
    ]);
  });

  // The 2026-09-08 probe rehearsal: the run offered "Provide guidance" FIRST and the lane took it,
  // so the run ended as succeeded without a draft pull request. A parking option is never the
  // answer while another option keeps the run moving -- wherever it sits in the list.
  it("never takes a parking option ahead of one that keeps the run moving", () => {
    expect(
      plan([
        {
          header: "A",
          options: ["Provide guidance", "Create the pull request with the current change"],
        },
        {
          header: "B",
          options: [
            "Stop here and hand it back",
            "Wait for the operator",
            "Use the simpler approach",
          ],
        },
        { header: "C", options: ["Continue without asking the operator again", "Abort the run"] },
      ]).map((answer) => (answer.kind === "option" ? answer.label : answer.kind)),
    ).toEqual([
      "Create the pull request with the current change",
      "Use the simpler approach",
      "Continue without asking the operator again",
    ]);
  });

  // Keiko for Quality on #3394: the free-text answer used to be filled into "the first N custom
  // fields of the form" while the questions that needed one were counted separately. Here the
  // first question has a continue option AND a free-text field, the second only parks: the
  // position-based fill would have written into the FIRST question's field -- replacing the option
  // just picked there, since a non-empty custom value is the answer of a single-choice question --
  // and left the second question unanswered. Each question is answered through its own controls.
  it("puts the free-text answer into the field of the question that needs it, never by position", () => {
    expect(
      plan([
        { header: "Approach", options: ["Keep going", "Provide guidance"], custom: true },
        {
          header: "Direction",
          options: ["Provide guidance", "Wait for the operator"],
          custom: true,
        },
      ]),
    ).toEqual([
      { kind: "option", field: 0, option: 0, label: "Keep going" },
      { kind: "custom", field: 1 },
    ]);
  });

  it("answers a question without options through its free-text field", () => {
    expect(plan([{ header: "Anything else", options: [], custom: true }])).toEqual([
      { kind: "custom", field: 0 },
    ]);
  });

  it("falls back to the first option when every option parks the run and no free text is accepted", () => {
    expect(plan([{ header: "A", options: ["Provide guidance", "Abort the run"] }])).toEqual([
      { kind: "option", field: 0, option: 0, label: "Provide guidance" },
    ]);
  });

  it("gives no answer to a question with neither options nor a free-text field", () => {
    expect(plan([{ header: "Empty", options: [] }])).toEqual([]);
  });

  it("answers two questions that offer the same option text each inside its own fieldset", () => {
    expect(
      plan([
        { header: "First", options: ["Yes", "No"] },
        { header: "Second", options: ["Yes", "No"] },
      ]),
    ).toEqual([
      { kind: "option", field: 0, option: 0, label: "Yes" },
      { kind: "option", field: 1, option: 0, label: "Yes" },
    ]);
  });
});
