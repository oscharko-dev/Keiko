import { isSafeAtlassianConnectorBaseUrl } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { jiraNativeId } from "./jira-native-values.js";
import { jiraResourceSelfMatches } from "./jira-resource-self.js";

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
    !isSafeAtlassianConnectorBaseUrl(binding.baseUrl) ||
    !jiraNativeId(binding.issueId) ||
    !jiraNativeId(commentId)
  )
    return false;
  return jiraResourceSelfMatches(value, `issue/${binding.issueId}/comment/${commentId}`);
}

export function normalizeJiraCommentBody(body: string): string {
  return body.replaceAll(/\r\n?/gu, "\n");
}
