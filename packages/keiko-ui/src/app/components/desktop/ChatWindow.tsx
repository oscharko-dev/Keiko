"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useChatSessionContext } from "./context/ChatSessionContext";
import { ConnectedScopePill } from "./ConnectedScopePill";
import { GroundedAnswer } from "./GroundedAnswer";
import { Icons } from "./Icons";
import { DEFAULT_MODEL_ID, type ChatSessionApi } from "./hooks/useChatSession";
import { ApiError, updateChat } from "@/lib/api";
import {
  fetchCapsules,
  fetchCapsuleSets,
  type CapsuleListEntry,
  type CapsuleSetListEntry,
} from "@/lib/local-knowledge-api";
import type {
  Chat,
  ChatMessage,
  ChatLocalKnowledgeScope,
  GroundedAnswer as GroundedAnswerWire,
  ModelCapability,
} from "@/lib/types";

interface ChatWindowProps {
  readonly mini?: boolean;
  readonly linkedRoot?: string | null;
}

const SUGGESTIONS: readonly string[] = [
  "Explain the architecture of this codebase",
  "Find and fix a bug in the workspace store",
  "Write tests for the window manager",
];

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function visibleOnly(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role === "user" || m.role === "assistant");
}

function modelList(models: readonly ModelCapability[]): readonly ModelCapability[] {
  return models.length > 0 ? models : [{ id: DEFAULT_MODEL_ID } as ModelCapability];
}

function onComposerKeyDown(
  send: () => Promise<void>,
): (event: KeyboardEvent<HTMLTextAreaElement>) => void {
  return (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };
}

function ChatBubble({ message }: { readonly message: ChatMessage }): ReactNode {
  const isUser = message.role === "user";
  return (
    <article className="chat-msg" data-role={message.role}>
      <div className="chat-msg-bubble">
        <div className="chat-msg-role">{isUser ? "You" : "Keiko"}</div>
        {message.content}
        <div className="chat-msg-time">{timeLabel(message.timestamp)}</div>
      </div>
    </article>
  );
}

function TypingBubble(): ReactNode {
  return (
    <article className="chat-msg" data-role="assistant">
      <div className="chat-msg-bubble">
        <div className="chat-msg-role">Keiko</div>
        <span className="chat-typing" aria-label="Keiko is responding">
          <i />
          <i />
          <i />
        </span>
      </div>
    </article>
  );
}

interface ComposerBarProps {
  readonly session: ChatSessionApi;
  readonly ready: boolean;
}

function ComposerBar({ session, ready }: ComposerBarProps): ReactNode {
  const { models, selectedModel, setSelectedModel } = session;
  return (
    <div className="cmp-bar">
      <button type="button" className="cmp-add" aria-label="Attach (coming soon)" title="Attach">
        <Icons.plus size={16} />
      </button>
      <button type="button" className="cmp-mode" title="Mode">
        <Icons.spark size={14} style={{ color: "var(--accent)" }} /> Build
        <Icons.chevron size={12} />
      </button>
      <span className="spacer" />
      <label className="cmp-model mono" title="Model">
        <Icons.cube size={13} style={{ color: "var(--accent)" }} />
        <select
          className="cmp-model-select"
          value={selectedModel}
          aria-label="Model"
          onChange={(event) => setSelectedModel(event.target.value)}
        >
          {modelList(models).map((model) => (
            <option key={model.id} value={model.id}>
              {model.id}
            </option>
          ))}
        </select>
        <Icons.chevron size={12} />
      </label>
      <button type="button" className="cmp-icon" aria-label="Voice (coming soon)" title="Voice">
        <Icons.mic size={16} />
      </button>
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
  );
}

interface ComposerCoreProps {
  readonly session: ChatSessionApi;
  readonly ready: boolean;
  readonly placeholder: string;
}

function ComposerCore({ session, ready, placeholder }: ComposerCoreProps): ReactNode {
  const { draft, loading, sending, setDraft, sendMessage } = session;
  return (
    <div className="cmp-box">
      <textarea
        className="cmp-input"
        rows={2}
        value={draft}
        aria-label="Chat message"
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onComposerKeyDown(sendMessage)}
        disabled={loading || sending}
      />
      <ComposerBar session={session} ready={ready} />
    </div>
  );
}

function ChatHero({
  session,
  ready,
}: {
  readonly session: ChatSessionApi;
  readonly ready: boolean;
}): ReactNode {
  const { loading, activeProject, setDraft, sendMessage } = session;
  const folder = activeProject?.name ?? "example-workspace";
  return (
    <form
      className="composer composer-compact"
      onSubmit={(event) => {
        event.preventDefault();
        void sendMessage();
      }}
    >
      <h1 className="composer-title">What should we build?</h1>
      <ComposerCore
        session={session}
        ready={ready}
        placeholder={
          loading
            ? "Loading local workspace..."
            : "Describe a task, paste a link, or ask anything..."
        }
      />
      <div className="cmp-context">
        <button type="button" className="chip">
          <Icons.folder size={14} style={{ color: "var(--accent)" }} />
          <span className="chip-label">{folder}</span>
          <Icons.chevron size={12} style={{ color: "var(--fg-faint)" }} />
        </button>
        <button type="button" className="chip">
          <Icons.cube size={14} style={{ color: "var(--fg-dim)" }} />
          <span className="chip-label">Work locally</span>
          <Icons.chevron size={12} style={{ color: "var(--fg-faint)" }} />
        </button>
      </div>
      <div className="cmp-suggest">
        {SUGGESTIONS.map((prompt) => (
          <button type="button" key={prompt} className="suggest" onClick={() => setDraft(prompt)}>
            <Icons.spark size={12} style={{ color: "var(--accent)" }} /> {prompt}
          </button>
        ))}
      </div>
    </form>
  );
}

