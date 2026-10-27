import {
  ATLASSIAN_AUTHORITY_FAILURE_REASON,
  decideAtlassianEnvelopeAction,
  type AtlassianGovernedActionOutcome,
} from "./actionPolicy.js";
import type {
  ChatToolAuthorityEnvelope,
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
