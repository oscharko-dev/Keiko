import type { JiraMutationOutcome } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  observedChatToolMutationOutcome,
  sameMutationIdentity,
} from "../store/chatToolMutationState.js";
import type {
  JiraChatToolMutationIntent as ChatToolMutationIntent,
  ChatToolMutationRecord,
} from "../store/chatToolMutationTypes.js";

export interface JiraChatMutationOutcomeInput {
  readonly result: ToolResultEnvelope;
  readonly record: ChatToolMutationRecord | undefined;
  readonly expected: ChatToolMutationIntent;
}

/** Cancellation cannot roll back Jira. Project the exact durable action's body-free outcome or
 * the catalog's proof that a new action never reached its effect boundary;
 * the catalog result, reservation receipt and their metrics retain their original settlement. */
export function jiraChatMutationOutcome({
  result,
  record,
  expected,
}: JiraChatMutationOutcomeInput): JiraMutationOutcome | undefined {
  if (result.toolRef?.canonicalId !== `keiko.${expected.operation}`) return undefined;
  // Consent can expire before a handler creates its journal. The catalog's effect boundary then
  // proves non-dispatch; an existing durable action always remains authoritative across replay.
  if (record === undefined) return !result.effectStarted ? "not-dispatched" : undefined;
  if (
    record.invocationId !== expected.invocationId ||
    record.userMessageId !== expected.userMessageId ||
    !sameMutationIdentity(record, expected)
  )
    return undefined;
  // The catalog mints a transport invocation ID; the journal uses the canonical Chat action ID.
  return observedChatToolMutationOutcome(record);
}