function MiniChat({
  session,
  ready,
}: {
  readonly session: ChatSessionApi;
  readonly ready: boolean;
}): ReactNode {
  const { draft, loading, sending, setDraft, sendMessage } = session;
  return (
    <form
      className="composer composer-fill"
      onSubmit={(event) => {
        event.preventDefault();
        void sendMessage();
      }}
    >
      <div className="cmp-box cmp-box-fill">
        <textarea
          className="cmp-input cmp-input-mini"
          value={draft}
          aria-label="Chat message"
          placeholder={loading ? "Loading..." : "Ask Keiko..."}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onComposerKeyDown(sendMessage)}
          disabled={loading || sending}
        />
        <button
          type="submit"
          className="cmp-send cmp-send-float"
          data-on={ready}
          disabled={!ready}
          aria-label="Send message"
          title="Send"
        >
          <Icons.arrowUp size={16} />
        </button>
      </div>
    </form>
  );
}

// Design pattern (widgets.jsx ChatWidget): when this card is connected to a
// Files card via the workspace's connection graph, surface the linked folder
// so the conversation context is visible to the user. Without this the
// connect-card gesture has no perceptible effect inside the chat.
function ChatContext({ root }: { readonly root: string }): ReactNode {
  return (
    <div className="chat-ctx">
      <Icons.files size={12} /> Context <span className="mono">{root}/</span>
    </div>
  );
}

function groundedModeValue(chat: Chat): string {
  if (chat.localKnowledgeScope?.kind === "capsule") {
    return `capsule:${chat.localKnowledgeScope.capsuleId}`;
  }
  if (chat.localKnowledgeScope?.kind === "capsule-set") {
    return `capsule-set:${chat.localKnowledgeScope.capsuleSetId}`;
  }
  if (chat.connectedScope !== undefined) return "files";
  return "none";
}

function formatScopeUpdateError(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unable to update knowledge scope.";
}

function LocalKnowledgeScopeControl({
  chat,
  onChatChanged,
}: {
  readonly chat: Chat;
  readonly onChatChanged: (chat: Chat) => void;
}): ReactNode {
  const [capsules, setCapsules] = useState<readonly CapsuleListEntry[]>([]);
  const [capsuleSets, setCapsuleSets] = useState<readonly CapsuleSetListEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [capsuleResponse, capsuleSetResponse] = await Promise.all([
          fetchCapsules(),
          fetchCapsuleSets().catch(() => ({ capsuleSets: [] })),
        ]);
        if (cancelled) return;
        setCapsules(
          capsuleResponse.capsules.filter((entry) => entry.lifecycleState === "ready"),
        );
        setCapsuleSets(capsuleSetResponse.capsuleSets);
      } catch (caught) {
        if (!cancelled) setError(formatScopeUpdateError(caught));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleChange(value: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (value === "none") {
        const response = await updateChat(chat.id, {
          connectedScope: null,
          localKnowledgeScope: null,
        });
        onChatChanged(response.chat);
        return;
      }
      if (value === "files") {
        const response = await updateChat(chat.id, { localKnowledgeScope: null });
        onChatChanged(response.chat);
        return;
      }
      if (value.startsWith("capsule-set:")) {
        const response = await updateChat(chat.id, {
          connectedScope: null,
          localKnowledgeScope: {
            kind: "capsule-set",
            capsuleSetId: value.slice("capsule-set:".length) as Extract<
              ChatLocalKnowledgeScope,
              { readonly kind: "capsule-set" }
            >["capsuleSetId"],
            connectedAtMs: Date.now(),
          },
        });
        onChatChanged(response.chat);
        return;
      }
      if (value.startsWith("capsule:")) {
        const response = await updateChat(chat.id, {
          connectedScope: null,
          localKnowledgeScope: {
            kind: "capsule",
            capsuleId: value.slice("capsule:".length) as Extract<
              ChatLocalKnowledgeScope,
              { readonly kind: "capsule" }
            >["capsuleId"],
            connectedAtMs: Date.now(),
          },
        });
        onChatChanged(response.chat);
      }
    } catch (caught) {
      setError(formatScopeUpdateError(caught));
    } finally {
      setBusy(false);
    }
  }

  const value = groundedModeValue(chat);
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        fontSize: 12,
      }}
    >
      <span className="mono" style={{ color: "var(--fg-dim)" }}>
        Grounding
      </span>
      <select
        value={value}
        disabled={busy}
        aria-label="Grounding mode"
        onChange={(event) => {
          void handleChange(event.target.value);
        }}
      >
        <option value="none">Model only</option>
        <option value="files" disabled={chat.connectedScope === undefined}>
          Live Files context
        </option>
        {capsules.map((capsule) => (
          <option key={capsule.id} value={`capsule:${capsule.id}`}>
            {`Knowledge capsule: ${capsule.displayName}`}
          </option>
        ))}
        {capsuleSets.map((capsuleSet) => (
          <option key={capsuleSet.id} value={`capsule-set:${capsuleSet.id}`}>
            {`Capsule set: ${capsuleSet.displayName}`}
          </option>
        ))}
      </select>
      {error !== null ? (
        <span role="alert" className="scope-connect-error">
          {error}
        </span>
      ) : null}
    </label>
  );
}

