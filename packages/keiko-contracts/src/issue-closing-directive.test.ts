import { describe, expect, it } from "vitest";
import { hasIssueClosingDirective } from "./issue-closing-directive.js";

describe("untrusted issue-closing directives", () => {
  it.each([
    "close",
    "closes",
    "closed",
    "fix",
    "fixes",
    "fixed",
    "resolve",
    "resolves",
    "resolved",
  ])("rejects every GitHub keyword %s and supported reference form", (keyword) => {
    for (const target of ["#42", "Owner/repo-name#42", "https://github.com/Owner/repo/issues/42"])
      expect(hasIssueClosingDirective(`Summary\n\n${keyword.toUpperCase()}: ${target}`)).toBe(true);
  });

  it.each([
    "fix: implement the feature",
    "Refs #42",
    "Fixes the issue described in #42",
    "enclosed #42",
    "prefix #42",
    "resolve dependencies",
    "Please close the dialog",
  ])("keeps ordinary prose and advisory linkage: %s", (message) => {
    expect(hasIssueClosingDirective(message)).toBe(false);
  });

  it.each([
    "Fixes\n#42",
    "<!-- closes #42 -->",
    "`resolves #42`",
    "closed:Owner/repo#42",
    "fixed http://example.invalid/target",
    "closes https://example.invalid/target",
  ])("preserves the commit producer's conservative refusal: %s", (message) => {
    expect(hasIssueClosingDirective(message)).toBe(true);
  });
});
