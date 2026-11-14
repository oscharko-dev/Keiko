import { chatCapabilityMatches } from "../chat-tool-authority.js";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { KNOWLEDGE_CHAT_TOOLS, type KnowledgeChatToolName } from "../requirementsToolName.js";
import {
  createChatToolAuthorityPort,
  renewRunningReadGrant,
  reserveChatToolInvocation,
} from "../chat-tool-approvals.js";
import { CatalogDispatchFault, requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import type {
  ChatToolReadGrantView,
  ChatToolWriteApprovalView,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import {
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MUTATION_OPERATIONS,
  JIRA_MANAGED_ACTION_TYPES,
  type JiraAttachmentPreview,
  type JiraManagedReadToolName,
  type JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  ToolAuthorityAvailability,
  ToolConsumerActionIdentity,
  ToolConsumerContext,
  ToolEffectGuard,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { ChatToolBatchProgress } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { JiraTraceRequest } from "@oscharko-dev/keiko-connectors";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { UiHandlerDeps } from "../deps.js";
import { recordChatAuthorityResult } from "../editor/chatAuthorityActivity.js";
import { decideAtlassianEnvelopeAction } from "./actionPolicy.js";
import type { ChatReadGrantEntry } from "./chatReadGrantState.js";
import type {
  CatalogConsumer,
  CatalogHandlerResult,
  CatalogConsumerPort,
  CatalogToolBinderInput,
} from "../tool-catalog/catalogToolPorts.js";
import type { ManagedCatalogRoute } from "../tool-catalog/managedProviderCatalog.js";
import {
  isCurrentJiraChatReadGrant,
  requestJiraChatReadGrant,
  reserveCurrentJiraChatAuthority,
  resolveCurrentJiraChatAuthority,
  type JiraChatAuthorityDeps,
} from "./jiraChatAuthority.js";
import {
  claimJiraChatWrite,
  jiraChatWritePermission,
  requestCatalogWriteApproval,
} from "./jiraChatCatalogWrite.js";
import type { ChatWriteApprovalClaim } from "./chatWriteApprovalState.js";
import { jiraApprovalExpiredResult, type HeldJiraDraft } from "./jiraApprovalExpiry.js";
import { recordJiraDraftActivity } from "./jiraDraftActivity.js";
import {
  JIRA_CATALOG_DISCOVERY_TOOLS,
  type JiraCatalogDiscoveryToolName,
} from "./jiraCatalogDiscovery.js";
import {
  isCurrentJiraOperationBinding,
  jiraOperationForTool,
  jiraOperationBindingForTool,
} from "./jiraManagedProvider.js";
import type { JiraOperationBinding } from "./jiraOperationRegistry.js";
import { jiraCatalogResult } from "./jiraCatalogResult.js";
import { chatApprovalContinuationIsLive } from "../chat-approval-continuation-state.js";

/** Private ordinary-Chat scope. Neither a workspace nor a Coding session is required. */
export interface JiraChatCatalogContext extends ToolConsumerContext {
  /** Server-private whole-turn lifetime, shared by Jira-only and mixed-source producers. */
  readonly privateLifetime?: ReturnType<
    typeof import("./httpPrivateIdentity.js").createJiraPrivateLifetime
  >;
  readonly activeHumanInput?: () =>
    import("@oscharko-dev/keiko-connectors").JiraHumanInputSelection | undefined;
  readonly humanInputFor?: (
    operation: string,
    argumentsDigest: string,
  ) => import("@oscharko-dev/keiko-connectors").JiraHumanInputSelection | undefined;
  readonly jiraDiscoveryResultFits?: ((result: CatalogJsonObject) => boolean) | undefined;
  readonly chatId: string;
  readonly authorityReference: EditorAgentGovernedAuthorityReference;
  readonly userMessageId?: string;
  /** Server-owned selection for the next model round, after the current invocation settles. */
  readonly selectJiraOperations?:
    ((identities: readonly string[], result: CatalogJsonObject) => Promise<void>) | undefined;
  /** Identities of the current additional selection, which the next selection replaces. */
  readonly selectedJiraOperations?: (() => readonly string[]) | undefined;
  /** Server-private pure snapshot; never serialized into model/MCP arguments. */
  readonly retainDraftProgress?:
    | ((actionId: string, invocationId: string, snapshot: () => CatalogJsonObject) => void)
    | undefined;
  /** Publishes the counted progress of the running jira.draft-batch call (#4173); counts only. */
  readonly reportBatchProgress?: ((progress: ChatToolBatchProgress) => void) | undefined;
  /** Model calls the turn can still spend on nested work after reserving its answer rounds. */
  readonly remainingModelCalls?: (() => number) | undefined;
  /** The model the accepted turn runs on; a draft batch writes its pages with the same model. */
  readonly knowledgeReviewModelId?: () => string | undefined;
  /** The sources the model's `[n]` markers designate in this turn; staged drafts name them too. */
  readonly citationSources?: (() => ReadonlyMap<number, string>) | undefined;
  /** Runs a nested model call under the accepted turn's readiness guard and meter. */
  readonly meterModel?: (model: ModelPort) => ModelPort;
  /** Releases the provisional synthesis charge of a nested call whose answer was used. */
  readonly confirmModelOperation?: (response: NormalizedResponse) => void;
}
export interface JiraChatCatalogAction extends ToolConsumerActionIdentity {
  readonly tool:
    | JiraManagedReadToolName
    | JiraMutationOperation
    | KnowledgeChatToolName
    | JiraCatalogDiscoveryToolName;
  readonly argumentsDigest: string;
  /** Required for Jira operations; local Knowledge/discovery reads carry no Jira binding. */
  readonly operationBinding?: JiraOperationBinding;
  /** Server-prepared source payload, captured before the approval identity is minted. */
  readonly sourceDigest?: string;
  /** Random revision of the immutable ready input, never a secret-derived hash. */
  readonly humanInputRevision?: string;
}
export interface JiraChatCatalogConsumer extends CatalogConsumer {
  readonly context: JiraChatCatalogContext;
  readonly action: JiraChatCatalogAction;
  readonly guard: ToolEffectGuard & {
    readonly write?: {
      readonly action: JiraChatCatalogAction;
      readonly beforeMutation: (itemRef?: string) => boolean;
      readonly source?: import("./jiraChatRequirementBinding.js").PreparedJiraSource;
    };
  };
}
const READ_TOOLS: ReadonlySet<string> = new Set([
  ...JIRA_MANAGED_READ_TOOLS,
  ...KNOWLEDGE_CHAT_TOOLS,
  ...JIRA_CATALOG_DISCOVERY_TOOLS,
]);
export const JIRA_CHAT_TOOLS = [...JIRA_MANAGED_READ_TOOLS, ...JIRA_MUTATION_OPERATIONS];
/** Every tool the Chat catalog hosts: the Jira tools and the local Knowledge reads (#4179). */
export const CHAT_CATALOG_TOOLS: readonly JiraChatCatalogAction["tool"][] = [
  ...JIRA_CHAT_TOOLS,
  ...KNOWLEDGE_CHAT_TOOLS,
  ...JIRA_CATALOG_DISCOVERY_TOOLS,
];
const CHAT_TOOLS: ReadonlySet<string> = new Set(CHAT_CATALOG_TOOLS);
function isLocalCatalogRead(
  tool: string,
): tool is KnowledgeChatToolName | JiraCatalogDiscoveryToolName {
  return (
    (KNOWLEDGE_CHAT_TOOLS as readonly string[]).includes(tool) ||
    (JIRA_CATALOG_DISCOVERY_TOOLS as readonly string[]).includes(tool)
  );
}

function validActionFields(action: CatalogJsonObject): boolean {
  return (
    typeof action.actionId === "string" &&
    typeof action.idempotencyKey === "string" &&
    typeof action.argumentsDigest === "string" &&
    /^[a-f0-9]{64}$/u.test(action.argumentsDigest)
  );
}
function validActionBinding(tool: string, action: CatalogJsonObject): boolean {
  const bound = jiraOperationForTool(tool) !== undefined;
  const revisionKey = action.humanInputRevision === undefined ? "" : "humanInputRevision,";
  const sourceKey = action.sourceDigest === undefined ? "" : "sourceDigest,";
  const keys = bound
    ? `actionId,argumentsDigest,${revisionKey}idempotencyKey,operationBinding,${sourceKey}tool`
    : "actionId,argumentsDigest,idempotencyKey,tool";
  return (
    Object.keys(action).sort(compareStrings).join() === keys &&
    (!bound || isCurrentJiraOperationBinding(tool, action.operationBinding)) &&
    validOptionalActionRevision(action.humanInputRevision) &&
    validOptionalSourceDigest(action.sourceDigest)
  );
}
function validOptionalActionRevision(value: CatalogJsonValue | undefined): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value))
  );
}
function validOptionalSourceDigest(value: CatalogJsonValue | undefined): boolean {
  return value === undefined || (typeof value === "string" && /^[0-9a-f]{64}$/u.test(value));
}
function actionBinding(tool: string): Pick<JiraChatCatalogAction, "operationBinding"> {
  const binding = jiraOperationBindingForTool(tool);
  return binding === undefined ? {} : { operationBinding: binding };
}

