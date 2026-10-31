import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { createChatToolAuthorityPort, reserveChatToolInvocation } from "../chat-tool-approvals.js";
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

/** Private ordinary-Chat scope. Neither a workspace nor a Coding session is required. */
export interface JiraChatCatalogContext extends ToolConsumerContext {
  readonly chatId: string;
  readonly authorityReference: EditorAgentGovernedAuthorityReference;
  readonly userMessageId?: string;
}
export interface JiraChatCatalogAction extends ToolConsumerActionIdentity {
  readonly tool: JiraManagedReadToolName | JiraMutationOperation;
  readonly argumentsDigest: string;
}
export interface JiraChatCatalogConsumer extends CatalogConsumer {
  readonly context: JiraChatCatalogContext;
  readonly action: JiraChatCatalogAction;
  readonly guard: ToolEffectGuard & {
    readonly write?: {
      readonly action: JiraChatCatalogAction;
      readonly beforeMutation: () => boolean;
    };
  };
}
const READ_TOOLS: ReadonlySet<string> = new Set(JIRA_MANAGED_READ_TOOLS);
export const JIRA_CHAT_TOOLS = [...JIRA_MANAGED_READ_TOOLS, ...JIRA_MUTATION_OPERATIONS];
const CHAT_TOOLS = new Set(JIRA_CHAT_TOOLS);

function captureAction(value: CatalogJsonValue): JiraChatCatalogAction | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const action = value as CatalogJsonObject;
  const tool = JIRA_CHAT_TOOLS.find((name) => name === action.tool);
  if (
    Object.keys(action).sort(compareStrings).join() !==
      "actionId,argumentsDigest,idempotencyKey,tool" ||
    tool === undefined ||
    typeof action.actionId !== "string" ||
    typeof action.idempotencyKey !== "string" ||
    typeof action.argumentsDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(action.argumentsDigest)
  )
    return undefined;
  return {
    tool,
    actionId: action.actionId,
    idempotencyKey: action.idempotencyKey,
    argumentsDigest: action.argumentsDigest,
  };
}

export const jiraChatCatalogConsumerPort: CatalogConsumerPort<JiraChatCatalogConsumer> = {
  scope: (context) => ({
    kind: "jira-chat",
    chatId: context.chatId,
    authorityRunId: context.authorityReference.runId,
    authorityDigest: context.authorityReference.envelopeDigest,
  }),
  staleReason: "consumer-stale",
  requiredEffects: () => ["connector-access"],
  captureAction: (handler, value) => {
    const action = captureAction(value);
    return handler.binding?.catalogAction === action?.tool ? action : undefined;
  },
  captureApprovedAction: captureAction,
};

/** Use with the application-owned managed catalog; this creates no MCP host or transport. */
export function jiraChatReadCatalogRoutes(): readonly ManagedCatalogRoute<JiraChatCatalogConsumer>[] {
  return jiraChatCatalogRoutes(JIRA_MANAGED_READ_TOOLS);
}

export function jiraChatCatalogRoutes(
  tools: readonly JiraChatCatalogAction["tool"][] = JIRA_CHAT_TOOLS,
): readonly ManagedCatalogRoute<JiraChatCatalogConsumer>[] {
  return tools.map((tool) => ({
    name: tool,
    alias: tool.replace(/[.-]/gu, "_"),
    catalogAction: tool,
    previewAction: (identity): JiraChatCatalogAction => ({
      ...identity,
      tool,
      argumentsDigest: sha256Hex(canonicalise({})),
    }),
    actionFor: (args, identity): JiraChatCatalogAction => ({
      ...identity,
      tool,
      argumentsDigest: sha256Hex(canonicalise(args)),
    }),
    resultFor: (data, context): CatalogHandlerResult => {
      if (READ_TOOLS.has(tool)) requireDispatch(context.beforeEffect(), "denied", "effect-denied");
      return {
        data,
        page: {
          truncated: typeof data.nextStartAt === "number",
          reason: typeof data.nextStartAt === "number" ? "result-cap" : "none",
          cursor: null,
        },
        resultCount: Array.isArray(data.items) ? data.items.length : 0,
      };
    },
  }));
}

export interface JiraChatAdmissionOptions {
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
  ) => Promise<CatalogJsonObject | undefined>;
}
type AdmissionPorts = Pick<
  CatalogToolBinderInput<JiraChatCatalogConsumer>,
  "authorityPort" | "approvalPort"
>;
const DENIED = { ok: false, reason: "authority-invalid" } as const;
const REVIEW = { ok: false, reason: "approval-required" } as const;
const ALLOWED = { ok: true } as const;

function readPermission(
  options: JiraChatAdmissionOptions,
  action: JiraChatCatalogAction,
): ToolAuthorityAvailability {
  const context = options.context();
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
  return grantPermission(options, entry, nowIso);
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
  const valid =
    capability === context.authority &&
    capability === context.authorityReference.envelopeDigest &&
    CHAT_TOOLS.has(action.tool) &&
    !context.signal.aborted;
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
  if (!READ_TOOLS.has(action.tool)) {
    const refusal = await options.preflightWrite?.(action, context);
    if (refusal !== undefined) {
      throw new CatalogDispatchFault("failed", "provider-reported-error", undefined, refusal);
    }
    await requestCatalogWriteApproval({ ...options, context: () => context }, action);
  }
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
    },
  };
}

function mutationGuard(
  options: JiraChatAdmissionOptions,
  capability: string | undefined,
  action: JiraChatCatalogAction,
): JiraChatCatalogConsumer["guard"] {
  let claim: ChatWriteApprovalClaim | undefined;
  const check = (): boolean => preview(options, capability, action, claim).ok;
  return READ_TOOLS.has(action.tool)
    ? { check }
    : {
        check,
        write: {
          action,
          beforeMutation: (): boolean => {
            if (!check()) return false;
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
