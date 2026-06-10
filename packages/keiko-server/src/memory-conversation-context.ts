import type { ConversationId, MemoryScope, ProjectId, UserId, WorkspaceId } from "@oscharko-dev/keiko-contracts/memory";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";

export const LOCAL_CONVERSATION_MEMORY_USER_ID = "local-operator" as UserId;

export interface ConversationMemoryRuntimeContext {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly conversationId: ConversationId;
}

export function resolveConversationMemoryContext(
  deps: UiHandlerDeps,
  projectPath: string,
  chatId: string,
): ConversationMemoryRuntimeContext | RouteResult {
  const chat = deps.store.listChats(projectPath).find((entry) => entry.id === chatId);
  if (chat === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Chat not found.") };
  }
  return {
    userId: LOCAL_CONVERSATION_MEMORY_USER_ID,
    workspaceId: projectPath as WorkspaceId,
    projectId: projectPath as ProjectId,
    conversationId: chat.id as ConversationId,
  };
}

export function conversationMemoryScopes(
  context: ConversationMemoryRuntimeContext,
): readonly MemoryScope[] {
  return [
    { kind: "workspace", workspaceId: context.workspaceId },
    { kind: "project", projectId: context.projectId },
    { kind: "user", userId: context.userId },
    { kind: "global" },
  ];
}
