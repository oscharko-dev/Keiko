import { ApiError, fetchChats, updateChat, type UpdateChatInput } from "./api";
import { newClientCorrelationId } from "./bff-correlation";
import { clientErrorEvidence } from "./client-error-evidence";
import { reportClientDiagnostic } from "./client-diagnostics";
import { bffRequestErrorKind } from "./http";
import type { Chat, ChatGitChangeScope, ChatResponse } from "./types";

// Source-mutation replies describe the scope; the targeted chat response owns its identity.
export async function canonicalGroundingChat(
  chat: Chat,
  listChats: typeof fetchChats = fetchChats,
  correlationId: string = newClientCorrelationId(),
): Promise<Chat> {
  const response = await listChats(chat.projectPath, correlationId, chat.id);
  const current = response.chats.find(
    (candidate) => candidate.id === chat.id && candidate.projectPath === chat.projectPath,
  );
  if (current === undefined || (current.status !== undefined && current.status !== "open")) {
    throw new ApiError("NOT_FOUND", "The connected chat is no longer available.", 404);
  }
  return current;
}

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
      const correlationId = error.correlationId ?? newClientCorrelationId();
      reportClientDiagnostic("Grounding scope mutation refused.", {
        kind: "other",
        correlationId,
        errorKind: bffRequestErrorKind(error),
        errorEvidence: clientErrorEvidence(error),
      });
      await refreshConflictedChat(chat, correlationId, onChatChanged);
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

interface CommittedGitChat {
  readonly chat: Chat | undefined;
  readonly confirmed: boolean;
  readonly unavailable?: boolean;
}

type CommittedGitResult = { readonly scope: ChatGitChangeScope; readonly chat?: Chat };

function ownsOpenGitChat(original: Chat, candidate: Chat): boolean {
  return (
    candidate.id === original.id &&
    candidate.projectPath === original.projectPath &&
    (candidate.status === undefined || candidate.status === "open")
  );
}

function confirmsGitScope(chat: Chat, scope: ChatGitChangeScope): boolean {
  return (
    chat.gitChangeScopes?.some(
      (candidate) =>
        candidate.relationshipId === scope.relationshipId &&
        candidate.snapshotDigest === scope.snapshotDigest &&
        candidate.remoteDigest === scope.remoteDigest,
    ) === true
  );
}

function projectedGitChat(
  latest: Chat,
  original: Chat,
  scope: ChatGitChangeScope,
  previousRelationshipId?: string,
): Chat | undefined {
  if (!ownsOpenGitChat(original, latest)) return undefined;
  if (latest.groundingScopeIdentity !== original.groundingScopeIdentity) return undefined;
  const scopes = (latest.gitChangeScopes ?? []).filter(
    (candidate) =>
      candidate.relationshipId !== previousRelationshipId &&
      candidate.relationshipId !== scope.relationshipId,
  );
  return { ...latest, gitChangeScopes: [...scopes, scope] };
}

// Successful POSTs are never replayed because a legacy follow-up read is unavailable.
export async function committedGitChat(
  original: Chat,
  result: CommittedGitResult,
  correlationId: string,
  listChats: typeof fetchChats = fetchChats,
): Promise<CommittedGitChat> {
  try {
    const canonical =
      result.chat ?? (await canonicalGroundingChat(original, listChats, correlationId));
    if (!ownsOpenGitChat(original, canonical) || !confirmsGitScope(canonical, result.scope)) {
      throw new ApiError(
        "CONTRACT_VALIDATION_FAILED",
        "Committed Git scope was not confirmed.",
        502,
      );
    }
    return { chat: canonical, confirmed: true };
  } catch (error) {
    reportClientDiagnostic("Committed Git scope refresh failed.", {
      kind: "other",
      correlationId,
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    return {
      chat: undefined,
      confirmed: false,
      unavailable:
        result.chat !== undefined || (error instanceof ApiError && error.code === "NOT_FOUND"),
    };
  }
}

export function adoptableGitChat(
  original: Chat,
  latest: Chat,
  committed: CommittedGitChat,
  scope: ChatGitChangeScope,
  previousRelationshipId?: string,
): Chat | undefined {
  if (!ownsOpenGitChat(original, latest) || committed.unavailable === true) return undefined;
  if (committed.chat !== undefined) {
    return latest.updatedAt > committed.chat.updatedAt ? undefined : committed.chat;
  }
  return projectedGitChat(latest, original, scope, previousRelationshipId);
}
