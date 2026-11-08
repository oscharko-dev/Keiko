import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_LOG_OPERATION_REGISTRY,
  type ActivityLogOperationRegistration,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  ATLASSIAN_CONNECTOR_ACTION_CLASS,
  JIRA_MANAGED_ACTION_TYPES,
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MUTATION_OPERATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import { recordAtlassianActionOutcome } from "./actionOutcomeActivity.js";
import { recordJiraOperationActivity } from "./jiraOperationActivity.js";
import { jiraOperationDefinitions } from "./jiraOperationRegistry.js";
import { recordJiraFieldRefusal } from "./jiraTemplateLog.js";
import { recordCodingJiraPod } from "../coding-runtime/codingJiraPodBinding.js";

afterEach(resetServerLogger);
const PROOFS = [
  {
    op: "jira.operation.issues",
    count: 41,
    prove: (line: string): Record<string, unknown> =>
      expectActivityLogProof("jira.operation.issues.line", line),
  },
  {
    op: "jira.operation.planning",
    count: 31,
    prove: (line: string): Record<string, unknown> =>
      expectActivityLogProof("jira.operation.planning.line", line),
  },
  {
    op: "jira.operation.projects",
    count: 34,
    prove: (line: string): Record<string, unknown> =>
      expectActivityLogProof("jira.operation.projects.line", line),
  },
  {
    op: "jira.operation.metadata",
    count: 42,
    prove: (line: string): Record<string, unknown> =>
      expectActivityLogProof("jira.operation.metadata.line", line),
  },
  {
    op: "jira.operation.schemes",
    count: 62,
    prove: (line: string): Record<string, unknown> =>
      expectActivityLogProof("jira.operation.schemes.line", line),
  },
  {
    op: "jira.operation.identities",
    count: 61,
    prove: (line: string): Record<string, unknown> =>
      expectActivityLogProof("jira.operation.identities.line", line),
  },
  {
    op: "jira.operation.avatars",
    count: 19,
    prove: (line: string): Record<string, unknown> =>
      expectActivityLogProof("jira.operation.avatars.line", line),
  },
  {
    op: "jira.operation.properties",
    count: 32,
    prove: (line: string): Record<string, unknown> =>
      expectActivityLogProof("jira.operation.properties.line", line),
  },
  {
    op: "jira.operation.configuration",
    count: 39,
    prove: (line: string): Record<string, unknown> =>
      expectActivityLogProof("jira.operation.configuration.line", line),
  },
  {
    op: "jira.operation.maintenance",
    count: 25,
    prove: (line: string): Record<string, unknown> =>
      expectActivityLogProof("jira.operation.maintenance.line", line),
  },
  {
    op: "jira.operation.saved-views",
    count: 17,
    prove: (line: string): Record<string, unknown> =>
      expectActivityLogProof("jira.operation.saved-views.line", line),
  },
  {
    op: "jira.operation.core",
    count: 37,
    prove: (line: string): Record<string, unknown> =>
      expectActivityLogProof("jira.operation.core.line", line),
  },
  {
    op: "jira.operation.local",
    count: 3,
    prove: (line: string): Record<string, unknown> =>
      expectActivityLogProof("jira.operation.local.line", line),
  },
] as const;
const AMBIGUOUS_ACTION_TOOLS: ReadonlySet<string> = new Set([
  "jira.create",
  "jira.draft",
  "jira.edit",
  "jira.attach",
]);
function proveFact(events: readonly ServerLogEvent[]): Record<string, unknown> {
  const facts = events.filter((event) => event.op.startsWith("jira.operation."));
  expect(facts).toHaveLength(1);
  const event = facts[0];
  if (event === undefined) throw new TypeError("Missing operation fact");
  const proof = PROOFS.find(({ op }) => op === event.op);
  if (proof === undefined) throw new TypeError("Unknown operation proof");
  const line = formatActivityLogProofLine(event);
  const record = proof.prove(line);
  expect(line).not.toMatch(
    /private-connector|private-activity|synthetic-secret-value|SYN-7|jira\.example|projectId|issueKey|actorUserKey|browseUrl/u,
  );
  return record;
}

