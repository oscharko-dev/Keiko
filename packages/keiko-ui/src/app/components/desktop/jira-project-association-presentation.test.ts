import { describe, expect, it } from "vitest";
import { jiraProjectAssociationDetails } from "./jira-project-association-presentation";

const PROJECT = { projectId: "9223372036854775807", projectKey: "SYN" };

describe("project configuration association presentation", () => {
  it("keeps the canonical project with configured grants and ignores remote destinations", () => {
    const cards = jiraProjectAssociationDetails("jira_project_permission_scheme", {
      ...PROJECT,
      id: "37",
      name: "Access",
      permissions: [
        {
          id: "81",
          permission: "BROWSE_PROJECTS",
          holder: { type: "group", parameter: "Developers" },
        },
      ],
      self: "https://untrusted.invalid/scheme",
      browseUrl: "https://untrusted.invalid/project",
    });
    expect(cards[0]?.facts).toContainEqual({
      label: "chat.jira.fact.projectId",
      value: PROJECT.projectId,
    });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.fact.projectKey", value: "SYN" });
    expect(cards[1]?.facts).toContainEqual({ label: "chat.jira.access.schemeId", value: "37" });
    expect(cards[1]?.labels).toContain("chat.jira.access.configurationOnly");
    expect(JSON.stringify(cards)).not.toContain("untrusted.invalid");
  });
  it("labels zero accessible levels without claiming that the configured scheme is empty", () => {
    const cards = jiraProjectAssociationDetails("jira_project_security_levels", {
      ...PROJECT,
      levelsScope: "accessible",
      items: [],
      startAt: 0,
      total: 0,
    });
    expect(cards[0]?.facts).toContainEqual({
      label: "chat.jira.association.accessibleLevelCount",
      value: "0",
    });
    expect(cards[0]?.labels).toEqual(["chat.jira.association.accessibleLevelsScope"]);
    expect(cards[0]?.facts.some(({ label }) => label === "chat.jira.access.levelCount")).toBe(
      false,
    );
  });
  it("does not apply an accessible count to a legacy result with unknown scope", () => {
    const cards = jiraProjectAssociationDetails("jira_project_security_levels", {
      ...PROJECT,
      items: [],
      total: 0,
    });
    expect(cards[0]?.labels).toContain("chat.jira.association.levelsScopeUnknown");
    expect(
      cards[0]?.facts.some(({ label }) => label === "chat.jira.association.accessibleLevelCount"),
    ).toBe(false);
  });
  it("preserves original-only mappings and unknown mappings using the existing workflow owner", () => {
    const source = { ...PROJECT, id: "48", schemeId: "48", name: "Workflow" };
    const absent = jiraProjectAssociationDetails("jira_project_workflow_scheme", source);
    expect(absent[0]?.labels).toContain("chat.jira.administration.mappingsUnknown");
    const cards = jiraProjectAssociationDetails("jira_project_workflow_scheme", {
      ...source,
      items: [{ issueTypeId: "10001", originalWorkflow: "Previous workflow" }],
    });
    expect(
      cards[0]?.facts.filter(({ label }) => label === "chat.jira.fact.projectKey"),
    ).toHaveLength(1);
    expect(cards[1]?.facts).toContainEqual({
      label: "chat.jira.fact.originalWorkflow",
      value: "Previous workflow",
    });
    expect(cards[1]?.labels).toContain("chat.jira.administration.currentMappingUnknown");
  });
  it("keeps explicit false and empty priority options distinct from missing metadata", () => {
    const source = { ...PROJECT, id: "49", name: "Priorities", description: "Configured options" };
    const missing = jiraProjectAssociationDetails("jira_project_priority_scheme", source)[0];
    expect(missing?.labels).toEqual([
      "chat.jira.access.configurationOnly",
      "chat.jira.association.priorityOptionsUnknown",
      "chat.jira.schemeWrite.reviewUnavailable",
    ]);
    expect(
      missing?.facts.some(({ label }) => label === "chat.jira.association.priorityCount"),
    ).toBe(false);
    const empty = jiraProjectAssociationDetails("jira_project_priority_scheme", {
      ...source,
      defaultScheme: false,
      optionIds: [],
    })[0];
    expect(empty).toMatchObject({ name: "Priorities", body: "Configured options" });
    expect(empty?.labels).toContain("chat.jira.association.notDefaultPriorityScheme");
    expect(empty?.facts).toContainEqual({
      label: "chat.jira.association.priorityCount",
      value: "0",
    });
    expect(
      empty?.facts.some(({ label }) => label === "chat.jira.association.defaultPriorityId"),
    ).toBe(false);
  });
  it.each([
    "jira_project_permission_scheme",
    "jira_project_issue_security_scheme",
    "jira_project_security_levels",
    "jira_project_workflow_scheme",
    "jira_project_priority_scheme",
  ])("does not manufacture a configuration card for a failed %s read", (tool) => {
    expect(
      jiraProjectAssociationDetails(tool, { outcome: "failed", reason: "permission-denied" }),
    ).toEqual([]);
  });
});
