import { describe, expect, it } from "vitest";
import { JIRA_TOOL_GUIDANCE } from "./jiraToolGuidance.js";

describe("shared Jira tool guidance", () => {
  // #4357: a deployment model told the person that no delete operation exists although
  // jira.delete-issue is selectable through discovery. A base catalog cannot list every operation,
  // so the one shared instruction says where the rest are and forbids claiming one absent unseen.
  it("says further operations exist behind discovery and must not be claimed absent unseen", () => {
    expect(JIRA_TOOL_GUIDANCE).toMatch(/behind jira\.discover and jira\.describe/u);
    expect(JIRA_TOOL_GUIDANCE).toMatch(/deleting, moving or administering/u);
    expect(JIRA_TOOL_GUIDANCE).toMatch(/never tell the user an operation does not exist/u);
  });

  // The Jira 400 for a localized issue type name ("Der Wert 'Aufgabe' existiert nicht") is the
  // normal case on a German Jira; the id is language independent.
  it("tells a model to name an issue type in JQL by its id", () => {
    expect(JIRA_TOOL_GUIDANCE).toMatch(/issue type by its id from jira\.issue-types/u);
  });
});
