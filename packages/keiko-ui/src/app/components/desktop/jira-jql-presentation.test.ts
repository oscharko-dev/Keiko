import { describe, expect, it } from "vitest";
import { jiraJqlDetails } from "./jira-jql-presentation";

describe("native JQL metadata presentation", () => {
  it("preserves exact usable field tokens and observed flags without rendering native highlighting", () => {
    const cards = jiraJqlDetails("jira_jql_autocomplete", { category: "fields", metadataScope: "visible-fields",
      items: [{ value: "cf[10001]", cfid: "cf[10001]", auto: false, searchable: true,
        operators: ["=", "was in"], types: [], displayName: "<b>Untrusted</b>", self: "https://untrusted.invalid" }],
    });
    expect(cards[0]?.labels).toContain("chat.jira.jql.discoveryOnly");
    expect(cards[1]?.name).toBe("cf[10001]");
    expect(cards[1]?.facts).toContainEqual({ label: "chat.jira.jql.operatorCount", value: "2" });
    expect(cards[1]?.facts).toContainEqual({ label: "chat.jira.jql.typeCount", value: "0" });
    expect(cards[1]?.labels).toContain("chat.jira.jql.autoFalse");
    expect(cards[1]?.labels).toContain("chat.jira.lookup.orderableUnknown");
    expect(JSON.stringify(cards)).not.toMatch(/Untrusted|untrusted.invalid/u);
  });
  it("distinguishes unknown field arrays from explicit empty arrays", () => {
    const cards = jiraJqlDetails("jira_jql_autocomplete", { category: "fields", metadataScope: "visible-fields",
      items: [{ value: "assignee" }, { value: "reporter", types: [], operators: [] }],
    });
    expect(cards[1]?.labels).toContain("chat.jira.jql.typesUnknown");
    expect(cards[1]?.labels).toContain("chat.jira.jql.operatorsUnknown");
    expect(cards[1]?.facts).toEqual([]);
    expect(cards[2]?.facts).toContainEqual({ label: "chat.jira.jql.operatorCount", value: "0" });
  });
  it.each([
    ["functions", "visible-functions", "currentUser()"],
    ["reserved-words", "reserved-words", "empty"],
  ])("keeps %s tokens separate from field capability metadata", (category, metadataScope, value) => {
    const cards = jiraJqlDetails("jira_jql_autocomplete", { category, metadataScope, items: [{ value, auto: true }] });
    expect(cards[1]?.name).toBe(value);
    expect(cards[1]?.labels).not.toContain("chat.jira.jql.autoTrue");
  });
  it("keeps suggestion context and explicit empty prefixes without inventing query validation", () => {
    const cards = jiraJqlDetails("jira_jql_suggestions", { category: "suggestions", metadataScope: "native-suggestions",
      fieldName: "project", fieldValue: "", predicateName: "from", predicateValue: "Old & new", items: [{ value: "Exact & token" }],
    });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.jql.predicatePrefix", value: "Old & new" });
    expect(cards[0]?.labels).toContain("chat.jira.jql.emptyFieldPrefix");
    expect(cards[1]).toEqual({ name: "Exact & token", facts: [], labels: [] });
  });
});
