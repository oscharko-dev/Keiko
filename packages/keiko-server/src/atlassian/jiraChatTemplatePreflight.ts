import {
  checkJiraManagedMutationTemplates,
  firstJiraDraftTemplateRefusal,
  type JiraDraftTemplateRefusal,
  type JiraManagedConnection,
} from "@oscharko-dev/keiko-connectors";
import type {
  JiraDraftRefusalReason,
  JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { UiHandlerDeps } from "../deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import type {
  JiraChatAdmissionOptions,
  JiraChatCatalogAction,
  JiraChatCatalogContext,
} from "./jiraChatCatalogConsumer.js";
import { jiraMutationToolResult } from "./jiraMutationResult.js";
import { recordJiraDraftActivity } from "./jiraDraftActivity.js";
import { draftRefusalData, readableChatDraft } from "./jiraChatDraftArguments.js";
import { resolveCurrentJiraChatAuthority } from "./jiraChatAuthority.js";
import { jiraIssueTemplateSource, recordJiraTemplateRefusal } from "./jiraTemplateLog.js";

/** The writes that change issue fields, which is what an issue template describes. */
function fieldOperation(tool: string): JiraMutationOperation | undefined {
  return tool === "jira.create" ||
    tool === "jira.edit" ||
    tool === "jira.transition" ||
    tool === "jira.assign"
    ? tool
    : undefined;
}

type PreflightDeps = JiraChatAdmissionOptions["deps"] &
  Pick<UiHandlerDeps, "store" | "atlassianConnectorCredentials" | "jiraDraftStore" | "activityLog">;

export interface JiraChatTemplatePreflightPorts {
  readonly deps: PreflightDeps;
  /** The proposed write's arguments, only when they match the approval's digest. */
  readonly writeArguments: (action: JiraChatCatalogAction) => CatalogJsonObject | undefined;
  /** The read grant the dry run's GET requests depend on is still current. */
  readonly readAllowed: (action: JiraChatCatalogAction) => boolean;
}

type Credential = Extract<ReturnType<typeof resolveCurrentJiraChatAuthority>, { ok: true }>;
type HttpFactory = NonNullable<
  PreflightDeps["atlassianConnectorCredentials"]
>["httpBodyPortFactory"];

/** The read-only request context and connection every dry run of one proposed write shares. */
interface DryRunTarget {
  readonly invocation: ManagedMcpInvocationContext;
  readonly connection: JiraManagedConnection;
}
function dryRunTarget(
  ports: JiraChatTemplatePreflightPorts,
  action: JiraChatCatalogAction,
  context: JiraChatCatalogContext,
  factory: HttpFactory,
  current: Credential,
): DryRunTarget {
  const allowed = (): boolean => !context.signal.aborted && ports.readAllowed(action);
  return {
    invocation: {
      invocationId: action.actionId,
      correlationId: context.correlationId,
      signal: context.signal,
      beforeEffect: allowed,
    },
    connection: {
      baseUrl: current.credential.baseUrl,
      deployment: current.credential.deployment,
      http: factory(current.credential, context.correlationId, { beforeDispatch: allowed }),
      issueTemplates: jiraIssueTemplateSource(ports.deps.store),
    },
  };
}

/** The dry run is advisory: the gate in front of the Jira request decides, so a failure is recorded. */
function recordPreflightFailure(correlationId: string, error: unknown): void {
  emitServerDiagnostic(
    undefined,
    serverDiagnosticFromError({
      correlationId,
      operation: "jira.template-preflight-failed",
      source: "jira-chat-template-preflight",
      error,
      redact: () => "server-operation-failed",
    }),
  );
}

/** The current credential and the HTTP factory a dry run reads Jira with, or undefined. */
function dryRunAccess(
  ports: JiraChatTemplatePreflightPorts,
  context: JiraChatCatalogContext,
): { readonly factory: HttpFactory; readonly current: Credential } | undefined {
  const { deps } = ports;
  const factory = deps.atlassianConnectorCredentials?.httpBodyPortFactory;
  if (factory === undefined) return undefined;
  const current = resolveCurrentJiraChatAuthority(
    deps,
    context.chatId,
    context.authorityReference,
    new Date().toISOString(),
    context.correlationId,
  );
  return current.ok ? { factory, current } : undefined;
}

/** Whether any template, or any unreadable one, could govern the creation of a draft's items. */
function templatesGovernCreate(store: PreflightDeps["store"]): boolean {
  const set = jiraIssueTemplateSource(store)();
  return (
    set.unreadable > 0 ||
    set.templates.some((template) =>
      template.activations.some((activation) => activation.kind === "create"),
    )
  );
}
function itemsOf(args: CatalogJsonObject): readonly Readonly<Record<string, unknown>>[] {
  const items: unknown = args.items;
  return Array.isArray(items) ? (items as readonly Readonly<Record<string, unknown>>[]) : [];
}

/**
 * The first item of a draft that an active template would refuse when it is created (#4178): each
 * item runs the check its create will run, so a human is never asked to approve known-invalid
 * items. Per-item checks also ran when an item was staged; templates may have changed since, and an
 * inline draft was never staged.
 */
