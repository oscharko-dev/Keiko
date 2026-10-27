import type { ChatToolWriteApprovalDecision } from "@oscharko-dev/keiko-contracts";
import {
  getChatConsent,
  readCurrentChatDecision,
  chatConsentFailure,
  type ChatConsentRouteOwner,
} from "./chatConsentRouteOwner.js";
import { validateChatToolWriteApprovalDecision } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { UiHandlerDeps } from "../deps.js";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import { isCurrentJiraChatWriteApproval } from "./jiraChatWriteApproval.js";
import {
  projectChatWriteApproval,
  recordWriteApproval,
  type ChatWriteApprovalEntry,
} from "./chatWriteApprovalState.js";

const OWNER: ChatConsentRouteOwner<ChatWriteApprovalEntry, ChatToolWriteApprovalDecision> = {
  phase: "write-approval",
  project: (entry, correlationId) => {
    recordWriteApproval({ kind: "chat-write", entry, correlationId }, 0);
    return projectChatWriteApproval(entry);
  },
  retained: (registry, id, correlation) => registry.getChatWriteApproval(id, correlation),
  isCurrent: isCurrentJiraChatWriteApproval,
  validate: validateChatToolWriteApprovalDecision,
};
export const handleGetChatWriteApproval = getChatConsent(OWNER);

/** Human-only decision: approval authorizes one exact effect; it does not dispatch that effect. */
export async function handleDecideChatWriteApproval(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const parsed = await readCurrentChatDecision(ctx, deps, OWNER);
  if (!parsed.ok) return parsed.response;
  const { entry, registry, nowIso } = parsed;
  if (entry.approval.actionDigest !== parsed.value.actionDigest)
    return chatConsentFailure(ctx, OWNER.phase, 409);
  const proof = sha256Hex(
    canonicalise({
      kind: "jira-chat-write-approval",
      approvalId: entry.approval.approvalId,
      action: entry.approval,
      subject: entry.subject,
      authority: entry.authority,
      acceptedAt: nowIso,
    }),
  );
  const result =
    parsed.value.decision === "approve"
      ? registry.acceptChatWriteApproval(
          entry.approval.approvalId,
          entry.subject,
          entry.authority,
          entry.approval,
          proof,
          ctx.correlationId,
        )
      : registry.rejectChatWriteApproval(
          entry.approval.approvalId,
          entry.subject,
          entry.authority,
          entry.approval,
          ctx.correlationId,
        );
  if (!result.ok) return chatConsentFailure(ctx, OWNER.phase, 409);
  return { status: 200, body: { approval: result.approval } };
}

export const CHAT_WRITE_APPROVAL_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/atlassian-connectors/action-approvals/:approvalId/chat-write-approval",
    handler: handleGetChatWriteApproval,
  },
  {
    method: "POST",
    pattern: "/api/atlassian-connectors/action-approvals/:approvalId/chat-write-approval",
    handler: handleDecideChatWriteApproval,
  },
];
