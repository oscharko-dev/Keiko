"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ProjectWithAvailability } from "@/lib/types";
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
  | "enqueueCanonicalVoiceTurn"
  | "canonicalVoiceCaptureMustPause"
  | "retryPendingCanonicalVoiceTurn"
  | "discardPendingCanonicalVoiceTurn"
  | "interruptCanonicalVoiceDelivery"
  | "regenerateMessage"
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
type ChatSessionState = Omit<ChatSessionApi, ChatSessionActionKeys>;
// GEN-PERF-CHAT-014 — the streaming delta is the ONLY session field that changes on every
// coalesced token flush (up to one commit per animation frame while a reply streams). It
// lives in its own context slice so consumers that don't render the live bubble (composer,
// headers, panels) can subscribe to the settled slice and skip those per-frame renders.
type ChatSessionStream = Pick<ChatSessionApi, "streamingAssistantMessage">;
type ChatSessionSettledState = Omit<ChatSessionState, "streamingAssistantMessage">;
// Everything a composer-side consumer may need: the full session API minus the per-frame
// streaming delta. Reading THIS instead of useChatSessionContext() is what makes a
// memo()'d component actually bail out during a stream.
export type ChatSessionComposerApi = Omit<ChatSessionApi, "streamingAssistantMessage">;
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

const ChatSessionStateContext = createContext<ChatSessionSettledState | null>(null);
const ChatSessionStreamContext = createContext<ChatSessionStream | null>(null);
const ChatSessionActionsContext = createContext<ChatSessionActions | null>(null);
const ChatSessionCatalogContext = createContext<ChatSessionCatalog | null>(null);
const ChatSessionProjectContext = createContext<ProjectWithAvailability | null>(null);
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
      ...(value.enqueueCanonicalVoiceTurn === undefined
        ? {}
        : { enqueueCanonicalVoiceTurn: value.enqueueCanonicalVoiceTurn }),
      ...(value.canonicalVoiceCaptureMustPause === undefined
        ? {}
        : { canonicalVoiceCaptureMustPause: value.canonicalVoiceCaptureMustPause }),
      ...(value.retryPendingCanonicalVoiceTurn === undefined
        ? {}
        : { retryPendingCanonicalVoiceTurn: value.retryPendingCanonicalVoiceTurn }),
      ...(value.discardPendingCanonicalVoiceTurn === undefined
        ? {}
        : { discardPendingCanonicalVoiceTurn: value.discardPendingCanonicalVoiceTurn }),
      ...(value.interruptCanonicalVoiceDelivery === undefined
        ? {}
        : { interruptCanonicalVoiceDelivery: value.interruptCanonicalVoiceDelivery }),
      regenerateMessage: value.regenerateMessage,
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
      value.enqueueCanonicalVoiceTurn,
      value.canonicalVoiceCaptureMustPause,
      value.retryPendingCanonicalVoiceTurn,
      value.discardPendingCanonicalVoiceTurn,
      value.interruptCanonicalVoiceDelivery,
      value.regenerateMessage,
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
  const stream = useMemo<ChatSessionStream>(
    () => ({ streamingAssistantMessage: value.streamingAssistantMessage }),
    [value.streamingAssistantMessage],
  );
  const state = useMemo<ChatSessionSettledState>(
    () => ({
      projects: value.projects,
      chats: value.chats,
      messages: value.messages,
      models: value.models,
      activeProject: value.activeProject,
      activeChat: value.activeChat,
      selectedModel: value.selectedModel,
      noEligibleModels: value.noEligibleModels,
      draft: value.draft,
      loading: value.loading,
      sending: value.sending,
      sendStatus: value.sendStatus,
      canonicalVoiceTurnRequiresRetry: value.canonicalVoiceTurnRequiresRetry,
      regeneratingMessageId: value.regeneratingMessageId,
      error: value.error,
      latestGrounded: value.latestGrounded,
      pendingAttachments: value.pendingAttachments,
      lastSentDocuments: value.lastSentDocuments,
      ...(value.lastSentImages === undefined ? {} : { lastSentImages: value.lastSentImages }),
      memoryEnabled: value.memoryEnabled,
      memoryBudgetTokens: value.memoryBudgetTokens,
      latestMemory: value.latestMemory,
    }),
    [
      value.projects,
      value.chats,
      value.messages,
      value.models,
      value.activeProject,
      value.activeChat,
      value.selectedModel,
      value.noEligibleModels,
      value.draft,
      value.loading,
      value.sending,
      value.sendStatus,
      value.canonicalVoiceTurnRequiresRetry,
      value.regeneratingMessageId,
      value.error,
      value.latestGrounded,
      value.pendingAttachments,
      value.lastSentDocuments,
      value.lastSentImages,
      value.memoryEnabled,
      value.memoryBudgetTokens,
      value.latestMemory,
    ],
  );
  return (
    <ChatSessionActionsContext.Provider value={actions}>
      <ChatSessionCatalogContext.Provider value={catalog}>
        <ChatSessionProjectContext.Provider value={value.activeProject ?? null}>
          <ChatSessionActivityContext.Provider value={activity}>
            <ChatSessionStateContext.Provider value={state}>
              <ChatSessionStreamContext.Provider value={stream}>
                {children}
              </ChatSessionStreamContext.Provider>
            </ChatSessionStateContext.Provider>
          </ChatSessionActivityContext.Provider>
        </ChatSessionProjectContext.Provider>
      </ChatSessionCatalogContext.Provider>
    </ChatSessionActionsContext.Provider>
  );
}

export function useChatSessionContext(): ChatSessionApi {
  const state = useContext(ChatSessionStateContext);
  const stream = useContext(ChatSessionStreamContext);
  const actions = useContext(ChatSessionActionsContext);
  const combined = useMemo<ChatSessionApi | null>(
    () =>
      state === null || stream === null || actions === null
        ? null
        : { ...state, ...stream, ...actions },
    [state, stream, actions],
  );
  if (combined === null) {
    throw new Error("useChatSessionContext must be used inside ChatSessionProvider");
  }
  return combined;
}

// GEN-PERF-CHAT-014 — settled session slice for components that never render the live
// streaming bubble (composer, scope header, panels). Unlike useChatSessionContext(), the
// returned identity does NOT change on per-frame token flushes, so a memo()'d consumer
// skips every stream-flush render and still re-renders on drafts, sends, and catalog
// changes exactly as before.
export function useChatSessionComposer(): ChatSessionComposerApi {
  const state = useContext(ChatSessionStateContext);
  const actions = useContext(ChatSessionActionsContext);
  const combined = useMemo<ChatSessionComposerApi | null>(
    () => (state === null || actions === null ? null : { ...state, ...actions }),
    [state, actions],
  );
  if (combined === null) {
    throw new Error("useChatSessionComposer must be used inside ChatSessionProvider");
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

export function useOptionalChatSessionCatalog(): ChatSessionCatalog | null {
  return useContext(ChatSessionCatalogContext);
}

export function useOptionalChatSessionProject(): ProjectWithAvailability | null {
  return useContext(ChatSessionProjectContext);
}

export function useOptionalChatSessionActions(): ChatSessionActions | null {
  return useContext(ChatSessionActionsContext);
}

export function useOptionalChatSessionActivity(): ChatSessionActivity | null {
  return useContext(ChatSessionActivityContext);
}
