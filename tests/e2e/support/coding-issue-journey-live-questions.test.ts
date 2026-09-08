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
  document.body.innerHTML =
    `<form>` +
    `<fieldset>${optionMarkup("q1", "radio", ["Hand off to the operator", "Keep probing"])}</fieldset>` +
    `<fieldset>${optionMarkup("q2", "checkbox", ["Yes", "No"])}</fieldset>` +
    `<fieldset>${optionMarkup("q3", "radio", ["Yes", "No"])}</fieldset>` +
    `</form>`;
  return [...document.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
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
    const picks = pickQuestionOptions(questionOptionFacts(renderForm()));
    expect(picks.map((pick) => [pick.name, pick.index, pick.label])).toEqual([
      ["q1", 1, "Keep probing"],
      ["q2", 2, "Yes"],
      ["q3", 4, "Yes"],
    ]);
  });

  it("returns no pick for a question without options", () => {
    expect(pickQuestionOptions([])).toEqual([]);
  });
});
