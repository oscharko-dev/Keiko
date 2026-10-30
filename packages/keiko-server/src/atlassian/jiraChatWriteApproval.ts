import {
  chatWriteApprovalTiming,
  createChatWriteApprovalOwner,
  type ChatWriteFacts,
  type ChatToolWriteApprovalAdmission,
} from "../chat-tool-approvals.js";
import type { EditorAgentGovernedAuthorityReference } from "@oscharko-dev/keiko-contracts";
import { JIRA_MANAGED_ACTION_TYPES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { UiHandlerDeps } from "../deps.js";
import { decideAtlassianEnvelopeAction } from "./actionPolicy.js";
import {
  type ChatWriteApprovalEntry,
  type JiraChatWriteActionIdentity,
} from "./chatWriteApprovalState.js";
import {
  isCurrentJiraChatReadGrant,
  resolveCurrentJiraChatAuthority,
  type JiraChatAuthorityDeps,
  type JiraChatAuthorityEnvelope,
} from "./jiraChatAuthority.js";

type WriteDeps = JiraChatAuthorityDeps & Pick<UiHandlerDeps, "atlassianActionApprovalRegistry">;
type WriteFacts = ChatWriteFacts<JiraChatAuthorityEnvelope>;
export type JiraChatWriteApprovalAdmission = ChatToolWriteApprovalAdmission;

function pendingApproval(
  facts: WriteFacts,
  authority: EditorAgentGovernedAuthorityReference,
  action: JiraChatWriteActionIdentity,
  now: number,
): ChatWriteApprovalEntry {
  const subject = facts.envelope.subject;
  return {
    subject,
    authority,
    approvalProofDigest: null,
    approval: {
      kind: "jira-chat-write",
      chatId: subject.chatId,
      podId: subject.podId,
      bindingGeneration: subject.bindingGeneration,
      authenticationGeneration: subject.authenticationGeneration,
      ...action,
      ...chatWriteApprovalTiming(facts, now),
    },
  };
}

const owner = createChatWriteApprovalOwner<
  WriteDeps,
  JiraChatAuthorityEnvelope,
  JiraChatWriteActionIdentity
>({
  resolve: resolveCurrentJiraChatAuthority,
  readCurrent: isCurrentJiraChatReadGrant,
  matchesEntry: (entry) => entry.approval.kind === "jira-chat-write",
  policy: (entry, envelope) => {
    if (entry.approval.kind !== "jira-chat-write") return "denied";
    const policy = decideAtlassianEnvelopeAction(
      JIRA_MANAGED_ACTION_TYPES[entry.approval.operation],
      envelope,
    );
    return policy.kind === "allowed" || policy.kind === "review-required" ? policy.kind : "denied";
  },
  pending: pendingApproval,
});
export const isCurrentJiraChatWriteApproval = owner.isCurrent;
export const requestJiraChatWriteApproval = owner.request;
