import { randomUUID } from "node:crypto";
import type {
  ChatToolAuthorityEnvelope,
  ChatToolWriteApprovalView,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import { JIRA_MANAGED_ACTION_TYPES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { validateChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import type { UiHandlerDeps } from "../deps.js";
import { recordChatAuthorityResult } from "../editor/chatAuthorityActivity.js";
import { ATLASSIAN_ACTION_APPROVAL_TTL_MS } from "./actionApprovals.js";
import { decideAtlassianEnvelopeAction } from "./actionPolicy.js";
import { sameReadGrantSubject } from "./chatReadGrantState.js";
import {
  sameWriteAction,
  type ChatWriteApprovalEntry,
  type JiraChatWriteActionIdentity,
} from "./chatWriteApprovalState.js";
import {
  isCurrentJiraChatReadGrant,
  resolveCurrentJiraChatAuthority,
  type JiraChatAuthorityDeps,
} from "./jiraChatAuthority.js";

type WriteDeps = JiraChatAuthorityDeps & Pick<UiHandlerDeps, "atlassianActionApprovalRegistry">;
interface WriteFacts {
  readonly envelope: ChatToolAuthorityEnvelope;
  readonly readExpiresAt: number;
}
export type JiraChatWriteApprovalAdmission =
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
  deps: WriteDeps,
  chatId: string,
  authority: EditorAgentGovernedAuthorityReference,
  nowIso: string,
  correlationId: string,
): WriteFacts | undefined {
  const current = resolveCurrentJiraChatAuthority(deps, chatId, authority, nowIso, correlationId);
  const registry = deps.atlassianActionApprovalRegistry;
  if (!current.ok || registry === undefined) return undefined;
  const grant = registry.findGrantedChatReadGrant(current.envelope.subject, correlationId);
  const entry =
    grant === undefined ? undefined : registry.getChatReadGrant(grant.grantId, correlationId);
  if (entry === undefined || !isCurrentJiraChatReadGrant(deps, entry, nowIso, correlationId))
    return undefined;
  return { envelope: current.envelope, readExpiresAt: entry.grant.expiresAt };
}

/** Rechecks current custody, mode, authority and read consent without granting an action. */
export function isCurrentJiraChatWriteApproval(
  deps: WriteDeps,
  entry: ChatWriteApprovalEntry,
  nowIso: string,
  correlationId: string,
): boolean {
  const facts = currentWriteFacts(
    deps,
    entry.subject.chatId,
    entry.authority,
    nowIso,
    correlationId,
  );
  if (facts === undefined || !sameReadGrantSubject(entry, facts.envelope.subject)) return false;
  const policy = decideAtlassianEnvelopeAction(
    JIRA_MANAGED_ACTION_TYPES[entry.approval.operation],
    facts.envelope,
  );
  const now = Date.parse(nowIso);
  return (
    (policy.kind === "allowed" || policy.kind === "review-required") &&
    entry.approval.requestedAt <= now &&
    entry.approval.expiresAt > now &&
    entry.approval.expiresAt <= Date.parse(facts.envelope.expiresAt) &&
    entry.approval.expiresAt <= facts.readExpiresAt
  );
}

function denied(
  reason: Extract<JiraChatWriteApprovalAdmission, { kind: "denied" }>["reason"],
  chatId: string,
  correlationId: string,
): JiraChatWriteApprovalAdmission {
  recordChatAuthorityResult(
    "write-approval",
    { ok: false, reason: "invalid" },
    { chatId },
    correlationId,
  );
  return { kind: "denied", reason };
}

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
      approvalId: randomUUID(),
      chatId: subject.chatId,
      podId: subject.podId,
      bindingGeneration: subject.bindingGeneration,
      authenticationGeneration: subject.authenticationGeneration,
      ...action,
      state: "pending",
      requestedAt: now,
      expiresAt: Math.min(
        Date.parse(facts.envelope.expiresAt),
        facts.readExpiresAt,
        now + ATLASSIAN_ACTION_APPROVAL_TTL_MS,
      ),
    },
  };
}

function existingApproval(
  deps: WriteDeps,
  entry: ChatWriteApprovalEntry,
  action: JiraChatWriteActionIdentity,
  nowIso: string,
  correlationId: string,
): JiraChatWriteApprovalAdmission {
  if (!sameWriteAction(entry.approval, action))
    return denied("invalid", entry.subject.chatId, correlationId);
  if (!isCurrentJiraChatWriteApproval(deps, entry, nowIso, correlationId)) {
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

/** The browser decides the retained record; this never dispatches or consumes a write. */
export function requestJiraChatWriteApproval(
  deps: WriteDeps,
  chatId: string,
  authority: EditorAgentGovernedAuthorityReference,
  action: JiraChatWriteActionIdentity,
  nowIso: string,
  correlationId: string,
): JiraChatWriteApprovalAdmission {
  const facts = currentWriteFacts(deps, chatId, authority, nowIso, correlationId);
  const registry = deps.atlassianActionApprovalRegistry;
  if (facts === undefined || registry === undefined)
    return denied("authority-denied", chatId, correlationId);
  const entry = pendingApproval(facts, authority, action, Date.parse(nowIso));
  if (!validateChatToolWriteApprovalView(entry.approval).ok)
    return denied("invalid", chatId, correlationId);
  const policy = decideAtlassianEnvelopeAction(
    JIRA_MANAGED_ACTION_TYPES[action.operation],
    facts.envelope,
  );
  if (policy.kind === "allowed") return { kind: "allowed" };
  if (policy.kind !== "review-required") return denied("authority-denied", chatId, correlationId);
  const existing = registry.findChatWriteApproval(
    facts.envelope.subject,
    authority,
    action.invocationId,
    correlationId,
  );
  if (existing !== undefined)
    return existingApproval(deps, existing, action, nowIso, correlationId);
  const created = registry.createChatWriteApproval(entry, correlationId);
  if (!created.ok) return denied(created.reason, chatId, correlationId);
  return { kind: "review-required", approval: entry.approval };
}
