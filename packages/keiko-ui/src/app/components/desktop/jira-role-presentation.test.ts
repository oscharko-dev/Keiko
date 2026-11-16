import { describe, expect, it } from "vitest";
import { jiraRoleDetails } from "./jira-role-presentation";

describe("saved Jira role and priority scheme facts", () => {
  it.each([null, "", " ", "Reviewed description"])(
    "retains the exact role review description %j without claiming complete membership",
    (description) => {
      const source = {
        actorsScope: "role-configuration",
        id: "37",
        name: "Reviewers",
        reviewSnapshot: { id: "37", name: "Reviewers", description },
      };
      const cards = jiraRoleDetails("jira_role", source);
      expect(cards.flatMap((card) => card.labels)).toContain(
        "chat.jira.accessWrite.reviewAvailable",
      );
      expect(cards[0]?.labels).toContain("chat.jira.role.actorsUnknown");
      if (description === null)
        expect(cards.at(-1)?.labels).toContain("chat.jira.structural.nativeNotProvided");
      else if (description === "")
        expect(cards.at(-1)?.labels).toContain("chat.jira.propertyMutation.emptyText");
      else
        expect(cards.at(-1)?.facts).toContainEqual({
          label: "chat.jira.structural.nativeDescription",
          value: description,
        });
    },
  );
  it.each([
    undefined,
    { id: "37", name: "Reviewers" },
    { id: "38", name: "Reviewers", description: null },
    { id: "37", name: "Other role", description: null },
    { id: "37", name: "Reviewers", description: false },
    { id: "37", name: "Reviewers", description: null, inferredPermission: true },
  ])(
    "does not invent a reviewable role from missing or contradictory metadata %j",
    (reviewSnapshot) => {
      const cards = jiraRoleDetails("jira_project_role", {
        id: "37",
        name: "Reviewers",
        actors: [],
        projectId: "10000",
        projectKey: "SYN",
        reviewSnapshot,
      });
      expect(cards.at(-1)?.labels).toContain("chat.jira.accessWrite.reviewUnavailable");
      expect(cards.flatMap((card) => card.labels)).not.toContain(
        "chat.jira.accessWrite.reviewAvailable",
      );
    },
  );
  it("does not claim a review snapshot when its description contradicts ordinary observed metadata", () => {
    const cards = jiraRoleDetails("jira_role", {
      id: "37",
      name: "Reviewers",
      description: "Observed text",
      reviewSnapshot: { id: "37", name: "Reviewers", description: null },
    });
    expect(cards.at(-1)?.labels).toContain("chat.jira.accessWrite.reviewUnavailable");
  });
  it("keeps configured actors bound to their role without asserting current-user rights", () => {
    const cards = jiraRoleDetails("jira_role", {
      actorsScope: "role-configuration",
      id: "37",
      name: "Reviewers",
      actors: [
        {
          id: "9007199254740993",
          name: "team",
          displayName: "Review team",
          type: "atlassian-group-role-actor",
          avatarUrl: "https://untrusted.invalid/image",
          emailAddress: "private@example.invalid",
        },
      ],
    });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.role.actorCount", value: "1" });
    expect(cards[1]?.facts).toContainEqual({ label: "chat.jira.fact.roleId", value: "37" });
    expect(cards[1]?.facts).toContainEqual({
      label: "chat.jira.role.actorId",
      value: "9007199254740993",
    });
    expect(cards[1]?.labels).toEqual(["chat.jira.role.configurationScope"]);
    expect(JSON.stringify(cards)).not.toMatch(
      /untrusted.invalid|private@example.invalid|permissionGranted/u,
    );
  });
  it("keeps unprovided defaults distinct from a known empty default actor page", () => {
    const context = { roleId: "37", actorsScope: "role-defaults" };
    const missing = jiraRoleDetails("jira_role_default_actors", context);
    expect(missing[0]?.labels).toContain("chat.jira.role.actorsUnknown");
    const empty = jiraRoleDetails("jira_role_default_actors", {
      ...context,
      items: [],
      startAt: 0,
      total: 0,
    });
    expect(empty[0]?.labels).toEqual(["chat.jira.role.defaultsScope"]);
    expect(empty).toHaveLength(1);
  });
  it("preserves missing actor identities rather than using names or URLs as IDs", () => {
    const cards = jiraRoleDetails("jira_role_default_actors", {
      roleId: "37",
      actorsScope: "role-defaults",
      items: [{ name: "Developer", self: "https://untrusted.invalid/actor/91" }],
    });
    expect(cards[1]?.facts).toEqual([
      { label: "chat.jira.fact.roleId", value: "37" },
      { label: "chat.jira.role.actorName", value: "Developer" },
    ]);
  });
  it("keeps project role names readable without borrowing IDs from untrusted URLs", () => {
    const cards = jiraRoleDetails("jira_project_roles", {
      projectId: "10000",
      projectKey: "SYN",
      items: [{ name: "Reviewers", self: "https://untrusted.invalid/role/37", id: "37" }],
    });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.fact.projectKey", value: "SYN" });
    expect(cards[1]).toEqual({
      name: "Reviewers",
      facts: [],
      labels: ["chat.jira.role.indexScope"],
    });
  });
  it("retains project context while distinguishing membership observations from role defaults", () => {
    const cards = jiraRoleDetails("jira_project_role", {
      projectId: "10000",
      projectKey: "SYN",
      actorsScope: "project-membership",
      id: "37",
      name: "Reviewers",
      actors: [],
    });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.role.actorCount", value: "0" });
    expect(cards[0]?.labels).toEqual(["chat.jira.role.membershipScope"]);
  });
  it("reuses priority scheme facts while preserving unknown options and observed false", () => {
    const cards = jiraRoleDetails("jira_priority_schemes", {
      items: [
        { id: "49", name: "Unknown" },
        { id: "50", name: "Empty", optionIds: [], defaultScheme: false },
      ],
    });
    expect(cards[0]?.labels).toContain("chat.jira.association.priorityOptionsUnknown");
    expect(
      cards[0]?.facts.some(({ label }) => label === "chat.jira.association.priorityCount"),
    ).toBe(false);
    expect(cards[1]?.labels).toContain("chat.jira.association.notDefaultPriorityScheme");
    expect(cards[1]?.facts).toContainEqual({
      label: "chat.jira.association.priorityCount",
      value: "0",
    });
  });
});
