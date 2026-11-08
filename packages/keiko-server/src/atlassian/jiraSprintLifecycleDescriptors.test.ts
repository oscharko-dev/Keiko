import { expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { JIRA_SPRINT_LIFECYCLE_WRITE_DEFINITIONS, jiraSprintLifecycleDeclarationForTool } from "./jiraSprintLifecycleDescriptors.js";
import { SPRINT_LIFECYCLE_FIXTURE_CASES } from "../../../../tests/support/jira-sprint-lifecycle-fixture.js";

it("compiles all five closed native sprint schemas without accepting headers or transport choices", () => {
  expect(Object.keys(JIRA_SPRINT_LIFECYCLE_WRITE_DEFINITIONS)).toHaveLength(5);
  for (const [name, definition] of Object.entries(JIRA_SPRINT_LIFECYCLE_WRITE_DEFINITIONS)) {
    expect(isBoundedExternalJsonSchema(definition.input), name).toBe(true);
    expect(isBoundedExternalJsonSchema(definition.result), name).toBe(true);
    expect(jiraSprintLifecycleDeclarationForTool(name)?.descriptor.idempotency).toBe("server-key-required");
  }
  expect(jiraSprintLifecycleDeclarationForTool("jira.sprint-proxy")).toBeUndefined();
});
it.each(SPRINT_LIFECYCLE_FIXTURE_CASES)("admits the explicit reviewed $name contract and rejects widening", ({ name, args }) => {
  const descriptor = jiraSprintLifecycleDeclarationForTool(name)?.descriptor;
  if (descriptor === undefined) throw new TypeError("Missing sprint declaration");
  expect(describeCatalogSchemaMismatch(descriptor.inputSchema, args)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(descriptor.inputSchema, { ...args, headers: { "X-ExperimentalApi": "true" } })).toBeDefined();
  const receipt = name === "jira.swap-sprints" ? { sprintId: "11", originBoardId: "7", swapSprintId: "12" }
    : name === "jira.unmap-sprints" || name === "jira.unmap-all-sprints" ? {
      sprintIds: ["12"], sprintSynced: false, ...(name === "jira.unmap-all-sprints" ? { allSprints: true } : {}),
    } : { sprintId: "11", originBoardId: "7", sprintPresent: name !== "jira.delete-sprint" };
  const result = { outcome: "succeeded-unconfirmed", userKey: "synthetic-actor", ...receipt };
  expect(describeCatalogSchemaMismatch(descriptor.resultSchema, result)).toBeUndefined();
  expect(describeCatalogSchemaMismatch(descriptor.resultSchema, { ...result, issueCount: 0 })).toBeDefined();
});
