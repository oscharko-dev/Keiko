import { expect, it } from "vitest";
import type {
  CatalogDigest,
  ToolResultEnvelope,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { createToolRef, validateToolResultEnvelope } from "@oscharko-dev/keiko-tool-catalog";
import type {
  JiraChatToolMutationIntent as ChatToolMutationIntent,
  ChatToolMutationRecord,
} from "../store/chatToolMutationTypes.js";
import { jiraChatMutationOutcome } from "./jiraChatMutationOutcome.js";

const EXPECTED: ChatToolMutationIntent = {
  invocationId: "canonical-action-one",
  chatId: "chat-one",
  userMessageId: "message-one",
  turnRef: "canonical-turn-one",
  actorId: "actor-one",
  podId: "pod-one",
  bindingGeneration: 1,
  credentialGeneration: 2,
  authorityDigest: "a".repeat(64),
  actionDigest: "b".repeat(64),
  operation: "jira.create",
  correlationId: "correlation-one",
};
const RESULT: ToolResultEnvelope = {
  schemaVersion: 1,
  invocationId: "catalog-invocation-one",
  toolRef: createToolRef("keiko.jira.create", 3),
  projectionDigest: "c".repeat(64) as CatalogDigest,
  effectStarted: true,
  status: "cancelled",
  reason: "parent-cancelled",
  data: null,
  page: null,
  metrics: { inputBytes: 10, outputBytes: 0, resultCount: 0, durationMs: 10 },
};
type JiraRecord = Exclude<ChatToolMutationRecord, { sourceKind: "configured-mcp" }>;
function record(overrides: Partial<JiraRecord> = {}): JiraRecord {
  return {
    ...EXPECTED,
    phase: "acknowledged",
    outcome: null,
    httpStatus: 201,
    createdAt: 1000,
    updatedAt: 1001,
    ...overrides,
  };
}

it("preserves the acknowledged effect independently from cancelled catalog settlement", () => {
  const result = validateToolResultEnvelope(RESULT);
  const before = JSON.stringify(result);
  expect(jiraChatMutationOutcome({ result, record: record(), expected: EXPECTED })).toBe(
    "succeeded-unconfirmed",
  );
  expect(JSON.stringify(result)).toBe(before);
  expect(result).toMatchObject({ status: "cancelled", data: null, metrics: RESULT.metrics });
  expect(() => validateToolResultEnvelope({ ...result, data: { outcome: "succeeded" } })).toThrow();
});

it.each([
  { status: "denied", reason: "authority-revoked" },
  { status: "timeout", reason: "deadline-exceeded" },
  { status: "failed", reason: "handler-failed" },
] as const)("keeps a confirmed Jira write after $status execution", ({ status, reason }) => {
  const result = validateToolResultEnvelope({ ...RESULT, status, reason });
  expect(
    jiraChatMutationOutcome({
      result,
      record: record({ phase: "settled", outcome: "succeeded" }),
      expected: EXPECTED,
    }),
  ).toBe("succeeded");
  expect(result).toMatchObject({ status, reason, data: null });
});

it.each([
  { phase: "prepared", outcome: null, httpStatus: null, observed: "not-dispatched" },
  { phase: "dispatched", outcome: null, httpStatus: null, observed: "unknown" },
  { phase: "dispatched", outcome: null, httpStatus: 400, observed: "unknown" },
  { phase: "dispatched", outcome: null, httpStatus: 503, observed: "unknown" },
  { phase: "acknowledged", outcome: null, httpStatus: 204, observed: "succeeded-unconfirmed" },
  { phase: "settled", outcome: "succeeded", httpStatus: 201, observed: "succeeded" },
  {
    phase: "settled",
    outcome: "succeeded-unconfirmed",
    httpStatus: 204,
    observed: "succeeded-unconfirmed",
  },
  { phase: "settled", outcome: "unknown", httpStatus: null, observed: "unknown" },
  { phase: "settled", outcome: "unknown", httpStatus: 500, observed: "unknown" },
  { phase: "settled", outcome: "rejected", httpStatus: null, observed: "rejected" },
  { phase: "settled", outcome: "not-dispatched", httpStatus: null, observed: "not-dispatched" },
] as const)("projects only observed journal evidence: $phase / $outcome / $httpStatus", (value) => {
  const { observed, ...state } = value;
  expect(
    jiraChatMutationOutcome({ result: RESULT, record: record(state), expected: EXPECTED }),
  ).toBe(observed);
});

it.each([
  { invocationId: "other-canonical-action" },
  { chatId: "other-chat" },
  { userMessageId: "other-message" },
  { userMessageId: null },
  { turnRef: "other-turn" },
  { actorId: "other-actor" },
  { podId: "other-pod" },
  { bindingGeneration: 2 },
  { credentialGeneration: 3 },
  { authorityDigest: "d".repeat(64) },
  { actionDigest: "e".repeat(64) },
  { operation: "jira.edit" },
] satisfies Partial<ChatToolMutationRecord>[])(
  "refuses a different durable subject: %j",
  (changed) => {
    expect(
      jiraChatMutationOutcome({ result: RESULT, record: record(changed), expected: EXPECTED }),
    ).toBeUndefined();
  },
);

it("does not reuse a mutation record for a different or absent catalog tool", () => {
  for (const toolRef of [
    null,
    createToolRef("keiko.jira.issue", 1),
    createToolRef("keiko.jira.edit", 3),
  ])
    expect(
      jiraChatMutationOutcome({
        result: { ...RESULT, toolRef },
        record: record(),
        expected: EXPECTED,
      }),
    ).toBeUndefined();
  expect(
    jiraChatMutationOutcome({ result: RESULT, record: undefined, expected: EXPECTED }),
  ).toBeUndefined();
});

it.each([
  { phase: "prepared", outcome: null, httpStatus: 200 },
  { phase: "prepared", outcome: "succeeded", httpStatus: null },
  { phase: "dispatched", outcome: null, httpStatus: 201 },
  { phase: "dispatched", outcome: "unknown", httpStatus: 500 },
  { phase: "acknowledged", outcome: null, httpStatus: null },
  { phase: "acknowledged", outcome: null, httpStatus: 500 },
  { phase: "settled", outcome: null, httpStatus: 201 },
  { phase: "settled", outcome: "succeeded", httpStatus: null },
  { phase: "settled", outcome: "succeeded-unconfirmed", httpStatus: 500 },
  { phase: "settled", outcome: "unknown", httpStatus: 204 },
  { phase: "settled", outcome: "rejected", httpStatus: 400 },
  { phase: "settled", outcome: "not-dispatched", httpStatus: 201 },
  { phase: "dispatched", outcome: null, httpStatus: 99 },
  { phase: "dispatched", outcome: null, httpStatus: 600 },
  { phase: "dispatched", outcome: null, httpStatus: 200.1 },
] satisfies Partial<ChatToolMutationRecord>[])(
  "refuses inconsistent journal state: %j",
  (changed) => {
    expect(
      jiraChatMutationOutcome({ result: RESULT, record: record(changed), expected: EXPECTED }),
    ).toBeUndefined();
  },
);
