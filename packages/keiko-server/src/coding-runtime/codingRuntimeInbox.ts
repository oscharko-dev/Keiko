import type { CodingWorkbenchRuntimeFailureCode } from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchRuntimeInboxAction,
  CodingWorkbenchRuntimeInboxItem,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

/**
 * The pending-message vocabulary every layer of the Workbench shares (S07, ADR-0137 D10): the run
 * port that reads and changes the runtime's inbox, the dispatcher that admits an action, the
 * coordinator that serializes it and the route that answers it. Pure data, so no layer imports
 * another to name an outcome or a refusal.
 *
 * What a pending message is: an operator message Keiko delivered into the turn in flight (`steer` or
 * `queue`) that the runtime has not handed to the model yet. Only such a message is ever listed or
 * changed; the runtime's own queued inputs and anything Keiko did not mint for the run are not.
 */

/**
 * How an admitted action ended. A message the runtime had already taken (the model has it, or is
 * about to) is not an error: the operator asked for something that is no longer possible, and the
 * truthful answer is that it was delivered. Repeating an action on a message this port withdrew
 * itself says so too.
 */
export const CODING_RUNTIME_INBOX_OUTCOMES = [
  "already-cancelled",
  "already-delivered",
  "cancelled",
  "promoted",
] as const;

export type CodingRuntimeInboxOutcome = (typeof CODING_RUNTIME_INBOX_OUTCOMES)[number];

export const CODING_RUNTIME_INBOX_REFUSALS = [
  "inbox-failed",
  "not-admitted",
  "run-unavailable",
  "turn-not-running",
  "unknown-item",
  "unsupported",
] as const;

export type CodingRuntimeInboxRefusal = (typeof CODING_RUNTIME_INBOX_REFUSALS)[number];

export type CodingRuntimeInboxResult =
  | { readonly ok: true; readonly outcome: CodingRuntimeInboxOutcome }
  | { readonly ok: false; readonly reason: CodingRuntimeInboxRefusal };

/**
 * One admitted action on one pending message of a run. The dispatcher adds the operator's request
 * identity around it; the run port needs only these three facts.
 */
export interface CodingRuntimeInboxActionInput {
  readonly action: CodingWorkbenchRuntimeInboxAction;
  readonly itemId: string;
}

export type CodingRuntimeInboxItems = readonly CodingWorkbenchRuntimeInboxItem[];

type InboxFailureCode = Extract<
  CodingWorkbenchRuntimeFailureCode,
  "authority-resolution-failed" | "invalid-intent" | "runtime-failed"
>;

/**
 * The failure code each refusal answers with. A refusal that states a fact about the request or the
 * run's current state is the request's own (`invalid-intent`); one the authority guard made is an
 * authority failure; everything else is the runtime failing. A record keyed by the closed refusal
 * list, so a new refusal cannot be added without choosing its answer.
 */
const INBOX_REFUSAL_FAILURE_CODES = {
  "inbox-failed": "runtime-failed",
  "not-admitted": "authority-resolution-failed",
  "run-unavailable": "runtime-failed",
  "turn-not-running": "invalid-intent",
  "unknown-item": "invalid-intent",
  unsupported: "invalid-intent",
} as const satisfies Record<CodingRuntimeInboxRefusal, InboxFailureCode>;

export function inboxRefusalFailureCode(reason: CodingRuntimeInboxRefusal): InboxFailureCode {
  return INBOX_REFUSAL_FAILURE_CODES[reason];
}
