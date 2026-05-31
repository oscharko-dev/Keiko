"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, fetchChatMessages, fetchChats } from "@/lib/api";
import type { Chat, ChatMessage, ProjectWithAvailability } from "@/lib/types";
import { ChatComposer } from "./ChatComposer";
import { RunSummaryCard } from "./RunSummaryCard";

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

type ChatState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; chat: Chat }
  | { kind: "notfound" };

/**
 * Central chat view: project header + message list + composer.
 * Unavailable projects show a banner; composer is hidden.
 * This component only renders when both ?project= and ?chat= are present.
 *
 * Fetches the chat record (issue #65) so the composer can read `chat.selectedModel`
 * and submit per-mode workflow runs against `project.path`.
 */
export function ChatView({ chatId, project }: ChatViewProps): ReactNode {
  const [state, setState] = useState<MessagesState>({ kind: "loading" });
  const [chatState, setChatState] = useState<ChatState>({ kind: "loading" });
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

  useEffect(() => {
    let active = true;
    setChatState({ kind: "loading" });
    void fetchChats(project.path)
      .then(({ chats }) => {
        if (!active) return;
        const found = chats.find((c) => c.id === chatId);
        setChatState(found === undefined ? { kind: "notfound" } : { kind: "loaded", chat: found });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message = err instanceof ApiError ? err.message : "Failed to load chat";
        setChatState({ kind: "error", message });
      });
    return () => {
      active = false;
    };
  }, [chatId, project.path]);

  useEffect(() => {
    if (state.kind === "loaded") {
      bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
    }
  }, [state]);

  useEffect(() => {
    composerRef.current?.focus();
  }, [chatId]);

  function handleMessageSent(): void {
    setRefreshKey((k) => k + 1);
  }

  // Issue #66 — replace a message by id in-place so a PATCHed run summary updates the DOM
  // without a full refetch. The hook only patches system messages with a runId; the
  // role+runId discriminator in the render branch routes the render path.
  const handlePatched = useCallback((updated: ChatMessage): void => {
    setState((prev) => {
      if (prev.kind !== "loaded") return prev;
      return {
        kind: "loaded",
        messages: prev.messages.map((m) => (m.id === updated.id ? updated : m)),
      };
    });
  }, []);

  const projectName = project.name;
  const available = project.available !== false;

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Project / chat header */}
      <div className="min-w-0 border-b border-border bg-chrome px-4 py-2">
        <p className="break-all font-mono text-xs text-ink-dim" title={project.path}>
          {project.path}
        </p>
        <p className="truncate text-sm font-medium text-ink" title={projectName}>
          {projectName}
        </p>
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
                {msg.role === "system" && msg.runId !== undefined ? (
                  <RunSummaryCard message={msg} onPatched={handlePatched} />
                ) : (
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
                )}
              </li>
            ))}
          </ul>
        )}
        <div ref={bottomRef} aria-hidden="true" />
      </div>

      {/* Chat-record error surface — distinct from a message-list error so the composer is
          held back without misattributing the failure to the message stream. */}
      {available && chatState.kind === "error" && (
        <div
          role="alert"
          className="border-t border-border bg-chrome px-4 py-3 text-xs text-red-300"
        >
          {chatState.message}
        </div>
      )}
      {available && chatState.kind === "notfound" && (
        <div
          role="alert"
          className="border-t border-border bg-chrome px-4 py-3 text-xs text-ink-muted"
        >
          This chat is no longer available.
        </div>
      )}

      {/* Composer — hidden for unavailable projects or while the chat record is still loading. */}
      {available && chatState.kind === "loaded" && (
        <ChatComposer
          chatId={chatId}
          chat={chatState.chat}
          project={project}
          onMessageSent={handleMessageSent}
          textareaRef={composerRef}
        />
      )}
    </div>
  );
}

export default ChatView;
