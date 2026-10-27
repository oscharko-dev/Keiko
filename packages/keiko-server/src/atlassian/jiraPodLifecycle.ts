import { randomUUID } from "node:crypto";
import type { UiStore } from "../store/index.js";
import { interruptChangedChatGenerations } from "../chat-turn-serializer.js";
import type { Chat } from "../store/index.js";
import type { UiHandlerDeps } from "../deps.js";
export type JiraChatAccessOwners = Pick<
  UiHandlerDeps,
  "agentAuthorityRegistry" | "atlassianActionApprovalRegistry"
>;

export function revokeJiraChatAccess(
  owners: JiraChatAccessOwners,
  chatId: string,
  correlationId?: string,
): void {
  owners.agentAuthorityRegistry?.revokeChatAuthorities(chatId, correlationId);
  owners.atlassianActionApprovalRegistry?.revokeChatApprovals(chatId, correlationId);
}

/** Shared by credential management and Live Pod management through the custody owner. */
export function invalidateJiraPodChats(
  store: UiStore,
  podId: string,
  authenticationGeneration: number | null,
  correlationId: string = randomUUID(),
  owners: JiraChatAccessOwners = {},
): void {
  for (const change of store.invalidateJiraPod(podId, authenticationGeneration, correlationId)) {
    revokeJiraChatAccess(owners, change.current.id, correlationId);
    interruptChangedChatGenerations({ store }, change.previous, change.current, correlationId);
  }
}

/** Called after the committed update, never for an optimistic preview or rejected CAS. */
export function revokeChangedJiraChatAuthority(
  deps: JiraChatAccessOwners,
  previous: Chat,
  current: Chat,
  correlationId: string | undefined,
): void {
  if (
    previous.jiraBindingGeneration !== current.jiraBindingGeneration ||
    (previous.status !== "closed" && current.status === "closed")
  ) {
    revokeJiraChatAccess(deps, current.id, correlationId);
  }
}
