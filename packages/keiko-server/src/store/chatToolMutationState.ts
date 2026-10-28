import {
  JIRA_MUTATION_OPERATIONS,
  JIRA_MUTATION_OUTCOMES,
  type JiraMutationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { invalidRequest, UiStoreError } from "./errors.js";
import type {
  ChatToolMutationIntent,
  ChatToolMutationRecord,
  CodingToolMutationConsumer,
} from "./chatToolMutationTypes.js";
const OPERATIONS: ReadonlySet<string> = new Set(JIRA_MUTATION_OPERATIONS);
const OUTCOMES: ReadonlySet<string> = new Set(JIRA_MUTATION_OUTCOMES);
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
function validConsumer(value: unknown): value is CodingToolMutationConsumer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === "coding" &&
    typeof v.runId === "string" &&
    ID.test(v.runId) &&
    [v.sessionId, v.messageId, v.callId].every(
      (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(id),
    ) &&
    typeof v.argumentsDigest === "string" &&
    DIGEST.test(v.argumentsDigest)
  );
}
export function journalConflict(): UiStoreError {
  return new UiStoreError(
    "INVALID_REQUEST",
    "The mutation journal state conflicts with this action.",
    409,
  );
}
/** Pure validation result shared by write admission and read-only history projection. */
export function mutationIntentError(intent: ChatToolMutationIntent): UiStoreError | undefined {
  if (
    intent.consumer !== undefined &&
    (intent.sourceKind !== "configured-mcp" || !validConsumer(intent.consumer))
  )
    return invalidRequest("Invalid coding mutation identity.");
  const identifiers = [
    intent.invocationId,
    intent.chatId,
    intent.userMessageId,
    intent.actorId,
    intent.correlationId,
  ];
  if (!identifiers.every((value) => typeof value === "string" && ID.test(value)))
    return invalidRequest("Invalid mutation identity.");
  if (
    typeof intent.turnRef !== "string" ||
    intent.turnRef.length < 1 ||
    intent.turnRef.length > 256
  )
    return invalidRequest("Invalid mutation turn reference.");
  if (!DIGEST.test(intent.actionDigest) || !DIGEST.test(intent.authorityDigest))
    return invalidRequest("Invalid mutation digest.");
  return mutationSourceError(intent);
}
function isJiraSource(value: unknown): boolean {
  return value === undefined || value === "jira";
}
function validIdentifier(value: unknown): boolean {
  return typeof value === "string" && ID.test(value);
}
function mutationSourceError(intent: ChatToolMutationIntent): UiStoreError | undefined {
  if (intent.sourceKind === "configured-mcp") {
    const absent: readonly unknown[] = [
      intent.podId,
      intent.bindingGeneration,
      intent.credentialGeneration,
    ];
    const valid =
      DIGEST.test(intent.configurationDigest) &&
      [intent.serverName, intent.toolName, intent.operation].every(validIdentifier) &&
      absent.every((value) => value === null);
    return valid ? undefined : invalidRequest("Invalid MCP mutation source.");
  }
  const valid =
    isJiraSource(intent.sourceKind) &&
    validIdentifier(intent.podId) &&
    [intent.bindingGeneration, intent.credentialGeneration].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) &&
    OPERATIONS.has(intent.operation);
  return valid ? undefined : invalidRequest("Invalid mutation source.");
}
export function validateMutationIntent(intent: ChatToolMutationIntent): void {
  const error = mutationIntentError(intent);
  if (error !== undefined) throw error;
}

