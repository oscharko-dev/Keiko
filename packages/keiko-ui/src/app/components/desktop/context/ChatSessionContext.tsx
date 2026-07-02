"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ChatSessionApi } from "../hooks/useChatSession";

type ChatSessionActionKeys =
  | "clearError"
  | "setDraft"
  | "setSelectedModel"
  | "openNewChat"
  | "openProject"
  | "openChat"
  | "addProject"
  | "sendMessage"
  | "appendVoiceTurn"
  | "runRealtimeGroundedTool"
  | "cancelSend"
  | "replaceChat"
  | "cancelGrounded"
  | "addPendingAttachment"
  | "removePendingAttachment"
  | "clearPendingAttachments"
  | "setMemoryEnabled"
  | "setMemoryBudgetTokens"
  | "clearLatestMemory"
  | "acceptMemoryCandidate"
  | "rejectMemoryCandidate"
  | "forgetMemoryAction";

export type ChatSessionActions = Pick<ChatSessionApi, ChatSessionActionKeys>;
export type ChatSessionState = Omit<ChatSessionApi, ChatSessionActionKeys>;
export type ChatSessionCatalog = Pick<
  ChatSessionApi,
  | "projects"
  | "chats"
  | "models"
  | "activeProject"
  | "activeChat"
  | "selectedModel"
  | "noEligibleModels"
  | "loading"
  | "error"
>;
export type ChatSessionActivity = Pick<ChatSessionApi, "sending" | "latestGrounded">;

const ChatSessionStateContext = createContext<ChatSessionState | null>(null);
const ChatSessionActionsContext = createContext<ChatSessionActions | null>(null);
const ChatSessionCatalogContext = createContext<ChatSessionCatalog | null>(null);
const ChatSessionActivityContext = createContext<ChatSessionActivity | null>(null);

interface ChatSessionProviderProps {
  readonly value: ChatSessionApi;
  readonly children: ReactNode;
}

