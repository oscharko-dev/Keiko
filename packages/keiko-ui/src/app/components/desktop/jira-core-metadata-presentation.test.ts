import { describe, expect, it } from "vitest";
import { jiraCoreMetadataDetails } from "./jira-core-metadata-presentation";

describe("Jira core metadata presentation", () => {
  it.each([
    [true, "chat.jira.core.subtaskType"],
    [false, "chat.jira.core.standardType"],
    [undefined, "chat.jira.core.typeKindUnknown"],
  ])("preserves observed issue type classification %s", (subtask, label) => {
    const [item] = jiraCoreMetadataDetails("jira_issue_type", {
      id: "9223372036854775807", name: "Story", subtask, avatarId: "19",
      iconUrl: "https://untrusted.invalid/icon", self: "https://untrusted.invalid/type",
    });
    expect(item?.labels).toContain(label);
    expect(item?.facts).toContainEqual({ label: "chat.jira.fact.issueTypeId", value: "9223372036854775807" });
    expect(item?.facts).toContainEqual({ label: "chat.jira.fact.avatarId", value: "19" });
    expect(JSON.stringify(item)).not.toContain("untrusted.invalid");
  });
  it("keeps a requested resolution separate from an absent observed identity", () => {
    const [item] = jiraCoreMetadataDetails("jira_resolution", {
      resolutionId: "41", name: "Fixed", description: "Resolved", self: "https://untrusted.invalid/resolution/41",
    });
    expect(item).toMatchObject({ name: "Fixed", body: "Resolved" });
    expect(item?.facts).toEqual([{ label: "chat.jira.core.requestedResolutionId", value: "41" }]);
    expect(item?.labels).toContain("chat.jira.core.resolutionIdUnknown");
  });
  it("retains separate status/category identities and color text without rendering CSS", () => {
    const [item] = jiraCoreMetadataDetails("jira_status", {
      id: "3", name: "In progress", statusColor: "#123456",
      statusCategory: { id: "4", key: "indeterminate", name: "In progress category", colorName: "yellow" },
    });
    expect(item?.facts).toEqual([
      { label: "chat.jira.core.statusId", value: "3" },
      { label: "chat.jira.core.statusColor", value: "#123456" },
      { label: "chat.jira.core.statusCategoryId", value: "4" },
      { label: "chat.jira.core.statusCategoryKey", value: "indeterminate" },
      { label: "chat.jira.core.statusCategoryName", value: "In progress category" },
      { label: "chat.jira.core.colorName", value: "yellow" },
    ]);
    expect(item).not.toHaveProperty("style");
  });
  it("keeps status lists unknown when missing and known empty only for explicit arrays", () => {
    const cards = jiraCoreMetadataDetails("jira_project_statuses", {
      projectId: "10000", projectKey: "SYN",
      items: [{ id: "1", name: "Unknown" }, { id: "2", name: "Empty", subtask: false, statuses: [] }],
    });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.fact.projectKey", value: "SYN" });
    expect(cards[0]?.labels).toContain("chat.jira.core.projectStatusesScope");
    expect(cards[1]?.labels).toContain("chat.jira.core.statusesUnknown");
    expect(cards[1]?.facts.some(({ label }) => label === "chat.jira.core.configuredStatusCount")).toBe(false);
    expect(cards[2]?.facts).toContainEqual({ label: "chat.jira.core.configuredStatusCount", value: "0" });
  });
  it("binds each configured status to its native issue type", () => {
    const cards = jiraCoreMetadataDetails("jira_project_statuses", {
      items: [{ id: "10001", name: "Story", statuses: [{ id: "3", name: "Open" }] }],
    });
    expect(cards[1]?.facts).toEqual([
      { label: "chat.jira.fact.issueTypeId", value: "10001" },
      { label: "chat.jira.core.statusId", value: "3" },
    ]);
    expect(cards[1]?.labels).toContain("chat.jira.core.statusCategoryUnknown");
  });
  it("labels native project-type translation identifiers without treating them as translated prose", () => {
    const [item] = jiraCoreMetadataDetails("jira_project_type_definition", {
      key: "software", formattedKey: "Software", descriptionI18nKey: "project.type.software.description", color: "blue",
      icon: "https://untrusted.invalid/icon",
    });
    expect(item?.name).toBe("Software");
    expect(item).not.toHaveProperty("body");
    expect(item?.facts).toContainEqual({ label: "chat.jira.core.descriptionTranslationKey", value: "project.type.software.description" });
    expect(JSON.stringify(item)).not.toContain("untrusted.invalid");
  });
  it("retains the source type on alternative-type results without substituting its identity", () => {
    const [item] = jiraCoreMetadataDetails("jira_issue_type_alternatives", {
      issueTypeId: "1", items: [{ id: "2", name: "Task", subtask: false }],
    });
    expect(item?.facts).toContainEqual({ label: "chat.jira.core.sourceIssueTypeId", value: "1" });
    expect(item?.facts).toContainEqual({ label: "chat.jira.fact.issueTypeId", value: "2" });
  });
});
