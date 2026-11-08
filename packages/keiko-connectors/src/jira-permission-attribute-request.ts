import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { atlassianApiEndpointsFor, atlassianApiUrl } from "./atlassian-sync-classify.js";
import { ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS, type AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import { jiraPropertyPathKey } from "./jira-entity-property-values.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { jiraNativeId } from "./jira-native-values.js";
import { executeAdmittedJiraRequest } from "./jira-request-admission.js";

export type JiraPermissionAttributeRequest = (schemeId: string, attributeKey: string, enabled: boolean) => Promise<AtlassianWriteHttpOutcome>;
function validInput(schemeId: unknown, key: unknown, value: unknown): boolean {
  return jiraNativeId(schemeId) && jiraPropertyPathKey(key) && typeof value === "boolean";
}
/** Fixed PermissionSchemeResource PUT with its documented text/plain boolean. Private binding
 * keeps the media type outside model input and retains existing custody/authority/deadline. */
export function jiraPermissionAttributeRequest(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
): JiraPermissionAttributeRequest {
  const endpoints = atlassianApiEndpointsFor(connection.baseUrl, "/rest/api/2/");
  const signal = AbortSignal.any([
    context.signal, AbortSignal.timeout(ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS),
  ]);
  return (schemeId, attributeKey, enabled) => {
    if (!validInput(schemeId, attributeKey, enabled))
      return Promise.resolve({ ok: false, reason: "field-validation" });
    return executeAdmittedJiraRequest(connection, context, signal, {
      method: "PUT",
      url: atlassianApiUrl(endpoints, `permissionscheme/${schemeId}/attribute/${encodeURIComponent(attributeKey)}`),
      bodyJson: enabled ? "true" : "false", jiraPermissionAttribute: true, expect: "none",
    });
  };
}
