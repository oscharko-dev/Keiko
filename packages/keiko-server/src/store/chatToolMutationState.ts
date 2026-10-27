import {
  JIRA_MUTATION_OPERATIONS,
  JIRA_MUTATION_OUTCOMES,
  type JiraMutationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { invalidRequest, UiStoreError } from "./errors.js";
import type { ChatToolMutationIntent, ChatToolMutationRecord } from "./chatToolMutationTypes.js";
const OPERATIONS: ReadonlySet<string> = new Set(JIRA_MUTATION_OPERATIONS);
const OUTCOMES: ReadonlySet<string> = new Set(JIRA_MUTATION_OUTCOMES);
const KNOWN_REJECTIONS = new Set([400, 401, 403, 404, 405, 409, 412, 413, 415, 422, 429]);
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
export function journalConflict(): UiStoreError {
  return new UiStoreError(
    "INVALID_REQUEST",
    "The mutation journal state conflicts with this action.",
    409,
  );
}
export function validateMutationIntent(intent: ChatToolMutationIntent): void {
  const identifiers = [
    intent.invocationId,
    intent.chatId,
    intent.userMessageId,
    intent.actorId,
    intent.podId,
    intent.correlationId,
  ];
  if (!identifiers.every((value) => typeof value === "string" && ID.test(value)))
    throw invalidRequest("Invalid mutation identity.");
  if (
    typeof intent.turnRef !== "string" ||
    intent.turnRef.length < 1 ||
    intent.turnRef.length > 256
  )
    throw invalidRequest("Invalid mutation turn reference.");
  if (!DIGEST.test(intent.actionDigest) || !DIGEST.test(intent.authorityDigest))
    throw invalidRequest("Invalid mutation digest.");
  if (
    ![intent.bindingGeneration, intent.credentialGeneration].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw invalidRequest("Invalid mutation generation.");
  if (!OPERATIONS.has(intent.operation)) throw invalidRequest("Invalid mutation operation.");
}
export function sameMutationIdentity(
  record: ChatToolMutationRecord,
  intent: ChatToolMutationIntent,
): boolean {
  return (
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
export function acknowledgedStatus(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}
const UNSTARTED: ReadonlySet<JiraMutationOutcome> = new Set(["not-dispatched"]);
const ACKNOWLEDGED: ReadonlySet<JiraMutationOutcome> = new Set([
  "succeeded",
  "succeeded-unconfirmed",
]);
const REJECTED: ReadonlySet<JiraMutationOutcome> = new Set(["rejected"]);
const UNKNOWN: ReadonlySet<JiraMutationOutcome> = new Set(["unknown"]);
function allowedOutcomes(record: ChatToolMutationRecord): ReadonlySet<JiraMutationOutcome> {
  if (record.phase === "prepared") return UNSTARTED;
  if (acknowledgedStatus(record.httpStatus)) return ACKNOWLEDGED;
  return record.httpStatus !== null && KNOWN_REJECTIONS.has(record.httpStatus) ? REJECTED : UNKNOWN;
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
