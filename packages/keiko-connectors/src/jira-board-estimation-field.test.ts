import { describe, expect, it } from "vitest";
import { boardEstimationField, boardFieldMatches } from "./jira-agile-planning-observations.js";

const FIELD = { estimation: { type: "field", field: { fieldId: "customfield_10200" } } };

describe("boardEstimationField", () => {
  it("projects a field-backed estimation with a bounded display name", () => {
    expect(boardEstimationField(FIELD)).toEqual({
      kind: "field",
      fieldId: "customfield_10200",
      displayName: "customfield_10200",
    });
    const named = boardEstimationField({
      estimation: {
        type: "field",
        field: { fieldId: "customfield_10200", displayName: "x".repeat(300) },
      },
    });
    expect(named).toMatchObject({ kind: "field", displayName: "x".repeat(200) });
  });

  it.each([
    { estimation: { type: "issueCount" } },
    { estimation: { type: "none" } },
    { type: "kanban" },
  ])("reports a board without an estimate as none (%j)", (board) => {
    expect(boardEstimationField(board)).toEqual({ kind: "none" });
  });

  it.each([
    {},
    { type: "scrum" },
    { estimation: { type: "field" } },
    { estimation: { type: "field", field: { fieldId: "not a field" } } },
    { estimation: { type: "field", field: { fieldId: 5 } } },
    { estimation: { type: "other" } },
  ])("reports anything else as malformed (%j)", (board) => {
    expect(boardEstimationField(board)).toEqual({ kind: "malformed" });
  });

  it("drives the estimation branch of boardFieldMatches", () => {
    const input = {
      operation: "jira.set-issue-estimation",
      fieldId: "customfield_10200",
    } as unknown as Parameters<typeof boardFieldMatches>[0];
    expect(boardFieldMatches(input, FIELD)).toBe(true);
    expect(boardFieldMatches(input, { estimation: { type: "issueCount" } })).toBe(false);
    expect(boardFieldMatches(input, {})).toBe(false);
  });
});
