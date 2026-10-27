import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { ChatToolAuthoritySubject } from "@oscharko-dev/keiko-contracts";
import { validateChatToolAuthoritySubject } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";

type Failure = "invalid" | "expired" | "budget-exceeded" | "revoked";
type Outcome = { readonly ok: true } | { readonly ok: false; readonly reason: Failure };
type Phase = "register" | "resolve" | "reserve" | "revoke";

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
      values: ["register", "resolve", "reserve", "revoke"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["allowed", "invalid", "expired", "budget-exceeded", "revoked"],
    },
    authorityDigest: OPTIONAL_DIGEST,
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
  proofIds: ["chat.tool-authority.operation.lifecycle"],
  releaseImpact: "minor",
});

interface AuthorityEvidence {
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

export function recordChatAuthorityResult<T extends Outcome>(
  phase: Phase,
  result: T,
  evidence: AuthorityEvidence,
  correlationId: string | undefined,
): T {
  const digest = evidence.authorityDigest;
  processServerLogSink().write(
    activityLogEvent(
      CHAT_AUTHORITY_OPERATION,
      {
        correlationId: correlationIdOrUnknown(correlationId),
        level: result.ok ? "info" : "warn",
      },
      {
        phase,
        outcome: result.ok ? "allowed" : result.reason,
        ...(digest !== undefined && /^[a-f0-9]{64}$/.test(digest)
          ? { authorityDigest: digest }
          : {}),
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
