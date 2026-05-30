"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { fetchChats, ApiError } from "@/lib/api";
import type { Chat } from "@/lib/types";
import { sortChats } from "@/lib/sidebar-sort";

// ---------------------------------------------------------------------------
// ChatList states
// ---------------------------------------------------------------------------

type ChatListState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; chats: readonly Chat[] };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChatListProps {
  projectPath: string;
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
  /** Called when new chats are created and list needs refresh. */
  refreshKey?: number;
}

/**
 * Nested chat list under a selected project row.
 * Fetches GET /api/chats?projectPath=... and renders sorted by updatedAt desc.
 */
export function ChatList({
  projectPath,
  selectedChatId,
  onSelectChat,
  refreshKey,
}: ChatListProps): ReactNode {
  const [state, setState] = useState<ChatListState>({ kind: "loading" });

  const load = useCallback(() => {
    setState({ kind: "loading" });
    let active = true;
    void fetchChats(projectPath)
      .then((r) => {
        if (active) setState({ kind: "loaded", chats: sortChats(r.chats) });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const msg = err instanceof ApiError ? err.message : "Failed to load chats";
        setState({ kind: "error", message: msg });
      });
    return () => {
      active = false;
    };
  }, [projectPath]);

  useEffect(() => {
    return load();
  }, [load, refreshKey]);

  if (state.kind === "loading") {
    return (
      <div role="status" aria-live="polite" aria-label="Loading chats" className="px-2 py-1">
        <div className="h-4 w-3/4 animate-pulse rounded bg-elevated" />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div role="alert" className="px-2 py-1 text-xs text-red-300">
        {state.message}
      </div>
    );
  }

  if (state.chats.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-ink-dim" aria-label="No chats yet for this project">
        No chats yet
      </p>
    );
  }

  return (
    <ul className="space-y-0.5">
      {state.chats.map((chat) => (
        <li key={chat.id}>
          <button
            type="button"
            aria-current={chat.id === selectedChatId ? "true" : undefined}
            title={chat.title}
            onClick={() => { onSelectChat(chat.id); }}
            className={`w-full truncate rounded px-2 py-1 text-left text-xs
              transition-colors
              focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
              ${
                chat.id === selectedChatId
                  ? "bg-elevated text-ink"
                  : "text-ink-muted hover:bg-elevated hover:text-ink"
              }`}
          >
            {chat.title}
          </button>
        </li>
      ))}
    </ul>
  );
}

export default ChatList;
