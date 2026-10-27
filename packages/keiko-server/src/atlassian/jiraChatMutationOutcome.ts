import type { JiraMutationOutcome } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { acknowledgedStatus, sameMutationIdentity } from "../store/chatToolMutationState.js";
import type {
  ChatToolMutationIntent,
  ChatToolMutationRecord,
} from "../store/chatToolMutationTypes.js";

export interface JiraChatMutationOutcomeInput {
  readonly result: ToolResultEnvelope;
  readonly record: ChatToolMutationRecord | undefined;
  readonly expected: ChatToolMutationIntent;
}

function settledOutcome(record: ChatToolMutationRecord): JiraMutationOutcome | undefined {
  switch (record.outcome) {
    case "succeeded":
    case "succeeded-unconfirmed":
      return acknowledgedStatus(record.httpStatus) ? record.outcome : undefined;
    case "not-dispatched":
    case "rejected":
      return record.httpStatus === null ? record.outcome : undefined;
    case "unknown":
      return acknowledgedStatus(record.httpStatus) ? undefined : record.outcome;
    default:
      return undefined;
  }
}

function validHttpStatus(status: number | null): boolean {
  return status === null || (Number.isInteger(status) && status >= 100 && status <= 599);
}

function observedOutcome(record: ChatToolMutationRecord): JiraMutationOutcome | undefined {
  if (!validHttpStatus(record.httpStatus)) return undefined;
  if (record.phase === "settled") return settledOutcome(record);
  if (record.outcome !== null) return undefined;
  switch (record.phase) {
    case "prepared":
      return record.httpStatus === null ? "not-dispatched" : undefined;
    case "dispatched":
      return acknowledgedStatus(record.httpStatus) ? undefined : "unknown";
    case "acknowledged":
      return acknowledgedStatus(record.httpStatus) ? "succeeded-unconfirmed" : undefined;
    default:
      return undefined;
  }
}

/** Cancellation cannot roll back Jira. Project only the exact durable action's body-free outcome;
 * the catalog result, reservation receipt and their metrics retain their original settlement. */
export function jiraChatMutationOutcome({
  result,
  record,
  expected,
}: JiraChatMutationOutcomeInput): JiraMutationOutcome | undefined {
  if (
    record === undefined ||
    result.toolRef?.canonicalId !== `keiko.${expected.operation}` ||
    record.invocationId !== expected.invocationId ||
    record.userMessageId !== expected.userMessageId ||
    !sameMutationIdentity(record, expected)
  )
    return undefined;
  // The catalog mints a transport invocation ID; the journal uses the canonical Chat action ID.
  return observedOutcome(record);
}
