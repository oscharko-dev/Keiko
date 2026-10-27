import type {
  ChatToolReadGrantView,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import {
  JIRA_MANAGED_READ_TOOLS,
  type JiraManagedReadToolName,
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

/** Private ordinary-Chat scope. Neither a workspace nor a Coding session is required. */
export interface JiraChatCatalogContext extends ToolConsumerContext {
  readonly chatId: string;
  readonly authorityReference: EditorAgentGovernedAuthorityReference;
}
export interface JiraChatCatalogAction extends ToolConsumerActionIdentity {
  readonly tool: JiraManagedReadToolName;
  readonly argumentsDigest: string;
}
export interface JiraChatCatalogConsumer extends CatalogConsumer {
  readonly context: JiraChatCatalogContext;
  readonly action: JiraChatCatalogAction;
  readonly guard: ToolEffectGuard;
}
const READ_TOOLS: ReadonlySet<string> = new Set(JIRA_MANAGED_READ_TOOLS);

function captureAction(value: CatalogJsonValue): JiraChatCatalogAction | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const action = value as CatalogJsonObject;
  const tool = JIRA_MANAGED_READ_TOOLS.find((name) => name === action.tool);
  if (
    Object.keys(action).sort().join() !== "actionId,argumentsDigest,idempotencyKey,tool" ||
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
  return JIRA_MANAGED_READ_TOOLS.map((tool) => ({
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
    resultFor: (data) => ({
      data,
      page: {
        truncated: typeof data.nextStartAt === "number",
        reason: typeof data.nextStartAt === "number" ? "result-cap" : "none",
        cursor: null,
      },
      resultCount: Array.isArray(data.items) ? data.items.length : 0,
    }),
  }));
}

interface AdmissionOptions {
  readonly deps: JiraChatAuthorityDeps & Pick<UiHandlerDeps, "atlassianActionApprovalRegistry">;
  readonly context: () => JiraChatCatalogContext;
  readonly now: () => number;
  /** Notification/wait only. The authenticated consent route remains the decision owner. */
  readonly requestReadConsent?: (
    grant: ChatToolReadGrantView,
    signal: AbortSignal,
  ) => Promise<void>;
}
type AdmissionPorts = Pick<
  CatalogToolBinderInput<JiraChatCatalogConsumer>,
  "authorityPort" | "approvalPort"
>;
const DENIED = { ok: false, reason: "authority-invalid" } as const;
const REVIEW = { ok: false, reason: "approval-required" } as const;
const ALLOWED = { ok: true } as const;

function readPermission(
  options: AdmissionOptions,
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
  const policy = decideAtlassianEnvelopeAction(action.tool, current.envelope);
  if (policy.kind !== "allowed" && policy.kind !== "review-required") return DENIED;
  const entry = registry.findChatReadGrantForRequest(
    current.envelope.subject,
    context.authorityReference,
    context.correlationId,
  );
  return grantPermission(options, entry, nowIso);
}

function grantPermission(
  options: AdmissionOptions,
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
  options: AdmissionOptions,
  capability: string | undefined,
  action: JiraChatCatalogAction,
): ToolAuthorityAvailability {
  const context = options.context();
  const valid =
    capability === context.authority &&
    capability === context.authorityReference.envelopeDigest &&
    READ_TOOLS.has(action.tool) &&
    !context.signal.aborted;
  const outcome = valid ? readPermission(options, action) : DENIED;
  recordChatAuthorityResult(
    "catalog-read",
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

async function requestConsent(
  options: AdmissionOptions,
  action: JiraChatCatalogAction,
  context: JiraChatCatalogContext,
): Promise<JiraChatCatalogAction | undefined> {
  const before = preview(options, context.authority, action);
  if (before.ok) return action;
  if (before.reason !== "approval-required" || options.requestReadConsent === undefined)
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
  return preview(options, context.authority, action).ok ? action : undefined;
}

/** Shared binder owns schema admission, budget reservation, cancellation and single settlement. */
export function createJiraChatCatalogAdmission(options: AdmissionOptions): AdmissionPorts {
  return {
    authorityPort: {
      preview: (capability, action) => preview(options, capability, action),
      admit: (capability, action): ReturnType<AdmissionPorts["authorityPort"]["admit"]> => {
        if (!preview(options, capability, action).ok) return DENIED;
        const context = options.context();
        const reservation = reserveCurrentJiraChatAuthority(
          options.deps,
          context.chatId,
          context.authorityReference,
          { toolCalls: 1, patchBytes: 0, promptTokens: 0 },
          new Date(options.now()).toISOString(),
          context.correlationId,
        );
        return reservation.ok
          ? {
              ok: true,
              mutationGuard: {
                check: (): boolean => preview(options, capability, action).ok,
              },
            }
          : DENIED;
      },
    },
    approvalPort: {
      available: () => options.requestReadConsent !== undefined,
      request: (action, context) => requestConsent(options, action, context),
    },
  };
}
