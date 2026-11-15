import {
  isJiraApprovalProjectName,
  type AtlassianConnectorWriteFailureReason,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord } from "./atlassian-sync-classify.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { requestFor } from "./jira-managed-mutations.js";

export type JiraFieldNamesResult =
  | {
      readonly ok: true;
      /** The names Jira gives the requested field ids, in the acting person's language. */
      readonly names: readonly { readonly id: string; readonly name: string }[];
    }
  | { readonly ok: false; readonly reason: AtlassianConnectorWriteFailureReason };

const FIELDS_MAX = 5000;

/**
 * The names of the requested fields from the same `field` read the template gate performs, in the
 * words Jira shows the acting person. Read-only; an id Jira does not list, or whose name a card must
 * not show, is simply absent from the answer. Jira's answer is the only source of names.
 */
export async function readJiraFieldNames(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
  ids: readonly string[],
): Promise<JiraFieldNamesResult> {
  const response = await requestFor(connection, context)("field", "GET", undefined, "json-array");
  if (!response.ok) return { ok: false, reason: response.reason };
  const { items } = response;
  if (response.status !== 200 || items === undefined || items.length > FIELDS_MAX)
    return { ok: false, reason: "malformed-payload" };
  const wanted = new Set(ids);
  return {
    ok: true,
    names: items.flatMap((item) => {
      const { id, name } = asRecord(item) ?? {};
      return typeof id === "string" && wanted.has(id) && isJiraApprovalProjectName(name)
        ? [{ id, name }]
        : [];
    }),
  };
}
