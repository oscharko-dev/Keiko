"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useChatSessionContext } from "./context/ChatSessionContext";
import { ConnectedScopePill } from "./ConnectedScopePill";
import { GroundedAnswer } from "./GroundedAnswer";
import { Icons } from "./Icons";
import {
  AttachButton,
  AttachDropZone,
  AttachmentStrip,
  AttachRejectionAlert,
} from "./AttachmentStrip";
import type { ChatSessionApi } from "./hooks/useChatSession";
import type { AttachmentRejectionReason } from "./hooks/useChatSession";
import type {
  Chat,
  ChatMessage,
  GroundedAnswer as GroundedAnswerWire,
  ModelCapability,
  ProjectWithAvailability,
} from "@/lib/types";

interface ChatWindowProps {
  readonly mini?: boolean;
  readonly linkedRoot?: string | null;
}

// AC #1 — voice is not yet implemented. Gate on a constant so that when the
// capability flag arrives the removal is a one-line change, not a search.
const VOICE_SUPPORTED = false;

// Stable id for the no-model alert so aria-describedby chains can reference it.
const NO_MODEL_ALERT_ID = "cmp-no-model-alert";

// Stable id for the "type a message" send-button hint for aria-describedby.
const SEND_HINT_ID = "cmp-send-hint";

// Workspace-aware starter prompts for the empty state.
function starterPrompts(activeProject: ProjectWithAvailability | undefined): readonly string[] {
  if (activeProject !== undefined) {
    return [
      `Explain the architecture of ${activeProject.name}`,
      `Find a bug in ${activeProject.name}`,
      `Write tests for ${activeProject.name}`,
    ];
  }
  return [
    "Explain the architecture of this codebase",
    "Find and fix a bug in the workspace store",
    "Write tests for the window manager",
  ];
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function visibleOnly(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role === "user" || m.role === "assistant");
}

// No fallback to a placeholder model id — when no eligible models are
// configured the caller renders a noEligibleModels error instead (AC #4).
function modelList(models: readonly ModelCapability[]): readonly ModelCapability[] {
  return models;
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
  readonly selectedModelCapability: ModelCapability | undefined;
  readonly onAttachFiles: (files: readonly File[]) => void;
}

function ComposerBar({
  session,
  ready,
  selectedModelCapability,
  onAttachFiles,
}: ComposerBarProps): ReactNode {
  const { models, selectedModel, setSelectedModel, noEligibleModels, loading } = session;
  // AC #1 / AC #4: when no eligible model is configured the send button must be
  // focusable (so screen-reader users discover the error) but must not submit.
  // Use aria-disabled rather than the HTML disabled attribute so focus is retained.
  const sendBlocked = noEligibleModels || !ready;

  // AC #2: aria-describedby chains:
  // - model select → NO_MODEL_ALERT_ID when noEligibleModels
  // - send button  → NO_MODEL_ALERT_ID when noEligibleModels, else SEND_HINT_ID when !ready
  const selectDescribedBy = noEligibleModels ? NO_MODEL_ALERT_ID : undefined;
  const sendDescribedBy = noEligibleModels ? NO_MODEL_ALERT_ID : !ready ? SEND_HINT_ID : undefined;

  // AC #2 / title for disabled model select.
  const selectTitle = noEligibleModels
    ? "No conversation-eligible model is configured — connect a gateway in Settings"
    : "Model";

  return (
    <div className="cmp-bar">
      {/* Issue #147: real AttachButton replaces the placeholder "Attach (coming soon)" button */}
      <AttachButton model={selectedModelCapability} onFiles={onAttachFiles} />
      <button type="button" className="cmp-mode" title="Mode">
        <Icons.spark size={14} style={{ color: "var(--accent)" }} /> Build
        <Icons.chevron size={12} />
      </button>
      <span className="spacer" />
      {/* AC #3: loading state — show a "Loading models…" option while bootstrapping */}
      <label className="cmp-model mono" title={selectTitle}>
        <Icons.cube size={13} style={{ color: "var(--accent)" }} />
        <select
          className="cmp-model-select"
          value={loading ? "" : (selectedModel ?? "")}
          aria-label="Model"
          aria-disabled={noEligibleModels || loading ? "true" : undefined}
          aria-describedby={selectDescribedBy}
          title={selectTitle}
          disabled={noEligibleModels || loading}
          onChange={(event) => setSelectedModel(event.target.value)}
        >
          {loading ? (
            <option value="" disabled>
              Loading models…
            </option>
          ) : (
            modelList(models).map((model) => (
              <option key={model.id} value={model.id}>
                {model.id}
              </option>
            ))
          )}
        </select>
        <Icons.chevron size={12} />
      </label>
      {/* AC #1: voice button omitted — VOICE_SUPPORTED is false.
          When the capability flag arrives, render this block only when VOICE_SUPPORTED is true. */}
      {VOICE_SUPPORTED ? (
        <button type="button" className="cmp-icon" aria-label="Voice" title="Voice">
          <Icons.mic size={16} />
        </button>
      ) : null}
      {/* AC #2: visually-hidden hint for screen readers when send is blocked by empty draft */}
      {sendDescribedBy === SEND_HINT_ID ? (
        <span id={SEND_HINT_ID} className="sr-only">
          Type a message to send
        </span>
      ) : null}
      <button
        type={noEligibleModels ? "button" : "submit"}
        className="cmp-send"
        data-on={!sendBlocked}
        aria-disabled={sendBlocked}
        aria-describedby={sendDescribedBy}
        title={
          noEligibleModels
            ? "No conversation-eligible model is configured — connect a gateway in Settings"
            : !ready
              ? "Type a message to send"
              : "Send message"
        }
        disabled={!noEligibleModels && !ready}
        aria-label="Send message"
      >
        <Icons.arrowUp size={16} />
      </button>
    </div>
  );
}

