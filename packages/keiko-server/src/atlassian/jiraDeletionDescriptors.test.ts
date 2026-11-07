import { expect, it, vi } from "vitest";
import {
  ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK,
  JIRA_MANAGED_ACTION_TYPES,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraDeletionDeclarationForTool } from "./jiraDeletionDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const WORKLOG = {
  issueKey: "APP-1", worklogId: "8", timeSpentSeconds: 3600,
  started: "2026-11-07T09:00:00.000Z", comment: "", visibility: null,
} as const;
it.each([
  ["jira.delete-comment", { issueKey: "APP-1", commentId: "7", expectedBody: "Reviewed" }, { commentId: "7" }],
  ["jira.delete-attachment", { issueKey: "APP-1", attachmentId: "9", filename: "scope.txt", size: 20 }, { attachmentId: "9" }],
  ["jira.delete-worklog", WORKLOG, { worklogId: "8" }],
] as const)("declares %s as a high-risk governed effect with its exact reviewed snapshot", (name, args, identity) => {
  const declaration = jiraDeletionDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing deletion declaration");
  expect(declaration.risk).toBe("write");
  expect(ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK[JIRA_MANAGED_ACTION_TYPES[name]]).toBe("high");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
    outcome: "succeeded", issueKey: "APP-1", issueId: "10001", ...identity,
  })).toBeUndefined();
  const connection = vi.fn();
  expect(createJiraProviderForCatalog(connection, [name]).tools()).toHaveLength(1);
  expect(connection).not.toHaveBeenCalled();
});
it.each([
  ["jira.delete-comment", { issueKey: "APP-1", commentId: "7" }],
  ["jira.delete-comment", { issueKey: "APP-1", commentId: "7", expectedBody: "", expectedVisibility: null }],
  ["jira.delete-attachment", { issueKey: "APP-1", attachmentId: "9", filename: "scope.txt", size: -1 }],
  ["jira.delete-attachment", { issueKey: "APP-1", attachmentId: "9", filename: "", size: 0 }],
  ["jira.delete-worklog", { ...WORKLOG, visibility: undefined }],
  ["jira.delete-worklog", { ...WORKLOG, started: "2026-11-07" }],
  ["jira.delete-worklog", { ...WORKLOG, adjustEstimate: "auto" }],
] as const)("refuses incomplete or unreviewed %s input before dispatch", (name, args) => {
  const declaration = jiraDeletionDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing deletion declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
