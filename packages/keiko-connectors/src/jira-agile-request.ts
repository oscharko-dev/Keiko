import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { atlassianApiEndpointsFor, atlassianApiUrl } from "./atlassian-sync-classify.js";
import {
  executeAtlassianWriteRequest,
  ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS,
} from "./atlassian-write-http.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

/** Fixed Software DC root over the existing bounded credential-blind transport. */
export function jiraAgileRequest(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
): JiraMutationRequest {
  return jiraAgileRequests(connection, context).agile;
}
export interface JiraAgileRequests {
  readonly agile: JiraMutationRequest;
  readonly issue: JiraMutationRequest;
}
/** Native effects and existing issue-template reads share one action deadline and custody port. */
export function jiraAgileRequests(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
): JiraAgileRequests {
  const signal = AbortSignal.any([
    context.signal,
    AbortSignal.timeout(ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS),
  ]);
  return {
    agile: fixedRequest(connection, context, signal, "/rest/agile/1.0/"),
    issue: fixedRequest(connection, context, signal, "/rest/api/2/"),
  };
}
function fixedRequest(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
  signal: AbortSignal,
  root: "/rest/agile/1.0/" | "/rest/api/2/",
): JiraMutationRequest {
  const endpoints = atlassianApiEndpointsFor(connection.baseUrl, root);
  return (path, method = "GET", body, expect = "json") =>
    executeAtlassianWriteRequest(
      {
        signal,
        http: (request) =>
          signal.aborted || !context.beforeEffect()
            ? Promise.resolve({ kind: "network-error" })
            : connection.http(request),
      },
      {
        method,
        url: atlassianApiUrl(endpoints, path),
        ...(body === undefined ? {} : { bodyJson: JSON.stringify(body) }),
        expect,
      },
    );
}
