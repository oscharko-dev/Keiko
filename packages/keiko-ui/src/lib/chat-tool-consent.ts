import type { Chat, ChatMessage } from "@oscharko-dev/keiko-contracts/bff-wire";
import { ApiError, fetchChatMessages } from "./api";
import { chatToolReadGrants } from "./chat-tool-events";
import { clientErrorEvidence } from "./client-error-evidence";
import { reportClientDiagnostic } from "./client-diagnostics";
import { bffRequestErrorKind } from "./http";
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
  const transcript = message?.toolTranscript;
  if (message === undefined || transcript === undefined) return undefined;
  const grants = chatToolReadGrants(transcript);
  if (grants.some((grant) => grant.chatId !== chatId)) return undefined;
  if (
    transcript.exchanges.some(
      (entry) => entry.approval !== undefined && entry.approval.chatId !== chatId,
    )
  )
    return undefined;
  return {
    message,
    identity: JSON.stringify([
      message.id,
      message.turnState,
      grants.map((grant) => [grant.kind, grant.grantId, grant.state]),
      transcript.exchanges.map((entry) => [
        entry.call.id,
        entry.approval?.approvalId,
        entry.approval?.state,
        entry.mutationOutcome,
        entry.result?.status,
        entry.result?.reason,
      ]),
    ]),
  };
}
/** Only observes the accepted canonical row; a GET never grants consent or resumes execution. */
export function watchChatToolConsent(
  chat: BoundChat,
  projectPath: string,
  resolveReference: (() => Promise<string>) | undefined,
  signal: AbortSignal,
  publish: (message: ChatMessage) => void,
): () => void {
  if (resolveReference === undefined) return (): void => undefined;
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
    } catch (error) {
      if (!combined.aborted)
        reportClientDiagnostic("Chat tool consent observation failed.", {
          kind: "other",
          correlationId: error instanceof ApiError ? error.correlationId : undefined,
          errorKind: bffRequestErrorKind(error),
          errorEvidence: clientErrorEvidence(error),
        });
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