export function ChatSessionProvider({ value, children }: ChatSessionProviderProps): ReactNode {
  const actions = useMemo<ChatSessionActions>(
    () => ({
      setDraft: value.setDraft,
      setSelectedModel: value.setSelectedModel,
      openNewChat: value.openNewChat,
      openProject: value.openProject,
      openChat: value.openChat,
      addProject: value.addProject,
      sendMessage: value.sendMessage,
      cancelSend: value.cancelSend,
      replaceChat: value.replaceChat,
      cancelGrounded: value.cancelGrounded,
      addPendingAttachment: value.addPendingAttachment,
      removePendingAttachment: value.removePendingAttachment,
      clearPendingAttachments: value.clearPendingAttachments,
      setMemoryEnabled: value.setMemoryEnabled,
      setMemoryBudgetTokens: value.setMemoryBudgetTokens,
      clearLatestMemory: value.clearLatestMemory,
      acceptMemoryCandidate: value.acceptMemoryCandidate,
      rejectMemoryCandidate: value.rejectMemoryCandidate,
      forgetMemoryAction: value.forgetMemoryAction,
      ...(value.clearError === undefined ? {} : { clearError: value.clearError }),
      ...(value.appendVoiceTurn === undefined ? {} : { appendVoiceTurn: value.appendVoiceTurn }),
      ...(value.runRealtimeGroundedTool === undefined
        ? {}
        : { runRealtimeGroundedTool: value.runRealtimeGroundedTool }),
    }),
    [
      value.clearError,
      value.setDraft,
      value.setSelectedModel,
      value.openNewChat,
      value.openProject,
      value.openChat,
      value.addProject,
      value.sendMessage,
      value.appendVoiceTurn,
      value.runRealtimeGroundedTool,
      value.cancelSend,
      value.replaceChat,
      value.cancelGrounded,
      value.addPendingAttachment,
      value.removePendingAttachment,
      value.clearPendingAttachments,
      value.setMemoryEnabled,
      value.setMemoryBudgetTokens,
      value.clearLatestMemory,
      value.acceptMemoryCandidate,
      value.rejectMemoryCandidate,
      value.forgetMemoryAction,
    ],
  );
  const catalog = useMemo<ChatSessionCatalog>(
    () => ({
      projects: value.projects,
      chats: value.chats,
      models: value.models,
      activeProject: value.activeProject,
      activeChat: value.activeChat,
      selectedModel: value.selectedModel,
      noEligibleModels: value.noEligibleModels,
      loading: value.loading,
      error: value.error,
    }),
    [
      value.projects,
      value.chats,
      value.models,
      value.activeProject,
      value.activeChat,
      value.selectedModel,
      value.noEligibleModels,
      value.loading,
      value.error,
    ],
  );
  const activity = useMemo<ChatSessionActivity>(
    () => ({ sending: value.sending, latestGrounded: value.latestGrounded }),
    [value.sending, value.latestGrounded],
  );
  const state = useMemo<ChatSessionState>(
    () => ({
      projects: value.projects,
      chats: value.chats,
      messages: value.messages,
      streamingAssistantMessage: value.streamingAssistantMessage,
      models: value.models,
      activeProject: value.activeProject,
      activeChat: value.activeChat,
      selectedModel: value.selectedModel,
      noEligibleModels: value.noEligibleModels,
      draft: value.draft,
      loading: value.loading,
      sending: value.sending,
      sendStatus: value.sendStatus,
      error: value.error,
      latestGrounded: value.latestGrounded,
      pendingAttachments: value.pendingAttachments,
      lastSentDocuments: value.lastSentDocuments,
      memoryEnabled: value.memoryEnabled,
      memoryBudgetTokens: value.memoryBudgetTokens,
      latestMemory: value.latestMemory,
    }),
    [
      value.projects,
      value.chats,
      value.messages,
      value.streamingAssistantMessage,
      value.models,
      value.activeProject,
      value.activeChat,
      value.selectedModel,
      value.noEligibleModels,
      value.draft,
      value.loading,
      value.sending,
      value.sendStatus,
      value.error,
      value.latestGrounded,
      value.pendingAttachments,
      value.lastSentDocuments,
      value.memoryEnabled,
      value.memoryBudgetTokens,
      value.latestMemory,
    ],
  );
  return (
    <ChatSessionActionsContext.Provider value={actions}>
      <ChatSessionCatalogContext.Provider value={catalog}>
        <ChatSessionActivityContext.Provider value={activity}>
          <ChatSessionStateContext.Provider value={state}>
            {children}
          </ChatSessionStateContext.Provider>
        </ChatSessionActivityContext.Provider>
      </ChatSessionCatalogContext.Provider>
    </ChatSessionActionsContext.Provider>
  );
}

export function useChatSessionContext(): ChatSessionApi {
  const state = useContext(ChatSessionStateContext);
  const actions = useContext(ChatSessionActionsContext);
  const combined = useMemo<ChatSessionApi | null>(
    () => (state === null || actions === null ? null : { ...state, ...actions }),
    [state, actions],
  );
  if (combined === null) {
    throw new Error("useChatSessionContext must be used inside ChatSessionProvider");
  }
  return combined;
}

export function useChatSessionCatalog(): ChatSessionCatalog {
  const ctx = useContext(ChatSessionCatalogContext);
  if (ctx === null) {
    throw new Error("useChatSessionCatalog must be used inside ChatSessionProvider");
  }
  return ctx;
}

export function useChatSessionActions(): ChatSessionActions {
  const ctx = useContext(ChatSessionActionsContext);
  if (ctx === null) {
    throw new Error("useChatSessionActions must be used inside ChatSessionProvider");
  }
  return ctx;
}

// Issue #184 — optional read for nested widgets (e.g. FilePreview) that may render outside the
// chat session in tests or in stand-alone storybook-style usage. Returns null when no provider
// is mounted; callers that need the session must use useChatSessionContext().
export function useOptionalChatSessionContext(): ChatSessionApi | null {
  const state = useContext(ChatSessionStateContext);
  const actions = useContext(ChatSessionActionsContext);
  return useMemo<ChatSessionApi | null>(
    () => (state === null || actions === null ? null : { ...state, ...actions }),
    [state, actions],
  );
}

export function useOptionalChatSessionCatalog(): ChatSessionCatalog | null {
  return useContext(ChatSessionCatalogContext);
}

export function useOptionalChatSessionActivity(): ChatSessionActivity | null {
  return useContext(ChatSessionActivityContext);
}
