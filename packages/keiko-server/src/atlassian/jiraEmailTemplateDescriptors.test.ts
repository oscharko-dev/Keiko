import { expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { emailTemplateFixture } from "../../../../tests/support/jira-email-template-fixture.js";
import {
  JIRA_EMAIL_TEMPLATE_DEFINITIONS,
  jiraEmailTemplateDeclarationForTool,
} from "./jiraEmailTemplateDescriptors.js";

it("keeps four closed bounded native email-template contracts", () => {
  expect(Object.keys(JIRA_EMAIL_TEMPLATE_DEFINITIONS)).toHaveLength(4);
  for (const [name, definition] of Object.entries(JIRA_EMAIL_TEMPLATE_DEFINITIONS)) {
    const declaration = jiraEmailTemplateDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing email-template declaration");
    expect(isBoundedExternalJsonSchema(declaration.descriptor.inputSchema), name).toBe(true);
    expect(isBoundedExternalJsonSchema(declaration.descriptor.resultSchema), name).toBe(true);
    expect(declaration.risk).toBe(definition.risk);
  }
  expect(jiraEmailTemplateDeclarationForTool("jira.send-email")).toBeUndefined();
});
it("accepts exact upload integrity metadata and refuses arbitrary bytes/URL/header input", () => {
  const { uploadArgs } = emailTemplateFixture();
  const declaration = jiraEmailTemplateDeclarationForTool("jira.upload-email-template-pack");
  if (declaration === undefined) throw new TypeError("Missing email-template declaration");
  const schema = declaration.descriptor.inputSchema;
  expect(describeCatalogSchemaMismatch(schema, uploadArgs)).toBeUndefined();
  for (const extra of [
    { bytes: "base64" },
    { headers: {} },
    { endpoint: "elsewhere" },
    { expectedFile: {} },
    { acceptStagedTemplateReplacement: false },
  ])
    expect(describeCatalogSchemaMismatch(schema, { ...uploadArgs, ...extra })).toBeDefined();
});
it("requires explicit unverified staging acceptance for apply without inventing a staged digest", () => {
  const { applyArgs, revertArgs } = emailTemplateFixture();
  const declaration = jiraEmailTemplateDeclarationForTool("jira.apply-email-template-pack");
  if (declaration === undefined) throw new TypeError("Missing email-template declaration");
  const schema = declaration.descriptor.inputSchema;
  expect(describeCatalogSchemaMismatch(schema, applyArgs)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(schema, revertArgs)).toBeDefined();
  expect(
    describeCatalogSchemaMismatch(schema, { ...applyArgs, stagedSha256: "a".repeat(64) }),
  ).toBeDefined();
});
it.each(["upload", "apply", "revert"] as const)(
  "never admits a confirmed %s effect or mail-delivery claim",
  (action) => {
    const name = `jira.${action}-email-template-pack` as const;
    const declaration = jiraEmailTemplateDeclarationForTool(name);
    if (declaration === undefined) throw new TypeError("Missing email-template declaration");
    const schema = declaration.descriptor.resultSchema;
    expect(
      describeCatalogSchemaMismatch(schema, {
        outcome: "succeeded-unconfirmed",
        emailTemplateAction: action,
      }),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(schema, { outcome: "succeeded", emailTemplateAction: action }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(schema, {
        outcome: "unknown",
        emailTemplateAction: action,
        emailSent: true,
      }),
    ).toBeDefined();
  },
);
it("keeps complete export metadata separate from any file content or staged identity", () => {
  const { pack } = emailTemplateFixture();
  const declaration = jiraEmailTemplateDeclarationForTool("jira.email-template-pack");
  if (declaration === undefined) throw new TypeError("Missing email-template declaration");
  const schema = declaration.descriptor.resultSchema;
  const metadata = {
    outcome: "succeeded",
    selectionScope: "complete-exported-email-template-pack",
    archiveBytes: pack.archiveBytes,
    archiveSha256: pack.archiveSha256,
    manifestSha256: pack.manifestSha256,
    entryCount: pack.entries.length,
  };
  const result = { ...metadata, items: pack.entries };
  expect(describeCatalogSchemaMismatch(schema, result)).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(schema, { ...result, content: "template body" }),
  ).toBeDefined();
  expect(describeCatalogSchemaMismatch(schema, metadata)).toBeDefined();
});
