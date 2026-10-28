import type {
  ChatToolReadGrantView,
  ChatToolWriteApprovalView,
} from "@oscharko-dev/keiko-contracts";
import type { ToolAuthorityAvailability } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { CatalogToolBinderInput } from "../tool-catalog/catalogToolPorts.js";
import type {
  ChatWriteApprovalClaim,
  ChatToolWriteActionIdentity,
} from "../atlassian/chatWriteApprovalState.js";
import { sameWriteAction } from "../atlassian/chatWriteApprovalState.js";
import {
  resolveCurrentMcpChatAuthority,
  reserveCurrentMcpChatAuthority,
  requestMcpChatReadGrant,
  isCurrentMcpChatReadGrant,
  type McpChatAuthorityDeps,
} from "./mcpChatAuthority.js";
import {
  isCurrentMcpChatWriteApproval,
  requestMcpChatWriteApproval,
} from "./mcpChatWriteApproval.js";
import type {
  McpChatCatalogAction,
  McpChatCatalogConsumer,
  McpChatCatalogContext,
  McpChatCatalogTool,
} from "./mcpChatCatalogConsumer.js";

export interface McpChatAdmissionOptions {
  readonly deps: McpChatAuthorityDeps;
  readonly context: () => McpChatCatalogContext;
  readonly tools: readonly McpChatCatalogTool[];
  readonly now: () => number;
  readonly requestReadConsent: (grant: ChatToolReadGrantView, signal: AbortSignal) => Promise<void>;
  readonly requestWriteConsent: (
    approval: ChatToolWriteApprovalView,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly reviewableWrite: (action: McpChatCatalogAction) => boolean;
}
type Ports = Pick<CatalogToolBinderInput<McpChatCatalogConsumer>, "authorityPort" | "approvalPort">;
const DENIED = { ok: false, reason: "authority-invalid" } as const;
const REVIEW = { ok: false, reason: "approval-required" } as const;
const ALLOWED = { ok: true } as const;

export function mcpChatWriteAction(action: McpChatCatalogAction): ChatToolWriteActionIdentity {
  return {
    invocationId: action.actionId,
    operation: action.name,
    actionDigest: sha256Hex(
      canonicalise({
        operation: action.name,
        argumentsDigest: action.argumentsDigest,
      }),
    ),
  };
}
function currentFacts(
  options: McpChatAdmissionOptions,
): Extract<ReturnType<typeof resolveCurrentMcpChatAuthority>, { ok: true }> | undefined {
  const context = options.context();
  if (context.signal.aborted) return undefined;
  const current = resolveCurrentMcpChatAuthority(
    options.deps,
    context.chatId,
    context.authorityReference,
    new Date(options.now()).toISOString(),
    context.correlationId,
  );
  return current.ok &&
    current.envelope.expiresAt === context.authorityExpiresAt &&
    current.envelope.subject.configurationDigest === context.configurationDigest
    ? current
    : undefined;
}
function readPermission(options: McpChatAdmissionOptions): ToolAuthorityAvailability {
  const current = currentFacts(options);
  const registry = options.deps.atlassianActionApprovalRegistry;
  if (current === undefined || registry === undefined) return DENIED;
  const context = options.context();
  const entry = registry.findChatReadGrantForRequest(
    current.envelope.subject,
    context.authorityReference,
    context.correlationId,
  );
  if (entry === undefined || entry.grant.state === "pending") return REVIEW;
  return entry.grant.state === "granted" &&
    isCurrentMcpChatReadGrant(
      options.deps,
      entry,
      new Date(options.now()).toISOString(),
      context.correlationId,
    )
    ? ALLOWED
    : DENIED;
}
function writePermission(
  options: McpChatAdmissionOptions,
  action: McpChatCatalogAction,
  claim?: ChatWriteApprovalClaim,
): ToolAuthorityAvailability {
  const current = currentFacts(options);
  const registry = options.deps.atlassianActionApprovalRegistry;
  if (current === undefined || registry === undefined) return DENIED;
  if (current.envelope.effectiveMode === "autonomous-delivery") return ALLOWED;
  const context = options.context();
  const identity = mcpChatWriteAction(action);
  const entry = registry.findChatWriteApproval(
    current.envelope.subject,
    context.authorityReference,
    identity.invocationId,
    context.correlationId,
  );
  if (entry === undefined) return REVIEW;
  if (
    !sameWriteAction(entry.approval, identity) ||
    !isCurrentMcpChatWriteApproval(
      options.deps,
      entry,
      new Date(options.now()).toISOString(),
      context.correlationId,
    )
  )
    return DENIED;
  return grantedWritePermission(
    options,
    current.envelope.subject,
    identity,
    entry.approval.state,
    claim,
  );
}
function grantedWritePermission(
  options: McpChatAdmissionOptions,
  subject: Extract<
    ReturnType<typeof resolveCurrentMcpChatAuthority>,
    { ok: true }
  >["envelope"]["subject"],
  identity: ChatToolWriteActionIdentity,
  state: ChatToolWriteApprovalView["state"],
  claim: ChatWriteApprovalClaim | undefined,
): ToolAuthorityAvailability {
  if (state === "pending") return REVIEW;
  if (state === "approved") return ALLOWED;
  const context = options.context();
  return claim !== undefined &&
    options.deps.atlassianActionApprovalRegistry?.isChatWriteClaimCurrent(
      claim,
      subject,
      context.authorityReference,
      identity,
      context.correlationId,
    ) === true
    ? ALLOWED
    : DENIED;
}
function validAction(
  options: McpChatAdmissionOptions,
  capability: string | undefined,
  action: McpChatCatalogAction,
): boolean {
  const context = options.context();
  return (
    capability === context.authority &&
    capability === context.authorityReference.envelopeDigest &&
    options.tools.some(
      (tool) =>
        tool.name === action.name &&
        tool.serverName === action.serverName &&
        tool.toolName === action.toolName &&
        tool.risk === action.risk,
    )
  );
}
function preview(
  options: McpChatAdmissionOptions,
  capability: string | undefined,
  action: McpChatCatalogAction,
  claim?: ChatWriteApprovalClaim,
): ToolAuthorityAvailability {
  if (!validAction(options, capability, action)) return DENIED;
  const read = readPermission(options);
  return read.ok && action.risk === "write" ? writePermission(options, action, claim) : read;
}
function reviewable(options: McpChatAdmissionOptions, action: McpChatCatalogAction): boolean {
  return action.risk === "read" || options.reviewableWrite(action);
}
async function requestConsent(
  options: McpChatAdmissionOptions,
  action: McpChatCatalogAction,
  context: McpChatCatalogContext,
): Promise<McpChatCatalogAction | undefined> {
  const permission = preview(options, context.authority, action);
  if (permission.ok) return action;
  if (permission.reason !== "approval-required" || !reviewable(options, action)) return undefined;
  const read = requestMcpChatReadGrant(
    options.deps,
    context.chatId,
    context.authorityReference,
    new Date(options.now()).toISOString(),
    context.correlationId,
  );
  if (read.kind === "denied") return undefined;
  if (read.kind === "review-required") await options.requestReadConsent(read.grant, context.signal);
  if (!readPermission(options).ok) return undefined;
  if (action.risk === "write") {
    const write = requestMcpChatWriteApproval(
      options.deps,
      context.chatId,
      context.authorityReference,
      mcpChatWriteAction(action),
      new Date(options.now()).toISOString(),
      context.correlationId,
    );
    if (write.kind === "review-required")
      await options.requestWriteConsent(write.approval, context.signal);
  }
  return preview(options, context.authority, action).ok ? action : undefined;
}
function claimWrite(
  options: McpChatAdmissionOptions,
  action: McpChatCatalogAction,
): { readonly ok: true; readonly claim?: ChatWriteApprovalClaim } | { readonly ok: false } {
  const current = currentFacts(options);
  const registry = options.deps.atlassianActionApprovalRegistry;
  if (current === undefined || registry === undefined) return { ok: false };
  if (current.envelope.effectiveMode === "autonomous-delivery") return { ok: true };
  const context = options.context();
  const identity = mcpChatWriteAction(action);
  const entry = registry.findChatWriteApproval(
    current.envelope.subject,
    context.authorityReference,
    identity.invocationId,
    context.correlationId,
  );
  if (entry === undefined || !writePermission(options, action).ok) return { ok: false };
  return registry.claimChatWriteApproval(
    entry.approval.approvalId,
    current.envelope.subject,
    context.authorityReference,
    identity,
    context.correlationId,
  );
}
function guard(
  options: McpChatAdmissionOptions,
  capability: string | undefined,
  action: McpChatCatalogAction,
): McpChatCatalogConsumer["guard"] {
  let claim: ChatWriteApprovalClaim | undefined;
  const check = (): boolean => preview(options, capability, action, claim).ok;
  return action.risk === "read"
    ? { check }
    : {
        check,
        write: {
          action,
          beforeMutation: (): boolean => {
            if (!check()) return false;
            const result = claimWrite(options, action);
            if (!result.ok) return false;
            claim = result.claim;
            return check();
          },
        },
      };
}
/** The existing binder owns schema checks, approval routing, budgets and exactly-once settlement. */
export function createMcpChatCatalogAdmission(options: McpChatAdmissionOptions): Ports {
  return {
    authorityPort: {
      preview: (capability, action) => preview(options, capability, action),
      admit: (capability, action): ReturnType<Ports["authorityPort"]["admit"]> => {
        if (!preview(options, capability, action).ok || !reviewable(options, action)) return DENIED;
        const context = options.context();
        const reserved = reserveCurrentMcpChatAuthority(
          options.deps,
          context.chatId,
          context.authorityReference,
          { toolCalls: 1, patchBytes: 0, promptTokens: 0 },
          new Date(options.now()).toISOString(),
          context.correlationId,
        );
        return reserved.ok
          ? { ok: true, mutationGuard: guard(options, capability, action) }
          : DENIED;
      },
    },
    approvalPort: {
      available: () => true,
      request: (action, context) => requestConsent(options, action, context),
    },
  };
}
