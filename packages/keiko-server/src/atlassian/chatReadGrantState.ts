import type {
  ChatToolAuthoritySubject,
  ChatToolReadGrant,
  ChatToolReadGrantView,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import {
  validateChatToolReadGrant,
  validateChatToolAuthoritySubject,
} from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import { isEditorAgentGovernedAuthorityReference } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import { canonicalise } from "@oscharko-dev/keiko-security";
import { correlationIdOrUnknown } from "../correlation.js";
import { recordChatAuthorityResult } from "../editor/chatAuthorityActivity.js";

export interface ChatReadGrantEntry {
  readonly grant: ChatToolReadGrant;
  readonly authority: EditorAgentGovernedAuthorityReference;
}
export interface RetainedChatReadGrant {
  readonly kind: "chat-read";
  readonly entry: ChatReadGrantEntry;
  readonly correlationId: string;
}
export type ChatReadGrantResult =
  | { readonly ok: true; readonly grant: ChatToolReadGrant }
  | { readonly ok: false; readonly reason: "invalid" };

export function validReadGrantRequest(
  entry: ChatReadGrantEntry,
  now: number,
  ttl: number,
): boolean {
  const parsed = validateChatToolReadGrant(entry.grant);
  if (!parsed.ok || parsed.value.state !== "pending") return false;
  if (!isEditorAgentGovernedAuthorityReference(entry.authority)) return false;
  if (!Object.hasOwn(entry.authority, "runId") || !Object.hasOwn(entry.authority, "envelopeDigest"))
    return false;
  if (Object.keys(entry.authority).length !== 2) return false;
  return (
    parsed.value.requestedAt <= now &&
    parsed.value.expiresAt > now &&
    parsed.value.expiresAt - parsed.value.requestedAt <= ttl
  );
}

export function snapshotReadGrant(
  entry: ChatReadGrantEntry,
  correlationId?: string,
): RetainedChatReadGrant {
  return Object.freeze({
    kind: "chat-read",
    correlationId: correlationIdOrUnknown(correlationId),
    entry: Object.freeze({
      grant: Object.freeze({ ...entry.grant, subject: Object.freeze({ ...entry.grant.subject }) }),
      authority: Object.freeze({
        runId: entry.authority.runId,
        envelopeDigest: entry.authority.envelopeDigest,
      }),
    }),
  });
}

export function sameReadGrantSubject(
  grant: Pick<ChatToolReadGrant, "subject">,
  subject: ChatToolAuthoritySubject,
): boolean {
  return (
    validateChatToolAuthoritySubject(subject).ok &&
    canonicalise(grant.subject) === canonicalise(subject)
  );
}

export function sameReadGrantAuthority(
  entry: Pick<ChatReadGrantEntry, "authority">,
  authority: EditorAgentGovernedAuthorityReference,
): boolean {
  return (
    isEditorAgentGovernedAuthorityReference(authority) &&
    Object.hasOwn(authority, "runId") &&
    Object.hasOwn(authority, "envelopeDigest") &&
    Object.keys(authority).length === 2 &&
    canonicalise(entry.authority) === canonicalise(authority)
  );
}

const INACTIVE_REASON = {
  pending: "review-required",
  rejected: "policy-denied",
  expired: "expired",
  revoked: "revoked",
} as const;
export function recordReadGrant(record: RetainedChatReadGrant, affectedCount = 1): void {
  const grant = record.entry.grant;
  recordChatAuthorityResult(
    "read-grant",
    grant.state === "granted" ? { ok: true } : { ok: false, reason: INACTIVE_REASON[grant.state] },
    {
      subject: grant.subject,
      authorityDigest: record.entry.authority.envelopeDigest,
      grantId: grant.grantId,
      grantState: grant.state,
      consentProofDigest: grant.consentProofDigest ?? undefined,
      affectedCount,
    },
    record.correlationId,
  );
}

export function invalidReadGrant(correlationId?: string): {
  readonly ok: false;
  readonly reason: "invalid";
} {
  return recordChatAuthorityResult(
    "read-grant",
    { ok: false, reason: "invalid" },
    {},
    correlationId,
  );
}

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
