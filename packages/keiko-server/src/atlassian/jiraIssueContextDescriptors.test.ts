import { expect, it, vi } from "vitest";
import type { AtlassianHttpBodyPort } from "@oscharko-dev/keiko-connectors";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { response } from "../../../../tests/support/jira-managed-remote.js";
import {
  JIRA_ISSUE_CONTEXT_READ_DEFINITIONS,
  jiraIssueContextDeclarationForTool,
} from "./jiraIssueContextDescriptors.js";
import { createJiraProviderForCatalog, jiraOperationForTool } from "./jiraManagedProvider.js";

const ISSUE = { issueId: "10001", issueKey: "SYN-1" };
it("compiles all six bounded issue-context schemas through the existing guard", () => {
  expect(Object.keys(JIRA_ISSUE_CONTEXT_READ_DEFINITIONS)).toHaveLength(6);
  for (const [name, definition] of Object.entries(JIRA_ISSUE_CONTEXT_READ_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(jiraIssueContextDeclarationForTool(name)?.name).toBe(name);
  }
});
it.each([
  ["jira.issue-picker", { query: "", currentJQL: "", showSubTasks: false }, {
    sections: [{ id: "current", issues: [] }, { label: "History" }], suggestionsScope: "native-suggestions",
  }, "/issue/picker"],
  ["jira.pinned-comments", { issueIdOrKey: "SYN-1", maxResults: 1 }, {
    ...ISSUE, items: [{ id: "7", body: "", created: "2026-01-01", pinnedBy: "synthetic-user" }], startAt: 0, total: 1,
  }, "/issue/{issueIdOrKey}/pinned-comments"],
  ["jira.subtasks", { issueIdOrKey: "10001" }, {
    ...ISSUE, items: [{ id: "10002", key: "SYN-2", summary: "Child", browseUrl: "https://jira.example.invalid/browse/SYN-2" }], startAt: 0, total: 1,
  }, "/issue/{issueIdOrKey}/subtask"],
  ["jira.subtask-move-availability", { issueIdOrKey: "syn-1" }, {
    ...ISSUE, canReorderSubtasks: false,
  }, "/issue/{issueIdOrKey}/subtask/move"],
  ["jira.remote-links", { issueIdOrKey: "SYN-1", startAt: 0 }, {
    ...ISSUE, items: [{ id: "9", resolved: false }], startAt: 0, total: 1,
  }, "/issue/{issueIdOrKey}/remotelink"],
  ["jira.remote-links", { issueIdOrKey: "SYN-1", globalId: "external=synthetic" }, {
    ...ISSUE, id: "9", globalId: "external=synthetic", application: {}, summary: "", resolved: false,
  }, "/issue/{issueIdOrKey}/remotelink"],
  ["jira.remote-link", { issueIdOrKey: "SYN-1", linkId: "9" }, {
    ...ISSUE, id: "9", title: "External item",
  }, "/issue/{issueIdOrKey}/remotelink/{linkId}"],
] as const)("binds %s to its closed native read and observed result", (name, args, result, pathTemplate) => {
  const declaration = jiraIssueContextDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing issue-context declaration");
  expect(declaration.risk).toBe("read");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeUndefined();
  expect(jiraOperationForTool(name)?.definition).toMatchObject({
    method: "GET", apiRoot: "/rest/api/2", pathTemplate, effects: ["remote-read"],
  });
  const connection = vi.fn();
  expect(createJiraProviderForCatalog(connection, [name]).tools()).toHaveLength(1);
  expect(connection).not.toHaveBeenCalled();
});
it.each([
  ["jira.issue-picker", { startAt: 0 }],
  ["jira.issue-picker", { query: "x", endpoint: "/search" }],
  ["jira.issue-picker", { currentJQL: "x".repeat(2049) }],
  ["jira.issue-picker", { currentProjectId: 10000 }],
  ["jira.pinned-comments", { issueIdOrKey: "SYN-1", maxResults: 101 }],
  ["jira.subtasks", { issueIdOrKey: "../SYN-1" }],
  ["jira.subtask-move-availability", { issueIdOrKey: "SYN-1", parentId: "10002" }],
  ["jira.remote-links", { issueIdOrKey: "SYN-1", globalId: "" }],
  ["jira.remote-links", { issueIdOrKey: "SYN-1", globalId: "external=synthetic", startAt: 0 }],
  ["jira.remote-links", { issueIdOrKey: "SYN-1", globalId: "external=synthetic", maxResults: 1 }],
  ["jira.remote-link", { issueIdOrKey: "SYN-1", linkId: "0" }],
  ["jira.remote-link", { issueIdOrKey: "SYN-1", linkId: "9", url: "https://remote.example.invalid" }],
] as const)("refuses unsupported %s selectors", (name, args) => {
  const declaration = jiraIssueContextDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing issue-context declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it.each([
  ["jira.issue-picker", { sections: [{ issues: [{ key: "SYN-1", browseUrl: "https://jira.example.invalid/browse/SYN-1", summaryHtml: "<b>hidden</b>" }] }], suggestionsScope: "native-suggestions" }],
  ["jira.issue-picker", { sections: [], suggestionsScope: "complete-issue-inventory" }],
  ["jira.pinned-comments", { ...ISSUE, items: [{ id: "7", body: "Text", created: "observed", author: { emailAddress: "synthetic@example.invalid" } }] }],
  ["jira.subtask-move-availability", { ...ISSUE, canReorderSubtasks: "false" }],
  ["jira.remote-links", { ...ISSUE, items: [{ id: "9", object: { url: "https://remote.example.invalid" } }] }],
  ["jira.remote-link", { ...ISSUE, id: "9", application: { iconUrl: "https://remote.example.invalid/icon" } }],
] as const)("refuses unprojected %s fields and unsupported claims", (name, result) => {
  const declaration = jiraIssueContextDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing issue-context declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, { outcome: "succeeded", ...result })).toBeDefined();
});
it.each([
  ["jira.pinned-comments", { issueIdOrKey: "SYN-1" }, [{ comment: { id: "7", body: "Pinned", created: "2026-01-01" } }], "pinned-comments"],
  ["jira.subtasks", { issueIdOrKey: "SYN-1" }, [{ id: "10002", key: "SYN-2", fields: { summary: "Child", parent: { id: "10001", key: "SYN-1" } } }], "subtask"],
  ["jira.subtask-move-availability", { issueIdOrKey: "SYN-1" }, false, "subtask/move"],
  ["jira.remote-links", { issueIdOrKey: "SYN-1" }, [{ id: 9, object: { title: "External", status: { resolved: false } } }], "remotelink"],
  ["jira.remote-link", { issueIdOrKey: "SYN-1", linkId: "9" }, { id: 9, object: { title: "External" } }, "remotelink/9"],
] as const)("routes %s through the shared provider and observed numeric issue binding", async (name, args, native, suffix) => {
  const http = vi.fn<AtlassianHttpBodyPort>((request) => Promise.resolve(response(
    new URL(request.url).pathname.endsWith("/issue/SYN-1")
      ? { id: "10001", key: "SYN-1", fields: { summary: "Parent" } } : native,
  )));
  const provider = createJiraProviderForCatalog(() => ({
    deployment: "data-center", baseUrl: "https://jira.example.invalid/context", http,
  }), [name]);
  const tool = provider.tools()[0];
  if (tool === undefined) throw new TypeError("Missing selected issue-context tool");
  const result = await tool.execute(args, {
    invocationId: "issue-context", correlationId: "issue-context",
    signal: new AbortController().signal, beforeEffect: () => true,
  });
  expect(result.data).toMatchObject({ outcome: "succeeded", ...ISSUE });
  expect(http.mock.calls).toHaveLength(2);
  expect(http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  expect(http.mock.calls.at(-1)?.[0].url).toBe(`https://jira.example.invalid/context/rest/api/2/issue/10001/${suffix}`);
  expect(result.data.operationBinding).toEqual(jiraOperationForTool(name)?.binding);
});
