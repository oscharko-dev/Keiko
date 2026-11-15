import {
  isJiraApprovalProjectName,
  type AtlassianConnectorWriteFailureReason,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { requestFor } from "./jira-managed-mutations.js";

export type JiraTransitionIdentityResult =
  | {
      readonly ok: true;
      /** Absent when Jira names no transition, or a name a card must not show. */
      readonly name?: string;
      /** The status the transition leads to; absent under the same conditions. */
      readonly targetStatusName?: string;
    }
  | { readonly ok: false; readonly reason: AtlassianConnectorWriteFailureReason };

const TRANSITIONS_MAX = 1000;
const MALFORMED = { ok: false, reason: "malformed-payload" } as const;

/** A name a card can show, from a Jira field that may be absent or something else. */
function shownName(value: unknown): string | undefined {
  return isJiraApprovalProjectName(value) ? value : undefined;
}

/**
 * The name of one transition of an issue and the status it leads to, in the words Jira shows the
 * acting person, from the same `issue/{key}/transitions` read the transition write performs. Read-only.
 * A transition the issue does not offer is `invalid-transition`; a name a card cannot show is dropped
 * on its own. Jira's answer is the only source of names.
 */
export async function readJiraTransitionIdentity(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
  issueKey: string,
  transitionId: string,
): Promise<JiraTransitionIdentityResult> {
  const response = await requestFor(
    connection,
    context,
  )(`issue/${encodeURIComponent(issueKey)}/transitions`);
  if (!response.ok) return { ok: false, reason: response.reason };
  const transitions = asArray(response.body?.transitions);
  if (response.status !== 200 || transitions === undefined || transitions.length > TRANSITIONS_MAX)
    return MALFORMED;
  return identityOf(transitions.map(asRecord).filter((item) => item?.id === transitionId));
}

/** The one matching transition's shown names, or why the answer is not usable. */
function identityOf(
  matches: readonly (Record<string, unknown> | undefined)[],
): JiraTransitionIdentityResult {
  if (matches.length === 0) return { ok: false, reason: "invalid-transition" };
  const [transition] = matches;
  if (matches.length !== 1 || transition === undefined) return MALFORMED;
  const name = shownName(transition.name);
  const target = shownName(asRecord(transition.to)?.name);
  return {
    ok: true,
    ...(name === undefined ? {} : { name }),
    ...(target === undefined ? {} : { targetStatusName: target }),
  };
}
