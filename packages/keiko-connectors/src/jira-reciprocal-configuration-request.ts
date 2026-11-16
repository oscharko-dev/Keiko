import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { atlassianApiEndpointsFor, atlassianApiUrl } from "./atlassian-sync-classify.js";
import {
  ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS,
  type AtlassianWriteHttpOutcome,
} from "./atlassian-write-http.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { executeAdmittedJiraRequest } from "./jira-request-admission.js";

/** Private prerequisites of the one delegated Jira operation, never standalone tools or
 * caller-supplied URLs. The saved local connection remains the sole HTTP destination. */
export interface JiraReciprocalConfigurationPorts {
  readonly baseUrl: string;
  readonly manifest: () => Promise<AtlassianWriteHttpOutcome>;
  readonly applicationLinks: () => Promise<AtlassianWriteHttpOutcome>;
}
export function jiraReciprocalConfigurationRequests(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
): JiraReciprocalConfigurationPorts {
  const endpoints = atlassianApiEndpointsFor(connection.baseUrl, "/rest/applinks/1.0/");
  const signal = AbortSignal.any([
    context.signal,
    AbortSignal.timeout(ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS),
  ]);
  const read = (path: "manifest" | "listApplicationlinks"): Promise<AtlassianWriteHttpOutcome> =>
    executeAdmittedJiraRequest(connection, context, signal, {
      method: "GET",
      url: atlassianApiUrl(endpoints, path),
      expect: "json",
    });
  return {
    baseUrl: connection.baseUrl,
    manifest: () => read("manifest"),
    applicationLinks: () => read("listApplicationlinks"),
  };
}
