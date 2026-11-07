import { describe, expect, it } from "vitest";
import { jiraAccessDetails } from "./jira-access-presentation";

describe("readable Jira access configuration projections", () => {
  it("binds each permission grant to its scheme without asserting effective access", () => {
    const cards = jiraAccessDetails("jira_permission_scheme", {
      id: "9007199254740993",
      name: "Engineering access",
      permissions: [{
        id: "91", permission: "BROWSE_PROJECTS",
        holder: { type: "group", parameter: "Developers", emailAddress: "private@example.invalid" },
        self: "https://untrusted.invalid/grant",
      }],
    });
    expect(cards).toHaveLength(2);
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.access.grantCount", value: "1" });
    expect(cards[1]?.facts).toEqual([
      { label: "chat.jira.access.grantId", value: "91" },
      { label: "chat.jira.access.schemeId", value: "9007199254740993" },
      { label: "chat.jira.access.permission", value: "BROWSE_PROJECTS" },
      { label: "chat.jira.access.holderType", value: "group" },
      { label: "chat.jira.access.holderParameter", value: "Developers" },
    ]);
    expect(cards.every((card) => card.labels.includes("chat.jira.access.configurationOnly"))).toBe(true);
    expect(JSON.stringify(cards)).not.toContain("example.invalid");
  });
  it.each([undefined, null, [null], [{}]])("keeps missing or unreadable grants unknown: %j", (permissions) => {
    const cards = jiraAccessDetails("jira_permission_scheme", { id: "37", name: "Access", permissions });
    expect(cards[0]?.labels).toContain("chat.jira.access.grantsUnknown");
    expect(cards[0]?.facts.some((fact) => fact.label === "chat.jira.access.grantCount")).toBe(false);
  });
  it("distinguishes explicit empty grants and levels from unknown collections", () => {
    const grants = jiraAccessDetails("jira_permission_scheme", { id: "37", name: "Access", permissions: [] });
    const levels = jiraAccessDetails("jira_issue_security_scheme", { id: "38", name: "Security", levels: [] });
    expect(grants[0]?.facts).toContainEqual({ label: "chat.jira.access.grantCount", value: "0" });
    expect(levels[0]?.facts).toContainEqual({ label: "chat.jira.access.levelCount", value: "0" });
    expect(levels[0]?.facts.some((fact) => fact.label === "chat.jira.access.defaultLevelId")).toBe(false);
  });
  it("preserves default-level and nested-level identities without inferring membership", () => {
    const cards = jiraAccessDetails("jira_issue_security_scheme", {
      id: "37", name: "Engineering security", defaultSecurityLevelId: "91",
      levels: [{ id: "91", name: "Restricted", description: "A configured level" }],
    });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.access.defaultLevelId", value: "91" });
    expect(cards[1]).toMatchObject({ name: "Restricted", body: "A configured level" });
    expect(cards[1]?.facts).toContainEqual({ label: "chat.jira.access.schemeId", value: "37" });
  });
  it.each([false, true])("does not turn unavailable event expansion into an empty scheme: requested=%s", (eventsRequested) => {
    const cards = jiraAccessDetails("jira_notification_scheme", {
      eventsRequested, items: [{ id: "37", name: "Notifications", eventsAvailable: false }],
    });
    expect(cards[0]?.labels).toContain(eventsRequested
      ? "chat.jira.access.eventsUnavailable" : "chat.jira.access.eventsNotRequested");
    expect(cards[0]?.facts.some((fact) => fact.label === "chat.jira.access.eventCount")).toBe(false);
  });
  it("shows an explicit empty event expansion as known zero", () => {
    const cards = jiraAccessDetails("jira_notification_scheme", {
      eventsRequested: true,
      items: [{ id: "37", name: "Notifications", eventsAvailable: true, events: [] }],
    });
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.access.eventCount", value: "0" });
  });
  it("retains event/recipient relationships and only the explicit email-address recipient", () => {
    const cards = jiraAccessDetails("jira_project_notification_scheme", {
      projectId: "10000", projectKey: "SYN", eventsRequested: true,
      items: [{
        id: "37", name: "Notifications", eventsAvailable: true,
        events: [{
          id: "81", name: "Issue updated", templateEvents: [{ id: "82", name: "Template" }],
          notifications: [
            { id: "91", notificationType: "User", user: { key: "U1", name: "recipient", active: false, emailAddress: "hidden@example.invalid" }, emailAddress: "also-hidden@example.invalid" },
            { id: "92", notificationType: "EmailAddress", emailAddress: "configured@example.invalid" },
          ],
        }],
      }],
    });
    expect(cards).toHaveLength(5);
    expect(cards[0]?.facts).toContainEqual({ label: "chat.jira.fact.projectKey", value: "SYN" });
    expect(cards[2]?.facts).toContainEqual({ label: "chat.jira.access.eventId", value: "81" });
    expect(cards[2]?.labels).toContain("chat.jira.outcome.inactive");
    expect(cards[3]?.facts).toContainEqual({ label: "chat.jira.access.recipientEmail", value: "configured@example.invalid" });
    expect(cards[4]?.facts).toContainEqual({ label: "chat.jira.access.parentEventId", value: "81" });
    expect(JSON.stringify(cards)).not.toContain("hidden@example.invalid");
  });
  it("keeps absent recipients unknown while explicit empty recipients remain zero", () => {
    const cards = jiraAccessDetails("jira_notification_scheme", {
      eventsRequested: true,
      items: [{ id: "37", name: "Notifications", eventsAvailable: true, events: [
        { id: "81", name: "Unknown" }, { id: "82", name: "Empty", notifications: [] },
      ] }],
    });
    expect(cards[1]?.labels).toContain("chat.jira.access.recipientsUnknown");
    expect(cards[1]?.facts.some((fact) => fact.label === "chat.jira.access.recipientCount")).toBe(false);
    expect(cards[2]?.facts).toContainEqual({ label: "chat.jira.access.recipientCount", value: "0" });
  });
  it("reads flat recipient metadata while preserving saved nested recipient cards", () => {
    const context = { eventsRequested: true, items: [{ id: "37", name: "Notifications", eventsAvailable: true,
      events: [{ id: "81", notifications: [
        { id: "91", notificationType: "User", recipientKind: "user", recipientKey: "U1", recipientName: "Current", recipientDisplayName: "Current person", recipientActive: false, user: { name: "Obsolete nested person" } },
        { id: "92", notificationType: "Group", recipientKind: "group", recipientName: "Engineers" },
        { id: "93", notificationType: "ProjectRole", recipientKind: "projectRole", recipientId: "10002", recipientName: "Reviewers", recipientDescription: "Configured reviewers" },
        { id: "94", notificationType: "UserCustomField", recipientKind: "field", recipientId: "customfield_10001", recipientName: "Review contact", recipientDescription: "Unsupported field description" },
        { id: "95", notificationType: "User", user: { key: "U2", name: "Legacy person", active: true } },
      ] }],
    }] };
    const cards = jiraAccessDetails("jira_notification_scheme", context);
    expect(cards[2]?.facts).toContainEqual({ label: "chat.jira.fact.userName", value: "Current" });
    expect(cards[2]?.labels).toContain("chat.jira.outcome.inactive");
    expect(cards[3]?.facts).toContainEqual({ label: "chat.jira.fact.groupName", value: "Engineers" });
    expect(cards[4]).toMatchObject({ body: "Configured reviewers" });
    expect(cards[4]?.facts).toContainEqual({ label: "chat.jira.fact.roleId", value: "10002" });
    expect(cards[5]?.facts).toContainEqual({ label: "chat.jira.access.fieldId", value: "customfield_10001" });
    expect(cards[6]?.facts).toContainEqual({ label: "chat.jira.fact.userName", value: "Legacy person" });
    expect(JSON.stringify(cards)).not.toContain("Obsolete nested person");
    expect(JSON.stringify(cards)).not.toContain("Unsupported field description");
  });
  it("does not reinterpret a mismatched flat recipient kind through legacy fallback", () => {
    const cards = jiraAccessDetails("jira_notification_scheme", {
      eventsRequested: true, items: [{ id: "37", name: "Notifications", eventsAvailable: true,
        events: [{ id: "81", notifications: [{ id: "91", notificationType: "User", recipientKind: "group", recipientName: "Wrong group", user: { name: "Wrong fallback" } }] }],
      }],
    });
    expect(cards[2]?.facts.some(({ label }) => label === "chat.jira.fact.userName")).toBe(false);
    expect(JSON.stringify(cards)).not.toMatch(/Wrong group|Wrong fallback/u);
  });
});