function captureAction(value: CatalogJsonValue): JiraChatCatalogAction | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const action = value as CatalogJsonObject;
  const tool = CHAT_CATALOG_TOOLS.find((name) => name === action.tool);
  if (tool === undefined || !validActionFields(action) || !validActionBinding(tool, action))
    return undefined;
  return {
    tool,
    actionId: action.actionId as string,
    idempotencyKey: action.idempotencyKey as string,
    argumentsDigest: action.argumentsDigest as string,
    ...actionBinding(tool),
    ...(typeof action.sourceDigest === "string" ? { sourceDigest: action.sourceDigest } : {}),
    ...(typeof action.humanInputRevision === "string"
      ? { humanInputRevision: action.humanInputRevision }
      : {}),
  };
}

export function createJiraChatCatalogConsumerPort(
  sourceDigestFor?: (actionId: string, argumentsDigest: string) => string | undefined,
  humanInputRevisionFor?: (actionId: string, argumentsDigest: string) => string | undefined,
): CatalogConsumerPort<JiraChatCatalogConsumer> {
  const capture = (value: CatalogJsonValue): JiraChatCatalogAction | undefined => {
    const action = captureAction(value);
    if (action === undefined) return undefined;
    const sourceDigest = sourceDigestFor?.(action.actionId, action.argumentsDigest);
    if (action.sourceDigest !== undefined && action.sourceDigest !== sourceDigest) return undefined;
    const humanInputRevision = humanInputRevisionFor?.(action.actionId, action.argumentsDigest);
    if (action.humanInputRevision !== undefined && action.humanInputRevision !== humanInputRevision)
      return undefined;
    return {
      ...action,
      ...(sourceDigest === undefined ? {} : { sourceDigest }),
      ...(humanInputRevision === undefined ? {} : { humanInputRevision }),
    };
  };
  return {
    scope: (context) => ({
      kind: "jira-chat",
      chatId: context.chatId,
      authorityRunId: context.authorityReference.runId,
      authorityDigest: context.authorityReference.envelopeDigest,
    }),
    staleReason: "consumer-stale",
    requiredEffects: () => ["connector-access"],
    captureAction: (handler, value): JiraChatCatalogAction | undefined => {
      const action = capture(value);
      const operation = action === undefined ? undefined : jiraOperationForTool(action.tool);
      return handler.binding?.catalogAction === action?.tool &&
        (operation === undefined ||
          handler.descriptor.descriptorDigest === operation.declaration.descriptor.descriptorDigest)
        ? action
        : undefined;
    },
    captureApprovedAction: capture,
  };
}
export const jiraChatCatalogConsumerPort = createJiraChatCatalogConsumerPort();

