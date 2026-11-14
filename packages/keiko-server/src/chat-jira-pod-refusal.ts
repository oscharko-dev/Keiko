// A turn whose Chat is bound to a Jira Pod that can no longer serve it is refused (fail closed) as
// before; this only makes the refusal readable (#4371). The authority check already knows WHY it
// failed, as a closed readiness value; three of those values are the Chat owner's own business and
// name what to do next. Everything else, and every other denied dispatch, stays the generic refusal
// and reveals nothing more than "not authorized".

import { CatalogDispatchFault } from "./tool-catalog/catalogToolErrors.js";

// The server's English wording is the fallback for other clients: the UI reads the closed code
// through its own catalogs (`chat.error.jiraPod*`), so a German clerk reads German.
export const JIRA_POD_REFUSALS = {
  "pod-unavailable": {
    code: "JIRA_POD_UNAVAILABLE",
    message: "The Jira Pod bound to this Chat is no longer available. Choose a Jira Pod again.",
  },
  "verification-required": {
    code: "JIRA_POD_VERIFICATION_REQUIRED",
    message:
      "The Jira Pod must be verified again before this Chat can use it. Verify it in the Local Knowledge window.",
  },
  "generation-changed": {
    code: "JIRA_POD_CONNECTION_CHANGED",
    message:
      "The Jira connection changed after this Chat chose its Jira Pod. Choose the Jira Pod again.",
  },
} as const;

export type JiraPodRefusalReadiness = keyof typeof JIRA_POD_REFUSALS;

function isJiraPodRefusalReadiness(value: string): value is JiraPodRefusalReadiness {
  return Object.hasOwn(JIRA_POD_REFUSALS, value);
}

/** Still a denied dispatch with the same reason; only the closed readiness rides along. */
export class JiraPodRefusalFault extends CatalogDispatchFault {
  public constructor(public readonly readiness: JiraPodRefusalReadiness) {
    super("denied", "authority-invalid");
  }
}

/** Raises the specific refusal when a failed authority carries one of the three Pod readiness values. */
export function requireNoJiraPodRefusal(result: {
  readonly ok: boolean;
  readonly readiness?: string | undefined;
}): void {
  if (result.ok || result.readiness === undefined) return;
  if (isJiraPodRefusalReadiness(result.readiness)) throw new JiraPodRefusalFault(result.readiness);
}
