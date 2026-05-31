"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { Icons } from "./Icons";
import type { UseChatSessionResult } from "./hooks/useChatSession";
import { DEFAULT_MODEL_ID } from "./hooks/useChatSession";
import type { ChatMessage, ModelCapability } from "@/lib/types";

interface ChatWindowProps {
  session: UseChatSessionResult;
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function visibleOnly(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role === "user" || m.role === "assistant");
}

interface MessageBubbleProps {
  message: ChatMessage;
}

function MessageBubble({ message }: MessageBubbleProps): ReactNode {
  const isUser = message.role === "user";
  return (
    <article
      data-role={message.role}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
        marginBottom: 12,
      }}
    >
      <div
        style={{
          maxWidth: "82%",
          padding: "10px 13px",
          borderRadius: 12,
          background: isUser ? "var(--accent-dim)" : "var(--card)",
          border: "1px solid var(--line-soft)",
          color: "var(--fg)",
          fontSize: 14,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        <div
          className="mono"
          style={{ fontSize: 10.5, color: "var(--fg-faint)", marginBottom: 4 }}
        >
          {isUser ? "You" : "Keiko"}
        </div>
        {message.content}
        <div
          className="mono"
          style={{ fontSize: 10.5, color: "var(--fg-faint)", marginTop: 6 }}
        >
          {timeLabel(message.timestamp)}
        </div>
      </div>
    </article>
  );
}

export function ChatWindow({ session }: ChatWindowProps): ReactNode {
  const {
    messages,
    models,
    activeChat,
    selectedModel,
    draft,
    loading,
    sending,
    error,
    setDraft,
    setSelectedModel,
    sendMessage,
  } = session;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const ready = draft.trim().length > 0 && !sending && !loading;
  const visible = visibleOnly(messages);
  const modelOptions: readonly ModelCapability[] =
    models.length > 0 ? models : ([{ id: DEFAULT_MODEL_ID } as ModelCapability]);

  return (
    <>
      <div className="win-head">
        <span className="win-ico" style={{ color: "var(--accent)" }}>
          <Icons.spark size={14} />
        </span>
        <span className="win-title">Chat</span>
        {activeChat !== undefined ? (
          <span className="win-sub">{activeChat.title}</span>
        ) : null}
        <span className="spacer" />
        <span className="win-sub mono">{selectedModel}</span>
      </div>

      <div className="chatw" style={{ height: "calc(100% - 38px)" }}>
        <div className="chatw-scroll" aria-live="polite">
          {visible.length === 0 ? (
            <div style={{ padding: "18px 8px", color: "var(--fg-faint)", fontSize: 13 }}>
              <div style={{ color: "var(--fg)", fontSize: 16, marginBottom: 6 }}>
                Chat with GPT OSS 120B
              </div>
              The model call stays behind the existing Keiko Model Gateway. No provider
              details or Azure secrets are exposed to the browser.
            </div>
          ) : (
            visible.map((message) => <MessageBubble key={message.id} message={message} />)
          )}
        </div>

        <form
          className="composer composer-compact"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage();
          }}
        >
          <div className="cmp-box">
            <textarea
              className="cmp-input"
              rows={2}
              value={draft}
              aria-label="Chat message"
              placeholder={
                loading
                  ? "Loading local workspace..."
                  : "Ask GPT OSS 120B about your code..."
              }
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              disabled={loading || sending}
            />
            <div className="cmp-bar">
              <button type="button" className="cmp-add" aria-label="Attach">
                <Icons.plus size={16} />
              </button>
              <select
                className="cmp-model mono"
                value={selectedModel}
                aria-label="Model"
                onChange={(event) => setSelectedModel(event.target.value)}
              >
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
              <span className="spacer" />
              <button
                type="submit"
                className="cmp-send"
                data-on={ready}
                disabled={!ready}
                aria-label="Send message"
              >
                <Icons.arrowUp size={16} />
              </button>
            </div>
            {error !== undefined ? (
              <div
                role="alert"
                style={{
                  marginTop: 8,
                  padding: "6px 10px",
                  borderRadius: 7,
                  background:
                    "color-mix(in oklch, var(--danger) 12%, transparent)",
                  color: "var(--danger)",
                  fontSize: 12,
                }}
              >
                {error}
              </div>
            ) : null}
          </div>
        </form>
      </div>
    </>
  );
}
