import { isSafeAtlassianConnectorBaseUrl } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { atlassianApiEndpointsFor, atlassianApiUrl } from "./atlassian-sync-classify.js";
import { jiraNativeId } from "./jira-native-values.js";

export interface JiraCommentBinding {
  readonly issueId: string;
  readonly baseUrl: string;
}

/** Comparison only: native self is never a dispatch target or a user-facing URL. */
export function jiraCommentSelfMatches(
  value: unknown,
  commentId: string,
  binding: JiraCommentBinding,
): boolean {
  if (
    typeof value !== "string" ||
    !URL.canParse(value) ||
    !isSafeAtlassianConnectorBaseUrl(binding.baseUrl) ||
    !jiraNativeId(binding.issueId) ||
    !jiraNativeId(commentId)
  )
    return false;
  const expected = atlassianApiUrl(
    atlassianApiEndpointsFor(binding.baseUrl, "/rest/api/2/"),
    `issue/${binding.issueId}/comment/${commentId}`,
  );
  return new URL(value).href === expected;
}

export function normalizeJiraCommentBody(body: string): string {
  return body.replaceAll(/\r\n?/gu, "\n");
}