// AC #1: rendered when no conversation-eligible model is configured. Uses
// role="alert" so screen readers announce immediately on mount. Uses gw-error
// CSS class (var(--fg) text) for WCAG AA contrast compliance.
// Stable id enables aria-describedby wiring from disabled controls (AC #2).
function NoModelAlert(): ReactNode {
  return (
    <div id={NO_MODEL_ALERT_ID} role="alert" className="gw-error cmp-no-model">
      No conversation-eligible model is configured. Connect a gateway in Settings to enable chat.
    </div>
  );
}

// AC #3: rendered while session.loading is true. role="status" (polite) so
// screen-reader users hear the state without interruption. No fake progress
// percentage — engineering note forbids it.
function LoadingStatus(): ReactNode {
  return (
    <div role="status" className="cmp-loading-status">
      <span className="cmp-loading-dot" aria-hidden="true" />
      Connecting to your gateway…
    </div>
  );
}

interface ComposerCoreProps {
  readonly session: ChatSessionApi;
  readonly ready: boolean;
  readonly placeholder: string;
}

function ComposerCore({ session, ready, placeholder }: ComposerCoreProps): ReactNode {
  const {
    draft,
    loading,
    sending,
    setDraft,
    sendMessage,
    models,
    selectedModel,
    pendingAttachments,
    addPendingAttachment,
    removePendingAttachment,
  } = session;

  // Rejection state for the inline alert (AC #2 / Part 2).
  const [rejectionReason, setRejectionReason] = useState<AttachmentRejectionReason | undefined>();
  const [rejectionMime, setRejectionMime] = useState<string | undefined>();

  const selectedModelCapability = models.find((m) => m.id === selectedModel);

  // Derive whether any attachment kinds are supported by the selected model.
  const attachEnabled =
    selectedModelCapability !== undefined &&
    (selectedModelCapability.supportsImageInput || selectedModelCapability.supportsDocumentInput);

  const handleFiles = useCallback(
    async (files: readonly File[]) => {
      // Process each file; show the first rejection encountered.
      let firstRejectionReason: AttachmentRejectionReason | undefined;
      let firstRejectionMime: string | undefined;
      for (const file of files) {
        const result = await addPendingAttachment(file);
        if (!result.ok && firstRejectionReason === undefined) {
          firstRejectionReason = result.reason;
          firstRejectionMime = file.type;
        }
      }
      setRejectionReason(firstRejectionReason);
      setRejectionMime(firstRejectionMime);
    },
    [addPendingAttachment],
  );

  return (
    <div className="cmp-box">
      {/* Drop zone above the textarea (Part 2 — shown when attachment is supported) */}
      <AttachDropZone enabled={attachEnabled} onFiles={handleFiles} />
      {/* Chip strip below the textarea, above the composer bar (AC #3) */}
      <AttachmentStrip attachments={pendingAttachments} onRemove={removePendingAttachment} />
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
      {/* Inline rejection alert — role="alert" announces immediately (AC #2) */}
      <AttachRejectionAlert reason={rejectionReason} mimeType={rejectionMime} />
      <ComposerBar
        session={session}
        ready={ready}
        selectedModelCapability={selectedModelCapability}
        onAttachFiles={handleFiles}
      />
    </div>
  );
}

