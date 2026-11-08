import { describe, expect, it } from "vitest";
import {
  ATLASSIAN_CONNECTOR_ACTION_CLASS,
  JIRA_MANAGED_ACTION_TYPES,
  decideAtlassianConnectorAction,
  jiraRequiredConnectorScope,
} from "./atlassian-connectors.js";
import { CODING_WORKBENCH_MODES } from "./coding-workbench.js";

const ADMIN_TOOLS = [
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
