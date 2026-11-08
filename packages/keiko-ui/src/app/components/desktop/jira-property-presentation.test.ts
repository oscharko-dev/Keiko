import { expect, it } from "vitest";
import { jiraPropertyDetails as details, JIRA_PROPERTY_TOOLS } from "./jira-property-presentation";

it("renders typed root/null/empty containers independently from unavailable values", () => {
  const cards = details("jira_issue_property", {
    outcome: "succeeded",
    issueId: "10002",
    issueKey: "SYN-2",
    propertyKey: "settings",
    nodeCount: 4,
    items: [
      { path: "", kind: "object", childCount: 3 },
      { path: "/none", kind: "null" },
      { path: "/object", kind: "object", childCount: 0 },
      { path: "/array", kind: "array", childCount: 0 },
    ],
  });
  expect(cards[1]?.labels).toEqual(["chat.jira.properties.root", "chat.jira.properties.object"]);
  expect(cards[2]?.labels).toContain("chat.jira.properties.null");
  expect(cards[3]?.labels).toContain("chat.jira.properties.emptyObject");
  expect(cards[4]?.labels).toContain("chat.jira.properties.emptyArray");
  expect(cards.flatMap((card) => card.labels)).not.toContain("chat.jira.properties.valueUnknown");
  expect(details("jira_issue_property", { outcome: "succeeded" })[0]?.labels).toContain(
    "chat.jira.properties.valueUnknown",
  );
});
it("keeps escaped pointer paths and text values unchanged without a second JSON interpretation", () => {
  const cards = details("jira_board_property", {
    outcome: "succeeded",
    items: [
      { path: "/a~1b~0c", kind: "string", textValue: '{"literal":false}' },
      { path: "/", kind: "string", textValue: "" },
      { path: "/spaces", kind: "string", textValue: "  " },
    ],
  });
  expect(cards[1]?.facts).toEqual([{ label: "chat.jira.properties.pointer", value: "/a~1b~0c" }]);
  expect(cards[1]?.body).toBe('{"literal":false}');
  expect(cards[2]?.facts).toEqual([{ label: "chat.jira.properties.pointer", value: "/" }]);
  expect(cards[2]?.labels).toContain("chat.jira.properties.emptyText");
  expect(cards[3]?.body).toBe("  ");
  expect(cards[3]?.labels).toContain("chat.jira.properties.whitespaceText");
});
it("preserves false and zero rather than replacing them with missing values", () => {
  const cards = details("jira_sprint_property", {
    outcome: "succeeded",
    items: [
      { path: "/flag", kind: "boolean", booleanValue: false },
      { path: "/count", kind: "number", numberValue: 0 },
      { path: "/unknown", kind: "boolean" },
    ],
  });
  expect(cards[1]?.labels).toContain("chat.jira.properties.false");
  expect(cards[2]?.facts).toContainEqual({ label: "chat.jira.properties.value", value: "0" });
  expect(cards[3]?.labels).toContain("chat.jira.properties.valueUnknown");
});
it("visibly distinguishes controls and literal escapes in text and pointer paths without changing native nodes", () => {
  const nodes = [
    { path: "/a\u0000\u0085\\~1~0", kind: "string", textValue: "\u0000\n\t\u0085\\u0000" },
    { path: "/control", kind: "string", textValue: "\u0000" },
    { path: "/literal", kind: "string", textValue: "\\u0000" },
  ];
  const cards = details("jira_issue_property", { outcome: "succeeded", items: nodes });
  expect(cards[1]?.facts).toContainEqual({
    label: "chat.jira.properties.pointer",
    value: String.raw`/a\u0000\u0085\\~1~0`,
  });
  expect(cards[1]?.body).toBe(String.raw`\u0000\u000a\u0009\u0085\\u0000`);
  expect(
    cards[1]?.labels.filter((label) => label === "chat.jira.properties.visibleEscapes"),
  ).toHaveLength(1);
  expect(cards[2]?.body).toBe(String.raw`\u0000`);
  expect(cards[3]?.body).toBe(String.raw`\\u0000`);
  expect(nodes[0]).toEqual({
    path: "/a\u0000\u0085\\~1~0",
    kind: "string",
    textValue: "\u0000\n\t\u0085\\u0000",
  });
});
it("distinguishes empty native key lists from unknown lists and preserves unselectable keys", () => {
  expect(
    details("jira_project_property_keys", { outcome: "succeeded", items: [], total: 0 })[0]?.labels,
  ).toContain("chat.jira.properties.keysEmpty");
  expect(details("jira_project_property_keys", { outcome: "succeeded" })[0]?.labels).toContain(
    "chat.jira.properties.keysUnknown",
  );
  const cards = details("jira_project_property_keys", {
    outcome: "succeeded",
    items: [{ key: "a/b%" }],
  });
  expect(cards[1]?.facts).toContainEqual({ label: "chat.jira.properties.key", value: "a/b%" });
  expect(cards[1]?.labels).toContain("chat.jira.properties.unselectableKey");
});
it("keeps the dashboard item as requested context and never turns foreign fields into links", () => {
  const cards = details("jira_dashboard_item_property", {
    outcome: "succeeded",
    dashboardId: "10",
    selectedItemId: "20",
    items: [
      {
        path: "",
        kind: "null",
        self: "https://untrusted.invalid",
        browseUrl: "https://untrusted.invalid",
      },
    ],
  });
  expect(cards[0]?.facts).toContainEqual({
    label: "chat.jira.properties.selectedItemId",
    value: "20",
  });
  expect(cards[0]?.labels).toContain("chat.jira.properties.requestedItemContext");
  expect(JSON.stringify(cards)).not.toContain("untrusted.invalid");
});
it("covers sixteen read aliases without claiming success on a failed result", () => {
  expect(JIRA_PROPERTY_TOOLS.size).toBe(16);
  expect(details("jira_issue_property", { outcome: "failed", reason: "invalid-input" })).toEqual(
    [],
  );
  expect(details("jira_set_property", { outcome: "succeeded" })).toEqual([]);
});
