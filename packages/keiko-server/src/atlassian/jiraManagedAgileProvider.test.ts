import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  JiraManagedReadToolName,
  JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { jiraAgileDeclarationForTool } from "./jiraAgileDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const READS = [
  ["jira.boards", {}],
  ["jira.board", { boardId: "31" }],
  ["jira.board-configuration", { boardId: "31" }],
  ["jira.board-backlog", { boardId: "31" }],
  ["jira.board-issues", { boardId: "31" }],
  ["jira.board-epics", { boardId: "31" }],
  ["jira.epic", { epicIdOrKey: "SYN-1" }],
  ["jira.epic-issues", { epicIdOrKey: "SYN-1" }],
  ["jira.sprints", { boardId: "31" }],
  ["jira.sprint", { sprintId: "41" }],
  ["jira.sprint-issues", { sprintId: "41" }],
  ["jira.filter", { filterId: "51" }],
  ["jira.favourite-filters", { startAt: 0, maxResults: 25 }],
] as const satisfies readonly (readonly [JiraManagedReadToolName, CatalogJsonObject])[];
const WRITES = [
  ["jira.board-create", { name: "Delivery", type: "scrum", filterId: "51" }],
  ["jira.sprint-create", { name: "Iteration", originBoardId: "31" }],
  ["jira.sprint-update", { sprintId: "41", goal: "Ready" }],
  ["jira.sprint-move-issues", { sprintId: "41", issues: ["SYN-1"] }],
  ["jira.backlog-move-issues", { issues: ["SYN-1"] }],
  ["jira.epic-update", { epicIdOrKey: "SYN-1", done: true }],
  ["jira.epic-move-issues", { epicIdOrKey: "SYN-1", issues: ["SYN-2"] }],
] as const satisfies readonly (readonly [JiraMutationOperation, CatalogJsonObject])[];

it.each([...READS, ...WRITES])("offers the selected closed %s declaration", (name, args) => {
  const connection = vi.fn();
  const executeMutation = vi.fn();
  const provider = createJiraProviderForCatalog(connection, [name], executeMutation);
  const tools = provider.tools();
  expect(tools).toHaveLength(1);
  const tool = tools[0];
  const expected = jiraAgileDeclarationForTool(name);
  if (tool === undefined || expected === undefined) throw new TypeError("Missing Jira tool");
  expect(tool.name).toBe(name);
  expect(tool.risk).toBe(expected.risk);
  expect(tool.descriptor.inputSchema).toEqual(expected.descriptor.inputSchema);
  expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, args)).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(tool.descriptor.inputSchema, {
      ...args,
      endpoint: "/rest/api/2/arbitrary",
    }),
  ).toBeDefined();
  expect(tool.descriptor.resultSchema.required).toEqual(
    expect.arrayContaining(["outcome", "operationBinding"]),
  );
  expect(connection).not.toHaveBeenCalled();
  expect(executeMutation).not.toHaveBeenCalled();
});

it.each(WRITES)("requires the existing mutation executor for %s", (name) => {
  const connection = vi.fn();
  expect(() => createJiraProviderForCatalog(connection, [name])).toThrow(TypeError);
  expect(connection).not.toHaveBeenCalled();
});

it("keeps core project and issue declarations available beside the selected Agile tools", () => {
  const names = [
    "jira.project",
    "jira.create-project",
    "jira.issue",
    "jira.board",
    "jira.sprint-update",
  ] as const;
  const provider = createJiraProviderForCatalog(vi.fn(), names, vi.fn());
  expect(provider.tools().map((tool) => tool.name)).toEqual(names);
});
