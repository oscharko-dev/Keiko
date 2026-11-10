import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { atlassianApiEndpointsFor, atlassianApiUrl } from "./atlassian-sync-classify.js";
import {
  ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS,
  type AtlassianWriteHttpOutcome,
} from "./atlassian-write-http.js";
import type { JiraIdentityPorts } from "./jira-identity-mutation-values.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { executeAdmittedJiraRequest } from "./jira-request-admission.js";
import { savedName } from "./jira-saved-configuration-values.js";

/** ExperimentalApi is fixed by the native UserResource, never selected by the model. */
export function jiraIdentityRequests(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
): JiraIdentityPorts {
  const endpoints = atlassianApiEndpointsFor(connection.baseUrl, "/rest/api/2/");
  const signal = AbortSignal.any([
    context.signal,
    AbortSignal.timeout(ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS),
  ]);
  return {
    user: (method, key, body): Promise<AtlassianWriteHttpOutcome> => {
      if (
        (method === "POST" && (key !== undefined || body === undefined)) ||
        (method !== "POST" && !savedName(key)) ||
        (method === "DELETE") !== (body === undefined)
      )
        return Promise.resolve({ ok: false, reason: "field-validation" });
      const query = key === undefined ? "" : `?${new URLSearchParams({ key }).toString()}`;
      return executeAdmittedJiraRequest(connection, context, signal, {
        method,
        url: atlassianApiUrl(endpoints, `user${query}`),
        ...(body === undefined ? {} : { bodyJson: JSON.stringify(body) }),
        jiraIdentityExperimental: true,
        expect: method === "POST" ? "json" : "none",
      });
    },
  };
}
