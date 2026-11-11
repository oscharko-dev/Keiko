import { expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { OPTION_SCHEME_MUTATION_CASES as CASES } from "../../../../tests/support/jira-option-scheme-fixture.js";
import {
  JIRA_OPTION_SCHEME_WRITE_DEFINITIONS,
  jiraOptionSchemeMutationDeclarationForTool as declaration,
} from "./jiraOptionSchemeMutationDescriptors.js";
import { jiraAdministrationDeclarationForTool } from "./jiraAdministrationDescriptors.js";
import { jiraRoleDeclarationForTool } from "./jiraRoleDescriptors.js";

it.each(CASES)(
  "keeps the native confirmation boundary for $tool",
  ({ tool, receipt, confirmed }) => {
    const selected = declaration(tool);
    if (selected === undefined) throw new TypeError("Missing scheme declaration");
    const mismatch = describeCatalogSchemaMismatch(selected.descriptor.resultSchema, {
      outcome: "succeeded",
      ...receipt,
    });
    if (confirmed) expect(mismatch).toBeUndefined();
    else expect(mismatch).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(selected.descriptor.resultSchema, {
        outcome: "succeeded-unconfirmed",
        reason: "unavailable",
        ...receipt,
      }),
    ).toBeUndefined();
  },
);
it("declares ten closed native scheme operations with explicit instance administration", () => {
  expect(Object.keys(JIRA_OPTION_SCHEME_WRITE_DEFINITIONS)).toEqual(CASES.map(({ tool }) => tool));
  for (const definition of Object.values(JIRA_OPTION_SCHEME_WRITE_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input)).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result)).toBe(true);
    expect(definition.description).toContain("issue-tracker.admin");
  }
  expect(declaration("jira.scheme-request")).toBeUndefined();
});
it.each(CASES)(
  "admits $tool's actual reviewed snapshot and target receipt",
  ({ tool, args, receipt, confirmed }) => {
    const selected = declaration(tool);
    if (selected === undefined) throw new TypeError("Missing scheme declaration");
    expect(describeCatalogSchemaMismatch(selected.descriptor.inputSchema, args)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(selected.descriptor.resultSchema, {
        outcome: confirmed ? "succeeded" : "succeeded-unconfirmed",
        ...receipt,
      }),
    ).toBeUndefined();
  },
);
it.each([
  { tool: CASES[0].tool, args: { ...CASES[0].args, defaultIssueTypeId: null } },
  { tool: CASES[0].tool, args: { ...CASES[0].args, issueTypeIds: [] } },
  { tool: CASES[0].tool, args: { ...CASES[0].args, issueTypeIDs: ["1"] } },
  { tool: CASES[2].tool, args: { ...CASES[2].args, confirmUnverifiedConsequences: false } },
  { tool: CASES[3].tool, args: { ...CASES[3].args, projects: [] } },
  { tool: CASES[5].tool, args: { ...CASES[5].args, projects: CASES[3].args.projects } },
  { tool: CASES[6].tool, args: { ...CASES[6].args, projects: [] } },
  { tool: CASES[7].tool, args: { ...CASES[7].args, defaultOptionId: 2 } },
  { tool: CASES[9].tool, args: { ...CASES[9].args, url: "https://untrusted.invalid/" } },
])("refuses unsupported or incomplete $tool inputs", ({ tool, args }) => {
  const selected = declaration(tool);
  if (selected === undefined) throw new TypeError("Missing scheme declaration");
  expect(describeCatalogSchemaMismatch(selected.descriptor.inputSchema, args)).toBeDefined();
});
it("keeps full replacement with [] separate from native missing associations", () => {
  const selected = declaration(CASES[4].tool);
  if (selected === undefined) throw new TypeError("Missing association declaration");
  expect(
    describeCatalogSchemaMismatch(selected.descriptor.inputSchema, {
      ...CASES[4].args,
      projects: [],
    }),
  ).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(selected.descriptor.inputSchema, {
      ...CASES[4].args,
      expectedProjects: null,
    }),
  ).toBeDefined();
});
it("admits exact observed read snapshots without converting missing values to null", () => {
  const issue = jiraAdministrationDeclarationForTool("jira.issue-type-scheme");
  const priority = jiraRoleDeclarationForTool("jira.priority-scheme");
  if (issue === undefined || priority === undefined) throw new TypeError("Missing scheme reads");
  const issueRow = {
    id: "7",
    name: "Delivery types",
    reviewSnapshotAvailable: true,
    reviewSnapshot: {
      ...CASES[1].args.expectedScheme,
      description: null,
      defaultIssueTypeId: null,
    },
  };
  expect(
    describeCatalogSchemaMismatch(issue.descriptor.resultSchema, {
      outcome: "succeeded",
      schemeId: "7",
      items: [issueRow],
    }),
  ).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(priority.descriptor.resultSchema, {
      outcome: "succeeded",
      id: "9",
      name: "Delivery priorities",
      reviewSnapshotAvailable: true,
      reviewSnapshot: CASES[8].args.expectedScheme,
    }),
  ).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(issue.descriptor.resultSchema, {
      outcome: "succeeded",
      schemeId: "7",
      items: [{ id: "7", name: "Delivery types", reviewSnapshotAvailable: false }],
    }),
  ).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(issue.descriptor.resultSchema, {
      outcome: "succeeded",
      schemeId: "7",
      items: [
        {
          ...issueRow,
          reviewSnapshot: { id: "7", name: "Delivery types", issueTypeIds: ["1", "2"] },
        },
      ],
    }),
  ).toBeDefined();
});
