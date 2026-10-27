import type { ChatToolReadConsentDecision } from "@oscharko-dev/keiko-contracts";
import {
  getChatConsent,
  readCurrentChatDecision,
  chatConsentFailure,
  type ChatConsentRouteOwner,
} from "./chatConsentRouteOwner.js";
import { validateChatToolReadConsentDecision } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { UiHandlerDeps } from "../deps.js";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import { isCurrentJiraChatReadGrant } from "./jiraChatAuthority.js";
import { projectChatReadGrant, type ChatReadGrantEntry } from "./chatReadGrantState.js";

const OWNER: ChatConsentRouteOwner<ChatReadGrantEntry, ChatToolReadConsentDecision> = {
  phase: "read-grant",
  project: (entry) => projectChatReadGrant(entry.grant),
  retained: (registry, id, correlation) => registry.getChatReadGrant(id, correlation),
  isCurrent: isCurrentJiraChatReadGrant,
  validate: validateChatToolReadConsentDecision,
};
export const handleGetChatReadConsent = getChatConsent(OWNER);

/** Human-only consent endpoint. It changes the existing grant record and never executes a tool. */
export async function handleDecideChatReadConsent(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const parsed = await readCurrentChatDecision(ctx, deps, OWNER);
  if (!parsed.ok) return parsed.response;
  const { entry, registry, nowIso } = parsed;
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
  if (!result.ok) return chatConsentFailure(ctx, OWNER.phase, 409);
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