async function draftTemplateRefusal(
  ports: JiraChatTemplatePreflightPorts,
  action: JiraChatCatalogAction,
  context: JiraChatCatalogContext,
  draftArguments: CatalogJsonObject,
): Promise<JiraDraftTemplateRefusal | undefined> {
  if (!templatesGovernCreate(ports.deps.store)) return undefined;
  const access = dryRunAccess(ports, context);
  if (access === undefined) return undefined;
  const target = dryRunTarget(ports, action, context, access.factory, access.current);
  try {
    return await firstJiraDraftTemplateRefusal(
      itemsOf(draftArguments),
      target.invocation,
      target.connection,
    );
  } catch (error) {
    recordPreflightFailure(context.correlationId, error);
    return undefined;
  }
}

/** The structured refusal the model corrects: the item and the exact rules it violates. */
function draftTemplateRefusalData(refusal: JiraDraftTemplateRefusal): CatalogJsonObject {
  return {
    ...jiraMutationToolResult("rejected", "field-validation").data,
    items: [
      {
        ref: refusal.ref,
        state: "failed",
        reason: "field-validation",
        violations: refusal.violations.map((violation) => ({ ...violation })),
      },
    ],
  };
}

/** Why the draft is not put in front of a human, in the Activity Log's closed words. */
function refusalReason(
  draft: ReturnType<typeof readableChatDraft>,
  refusal: JiraDraftTemplateRefusal | undefined,
): "template-violation" | JiraDraftRefusalReason | undefined {
  if (!draft.ok) return draft.reason;
  return refusal === undefined ? undefined : "template-violation";
}

/**
 * A draft is judged before any human is asked: the staged draft it names must exist unchanged and
 * be runnable (every relation known, no cycle, within the resource bound), and every item must pass
 * the templates active for its creation. The refusal is the structured result the model corrects.
 */
async function draftPreflight(
  ports: JiraChatTemplatePreflightPorts,
  action: JiraChatCatalogAction,
  context: JiraChatCatalogContext,
): Promise<CatalogJsonObject | undefined> {
  const args = ports.writeArguments(action);
  if (args === undefined) return undefined;
  const startedAt = Date.now();
  const { jiraDraftStore, activityLog } = ports.deps;
  const draft = readableChatDraft(jiraDraftStore, context.chatId, args);
  const refusal = draft.ok
    ? await draftTemplateRefusal(ports, action, context, draft.arguments)
    : undefined;
  const reason = refusalReason(draft, refusal);
  recordJiraDraftActivity(activityLog, context.correlationId, {
    phase: reason === undefined ? "submitted" : "refused",
    ...(reason === undefined ? {} : { refusal: reason }),
    newDraft: false,
    pageItemCount: 0,
    ...draftSizes(jiraDraftStore, context.chatId, args, draft),
    unresolvedRefCount: 0,
    violationCount: refusal?.violations.length ?? 0,
    durationMs: Date.now() - startedAt,
  });
  if (refusal !== undefined) {
    recordJiraTemplateRefusal(context.correlationId, {
      operation: "jira.create",
      stage: "pre-approval",
      violations: refusal.violations,
    });
    return draftTemplateRefusalData(refusal);
  }
  return draft.ok ? undefined : draftRefusalData(draft.reason);
}
/** The counts of the staged draft a call names (zero for an inline or unavailable draft). */
function draftSizes(
  store: PreflightDeps["jiraDraftStore"],
  chatId: string,
  args: Readonly<Record<string, unknown>>,
  draft: ReturnType<typeof readableChatDraft>,
): { readonly itemCount: number; readonly pageCount: number; readonly byteCount: number } {
  const items = draft.ok ? draft.arguments.items : undefined;
  const staged = typeof args.draftId === "string" ? store?.peek(args.draftId, chatId) : undefined;
  return {
    itemCount: Array.isArray(items) ? items.length : 0,
    pageCount: staged?.pageCount ?? 0,
    byteCount: staged?.bytes ?? 0,
  };
}

async function dryRun(
  target: DryRunTarget,
  operation: JiraMutationOperation,
  args: CatalogJsonObject,
  correlationId: string,
): Promise<CatalogJsonObject | undefined> {
  const result = await checkJiraManagedMutationTemplates(
    operation,
    args,
    target.invocation,
    target.connection,
  );
  if (result.ok || result.violations === undefined) return undefined;
  recordJiraTemplateRefusal(correlationId, {
    operation,
    stage: "pre-approval",
    violations: result.violations,
  });
  return jiraMutationToolResult(
    "rejected",
    result.reason,
    {},
    false,
    undefined,
    undefined,
    result.violations,
  ).data;
}

/**
 * Runs the template admission of a proposed create, edit, assignment or transition, and of every
 * item of a backlog draft, before Chat asks a human to approve it, using the same pipeline as the
 * write itself. A refusal is the structured tool result the model corrects; a write that violates
 * an active template is never put in front of a person. The gate in front of the Jira request stays
 * authoritative in every autonomy mode.
 */
export function createJiraChatTemplatePreflight(
  ports: JiraChatTemplatePreflightPorts,
): NonNullable<JiraChatAdmissionOptions["preflightWrite"]> {
  return async (action, context) => {
    if (action.tool === "jira.draft") return draftPreflight(ports, action, context);
    const operation = fieldOperation(action.tool);
    const args = ports.writeArguments(action);
    if (operation === undefined || args === undefined) return undefined;
    const access = dryRunAccess(ports, context);
    if (access === undefined) return undefined;
    try {
      const target = dryRunTarget(ports, action, context, access.factory, access.current);
      return await dryRun(target, operation, args, context.correlationId);
    } catch (error) {
      recordPreflightFailure(context.correlationId, error);
      return undefined;
    }
  };
}
