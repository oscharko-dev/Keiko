"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { fetchChatMessages, ApiError } from "@/lib/api";
import type { ChatMessage, ProjectWithAvailability } from "@/lib/types";
import { ChatComposer } from "./ChatComposer";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChatViewProps {
  chatId: string;
  project: ProjectWithAvailability;
}

type MessagesState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; messages: readonly ChatMessage[] };

/**
 * Central chat view: project header + message list + composer.
 * Unavailable projects show a banner; composer is hidden.
 * This component only renders when both ?project= and ?chat= are present.
 */
export function ChatView({ chatId, project }: ChatViewProps): ReactNode {
  const [state, setState] = useState<MessagesState>({ kind: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(() => {
    setState({ kind: "loading" });
    let active = true;
    void fetchChatMessages(chatId)
      .then((r) => {
        if (active) setState({ kind: "loaded", messages: r.messages });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const msg = err instanceof ApiError ? err.message : "Failed to load messages";
        setState({ kind: "error", message: msg });
      });
    return () => {
      active = false;
    };
  }, [chatId]);

  useEffect(() => {
    return load();
  }, [load, refreshKey]);

  // Scroll to bottom when messages load or new message arrives
  useEffect(() => {
    if (state.kind === "loaded") {
      bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
    }
  }, [state]);

  // Focus composer on mount (D8: New chat → focus composer)
  useEffect(() => {
    const id = setTimeout(() => {
      composerRef.current?.focus();
    }, 50);
    return () => { clearTimeout(id); };
  }, [chatId]);

  function handleMessageSent(): void {
    setRefreshKey((k) => k + 1);
  }

  const projectName = project.name;
  const available = project.available !== false;

  return (
    <div className="flex h-full flex-col">
      {/* Project / chat header */}
      <div className="border-b border-border bg-chrome px-4 py-2">
        <p className="text-xs text-ink-dim">{project.path}</p>
        <p className="text-sm font-medium text-ink">{projectName}</p>
      </div>

      {/* Unavailable banner */}
      {!available && (
        <div
          role="alert"
          className="border-b border-border bg-panel px-4 py-3 text-xs text-ink-muted"
        >
          <span className="font-medium text-ink">Path no longer available.</span>{" "}
          This path is no longer available on disk. Reconnect by re-adding the same path,
          or remove it from the sidebar. Existing chats remain visible as history.
        </div>
      )}

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {state.kind === "loading" && (
          <div role="status" aria-live="polite" aria-label="Loading messages" className="space-y-2">
            {[1, 2].map((n) => (
              <div key={n} className="h-8 animate-pulse rounded bg-elevated" />
            ))}
          </div>
        )}

        {state.kind === "error" && (
          <div role="alert" className="text-xs text-red-300">
            {state.message}
          </div>
        )}

        {state.kind === "loaded" && state.messages.length === 0 && (
          <p className="text-xs text-ink-dim">No messages yet. Say something!</p>
        )}

        {state.kind === "loaded" && state.messages.length > 0 && (
          <ul className="space-y-3">
            {state.messages.map((msg) => (
              <li
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm
                    ${
                      msg.role === "user"
                        ? "bg-accent text-ink-inverse"
                        : "bg-panel text-ink"
                    }`}
                >
                  <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div ref={bottomRef} aria-hidden="true" />
      </div>

      {/* Composer — hidden for unavailable projects */}
      {available && (
        <ChatComposer chatId={chatId} onMessageSent={handleMessageSent} />
      )}
    </div>
  );
}

export default ChatView;
