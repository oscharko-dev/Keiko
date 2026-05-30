"use client";

import { useRef, useState } from "react";
import type { ReactNode, KeyboardEvent } from "react";
import { createChatMessage, ApiError } from "@/lib/api";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChatComposerProps {
  chatId: string;
  /** Called after message is successfully persisted so the parent can refresh. */
  onMessageSent: () => void;
}

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "error"; message: string };

/**
 * Text composer for a chat. Sends a user message via POST /api/chats/messages.
 * No workflow execution — this creates the user message row only (#64 scope).
 * Workflow wiring is reserved for epic #61 child issues.
 */
export function ChatComposer({ chatId, onMessageSent }: ChatComposerProps): ReactNode {
  const [text, setText] = useState("");
  const [sendState, setSendState] = useState<SendState>({ kind: "idle" });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const errorId = "composer-error";

  const isEmpty = text.trim().length === 0;
  const isSending = sendState.kind === "sending";

  async function send(): Promise<void> {
    if (isEmpty || isSending) return;
    const content = text.trim();
    setSendState({ kind: "sending" });
    try {
      await createChatMessage({
        chatId,
        role: "user",
        content,
        timestamp: Date.now(),
      });
      setText("");
      setSendState({ kind: "idle" });
      onMessageSent();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : "Failed to send message.";
      setSendState({ kind: "error", message: msg });
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Send on Enter (without Shift)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="border-t border-border bg-chrome px-4 py-3">
      {sendState.kind === "error" && (
        <p id={errorId} role="alert" className="mb-2 text-xs text-red-400">
          {sendState.message}
        </p>
      )}
      <div className="flex items-end gap-2">
        <label htmlFor={`composer-${chatId}`} className="sr-only">
          Message
        </label>
        <textarea
          ref={textareaRef}
          id={`composer-${chatId}`}
          rows={3}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (sendState.kind === "error") setSendState({ kind: "idle" });
          }}
          onKeyDown={handleKeyDown}
          placeholder="Type a message… (Enter to send, Shift+Enter for new line)"
          disabled={isSending}
          aria-describedby={sendState.kind === "error" ? errorId : undefined}
          aria-invalid={sendState.kind === "error" ? "true" : undefined}
          className="flex-1 resize-none rounded bg-elevated px-3 py-2 text-sm text-ink
            placeholder:text-ink-dim
            focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
            disabled:opacity-50"
          style={{ border: "1px solid #3a4052" }}
        />
        <button
          type="button"
          disabled={isEmpty || isSending}
          onClick={() => { void send(); }}
          aria-label="Send message"
          className="shrink-0 rounded bg-accent px-3 py-2 text-xs font-medium text-ink-inverse
            hover:bg-accent-strong
            focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
            disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isSending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

export default ChatComposer;
