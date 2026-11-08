import { describe, expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import {
  PROJECT_LIFECYCLE_FIXTURE_CASES as CASES,
  PROJECT_LIFECYCLE_REVIEW as PROJECT,
} from "../../../../tests/support/jira-project-lifecycle-fixture.js";
import {
  JIRA_PROJECT_LIFECYCLE_WRITE_DEFINITIONS as DEFINITIONS,
  jiraProjectLifecycleMutationDeclarationForTool as declaration,
} from "./jiraProjectLifecycleMutationDescriptors.js";
import { JIRA_PROJECT_REVIEW_SCHEMA } from "./jiraProjectLifecycleSchemas.js";

describe("closed project lifecycle declarations", () => {
  it.each(CASES)("describes $name as one unconfirmed native effect", ({ name, args, receipt }) => {
    const tool = declaration(name);
    if (tool === undefined) throw new TypeError("Missing project declaration");
    expect(isBoundedExternalJsonSchema(DEFINITIONS[name].input)).toBe(true);
    expect(isBoundedExternalJsonSchema(DEFINITIONS[name].result)).toBe(true);
    expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, args)).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.inputSchema, {
        ...args,
        confirmUnverifiedConsequences: false,
      }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.inputSchema, { ...args, headers: {} }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
        outcome: "succeeded-unconfirmed",
        ...receipt,
      }),
    ).toBeUndefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.resultSchema, {
        outcome: "succeeded",
        ...receipt,
      }),
    ).toBeDefined();
  });
  it("requires observed archived state and prior project type for a type change", () => {
    expect(isBoundedExternalJsonSchema(JIRA_PROJECT_REVIEW_SCHEMA)).toBe(true);
    expect(
      describeCatalogSchemaMismatch(JIRA_PROJECT_REVIEW_SCHEMA, { ...PROJECT, archived: null }),
    ).toBeDefined();
    const tool = declaration("jira.update-project-type");
    if (tool === undefined) throw new TypeError("Missing type declaration");
    const expectedProject = {
      id: PROJECT.id,
      key: PROJECT.key,
      name: PROJECT.name,
      archived: PROJECT.archived,
    };
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.inputSchema, {
        ...CASES[3].args,
        expectedProject,
      }),
    ).toBeDefined();
  });
  it("does not expose migration or automatic restoration reindex arguments", () => {
    const tool = declaration("jira.restore-project");
    if (tool === undefined) throw new TypeError("Missing restore declaration");
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.inputSchema, {
        ...CASES[2].args,
        reindex: true,
      }),
    ).toBeDefined();
    expect(declaration("jira.migrate-project-issues")).toBeUndefined();
  });
});
