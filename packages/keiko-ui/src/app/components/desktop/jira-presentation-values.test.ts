import { describe, expect, it } from "vitest";
import { jiraPresentationFact, jiraPresentationRecord, jiraPresentationText } from "./jira-presentation-values";

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
    const value: unknown = Object.assign(Object.create({ id: "unowned", name: "Inherited" }), { own: "Observed" });
    const parsed = jiraPresentationRecord(value);
    expect(parsed).toEqual({ own: "Observed" });
    expect(parsed).not.toBe(value);
    expect(parsed).not.toHaveProperty("id");
    expect(jiraPresentationRecord(null)).toBeUndefined();
    expect(jiraPresentationRecord([{ id: "1" }])).toBeUndefined();
  });
});
