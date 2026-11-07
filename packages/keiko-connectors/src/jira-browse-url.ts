import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { atlassianApiEndpointsFor, type AtlassianApiEndpoints } from "./atlassian-sync-classify.js";
import { jiraNativeId } from "./jira-native-values.js";

// Site-root browse base (origin plus any Data Center context path) — the same click-through
// shape the synced `webuiPath` resolves to against the connector base URL.
export function jiraBrowseBaseFor(endpoints: AtlassianApiEndpoints): string {
  const basePath = endpoints.base.pathname.endsWith("/")
    ? endpoints.base.pathname.slice(0, -1)
    : endpoints.base.pathname;
  return `${endpoints.base.origin}${basePath}`;
}

/** A UI/tool result only: never persist this URL in activity or mutation evidence. */
export function jiraBrowseUrl(baseUrl: string, issueKey: unknown): string | undefined {
  if (!isSafeAtlassianIdentifier(issueKey)) return undefined;
  const base = jiraBrowseBaseFor(atlassianApiEndpointsFor(baseUrl, "/rest/api/2/"));
  return `${base}/browse/${issueKey}`;
}

/** The saved filter's UI destination comes only from the selected connection and exact native ID. */
export function jiraFilterBrowseUrl(baseUrl: string, filterId: unknown): string | undefined {
  if (!jiraNativeId(filterId)) return undefined;
  const endpoints = atlassianApiEndpointsFor(baseUrl, "/rest/api/2/");
  if (endpoints.base.protocol !== "https:") return undefined;
  const base = jiraBrowseBaseFor(endpoints);
  return `${base}/issues/?filter=${filterId}`;
}

/** A board destination from the selected instance, never an upstream self or homepage URL. */
export function jiraBoardBrowseUrl(baseUrl: string, boardId: unknown): string | undefined {
  if (
    typeof boardId !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(boardId) ||
    !Number.isSafeInteger(Number(boardId))
  )
    return undefined;
  const base = jiraBrowseBaseFor(atlassianApiEndpointsFor(baseUrl, "/rest/api/2/"));
  return `${base}/secure/RapidBoard.jspa?rapidView=${boardId}`;
}
