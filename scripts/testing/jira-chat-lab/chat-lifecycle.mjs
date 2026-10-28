import {
  CHAT_TURN_WAIT_CANCELLED,
  interruptChatGenerations,
  runSerializedChatTurn,
} from "../../../packages/keiko-server/dist/chat-turn-serializer.js";

/** Report only known harness source coordinates; failed intents always remain private. */
export function reportFaultQualificationFailure(qualification, error) {
  const location =
    error instanceof Error
      ? (error.stack?.match(
          /(?:restricted-(?:chat|cases|catalog-cases)|browser-(?:faults|write|connections|lifecycle|disconnect|response-drop|recovery)|chat-(?:faults|fault-transport|read|write|lifecycle)|consent-lifecycle|pagination-chat|private-json)\.mjs:\d+:\d+/gu,
        ) ?? [])
      : [];
  console.error(JSON.stringify({ qualification, passed: false, location }));
  console.error(
    "Incomplete group retained privately. Reconcile read-only; never replay a pending mutation.",
  );
  process.exitCode = 1;
}

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
