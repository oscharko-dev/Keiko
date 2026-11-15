import {
  isJiraApprovalProjectName,
  isSafeAtlassianIdentifier,
  type AtlassianConnectorWriteFailureReason,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { requestFor } from "./jira-managed-mutations.js";

export type JiraProjectIdentityResult =
  | {
      readonly ok: true;
      readonly key: string;
      /** Absent when Jira's name is too long or carries a character a card must not show. */
      readonly name?: string;
    }
  | { readonly ok: false; readonly reason: AtlassianConnectorWriteFailureReason };

const NUMERIC_ID = /^\d{1,32}$/u;

/** What a project read answers for `target`, or why the answer is not usable. */
function identityOf(
  body: Readonly<Record<string, unknown>> | undefined,
  target: string,
): JiraProjectIdentityResult {
  const { id, key, name } = body ?? {};
  if (typeof id !== "string" || !NUMERIC_ID.test(id) || !isSafeAtlassianIdentifier(key))
    return { ok: false, reason: "malformed-payload" };
  // The answer must be for the project that was asked for, as every project-bound read checks.
  if (id !== target && key.toUpperCase() !== target.toUpperCase())
    return { ok: false, reason: "conflict" };
  return { ok: true, key, ...(isJiraApprovalProjectName(name) ? { name } : {}) };
}

/**
 * The key and name of a project, from the same `project/{idOrKey}` read every project-bound write
 * performs (and bounded by the same admitted request), so a review can name the project it covers.
 * Read-only; a numeric id is passed through and a key is upper-cased, as the draft placement does.
 * A name a card cannot show is dropped on its own: the key still identifies the project.
 */
export async function readJiraProjectIdentity(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
  reference: string,
): Promise<JiraProjectIdentityResult> {
  const target = NUMERIC_ID.test(reference) ? reference : reference.toUpperCase();
  const response = await requestFor(connection, context)(`project/${encodeURIComponent(target)}`);
  if (!response.ok) return { ok: false, reason: response.reason };
  return identityOf(response.status === 200 ? response.body : undefined, target);
}
