import { ATLASSIAN_JQL_MAX_CHARS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { selectedJiraReadFields } from "./jira-managed-field-reads.js";
import {
  JIRA_MANAGED_SEARCH_FIELDS,
  jiraIssueReadResult,
  boundJiraReadResult,
} from "./jira-managed-issue-reads.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { selectJiraReadPage } from "./jira-managed-read-request.js";

const FIELDS = new Set(["jql", "fields", "startAt", "maxResults"]);

export function isJiraSearchPostRead(name: string): name is "jira.search-post" {
  return name === "jira.search-post";
}

/** Native POST search is a read: use the same field, page and result owners as GET search. */
export async function executeJiraSearchPostRead(
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  baseUrl: string,
): Promise<ManagedMcpToolResult> {
  const page = selectJiraReadPage(args, FIELDS);
  const selected = selectedJiraReadFields(args.fields);
  if (page === undefined || selected === undefined) return jiraReadFailure("invalid-input");
  if (
    typeof args.jql !== "string" ||
    args.jql.length === 0 ||
    args.jql.length > ATLASSIAN_JQL_MAX_CHARS
  )
    return jiraReadFailure("invalid-input");
  const fields = [...new Set([...JIRA_MANAGED_SEARCH_FIELDS.split(","), ...selected])];
  const response = await request(
    "search",
    "POST",
    {
      jql: args.jql,
      startAt: page.startAt,
      maxResults: page.maxResults,
      fields,
      validateQuery: true,
      ...(selected.length === 0 ? {} : { expand: ["names", "schema"] }),
    },
    "json",
  );
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  if (response.status !== 200 || response.body === undefined)
    return jiraReadFailure("malformed-payload");
  return boundJiraReadResult(
    jiraIssueReadResult(
      "jira.search",
      baseUrl,
      response.body,
      page.startAt,
      page.maxResults,
      selected,
    ),
  );
}
