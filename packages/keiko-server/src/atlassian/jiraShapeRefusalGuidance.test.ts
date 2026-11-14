import { expect, it } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { GatewayToolCatalogError } from "@oscharko-dev/keiko-model-gateway";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { jiraEntityPropertyMutationDeclarationForTool } from "./jiraEntityPropertyMutationDescriptors.js";
import { jiraLinkMutationDeclarationForTool } from "./jiraLinkMutationDescriptors.js";

// What the model receives when the gateway refuses a Jira call for its shape: the correction built
// from the tool's own schema by the same path a real rejection takes. The refusal names, for each
// rejected property, the rule the schema states there, in one sentence, so one retry can repair it
// (Gemma selection lane x3, 2026-11-14: the path alone never produced a repaired call).
function correction(
  declaration: ReturnType<typeof jiraLinkMutationDeclarationForTool>,
  alias: string,
  args: CatalogJsonObject,
): string {
  if (declaration === undefined) throw new TypeError("Missing declaration");
  const shape = describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, args);
  if (shape === undefined) throw new TypeError("Expected a schema mismatch");
  const text = new GatewayToolCatalogError("invalid-arguments", undefined, true, {
    toolCallId: "call-1",
    offeredAlias: alias,
    shape,
  }).correction();
  if (text === undefined) throw new TypeError("Missing correction");
  return text;
}

const REMOTE_VALUE = {
  globalId: "global-1",
  applicationType: null,
  applicationName: null,
  relationship: null,
  url: "https://example.invalid/page",
  title: "Synthetic",
  summary: null,
  iconUrl: null,
  iconTitle: null,
  resolved: null,
  statusIconUrl: null,
  statusIconTitle: null,
  statusIconLink: null,
};
const REMOTE_ARGS = {
  issueIdOrKey: "SYN-1",
  expectedActorKey: "actor-1",
  expectAbsent: true,
};

it("tells the model what every rejected remote-link property must be, in one round", () => {
  const text = correction(
    jiraLinkMutationDeclarationForTool("jira.upsert-remote-link"),
    "jira_upsert_remote_link",
    { ...REMOTE_ARGS, value: { ...REMOTE_VALUE, iconUrl: "", iconTitle: "" } },
  );
  expect(text).toContain("Expected: ");
  expect(text).toContain("value.iconTitle must be a string, 1 to 255 characters or null");
  expect(text).toContain("value.iconUrl must be a string, 1 to 2048 characters or null");
  // The rejected values are never quoted back.
  expect(text).not.toContain("example.invalid");
});

it("tells the model how a new property is written when it sends neither review form", () => {
  const declaration = jiraEntityPropertyMutationDeclarationForTool("jira.set-issue-property");
  const row = { path: "", kind: "string", textValue: "x" };
  const text = correction(declaration, "jira_set_issue_property", {
    issueIdOrKey: "SYN-1",
    propertyKey: "synthetic.key",
    valueNodes: [row],
  });
  expect(text).toContain(
    "Supply exactly one of: expectedValueNodes, expectAbsent; omit the others.",
  );
  expect(text).not.toContain("Missing required properties: expectedValueNodes");
});

it("says the rule of a malformed review form instead of only its path", () => {
  const declaration = jiraEntityPropertyMutationDeclarationForTool("jira.set-issue-property");
  const row = { path: "", kind: "string", textValue: "x" };
  const text = correction(declaration, "jira_set_issue_property", {
    issueIdOrKey: "SYN-1",
    propertyKey: "synthetic.key",
    valueNodes: [row],
    expectAbsent: false,
  });
  expect(text).toContain("The value of expectAbsent must be one of: true.");
  const wrongType = correction(declaration, "jira_set_issue_property", {
    issueIdOrKey: "SYN-1",
    propertyKey: "synthetic.key",
    valueNodes: "not-rows",
    expectAbsent: true,
  });
  expect(wrongType).toContain("Expected: valueNodes must be an array, 1 to ");
  expect(wrongType).not.toContain("not-rows");
});

it("advertises the new-property case with the exact argument, and no review form as required", () => {
  const declaration = jiraEntityPropertyMutationDeclarationForTool("jira.set-issue-property");
  if (declaration === undefined) throw new TypeError("Missing declaration");
  expect(declaration.descriptor.description).toContain(
    "A property that does not exist yet needs expectAbsent:true",
  );
  const required = declaration.descriptor.inputSchema.required as readonly string[];
  expect(required).not.toContain("expectedValueNodes");
  expect(required).not.toContain("expectAbsent");
  // The either-or is validated by Keiko's own schema: both forms, and neither, are refused.
  const base = {
    issueIdOrKey: "SYN-1",
    propertyKey: "synthetic.key",
    valueNodes: [{ path: "", kind: "string", textValue: "x" }],
  };
  const node = [{ path: "", kind: "string", textValue: "y" }];
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, {
      ...base,
      expectAbsent: true,
    }),
  ).toBeUndefined();
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, {
      ...base,
      expectedValueNodes: node,
    }),
  ).toBeUndefined();
  expect(describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, base)).toBeDefined();
  expect(
    describeCatalogSchemaMismatch(declaration.descriptor.inputSchema, {
      ...base,
      expectAbsent: true,
      expectedValueNodes: node,
    }),
  ).toBeDefined();
});
