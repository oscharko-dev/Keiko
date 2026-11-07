import { describe, expect, it } from "vitest";
import { jiraReleaseDetails } from "./jira-release-presentation";

describe("native release counts and version pages", () => {
  it("retains observed zero without turning absent count dimensions into zero", () => {
    const [card] = jiraReleaseDetails("jira_version_related_issue_counts", {
      versionId: "42", countScope: "jira-response", issuesFixedCount: 0,
    });
    expect(card?.facts).toEqual([
      { label: "chat.jira.fact.versionId", value: "42" },
      { label: "chat.jira.release.fixedIssues", value: "0" },
    ]);
    expect(card?.labels).toContain("chat.jira.release.countsUnknown");
    expect(card?.labels).toContain("chat.jira.release.nativeCountScope");
  });
  it.each([
    ["jira_component_related_issue_counts", { componentId: "71" }],
    ["jira_version_unresolved_issue_count", { versionId: "42" }],
  ] as const)("keeps wholly unprovided native %s counts unknown", (tool, identity) => {
    const [card] = jiraReleaseDetails(tool, { ...identity, countScope: "jira-response" });
    expect(card?.facts).toHaveLength(1);
    expect(card?.labels).toContain("chat.jira.release.countsUnknown");
  });
  it("binds custom-field usage to the version and distinguishes an absent usage count from zero", () => {
    const cards = jiraReleaseDetails("jira_version_related_issue_counts", {
      versionId: "42", countScope: "jira-response",
      issuesAffectedCount: 8, issuesFixedCount: 4, issueCountWithCustomFieldsShowingVersion: 2,
      customFieldNames: [{ customFieldId: "10001", fieldName: "Delivery", issueCountWithVersionInCustomField: 0 },
        { customFieldId: "9223372036854775807", fieldName: "Audit" }],
    });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.release.customFieldCount", value: "2" });
    expect(cards[1]?.facts).toContainEqual({ label: "chat.jira.release.fieldIssues", value: "0" });
    expect(cards[2]?.facts).toContainEqual({ label: "chat.jira.fact.versionId", value: "42" });
    expect(cards[2]?.facts.some(({ label }) => label === "chat.jira.release.fieldIssues")).toBe(false);
    expect(cards[2]?.labels).toContain("chat.jira.release.countsUnknown");
  });
  it("distinguishes an empty usage collection from an unknown one", () => {
    const [card] = jiraReleaseDetails("jira_version_related_issue_counts", { versionId: "42", countScope: "jira-response", customFieldNames: [] });
    expect(card?.facts).toContainEqual({ label: "chat.jira.release.customFieldCount", value: "0" });
    expect(card?.labels).not.toContain("chat.jira.release.customUsageUnknown");
  });
  it("preserves version states and project context without inventing per-version ownership", () => {
    const cards = jiraReleaseDetails("jira_project_version_page", {
      projectId: "10000", projectKey: "SYN", items: [{ versionId: "42", name: "Release", released: false }],
    });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.fact.projectKey", value: "SYN" });
    expect(cards[1]?.labels).toContain("chat.jira.metadata.unreleased");
    expect(cards[1]?.labels).toContain("chat.jira.metadata.archiveUnknown");
    expect(cards[1]?.facts.some(({ label }) => label === "chat.jira.fact.projectId")).toBe(false);
  });
});
