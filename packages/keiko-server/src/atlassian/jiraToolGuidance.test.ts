import { describe, expect, it } from "vitest";
import { JIRA_TOOL_GUIDANCE } from "./jiraToolGuidance.js";

describe("shared Jira tool guidance", () => {
  // #4357: a deployment model told the person that no delete operation exists although
  // jira.delete-issue is selectable through discovery. A base catalog cannot list every operation,
  // so the one shared instruction says where the rest are and forbids claiming one absent unseen.
  it("says further operations exist behind discovery and must not be claimed absent unseen", () => {
    expect(JIRA_TOOL_GUIDANCE).toMatch(/behind jira\.discover and jira\.describe/u);
    expect(JIRA_TOOL_GUIDANCE).toMatch(/deleting, moving or administering/u);
    expect(JIRA_TOOL_GUIDANCE).toMatch(/Never tell the user an operation does not exist/u);
  });

  // 2026-11-13 lane: nine calls named a tool the model had not selected (`invalid-identity`).
  it("says a tool must be selected with jira.describe before it can be called", () => {
    expect(JIRA_TOOL_GUIDANCE).toMatch(/cannot be called until jira\.describe has selected it/u);
  });

  // remote-link lane 2026-11-13: three of four attempts were refused by the write guard after the
  // model looked for the connected user's key in assignable-users instead of jira.myself.
  it("tells a model where a guarded write's actor key and review evidence come from", () => {
    expect(JIRA_TOOL_GUIDANCE).toMatch(/expectedActorKey \(the key jira\.myself returns\)/u);
    expect(JIRA_TOOL_GUIDANCE).toMatch(/select the read and the write in one jira\.describe/u);
  });

  // The Jira 400 for a localized issue type name ("Der Wert 'Aufgabe' existiert nicht") is the
  // normal case on a German Jira; the id is language independent.
  it("tells a model to name an issue type in JQL by its id", () => {
    expect(JIRA_TOOL_GUIDANCE).toMatch(/issue type by its id from jira\.issue-types/u);
  });
});
