import {
  CHAT_TURN_WAIT_CANCELLED,
  interruptChatGenerations,
  runSerializedChatTurn,
} from "../../../packages/keiko-server/dist/chat-turn-serializer.js";

/** The existing serializer owns underlying work after the HTTP caller has cancelled. */
export async function drainLiveChatTurns(deps, projectPath, timeoutMs = 15_000) {
  const chats = deps.store.listChats(projectPath);
  const controller = new globalThis.AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (const chat of chats) interruptChatGenerations(deps, chat.id);
    const results = await Promise.all(
      chats.map((chat) => runSerializedChatTurn(deps, chat.id, controller.signal, () => undefined)),
    );
    if (results.some((result) => result === CHAT_TURN_WAIT_CANCELLED))
      throw new TypeError(
        "Laboratory Chat work did not drain; preserve the open store and retained state",
      );
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
