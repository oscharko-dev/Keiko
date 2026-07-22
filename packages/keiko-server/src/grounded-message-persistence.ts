import type { UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/index.js";

// A grounded turn admits and persists its canonical user message before retrieval/model work. The
// optional row lets every grounded source path add only the assistant on success, while direct
// lower-level callers retain the atomic two-message insert used by their isolated tests.
export function persistGroundedExchange(
  deps: UiHandlerDeps,
  chatId: string,
  userContent: string,
  assistantContent: string,
  admittedUser?: ChatMessage,
): readonly [ChatMessage, ChatMessage] {
  const now = Date.now();
  const base = {
    chatId,
    timestamp: now,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  } as const;
  if (admittedUser !== undefined) {
    if (admittedUser.chatId !== chatId || admittedUser.role !== "user") {
      throw new Error("admitted grounded message does not match the user turn");
    }
    const assistant = deps.store.createTurnAssistant(admittedUser.id, {
      ...base,
      role: "assistant",
      content: assistantContent,
    });
    return [admittedUser, assistant];
  }
  const [user, assistant] = deps.store.createMessages([
    { ...base, role: "user", content: userContent },
    { ...base, role: "assistant", content: assistantContent },
  ]);
  if (user === undefined || assistant === undefined) {
    throw new Error("createMessages returned fewer rows than expected");
  }
  return [user, assistant];
}
