import { checkJiraManagedMutationTemplates } from "@oscharko-dev/keiko-connectors";
import type { JiraMutationOperation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { UiHandlerDeps } from "../deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import type { JiraChatAdmissionOptions, JiraChatCatalogAction } from "./jiraChatCatalogConsumer.js";
import { jiraMutationToolResult } from "./jiraMutationResult.js";
import { resolveCurrentJiraChatAuthority } from "./jiraChatAuthority.js";
import { jiraIssueTemplateSource, recordJiraTemplateRefusal } from "./jiraTemplateLog.js";

function fieldOperation(tool: string): JiraMutationOperation | undefined {
  return tool === "jira.create" || tool === "jira.edit" || tool === "jira.transition"
    ? tool
    : undefined;
}

type PreflightDeps = JiraChatAdmissionOptions["deps"] &
  Pick<UiHandlerDeps, "store" | "atlassianConnectorCredentials">;

export interface JiraChatTemplatePreflightPorts {
  readonly deps: PreflightDeps;
  /** The proposed write's arguments, only when they match the approval's digest. */
  readonly writeArguments: (action: JiraChatCatalogAction) => CatalogJsonObject | undefined;
  /** The read grant the dry run's GET requests depend on is still current. */
  readonly readAllowed: (action: JiraChatCatalogAction) => boolean;
}

/**
 * Runs the template admission of a proposed create, edit or transition before Chat asks a human
 * to approve it, using the same pipeline as the write itself. A refusal is the structured tool
 * result the model corrects; a draft that violates an active template is never put in front of a
 * person. The gate in front of the Jira request stays authoritative in every autonomy mode.
 */
export function createJiraChatTemplatePreflight(
  ports: JiraChatTemplatePreflightPorts,
): NonNullable<JiraChatAdmissionOptions["preflightWrite"]> {
  return async (action, context) => {
    const { deps } = ports;
    const operation = fieldOperation(action.tool);
    const args = ports.writeArguments(action);
    const factory = deps.atlassianConnectorCredentials?.httpBodyPortFactory;
    if (operation === undefined || args === undefined || factory === undefined) return undefined;
    const current = resolveCurrentJiraChatAuthority(
      deps,
      context.chatId,
      context.authorityReference,
      new Date().toISOString(),
      context.correlationId,
    );
    if (!current.ok) return undefined;
    const allowed = (): boolean => !context.signal.aborted && ports.readAllowed(action);
    try {
      const result = await checkJiraManagedMutationTemplates(
        operation,
        args,
        {
          invocationId: action.actionId,
          correlationId: context.correlationId,
          signal: context.signal,
          beforeEffect: allowed,
        },
        {
          baseUrl: current.credential.baseUrl,
          deployment: current.credential.deployment,
          http: factory(current.credential, context.correlationId, { beforeDispatch: allowed }),
          issueTemplates: jiraIssueTemplateSource(deps.store),
        },
      );
      if (result.ok || result.violations === undefined) return undefined;
      recordJiraTemplateRefusal(context.correlationId, {
        operation,
        stage: "pre-approval",
        violations: result.violations,
      });
      return jiraMutationToolResult("rejected", result.reason, {}, false, result.violations).data;
    } catch (error) {
      // The dry run is advisory: the gate in front of the Jira request decides, so a failed
      // dry run is recorded and the flow continues to the human's approval and that gate.
      emitServerDiagnostic(
        undefined,
        serverDiagnosticFromError({
          correlationId: context.correlationId,
          operation: "jira.template-preflight-failed",
          source: "jira-chat-template-preflight",
          error,
          redact: () => "server-operation-failed",
        }),
      );
      return undefined;
    }
  };
}
