import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

export type JiraReadResponse = Extract<AtlassianWriteHttpOutcome, { readonly ok: true }>;

/** Share transport refusal handling after each owner has selected its closed native GET. */
export async function executeJiraSelectedRead<S extends { readonly path: string }>(
  selected: S | undefined,
  request: JiraMutationRequest,
  expect: "json" | "json-array",
  project: (response: JiraReadResponse, selection: S) => ManagedMcpToolResult,
): Promise<ManagedMcpToolResult> {
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const response = await request(selected.path, "GET", undefined, expect);
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  if (response.status !== 200) return jiraReadFailure("malformed-payload");
  return project(response, selected);
}
