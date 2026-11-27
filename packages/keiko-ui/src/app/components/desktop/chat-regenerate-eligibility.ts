import type { ChatMessage } from "@/lib/types";

/**
 * The assistant answer Regenerate may be offered on: the last question-or-answer message of the
 * conversation, and only when it is an answer. This is the server's own rule
 * (`latestRegenerableTurn`), so an answer followed by a newer question (for example one the
 * person stopped) never shows a control the server refuses. Run summaries and other system
 * messages do not count, as on the server.
 */
export function latestRegenerableAssistantId(messages: readonly ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message.id;
    if (message?.role === "user") return undefined;
  }
  return undefined;
}
