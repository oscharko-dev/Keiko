import type { AtlassianConnectorActionType } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type {
  ChatToolAuthoritySubject,
  ChatToolReadGrantState,
} from "@oscharko-dev/keiko-contracts";
import { validateChatToolAuthoritySubject } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";

type Failure =
  "invalid" | "expired" | "budget-exceeded" | "revoked" | "review-required" | "policy-denied";
type Outcome = { readonly ok: true } | { readonly ok: false; readonly reason: Failure };
type Phase =
  "register" | "resolve" | "reserve" | "revoke" | "current-state" | "action-policy" | "read-grant";
export type ChatAuthorityReadiness =
  | "ready"
  | "chat-unavailable"
  | "not-bound"
  | "pod-unavailable"
  | "verification-required"
  | "generation-changed"
  | "mode-changed"
  | "authority-unavailable"
  | "authority-denied";

const OPTIONAL_DIGEST = {
  type: "string",
  dataClass: "digest",
  required: false,
  maxLength: 64,
} as const;
const OPTIONAL_COUNT = { type: "integer", dataClass: "count", required: false } as const;
const CHAT_AUTHORITY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.tool-authority.operation",
  category: "security",
  owner: "keiko-server",
  emitter: "editor.chatAuthorityActivity.recordChatAuthorityResult",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "register",
        "resolve",
        "reserve",
        "revoke",
        "current-state",
        "action-policy",
        "read-grant",
      ],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "allowed",
        "invalid",
        "expired",
        "budget-exceeded",
        "revoked",
        "review-required",
        "policy-denied",
      ],
    },
    actionType: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "sync-space",
        "sync-project",
        "search-issues-live",
        "create-issue",
        "update-issue-fields",
        "transition-issue",
        "add-issue-comment",
        "create-page",
        "update-page",
        "add-page-comment",
        "jira.projects",
        "jira.issue-types",
        "jira.create-fields",
        "jira.edit-fields",
        "jira.search",
        "jira.issue",
        "jira.comments",
        "jira.transitions",
        "jira.assignable-users",
        "assign-issue",
      ],
    },
    grantDigest: OPTIONAL_DIGEST,
    consentProofDigest: OPTIONAL_DIGEST,
    grantState: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["pending", "granted", "rejected", "expired", "revoked"],
    },
    authorityDigest: OPTIONAL_DIGEST,
    readiness: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "ready",
        "chat-unavailable",
        "not-bound",
        "pod-unavailable",
        "verification-required",
        "generation-changed",
        "mode-changed",
        "authority-unavailable",
        "authority-denied",
      ],
    },
    actorDigest: OPTIONAL_DIGEST,
    chatDigest: OPTIONAL_DIGEST,
    podDigest: OPTIONAL_DIGEST,
    bindingGeneration: OPTIONAL_COUNT,
    authenticationGeneration: OPTIONAL_COUNT,
    toolCalls: OPTIONAL_COUNT,
    promptTokens: OPTIONAL_COUNT,
    affectedCount: OPTIONAL_COUNT,
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["chat-tool-authority"],
  proofIds: [
    "chat.tool-authority.operation.action-policy",
    "chat.tool-authority.operation.current-state",
    "chat.tool-authority.operation.lifecycle",
    "chat.tool-authority.operation.read-grant",
    "chat.tool-authority.operation.read-grant-lifecycle",
    "chat.tool-authority.operation.read-consent-route",
  ],
  releaseImpact: "minor",
});

interface AuthorityEvidence {
  readonly grantId?: string | undefined;
  readonly grantState?: ChatToolReadGrantState | undefined;
  readonly consentProofDigest?: string | undefined;
  readonly actionType?: AtlassianConnectorActionType | undefined;
  readonly readiness?: ChatAuthorityReadiness | undefined;
  readonly authorityDigest?: string | undefined;
  readonly subject?: ChatToolAuthoritySubject | undefined;
  readonly chatId?: string | undefined;
  readonly toolCalls?: number | undefined;
  readonly promptTokens?: number | undefined;
  readonly affectedCount?: number | undefined;
}

function subjectFields(
  subject: ChatToolAuthoritySubject | undefined,
): Record<string, string | number> {
  if (!validateChatToolAuthoritySubject(subject).ok || subject === undefined) return {};
  return {
    actorDigest: subject.actorDigest,
    chatDigest: sha256Hex(subject.chatId),
    podDigest: sha256Hex(subject.podId),
    bindingGeneration: subject.bindingGeneration,
    authenticationGeneration: subject.authenticationGeneration,
  };
}

function countField(name: string, value: number | undefined): Record<string, number> {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? { [name]: value } : {};
}

function digestField(name: string, value: string | undefined): Record<string, string> {
  return value !== undefined && /^[a-f0-9]{64}$/.test(value) ? { [name]: value } : {};
}

function grantFields(evidence: AuthorityEvidence): Record<string, string> {
  return {
    ...(evidence.grantId === undefined ? {} : { grantDigest: sha256Hex(evidence.grantId) }),
    ...(evidence.grantState === undefined ? {} : { grantState: evidence.grantState }),
    ...digestField("consentProofDigest", evidence.consentProofDigest),
  };
}

export function recordChatAuthorityResult<T extends Outcome>(
  phase: Phase,
  result: T,
  evidence: AuthorityEvidence,
  correlationId: string | undefined,
): T {
  processServerLogSink().write(
    activityLogEvent(
      CHAT_AUTHORITY_OPERATION,
      {
        correlationId: correlationIdOrUnknown(correlationId),
        level: result.ok || result.reason === "review-required" ? "info" : "warn",
      },
      {
        phase,
        ...grantFields(evidence),
        ...(evidence.actionType === undefined ? {} : { actionType: evidence.actionType }),
        outcome: result.ok ? "allowed" : result.reason,
        ...(evidence.readiness === undefined ? {} : { readiness: evidence.readiness }),
        ...digestField("authorityDigest", evidence.authorityDigest),
        ...(evidence.chatId === undefined ? {} : { chatDigest: sha256Hex(evidence.chatId) }),
        ...subjectFields(evidence.subject),
        ...countField("toolCalls", evidence.toolCalls),
        ...countField("promptTokens", evidence.promptTokens),
        ...countField("affectedCount", evidence.affectedCount),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
  return result;
}
