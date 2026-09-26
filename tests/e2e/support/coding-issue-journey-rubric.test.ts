import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { requiredIndependentReviewCriteria } from "./coding-issue-journey-rubric.js";

const RUBRIC = `## Common independent review criteria
- \`shared-check\`: Common criterion.
### Issue #1 — first fixture
- \`issue-check\`: Issue criterion.
`;

function criteria(text: string, issue = 1): readonly string[] {
  const bytes = Buffer.from(text);
  return requiredIndependentReviewCriteria(
    bytes,
    issue,
    createHash("sha256").update(bytes).digest("hex"),
  );
}

describe("frozen independent-review criterion inventory", () => {
  it("combines common and issue criteria without including the next issue", () => {
    expect(
      criteria(`${RUBRIC}### Issue #3 — next fixture\n- \`next-check\`: Another issue.\n`),
    ).toEqual(["shared-check", "issue-check"]);
  });

  it.each([
    RUBRIC.replace("issue-check", "shared-check"),
    RUBRIC.replace("- `issue-check`:", "- Missing criterion ID:"),
    RUBRIC.replace("- `issue-check`: Issue criterion.", ""),
    `${RUBRIC}### Issue #1 — duplicated\n- \`duplicate-check\`: Duplicate heading.\n`,
  ])("fails closed when the owning criterion inventory is malformed", (text) => {
    expect(() => criteria(text)).toThrow("frozen rubric");
  });

  it("requires the requested issue's own section", () => {
    expect(() => criteria(RUBRIC, 7)).toThrow("missing or repeated");
  });

  it("finds a complete nonempty inventory for each of the actual five registered fixtures", () => {
    const rubric = readFileSync(
      resolve("docs/qa/evidence/coding-issue-journey/3390/rubric.md"),
      "utf8",
    );
    for (const issue of [1, 3, 4, 5, 6]) {
      const ids = criteria(rubric, issue);
      expect(ids).toContain("exact-head-required-ci");
      expect(ids).toContain("observed-red-green");
      expect(ids.length).toBeGreaterThan(4);
    }
  });
});
