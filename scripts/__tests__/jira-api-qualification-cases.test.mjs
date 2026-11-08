import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraOperationForTool } from "../../packages/keiko-server/dist/atlassian/jiraManagedProvider.js";
import { API_QUALIFICATION_CASES } from "../testing/jira-chat-lab/api-qualification-cases.mjs";
import { API_QUALIFICATION_ISSUE_CASES } from "../testing/jira-chat-lab/api-qualification-issue-cases.mjs";
import { API_QUALIFICATION_OBSERVATION_CASES } from "../testing/jira-chat-lab/api-qualification-observation-cases.mjs";
import { API_QUALIFICATION_PROPERTY_CASES } from "../testing/jira-chat-lab/api-qualification-property-cases.mjs";

const cases = [
  ...API_QUALIFICATION_CASES,
  ...API_QUALIFICATION_OBSERVATION_CASES,
  ...API_QUALIFICATION_ISSUE_CASES,
  ...API_QUALIFICATION_PROPERTY_CASES,
];
const fixture = {
  runId: "synthetic-run",
  projectId: "10000",
  issueTypeId: "10001",
  priorityId: "3",
  resolutionId: "1",
  statusIdOrName: "1",
  statusCategoryIdOrKey: "2",
  roleId: "10002",
  issueKeys: ["KEIKO-1"],
  actorKey: "JIRAUSER10000",
  createdIssueKey: "KEIKO-10",
  createdIssueId: "10010",
  commentId: "10011",
  worklogId: "10012",
};

describe("explicit Jira API qualification cases", () => {
  it("keeps each case bound to one distinct native inventory operation", () => {
    const ledger = JSON.parse(
      readFileSync(
        new URL("../../docs/local-knowledge/jira-api-coverage/operations.json", import.meta.url),
      ),
    );
    const identities = cases.map((entry) => {
      const operation = jiraOperationForTool(entry.tool);
      expect(operation.definition.kind).toBe("native");
      expect(
        ledger.operations.find((row) => row.identity === operation.definition.identity)
          .currentCapabilityIds,
      ).toContain(entry.tool);
      return operation.definition.identity;
    });
    expect(new Set(identities).size).toBe(cases.length);
  });

  it.each(cases)("uses the actual typed $tool contract and effect classification", (entry) => {
    const operation = jiraOperationForTool(entry.tool);
    const args = entry.arguments(fixture);
    expect(
      describeCatalogSchemaMismatch(operation.declaration.descriptor.inputSchema, args),
    ).toBeUndefined();
    expect(operation.definition.effects.includes("remote-write")).toBe(entry.mutation === true);
    expect(typeof entry.readback).toBe("function");
  });
});
