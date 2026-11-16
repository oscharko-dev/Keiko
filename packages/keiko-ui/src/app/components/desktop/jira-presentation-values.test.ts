import { describe, expect, it } from "vitest";
import {
  jiraPresentationFact,
  jiraPresentationRecord,
  jiraPresentationText,
  jiraPresentationStringList,
} from "./jira-presentation-values";

describe("shared private Jira presentation values", () => {
  it("preserves significant leading/trailing whitespace while omitting whitespace-only facts", () => {
    expect(jiraPresentationText("  Observed text\n")).toBe("  Observed text\n");
    expect(jiraPresentationFact("chat.jira.fact.roleName", "  Reviewers  ")).toEqual([
      { label: "chat.jira.fact.roleName", value: "  Reviewers  " },
    ]);
    expect(jiraPresentationFact("chat.jira.fact.roleName", " \n\t")).toEqual([]);
    expect(jiraPresentationText(0)).toBeUndefined();
  });
  it("copies only enumerable own saved fields and does not inherit resource metadata", () => {
    const value: unknown = Object.assign(Object.create({ id: "unowned", name: "Inherited" }), {
      own: "Observed",
    });
    const parsed = jiraPresentationRecord(value);
    expect(parsed).toEqual({ own: "Observed" });
    expect(parsed).not.toBe(value);
    expect(parsed).not.toHaveProperty("id");
    expect(jiraPresentationRecord(null)).toBeUndefined();
    expect(jiraPresentationRecord([{ id: "1" }])).toBeUndefined();
  });
  it("preserves supplied string lists and distinguishes empty from unknown", () => {
    expect(
      jiraPresentationStringList([], "chat.jira.jql.operators", "chat.jira.jql.operatorCount"),
    ).toEqual([{ label: "chat.jira.jql.operatorCount", value: "0" }]);
    expect(
      jiraPresentationStringList(
        [" = ", "was in"],
        "chat.jira.jql.operators",
        "chat.jira.jql.operatorCount",
      ),
    ).toEqual([
      { label: "chat.jira.jql.operators", value: " = , was in" },
      { label: "chat.jira.jql.operatorCount", value: "2" },
    ]);
    expect(
      jiraPresentationStringList(
        undefined,
        "chat.jira.jql.operators",
        "chat.jira.jql.operatorCount",
      ),
    ).toBeUndefined();
    expect(
      jiraPresentationStringList([0], "chat.jira.jql.operators", "chat.jira.jql.operatorCount"),
    ).toBeUndefined();
  });
});
