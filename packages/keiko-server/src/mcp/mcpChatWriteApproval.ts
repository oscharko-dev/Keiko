import {
  chatWriteApprovalTiming,
  createChatWriteApprovalOwner,
  type ChatWriteFacts,
  type ChatToolWriteApprovalAdmission,
} from "../chat-tool-approvals.js";
import type { EditorAgentGovernedAuthorityReference } from "@oscharko-dev/keiko-contracts";
import { codingWorkbenchPolicyEffectFor } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import {
  type ChatToolWriteActionIdentity,
  type ChatWriteApprovalEntry,
} from "../atlassian/chatWriteApprovalState.js";
import {
  isCurrentMcpChatReadGrant,
  resolveCurrentMcpChatAuthority,
  type McpChatAuthorityDeps,
  type McpChatAuthorityEnvelope,
} from "./mcpChatAuthority.js";

type WriteFacts = ChatWriteFacts<McpChatAuthorityEnvelope>;
export type McpChatWriteApprovalAdmission = ChatToolWriteApprovalAdmission;

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
      chatId: facts.envelope.subject.chatId,
      configurationDigest: facts.envelope.subject.configurationDigest,
      ...action,
      ...chatWriteApprovalTiming(facts, now),
    },
  };
}
const owner = createChatWriteApprovalOwner<
  McpChatAuthorityDeps,
  McpChatAuthorityEnvelope,
  ChatToolWriteActionIdentity
>({
  resolve: resolveCurrentMcpChatAuthority,
  readCurrent: isCurrentMcpChatReadGrant,
  matchesEntry: (entry) =>
    entry.approval.kind === "mcp-chat-write" && entry.subject.kind === "configured-mcp",
  policy: (_entry, envelope) => {
    const effect = codingWorkbenchPolicyEffectFor(envelope.effectiveMode, "internet", "medium");
    if (effect === "allowed") return "allowed";
    return effect === "approval-required" ? "review-required" : "denied";
  },
  pending: pending,
});
export const isCurrentMcpChatWriteApproval = owner.isCurrent;
export const requestMcpChatWriteApproval = owner.request;
