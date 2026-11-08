import { describe, expect, it } from "vitest";
import { PROJECT_CATEGORY_FIXTURE_CASES } from "../../../../tests/support/jira-project-category-fixture.js";
import { jiraProjectCategoryMutationDeclarationForTool as declaration } from "./jiraProjectCategoryMutationDescriptors.js";

describe("closed project category mutation declarations", () => {
  it.each(PROJECT_CATEGORY_FIXTURE_CASES)("declares $name on the existing write path", ({ name }) => {
    const actual = declaration(name);
    expect(actual?.name).toBe(name);
    expect(actual?.risk).toBe("write");
    expect(actual?.descriptor.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
  });
  it("does not expose generic categories or arbitrary native paths", () => {
    for (const name of ["jira.project-category", "jira.raw-http", "DELETE /rest/api/2/projectCategory/7"])
      expect(declaration(name)).toBeUndefined();
  });
});
