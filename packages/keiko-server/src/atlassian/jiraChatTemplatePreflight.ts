import {
  checkJiraManagedMutation,
  firstJiraDraftTemplateRefusal,
  jiraDraftFieldRefusals,
  jiraTemplateViolationGuidance,
  parseJiraDraft,
  type JiraDraftFieldRefusal,
  type JiraDraftTemplateRefusal,
  type JiraManagedConnection,
} from "@oscharko-dev/keiko-connectors";
import {
  sanitizeJiraMutationFailureDetail,
  type JiraFieldValidationFailure,
  type JiraMutationOperation,
  type JiraTemplateViolation,
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
import { jiraFailureDetailData, jiraMutationToolResult } from "./jiraMutationResult.js";
import { recordJiraDraftActivity } from "./jiraDraftActivity.js";
import { draftRefusalData, readableChatDraft } from "./jiraChatDraftArguments.js";
import { resolveCurrentJiraChatAuthority } from "./jiraChatAuthority.js";
import {
  jiraIssueTemplateSource,
  recordJiraFieldRefusal,
  recordJiraTemplateRefusal,
} from "./jiraTemplateLog.js";

/** The writes that change issue fields, which is what an issue template describes. */
type JiraFieldOperation = "jira.create" | "jira.edit" | "jira.transition" | "jira.assign";
function fieldOperation(tool: string): JiraFieldOperation | undefined {
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

/** Why the items of a readable draft are not put in front of a human. */
interface DraftItemsRefusal {
  readonly reason: "template-violation" | "invalid-fields";
  readonly violationCount: number;
  readonly data: CatalogJsonObject;
}
/** The structured refusal the model corrects: the item and the exact rules it violates. */
function draftTemplateRefusalData(refusal: JiraDraftTemplateRefusal): CatalogJsonObject {
  const guidance = jiraTemplateViolationGuidance(refusal.violations);
  return {
    ...jiraMutationToolResult("rejected", "field-validation").data,
    ...(guidance === undefined ? {} : { guidance }),
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
/** The items as a run of this draft reports them, so the model corrects them the same way. */
function draftFieldRefusalData(
  refusals: readonly JiraDraftFieldRefusal[],
  total: number,
): CatalogJsonObject {
  return {
    ...jiraMutationToolResult("rejected", "field-validation").data,
    failedCount: total,
    ...(total > refusals.length ? { omittedRowCount: total - refusals.length } : {}),
    items: refusals.map(({ ref, detail }) => ({
      ref,
      state: "failed",
      reason: "field-validation",
      ...jiraFailureDetailData(sanitizeJiraMutationFailureDetail(detail)),
    })),
  };
}
/**
 * Every item of a draft runs the checks its create will run, so a human is never asked to approve
 * known-invalid items: the templates active for its creation (#4178; each item reads Jira, so only
 * while one can govern), then the field validation (S05 of #4173; its size costs no further read).
 * Per-item checks also ran when an item was staged; templates may have changed since, and an inline
 * draft was never staged.
 */
async function draftItemsRefusal(
  ports: JiraChatTemplatePreflightPorts,
  action: JiraChatCatalogAction,
  context: JiraChatCatalogContext,
  draftArguments: CatalogJsonObject,
): Promise<DraftItemsRefusal | undefined> {
  const access = dryRunAccess(ports, context);
  if (access === undefined) return undefined;
  const { invocation, connection } = dryRunTarget(
    ports,
    action,
    context,
    access.factory,
    access.current,
  );
  try {
    const template = templatesGovernCreate(ports.deps.store)
      ? await firstJiraDraftTemplateRefusal(itemsOf(draftArguments), invocation, connection)
      : undefined;
    if (template !== undefined) return templateDraftRefusal(template, context.correlationId);
    const items = parseJiraDraft(draftArguments)?.items ?? [];
    const fields = await jiraDraftFieldRefusals(items, invocation, connection, { reconcile: true });
    if (fields.refusals.length === 0) return undefined;
    recordJiraFieldRefusal(context.correlationId, {
      operation: "jira.draft",
      refusedCount: fields.total,
      validations: fields.refusals.map((refusal) => refusal.detail.validation),
    });
    return {
      reason: "invalid-fields",
      violationCount: fields.total,
      data: draftFieldRefusalData(fields.refusals, fields.total),
    };
  } catch (error) {
    recordPreflightFailure(context.correlationId, error);
    return undefined;
  }
}
function templateDraftRefusal(
  refusal: JiraDraftTemplateRefusal,
  correlationId: string,
): DraftItemsRefusal {
  recordJiraTemplateRefusal(correlationId, {
    operation: "jira.create",
    stage: "pre-approval",
    violations: refusal.violations,
  });
  return {
    reason: "template-violation",
    violationCount: refusal.violations.length,
    data: draftTemplateRefusalData(refusal),
  };
}

/**
 * A draft is judged before any human is asked: the staged draft it names must exist unchanged and
 * be runnable (every relation known, no cycle, within the resource bound), and every item must pass
 * what its creation will check. The refusal is the structured result the model corrects.
 */
async function draftPreflight(
  ports: JiraChatTemplatePreflightPorts,
  action: JiraChatCatalogAction,
  context: JiraChatCatalogContext,
): Promise<CatalogJsonObject | undefined> {
  const args = ports.writeArguments(action);
  if (args === undefined) return undefined;
  const startedAt = Date.now();
  const { jiraDraftStore } = ports.deps;
  const draft = readableChatDraft(jiraDraftStore, context.chatId, args);
  const refusal = draft.ok
    ? await draftItemsRefusal(ports, action, context, draft.arguments)
    : undefined;
  recordDraftPreflight(ports, context, {
    reason: draft.ok ? refusal?.reason : draft.reason,
    sizes: draftSizes(jiraDraftStore, context.chatId, args, draft),
    violationCount: refusal?.violationCount ?? 0,
    startedAt,
  });
  if (refusal !== undefined) return refusal.data;
  return draft.ok ? undefined : draftRefusalData(draft);
}
function recordDraftPreflight(
  ports: JiraChatTemplatePreflightPorts,
  context: JiraChatCatalogContext,
  outcome: {
    readonly reason: Parameters<typeof recordJiraDraftActivity>[2]["refusal"];
    readonly sizes: ReturnType<typeof draftSizes>;
    readonly violationCount: number;
    readonly startedAt: number;
  },
): void {
  const { reason, sizes, violationCount, startedAt } = outcome;
  recordJiraDraftActivity(ports.deps.activityLog, context.correlationId, {
    phase: reason === undefined ? "submitted" : "refused",
    ...(reason === undefined ? {} : { refusal: reason }),
    newDraft: false,
    pageItemCount: 0,
    ...sizes,
    unresolvedRefCount: 0,
    violationCount,
    durationMs: Date.now() - startedAt,
  });
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
  const result = await checkJiraManagedMutation(
    operation,
    args,
    target.invocation,
    target.connection,
  );
  if (result.ok) return undefined;
  recordDryRunRefusal(correlationId, operation, result.violations, result.detail?.validation);
  return jiraMutationToolResult(
    "rejected",
    result.reason,
    {},
    false,
    sanitizeJiraMutationFailureDetail(result.detail),
    undefined,
    result.violations,
  ).data;
}
function recordDryRunRefusal(
  correlationId: string,
  operation: JiraMutationOperation,
  violations: readonly JiraTemplateViolation[] | undefined,
  validation: JiraFieldValidationFailure | undefined,
): void {
  if (violations !== undefined) {
    recordJiraTemplateRefusal(correlationId, { operation, stage: "pre-approval", violations });
    return;
  }
  const refused = fieldOperation(operation);
  if (refused !== undefined)
    recordJiraFieldRefusal(correlationId, {
      operation: refused,
      refusedCount: 1,
      validations: [validation],
    });
}

/**
 * Runs the admission of a proposed create, edit, assignment or transition, and of every item of a
 * backlog draft, before Chat asks a human to approve it, using the same pipeline as the write
 * itself. A refusal is the structured tool result the model corrects; a write that violates an
 * active template or that Keiko's own field validation refuses is never put in front of a person.
 * The gate in front of the Jira request stays authoritative in every autonomy mode.
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
