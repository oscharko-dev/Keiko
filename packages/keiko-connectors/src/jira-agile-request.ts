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
export interface JiraAgileRequestPhase {
  readonly agile: JiraMutationRequest;
  readonly issue: JiraMutationRequest;
  readonly signal: AbortSignal;
}
export interface JiraAgileRequests extends JiraAgileRequestPhase {
  /** Starts once after acknowledgement, still inside the original invocation/authority lifetime. */
  readonly readback: () => JiraAgileRequestPhase;
}
/** Pre-effect validation and post-effect evidence have separate bounded phases over one custody port. */
export function jiraAgileRequests(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
): JiraAgileRequests {
  let readback: JiraAgileRequestPhase | undefined;
  return {
    ...phase(connection, context, false),
    readback: () => (readback ??= phase(connection, context, true)),
  };
}
function phase(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
  readOnly: boolean,
): JiraAgileRequestPhase {
  const signal = AbortSignal.any([
    context.signal,
    AbortSignal.timeout(ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS),
  ]);
  return {
    signal,
    agile: fixedRequest(connection, context, signal, "/rest/agile/1.0/", readOnly),
    issue: fixedRequest(connection, context, signal, "/rest/api/2/", readOnly),
  };
}
function fixedRequest(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
  signal: AbortSignal,
  root: "/rest/agile/1.0/" | "/rest/api/2/",
  readOnly: boolean,
): JiraMutationRequest {
  const endpoints = atlassianApiEndpointsFor(connection.baseUrl, root);
  return (path, method = "GET", body, expect = "json") =>
    readOnly && method !== "GET"
      ? Promise.resolve({ ok: false, reason: "unavailable" })
      : executeAtlassianWriteRequest(
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
