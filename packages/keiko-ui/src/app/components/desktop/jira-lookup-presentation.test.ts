import { describe, expect, it } from "vitest";
import { jiraLookupDetails, jiraLookupNotice } from "./jira-lookup-presentation";

describe("scoped Jira directory and field presentation", () => {
  it("keeps picker populations and their totals separate", () => {
    const cards = jiraLookupDetails("jira_group_user_picker", {
      outcome: "succeeded",
      users: [{ key: "U1", name: "Synthetic", active: false }],
      usersTotal: 9,
      groups: [],
      groupsTotal: 0,
    });
    expect(cards[0]?.facts).toEqual([
      { label: "chat.jira.lookup.usersReturned", value: "1" },
      { label: "chat.jira.lookup.usersTotal", value: "9" },
    ]);
    expect(cards[1]?.labels).toContain("chat.jira.outcome.inactive");
    expect(cards[2]?.facts).toEqual([
      { label: "chat.jira.lookup.groupsReturned", value: "0" },
      { label: "chat.jira.lookup.groupsTotal", value: "0" },
    ]);
    expect(
      jiraLookupNotice("jira_group_user_picker", {
        outcome: "succeeded",
        users: [{}],
        usersTotal: 9,
      }),
    ).toBe("chat.jira.partial");
  });
  it("does not turn an omitted picker branch into zero matches", () => {
    const cards = jiraLookupDetails("jira_group_user_picker", { outcome: "succeeded", groups: [] });
    expect(cards[0]).toEqual({ facts: [], labels: ["chat.jira.lookup.usersUnknown"] });
    expect(cards[1]?.labels).toContain("chat.jira.lookup.groupsTotalUnknown");
    expect(cards[1]?.facts).toEqual([{ label: "chat.jira.lookup.groupsReturned", value: "0" }]);
    expect(jiraLookupDetails("jira_group_user_picker", {})).toEqual([]);
  });
  it("preserves field schema facts and false versus missing field flags", () => {
    const [card] = jiraLookupDetails("jira_fields", {
      id: "customfield_10001",
      name: "Delivery",
      custom: true,
      searchable: false,
      clauseNames: [],
      schema: { type: "array", items: "string", customId: "9223372036854775807" },
      required: true,
      editable: true,
      self: "https://untrusted.invalid/field",
    });
    expect(card?.labels).toContain("chat.jira.lookup.customField");
    expect(card?.labels).toContain("chat.jira.lookup.notSearchable");
    expect(card?.labels).toContain("chat.jira.lookup.orderableUnknown");
    expect(card?.facts).toContainEqual({ label: "chat.jira.lookup.clauseCount", value: "0" });
    expect(card?.facts).toContainEqual({
      label: "chat.jira.lookup.schemaCustomId",
      value: "9223372036854775807",
    });
    expect(card?.labels).toContain("chat.jira.lookup.fieldScope");
    expect(JSON.stringify(card)).not.toMatch(/untrusted.invalid|outcome.required|editable/u);
  });
  it("retains empty option values and known empty children independently of option state", () => {
    const [card] = jiraLookupDetails("jira_custom_field_option", {
      id: "91",
      value: "",
      disabled: false,
      childrenIds: [],
    });
    expect(card?.labels).toContain("chat.jira.lookup.emptyOptionValue");
    expect(card?.labels).toContain("chat.jira.lookup.optionEnabled");
    expect(card?.facts).toContainEqual({ label: "chat.jira.lookup.childOptionCount", value: "0" });
    const [unknown] = jiraLookupDetails("jira_custom_field_option", { id: "91", value: "Choice" });
    expect(unknown?.labels).toContain("chat.jira.lookup.optionStateUnknown");
    expect(unknown?.labels).toContain("chat.jira.lookup.childrenUnknown");
    expect(unknown?.facts).toHaveLength(1);
  });
  it.each([
    "jira_multi_project_assignable_users",
    "jira_permission_users",
    "jira_browse_permission_users",
  ])("retains the bounded search scope for %s", (tool) => {
    expect(jiraLookupNotice(tool, { outcome: "succeeded", searchLimit: 100, items: [] })).toBe(
      "chat.jira.directory.searchWindow",
    );
  });
  it("does not follow project suggestion URLs or invent an unreported match total", () => {
    const [card] = jiraLookupDetails("jira_project_picker", {
      items: [
        { id: "10000", key: "SYN", name: "Delivery", avatarUrl: "https://untrusted.invalid/image" },
      ],
    });
    expect(card?.facts).toEqual([
      { label: "chat.jira.fact.projectId", value: "10000" },
      { label: "chat.jira.fact.projectKey", value: "SYN" },
    ]);
    expect(jiraLookupNotice("jira_project_picker", { outcome: "succeeded", items: [] })).toBe(
      "chat.jira.directory.pickerTotalUnknown",
    );
    expect(JSON.stringify(card)).not.toContain("untrusted.invalid");
  });
});