describe("exact Jira operation facts through existing log owners", () => {
  it("covers every canonical tool exactly once without exceeding any closed-enum limit", () => {
    const registry: readonly ActivityLogOperationRegistration[] = ACTIVITY_LOG_OPERATION_REGISTRY;
    const families = registry.filter(({ op }) => op.startsWith("jira.operation."));
    expect(families).toHaveLength(13);
    const local = families.find(({ op }) => op === "jira.operation.local")?.fields.operation
      ?.values;
    expect(local).toEqual(["jira.report", "jira.draft-stage", "jira.draft-batch"]);
    const legacyLocal = local?.filter((tool) => tool !== "jira.draft-batch");
    expect(legacyLocal).toHaveLength(2);
    expect(legacyLocal).toEqual(["jira.report", "jira.draft-stage"]);
    const members = families.flatMap((entry) => {
      const values = entry.fields.operation?.values;
      expect(values?.length).toBe(PROOFS.find(({ op }) => op === entry.op)?.count);
      expect(values?.length).toBeLessThanOrEqual(64);
      return values ?? [];
    });
    const definitions = jiraOperationDefinitions();
    expect(definitions.filter(({ kind }) => kind === "native")).toHaveLength(439);
    const composites = definitions
      .filter(({ kind }) => kind === "composite")
      .map(({ tool }) => tool)
      .sort();
    expect(composites).toHaveLength(4);
    expect(composites).toEqual([
      "jira.draft",
      "jira.draft-batch",
      "jira.draft-stage",
      "jira.report",
    ]);
    const legacyComposites = composites.filter((tool) => tool !== "jira.draft-batch");
    expect(legacyComposites).toHaveLength(3);
    expect(legacyComposites).toEqual(["jira.draft", "jira.draft-stage", "jira.report"]);
    expect(new Set(members).size).toBe(members.length);
    expect(new Set(members)).toEqual(new Set(definitions.map(({ tool }) => tool)));
    expect(new Set(members)).toEqual(
      new Set([...JIRA_MANAGED_READ_TOOLS, ...JIRA_MUTATION_OPERATIONS]),
    );
    expect(members).not.toContain("jira.discover");
    expect(members).not.toContain("jira.describe");
  });

  it.each(
    [...JIRA_MANAGED_READ_TOOLS, ...JIRA_MUTATION_OPERATIONS].filter(
      (tool) => !AMBIGUOUS_ACTION_TOOLS.has(tool),
    ),
  )(
    "persists the exact bound %s identity and permission failure beside the historical action line",
    (tool) => {
      const sink = createBufferedServerLogSink();
      const actionType = JIRA_MANAGED_ACTION_TYPES[tool];
      recordAtlassianActionOutcome(
        { activityLog: sink },
        {
          schemaVersion: "1",
          activityId: "private-activity",
          occurredAt: 0,
          connectorId: "private-connector",
          provider: "jira",
          actionType,
          actionClass: ATLASSIAN_CONNECTOR_ACTION_CLASS[actionType],
          disposition: "allowed",
          outcome: "failed",
          reasonCode: "permission-denied",
          correlationId: "operation-proof",
          durationMs: 1,
        },
        "governed-assist",
      );
      expect(sink.events.filter(({ op }) => op === "atlassian.action.outcome")).toHaveLength(1);
      expect(proveFact(sink.events)).toMatchObject({
        operation: tool,
        stage: "action-outcome",
        outcome: "failed",
        reason: "permission-denied",
        correlationId: "operation-proof",
      });
    },
  );

  it.each(["create-issue", "update-issue-fields"] as const)(
    "keeps legacy %s without guessing one of its two canonical tool aliases",
    (actionType) => {
      const sink = createBufferedServerLogSink();
      recordAtlassianActionOutcome(
        { activityLog: sink },
        {
          schemaVersion: "1",
          activityId: "private-activity",
          occurredAt: 0,
          connectorId: "private-connector",
          provider: "jira",
          actionType,
          actionClass: ATLASSIAN_CONNECTOR_ACTION_CLASS[actionType],
          disposition: "allowed",
          outcome: "failed",
          reasonCode: "permission-denied",
          correlationId: "alias-proof",
          durationMs: 1,
        },
        "governed-assist",
      );
      expect(sink.events.map(({ op }) => op)).toEqual(["atlassian.action.outcome"]);
    },
  );

  it.each([
    ...JIRA_MANAGED_READ_TOOLS.filter((tool) => tool !== "jira.draft-batch"),
    ...JIRA_MUTATION_OPERATIONS.filter((tool) => tool !== "jira.draft" && tool !== "jira.attach"),
  ])(
    "binds Coding %s to the same family without treating its envelope completion as a Jira acknowledgement",
    (tool) => {
      const sink = createBufferedServerLogSink();
      recordCodingJiraPod(sink, "coding-proof", {
        action: "call",
        outcome: "failed",
        tool,
        reason: "scope-missing",
      });
      expect(sink.events.filter(({ op }) => op === "coding-runtime.jira-pod")).toHaveLength(1);
      expect(proveFact(sink.events)).toMatchObject({
        operation: tool,
        stage: "coding-call",
        outcome: "failed",
        reason: "scope-missing",
      });
    },
  );

  it.each(JIRA_MUTATION_OPERATIONS)(
    "records pre-effect field refusal for %s with its exact identity",
    (operation) => {
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "debug" }));
      recordJiraFieldRefusal("field-proof", {
        operation,
        refusedCount: 1,
        validations: ["invalid-field"],
      });
      expect(sink.events.filter(({ op }) => op === "jira.field.admission")).toHaveLength(1);
      expect(proveFact(sink.events)).toMatchObject({
        operation,
        stage: "field-admission",
        outcome: "refused",
        reason: "field-validation",
      });
    },
  );

  it.each([
    "jira.discover",
    "jira.describe",
    "jira.proxy",
    "jira.create secret",
    "https://jira.example.invalid/issue/SYN-7",
    "constructor",
  ])("does not turn unknown or local metadata name %s into a native fact", (name) => {
    const sink = createBufferedServerLogSink();
    Reflect.apply(recordJiraOperationActivity, undefined, [
      sink,
      { correlationId: "unknown-proof" },
      name,
      { stage: "action-outcome", outcome: "failed", reason: "other" },
    ]);
    expect(sink.events).toEqual([]);
  });
});
