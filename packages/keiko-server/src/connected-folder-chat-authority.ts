import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { ConnectedFolderChatToolAuthoritySubject } from "@oscharko-dev/keiko-contracts";
import type { Chat, ChatConnectedScope } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { AcceptedJiraChatTurn } from "./atlassian/jiraChatAuthority.js";
import {
  createLocalChatSourceAuthority,
  type CurrentLocalChatSourceAuthority,
  type LocalChatSourceAuthorityDeps,
  type MintedLocalChatSourceAuthority,
} from "./local-chat-source-authority.js";
import { chatKnowledgeScopes } from "./requirement-inventory.js";
import { deriveChatGroundingScopeIdentity } from "./store/chat-grounding-scope-identity.js";

export type CurrentConnectedFolderChatAuthority = CurrentLocalChatSourceAuthority<
  ConnectedFolderChatToolAuthoritySubject,
  "folder.read"
>;
export type MintedConnectedFolderChatAuthority = MintedLocalChatSourceAuthority<
  ConnectedFolderChatToolAuthoritySubject,
  "folder.read"
>;

type FolderOnlyChat = Pick<
  Chat,
  | "connectedScope"
  | "connectedScopes"
  | "localKnowledgeScope"
  | "localKnowledgeScopes"
  | "gitChangeScopes"
  | "jiraPodBinding"
>;

/**
 * The one folder scope of a Chat that is connected to exactly one folder and to nothing else: no
 * Jira Pod, no Knowledge scope, no Git change. Every other composition has no folder tool.
 */
export function soleConnectedFolderScope(
  chat: FolderOnlyChat | undefined,
): ChatConnectedScope | undefined {
  if (chat === undefined || chat.jiraPodBinding !== undefined) return undefined;
  if (chatKnowledgeScopes(chat).length > 0 || (chat.gitChangeScopes ?? []).length > 0)
    return undefined;
  const scopes =
    chat.connectedScopes ?? (chat.connectedScope === undefined ? [] : [chat.connectedScope]);
  return scopes.length === 1 ? scopes[0] : undefined;
}

/**
 * Bound to the Chat's current server-issued grounding scope identity, which covers the folder root,
 * its selected paths and every other source of the Chat: any change of it ends the authority.
 */
const CONNECTED_FOLDER_AUTHORITY = createLocalChatSourceAuthority<
  ConnectedFolderChatToolAuthoritySubject,
  "folder.read"
>({
  kind: "connected-folder",
  scope: "folder.read",
  configurationDigest: (chat) =>
    soleConnectedFolderScope(chat) === undefined
      ? undefined
      : sha256Hex(canonicalise({ groundingScopeIdentity: deriveChatGroundingScopeIdentity(chat) })),
  subject: (facts) => ({ kind: "connected-folder", ...facts }),
});

export function mintAcceptedConnectedFolderChatAuthority(
  deps: LocalChatSourceAuthorityDeps,
  turn: AcceptedJiraChatTurn,
): MintedConnectedFolderChatAuthority {
  return CONNECTED_FOLDER_AUTHORITY.mint(deps, turn);
}

/** The shared local-source checks, bound to the connected folder: the parameters are theirs. */
export const resolveCurrentConnectedFolderChatAuthority = CONNECTED_FOLDER_AUTHORITY.resolve;
export const reserveCurrentConnectedFolderChatAuthority = CONNECTED_FOLDER_AUTHORITY.reserve;
