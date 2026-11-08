import { expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  JIRA_WORKLOG_FEED_READ_DEFINITIONS,
  jiraWorklogFeedDeclarationForTool,
} from "./jiraWorklogFeedDescriptors.js";

function declaration(name: string) {
  const selected = jiraWorklogFeedDeclarationForTool(name);
  if (selected === undefined) throw new TypeError("Missing worklog feed declaration");
  return selected;
}
it("compiles two closed read-only native change feeds", () => {
  expect(Object.keys(JIRA_WORKLOG_FEED_READ_DEFINITIONS)).toHaveLength(2);
  for (const [name, definition] of Object.entries(JIRA_WORKLOG_FEED_READ_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), `${name} input`).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), `${name} result`).toBe(true);
    expect(declaration(name).risk).toBe("read");
  }
  expect(jiraWorklogFeedDeclarationForTool("jira.delete-worklog")).toBeUndefined();
  expect(jiraWorklogFeedDeclarationForTool("constructor")).toBeUndefined();
});
it.each([{}, { since: "0" }, { since: "1438013671562" }, { since: "9223372036854775807" }])(
  "admits the lossless cursor %j",
  (args) => {
    expect(
      describeCatalogSchemaMismatch(
        declaration("jira.updated-worklogs").descriptor.inputSchema,
        args,
      ),
    ).toBeUndefined();
  },
);
it.each([
  { since: 0 },
  { since: "01" },
  { since: "-1" },
  { since: null },
  { maxResults: 100 },
  { startAt: 0 },
  { nextPage: "https://external.invalid" },
])("refuses coercion and invented paging inputs %j", (args) => {
  expect(
    describeCatalogSchemaMismatch(
      declaration("jira.deleted-worklogs").descriptor.inputSchema,
      args,
    ),
  ).toBeDefined();
});
it("retains window and exclusion facts without a global completeness or total claim", () => {
  const schema = declaration("jira.updated-worklogs").descriptor.resultSchema;
  const result = {
    outcome: "succeeded",
    changeType: "updated",
    feedScope: "native-visible-change-window",
    timeUnit: "unix-milliseconds",
    excludesLatestMinute: true,
    since: "0",
    until: "1000",
    isLastPage: false,
    nextSince: "1000",
    items: [{ worklogId: "7", changedAt: "1000" }],
  };
  expect(describeCatalogSchemaMismatch(schema, result)).toBeUndefined();
  for (const extra of [
    { total: 1 },
    { complete: true },
    { nextPage: "https://external.invalid" },
    { excludesLatestMinute: false },
    { since: 0 },
    { items: [{ worklogId: "7", changedAt: 1000 }] },
    { changeType: "deleted" },
  ])
    expect(describeCatalogSchemaMismatch(schema, { ...result, ...extra })).toBeDefined();
});
