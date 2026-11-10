import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraAssetDeclarationForTool } from "./jiraAssetDescriptors.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const ID = "9007199254740993";
const AVATARS = { items: [{ id: ID, category: "system", selected: false }], startAt: 0, total: 1 };
it.each([
  ["jira.attachment-settings", {}, { enabled: false }],
  ["jira.attachment", { attachmentId: ID }, { attachmentId: ID, filename: "review.txt", size: 0 }],
  [
    "jira.attachment-archive",
    { attachmentId: ID, startAt: 0 },
    {
      attachmentId: ID,
      items: [{ entryIndex: 0, name: "review.txt", size: 12 }],
      total: 1,
      totalEntryCount: 4,
      entriesComplete: false,
      startAt: 0,
    },
  ],
  [
    "jira.attachment-archive-summary",
    { attachmentId: ID },
    { attachmentId: ID, name: "review.zip" },
  ],
  ["jira.system-avatars", { avatarType: "issuetype" }, AVATARS],
  ["jira.project-avatars", { projectIdOrKey: "APP", maxResults: 1 }, AVATARS],
  ["jira.user-avatars", { username: "Display Name" }, AVATARS],
  ["jira.avatars", { avatarType: "project", owningObjectId: ID }, AVATARS],
] as const)("declares the closed %s metadata read", (name, args, result) => {
  const declaration = jiraAssetDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing asset declaration");
  expect(declaration.risk).toBe("read");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      ...result,
    }),
  ).toBeUndefined();
  const connection = vi.fn();
  const provider = createJiraProviderForCatalog(connection, [name]);
  expect(provider.tools()).toHaveLength(1);
  expect(provider.tools()[0]?.descriptor.inputSchema).toEqual(declaration.descriptor.inputSchema);
  expect(connection).not.toHaveBeenCalled();
});
it.each([
  ["jira.attachment", { attachmentId: "../1" }],
  ["jira.attachment-archive", { attachmentId: "01" }],
  ["jira.attachment-archive-summary", { attachmentId: ID, url: "https://untrusted.invalid" }],
  ["jira.system-avatars", { avatarType: "plugin" }],
  ["jira.user-avatars", { username: null }],
  ["jira.avatars", { avatarType: "user", owningObjectId: ID }],
  ["jira.project-avatars", { projectIdOrKey: "../APP" }],
  ["jira.system-avatars", { avatarType: "project", maxResults: 101 }],
] as const)("rejects unsupported %s input", (name, args) => {
  const declaration = jiraAssetDeclarationForTool(name);
  if (declaration === undefined) throw new TypeError("Missing asset declaration");
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args)).toBeDefined();
});
it("never projects opaque human archive entries or remote image URLs", () => {
  const human = jiraAssetDeclarationForTool("jira.attachment-archive-summary");
  const avatar = jiraAssetDeclarationForTool("jira.user-avatars");
  if (human === undefined || avatar === undefined) throw new TypeError("Missing asset declaration");
  expect(
    describeCatalogSchemaMismatch(human.descriptor.resultSchema, {
      outcome: "succeeded",
      attachmentId: ID,
      entries: { secret: "untyped" },
    }),
  ).toBeDefined();
  expect(
    describeCatalogSchemaMismatch(avatar.descriptor.resultSchema, {
      outcome: "succeeded",
      items: [{ id: ID, category: "custom", url: "https://untrusted.invalid" }],
    }),
  ).toBeDefined();
});
it("preserves unknown archive names, sizes and totals without fabricated defaults", () => {
  const declaration = jiraAssetDeclarationForTool("jira.attachment-archive");
  if (declaration === undefined) throw new TypeError("Missing archive declaration");
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.resultSchema, {
      outcome: "succeeded",
      attachmentId: ID,
      items: [{ entryIndex: 0, abbreviatedName: "preview" }],
      total: 1,
      startAt: 0,
    }),
  ).toBeUndefined();
});
it("does not synthesize binary download, avatar upload or destructive operations", () => {
  for (const name of [
    "jira.download-attachment",
    "jira.upload-avatar",
    "jira.delete-attachment",
    "constructor",
  ])
    expect(jiraAssetDeclarationForTool(name)).toBeUndefined();
});