// Issue #184 — surfaces the chat's explicit connected-scope binding (set via the Files-window
// connector). Rendered above the message log so screen-reader users hear the live-region
// announce when the binding flips. The pill self-hides when no scope is bound.
function ChatScopeHeader({
  chat,
  onChatChanged,
}: {
  readonly chat: Chat;
  readonly onChatChanged: (chat: Chat) => void;
}): ReactNode {
  return (
    <div
      className="chat-scope-header"
      style={{ padding: "6px 12px", display: "flex", gap: 12, flexWrap: "wrap" }}
    >
      {chat.connectedScope !== undefined ? (
        <ConnectedScopePill chat={chat} onDisconnect={onChatChanged} />
      ) : null}
      <LocalKnowledgeScopeControl chat={chat} onChatChanged={onChatChanged} />
    </div>
  );
}

// Issue #185 — surface the latest grounded answer's citations + uncertainty + omitted-count
// directly under the assistant bubble it explains. Hidden when there is no grounded turn yet
// or when the active chat carries no connectedScope binding (regular gateway chats never
// produce one). Rendered as a single live region so screen-reader users hear it on update.
function GroundedAnswerPanel({
  chat,
  answer,
  busy,
}: {
  readonly chat: Chat | undefined;
  readonly answer: GroundedAnswerWire | undefined;
  readonly busy: boolean;
}): ReactNode {
  if (chat === undefined) return null;
  if (chat.connectedScope === undefined && chat.localKnowledgeScope === undefined) return null;
  if (answer === undefined && !busy) return null;
  return (
    <div className="chatw-grounded" aria-live="polite">
      <GroundedAnswer answer={answer} busy={busy} />
    </div>
  );
}

export function ChatWindow({ mini = false, linkedRoot = null }: ChatWindowProps): ReactNode {
  const session = useChatSessionContext();
  const {
    messages,
    draft,
    loading,
    sending,
    error,
    sendMessage,
    cancelGrounded,
    activeChat,
    replaceChat,
    latestGrounded,
  } = session;
  const ready = draft.trim().length > 0 && !sending && !loading;
  const visible = visibleOnly(messages);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [visible.length, sending]);

  if (mini) {
    return (
      <div className="chatw chatw-mini">
        {linkedRoot !== null ? <ChatContext root={linkedRoot} /> : null}
        {activeChat !== undefined ? (
          <ChatScopeHeader chat={activeChat} onChatChanged={replaceChat} />
        ) : null}
        <MiniChat session={session} ready={ready} />
      </div>
    );
  }

  return (
    <div className="chatw">
      {linkedRoot !== null ? <ChatContext root={linkedRoot} /> : null}
      {activeChat !== undefined ? (
        <ChatScopeHeader chat={activeChat} onChatChanged={replaceChat} />
      ) : null}
      <div className="chatw-scroll" ref={scrollRef} aria-live="polite">
        {visible.length === 0 ? (
          <ChatHero session={session} ready={ready} />
        ) : (
          <div className="chatw-log">
            {visible.map((message) => (
              <ChatBubble key={message.id} message={message} />
            ))}
            {sending ? (
              <div className="chatw-typing-row">
                <TypingBubble />
                {activeChat?.connectedScope !== undefined ||
                activeChat?.localKnowledgeScope !== undefined ? (
                  <button
                    type="button"
                    className="grounded-cancel-btn"
                    aria-label="Cancel grounded request"
                    onClick={cancelGrounded}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            ) : null}
            <GroundedAnswerPanel chat={activeChat} answer={latestGrounded} busy={sending} />
          </div>
        )}
      </div>

      {visible.length > 0 ? (
        <div className="chatw-foot">
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            <ComposerCore
              session={session}
              ready={ready}
              placeholder="Ask Keiko about your code..."
            />
            {error !== undefined ? (
              <div role="alert" className="cmp-err">
                {error}
              </div>
            ) : null}
          </form>
        </div>
      ) : null}

      {visible.length === 0 && error !== undefined ? (
        <div className="chatw-foot">
          <div role="alert" className="cmp-err">
            {error}
          </div>
        </div>
      ) : null}
    </div>
  );
}
