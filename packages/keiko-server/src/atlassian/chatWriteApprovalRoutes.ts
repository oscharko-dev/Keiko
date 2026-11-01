import type { ChatToolWriteApprovalDecision } from "@oscharko-dev/keiko-contracts";
import {
  getChatConsent,
  decideChatConsent,
  chatConsentFailure,
  type ChatConsentRouteOwner,
} from "./chatConsentRouteOwner.js";
import { validateChatToolWriteApprovalDecision } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { RouteDefinition, RouteResult } from "../routes.js";
import { isCurrentMcpChatWriteApproval } from "../mcp/mcpChatWriteApproval.js";
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
  isCurrent: (deps, entry, nowIso, correlationId) =>
    entry.subject.kind === "configured-mcp"
      ? isCurrentMcpChatWriteApproval(deps, entry, nowIso, correlationId)
      : isCurrentJiraChatWriteApproval(deps, entry, nowIso, correlationId),
  matchesDecision: (entry, value) => entry.approval.actionDigest === value.actionDigest,
  validate: validateChatToolWriteApprovalDecision,
};
export const handleGetChatWriteApproval = getChatConsent(OWNER);

/** Human-only decision: approval authorizes one exact effect; it does not dispatch that effect. */
export const handleDecideChatWriteApproval = decideChatConsent(
  OWNER,
  (parsed, ctx): RouteResult => {
    const { entry, registry, nowIso } = parsed;
    const excludedItemRefs = parsed.value.excludedItemRefs ?? [];
    const proof = sha256Hex(
      canonicalise({
        kind:
          entry.approval.kind === "mcp-chat-write"
            ? "mcp-chat-write-approval"
            : "jira-chat-write-approval",
        approvalId: entry.approval.approvalId,
        action: entry.approval,
        subject: entry.subject,
        authority: entry.authority,
        // The human's deselection is part of what was approved (#4178).
        ...(excludedItemRefs.length === 0 ? {} : { excludedItemRefs }),
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
            excludedItemRefs,
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
  },
);

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
