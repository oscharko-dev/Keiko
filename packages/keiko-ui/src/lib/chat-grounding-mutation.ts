import { ApiError, fetchChats, updateChat, type UpdateChatInput } from "./api";
import { newClientCorrelationId } from "./bff-correlation";
import { clientErrorEvidence } from "./client-error-evidence";
import { reportClientDiagnostic } from "./client-diagnostics";
import { bffRequestErrorKind } from "./http";
import type { Chat, ChatResponse } from "./types";

// A source conflict refreshes only this chat and never replays a stale replacement list.
// The original refusal stays visible so the user can review the canonical sources and retry.
export async function withGroundingScopeRefresh(
  chat: Chat,
  mutation: () => Promise<ChatResponse>,
  onChatChanged: ((chat: Chat) => void) | undefined,
): Promise<ChatResponse> {
  try {
    return await mutation();
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.code === "GROUNDING_SCOPE_CHANGED"
    ) {
      await refreshConflictedChat(
        chat,
        error.correlationId ?? newClientCorrelationId(),
        onChatChanged,
      );
    }
    throw error;
  }
}

async function refreshConflictedChat(
  chat: Chat,
  correlationId: string,
  onChatChanged: ((chat: Chat) => void) | undefined,
): Promise<void> {
  try {
    const response = await fetchChats(chat.projectPath, correlationId, chat.id);
    const current = response.chats.find(
      (candidate) => candidate.id === chat.id && candidate.projectPath === chat.projectPath,
    );
    if (current !== undefined) onChatChanged?.(current);
  } catch (error) {
    reportClientDiagnostic("Grounding scope conflict refresh failed.", {
      kind: "other",
      correlationId,
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
  }
}

export async function updateGroundingScopes(
  chat: Chat,
  patch: UpdateChatInput,
  onChatChanged: (chat: Chat) => void,
): Promise<Chat> {
  const response = await withGroundingScopeRefresh(
    chat,
    () =>
      updateChat(chat.id, {
        ...patch,
        ...(chat.groundingScopeIdentity === undefined
          ? {}
          : {
              expectedGroundingScopeIdentity: chat.groundingScopeIdentity,
            }),
      }),
    onChatChanged,
  );
  return response.chat;
}

export function replaceGroundingScopeList<T>(
  chat: Chat,
  scopes: readonly T[] | null,
  persist: (id: string, scopes: readonly T[] | null, identity?: string) => Promise<ChatResponse>,
  onChatChanged: ((chat: Chat) => void) | undefined,
): Promise<ChatResponse> {
  return withGroundingScopeRefresh(
    chat,
    () =>
      chat.groundingScopeIdentity === undefined
        ? persist(chat.id, scopes)
        : persist(chat.id, scopes, chat.groundingScopeIdentity),
    onChatChanged,
  );
}
