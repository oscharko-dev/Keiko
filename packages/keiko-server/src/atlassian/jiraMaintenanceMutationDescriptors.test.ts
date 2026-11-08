import { describe, expect, it } from "vitest";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { MAINTENANCE_MUTATION_FIXTURE_CASES as CASES } from "../../../../tests/support/jira-maintenance-mutation-fixture.js";
import { JIRA_MAINTENANCE_WRITE_DEFINITIONS as DEFINITIONS, jiraMaintenanceMutationDeclarationForTool as declaration } from "./jiraMaintenanceMutationDescriptors.js";

describe("closed administrative maintenance declarations", () => {
  it.each(CASES)("declares $name without permitting completed effects", ({ name, args, receipt }) => {
    const tool = declaration(name);
    if (tool === undefined) throw new TypeError("Missing maintenance declaration");
    expect(tool.risk).toBe("write");
    expect(tool.descriptor.description).toContain("issue-tracker.admin");
    expect(isBoundedExternalJsonSchema(DEFINITIONS[name].input)).toBe(true);
    expect(isBoundedExternalJsonSchema(DEFINITIONS[name].result)).toBe(true);
    expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, args)).toBeUndefined();
    expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, { ...args, headers: {} })).toBeDefined();
    expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, { ...args, confirmUnverifiedEffect: false })).toBeDefined();
    expect(describeCatalogSchemaMismatch(tool.descriptor.resultSchema, { outcome: "succeeded-unconfirmed", ...receipt })).toBeUndefined();
    expect(describeCatalogSchemaMismatch(tool.descriptor.resultSchema, { outcome: "succeeded", ...receipt })).toBeDefined();
    expect(describeCatalogSchemaMismatch(tool.descriptor.resultSchema, { outcome: "succeeded-unconfirmed", ...receipt, completed: true })).toBeDefined();
  });
  it("rejects arbitrary query/method/body controls and unknown maintenance tools", () => {
    expect(declaration("jira.restart-node")).toBeUndefined();
    const tool = declaration("jira.start-reindex");
    if (tool === undefined) throw new TypeError("Missing reindex declaration");
    for (const patch of [{ type: "OTHER" }, { type: "BACKGROUND_PREFFERED" }, { jql: "project = SYN" }, { taskId: "7" }, { method: "DELETE" }])
      expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, { ...CASES[8].args, ...patch })).toBeDefined();
  });
  it("keeps unknown liveness distinct from false and forbids partial review states", () => {
    const node = declaration("jira.mark-cluster-node-offline"); const reindex = declaration("jira.start-reindex");
    if (node === undefined || reindex === undefined) throw new TypeError("Missing native state declaration");
    expect(describeCatalogSchemaMismatch(node.descriptor.inputSchema, { ...CASES[2].args, expectedNode: { nodeId: "node-a", state: "ACTIVE" } })).toBeDefined();
    expect(describeCatalogSchemaMismatch(node.descriptor.inputSchema, { ...CASES[2].args, expectedNode: { nodeId: "node-a", state: "ACTIVE", alive: null } })).toBeDefined();
    expect(describeCatalogSchemaMismatch(reindex.descriptor.inputSchema, { ...CASES[8].args, expectedReindex: { taskState: "observed" } })).toBeDefined();
    expect(describeCatalogSchemaMismatch(reindex.descriptor.inputSchema, { ...CASES[8].args, expectedReindex: { taskState: "no-prior-task", success: true } })).toBeDefined();
  });
  it("retains exact ACK request IDs and empty observations without path or completion fields", () => {
    const tool = declaration("jira.process-reindex-requests");
    if (tool === undefined) throw new TypeError("Missing reindex request declaration");
    for (const reindexRequestIds of [[], ["9223372036854775807"]])
      expect(describeCatalogSchemaMismatch(tool.descriptor.resultSchema, { outcome: "succeeded-unconfirmed", userKey: "actor", reindexRequestIds })).toBeUndefined();
    expect(describeCatalogSchemaMismatch(tool.descriptor.resultSchema, { outcome: "succeeded-unconfirmed", reindexRequestIds: [9007199254740992] })).toBeDefined();
    expect(describeCatalogSchemaMismatch(tool.descriptor.resultSchema, { outcome: "succeeded-unconfirmed", futureAbsolutePath: "/private/snapshot" })).toBeDefined();
  });
});
