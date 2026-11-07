import { expect, it } from "vitest";
import { JIRA_MANAGED_ACTION_TYPES, JIRA_MANAGED_READ_TOOLS, JIRA_READ_TOOL_FAMILIES } from "./atlassian-connectors.js";

it("composes every canonical read family exactly once without changing its delivery order", () => {
  const owned = Object.values(JIRA_READ_TOOL_FAMILIES).flat();
  expect(JIRA_MANAGED_READ_TOOLS).toEqual(owned);
  expect(new Set(owned).size).toBe(owned.length);
  expect(owned).toHaveLength(133);
  for (const tool of owned) expect(JIRA_MANAGED_ACTION_TYPES[tool]).toBe(tool);
});
it("keeps existing adjacent read owners in order around the separated issue detail families", () => {
  const names: readonly string[] = JIRA_MANAGED_READ_TOOLS;
  const start = names.indexOf("jira.get-comment");
  expect(names.slice(start, start + 7)).toEqual([
    "jira.get-comment", "jira.link-types", "jira.issue-link",
    "jira.watchers", "jira.votes", "jira.worklogs", "jira.worklog",
  ]);
  expect(names.slice(-4)).toEqual([
    "jira.transitions", "jira.assignable-users", "jira.report", "jira.draft-stage",
  ]);
});
