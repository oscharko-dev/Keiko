import { describe, expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES as CASES } from "../../../../tests/support/jira-workflow-scheme-mutation-fixture.js";
import {
  JIRA_WORKFLOW_SCHEME_WRITE_DEFINITIONS as DEFINITIONS,
  jiraWorkflowSchemeMutationDeclarationForTool as declaration,
} from "./jiraWorkflowSchemeMutationDescriptors.js";
import { compileExternalCatalogSchema } from "@oscharko-dev/keiko-tool-catalog";
import {
  jiraNativeWriteResult,
  jiraNativeIdentitySchema,
} from "./jiraProjectStructureDescriptors.js";
import { text } from "./jiraManagedSchemas.js";

describe("closed workflow scheme configuration declarations", () => {
  it.each(CASES)(
    "compiles the exact $name declaration and native context",
    ({ name, args, receipt, confirmed }) => {
      const actual = declaration(name);
      if (actual === undefined) throw new TypeError("Missing workflow scheme declaration");
      expect(actual.risk).toBe("write");
      expect(actual.descriptor.description).toContain("issue-tracker.admin");
      expect(actual.descriptor.description).toContain("updateDraftIfNeeded:false");
      expect(isBoundedExternalJsonSchema(DEFINITIONS[name].input)).toBe(true);
      expect(isBoundedExternalJsonSchema(DEFINITIONS[name].result)).toBe(true);
      expect(describeCatalogSchemaMismatch(actual.descriptor.inputSchema, args)).toBeUndefined();
      expect(
        describeCatalogSchemaMismatch(actual.descriptor.resultSchema, {
          outcome: "succeeded-unconfirmed",
          ...receipt,
        }),
      ).toBeUndefined();
      const success = describeCatalogSchemaMismatch(actual.descriptor.resultSchema, {
        outcome: "succeeded",
        ...receipt,
      });
      if (confirmed) expect(success).toBeUndefined();
      else expect(success).toBeDefined();
      expect(
        describeCatalogSchemaMismatch(actual.descriptor.inputSchema, {
          ...args,
          updateDraftIfNeeded: true,
        }),
      ).toBeDefined();
      expect(
        describeCatalogSchemaMismatch(actual.descriptor.resultSchema, {
          outcome: "succeeded",
          ...receipt,
          published: true,
        }),
      ).toBeDefined();
    },
  );
  it("requires explicit reviewed draft originals and a distinct parent snapshot", () => {
    expect(declaration("jira.update-workflow-scheme-draft")?.descriptor.inputSchema).toMatchObject({
      required: expect.arrayContaining(["expectedScheme", "expectedDraft"]) as unknown,
      properties: {
        expectedDraft: {
          required: expect.arrayContaining([
            "originalDefaultWorkflow",
            "originalMappings",
          ]) as unknown,
        },
      },
    });
    expect(declaration("jira.create-workflow-scheme-draft")?.descriptor.inputSchema).toMatchObject({
      required: ["expectedActorKey", "expectedScheme"],
    });
  });
  it("keeps metadata partial while preserving explicit null and empty mapping targets", () => {
    const actual = declaration("jira.update-workflow-scheme");
    if (actual === undefined) throw new TypeError("Missing workflow scheme declaration");
    expect(
      describeCatalogSchemaMismatch(actual.descriptor.inputSchema, {
        ...CASES[1].args,
        description: "",
        defaultWorkflow: null,
        mappings: [],
      }),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(actual.descriptor.inputSchema, {
        expectedActorKey: CASES[1].args.expectedActorKey,
        expectedScheme: CASES[1].args.expectedScheme,
      }),
    ).toBeDefined();
  });
  it("requires a false mapping marker for new success while preserving the immutable legacy result schema", () => {
    const actual = declaration("jira.update-workflow-scheme");
    if (actual === undefined) throw new TypeError("Missing workflow scheme declaration");
    const legacySchema = compileExternalCatalogSchema(
      jiraNativeWriteResult({
        userKey: { ...text(255), minLength: 1 },
        schemeId: jiraNativeIdentitySchema,
        workflowSchemeScope: { type: "string", enum: ["scheme"] },
        schemePresent: { type: "boolean" },
      }),
    );
    const original = JSON.stringify(legacySchema);
    const legacyReceipt = {
      userKey: "actor",
      schemeId: "37",
      workflowSchemeScope: "scheme",
      schemePresent: true,
    };
    const historicSuccess = { outcome: "succeeded", ...legacyReceipt };
    expect(describeCatalogSchemaMismatch(legacySchema, historicSuccess)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(actual.descriptor.resultSchema, historicSuccess),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(actual.descriptor.resultSchema, {
        ...historicSuccess,
        workflowMappingChanged: true,
      }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(actual.descriptor.resultSchema, {
        ...historicSuccess,
        workflowMappingChanged: false,
      }),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(actual.descriptor.resultSchema, {
        ...historicSuccess,
        outcome: "unknown",
      }),
    ).toBeUndefined();
    expect(JSON.stringify(legacySchema)).toBe(original);
    expect(describeCatalogSchemaMismatch(legacySchema, historicSuccess)).toBeUndefined();
  });
  it("has no workflow-definition, publication or arbitrary proxy declaration", () => {
    for (const name of [
      "jira.publish-workflow-scheme",
      "jira.update-workflow",
      "PUT /workflowscheme/1",
      "jira.workflow-scheme-proxy",
    ])
      expect(declaration(name)).toBeUndefined();
  });
  it("admits only body-free journal replay without bypassing new workflow success evidence", () => {
    const actual = declaration("jira.update-workflow-scheme");
    if (actual === undefined) throw new TypeError("Missing workflow replay declaration");
    const schema = actual.descriptor.resultSchema;
    const replay = { outcome: "succeeded", replayed: true };
    expect(describeCatalogSchemaMismatch(schema, replay)).toBeUndefined();
    expect(describeCatalogSchemaMismatch(schema, { outcome: "succeeded" })).toBeDefined();
    for (const replayed of [false, "true", 1])
      expect(
        describeCatalogSchemaMismatch(schema, { outcome: "succeeded", replayed }),
      ).toBeDefined();
    expect(describeCatalogSchemaMismatch(schema, { ...replay, schemeId: "37" })).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(schema, { ...replay, workflowMappingChanged: true }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(schema, {
        ...replay,
        schemeId: 37,
        workflowMappingChanged: false,
      }),
    ).toBeDefined();
    expect(describeCatalogSchemaMismatch(schema, { ...replay, published: true })).toBeDefined();
  });
});
