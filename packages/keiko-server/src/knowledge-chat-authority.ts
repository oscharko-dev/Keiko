import {
  acceptedChatToolAuthorityEnvelope,
  isAcceptedChatToolTurn,
  isRequestedChatToolModeCurrent,
  reserveResolvedChatToolAuthority,
} from "./chat-tool-authority.js";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { CHAT_TOOL_DEFAULT_MODE } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type {
  ChatToolAuthorityEnvelope,
  KnowledgeChatToolAuthoritySubject,
  CodingWorkbenchRuntimeDelegationUsage,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import type { AcceptedJiraChatTurn } from "./atlassian/jiraChatAuthority.js";
import { jiraChatActorDigest } from "./atlassian/jiraPodAccess.js";
import { recordChatAuthorityResult } from "./editor/chatAuthorityActivity.js";
import { chatToolTurnBudget } from "./chat-tool-turn-budget.js";
import { chatKnowledgeScopes } from "./requirement-inventory.js";

export type KnowledgeChatAuthorityDeps = Pick<
  UiHandlerDeps,
  | "store"
  | "serverPrincipal"
  | "agentAuthorityRegistry"
  | "autonomousDeliveryDeploymentCeiling"
  | "chatToolTurnBudget"
>;
export type KnowledgeChatAuthorityEnvelope = ChatToolAuthorityEnvelope & {
  readonly subject: KnowledgeChatToolAuthoritySubject;
  readonly connectorScopes: readonly ["knowledge.read"];
};
export function isKnowledgeChatAuthorityEnvelope(
  envelope: ChatToolAuthorityEnvelope,
): envelope is KnowledgeChatAuthorityEnvelope {
  return (
    envelope.subject.kind === "knowledge-pods" &&
    envelope.connectorScopes.length === 1 &&
    envelope.connectorScopes[0] === "knowledge.read"
  );
}
interface Failure {
  readonly ok: false;
  readonly reason: "invalid" | "expired" | "budget-exceeded" | "revoked";
}
export type CurrentKnowledgeChatAuthority =
  { readonly ok: true; readonly envelope: KnowledgeChatAuthorityEnvelope } | Failure;
const INVALID = { ok: false, reason: "invalid" } as const;

/** Selection is server-owned; a changed scope can never reuse a turn's retained authority. */
function currentSubject(
  deps: KnowledgeChatAuthorityDeps,
  chatId: string,
): KnowledgeChatToolAuthoritySubject | undefined {
  const chat = deps.store.findChatById(chatId);
  const actorDigest = jiraChatActorDigest(deps);
  const scopes = chatKnowledgeScopes(chat);
  if (
    chat === undefined ||
    chat.status === "closed" ||
    actorDigest === undefined ||
    scopes.length === 0
  )
    return undefined;
  return {
    kind: "knowledge-pods",
    actorDigest,
    chatId,
    configurationDigest: sha256Hex(canonicalise(scopes)),
  };
}

export function prepareAcceptedKnowledgeChatAuthority(
  deps: KnowledgeChatAuthorityDeps,
  turn: AcceptedJiraChatTurn,
): CurrentKnowledgeChatAuthority {
  const subject = currentSubject(deps, turn.chatId);
  if (
    subject === undefined ||
    deps.agentAuthorityRegistry === undefined ||
    !isAcceptedChatToolTurn(deps, turn)
  )
    return recordChatAuthorityResult(
      "register",
      INVALID,
      { chatId: turn.chatId },
      turn.correlationId,
    );
  const requestedMode = deps.store.findChatById(turn.chatId)?.toolMode ?? CHAT_TOOL_DEFAULT_MODE;
  const deploymentCeiling = deps.autonomousDeliveryDeploymentCeiling ?? "governed-assist";
  return {
    ok: true,
    envelope: acceptedChatToolAuthorityEnvelope(
      turn,
      subject,
      requestedMode,
      deploymentCeiling,
      chatToolTurnBudget(deps),
      ["knowledge.read"],
    ),
  };
}

export function mintAcceptedKnowledgeChatAuthority(
  deps: KnowledgeChatAuthorityDeps,
  turn: AcceptedJiraChatTurn,
):
  | {
      readonly ok: true;
      readonly envelope: KnowledgeChatAuthorityEnvelope;
      readonly reference: EditorAgentGovernedAuthorityReference;
    }
  | Failure {
  const prepared = prepareAcceptedKnowledgeChatAuthority(deps, turn);
  if (!prepared.ok) return prepared;
  const result = deps.agentAuthorityRegistry?.registerChat(
    prepared.envelope,
    prepared.envelope.deploymentCeiling,
    new Date(turn.nowMs).toISOString(),
    turn.correlationId,
  );
  return result?.ok === true
    ? { ...prepared, reference: result.authorityRef }
    : (result ?? INVALID);
}
export function resolveCurrentKnowledgeChatAuthority(
  deps: KnowledgeChatAuthorityDeps,
  chatId: string,
  reference: EditorAgentGovernedAuthorityReference,
  nowIso: string,
  correlationId: string,
): CurrentKnowledgeChatAuthority {
  const subject = currentSubject(deps, chatId);
  if (subject === undefined || deps.agentAuthorityRegistry === undefined)
    return recordChatAuthorityResult(
      "current-state",
      INVALID,
      { chatId, authorityDigest: reference.envelopeDigest },
      correlationId,
    );
  const current = deps.agentAuthorityRegistry.resolveChat(
    reference,
    subject,
    deps.autonomousDeliveryDeploymentCeiling ?? "governed-assist",
    nowIso,
    correlationId,
  );
  if (!current.ok) return current;
  if (
    !isKnowledgeChatAuthorityEnvelope(current.envelope) ||
    !isRequestedChatToolModeCurrent(current.envelope, deps.store.findChatById(chatId))
  )
    return recordChatAuthorityResult(
      "current-state",
      INVALID,
      { subject, readiness: "mode-changed" },
      correlationId,
    );
  return recordChatAuthorityResult(
    "current-state",
    {
      ok: true,
      envelope: {
        ...current.envelope,
        subject: current.envelope.subject,
        connectorScopes: ["knowledge.read"],
      },
    },
    { subject, readiness: "ready" },
    correlationId,
  );
}
export function reserveCurrentKnowledgeChatAuthority(
  deps: KnowledgeChatAuthorityDeps,
  chatId: string,
  reference: EditorAgentGovernedAuthorityReference,
  usage: CodingWorkbenchRuntimeDelegationUsage,
  nowIso: string,
  correlationId: string,
): CurrentKnowledgeChatAuthority {
  const current = resolveCurrentKnowledgeChatAuthority(
    deps,
    chatId,
    reference,
    nowIso,
    correlationId,
  );
  return (
    reserveResolvedChatToolAuthority(
      deps,
      current,
      reference,
      usage,
      nowIso,
      correlationId,
      deps.autonomousDeliveryDeploymentCeiling ?? "governed-assist",
    ) ?? INVALID
  );
}
