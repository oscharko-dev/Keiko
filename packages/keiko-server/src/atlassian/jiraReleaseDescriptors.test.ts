import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  JIRA_RELEASE_READ_DEFINITIONS,
  jiraReleaseDeclarationForTool,
} from "./jiraReleaseDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

it("admits all four release descriptors through the unchanged schema boundary", () => {
  expect(Object.keys(JIRA_RELEASE_READ_DEFINITIONS)).toHaveLength(4);
  for (const [name, definition] of Object.entries(JIRA_RELEASE_READ_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraReleaseDeclarationForTool(name)?.name).toBe(name);
  }
});
it.each([
  [
    "jira.component-related-issue-counts",
    { componentId: "42" },
    { componentId: "42", countScope: "jira-response", issueCount: 0 },
  ],
  [
    "jira.version-related-issue-counts",
    { versionId: "42" },
    {
      versionId: "42",
      countScope: "jira-response",
      issuesAffectedCount: 3,
      issuesFixedCount: 2,
      customFieldNames: [
        { customFieldId: "10001", fieldName: "Delivery", issueCountWithVersionInCustomField: 0 },
      ],
    },
  ],
  [
    "jira.version-unresolved-issue-count",
    { versionId: "42" },
    { versionId: "42", countScope: "jira-response" },
  ],
  [
    "jira.project-version-page",
    { projectIdOrKey: "SYN", maxResults: 1, orderBy: "+name" },
    {
      projectId: "12",
      projectKey: "SYN",
      items: [{ versionId: "42", name: "Release", released: false }],
      startAt: 0,
      nextStartAt: 1,
    },
  ],
] as const)("declares %s as observational metadata", (name, args, result) => {
  const declaration = jiraReleaseDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing release declaration");
  expect(declaration.risk).toBe("read");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...result,
    }),
  ).toBeUndefined();
  const connection = vi.fn();
  expect(createJiraProviderForCatalog(connection, [name]).tools()).toHaveLength(1);
  expect(connection).not.toHaveBeenCalled();
});
it.each([
  ["jira.component-related-issue-counts", { componentId: 42 }],
  ["jira.version-related-issue-counts", { versionId: "0" }],
  ["jira.version-unresolved-issue-count", { versionId: "42", jql: "project=SYN" }],
  ["jira.project-version-page", { projectIdOrKey: "SYN", orderBy: "remoteLink" }],
  ["jira.project-version-page", { projectIdOrKey: "SYN", expand: "all" }],
  ["jira.project-version-page", { projectIdOrKey: "SYN", maxResults: 101 }],
] as const)("refuses unreviewed %s selectors", (name, args) => {
  const declaration = jiraReleaseDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing release declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  [
    "jira.component-related-issue-counts",
    { componentId: "42", countScope: "jira-response", issueCount: -1 },
  ],
  [
    "jira.version-unresolved-issue-count",
    { versionId: "42", countScope: "reconciled-report", issuesUnresolvedCount: 0 },
  ],
  [
    "jira.version-related-issue-counts",
    { versionId: "42", countScope: "jira-response", customFieldNames: ["Field"] },
  ],
  [
    "jira.version-related-issue-counts",
    {
      versionId: "42",
      countScope: "jira-response",
      customFieldNames: [
        { customFieldId: "7", fieldName: "Delivery", issueCountWithVersionInCustomField: 1.5 },
      ],
    },
  ],
  [
    "jira.project-version-page",
    {
      projectId: "12",
      projectKey: "SYN",
      items: [{ versionId: "42", name: "Release", projectId: 12 }],
      startAt: 0,
    },
  ],
  [
    "jira.project-version-page",
    {
      projectId: "12",
      projectKey: "SYN",
      items: [],
      startAt: 0,
      nextPage: "https://synthetic.invalid/next",
    },
  ],
] as const)("refuses unprojected %s result claims", (name, result) => {
  const declaration = jiraReleaseDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing release declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...result,
    }),
  ).toBeDefined();
});