// Deliverable: polished empty state when no messages are present and an active
// chat exists. Shows a welcoming headline, project-aware subhead, and 2–3
// starter-prompt buttons that prefill the composer draft.
interface EmptyComposerStateProps {
  readonly session: ChatSessionApi;
  readonly noEligibleModels: boolean;
}

function EmptyComposerState({ session, noEligibleModels }: EmptyComposerStateProps): ReactNode {
  const { activeProject, setDraft } = session;
  const prompts = starterPrompts(activeProject);
  return (
    <div className="chatw-empty">
      <h2 className="chatw-empty-headline">Start a Keiko conversation</h2>
      <p className="chatw-empty-sub">
        {activeProject !== undefined
          ? `Working in ${activeProject.name}. What would you like to explore?`
          : "Pick a project from the sidebar to scope your workspace, or ask anything below."}
      </p>
      {/* Starter prompts are only useful when a model is available */}
      {!noEligibleModels ? (
        <div className="chatw-empty-prompts" aria-label="Starter prompts">
          {prompts.map((prompt) => (
            <button type="button" key={prompt} className="suggest" onClick={() => setDraft(prompt)}>
              <Icons.spark size={12} style={{ color: "var(--accent)" }} />
              {prompt}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Rendered when no chat has been selected yet (activeChat is undefined).
// Instructs the user to pick or start a chat from the project sidebar.
function NoChatState(): ReactNode {
  return (
    <div className="chatw-empty-no-chat">
      <div className="chatw-empty-no-chat-icon" aria-hidden="true">
        <Icons.spark size={20} />
      </div>
      <p className="chatw-empty-no-chat-label">Pick or start a chat</p>
      <p className="chatw-empty-no-chat-hint">
        Select a conversation from the project sidebar, or create a new one to get started.
      </p>
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
        {starterPrompts(activeProject).map((prompt) => (
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
          type={ready ? "submit" : "button"}
          className="cmp-send cmp-send-float"
          data-on={ready}
          aria-disabled={!ready}
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
  if (chat.connectedScope === undefined) return null;
  return (
    <div className="chat-scope-header" style={{ padding: "6px 12px" }}>
      <ConnectedScopePill chat={chat} onDisconnect={onChatChanged} />
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
  if (chat.connectedScope === undefined) return null;
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
    noEligibleModels,
    sendMessage,
    cancelGrounded,
    activeChat,
    replaceChat,
    latestGrounded,
  } = session;
  // AC #1: block ready when no model is available — do not allow submission.
  const ready = draft.trim().length > 0 && !sending && !loading && !noEligibleModels;
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
        {noEligibleModels ? <NoModelAlert /> : null}
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
      {noEligibleModels ? (
        <div className="chatw-foot">
          <NoModelAlert />
        </div>
      ) : null}
      {/* AC #3: loading status — polite live region, non-technical wording */}
      {loading ? (
        <div className="chatw-foot">
          <LoadingStatus />
        </div>
      ) : null}
      <div className="chatw-scroll" ref={scrollRef} aria-live="polite">
        {visible.length === 0 ? (
          activeChat !== undefined ? (
            <EmptyComposerState session={session} noEligibleModels={noEligibleModels} />
          ) : (
            <NoChatState />
          )
        ) : (
          <div className="chatw-log">
            {visible.map((message) => (
              <ChatBubble key={message.id} message={message} />
            ))}
            {sending ? (
              <div className="chatw-typing-row">
                <TypingBubble />
                {activeChat?.connectedScope !== undefined ? (
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

      {/* Composer for empty state with active chat — the EmptyComposerState shows the
          welcoming content above, and the form wraps the input below. */}
      {visible.length === 0 && activeChat !== undefined ? (
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
              placeholder={loading ? "Connecting to your gateway…" : "Ask Keiko about your code…"}
            />
            {error !== undefined ? (
              <div role="alert" className="cmp-err">
                {error}
              </div>
            ) : null}
          </form>
        </div>
      ) : null}

      {visible.length === 0 && error !== undefined && activeChat === undefined ? (
        <div className="chatw-foot">
          <div role="alert" className="cmp-err">
            {error}
          </div>
        </div>
      ) : null}
    </div>
  );
}
