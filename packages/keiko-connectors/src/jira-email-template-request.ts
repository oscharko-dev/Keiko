import { JIRA_ATTACHMENT_MAX_BYTES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { atlassianApiEndpointsFor, atlassianApiUrl } from "./atlassian-sync-classify.js";
import { ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS } from "./atlassian-write-http.js";
import type { JiraEmailTemplatePorts } from "./jira-email-template-values.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { executeAdmittedJiraRequest } from "./jira-request-admission.js";

/** No selector/header/media input: the governed source supplies one admitted ZIP and the existing
 * HTTP owner retains credential custody, cancellation, retry bounds and native ACK observation. */
export function jiraEmailTemplateRequest(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
): Required<Pick<JiraEmailTemplatePorts, "download" | "upload">> {
  const endpoints = atlassianApiEndpointsFor(connection.baseUrl, "/rest/api/2/");
  const url = atlassianApiUrl(endpoints, "email-templates");
  const signal = AbortSignal.any([
    context.signal,
    AbortSignal.timeout(ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS),
  ]);
  return {
    download: async (): ReturnType<JiraEmailTemplatePorts["download"]> => {
      const result = await executeAdmittedJiraRequest(connection, context, signal, {
        method: "GET",
        url,
        jiraEmailTemplateArchive: true,
        expect: "jira-email-template-zip",
      });
      if (!result.ok) return dispatchFailure(result);
      return result.bytes === undefined
        ? { ok: false, reason: "malformed-payload" }
        : { ok: true, status: result.status, bytes: result.bytes };
    },
    upload: (bytes): ReturnType<NonNullable<JiraEmailTemplatePorts["upload"]>> => {
      if (!(bytes instanceof Uint8Array))
        return Promise.resolve({ ok: false, reason: "field-validation" });
      if (bytes.byteLength > JIRA_ATTACHMENT_MAX_BYTES)
        return Promise.resolve({ ok: false, reason: "bounds-exceeded" });
      // Copy before admission can await. Caller mutation or SharedArrayBuffer ownership cannot
      // alter the exact approved upload after this boundary.
      const owned = new Uint8Array(bytes);
      return executeAdmittedJiraRequest(connection, context, signal, {
        method: "POST",
        url,
        jiraEmailTemplateArchive: true,
        expect: "none",
        upload: { contentType: "application/zip", bytes: owned },
      });
    },
  };
}
