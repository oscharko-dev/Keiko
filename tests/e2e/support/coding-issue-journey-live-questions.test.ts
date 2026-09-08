// @vitest-environment jsdom
// #3390 / Keiko for Quality on #3394: the lane answers a runtime question through the workbench's
// own controls. The component renders the option text as the `aria-label` of the wrapping
// `<label>` (CodingWorkbenchQuestions.tsx), never of the input, and two questions in one form may
// legitimately offer the same option text -- so facts are read from the label and picks are
// identified by DOM index. This reproduces that markup exactly.
import { describe, expect, it } from "vitest";
import { pickQuestionOptions, questionOptionFacts } from "./coding-issue-journey-live.js";

function optionMarkup(name: string, type: "radio" | "checkbox", labels: readonly string[]): string {
  return labels
    .map(
      (label, index) =>
        `<label aria-label="${label}" for="${name}-option-${String(index)}">` +
        `<input id="${name}-option-${String(index)}" type="${type}" name="${name}" value="${String(index)}" />` +
        `<span>${label}</span></label>`,
    )
    .join("");
}

function renderForm(): readonly Element[] {
  return renderQuestions([
    ["q1", "radio", ["Hand off to the operator", "Keep probing"]],
    ["q2", "checkbox", ["Yes", "No"]],
    ["q3", "radio", ["Yes", "No"]],
  ]);
}

function renderQuestions(
  questions: readonly (readonly [string, "radio" | "checkbox", readonly string[]])[],
): readonly Element[] {
  document.body.innerHTML =
    `<form>` +
    questions
      .map(([name, type, labels]) => `<fieldset>${optionMarkup(name, type, labels)}</fieldset>`)
      .join("") +
    `</form>`;
  return [...document.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
}

function pickedLabels(facts: readonly Element[], customAnswerAvailable?: boolean): string[][] {
  return pickQuestionOptions(questionOptionFacts(facts), customAnswerAvailable).picks.map(
    (pick) => [pick.name, String(pick.index), pick.label],
  );
}

describe("runtime question options", () => {
  it("reads each option's label from the wrapping label element, by DOM index", () => {
    const facts = questionOptionFacts(renderForm());
    expect(facts).toEqual([
      { index: 0, name: "q1", label: "Hand off to the operator" },
      { index: 1, name: "q1", label: "Keep probing" },
      { index: 2, name: "q2", label: "Yes" },
      { index: 3, name: "q2", label: "No" },
      { index: 4, name: "q3", label: "Yes" },
      { index: 5, name: "q3", label: "No" },
    ]);
  });

  it("picks the option that hands the decision back to the run, else the first, once per question", () => {
    expect(pickedLabels(renderForm())).toEqual([
      ["q1", "1", "Keep probing"],
      ["q2", "2", "Yes"],
      ["q3", "4", "Yes"],
    ]);
  });

  it("returns no pick for a question without options", () => {
    expect(pickQuestionOptions([])).toEqual({ picks: [], unanswered: 0 });
  });

  // The 2026-09-08 probe rehearsal: the run offered "Provide guidance" FIRST and the lane took it,
  // so the run ended as succeeded without a draft pull request. A parking option is never the
  // answer while another option keeps the run moving -- wherever it sits in the list.
  it("never takes a parking option ahead of one that keeps the run moving", () => {
    const facts = renderQuestions([
      ["q1", "radio", ["Provide guidance", "Create the pull request with the current change"]],
      [
        "q2",
        "radio",
        ["Stop here and hand it back", "Wait for the operator", "Use the simpler approach"],
      ],
      ["q3", "radio", ["Continue without asking the operator again", "Abort the run"]],
    ]);
    expect(pickedLabels(facts)).toEqual([
      ["q1", "1", "Create the pull request with the current change"],
      ["q2", "4", "Use the simpler approach"],
      ["q3", "5", "Continue without asking the operator again"],
    ]);
  });

  it("answers in free text when every option parks the run and the form accepts one", () => {
    const facts = questionOptionFacts(
      renderQuestions([
        ["q1", "radio", ["Provide guidance", "Pause until the operator decides"]],
        ["q2", "radio", ["Yes", "No"]],
      ]),
    );
    expect(pickQuestionOptions(facts, true)).toEqual({
      picks: [{ index: 2, name: "q2", label: "Yes" }],
      unanswered: 1,
    });
  });

  it("falls back to the first option when every option parks the run and no free text is accepted", () => {
    const facts = renderQuestions([["q1", "radio", ["Provide guidance", "Abort the run"]]]);
    expect(pickedLabels(facts, false)).toEqual([["q1", "0", "Provide guidance"]]);
    expect(pickQuestionOptions(questionOptionFacts(facts)).unanswered).toBe(0);
  });
});
