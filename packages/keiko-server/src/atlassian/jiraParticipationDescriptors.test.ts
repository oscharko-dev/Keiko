import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraParticipationDeclarationForTool } from "./jiraParticipationDescriptors.js";
import { plainOperationSummary } from "./jiraOperationSummary.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

it.each([
  ["jira.watchers", { issueKey: "APP-1", maxResults: 20 }, "read"],
  ["jira.votes", { issueKey: "APP-1" }, "read"],
  ["jira.watch", { issueKey: "APP-1" }, "write"],
  ["jira.unwatch", { issueKey: "APP-1" }, "write"],
  ["jira.vote", { issueKey: "APP-1" }, "write"],
  ["jira.unvote", { issueKey: "APP-1" }, "write"],
  [
    "jira.create-worklog",
    {
      issueKey: "APP-1",
      timeSpentSeconds: 60,
      started: "2026-11-07T09:00:00.000Z",
      visibility: { type: "group", value: "reviewers" },
    },
    "write",
  ],
  [
    "jira.update-worklog",
    { issueKey: "APP-1", worklogId: "9007199254740993", comment: "" },
    "write",
  ],
] as const)("exposes the typed %s operation through the existing provider", (name, args, risk) => {
  const declaration = jiraParticipationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing participation declaration");
  expect(declaration.risk).toBe(risk);
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  const connection = vi.fn();
  const provider = createJiraProviderForCatalog(connection, [name], vi.fn());
  expect(provider.tools()).toHaveLength(1);
  expect(provider.tools()[0]?.descriptor.inputSchema).toEqual(declaration.descriptor.inputSchema);
  expect(connection).not.toHaveBeenCalled();
});
it.each([
  ["jira.watch", { issueKey: "APP-1", username: "another-user" }],
  ["jira.unvote", { issueKey: "../escape" }],
  ["jira.votes", { issueKey: "APP-1", maxResults: 101 }],
  [
    "jira.create-worklog",
    { issueKey: "APP-1", timeSpentSeconds: 0, started: "2026-11-07T09:00:00.000Z" },
  ],
  [
    "jira.create-worklog",
    { issueKey: "APP-1", timeSpentSeconds: 1.5, started: "2026-11-07T09:00:00.000Z" },
  ],
  [
    "jira.create-worklog",
    {
      issueKey: "APP-1",
      timeSpentSeconds: 60,
      started: "2026-11-07T09:00:00.000Z",
      adjustEstimate: "auto",
    },
  ],
  ["jira.update-worklog", { issueKey: "APP-1", worklogId: "1" }],
  [
    "jira.update-worklog",
    {
      issueKey: "APP-1",
      worklogId: "1",
      comment: "new",
      visibility: { type: "group", value: "other" },
    },
  ],
] as const)("rejects unsupported %s input before execution", (name, args) => {
  const declaration = jiraParticipationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing participation declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it("does not synthesize a worklog deletion or arbitrary property endpoint", () => {
  expect(jiraParticipationDeclarationForTool("jira.delete-worklog")).toBeUndefined();
  expect(jiraParticipationDeclarationForTool("constructor")).toBeUndefined();
});

// Release 1 offers no write for another person as a watcher (#4357, W13/F13). The model reads this
// description on every turn (jira.watch is a base tool), so it can answer in one plain sentence
// without a search or a failed call, and the one-line summary jira.discover returns says the same.
it("tells the model that another person cannot be added as a watcher yet, in the description and the summary", () => {
  const declaration = jiraParticipationDeclarationForTool("jira.watch");
  if (declaration === undefined) throw new TypeError("Missing participation declaration");
  const { description } = declaration.descriptor;
  expect(description).toMatch(/another person as a watcher is not available yet/u);
  expect(description).toMatch(/offer to watch the issue for the user instead/u);
  expect(description).toMatch(/do not search for another tool/u);
  expect(plainOperationSummary(description)).toMatch(/connected Jira user only/u);
  // The operation itself stays typed for the connected user: no user selection exists.
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, {
      issueKey: "APP-1",
      username: "x",
    }),
  ).toBeDefined();
});
