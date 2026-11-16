import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { JiraEmailTemplatePorts } from "./jira-email-template-values.js";
import { jiraEmailTemplateRequest } from "./jira-email-template-request.js";

/** Fixed transport plus the server's existing archive/source admission; no model-selected port. */
export function jiraManagedEmailTemplatePorts(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
  request: JiraMutationRequest,
  check: boolean,
): JiraEmailTemplatePorts | undefined {
  const admission = connection.emailTemplates;
  if (admission === undefined) return undefined;
  return {
    request,
    ...jiraEmailTemplateRequest(connection, context),
    inspect: admission.inspect,
    ...(admission.sourceFor === undefined ? {} : { source: admission.sourceFor(check) }),
  };
}
