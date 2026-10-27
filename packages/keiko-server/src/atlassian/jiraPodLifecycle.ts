import { randomUUID } from "node:crypto";
import type { UiStore } from "../store/index.js";
import { interruptChangedChatGenerations } from "../chat-turn-serializer.js";
import type { Chat } from "../store/index.js";
import type { UiHandlerDeps } from "../deps.js";
import type { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";

/** Shared by credential management and Live Pod management through the custody owner. */
export function invalidateJiraPodChats(
  store: UiStore,
  podId: string,
  authenticationGeneration: number | null,
  correlationId: string = randomUUID(),
  authorityRegistry?: EditorAgentAuthorityRegistry,
): void {
  for (const change of store.invalidateJiraPod(podId, authenticationGeneration, correlationId)) {
    authorityRegistry?.revokeChatAuthorities(change.current.id, correlationId);
    interruptChangedChatGenerations({ store }, change.previous, change.current, correlationId);
  }
}

/** Called after the committed update, never for an optimistic preview or rejected CAS. */
export function revokeChangedJiraChatAuthority(
  deps: Pick<UiHandlerDeps, "agentAuthorityRegistry">,
  previous: Chat,
  current: Chat,
  correlationId: string | undefined,
): void {
  if (
    previous.jiraBindingGeneration !== current.jiraBindingGeneration ||
    (previous.status !== "closed" && current.status === "closed")
  ) {
    deps.agentAuthorityRegistry?.revokeChatAuthorities(current.id, correlationId);
  }
}
