import { expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  JIRA_LINK_WRITE_DEFINITIONS,
  jiraLinkMutationDeclarationForTool,
} from "./jiraLinkMutationDescriptors.js";

const VALUE = {
  globalId: "synthetic:42",
  applicationType: null,
  applicationName: null,
  relationship: null,
  url: "https://example.invalid/item/42",
  title: "Synthetic item",
  summary: null,
  iconUrl: null,
  iconTitle: null,
  resolved: false,
  statusIconUrl: null,
  statusIconTitle: null,
  statusIconLink: null,
};
const REMOTE = { issueIdOrKey: "SYN-1", expectedActorKey: "synthetic-actor" };
const EXPECTED = { id: "9007199254740993", ...VALUE };
const ISSUE = {
  inwardIssueIdOrKey: "SYN-1",
  outwardIssueIdOrKey: "SYN-2",
  expectedActorKey: "synthetic-actor",
  linkType: { id: "9", name: "Blocks", inward: "is blocked by", outward: "blocks" },
};
it("compiles exactly six closed link schemas with the existing compiler and bounds", () => {
  expect(Object.keys(JIRA_LINK_WRITE_DEFINITIONS)).toHaveLength(6);
  for (const [name, definition] of Object.entries(JIRA_LINK_WRITE_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), name).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), name).toBe(true);
    expect(jiraLinkMutationDeclarationForTool(name)?.descriptor.idempotency).toBe(
      "server-key-required",
    );
  }
  expect(jiraLinkMutationDeclarationForTool("jira.create-issue-link-type")).toBeUndefined();
  expect(jiraLinkMutationDeclarationForTool("jira.reciprocal-remote-link")).toBeUndefined();
});
it.each([
  ["jira.create-issue-link", ISSUE],
  ["jira.delete-issue-link", { ...ISSUE, linkId: EXPECTED.id }],
  ["jira.upsert-remote-link", { ...REMOTE, expectAbsent: true, value: VALUE }],
  ["jira.upsert-remote-link", { ...REMOTE, expected: EXPECTED, value: VALUE }],
  [
    "jira.update-remote-link",
    { ...REMOTE, linkId: EXPECTED.id, expected: EXPECTED, value: { ...VALUE, globalId: null } },
  ],
  ["jira.delete-remote-link", { ...REMOTE, linkId: EXPECTED.id, expected: EXPECTED }],
  [
    "jira.delete-remote-link-by-global-id",
    { ...REMOTE, globalId: VALUE.globalId, expected: EXPECTED },
  ],
] as const)("admits the complete %s reviewed input without numeric ID rounding", (name, args) => {
  const declaration = jiraLinkMutationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "unknown",
      issueId: "10001",
      issueKey: "SYN-1",
      userKey: "synthetic-actor",
      linkId: EXPECTED.id,
      linkPresent: false,
    }),
  ).toBeUndefined();
});
it.each([
  ["jira.create-issue-link", { ...ISSUE, comment: { body: "Unreviewed second effect" } }],
  ["jira.delete-issue-link", ISSUE],
  ["jira.upsert-remote-link", { ...REMOTE, value: VALUE }],
  ["jira.upsert-remote-link", { ...REMOTE, value: VALUE, expectAbsent: true, expected: EXPECTED }],
  [
    "jira.update-remote-link",
    { ...REMOTE, linkId: "7", expected: EXPECTED, value: { title: "partial replacement" } },
  ],
  ["jira.delete-remote-link-by-global-id", { ...REMOTE, globalId: "synthetic:42" }],
  ["jira.delete-remote-link", { ...REMOTE, linkId: "7", expected: EXPECTED, method: "POST" }],
] as const)("refuses incomplete or widened %s input", (name, args) => {
  const declaration = jiraLinkMutationDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
