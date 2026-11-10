import { describe, expect, it } from "vitest";
import { jiraViewSettingsDetails } from "./jira-view-settings-presentation";
import { jiraProjectMetadataDetails } from "./jira-project-metadata-presentation";
import { jiraCollaborationDetails } from "./jira-collaboration-presentation";

describe("saved Jira resource pages and view settings", () => {
  it("reuses version and component identities without interpreting them as issue keys", () => {
    expect(
      jiraProjectMetadataDetails("jira_global_version_page", { versionId: "81", released: false })
        .facts,
    ).toContainEqual({ label: "chat.jira.fact.versionId", value: "81" });
    const component = jiraProjectMetadataDetails("jira_component_page", {
      id: "71",
      project: "SYN",
      deleted: false,
    });
    expect(component.facts).toContainEqual({ label: "chat.jira.fact.componentId", value: "71" });
    expect(component.labels).toContain("chat.jira.metadata.notDeleted");
    expect(
      jiraProjectMetadataDetails("jira_component_page", { id: "71", project: "SYN" }).labels,
    ).toContain("chat.jira.metadata.deletionUnknown");
  });
  it("reuses the link-type direction facts for a selected type", () => {
    const details = jiraCollaborationDetails("jira_link_type", {
      id: "31",
      name: "Blocks",
      inward: "is blocked by",
      outward: "blocks",
    });
    expect(details.facts).toContainEqual({ label: "chat.jira.fact.linkTypeId", value: "31" });
    expect(details.facts).toContainEqual({
      label: "chat.jira.fact.linkInward",
      value: "is blocked by",
    });
  });
  it("keeps accessibility flags separate from the connected-user scope", () => {
    const cards = jiraViewSettingsDetails("jira_accessibility_settings", {
      settingsScope: "connected-user",
      items: [{ key: "first", enabled: false }, { key: "second", enabled: true }, { key: "third" }],
    });
    expect(cards[0]?.labels).toContain("chat.jira.viewSettings.connectedUser");
    expect(cards.slice(1).map(({ labels }) => labels)).toEqual([
      ["chat.jira.viewSettings.disabled"],
      ["chat.jira.viewSettings.enabled"],
      ["chat.jira.viewSettings.enabledUnknown"],
    ]);
  });
  it("retains both native column forms, duplicates, order and signed positions", () => {
    const cards = jiraViewSettingsDetails("jira_filter_columns", {
      layoutScope: "filter",
      selectedFilterId: "42",
      columnsAvailable: true,
      columnConfig: "EXPLICIT",
      items: [
        { id: "summary", position: 1, columnHeadingKey: "native.summary" },
        { id: "summary", position: -1 },
        { value: "status", label: "Native status" },
      ],
    });
    expect(cards.slice(1).map(({ name }) => name)).toEqual(["summary", "summary", "Native status"]);
    expect(cards[2]?.facts).toContainEqual({
      label: "chat.jira.viewSettings.position",
      value: "-1",
    });
    expect(cards[0]?.facts).toContainEqual({
      label: "chat.jira.viewSettings.requestedFilter",
      value: "42",
    });
  });
  it("does not equate unavailable columns with an explicitly empty layout", () => {
    const unknown = jiraViewSettingsDetails("jira_filter_columns", {
      outcome: "succeeded",
      layoutScope: "filter",
      columnsAvailable: false,
    });
    const empty = jiraViewSettingsDetails("jira_filter_columns", {
      outcome: "succeeded",
      layoutScope: "filter",
      columnsAvailable: true,
      items: [],
    });
    expect(unknown[0]?.labels).toContain("chat.jira.viewSettings.columnsUnknown");
    expect(empty[0]?.labels).not.toContain("chat.jira.viewSettings.columnsUnknown");
    expect(unknown[0]?.facts).toEqual([]);
  });
  it("labels selected user names as request context without projecting unrelated native values", () => {
    const cards = jiraViewSettingsDetails("jira_user_columns", {
      layoutScope: "named-user",
      selectedUsername: "Review + QA",
      columnsAvailable: true,
      items: [
        {
          value: "summary",
          label: "Summary",
          self: "https://untrusted.invalid",
          html: "<img src=x>",
        },
      ],
    });
    expect(cards[0]?.facts).toContainEqual({
      label: "chat.jira.viewSettings.requestedUser",
      value: "Review + QA",
    });
    expect(JSON.stringify(cards)).not.toMatch(/untrusted|<img/u);
  });
});
