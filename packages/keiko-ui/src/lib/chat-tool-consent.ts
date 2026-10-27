import type { Chat, ChatMessage } from "@oscharko-dev/keiko-contracts/bff-wire";
import { fetchChatMessages } from "./api";
type BoundChat = Pick<Chat, "id" | "jiraPodBinding">;
async function readConsent(
  chatId: string,
  projectPath: string,
  reference: string,
  signal: AbortSignal,
): Promise<{ message: ChatMessage; identity: string } | undefined> {
  const response = await fetchChatMessages(chatId, projectPath, signal);
  const message = response.messages.find(
    (entry) =>
      entry.role === "user" && entry.chatId === chatId && entry.canonicalTurnRef === reference,
  );
  const grant = message?.toolTranscript?.readGrant;
  if (message === undefined || grant === undefined || grant.chatId !== chatId) return undefined;
  return { message, identity: `${message.id}:${grant.grantId}:${grant.state}` };
}
/** Only observes the accepted canonical row; a GET never grants consent or resumes execution. */
export function watchChatToolConsent(
  chat: BoundChat,
  projectPath: string,
  resolveReference: (() => Promise<string>) | undefined,
  signal: AbortSignal,
  publish: (message: ChatMessage) => void,
): () => void {
  if (chat.jiraPodBinding === undefined || resolveReference === undefined)
    return (): void => undefined;
  const stop = new AbortController();
  const combined = AbortSignal.any([signal, stop.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous: string | undefined;
  let reference: string | undefined;
  const poll = async (): Promise<void> => {
    if (combined.aborted) return;
    try {
      reference ??= await resolveReference();
      const observed = await readConsent(chat.id, projectPath, reference, combined);
      if (observed !== undefined && !combined.aborted && observed.identity !== previous) {
        previous = observed.identity;
        publish(observed.message);
      }
    } catch {
      // The shared BFF client records failed reads. Only GET is retried, never the turn POST.
    } finally {
      if (!combined.aborted)
        timer = setTimeout(() => {
          void poll();
        }, 1000);
    }
  };
  timer = setTimeout(() => {
    void poll();
  }, 500);
  return (): void => {
    stop.abort();
    clearTimeout(timer);
  };
}
