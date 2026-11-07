import { describe, expect, it } from "vitest";
import { jiraInstanceDetails } from "./jira-instance-presentation";

describe("observed Jira instance metadata", () => {
  it("keeps version/build observations separate from verification and ignores remote metadata", () => {
    const cards = jiraInstanceDetails("jira_server_info", {
      version: "11.4-SNAPSHOT", versionNumbers: [11, 4, 0], deploymentType: "Data Center",
      serverTitle: "Synthetic Jira", buildNumber: "9007199254740993", databaseBuildNumber: "0",
      baseUrl: "https://untrusted.invalid/context", healthChecks: [{ description: "private health content" }],
      compatibility: { agileApi: "available" },
    });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.instance.versionNumbers", value: "11.4.0" });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.instance.buildNumber", value: "9007199254740993" });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.instance.databaseBuildNumber", value: "0" });
    expect(cards[0]?.labels).toEqual(["chat.jira.instance.serverObservation"]);
    expect(JSON.stringify(cards)).not.toMatch(/untrusted|private health content|agileApi/u);
  });
  it("distinguishes true, false and missing features without inventing time configuration", () => {
    const [card] = jiraInstanceDetails("jira_instance_configuration", { votingEnabled: true, watchingEnabled: false });
    expect(card?.labels).toContain("chat.jira.instance.votingOn");
    expect(card?.labels).toContain("chat.jira.instance.watchingOff");
    expect(card?.labels).toContain("chat.jira.instance.attachmentsUnknown");
    expect(card?.labels).toContain("chat.jira.instance.timeSettingsUnknown");
    expect(card?.facts).toEqual([]);
  });
  it("retains observed zero and fractions in incomplete time settings", () => {
    const [card] = jiraInstanceDetails("jira_instance_configuration", {
      timeTrackingEnabled: false,
      timeTrackingConfiguration: { workingHoursPerDay: 0, workingDaysPerWeek: 4.5, defaultUnit: "hour" },
    });
    expect(card?.facts).toEqual([
      { label: "chat.jira.instance.hoursPerDay", value: "0" },
      { label: "chat.jira.instance.daysPerWeek", value: "4.5" },
    ]);
    expect(card?.labels).toContain("chat.jira.instance.timeTrackingOff");
    expect(card?.labels).toContain("chat.jira.instance.unitHour");
    expect(card?.labels).toContain("chat.jira.instance.timeSettingsPartial");
    expect(card?.labels).not.toContain("chat.jira.instance.formatPretty");
  });
  it("does not infer effective rights from a permission definition or a forged havePermission field", () => {
    const [card] = jiraInstanceDetails("jira_permission_definitions", {
      permissionsScope: "definitions", items: [{
        key: "EDIT_ISSUE", nativeKey: "EDIT_ISSUES", id: "12", name: "Edit issues", type: "PROJECT", havePermission: true,
      }],
    });
    expect(card?.facts).toEqual([
      { label: "chat.jira.instance.definitionKey", value: "EDIT_ISSUE" },
      { label: "chat.jira.instance.nativePermissionKey", value: "EDIT_ISSUES" },
      { label: "chat.jira.instance.definitionId", value: "12" },
    ]);
    expect(card?.labels).toEqual(["chat.jira.access.configurationOnly", "chat.jira.instance.projectDefinition"]);
    expect(JSON.stringify(card)).not.toContain("permissionGranted");
  });
  it("reuses current-user identity projection without email or actor-selection assumptions", () => {
    const [card] = jiraInstanceDetails("jira_myself", {
      key: "U1", name: "Synthetic", displayName: "Synthetic User", active: false,
      emailAddress: "private@example.invalid", self: "https://untrusted.invalid/user",
    });
    expect(card?.name).toBe("Synthetic User");
    expect(card?.labels).toContain("chat.jira.outcome.inactive");
    expect(card?.labels).toContain("chat.jira.directory.deletionUnknown");
    expect(JSON.stringify(card)).not.toMatch(/example.invalid|untrusted.invalid/u);
  });
});
