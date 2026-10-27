import { randomUUID } from "node:crypto";
import type { UiStore } from "../store/index.js";
import { interruptChangedChatGenerations } from "../chat-turn-serializer.js";

/** Shared by credential management and Live Pod management through the custody owner. */
export function invalidateJiraPodChats(
  store: UiStore,
  podId: string,
  authenticationGeneration: number | null,
  correlationId: string = randomUUID(),
): void {
  for (const change of store.invalidateJiraPod(podId, authenticationGeneration, correlationId))
    interruptChangedChatGenerations({ store }, change.previous, change.current, correlationId);
}
