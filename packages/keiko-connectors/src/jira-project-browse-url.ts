import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { atlassianApiEndpointsFor } from "./atlassian-sync-classify.js";
import { jiraBrowseBaseFor } from "./jira-browse-url.js";

/** Constructed only from the bound Jira instance and a validated project key, never remote URLs. */
export function jiraProjectBrowseUrl(baseUrl: string, projectKey: unknown): string | undefined {
  if (!isSafeAtlassianIdentifier(projectKey)) return undefined;
  const base = jiraBrowseBaseFor(atlassianApiEndpointsFor(baseUrl, "/rest/api/2/"));
  return `${base}/projects/${encodeURIComponent(projectKey)}/summary`;
}
