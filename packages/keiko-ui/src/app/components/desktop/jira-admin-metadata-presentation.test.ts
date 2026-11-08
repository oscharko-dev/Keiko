import { describe, expect, it } from "vitest";
import {
  jiraAdminMetadataDetails,
  jiraAdminMetadataNotice,
} from "./jira-admin-metadata-presentation";

describe("native administrative metadata presentation", () => {
  it("reuses screen identity while keeping the native deletion flag separate from authority", () => {
    const cards = jiraAdminMetadataDetails("jira_screens", {
      items: [{ id: "71", name: "Issue details", deletable: false }],
    });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.fact.screenId", value: "71" });
    expect(cards[0]?.labels).toEqual([
      "chat.jira.adminMetadata.configurationOnly",
      "chat.jira.adminMetadata.notDeletable",
    ]);
  });
  it("keeps observed workflow zero/default false and literal dates without projecting modification users", () => {
    const cards = jiraAdminMetadataDetails("jira_workflows", {
      items: [
        {
          name: "Review",
          steps: 0,
          isDefault: false,
          lastModifiedDate: "07/Nov/26",
          lastModifiedUser: "Private name",
        },
      ],
    });
    expect(cards[0]?.facts).toContainEqual({
      label: "chat.jira.adminMetadata.workflowSteps",
      value: "0",
    });
    expect(cards[0]?.facts).toContainEqual({
      label: "chat.jira.adminMetadata.workflowModified",
      value: "07/Nov/26",
    });
    expect(cards[0]?.labels).toContain("chat.jira.adminMetadata.notDefaultWorkflow");
    expect(JSON.stringify(cards)).not.toContain("Private name");
  });
  it("retains empty field scopes and counts without manufacturing unknown flags", () => {
    const cards = jiraAdminMetadataDetails("jira_custom_fields", {
      items: [
        {
          id: "customfield_10001",
          name: "Delivery",
          numericId: "10001",
          projectIds: [],
          issueTypeIds: [],
          isLocked: false,
          issuesWithValue: 0,
          type: "Native text",
          searcherKey: "native:searcher",
        },
      ],
    });
    expect(cards[0]?.facts).toContainEqual({
      label: "chat.jira.adminMetadata.projectIdsCount",
      value: "0",
    });
    expect(cards[0]?.facts).toContainEqual({
      label: "chat.jira.adminMetadata.issuesWithValue",
      value: "0",
    });
    expect(cards[0]?.labels).toContain("chat.jira.adminMetadata.notLocked");
    expect(cards[0]?.labels).toContain("chat.jira.adminMetadata.managementUnknown");
    expect(cards[0]?.labels).toContain("chat.jira.adminMetadata.countsUnknown");
  });
  it("keeps native option pages and empty options distinct from context completeness", () => {
    const data = {
      outcome: "succeeded",
      customFieldId: "10001",
      optionsScope: "native-context-options",
      page: 2,
      nextPage: 3,
      items: [{ id: "91", value: "", disabled: false, childrenIds: [] }],
    };
    const cards = jiraAdminMetadataDetails("jira_custom_field_options", data);
    expect(cards[0]?.facts).toContainEqual({
      label: "chat.jira.adminMetadata.optionPage",
      value: "2",
    });
    expect(cards[0]?.labels).toContain("chat.jira.adminMetadata.optionScopeOnly");
    expect(cards[1]?.labels).toContain("chat.jira.lookup.emptyOptionValue");
    expect(cards[1]?.labels).toContain("chat.jira.lookup.optionEnabled");
    expect(jiraAdminMetadataNotice("jira_custom_field_options", data)).toBe("chat.jira.partial");
    expect(
      jiraAdminMetadataNotice("jira_custom_field_options", {
        ...data,
        page: 1,
        nextPage: undefined,
      }),
    ).toBeUndefined();
  });
  it("preserves native terminology case and missing optional labels", () => {
    const cards = jiraAdminMetadataDetails("jira_terminology_entry", {
      originalName: "Epic",
      newName: "Initiative",
      isDefault: false,
    });
    expect(cards[0]?.facts).toContainEqual({
      label: "chat.jira.adminMetadata.originalName",
      value: "Epic",
    });
    expect(cards[0]?.labels).toEqual([
      "chat.jira.adminMetadata.customTerminology",
      "chat.jira.adminMetadata.terminologyUnknown",
    ]);
  });
  it.each([
    [true, "readOnlyEnabled"],
    [false, "readOnlyDisabled"],
    [undefined, "readOnlyUnknown"],
  ] as const)("keeps read-only %s as an observation", (enabled, suffix) => {
    const cards = jiraAdminMetadataDetails("jira_read_only_mode", {
      outcome: "succeeded",
      enabled,
      message: "",
      endTime: "07/Nov/26 21:30",
      timeZone: "",
    });
    expect(cards[0]?.labels).toContain(`chat.jira.adminMetadata.${suffix}`);
    expect(cards[0]?.labels).toContain("chat.jira.adminMetadata.emptyMessage");
    expect(cards[0]?.facts).toContainEqual({
      label: "chat.jira.adminMetadata.readOnlyEnd",
      value: "07/Nov/26 21:30",
    });
  });
  it("does not render a failed read as an observed unknown setting", () => {
    expect(
      jiraAdminMetadataDetails("jira_read_only_mode", {
        outcome: "failed",
        reason: "permission-denied",
      }),
    ).toEqual([]);
  });
});
