import type {
  ChatToolAuthoritySubject,
  ChatToolWriteApprovalView,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import { validateChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import type { JiraMutationOperation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { correlationIdOrUnknown } from "../correlation.js";
import { recordChatAuthorityResult } from "../editor/chatAuthorityActivity.js";
import { sameReadGrantAuthority, sameReadGrantSubject } from "./chatReadGrantState.js";

export interface ChatToolWriteActionIdentity {
  readonly invocationId: string;
  readonly operation: string;
  readonly actionDigest: string;
}
export interface JiraChatWriteActionIdentity extends ChatToolWriteActionIdentity {
  readonly operation: JiraMutationOperation;
}
export interface ChatWriteApprovalEntry {
  readonly approval: ChatToolWriteApprovalView;
  readonly subject: ChatToolAuthoritySubject;
  readonly authority: EditorAgentGovernedAuthorityReference;
  readonly approvalProofDigest: string | null;
  /**
   * Item refs of the reviewed backlog draft. Server-side only: it is never projected to the
   * client and lets the registry validate a human deselection before any state changes (#4178).
   */
  readonly draftItemRefs?: readonly string[];
}
export interface ChatWriteApprovalClaim {
  readonly approvalId: string;
  readonly claimId: string;
}
export interface RetainedChatWriteApproval {
  readonly kind: "chat-write";
  readonly entry: ChatWriteApprovalEntry;
  readonly correlationId: string;
  readonly claimId?: string;
}
export type ChatWriteApprovalResult =
  | { readonly ok: true; readonly approval: ChatToolWriteApprovalView }
  | { readonly ok: false; readonly reason: "invalid" };

export function sameWriteAction(
  approval: ChatToolWriteApprovalView,
  action: ChatToolWriteActionIdentity,
): boolean {
  return (
    approval.invocationId === action.invocationId &&
    approval.operation === action.operation &&
    approval.actionDigest === action.actionDigest
  );
}

function matchesApprovalSubject(entry: ChatWriteApprovalEntry): boolean {
  const { approval, subject } = entry;
  if (subject.kind === "configured-mcp")
    return (
      approval.kind === "mcp-chat-write" &&
      sameReadGrantSubject(entry, subject) &&
      approval.chatId === subject.chatId &&
      approval.configurationDigest === subject.configurationDigest
    );
  return (
    approval.kind === "jira-chat-write" &&
    sameReadGrantSubject(entry, subject) &&
    approval.chatId === subject.chatId &&
    approval.podId === subject.podId &&
    approval.bindingGeneration === subject.bindingGeneration &&
    approval.authenticationGeneration === subject.authenticationGeneration
  );
}

export function validWriteApprovalRequest(
  entry: ChatWriteApprovalEntry,
  now: number,
  ttl: number,
): boolean {
  const approval = entry.approval;
  return (
    validateChatToolWriteApprovalView(approval).ok &&
    approval.state === "pending" &&
    entry.approvalProofDigest === null &&
    sameReadGrantAuthority(entry, entry.authority) &&
    matchesApprovalSubject(entry) &&
    approval.requestedAt <= now &&
    approval.expiresAt > now &&
    approval.expiresAt - approval.requestedAt <= ttl
  );
}

export function snapshotWriteApproval(
  entry: ChatWriteApprovalEntry,
  correlationId?: string,
  claimId?: string,
): RetainedChatWriteApproval {
  return Object.freeze({
    kind: "chat-write",
    correlationId: correlationIdOrUnknown(correlationId),
    ...(claimId === undefined ? {} : { claimId }),
    entry: Object.freeze({
      approval: Object.freeze({ ...entry.approval }),
      subject: Object.freeze({ ...entry.subject }),
      authority: Object.freeze({
        runId: entry.authority.runId,
        envelopeDigest: entry.authority.envelopeDigest,
      }),
      approvalProofDigest: entry.approvalProofDigest,
      ...(entry.draftItemRefs === undefined
        ? {}
        : { draftItemRefs: Object.freeze([...entry.draftItemRefs]) }),
    }),
  });
}

/**
 * The deselection is empty, or a unique subset of the refs of the draft that was reviewed. Only a
 * backlog draft that recorded its refs can be partially approved; anything else fails closed.
 */
export function admitsWriteDeselection(
  entry: ChatWriteApprovalEntry,
  excludedItemRefs: readonly string[],
): boolean {
  if (excludedItemRefs.length === 0) return true;
  const { approval, draftItemRefs } = entry;
  if (
    approval.kind !== "jira-chat-write" ||
    approval.operation !== "jira.draft" ||
    draftItemRefs === undefined
  )
    return false;
  const refs = new Set(draftItemRefs);
  return (
    new Set(excludedItemRefs).size === excludedItemRefs.length &&
    excludedItemRefs.every((ref) => refs.has(ref))
  );
}

const DENIAL = {
  pending: "review-required",
  rejected: "policy-denied",
  expired: "expired",
  revoked: "revoked",
} as const;
export function recordWriteApproval(record: RetainedChatWriteApproval, affectedCount = 1): void {
  const { entry } = record;
  const { approval } = entry;
  recordChatAuthorityResult(
    "write-approval",
    approval.state === "approved" || approval.state === "claimed"
      ? { ok: true }
      : { ok: false, reason: DENIAL[approval.state] },
    {
      subject: entry.subject,
      authorityDigest: entry.authority.envelopeDigest,
      approvalId: approval.approvalId,
      approvalState: approval.state,
      actionDigest: approval.actionDigest,
      consentProofDigest: entry.approvalProofDigest ?? undefined,
      affectedCount,
    },
    record.correlationId,
  );
}

export function invalidWriteApproval(correlationId?: string): {
  readonly ok: false;
  readonly reason: "invalid";
} {
  return recordChatAuthorityResult(
    "write-approval",
    { ok: false, reason: "invalid" },
    {},
    correlationId,
  );
}

export function projectChatWriteApproval(entry: ChatWriteApprovalEntry): ChatToolWriteApprovalView {
  return { ...entry.approval };
}
