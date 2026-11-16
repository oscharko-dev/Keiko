import { describe, expect, it } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraEntityPropertyMutationDeclarationForTool } from "./jiraEntityPropertyMutationDescriptors.js";
import { jiraLinkMutationDeclarationForTool } from "./jiraLinkMutationDescriptors.js";

// #4357: the guarded writes demand read evidence in one of two forms. The refusal a model receives
// is built from this account, so it has to state the rule, not one half of it.
const NODES = [{ path: "", kind: "boolean", booleanValue: false }] as const;
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

function schemaOf(
  read: typeof jiraEntityPropertyMutationDeclarationForTool,
  tool: string,
): CatalogJsonObject {
  const declaration = read(tool);
  if (declaration === undefined) throw new TypeError(`Missing declaration ${tool}`);
  return declaration.descriptor.inputSchema;
}

describe("the rule a refused guarded write names", () => {
  const property = schemaOf(
    jiraEntityPropertyMutationDeclarationForTool,
    "jira.set-issue-property",
  );
  const base: CatalogJsonObject = {
    issueIdOrKey: "SYN-1",
    propertyKey: "display",
    valueNodes: NODES,
  };

  it.each<[string, CatalogJsonObject]>([
    ["neither review form", base],
    ["both review forms", { ...base, expectedValueNodes: NODES, expectAbsent: true }],
  ])("set-issue-property with %s states the exclusive choice", (_name, args) => {
    const shape = describeCatalogSchemaMismatch(property, args);
    expect(shape?.choice).toEqual({
      kind: "exactly-one",
      alternatives: [["expectedValueNodes"], ["expectAbsent"]],
    });
  });

  it("set-issue-property states that expectAbsent accepts only true", () => {
    const shape = describeCatalogSchemaMismatch(property, { ...base, expectAbsent: false });
    expect(shape?.allowed).toEqual({ path: "expectAbsent", values: [true] });
  });

  it("upsert-remote-link states the same two rules", () => {
    const remote = schemaOf(jiraLinkMutationDeclarationForTool, "jira.upsert-remote-link");
    const args: CatalogJsonObject = {
      issueIdOrKey: "SYN-1",
      expectedActorKey: "synthetic-actor",
      value: VALUE,
    };
    expect(
      describeCatalogSchemaMismatch(remote, { ...args, expectAbsent: false })?.allowed,
    ).toEqual({
      path: "expectAbsent",
      values: [true],
    });
    expect(describeCatalogSchemaMismatch(remote, args)?.choice).toEqual({
      kind: "exactly-one",
      alternatives: [["expectAbsent"], ["expected"]],
    });
    expect(describeCatalogSchemaMismatch(remote, { ...args, expectAbsent: true })).toBeUndefined();
  });
});
