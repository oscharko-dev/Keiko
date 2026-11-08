import { describe, expect, it } from "vitest";
import {
  ATLASSIAN_CONNECTOR_ACTION_CLASS,
  JIRA_MANAGED_ACTION_TYPES,
  decideAtlassianConnectorAction,
  jiraRequiredConnectorScope,
} from "./atlassian-connectors.js";
import { CODING_WORKBENCH_MODES } from "./coding-workbench.js";

const ADMIN_TOOLS = [
  "jira.create-issue-type-scheme",
  "jira.update-issue-type-scheme",
  "jira.delete-issue-type-scheme",
  "jira.add-issue-type-scheme-projects",
  "jira.set-issue-type-scheme-projects",
  "jira.clear-issue-type-scheme-projects",
  "jira.remove-issue-type-scheme-project",
  "jira.create-priority-scheme",
  "jira.update-priority-scheme",
  "jira.delete-priority-scheme",
  "jira.create-workflow-scheme",
  "jira.update-workflow-scheme",
  "jira.delete-workflow-scheme",
  "jira.create-workflow-scheme-draft",
  "jira.update-workflow-scheme-draft",
  "jira.delete-workflow-scheme-draft",
  "jira.set-workflow-scheme-default",
  "jira.delete-workflow-scheme-default",
  "jira.set-workflow-scheme-draft-default",
  "jira.delete-workflow-scheme-draft-default",
  "jira.set-workflow-scheme-issue-type",
  "jira.delete-workflow-scheme-issue-type",
  "jira.set-workflow-scheme-draft-issue-type",
  "jira.delete-workflow-scheme-draft-issue-type",
  "jira.set-workflow-scheme-workflow",
  "jira.delete-workflow-scheme-workflow",
  "jira.set-workflow-scheme-draft-workflow",
  "jira.delete-workflow-scheme-draft-workflow",
  "jira.set-application-property",
  "jira.set-system-columns",
  "jira.set-instance-base-url",
  "jira.set-read-only-mode",
  "jira.upload-email-template-pack",
  "jira.apply-email-template-pack",
  "jira.revert-email-template-pack",
  "jira.email-template-pack",
  "jira.create-permission-scheme", "jira.update-permission-scheme", "jira.delete-permission-scheme", "jira.add-permission-grant", "jira.delete-permission-grant", "jira.set-permission-scheme-attribute", "jira.create-role", "jira.update-role", "jira.replace-role", "jira.delete-role", "jira.add-role-default-actors", "jira.delete-role-default-actor", "jira.add-project-role-actors", "jira.set-project-role-actors", "jira.delete-project-role-actor",
  "jira.create-project-category", "jira.update-project-category", "jira.delete-project-category",
  "jira.add-default-screen-field", "jira.add-screen-tab-field", "jira.remove-screen-tab-field", "jira.move-screen-tab-field", "jira.set-screen-field-show-when-empty", "jira.move-screen-tab", "jira.unmap-all-sprints",
  "jira.anonymization-validation", "jira.anonymization-rerun-validation", "jira.anonymization-progress",
  "jira.create-filter", "jira.set-filter-share-scope",
  "jira.add-filter-permission", "jira.delete-filter-permission",
  "jira.set-app-monitoring", "jira.set-ipd-monitoring",
  "jira.start-jmx-metrics", "jira.stop-jmx-metrics",
  "jira.create-screen-tab", "jira.rename-screen-tab", "jira.delete-screen-tab",
  "jira.set-issue-type-property", "jira.delete-issue-type-property",
] as const;

describe("explicit Jira instance administration authority", () => {
  it.each(ADMIN_TOOLS)("requires administration for %s in every mode", (tool) => {
    const action = JIRA_MANAGED_ACTION_TYPES[tool];
    expect(jiraRequiredConnectorScope(tool)).toBe("issue-tracker.admin");
    expect(ATLASSIAN_CONNECTOR_ACTION_CLASS[action]).toBe("connector-admin");
    for (const mode of CODING_WORKBENCH_MODES) {
      expect(decideAtlassianConnectorAction(action, mode,
        ["issue-tracker.read", "issue-tracker.write"], ["connector-access"]))
        .toMatchObject({ disposition: "denied", denyReason: "connector-write-denied" });
      expect(decideAtlassianConnectorAction(action, mode,
        ["issue-tracker.read", "issue-tracker.write", "issue-tracker.admin"], ["connector-access"]))
        .toMatchObject({ disposition: mode === "autonomous-delivery" ? "allowed" : "review-required" });
    }
  });

  it.each([
    "jira.epic-remove-issues", "jira.rank-epic", "jira.rank-issues", "jira.set-issue-estimation", "jira.delete-version-remote-link", "jira.delete-version-remote-links", "jira.upsert-version-remote-link", "jira.upsert-version-remote-link-by-global-id",
    "jira.delete-board", "jira.set-board-refined-velocity", "jira.replace-sprint",
    "jira.delete-sprint", "jira.swap-sprints", "jira.unmap-sprints",
  ] as const)("keeps %s on its independently required ordinary-write grant", (tool) => {
    expect(jiraRequiredConnectorScope(tool)).toBe("issue-tracker.write");
    expect(ATLASSIAN_CONNECTOR_ACTION_CLASS[JIRA_MANAGED_ACTION_TYPES[tool]])
      .toBe("connector-write");
    expect(decideAtlassianConnectorAction(JIRA_MANAGED_ACTION_TYPES[tool],
      "autonomous-delivery", ["issue-tracker.admin"], ["connector-access"]).disposition)
      .toBe("denied");
  });

  it("keeps ordinary writes distinct and still requires the envelope action class", () => {
    expect(jiraRequiredConnectorScope("jira.set-issue-property")).toBe("issue-tracker.write");
    expect(jiraRequiredConnectorScope("jira.set-project-property")).toBe("issue-tracker.write");
    expect(decideAtlassianConnectorAction("update-issue-fields", "autonomous-delivery",
      ["issue-tracker.admin"], ["connector-access"]).disposition).toBe("denied");
    expect(decideAtlassianConnectorAction("set-app-monitoring", "autonomous-delivery",
      ["issue-tracker.admin"], []).disposition).toBe("denied");
  });
});
