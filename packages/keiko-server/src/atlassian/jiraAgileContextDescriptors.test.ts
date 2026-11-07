import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { JIRA_AGILE_CONTEXT_READ_DEFINITIONS, jiraAgileContextDeclarationForTool } from "./jiraAgileContextDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const ISSUE = { id: "10001", key: "SYN-1", summary: "Synthetic", browseUrl: "https://synthetic.invalid/jira/browse/SYN-1" };
const PAGE = { items: [ISSUE], startAt: 0, total: 1 };
it("admits all nine Agile context declarations with unchanged external schema bounds", () => {
  expect(Object.keys(JIRA_AGILE_CONTEXT_READ_DEFINITIONS)).toHaveLength(9);
  for (const [name, definition] of Object.entries(JIRA_AGILE_CONTEXT_READ_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraAgileContextDeclarationForTool(name)?.name).toBe(name);
  }
});
it.each([
  ["jira.board-epicless-issues", { boardId: "7" }, { ...PAGE, boardId: "7", collectionScope: "visible-board-issues" }],
  ["jira.board-epic-issues", { boardId: "7", epicId: "8", jql: "project=SYN" }, { ...PAGE, boardId: "7", epicId: "8", collectionScope: "visible-board-issues" }],
  ["jira.board-projects", { boardId: "7" }, { items: [{ id: "12", key: "SYN", name: "Synthetic", archived: false }], startAt: 0, boardId: "7", collectionScope: "visible-board-projects" }],
  ["jira.board-refined-velocity", { boardId: "7" }, { boardId: "7", value: false }],
  ["jira.board-sprint-issues", { boardId: "7", sprintId: "9" }, { ...PAGE, boardId: "7", sprintId: "9", collectionScope: "visible-board-issues" }],
  ["jira.board-versions", { boardId: "7", released: false }, { items: [{ versionId: "42", name: "Release", releaseDate: "2026-11-07", released: false }], startAt: 0, boardId: "7", collectionScope: "visible-board-versions" }],
  ["jira.epicless-issues", {}, { ...PAGE, collectionScope: "visible-epicless-issues" }],
  ["jira.agile-issue", { issueIdOrKey: "syn-1" }, { ...PAGE, items: [{ ...ISSUE, description: "Native issue text", reporter: { name: "Synthetic" }, duedate: "2026-11-07" }] }],
  ["jira.issue-estimation", { issueIdOrKey: "10001", boardId: "7" }, { boardId: "7", issueId: "10001", issueKey: "SYN-1", fieldId: "customfield_123", value: 0 }],
] as const)("declares %s with its exact native context", (name, args, result) => {
  const declaration = jiraAgileContextDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing Agile context declaration");
  expect(declaration.risk).toBe("read");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeUndefined();
  const connection = vi.fn();
  expect(createJiraProviderForCatalog(connection, [name]).tools()).toHaveLength(1);
  expect(connection).not.toHaveBeenCalled();
});
it.each([
  ["jira.board-epicless-issues", { boardId: 7 }],
  ["jira.board-epic-issues", { boardId: "7", epicId: "SYN-2" }],
  ["jira.board-projects", { boardId: "7", expand: "all" }],
  ["jira.board-refined-velocity", { boardId: "7", value: true }],
  ["jira.board-sprint-issues", { boardId: "7", sprintId: "9", fields: ["description"] }],
  ["jira.board-versions", { boardId: "7", released: "false" }],
  ["jira.epicless-issues", { validateQuery: false }],
  ["jira.epicless-issues", { jql: "" }],
  ["jira.agile-issue", { issueIdOrKey: "SYN-1", updateHistory: true }],
  ["jira.issue-estimation", { issueIdOrKey: "SYN-1" }],
] as const)("refuses unreviewed %s inputs", (name, args) => {
  const declaration = jiraAgileContextDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing Agile context declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.board-projects", { items: [], startAt: 0, boardId: "7", collectionScope: "all-projects" }],
  ["jira.board-versions", { items: [{ versionId: "42", name: "Release", projectId: 12 }], startAt: 0, boardId: "7", collectionScope: "visible-board-versions" }],
  ["jira.board-refined-velocity", { boardId: "7", value: "false" }],
  ["jira.issue-estimation", { boardId: "7", issueId: "10001", issueKey: "SYN-1", fieldId: "customfield_123", value: null }],
  ["jira.issue-estimation", { boardId: "7", issueId: "10001", issueKey: "SYN-1", fieldId: "customfield_123", value: 5, unit: "story-points" }],
  ["jira.agile-issue", { ...PAGE, items: [ISSUE, ISSUE] }],
] as const)("refuses unprojected %s result claims", (name, result) => {
  const declaration = jiraAgileContextDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing Agile context declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeDefined();
});
