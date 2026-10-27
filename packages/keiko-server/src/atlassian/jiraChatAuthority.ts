import { randomUUID } from "node:crypto";
import { DEFAULT_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/harness";
import { resolveEffectiveCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { CHAT_TOOL_READ_DISCLOSURE_VERSION } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import {
  ATLASSIAN_ACTION_APPROVAL_TTL_MS,
  ATLASSIAN_ACTION_APPROVAL_MAX_PENDING,
  type AtlassianActionApprovalRegistry,
} from "./actionApprovals.js";
import {
  projectChatReadGrant,
  sameReadGrantSubject,
  type ChatReadGrantEntry,
} from "./chatReadGrantState.js";
import {
  ATLASSIAN_AUTHORITY_FAILURE_REASON,
  decideAtlassianEnvelopeAction,
  type AtlassianGovernedActionOutcome,
} from "./actionPolicy.js";
import type {
  ChatToolAuthorityEnvelope,
  CodingWorkbenchMode,
  ChatToolReadGrant,
  ChatToolReadGrantView,
  AtlassianConnectorActionType,
  CodingWorkbenchRuntimeDelegationUsage,
  ChatToolAuthoritySubject,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import type { Chat } from "../store/index.js";
import type { EditorAgentAuthorityFailureReason } from "../editor/agentAuthorityRegistry.js";
import {
  recordChatAuthorityResult,
  type ChatAuthorityReadiness,
} from "../editor/chatAuthorityActivity.js";
import {
  findOwnedJiraPod,
  isReadyJiraPod,
  type JiraPodAccessDeps,
  type JiraLivePodCredential,
} from "./jiraPodAccess.js";

export type JiraChatAuthorityDeps = JiraPodAccessDeps &
  Pick<UiHandlerDeps, "store" | "agentAuthorityRegistry" | "autonomousDeliveryDeploymentCeiling">;

type CurrentJiraChatAuthority =
  | {
      readonly ok: true;
      readonly envelope: ChatToolAuthorityEnvelope;
      readonly credential: JiraLivePodCredential;
    }
  | { readonly ok: false; readonly reason: EditorAgentAuthorityFailureReason };

interface CurrentFacts {
  readonly ok: true;
  readonly chat: Chat;
  readonly credential: JiraLivePodCredential;
  readonly subject: ChatToolAuthoritySubject;
}

export interface AcceptedJiraChatTurn {
  readonly chatId: string;
  readonly userMessageId: string;
  readonly startedAtMs: number;
  readonly nowMs: number;
  readonly correlationId: string;
}
type AcceptedJiraChatAuthority =
  | {
      readonly ok: true;
      readonly envelope: ChatToolAuthorityEnvelope;
      readonly reference: EditorAgentGovernedAuthorityReference;
    }
  | { readonly ok: false; readonly reason: EditorAgentAuthorityFailureReason };

function acceptedTurnEnvelope(
  facts: CurrentFacts,
  turn: AcceptedJiraChatTurn,
  deploymentCeiling: CodingWorkbenchMode,
): ChatToolAuthorityEnvelope {
  const requestedMode = facts.chat.toolMode ?? "governed-assist";
  const runId = `chat-${sha256Hex(canonicalise({ chatId: turn.chatId, userMessageId: turn.userMessageId }))}`;
  return {
    schemaVersion: "1",
    kind: "chat-tool-authority",
    runId,
    subject: facts.subject,
    requestedMode,
    deploymentCeiling,
    effectiveMode: resolveEffectiveCodingWorkbenchMode(requestedMode, deploymentCeiling),
    actionClasses: ["connector-access", "network-egress"],
    connectorScopes: ["issue-tracker.read", "issue-tracker.write"],
    budget: {
      maxRuntimeMs: DEFAULT_LIMITS.maxWallTimeMs,
      maxToolCalls: DEFAULT_LIMITS.maxToolCalls,
      maxPromptTokens: 100_000,
      maxPatchBytes: 0,
    },
    expiresAt: new Date(turn.startedAtMs + DEFAULT_LIMITS.maxWallTimeMs).toISOString(),
    approvalProofDigest: sha256Hex(
      canonicalise({
        runId,
        subject: facts.subject,
        requestedMode,
        deploymentCeiling,
        userMessageId: turn.userMessageId,
        acceptedAtMs: turn.startedAtMs,
      }),
    ),
  };
}

function isCurrentAcceptedMessage(
  deps: JiraChatAuthorityDeps,
  turn: AcceptedJiraChatTurn,
): boolean {
  const message = deps.store.findMessageById(turn.userMessageId);
  return (
    message?.role === "user" &&
    message.chatId === turn.chatId &&
    message.timestamp === turn.startedAtMs &&
    (message.turnState === undefined || message.turnState === "pending") &&
    deps.store.listMessages(turn.chatId, 1).at(-1)?.id === message.id
  );
}

/** Retain the same canonical admission and deadline across duplicate calls and every phase. */
function validAcceptedTurn(deps: JiraChatAuthorityDeps, turn: AcceptedJiraChatTurn): boolean {
  const deadline = turn.startedAtMs + DEFAULT_LIMITS.maxWallTimeMs;
  return (
    isCurrentAcceptedMessage(deps, turn) &&
    Number.isSafeInteger(turn.startedAtMs) &&
    Number.isSafeInteger(turn.nowMs) &&
    Number.isFinite(new Date(deadline).getTime()) &&
    turn.startedAtMs >= 0 &&
    turn.nowMs >= turn.startedAtMs &&
    turn.nowMs < deadline
  );
}

/** Normal turn settlement does not revoke this issuer; expiry/lifecycle retain that ownership. */
export function mintAcceptedJiraChatAuthority(
  deps: JiraChatAuthorityDeps,
  turn: AcceptedJiraChatTurn,
): AcceptedJiraChatAuthority {
  const facts = currentFacts(deps, turn.chatId);
  const registry = deps.agentAuthorityRegistry;
  if (!facts.ok || registry === undefined || !validAcceptedTurn(deps, turn))
    return recordChatAuthorityResult(
      "register",
      { ok: false, reason: "invalid" },
      { chatId: turn.chatId },
      turn.correlationId,
    );
  const ceiling = deps.autonomousDeliveryDeploymentCeiling ?? "governed-assist";
  const envelope = acceptedTurnEnvelope(facts, turn, ceiling);
  const result = registry.registerChat(
    envelope,
    ceiling,
    new Date(turn.nowMs).toISOString(),
    turn.correlationId,
  );
  return result.ok ? { ok: true, envelope, reference: result.authorityRef } : result;
}

function currentFacts(
  deps: JiraChatAuthorityDeps,
  chatId: string,
): CurrentFacts | { readonly ok: false; readonly readiness: ChatAuthorityReadiness } {
  const chat = deps.store.findChatById(chatId);
  if (chat === undefined || chat.status === "closed")
    return { ok: false, readiness: "chat-unavailable" };
  const binding = chat.jiraPodBinding;
  if (binding === undefined) return { ok: false, readiness: "not-bound" };
  const credential = findOwnedJiraPod(deps, binding.podId);
  if (credential === undefined) return { ok: false, readiness: "pod-unavailable" };
  if (!isReadyJiraPod(credential)) return { ok: false, readiness: "verification-required" };
  if (
    credential.generation !== binding.authenticationGeneration ||
    chat.jiraBindingGeneration !== binding.bindingGeneration
  )
    return { ok: false, readiness: "generation-changed" };
  return {
    ok: true,
    chat,
    credential,
    subject: {
      actorDigest: credential.livePod.ownerDigest,
      chatId: chat.id,
      podId: binding.podId,
      bindingGeneration: binding.bindingGeneration,
      authenticationGeneration: binding.authenticationGeneration,
    },
  };
}

/** Private current-state resolution only. Consent, action approval and reservation are separate gates. */
export function resolveCurrentJiraChatAuthority(
  deps: JiraChatAuthorityDeps,
  chatId: string,
  reference: EditorAgentGovernedAuthorityReference,
  nowIso: string,
  correlationId: string,
): CurrentJiraChatAuthority {
  const facts = currentFacts(deps, chatId);
  const evidence = { chatId, authorityDigest: reference.envelopeDigest };
  if (!facts.ok || deps.agentAuthorityRegistry === undefined)
    return recordChatAuthorityResult(
      "current-state",
      { ok: false, reason: "invalid" },
      { ...evidence, readiness: facts.ok ? "authority-unavailable" : facts.readiness },
      correlationId,
    );
  const resolution = deps.agentAuthorityRegistry.resolveChat(
    reference,
    facts.subject,
    deps.autonomousDeliveryDeploymentCeiling ?? "governed-assist",
    nowIso,
    correlationId,
  );
  if (!resolution.ok)
    return recordChatAuthorityResult(
      "current-state",
      resolution,
      { ...evidence, subject: facts.subject, readiness: "authority-denied" },
      correlationId,
    );
  if (resolution.envelope.requestedMode !== (facts.chat.toolMode ?? "governed-assist")) {
    return recordChatAuthorityResult(
      "current-state",
      { ok: false, reason: "invalid" },
      { ...evidence, subject: facts.subject, readiness: "mode-changed" },
      correlationId,
    );
  }
  return recordChatAuthorityResult(
    "current-state",
    { ok: true, envelope: resolution.envelope, credential: facts.credential },
    { ...evidence, subject: facts.subject, readiness: "ready" },
    correlationId,
  );
}

/** Read consent and concrete action approval remain independent admission requirements. */
export function decideGovernedJiraChatAction(
  actionType: AtlassianConnectorActionType,
  deps: JiraChatAuthorityDeps,
  chatId: string,
  reference: EditorAgentGovernedAuthorityReference,
  nowIso: string,
  correlationId: string,
): AtlassianGovernedActionOutcome {
  const current = resolveCurrentJiraChatAuthority(deps, chatId, reference, nowIso, correlationId);
  if (!current.ok)
    return { kind: "authority-denied", reason: ATLASSIAN_AUTHORITY_FAILURE_REASON[current.reason] };
  const outcome = decideAtlassianEnvelopeAction(actionType, current.envelope);
  recordChatAuthorityResult(
    "action-policy",
    outcome.kind === "allowed" ? { ok: true } : { ok: false, reason: outcome.kind },
    { actionType, authorityDigest: reference.envelopeDigest, subject: current.envelope.subject },
    correlationId,
  );
  return outcome;
}

/** Reserve only after tool admission, consent and action approval; this never dispatches an effect. */
export function reserveCurrentJiraChatAuthority(
  deps: JiraChatAuthorityDeps,
  chatId: string,
  reference: EditorAgentGovernedAuthorityReference,
  usage: CodingWorkbenchRuntimeDelegationUsage,
  nowIso: string,
  correlationId: string,
): CurrentJiraChatAuthority {
  const current = resolveCurrentJiraChatAuthority(deps, chatId, reference, nowIso, correlationId);
  if (!current.ok) return current;
  const reservation = deps.agentAuthorityRegistry?.reserveForChat(
    reference,
    current.envelope.subject,
    deps.autonomousDeliveryDeploymentCeiling ?? "governed-assist",
    usage,
    nowIso,
    correlationId,
  );
  if (reservation === undefined)
    return recordChatAuthorityResult(
      "reserve",
      { ok: false, reason: "invalid" },
      { chatId, authorityDigest: reference.envelopeDigest },
      correlationId,
    );
  return reservation.ok ? current : reservation;
}

export function isCurrentJiraChatReadGrant(
  deps: JiraChatAuthorityDeps,
  entry: ChatReadGrantEntry,
  nowIso: string,
  correlationId: string,
): boolean {
  const current = resolveCurrentJiraChatAuthority(
    deps,
    entry.grant.subject.chatId,
    entry.authority,
    nowIso,
    correlationId,
  );
  const now = Date.parse(nowIso);
  return (
    current.ok &&
    entry.grant.requestedAt <= now &&
    entry.grant.expiresAt > now &&
    sameReadGrantSubject(entry.grant, current.envelope.subject) &&
    current.envelope.connectorScopes.includes("issue-tracker.read") &&
    entry.grant.expiresAt <= Date.parse(current.envelope.expiresAt)
  );
}

type ReadAdmissionDenial = "authority-denied" | "unavailable" | "rejected" | "capacity-exhausted";
export type JiraChatReadGrantAdmission =
  | { readonly kind: "granted" | "review-required"; readonly grant: ChatToolReadGrantView }
  | { readonly kind: "denied"; readonly reason: ReadAdmissionDenial };

function readAdmissionDenied(
  reason: ReadAdmissionDenial,
  chatId: string,
  correlationId: string,
): JiraChatReadGrantAdmission {
  recordChatAuthorityResult(
    "read-grant",
    { ok: false, reason: "invalid" },
    { chatId },
    correlationId,
  );
  return { kind: "denied", reason };
}

function pendingChatReadGrant(
  envelope: ChatToolAuthorityEnvelope,
  nowIso: string,
): ChatToolReadGrant {
  const now = Date.parse(nowIso);
  return {
    schemaVersion: "1",
    kind: "jira-chat-read-grant",
    grantId: randomUUID(),
    subject: envelope.subject,
    disclosureVersion: CHAT_TOOL_READ_DISCLOSURE_VERSION,
    requestedAt: now,
    expiresAt: Math.min(Date.parse(envelope.expiresAt), now + ATLASSIAN_ACTION_APPROVAL_TTL_MS),
    state: "pending",
    consentProofDigest: null,
  };
}

function reuseChatReadGrant(
  deps: JiraChatAuthorityDeps,
  registry: AtlassianActionApprovalRegistry,
  subject: ChatToolAuthoritySubject,
  authority: EditorAgentGovernedAuthorityReference,
  nowIso: string,
  correlationId: string,
): JiraChatReadGrantAdmission | undefined {
  for (let attempt = 0; attempt < ATLASSIAN_ACTION_APPROVAL_MAX_PENDING; attempt++) {
    const entry = registry.findChatReadGrantForRequest(subject, authority, correlationId);
    if (entry === undefined) break;
    if (entry.grant.state !== "pending" && entry.grant.state !== "granted")
      return readAdmissionDenied("rejected", subject.chatId, correlationId);
    if (isCurrentJiraChatReadGrant(deps, entry, nowIso, correlationId))
      return {
        kind: entry.grant.state === "granted" ? "granted" : "review-required",
        grant: projectChatReadGrant(entry.grant),
      };
    registry.revokeChatReadGrant(entry.grant.grantId, correlationId);
  }
  return undefined;
}

/** Request/reuse consent only; callers still admit the tool, reserve its budget and dispatch it. */
export function requestJiraChatReadGrant(
  deps: JiraChatAuthorityDeps & Pick<UiHandlerDeps, "atlassianActionApprovalRegistry">,
  chatId: string,
  authority: EditorAgentGovernedAuthorityReference,
  nowIso: string,
  correlationId: string,
): JiraChatReadGrantAdmission {
  const current = resolveCurrentJiraChatAuthority(deps, chatId, authority, nowIso, correlationId);
  if (!current.ok || !current.envelope.connectorScopes.includes("issue-tracker.read"))
    return readAdmissionDenied("authority-denied", chatId, correlationId);
  const registry = deps.atlassianActionApprovalRegistry;
  if (registry === undefined) return readAdmissionDenied("unavailable", chatId, correlationId);
  const existing = reuseChatReadGrant(
    deps,
    registry,
    current.envelope.subject,
    authority,
    nowIso,
    correlationId,
  );
  if (existing !== undefined) return existing;
  const grant = pendingChatReadGrant(current.envelope, nowIso);
  const created = registry.createChatReadGrant({ grant, authority }, correlationId);
  if (!created.ok) {
    const reason = created.reason === "capacity-exhausted" ? "capacity-exhausted" : "unavailable";
    return readAdmissionDenied(reason, chatId, correlationId);
  }
  return { kind: "review-required", grant: projectChatReadGrant(grant) };
}
