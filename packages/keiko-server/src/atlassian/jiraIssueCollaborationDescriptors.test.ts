import { expect, it } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  JIRA_MANAGED_ACTION_TYPES,
  ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK,
  ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { jiraIssueCollaborationDeclarationForTool } from "./jiraIssueCollaborationDescriptors.js";

const ID = "9007199254740993";
it.each([
  [
    "jira.get-comment",
    { issueKey: "APP-1", commentId: ID },
    {
      items: [
        {
          id: ID,
          issueKey: "APP-1",
          body: "Visible comment",
          visibility: { type: "role", value: "Developers" },
        },
      ],
    },
  ],
  [
    "jira.update-comment",
    { issueKey: "APP-1", commentId: ID, body: "Corrected comment" },
    { issueKey: "APP-1", commentId: ID },
  ],
  [
    "jira.link-types",
    { maxResults: 1 },
    {
      items: [{ id: ID, name: "Blocks", inward: "blocked by", outward: "blocks" }],
      total: 1,
      startAt: 0,
    },
  ],
  [
    "jira.issue-link",
    { linkId: ID },
    {
      items: [
        {
          id: ID,
          name: "Blocks",
          inward: "blocked by",
          outward: "blocks",
          inwardIssueKey: "APP-1",
          outwardIssueKey: "APP-2",
        },
      ],
    },
  ],
  [
    "jira.worklogs",
    { issueKey: "APP-1", startAt: 0 },
    { items: [{ id: ID, issueKey: "APP-1", timeSpentSeconds: 1200 }], total: 1, startAt: 0 },
  ],
  [
    "jira.worklog",
    { issueKey: "APP-1", worklogId: ID },
    { items: [{ id: ID, issueKey: "APP-1", timeSpentSeconds: 0 }] },
  ],
] as const)("compiles the typed %s contract without rounding identities", (name, args, result) => {
  const declaration = jiraIssueCollaborationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing collaboration declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...result,
    }),
  ).toBeUndefined();
  const write = name === "jira.update-comment";
  expect(declaration.descriptor.idempotency).toBe("server-key-required");
  const action = JIRA_MANAGED_ACTION_TYPES[name];
  expect(ATLASSIAN_CONNECTOR_ACTION_REQUIRED_SCOPE[action]).toBe(
    write ? "issue-tracker.write" : "issue-tracker.read",
  );
  expect(ATLASSIAN_CONNECTOR_ACTION_APPROVAL_RISK[action]).toBe(write ? "medium" : "low");
});
it.each([
  [
    "jira.update-comment",
    {
      issueKey: "APP-1",
      commentId: ID,
      body: "Changed",
      visibility: { type: "group", value: "public" },
    },
  ],
  ["jira.get-comment", { issueKey: "../APP-1", commentId: ID }],
  ["jira.issue-link", { linkId: Number(ID) }],
  ["jira.worklog", { issueKey: "APP-1", worklogId: "020" }],
  ["jira.worklogs", { issueKey: "APP-1", url: "https://untrusted.invalid" }],
  ["jira.link-types", { maxResults: 101 }],
] as const)("refuses unsupported %s input before dispatch", (name, args) => {
  const declaration = jiraIssueCollaborationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing collaboration declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it("never exposes a proxy, unknown method or inherited entry", () => {
  for (const name of ["jira.proxy", "jira.delete-comment", "constructor"])
    expect(jiraIssueCollaborationDeclarationForTool(name)).toBeUndefined();
});
