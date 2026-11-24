import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type {
  ChatToolAuthorityEnvelope,
  KnowledgeChatToolAuthoritySubject,
  CodingWorkbenchRuntimeDelegationUsage,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import type { AcceptedJiraChatTurn } from "./atlassian/jiraChatAuthority.js";
import {
  createLocalChatSourceAuthority,
  type CurrentLocalChatSourceAuthority,
  type LocalChatSourceAuthorityDeps,
  type LocalChatSourceEnvelope,
  type MintedLocalChatSourceAuthority,
} from "./local-chat-source-authority.js";
import { chatKnowledgeScopes } from "./requirement-inventory.js";

export type KnowledgeChatAuthorityDeps = LocalChatSourceAuthorityDeps;
export type KnowledgeChatAuthorityEnvelope = LocalChatSourceEnvelope<
  KnowledgeChatToolAuthoritySubject,
  "knowledge.read"
>;
export type CurrentKnowledgeChatAuthority = CurrentLocalChatSourceAuthority<
  KnowledgeChatToolAuthoritySubject,
  "knowledge.read"
>;

/** Local Knowledge selection: the digest of the Chat's selected Pods and Pod sets. */
const KNOWLEDGE_AUTHORITY = createLocalChatSourceAuthority<
  KnowledgeChatToolAuthoritySubject,
  "knowledge.read"
>({
  kind: "knowledge-pods",
  scope: "knowledge.read",
  configurationDigest: (chat) => {
    const scopes = chatKnowledgeScopes(chat);
    return scopes.length === 0 ? undefined : sha256Hex(canonicalise(scopes));
  },
  subject: (facts) => ({ kind: "knowledge-pods", ...facts }),
});

export function isKnowledgeChatAuthorityEnvelope(
  envelope: ChatToolAuthorityEnvelope,
): envelope is KnowledgeChatAuthorityEnvelope {
  return KNOWLEDGE_AUTHORITY.isEnvelope(envelope);
}

export function prepareAcceptedKnowledgeChatAuthority(
  deps: KnowledgeChatAuthorityDeps,
  turn: AcceptedJiraChatTurn,
): CurrentKnowledgeChatAuthority {
  return KNOWLEDGE_AUTHORITY.prepare(deps, turn);
}

export function mintAcceptedKnowledgeChatAuthority(
  deps: KnowledgeChatAuthorityDeps,
  turn: AcceptedJiraChatTurn,
): MintedLocalChatSourceAuthority<KnowledgeChatToolAuthoritySubject, "knowledge.read"> {
  return KNOWLEDGE_AUTHORITY.mint(deps, turn);
}

export function resolveCurrentKnowledgeChatAuthority(
  deps: KnowledgeChatAuthorityDeps,
  chatId: string,
  reference: EditorAgentGovernedAuthorityReference,
  nowIso: string,
  correlationId: string,
): CurrentKnowledgeChatAuthority {
  return KNOWLEDGE_AUTHORITY.resolve(deps, chatId, reference, nowIso, correlationId);
}

export function reserveCurrentKnowledgeChatAuthority(
  deps: KnowledgeChatAuthorityDeps,
  chatId: string,
  reference: EditorAgentGovernedAuthorityReference,
  usage: CodingWorkbenchRuntimeDelegationUsage,
  nowIso: string,
  correlationId: string,
): CurrentKnowledgeChatAuthority {
  return KNOWLEDGE_AUTHORITY.reserve(deps, chatId, reference, usage, nowIso, correlationId);
}
