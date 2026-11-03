import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { atlassianApiEndpointsFor, type AtlassianApiEndpoints } from "./atlassian-sync-classify.js";

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
