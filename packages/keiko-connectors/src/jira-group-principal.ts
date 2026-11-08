import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray } from "./atlassian-sync-classify.js";
import { jiraDirectoryGroup, jiraDirectoryTotal } from "./jira-directory-values.js";
import { projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";

type GroupPrincipalFailure = Extract<JiraMutationAttempt, { ok: false }>;
/** Jira 11.3 removed GET group. Bind only an exact observed name from the supported picker.
 * A missing/truncated fuzzy result is unavailable, never proof that the selected group is absent.
 */
export async function bindJiraGroupPrincipal(request: JiraMutationRequest, name: string): Promise<GroupPrincipalFailure | undefined> {
  const query = new URLSearchParams({ query: name, maxResults: "100" });
  const response = await request(`groups/picker?${query.toString()}`, "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  const body = response.status === 200 ? response.body : undefined;
  const raw = asArray(body?.groups);
  const groups = raw === undefined ? undefined : projectJiraCollection(raw, 100, jiraDirectoryGroup, "name");
  if (body === undefined || groups === undefined || !jiraDirectoryTotal(body.total, groups.length)) return { ok: false, reason: "malformed-payload" };
  if (groups.some((group) => group.name === name)) return undefined;
  return { ok: false, reason: "unavailable", detail: { messages: ["The supported Jira group search did not expose the exact reviewed native group name within its bounded result. A missing or partial fuzzy search is not evidence of absence. Select a group that this connection can read exactly before changing assignments."] } };
}
