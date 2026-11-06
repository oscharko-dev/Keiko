import type {
  ChatToolAuthorityEnvelope,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeDelegationUsage,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  CHAT_TOOL_DEFAULT_MODE,
  resolveEffectiveCodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type { AcceptedJiraChatTurn } from "./atlassian/jiraChatAuthority.js";
import type { UiHandlerDeps } from "./deps.js";
import type { ChatToolAuthorityResolution } from "./editor/agentAuthorityRegistry.js";
import { chatToolTurnBudget } from "./chat-tool-turn-budget.js";
import type { ToolConsumerContext } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";

type AuthorityFailure = Extract<ChatToolAuthorityResolution, { readonly ok: false }>;
type CurrentChatToolAuthority =
  { readonly ok: true; readonly envelope: ChatToolAuthorityEnvelope } | AuthorityFailure;

function validChatTurnLifetime(
  deps: Pick<UiHandlerDeps, "chatToolTurnBudget">,
  turn: AcceptedJiraChatTurn,
): boolean {
  const deadline = turn.startedAtMs + chatToolTurnBudget(deps).maxRuntimeMs;
  return (
    Number.isSafeInteger(turn.startedAtMs) &&
    Number.isSafeInteger(turn.nowMs) &&
    Number.isFinite(new Date(deadline).getTime()) &&
    turn.startedAtMs >= 0 &&
    turn.nowMs >= turn.startedAtMs &&
    turn.nowMs < deadline
  );
}

/** The latest accepted human message and its original bounded lifetime, shared by source adapters. */
export function isAcceptedChatToolTurn(
  deps: Pick<UiHandlerDeps, "store" | "chatToolTurnBudget">,
  turn: AcceptedJiraChatTurn,
): boolean {
  const message = deps.store.findMessageById(turn.userMessageId);
  return (
    validChatTurnLifetime(deps, turn) &&
    message?.role === "user" &&
    message.chatId === turn.chatId &&
    message.timestamp === turn.startedAtMs &&
    (message.turnState === undefined || message.turnState === "pending") &&
    deps.store.listMessages(turn.chatId, 1).at(-1)?.id === message.id
  );
}

/** Construct only after accepted-turn and source admission; domain adapters own their scope. */
export function acceptedChatToolAuthorityEnvelope<
  Subject extends ChatToolAuthorityEnvelope["subject"],
  const Scopes extends ChatToolAuthorityEnvelope["connectorScopes"],
>(
  turn: AcceptedJiraChatTurn,
  subject: Subject,
  requestedMode: CodingWorkbenchMode,
  deploymentCeiling: CodingWorkbenchMode,
  budget: ChatToolAuthorityEnvelope["budget"],
  connectorScopes: Scopes,
): ChatToolAuthorityEnvelope & { readonly subject: Subject; readonly connectorScopes: Scopes } {
  const runId = `chat-${sha256Hex(canonicalise({ chatId: turn.chatId, userMessageId: turn.userMessageId }))}`;
  return {
    schemaVersion: "1",
    kind: "chat-tool-authority",
    runId,
    subject,
    requestedMode,
    deploymentCeiling,
    effectiveMode: resolveEffectiveCodingWorkbenchMode(requestedMode, deploymentCeiling),
    actionClasses:
      "kind" in subject && subject.kind === "knowledge-pods"
        ? ["connector-access"]
        : ["connector-access", "network-egress"],
    connectorScopes,
    budget,
    expiresAt: new Date(turn.startedAtMs + budget.maxRuntimeMs).toISOString(),
    approvalProofDigest: sha256Hex(
      canonicalise({
        runId,
        subject,
        requestedMode,
        deploymentCeiling,
        userMessageId: turn.userMessageId,
        acceptedAtMs: turn.startedAtMs,
      }),
    ),
  };
}

/** A retained capability belongs to this exact active Chat authority. */
export function chatCapabilityMatches(
  context: Pick<ToolConsumerContext, "authority" | "signal"> & {
    readonly authorityReference: EditorAgentGovernedAuthorityReference;
  },
  capability: string | undefined,
): boolean {
  return (
    !context.signal.aborted &&
    capability === context.authority &&
    capability === context.authorityReference.envelopeDigest
  );
}

export function isRequestedChatToolModeCurrent(
  envelope: Pick<ChatToolAuthorityEnvelope, "requestedMode">,
  chat: { readonly toolMode?: CodingWorkbenchMode | undefined } | undefined,
): boolean {
  return envelope.requestedMode === (chat?.toolMode ?? CHAT_TOOL_DEFAULT_MODE);
}

/** Reserve only after the source adapter resolved its current subject, scope, mode and ceiling. */
export function reserveResolvedChatToolAuthority<Current extends CurrentChatToolAuthority>(
  deps: Pick<UiHandlerDeps, "agentAuthorityRegistry">,
  current: Current,
  reference: EditorAgentGovernedAuthorityReference,
  usage: CodingWorkbenchRuntimeDelegationUsage,
  nowIso: string,
  correlationId: string,
  deploymentCeiling: CodingWorkbenchMode,
): Current | AuthorityFailure | undefined {
  if (!current.ok) return current;
  const reserved = deps.agentAuthorityRegistry?.reserveForChat(
    reference,
    current.envelope.subject,
    deploymentCeiling,
    usage,
    nowIso,
    correlationId,
  );
  return reserved?.ok === true ? current : reserved;
}
