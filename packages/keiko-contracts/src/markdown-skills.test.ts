import { describe, expect, it } from "vitest";
import { JIRA_TEMPLATE_PARSE_ERROR_CODES } from "./jira-issue-template.js";
import { isMarkdownSkillRefusalReason, MARKDOWN_SKILL_REFUSAL_REASONS } from "./markdown-skills.js";

describe("Markdown skill refusal reasons (F31)", () => {
  // A new template parse code without a reason would reach the browser as the generic failure.
  it.each(JIRA_TEMPLATE_PARSE_ERROR_CODES)("names a reason for the parse code %s", (code) => {
    expect(MARKDOWN_SKILL_REFUSAL_REASONS).toContain(`template-${code}`);
  });

  it("recognises only its own closed vocabulary", () => {
    for (const reason of MARKDOWN_SKILL_REFUSAL_REASONS) {
      expect(isMarkdownSkillRefusalReason(reason)).toBe(true);
    }
    for (const other of ["INVALID_REQUEST", "", "template-", undefined, null, 4, {}]) {
      expect(isMarkdownSkillRefusalReason(other)).toBe(false);
    }
  });
});
