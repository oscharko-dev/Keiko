import { describe, expect, it } from "vitest";
import { ATLASSIAN_ACTION_APPROVAL_TTL_MS } from "./actionApprovalLimits.js";
import { JIRA_DRAFT_RUN_BUDGET } from "./jiraChatDraft.js";
import { jiraDraftStageDeclaration } from "./jiraDraftDescriptor.js";
import { jiraMutationDeclarations } from "./jiraManagedMutationDescriptors.js";

// Owner decision 2026-11-24: a backlog of a few hundred requirements is created in one approved
// run instead of stopping after ten minutes of creating, and saving a large draft may take thirty
// minutes against a slow Jira.
describe("the time a Jira draft may take", () => {
  it("lets a draft run create for the whole ceiling the jira.draft tool leaves after the approval wait", () => {
    const draft = jiraMutationDeclarations().find((entry) => entry.name === "jira.draft");
    if (draft === undefined) throw new TypeError("jira.draft must be declared");
    expect(JIRA_DRAFT_RUN_BUDGET.writeMs).toBe(JIRA_DRAFT_RUN_BUDGET.totalMs);
    expect(JIRA_DRAFT_RUN_BUDGET.totalMs + ATLASSIAN_ACTION_APPROVAL_TTL_MS).toBe(
      draft.descriptor.bounds.maxDurationMs,
    );
  });

  it("gives one draft-stage call thirty minutes", () => {
    expect(jiraDraftStageDeclaration().descriptor.bounds.maxDurationMs).toBe(30 * 60_000);
  });
});
