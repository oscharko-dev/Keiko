import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

export type JiraReadResponse = Extract<AtlassianWriteHttpOutcome, { readonly ok: true }>;

export interface JiraReadPageSelection {
  readonly startAt: number;
  readonly maxResults: number;
}
/** Validate the existing local/native page limits; each leaf still owns its allowed arguments and route. */
export function selectJiraReadPage(
  args: CatalogJsonObject,
  allowed: ReadonlySet<string>,
): JiraReadPageSelection | undefined {
  if (Object.keys(args).some((key) => !allowed.has(key))) return undefined;
  const startAt = args.startAt === undefined ? 0 : args.startAt;
  const maxResults = args.maxResults === undefined ? 25 : args.maxResults;
  return typeof startAt === "number" && Number.isSafeInteger(startAt) && startAt >= 0 && startAt <= 1_000_000 &&
    typeof maxResults === "number" && Number.isSafeInteger(maxResults) && maxResults >= 1 && maxResults <= 100
    ? { startAt, maxResults } : undefined;
}

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
