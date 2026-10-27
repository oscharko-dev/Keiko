import type { ChatToolReadGrant, ChatToolReadGrantView } from "@oscharko-dev/keiko-contracts";
import { validateChatToolReadConsentDecision } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { UiHandlerDeps } from "../deps.js";
import { readJsonObject } from "../files.js";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import { errorBody } from "../route-error.js";
import { correlationIdOrUnknown } from "../correlation.js";
import { recordChatAuthorityResult } from "../editor/chatAuthorityActivity.js";
import { resolveCurrentJiraChatAuthority } from "./jiraChatAuthority.js";
import { sameReadGrantSubject, type ChatReadGrantEntry } from "./chatReadGrantState.js";
import type { AtlassianActionApprovalRegistry } from "./actionApprovals.js";

export function projectChatReadGrant(grant: ChatToolReadGrant): ChatToolReadGrantView {
  return {
    kind: "jira-chat-read",
    grantId: grant.grantId,
    chatId: grant.subject.chatId,
    podId: grant.subject.podId,
    bindingGeneration: grant.subject.bindingGeneration,
    authenticationGeneration: grant.subject.authenticationGeneration,
    state: grant.state,
    disclosureVersion: grant.disclosureVersion,
    requestedAt: grant.requestedAt,
    expiresAt: grant.expiresAt,
  };
}

function currentConsent(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  nowIso: string,
): { entry: ChatReadGrantEntry; registry: AtlassianActionApprovalRegistry } | undefined {
  const id = ctx.params.approvalId;
  const registry = deps.atlassianActionApprovalRegistry;
  if (registry === undefined || !isSafeAtlassianIdentifier(id)) return undefined;
  const entry = registry.getChatReadGrant(id, ctx.correlationId);
  if (entry === undefined) return undefined;
  const current = resolveCurrentJiraChatAuthority(
    deps,
    entry.grant.subject.chatId,
    entry.authority,
    nowIso,
    correlationIdOrUnknown(ctx.correlationId),
  );
  if (
    !current.ok ||
    !sameReadGrantSubject(entry.grant, current.envelope.subject) ||
    !current.envelope.connectorScopes.includes("issue-tracker.read") ||
    entry.grant.expiresAt > Date.parse(current.envelope.expiresAt)
  )
    return undefined;
  return { entry, registry };
}

const CONSENT_ERROR_CODES = {
  400: "VALIDATION_FAILED",
  404: "CHAT_READ_CONSENT_UNAVAILABLE",
  409: "CHAT_READ_CONSENT_UNAVAILABLE",
  413: "PAYLOAD_TOO_LARGE",
} as const;

function consentFailure(ctx: RouteContext, status: keyof typeof CONSENT_ERROR_CODES): RouteResult {
  recordChatAuthorityResult(
    "read-grant",
    { ok: false, reason: "invalid" },
    { grantId: ctx.params.approvalId },
    ctx.correlationId,
  );
  const code = CONSENT_ERROR_CODES[status];
  return {
    status,
    body: errorBody(
      code,
      "The Chat read consent is not available for this request.",
      ctx.correlationId,
    ),
  };
}

export function handleGetChatReadConsent(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const consent = currentConsent(ctx, deps, new Date().toISOString());
  if (consent === undefined) return consentFailure(ctx, 404);
  return { status: 200, body: { approval: projectChatReadGrant(consent.entry.grant) } };
}

/** Human-only consent endpoint. It changes the existing grant record and never executes a tool. */
export async function handleDecideChatReadConsent(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, 4096);
  if (body.status === 413) return consentFailure(ctx, 413);
  const parsed = validateChatToolReadConsentDecision(body);
  if (!parsed.ok) return consentFailure(ctx, 400);
  // Re-resolve after the asynchronous body read: rotation or a binding change may have intervened.
  const nowIso = new Date().toISOString();
  const consent = currentConsent(ctx, deps, nowIso);
  if (consent === undefined) return consentFailure(ctx, 404);
  const { entry, registry } = consent;
  const proof = sha256Hex(
    canonicalise({
      kind: "jira-chat-read-consent",
      grantId: entry.grant.grantId,
      subject: entry.grant.subject,
      authority: entry.authority,
      disclosureVersion: entry.grant.disclosureVersion,
      acceptedAt: nowIso,
    }),
  );
  const result =
    parsed.value.decision === "approve"
      ? registry.acceptChatReadGrant(
          entry.grant.grantId,
          entry.grant.subject,
          entry.authority,
          proof,
          ctx.correlationId,
        )
      : registry.rejectChatReadGrant(
          entry.grant.grantId,
          entry.grant.subject,
          entry.authority,
          ctx.correlationId,
        );
  if (!result.ok) return consentFailure(ctx, 409);
  return { status: 200, body: { approval: projectChatReadGrant(result.grant) } };
}

export const CHAT_READ_CONSENT_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/atlassian-connectors/action-approvals/:approvalId/chat-read-consent",
    handler: handleGetChatReadConsent,
  },
  {
    method: "POST",
    pattern: "/api/atlassian-connectors/action-approvals/:approvalId/chat-read-consent",
    handler: handleDecideChatReadConsent,
  },
];
