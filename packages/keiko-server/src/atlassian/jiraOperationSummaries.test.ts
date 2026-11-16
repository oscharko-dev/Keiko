import { describe, expect, it } from "vitest";
import { jiraOperationContracts } from "./jiraManagedProvider.js";
import { JIRA_OPERATION_SUMMARIES } from "./jiraOperationSummaries.generated.js";
import { OPERATION_SUMMARY_MAX_CHARS, plainOperationSummary } from "./jiraOperationSummary.js";

describe("the Jira operation summaries behind jira.discover (#4357)", () => {
  // The table is generated so that discovery never builds all 443 descriptors at its first call; this
  // test is what keeps it honest: every summary derives, through the production function, from the
  // descriptor the operation really carries.
  it("has one current summary per operation, derived from its descriptor", () => {
    const contracts = jiraOperationContracts();
    expect(Object.keys(JIRA_OPERATION_SUMMARIES).sort()).toEqual(
      contracts.map((contract) => contract.definition.tool).sort(),
    );
    for (const contract of contracts)
      expect(JIRA_OPERATION_SUMMARIES[contract.definition.tool], contract.definition.tool).toBe(
        plainOperationSummary(contract.declaration.descriptor.description),
      );
  });

  it("is one plain line per operation", () => {
    for (const [tool, summary] of Object.entries(JIRA_OPERATION_SUMMARIES)) {
      expect(summary, tool).toMatch(/^[A-Z]/u);
      expect(summary, tool).not.toMatch(/\n/u);
      expect(summary.length, tool).toBeLessThanOrEqual(OPERATION_SUMMARY_MAX_CHARS);
      expect(summary.length, tool).toBeGreaterThan(10);
    }
  });
});

describe("plainOperationSummary", () => {
  it("takes the first sentence, collapses whitespace and cuts a long one at a word boundary", () => {
    expect(plainOperationSummary("Read one thing.  Then\n do more.")).toBe("Read one thing.");
    expect(plainOperationSummary("No full stop here")).toBe("No full stop here");
    const long = `Read ${"alpha ".repeat(60)}end.`;
    const cut = plainOperationSummary(long);
    expect(cut.length).toBeLessThanOrEqual(OPERATION_SUMMARY_MAX_CHARS);
    expect(cut).toMatch(/alpha\.$/u);
  });
});
