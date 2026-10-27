import type { JiraMutationOutcome } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  observedChatToolMutationOutcome,
  sameMutationIdentity,
} from "../store/chatToolMutationState.js";
import type {
  ChatToolMutationIntent,
  ChatToolMutationRecord,
} from "../store/chatToolMutationTypes.js";

export interface JiraChatMutationOutcomeInput {
  readonly result: ToolResultEnvelope;
  readonly record: ChatToolMutationRecord | undefined;
  readonly expected: ChatToolMutationIntent;
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
  return observedChatToolMutationOutcome(record);
}
