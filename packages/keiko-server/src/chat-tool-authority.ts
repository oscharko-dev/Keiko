import type {
  ChatToolAuthorityEnvelope,
  CodingWorkbenchRuntimeDelegationUsage,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import type { AcceptedJiraChatTurn } from "./atlassian/jiraChatAuthority.js";
import type { UiHandlerDeps } from "./deps.js";
import type { ChatToolAuthorityResolution } from "./editor/agentAuthorityRegistry.js";
import { chatToolTurnBudget } from "./chat-tool-turn-budget.js";

type AuthorityFailure = Extract<ChatToolAuthorityResolution, { readonly ok: false }>;
type CurrentChatToolAuthority<Envelope extends ChatToolAuthorityEnvelope> =
  { readonly ok: true; readonly envelope: Envelope } | AuthorityFailure;
const INVALID = { ok: false, reason: "invalid" } as const;

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

/** Reserve only after the source adapter resolved its current subject, scope, mode and ceiling. */
export function reserveResolvedChatToolAuthority<Envelope extends ChatToolAuthorityEnvelope>(
  deps: Pick<UiHandlerDeps, "agentAuthorityRegistry">,
  current: CurrentChatToolAuthority<Envelope>,
  reference: EditorAgentGovernedAuthorityReference,
  usage: CodingWorkbenchRuntimeDelegationUsage,
  nowIso: string,
  correlationId: string,
): CurrentChatToolAuthority<Envelope> {
  if (!current.ok) return current;
  const reserved = deps.agentAuthorityRegistry?.reserveForChat(
    reference,
    current.envelope.subject,
    current.envelope.deploymentCeiling,
    usage,
    nowIso,
    correlationId,
  );
  return reserved?.ok === true ? current : (reserved ?? INVALID);
}
