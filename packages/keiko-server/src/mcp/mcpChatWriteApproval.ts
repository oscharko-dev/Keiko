import { randomUUID } from "node:crypto";
import type {
  ChatToolWriteApprovalView,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import { codingWorkbenchPolicyEffectFor } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { validateChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import { ATLASSIAN_ACTION_APPROVAL_TTL_MS } from "../atlassian/actionApprovals.js";
import { sameReadGrantSubject } from "../atlassian/chatReadGrantState.js";
import {
  sameWriteAction,
  type ChatToolWriteActionIdentity,
  type ChatWriteApprovalEntry,
} from "../atlassian/chatWriteApprovalState.js";
import { recordChatAuthorityResult } from "../editor/chatAuthorityActivity.js";
import {
  isCurrentMcpChatReadGrant,
  resolveCurrentMcpChatAuthority,
  type McpChatAuthorityDeps,
  type McpChatAuthorityEnvelope,
} from "./mcpChatAuthority.js";

interface WriteFacts {
  readonly envelope: McpChatAuthorityEnvelope;
  readonly readExpiresAt: number;
}
export type McpChatWriteApprovalAdmission =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "review-required" | "approved" | "claimed";
      readonly approval: ChatToolWriteApprovalView;
    }
  | {
      readonly kind: "denied";
      readonly reason: "authority-denied" | "invalid" | "rejected" | "capacity-exhausted";
    };

function currentWriteFacts(
  deps: McpChatAuthorityDeps,
  chatId: string,
  authority: EditorAgentGovernedAuthorityReference,
  nowIso: string,
  correlationId: string,
): WriteFacts | undefined {
  const current = resolveCurrentMcpChatAuthority(deps, chatId, authority, nowIso, correlationId);
  const registry = deps.atlassianActionApprovalRegistry;
  if (!current.ok || registry === undefined) return undefined;
  const grant = registry.findGrantedChatReadGrant(current.envelope.subject, correlationId);
  const entry =
    grant === undefined ? undefined : registry.getChatReadGrant(grant.grantId, correlationId);
  if (entry === undefined || !isCurrentMcpChatReadGrant(deps, entry, nowIso, correlationId))
    return undefined;
  return { envelope: current.envelope, readExpiresAt: entry.grant.expiresAt };
}

export function isCurrentMcpChatWriteApproval(
  deps: McpChatAuthorityDeps,
  entry: ChatWriteApprovalEntry,
  nowIso: string,
  correlationId: string,
): boolean {
  if (entry.approval.kind !== "mcp-chat-write" || entry.subject.kind !== "configured-mcp")
    return false;
  const facts = currentWriteFacts(
    deps,
    entry.subject.chatId,
    entry.authority,
    nowIso,
    correlationId,
  );
  if (facts === undefined || !sameReadGrantSubject(entry, facts.envelope.subject)) return false;
  const now = Date.parse(nowIso);
  return (
    codingWorkbenchPolicyEffectFor(facts.envelope.effectiveMode, "internet", "medium") !==
      "denied" &&
    entry.approval.requestedAt <= now &&
    entry.approval.expiresAt > now &&
    entry.approval.expiresAt <= Date.parse(facts.envelope.expiresAt) &&
    entry.approval.expiresAt <= facts.readExpiresAt
  );
}
function denied(
  reason: Extract<McpChatWriteApprovalAdmission, { kind: "denied" }>["reason"],
  chatId: string,
  correlationId: string,
): McpChatWriteApprovalAdmission {
  recordChatAuthorityResult(
    "write-approval",
    { ok: false, reason: "invalid" },
    { chatId },
    correlationId,
  );
  return { kind: "denied", reason };
}
function pending(
  facts: WriteFacts,
  authority: EditorAgentGovernedAuthorityReference,
  action: ChatToolWriteActionIdentity,
  now: number,
): ChatWriteApprovalEntry {
  return {
    subject: facts.envelope.subject,
    authority,
    approvalProofDigest: null,
    approval: {
      kind: "mcp-chat-write",
      approvalId: randomUUID(),
      chatId: facts.envelope.subject.chatId,
      configurationDigest: facts.envelope.subject.configurationDigest,
      ...action,
      requestedAt: now,
      expiresAt: Math.min(
        Date.parse(facts.envelope.expiresAt),
        facts.readExpiresAt,
        now + ATLASSIAN_ACTION_APPROVAL_TTL_MS,
      ),
      state: "pending",
    },
  };
}
function existing(
  deps: McpChatAuthorityDeps,
  entry: ChatWriteApprovalEntry,
  action: ChatToolWriteActionIdentity,
  nowIso: string,
  correlationId: string,
): McpChatWriteApprovalAdmission {
  if (!sameWriteAction(entry.approval, action))
    return denied("invalid", entry.subject.chatId, correlationId);
  if (!isCurrentMcpChatWriteApproval(deps, entry, nowIso, correlationId)) {
    deps.atlassianActionApprovalRegistry?.revokeChatWriteApproval(
      entry.approval.approvalId,
      correlationId,
    );
    return denied("authority-denied", entry.subject.chatId, correlationId);
  }
  const state = entry.approval.state;
  if (state === "pending" || state === "approved" || state === "claimed")
    return { kind: state === "pending" ? "review-required" : state, approval: entry.approval };
  return denied("rejected", entry.subject.chatId, correlationId);
}

/** Human approval is claimed exactly once by the effect owner after all current-state checks. */
export function requestMcpChatWriteApproval(
  deps: McpChatAuthorityDeps,
  chatId: string,
  authority: EditorAgentGovernedAuthorityReference,
  action: ChatToolWriteActionIdentity,
  nowIso: string,
  correlationId: string,
): McpChatWriteApprovalAdmission {
  const facts = currentWriteFacts(deps, chatId, authority, nowIso, correlationId);
  const registry = deps.atlassianActionApprovalRegistry;
  if (facts === undefined || registry === undefined)
    return denied("authority-denied", chatId, correlationId);
  const entry = pending(facts, authority, action, Date.parse(nowIso));
  if (!validateChatToolWriteApprovalView(entry.approval).ok)
    return denied("invalid", chatId, correlationId);
  const effect = codingWorkbenchPolicyEffectFor(facts.envelope.effectiveMode, "internet", "medium");
  if (effect === "allowed") return { kind: "allowed" };
  if (effect !== "approval-required") return denied("authority-denied", chatId, correlationId);
  const retained = registry.findChatWriteApproval(
    facts.envelope.subject,
    authority,
    action.invocationId,
    correlationId,
  );
  if (retained !== undefined) return existing(deps, retained, action, nowIso, correlationId);
  const created = registry.createChatWriteApproval(entry, correlationId);
  if (!created.ok) return denied(created.reason, chatId, correlationId);
  return { kind: "review-required", approval: entry.approval };
}
