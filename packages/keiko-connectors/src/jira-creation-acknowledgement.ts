import type {
  JiraMutationAttempt,
  JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import { dispatchFailure } from "./jira-mutation-failure.js";

type Failure = Extract<JiraMutationAttempt, { readonly ok: false }>;
/** Any readable successful acknowledgement must proceed to its owner's independent GET. */
export function jiraCreationAcknowledgement(
  response: AtlassianWriteHttpOutcome,
  parseIdentity: (value: unknown) => string | undefined,
  knownReceipt?: JiraMutationReceipt,
): Failure | { readonly ok: true; readonly id: string } {
  const context = knownReceipt === undefined ? {} : { receipt: knownReceipt };
  if (!response.ok) return { ...dispatchFailure(response), ...context };
  const id = parseIdentity(response.body?.id);
  return id === undefined || response.status < 200 || response.status >= 300
    ? { ok: false, reason: "malformed-payload", ...context }
    : { ok: true, id };
}
