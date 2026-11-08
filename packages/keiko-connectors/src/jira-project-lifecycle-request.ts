import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { atlassianApiEndpointsFor, atlassianApiUrl } from "./atlassian-sync-classify.js";
import {
  ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS,
  type AtlassianWriteHttpOutcome,
} from "./atlassian-write-http.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { jiraNativeId } from "./jira-native-values.js";
import type { JiraProjectLifecyclePorts } from "./jira-project-lifecycle-ports.js";
import { safeSchemeBodyId } from "./jira-project-lifecycle-values.js";
import { executeAdmittedJiraRequest } from "./jira-request-admission.js";

const INVALID: AtlassianWriteHttpOutcome = { ok: false, reason: "field-validation" };
/** Native project-priority route only; safe JSON numeric body, exact string path IDs. */
export function jiraProjectLifecycleRequests(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
): JiraProjectLifecyclePorts {
  const endpoints = atlassianApiEndpointsFor(connection.baseUrl, "/rest/api/2/");
  const signal = AbortSignal.any([
    context.signal,
    AbortSignal.timeout(ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS),
  ]);
  return {
    priority: {
      read: (projectId) =>
        jiraNativeId(projectId)
          ? executeAdmittedJiraRequest(connection, context, signal, {
              method: "GET",
              url: atlassianApiUrl(endpoints, `project/${projectId}/priorityscheme`),
              jiraProjectPriority: true,
              expect: "json",
            })
          : Promise.resolve(INVALID),
      assign: (projectId, schemeId): ReturnType<typeof executeAdmittedJiraRequest> => {
        const id = safeSchemeBodyId(schemeId);
        return jiraNativeId(projectId) && id !== undefined
          ? executeAdmittedJiraRequest(connection, context, signal, {
              method: "PUT",
              url: atlassianApiUrl(endpoints, `project/${projectId}/priorityscheme`),
              bodyJson: JSON.stringify({ id }),
              jiraProjectPriority: true,
              expect: "none",
            })
          : Promise.resolve(INVALID);
      },
      remove: (projectId, schemeId) =>
        jiraNativeId(projectId) && jiraNativeId(schemeId)
          ? executeAdmittedJiraRequest(connection, context, signal, {
              method: "DELETE",
              url: atlassianApiUrl(endpoints, `project/${projectId}/priorityscheme/${schemeId}`),
              jiraProjectPriority: true,
              expect: "none",
            })
          : Promise.resolve(INVALID),
    },
  };
}