export function sameMutationIdentity(
  record: ChatToolMutationRecord,
  intent: ChatToolMutationIntent,
): boolean {
  return (
    sameMutationSource(record, intent) &&
    record.chatId === intent.chatId &&
    record.turnRef === intent.turnRef &&
    record.actorId === intent.actorId &&
    record.podId === intent.podId &&
    record.bindingGeneration === intent.bindingGeneration &&
    record.credentialGeneration === intent.credentialGeneration &&
    record.authorityDigest === intent.authorityDigest &&
    record.actionDigest === intent.actionDigest &&
    record.operation === intent.operation
  );
}
function sameConsumer(record: ChatToolMutationRecord, intent: ChatToolMutationIntent): boolean {
  const a = record.consumer;
  const b = intent.consumer;
  if (a === undefined || b === undefined) return a === b;
  return (
    record.userMessageId === intent.userMessageId &&
    a.runId === b.runId &&
    a.sessionId === b.sessionId &&
    a.messageId === b.messageId &&
    a.callId === b.callId &&
    a.argumentsDigest === b.argumentsDigest
  );
}
function sameMutationSource(
  record: ChatToolMutationRecord,
  intent: ChatToolMutationIntent,
): boolean {
  if (!sameConsumer(record, intent)) return false;
  if (record.sourceKind !== "configured-mcp") return intent.sourceKind !== "configured-mcp";
  return (
    intent.sourceKind === "configured-mcp" &&
    record.configurationDigest === intent.configurationDigest &&
    record.serverName === intent.serverName &&
    record.toolName === intent.toolName
  );
}
export function mutationAcknowledged(record: ChatToolMutationRecord): boolean {
  return record.sourceKind === "configured-mcp"
    ? record.protocolOutcome === "success"
    : acknowledgedStatus(record.httpStatus);
}
export function mutationHasResponse(record: ChatToolMutationRecord): boolean {
  return (
    record.httpStatus !== null ||
    (record.sourceKind === "configured-mcp" && record.protocolOutcome !== null)
  );
}
export function acknowledgedStatus(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}
// Only a local refusal before dispatch proves that this invocation caused no remote effect.
const UNSTARTED: ReadonlySet<JiraMutationOutcome> = new Set(["not-dispatched", "rejected"]);
const ACKNOWLEDGED: ReadonlySet<JiraMutationOutcome> = new Set([
  "succeeded",
  "succeeded-unconfirmed",
]);
const UNKNOWN: ReadonlySet<JiraMutationOutcome> = new Set(["unknown"]);
function allowedOutcomes(record: ChatToolMutationRecord): ReadonlySet<JiraMutationOutcome> {
  if (record.phase === "prepared") return UNSTARTED;
  if (mutationAcknowledged(record)) return ACKNOWLEDGED;
  // Status alone cannot prove absence of effects: a proxy can replace a response after commit.
  return UNKNOWN;
}
export function validateMutationSettlement(
  record: ChatToolMutationRecord,
  outcome: JiraMutationOutcome,
): void {
  if (!OUTCOMES.has(outcome)) throw invalidRequest("Invalid mutation outcome.");
  if (record.phase === "settled") {
    if (record.outcome !== outcome) throw journalConflict();
    return;
  }
  if (!allowedOutcomes(record).has(outcome)) throw journalConflict();
}

function settledOutcome(record: ChatToolMutationRecord): JiraMutationOutcome | undefined {
  switch (record.outcome) {
    case "succeeded":
    case "succeeded-unconfirmed":
      return mutationAcknowledged(record) ? record.outcome : undefined;
    case "not-dispatched":
    case "rejected":
      return !mutationHasResponse(record) ? record.outcome : undefined;
    case "unknown":
      return mutationAcknowledged(record) ? undefined : record.outcome;
    default:
      return undefined;
  }
}

function validHttpStatus(status: number | null): boolean {
  return status === null || (Number.isInteger(status) && status >= 100 && status <= 599);
}

export function observedChatToolMutationOutcome(
  record: ChatToolMutationRecord,
): JiraMutationOutcome | undefined {
  if (!validHttpStatus(record.httpStatus)) return undefined;
  if (record.phase === "settled") return settledOutcome(record);
  if (record.outcome !== null) return undefined;
  switch (record.phase) {
    case "prepared":
      return !mutationHasResponse(record) ? "not-dispatched" : undefined;
    case "dispatched":
      return mutationAcknowledged(record) ? undefined : "unknown";
    case "acknowledged":
      return mutationAcknowledged(record) ? "succeeded-unconfirmed" : undefined;
    default:
      return undefined;
  }
}
