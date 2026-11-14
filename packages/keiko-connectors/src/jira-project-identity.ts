import type { AtlassianConnectorWriteFailureReason } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { requestFor } from "./jira-managed-mutations.js";
import { readJiraBoundProject } from "./jira-managed-projects.js";

export type JiraProjectIdentityResult =
  | { readonly ok: true; readonly key: string; readonly name: string }
  | { readonly ok: false; readonly reason: AtlassianConnectorWriteFailureReason };

const NUMERIC_ID = /^\d{1,32}$/u;

/**
 * The key and name of a project, from the same `project/{idOrKey}` read every project-bound write
 * performs (and bounded by the same admitted request), so a review can name the project it covers.
 * Read-only; a numeric id is passed through and a key is upper-cased, as the draft placement does.
 */
export async function readJiraProjectIdentity(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
  reference: string,
): Promise<JiraProjectIdentityResult> {
  const target = NUMERIC_ID.test(reference) ? reference : reference.toUpperCase();
  const read = await readJiraBoundProject(requestFor(connection, context), target);
  return read.ok
    ? { ok: true, key: read.project.projectKey, name: read.project.projectName }
    : { ok: false, reason: read.reason };
}