export function jiraChatReadCatalogRoutes(): readonly ManagedCatalogRoute<JiraChatCatalogConsumer>[] {
  return jiraChatCatalogRoutes(JIRA_MANAGED_READ_TOOLS);
}

export function jiraChatCatalogRoutes(
  tools: readonly JiraChatCatalogAction["tool"][] = CHAT_CATALOG_TOOLS,
): readonly ManagedCatalogRoute<JiraChatCatalogConsumer>[] {
  return tools.map((tool) => ({
    name: tool,
    alias: tool.replace(/[.-]/gu, "_"),
    catalogAction: tool,
    previewAction: (identity): JiraChatCatalogAction => ({
      ...identity,
      tool,
      argumentsDigest: sha256Hex(canonicalise({})),
      ...actionBinding(tool),
    }),
    actionFor: (args, identity): JiraChatCatalogAction => ({
      ...identity,
      tool,
      argumentsDigest: sha256Hex(canonicalise(args)),
      ...actionBinding(tool),
    }),
    resultFor: (data, context): CatalogHandlerResult => {
      if (READ_TOOLS.has(tool)) requireDispatch(context.beforeEffect(), "denied", "effect-denied");
      return jiraCatalogResult(data);
    },
  }));
}

export interface JiraChatAdmissionOptions {
  readonly sourcePreparation?: import("./jiraChatRequirementBinding.js").JiraChatSourcePreparation;
  readonly deps: JiraChatAuthorityDeps & Pick<UiHandlerDeps, "atlassianActionApprovalRegistry">;
  readonly context: () => JiraChatCatalogContext;
  readonly now: () => number;
  /** Notification/wait only. The authenticated consent route remains the decision owner. */
  readonly requestReadConsent?: (
    grant: ChatToolReadGrantView,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly requestWriteConsent?: (
    approval: ChatToolWriteApprovalView,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly reviewableWrite?: (action: JiraChatCatalogAction) => boolean;
  /** Item refs of the persisted backlog draft preview; the registry validates a deselection. */
  readonly draftItemRefs?: (action: JiraChatCatalogAction) => readonly string[] | undefined;
  /**
   * Runs before a human is asked to approve a write. A returned object is the structured refusal
   * the model receives instead (issue-template violations, #4177); the approval is never created.
   */
  readonly preflightWrite?: (
    action: JiraChatCatalogAction,
    context: JiraChatCatalogContext,
    /** The requirement trace prepared for exactly this action, which its write receives too. */
    trace: JiraTraceRequest | undefined,
  ) => Promise<CatalogJsonObject | undefined>;
  /**
   * Runs after the preflight and before a human is asked: keeps the draft this write sends as the
   * Chat's open draft (the existing draft store), so an approval that expires leaves something to
   * resubmit (#4354 AC4). Absent or undefined for a write that is no draft.
   */
  readonly holdDraft?: (
    action: JiraChatCatalogAction,
    context: JiraChatCatalogContext,
  ) => HeldJiraDraft | undefined;
  /** The file a `jira.attach` approval shows the human; absent when it cannot be reviewed (#4176). */
  readonly attachmentPreview?: (
    action: JiraChatCatalogAction,
  ) => Promise<JiraAttachmentPreview | undefined>;
}
type AdmissionPorts = Pick<
  CatalogToolBinderInput<JiraChatCatalogConsumer>,
  "authorityPort" | "approvalPort"
>;
const DENIED = { ok: false, reason: "authority-invalid" } as const;
const REVIEW = { ok: false, reason: "approval-required" } as const;
const ALLOWED = { ok: true } as const;

function continuationIsLive(
  options: JiraChatAdmissionOptions,
  context: JiraChatCatalogContext,
): boolean {
  return (
    context.userMessageId === undefined ||
    chatApprovalContinuationIsLive(options.deps.store, context.userMessageId)
  );
}

function readPermission(
  options: JiraChatAdmissionOptions,
  action: JiraChatCatalogAction,
): ToolAuthorityAvailability {
  const context = options.context();
  if (!continuationIsLive(options, context)) return DENIED;
  const nowIso = new Date(options.now()).toISOString();
  const current = resolveCurrentJiraChatAuthority(
    options.deps,
    context.chatId,
    context.authorityReference,
    nowIso,
    context.correlationId,
  );
  const registry = options.deps.atlassianActionApprovalRegistry;
  if (
    !current.ok ||
    registry === undefined ||
    context.authorityExpiresAt !== current.envelope.expiresAt
  )
    return DENIED;
  // A Knowledge Pod the human attached to this Chat is read like a grounded answer reads it: the
  // current Chat authority admits it, no Jira consent is involved (#4179).
  if (isLocalCatalogRead(action.tool))
    return continuationIsLive(options, context) ? ALLOWED : DENIED;
  const policy = decideAtlassianEnvelopeAction(
    JIRA_MANAGED_ACTION_TYPES[action.tool],
    current.envelope,
  );
  if (policy.kind !== "allowed" && policy.kind !== "review-required") return DENIED;
  const entry = registry.findChatReadGrantForRequest(
    current.envelope.subject,
    context.authorityReference,
    context.correlationId,
  );
  const permission = grantPermission(options, entry, nowIso);
  return continuationIsLive(options, context) ? permission : DENIED;
}

function grantPermission(
  options: JiraChatAdmissionOptions,
  entry: ChatReadGrantEntry | undefined,
  nowIso: string,
): ToolAuthorityAvailability {
  const context = options.context();
  if (entry === undefined) return REVIEW;
  if (entry.grant.state !== "pending" && entry.grant.state !== "granted") return DENIED;
  return entry.grant.state === "granted" &&
    isCurrentJiraChatReadGrant(options.deps, entry, nowIso, context.correlationId)
    ? ALLOWED
    : REVIEW;
}

function preview(
  options: JiraChatAdmissionOptions,
  capability: string | undefined,
  action: JiraChatCatalogAction,
  claim?: ChatWriteApprovalClaim,
): ToolAuthorityAvailability {
  const context = options.context();
  const valid = chatCapabilityMatches(context, capability) && CHAT_TOOLS.has(action.tool);
  const read = valid ? readPermission(options, action) : DENIED;
  const outcome =
    read.ok && !READ_TOOLS.has(action.tool)
      ? jiraChatWritePermission(options, action, claim)
      : read;
  recordChatAuthorityResult(
    READ_TOOLS.has(action.tool) ? "catalog-read" : "catalog-write",
    outcome.ok
      ? { ok: true }
      : {
          ok: false,
          reason: outcome.reason === "approval-required" ? "review-required" : "invalid",
        },
    { chatId: context.chatId },
    context.correlationId,
  );
  return outcome;
}

function reviewableAction(
  options: JiraChatAdmissionOptions,
  action: JiraChatCatalogAction,
): boolean {
  return READ_TOOLS.has(action.tool) || options.reviewableWrite?.(action) === true;
}

/**
 * The template and field dry run of a write. A violating write is refused before any effect starts
 * and before any human is asked, whether or not its mode asks for an approval.
 */
/** A draft the source preparation refused by its closed reason: one body-free line, no text. */
function recordPreparedDraftRefusal(
  action: JiraChatCatalogAction,
  context: JiraChatCatalogContext,
  refusal: CatalogJsonObject,
): void {
  const reason = refusal.draftRefusal;
  if (action.tool !== "jira.draft" || reason !== "connection-changed") return;
  recordJiraDraftActivity(undefined, context.correlationId, {
    phase: "refused",
    refusal: reason,
    newDraft: false,
    pageItemCount: 0,
    itemCount: 0,
    pageCount: 0,
    byteCount: 0,
    unresolvedRefCount: 0,
    violationCount: 0,
    durationMs: 0,
  });
}

async function refuseByPreflight(
  options: JiraChatAdmissionOptions,
  action: JiraChatCatalogAction,
  context: JiraChatCatalogContext,
): Promise<void> {
  if (READ_TOOLS.has(action.tool)) return;
  const preparation = options.sourcePreparation;
  // The dry run admits what the write will: the write receives this prepared trace too (LIM27).
  const trace = preparation?.sourceFor(action.actionId, action.argumentsDigest)?.items[0]?.trace;
  const prepared = preparation?.refusalFor(action.actionId, action.argumentsDigest);
  const refusal = prepared ?? (await options.preflightWrite?.(action, context, trace));
  // The preflight records its own draft refusals; one the source preparation made has no other line.
  if (prepared !== undefined) recordPreparedDraftRefusal(action, context, prepared);
  if (refusal !== undefined) {
    const binding = jiraOperationBindingForTool(action.tool);
    requireDispatch(binding !== undefined, "failed", "provider-reported-error");
    // Preflight outcomes bypass the provider wrapper, but carry the same server-owned contract.
    // A refusal can never substitute its own operation identity or digest.
    throw new CatalogDispatchFault("failed", "provider-reported-error", undefined, {
      ...refusal,
      operationBinding: { ...binding },
    });
  }
}

/** The dry run first: a violating draft is refused before any human is asked. */
async function requestWriteStage(
  options: JiraChatAdmissionOptions,
  action: JiraChatCatalogAction,
  context: JiraChatCatalogContext,
): Promise<void> {
  await refuseByPreflight(options, action, context);
  const held = options.holdDraft?.(action, context);
  const wait = await requestCatalogWriteApproval({ ...options, context: () => context }, action);
  if (wait === "expired") {
    // The registry's own line records every expiry; a draft's refusal is also a draft event.
    if (action.tool === "jira.draft")
      recordJiraDraftActivity(undefined, context.correlationId, {
        phase: "refused",
        refusal: "approval-expired",
        newDraft: false,
        pageItemCount: 0,
        itemCount: held?.itemCount ?? 0,
        pageCount: 0,
        byteCount: 0,
        unresolvedRefCount: 0,
        violationCount: 0,
        durationMs: 0,
      });
    throw expiredApprovalFault(action, held);
  }
}

/** An approval that ran out is reported as that, with the draft to ask again with (#4354 AC4). */
function expiredApprovalFault(
  action: JiraChatCatalogAction,
  held: HeldJiraDraft | undefined,
): CatalogDispatchFault {
  const binding = jiraOperationBindingForTool(action.tool);
  requireDispatch(binding !== undefined, "failed", "provider-reported-error");
  // The model-visible refusal rides the `failed` class like every other refusal that carries
  // guidance (a denied result carries no data, the envelope rejects it): effectStarted is false and
  // the outcome says not-dispatched, so nothing claims an effect or a provider answer.
  return new CatalogDispatchFault("failed", "provider-reported-error", undefined, {
    ...jiraApprovalExpiredResult(held),
    operationBinding: { ...binding },
  });
}

async function requestConsent(
  options: JiraChatAdmissionOptions,
  action: JiraChatCatalogAction,
  context: JiraChatCatalogContext,
): Promise<JiraChatCatalogAction | undefined> {
  const before = preview(options, context.authority, action);
  if (before.ok) return action;
  if (
    before.reason !== "approval-required" ||
    options.requestReadConsent === undefined ||
    !reviewableAction(options, action)
  )
    return undefined;
  const request = requestJiraChatReadGrant(
    options.deps,
    context.chatId,
    context.authorityReference,
    new Date(options.now()).toISOString(),
    context.correlationId,
  );
  if (request.kind === "denied") return undefined;
  if (request.kind === "review-required")
    await options.requestReadConsent(request.grant, context.signal);
  if (!readPermission(options, action).ok) return undefined;
  if (!READ_TOOLS.has(action.tool)) await requestWriteStage(options, action, context);
  return preview(options, context.authority, action).ok ? action : undefined;
}

/** Shared binder owns schema admission, budget reservation, cancellation and single settlement. */
export function createJiraChatCatalogAdmission(options: JiraChatAdmissionOptions): AdmissionPorts {
  return {
    authorityPort: createChatToolAuthorityPort<JiraChatCatalogConsumer, JiraChatAdmissionOptions>(
      options,
      {
        preview,
        reviewable: reviewableAction,
        reserve: (current) => reserveChatToolInvocation(current, reserveCurrentJiraChatAuthority),
        guard: mutationGuard,
      },
    ),
    approvalPort: {
      available: (action) =>
        options.requestReadConsent !== undefined &&
        (READ_TOOLS.has(action.tool) || options.requestWriteConsent !== undefined),
      request: (action, context) => requestConsent(options, action, context),
      preflight: (action, context) => refuseByPreflight(options, action, context),
    },
  };
}

/** Only the running invocation's guard renews, and only after the full current-state check passed. */
function keepReadGrantCurrent(
  options: JiraChatAdmissionOptions,
  action: JiraChatCatalogAction,
): void {
  // A local catalog or Knowledge Pod read never consulted the Jira grant, so it does not keep it alive.
  if (isLocalCatalogRead(action.tool)) return;
  const context = options.context();
  const nowMs = options.now();
  const current = resolveCurrentJiraChatAuthority(
    options.deps,
    context.chatId,
    context.authorityReference,
    new Date(nowMs).toISOString(),
    context.correlationId,
  );
  if (current.ok)
    renewRunningReadGrant(
      options.deps.atlassianActionApprovalRegistry,
      current.envelope,
      context.authorityReference,
      nowMs,
      context.correlationId,
    );
}

function mutationGuard(
  options: JiraChatAdmissionOptions,
  capability: string | undefined,
  action: JiraChatCatalogAction,
): JiraChatCatalogConsumer["guard"] {
  let claim: ChatWriteApprovalClaim | undefined;
  const source = options.sourcePreparation?.sourceFor(action.actionId, action.argumentsDigest);
  const check = (): boolean => {
    const ok = preview(options, capability, action, claim).ok;
    if (ok) keepReadGrantCurrent(options, action);
    return ok;
  };
  return READ_TOOLS.has(action.tool)
    ? { check }
    : {
        check,
        write: {
          action,
          ...(source === undefined ? {} : { source }),
          beforeMutation: (itemRef): boolean => {
            if (!check()) return false;
            if (
              action.sourceDigest !== undefined &&
              (source?.sourceDigest !== action.sourceDigest ||
                options.sourcePreparation?.current(source, itemRef) !== true)
            )
              return false;
            // One approval covers one action; a backlog draft dispatches its items under it (#4178).
            if (claim !== undefined) return true;
            const result = claimJiraChatWrite(options, action);
            if (!result.ok) return false;
            claim = result.claim;
            return check();
          },
        },
      };
}
