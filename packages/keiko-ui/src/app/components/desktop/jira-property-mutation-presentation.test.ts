import { expect, it } from "vitest";
import { jiraPropertyMutationDetails as details } from "./jira-property-mutation-presentation";

it.each([
  ["board", { boardId: "7" }], ["sprint", { sprintId: "9" }],
  ["comment", { issueId: "10001", issueKey: "SYN-1", commentId: "10002" }],
  ["dashboard_item", { dashboardId: "71", selectedItemId: "81" }],
  ["issue", { issueId: "10001", issueKey: "SYN-1" }], ["issue_type", { issueTypeId: "10001" }],
  ["project", { projectId: "10000", projectKey: "SYN" }], ["user", { userKey: "JIRAUSER10100", username: "Synthetic-User" }],
] as const)(
  "distinguishes confirmed from requested property states for %s", (entity, context) => {
    for (const [verb, propertyPresent] of [["set", true], ["delete", false]] as const) {
      const tool = `jira_${verb}_${entity}_property`;
      const confirmed = details(tool, { ...context, outcome: "succeeded", propertyKey: "view.settings", propertyPresent });
      expect(confirmed[0]?.labels).toContain(propertyPresent ? "chat.jira.propertyMutation.confirmedPresent" : "chat.jira.propertyMutation.confirmedAbsent");
      for (const outcome of ["unknown", "succeeded-unconfirmed", "rejected"]) {
        const uncertain = details(tool, { ...context, outcome, propertyKey: "view.settings", propertyPresent })[0];
        expect(uncertain?.labels).toContain("chat.jira.propertyMutation.targetUnconfirmed");
        expect(uncertain?.labels).not.toContain("chat.jira.propertyMutation.confirmedPresent");
        expect(uncertain?.labels).not.toContain("chat.jira.propertyMutation.confirmedAbsent");
      }
      expect(details(tool, { outcome: "succeeded", propertyPresent: !propertyPresent })[0]?.labels).toContain("chat.jira.propertyMutation.presenceUnknown");
    }
  },
);
it("preserves requested dashboard item context without claiming independent item observation", () => {
  const card = details("jira_set_dashboard_item_property", { outcome: "unknown", propertyKey: "view.settings", propertyPresent: true,
    dashboardId: "71", selectedItemId: "81", self: "https://untrusted.invalid", value: { secretBody: "unprojected" } })[0];
  expect(card?.facts).toContainEqual({ label: "chat.jira.properties.selectedItemId", value: "81" });
  expect(card?.labels).toContain("chat.jira.properties.requestedItemContext");
  expect(JSON.stringify(card)).not.toContain("untrusted.invalid");
  expect(JSON.stringify(card)).not.toContain("unprojected");
});
it("keeps actual no-op distinct from absent state and optimistic receipts", () => {
  const context = { issueId: "10001", issueKey: "SYN-1", propertyKey: "view.settings" };
  expect(details("jira_set_issue_property", { ...context, outcome: "rejected", reason: "conflict", unchanged: true, propertyPresent: true })[0]?.labels)
    .toEqual(["chat.jira.propertyMutation.alreadyPresent"]);
  expect(details("jira_set_issue_property", { ...context, outcome: "unknown", reason: "conflict", unchanged: true, propertyPresent: true })[0]?.labels)
    .toContain("chat.jira.propertyMutation.targetUnconfirmed");
  expect(details("jira_delete_issue_property", { outcome: "rejected" })[0]?.labels)
    .toEqual(["chat.jira.propertyMutation.presenceUnknown"]);
});
it.each([
  { issueId: "10001", issueKey: "SYN-1" },
  { propertyKey: "view.settings", issueKey: "SYN-1" },
  { propertyKey: "view.settings", issueId: "10001" },
  { propertyKey: "view.settings", projectId: "10000", projectKey: "SYN" },
  { propertyKey: "view.settings", issueId: "10001", issueKey: "SYN-1", boardId: "7" },
  { propertyKey: "view.settings", issueId: "9223372036854775808", issueKey: "SYN-1" },
  { propertyKey: "view.settings", issueId: "not-a-native-id", issueKey: "SYN-1" },
])("keeps missing, malformed or foreign issue property context unknown: %j", (context) => {
  expect(details("jira_set_issue_property", { ...context, outcome: "succeeded", propertyPresent: true })[0]?.labels)
    .toEqual(["chat.jira.propertyMutation.presenceUnknown"]);
  expect(details("jira_set_issue_property", { ...context, outcome: "rejected", reason: "conflict", unchanged: true, propertyPresent: true })[0]?.labels)
    .toEqual(["chat.jira.propertyMutation.presenceUnknown"]);
});
