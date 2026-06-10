"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ChatSessionApi } from "../hooks/useChatSession";

const ChatSessionContext = createContext<ChatSessionApi | null>(null);

interface ChatSessionProviderProps {
  readonly value: ChatSessionApi;
  readonly children: ReactNode;
}

export function ChatSessionProvider({ value, children }: ChatSessionProviderProps): ReactNode {
  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}

export function useChatSessionContext(): ChatSessionApi {
  const ctx = useContext(ChatSessionContext);
  if (ctx === null) {
    throw new Error("useChatSessionContext must be used inside ChatSessionProvider");
  }
  return ctx;
}

// Issue #184 — optional read for nested widgets (e.g. FilePreview) that may render outside the
// chat session in tests or in stand-alone storybook-style usage. Returns null when no provider
// is mounted; callers that need the session must use useChatSessionContext().
export function useOptionalChatSessionContext(): ChatSessionApi | null {
  return useContext(ChatSessionContext);
}
