import { describe, expect, it } from "vitest";
import { JIRA_MUTATION_OPERATIONS } from "./jira-tool-execution.js";
import {
  JIRA_NOT_GOVERNED_REASONS,
  JIRA_TEMPLATE_GOVERNANCE,
  jiraTemplateGovernanceOf,
} from "./jira-template-governance.js";

describe("template governance of every Jira mutating operation (#4354 A.7)", () => {
  it("classifies each registered operation, and only registered operations", () => {
    expect(Object.keys(JIRA_TEMPLATE_GOVERNANCE).sort()).toEqual(
      [...JIRA_MUTATION_OPERATIONS].sort(),
    );
    for (const operation of JIRA_MUTATION_OPERATIONS)
      expect(jiraTemplateGovernanceOf(operation), operation).toBeDefined();
  });

  it("answers undefined for a name that is not a registered mutation", () => {
    expect(jiraTemplateGovernanceOf("jira.search")).toBeUndefined();
    expect(jiraTemplateGovernanceOf("toString")).toBeUndefined();
    expect(jiraTemplateGovernanceOf("constructor")).toBeUndefined();
  });

  it("puts the issue-content writes behind a gate class", () => {
    expect(jiraTemplateGovernanceOf("jira.create")).toEqual({ class: "create" });
    expect(jiraTemplateGovernanceOf("jira.create-issues")).toEqual({ class: "create-batch" });
    expect(jiraTemplateGovernanceOf("jira.edit")).toEqual({ class: "edit" });
    expect(jiraTemplateGovernanceOf("jira.assign")).toEqual({ class: "edit" });
    expect(jiraTemplateGovernanceOf("jira.transition")).toEqual({ class: "transition" });
    expect(jiraTemplateGovernanceOf("jira.draft")).toEqual({ class: "draft" });
  });

  it("names move-subtask, archive, restore and deletion explicitly, with their reason", () => {
    for (const operation of [
      "jira.move-subtask",
      "jira.archive-issue",
      "jira.archive-issues",
      "jira.restore-issue",
      "jira.delete-issue",
    ])
      expect(jiraTemplateGovernanceOf(operation), operation).toEqual({
        class: "not-governed",
        reason: "issue-lifecycle",
      });
  });

  it("leaves comments, watchers and the withdrawn attachments ungoverned on purpose", () => {
    expect(jiraTemplateGovernanceOf("jira.comment")).toEqual({
      class: "not-governed",
      reason: "comment",
    });
    expect(jiraTemplateGovernanceOf("jira.watch")).toEqual({
      class: "not-governed",
      reason: "participation",
    });
    expect(jiraTemplateGovernanceOf("jira.attach")).toEqual({
      class: "not-governed",
      reason: "attachment-withdrawn",
    });
  });

  it("uses every closed reason at least once, so none is dead", () => {
    const used = new Set(
      Object.values(JIRA_TEMPLATE_GOVERNANCE).flatMap((entry) =>
        entry.class === "not-governed" ? [entry.reason] : [],
      ),
    );
    expect([...used].sort()).toEqual([...JIRA_NOT_GOVERNED_REASONS].sort());
  });
});
