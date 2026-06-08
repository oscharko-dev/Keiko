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
import { ConnectorScopePill } from "./ConnectorScopePill";
import { BudgetIndicator, BUDGET_EXCEEDED_ALERT_ID } from "./ContextBudget";
import { GroundedAnswer } from "./GroundedAnswer";
import { Icons } from "./Icons";
import { SafeMarkdownBoundary } from "./SafeMarkdown";
import {
  AttachButton,
  AttachDropZone,
  AttachmentStrip,
  AttachRejectionAlert,
  SentDocumentsNote,
} from "./AttachmentStrip";
import { isRunSummaryMessage, LaunchWorkflowButton, RunSummaryCard } from "./WorkflowHandoff";
import { Toggle } from "./widgets/shared/Toggle";
import { isBudgetExceeded, type ChatSessionApi, type SendStatus } from "./hooks/useChatSession";
import type { AttachmentRejectionReason } from "./hooks/useChatSession";
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
  ConversationMemoryActionWire,
  ConversationMemoryResultWire,
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

// Stable id for the loading status so blocked actions can reference it.
const LOADING_STATUS_ID = "cmp-loading-status";

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

// Issue #153 — system messages that carry a workflow runId are rendered inline as
// RunSummaryCards (the chat-side projection of the run). Other system messages keep
// the historical "filtered out of the visible log" behaviour.
function visibleOnly(messages: readonly ChatMessage[]): ChatMessage[] {
  // Issue #152 — the streaming path inserts an empty assistant bubble before the first token
  // arrives; while it is empty the pending turn is represented by the TypingBubble, so an empty
  // assistant turn is hidden here to avoid a duplicate "Keiko" bubble during the contacting wait.
  // Persisted assistant turns are never empty (createAssistantMessage substitutes a placeholder).
  return messages.filter(
    (m) =>
      m.role === "user" ||
      (m.role === "assistant" && m.content.length > 0) ||
      isRunSummaryMessage(m),
  );
}

// No fallback to a placeholder model id — when no eligible models are
// configured the caller renders a noEligibleModels error instead (AC #4).
function modelList(models: readonly ModelCapability[]): readonly ModelCapability[] {
  return models.filter((model) => model.kind === "chat");
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
  // Issue #153 — system messages carrying a workflow runId render as a structural run-summary
  // card rather than a conversation bubble. AC#3: this keeps the run visible in the chat
  // without weakening evidence semantics (the BFF's persisted runId is still the source of
  // truth; this surface is read-only and never exposes apply/exec — AC#4).
  if (isRunSummaryMessage(message)) {
    return <RunSummaryCard message={message} />;
  }
  const isUser = message.role === "user";
  return (
    <article className="chat-msg" data-role={message.role}>
      <div className="chat-msg-bubble">
        <div className="chat-msg-role">{isUser ? "You" : "Keiko"}</div>
        {isUser ? (
          message.content
        ) : (
          // AC #1 / #2: assistant responses render as safe markdown.
          // User messages remain plain text — no markdown interpretation.
          // SM-1: wrapped in a per-message boundary so a parser/render defect
          // degrades this one bubble to plain text instead of crashing the view.
          <SafeMarkdownBoundary source={message.content} />
        )}
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
  // Issue #151 — when true, the budget for the next send exceeds the model's
  // window and the send button must be focusable but inert.
  readonly budgetExceeded: boolean;
}

function ComposerBar({
  session,
  ready,
  selectedModelCapability,
  onAttachFiles,
  budgetExceeded,
}: ComposerBarProps): ReactNode {
  const {
    models,
    selectedModel,
    setSelectedModel,
    draft,
    noEligibleModels,
    loading,
    sending,
    cancelSend,
    launchWorkflowFromConversation,
  } = session;
  // AC #1 / AC #4: when no eligible model is configured the send button must be
  // focusable (so screen-reader users discover the error) but must not submit.
  // Use aria-disabled rather than the HTML disabled attribute so focus is retained.
  // Issue #151 — budget-exceeded also blocks send.
  const sendBlocked = noEligibleModels || budgetExceeded || !ready;
  const draftEmpty = draft.trim().length === 0;

  // AC #2: aria-describedby chains:
  // - model select → NO_MODEL_ALERT_ID when noEligibleModels
  // - send button  → NO_MODEL_ALERT_ID when noEligibleModels,
  //                  BUDGET_EXCEEDED_ALERT_ID when context exceeded,
  //                  LOADING_STATUS_ID while bootstrapping,
  //                  else SEND_HINT_ID when only the draft is empty
  const selectDescribedBy = noEligibleModels ? NO_MODEL_ALERT_ID : undefined;
  const sendDescribedBy = noEligibleModels
    ? NO_MODEL_ALERT_ID
    : budgetExceeded
      ? BUDGET_EXCEEDED_ALERT_ID
      : loading
        ? LOADING_STATUS_ID
        : draftEmpty
          ? SEND_HINT_ID
          : undefined;

  // AC #2 / title for disabled model select.
  const selectTitle = noEligibleModels
    ? "No conversation-eligible model is configured — connect a gateway in Settings"
    : "Model";
  const selectValue = loading || noEligibleModels ? "" : (selectedModel ?? "");

  return (
    <div className="cmp-bar">
      {/* Issue #147: real AttachButton replaces the placeholder "Attach (coming soon)" button */}
      <AttachButton model={selectedModelCapability} onFiles={onAttachFiles} />
      <span className="spacer" />
      {/* AC #3: loading state — show a "Loading models…" option while bootstrapping */}
      <label className="cmp-model mono" title={selectTitle}>
        <Icons.cube size={13} style={{ color: "var(--accent)" }} />
        <select
          className="cmp-model-select"
          value={selectValue}
          aria-label="Model"
          aria-disabled={noEligibleModels || loading ? "true" : undefined}
          aria-describedby={selectDescribedBy}
          title={selectTitle}
          disabled={loading}
          onChange={(event) => {
            if (noEligibleModels || loading) return;
            setSelectedModel(event.target.value);
          }}
        >
          {loading ? (
            <option value="" disabled>
              Loading models…
            </option>
          ) : noEligibleModels ? (
            <option value="">No conversation-eligible model</option>
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
      {/* Issue #153: explicit Launch-workflow affordance. Hidden when no
          workflow-eligible model is selected (AC#2). Opens the picker dialog
          only on explicit user click (AC#1). */}
      <LaunchWorkflowButton
        selectedModel={selectedModelCapability}
        launch={launchWorkflowFromConversation}
      />
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
      {/* Issue #152 — while a send is in flight the primary action button
          flips to "Cancel response" (AC#1 + AC#3). Type="button" so it never
          submits the surrounding form; onClick calls cancelSend which is a
          safe no-op when the status is already terminal. */}
      {sending ? (
        <button
          type="button"
          className="cmp-send cmp-send-cancel"
          data-on
          aria-label="Cancel response"
          title="Cancel response"
          onClick={cancelSend}
        >
          <Icons.close size={16} />
        </button>
      ) : (
        <button
          type={sendBlocked ? "button" : "submit"}
          className="cmp-send"
          data-on={!sendBlocked}
          aria-disabled={sendBlocked}
          aria-describedby={sendDescribedBy}
          title={
            noEligibleModels
              ? "No conversation-eligible model is configured — connect a gateway in Settings"
              : budgetExceeded
                ? "Context exceeds the model's window — clear history or pick a larger-context model"
                : loading
                  ? "Connecting to your gateway"
                  : draftEmpty
                    ? "Type a message to send"
                    : "Send message"
          }
          aria-label="Send message"
        >
          <Icons.arrowUp size={16} />
        </button>
      )}
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
    <div id={LOADING_STATUS_ID} role="status" className="cmp-loading-status">
      <span className="cmp-loading-dot" aria-hidden="true" />
      Connecting to your gateway…
    </div>
  );
}

// Issue #152 — user-facing copy per lifecycle state. Engineering note: NO
// fake progress percentage. The strings here are the only progress signal.
// Exported so the Streaming.test asserts on canonical copy without
// duplicating it.
export function sendStatusLabel(status: SendStatus): string {
  switch (status) {
    case "idle":
      return "";
    case "queued":
      return "Submitting your message…";
    case "contacting":
      return "Contacting model…";
    case "streaming":
      return "Receiving response…";
    case "completed":
      return "";
    case "failed":
      return "";
    case "cancelled":
      return "Response cancelled.";
  }
}

// Issue #152 / AC#1 + AC#4 — assistive announcement of the send lifecycle.
// role="status" + aria-live="polite" so screen-reader users hear transitions
// without interruption. Hidden when there is nothing to say (idle/completed/
// failed — the error string carries its own role="alert").
function SendLifecycleStatus({ status }: { readonly status: SendStatus }): ReactNode {
  const label = sendStatusLabel(status);
  if (label.length === 0) return null;
  return (
    <div role="status" aria-live="polite" data-send-status={status} className="cmp-send-status">
      <span className="cmp-loading-dot" aria-hidden="true" />
      {label}
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
    sendStatus,
    setDraft,
    sendMessage,
    models,
    selectedModel,
    pendingAttachments,
    addPendingAttachment,
    removePendingAttachment,
    budget,
    clearHistory,
  } = session;
  // Issue #151 — budget can be undefined while bootstrapping; treat that as
  // not-exceeded so the composer remains submittable. CB-F1: a runtime-configured
  // model with contextWindow 0 reports pressure "exceeded" from the estimator but
  // has no real window — it must NOT block send (and BudgetIndicator self-hides),
  // so we gate on contextWindowTokens > 0 via the shared predicate. This also keeps
  // aria-describedby from dangling at a BudgetIndicator that renders nothing.
  const budgetExceeded = isBudgetExceeded(budget);

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
      {/* Issue #152 / AC#1 + AC#4 — lifecycle status announcement. Renders
          adjacent to the textarea so SR users hear the state without losing
          composer focus. Hidden when there is nothing to announce. */}
      <SendLifecycleStatus status={sendStatus} />
      {/* Issue #151 — context-pressure indicator + clear-history affordance */}
      <BudgetIndicator
        budget={budget}
        onClearHistory={clearHistory}
        disabled={sending || loading}
      />
      <ComposerBar
        session={session}
        ready={ready}
        selectedModelCapability={selectedModelCapability}
        onAttachFiles={handleFiles}
        budgetExceeded={budgetExceeded}
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
        {activeProject !== undefined && (
          <button type="button" className="chip">
            <Icons.folder size={14} style={{ color: "var(--accent)" }} />
            <span className="chip-label">{activeProject.name}</span>
            <Icons.chevron size={12} style={{ color: "var(--fg-faint)" }} />
          </button>
        )}
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
  const { draft, loading, sending, sendStatus, cancelSend, setDraft, sendMessage } = session;
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
        {/* ST-F1 — match ComposerBar: while a send is in flight the primary
            action flips to "Cancel response" (#152 AC#3) so the mini composer
            offers the same cancel affordance as the full composer. */}
        {sending ? (
          <button
            type="button"
            className="cmp-send cmp-send-float cmp-send-cancel"
            data-on
            aria-label="Cancel response"
            title="Cancel response"
            onClick={cancelSend}
          >
            <Icons.close size={16} />
          </button>
        ) : (
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
        )}
      </div>
      {/* ST-F1 — #152 AC#3 lifecycle status region for the mini composer. */}
      <SendLifecycleStatus status={sendStatus} />
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

interface ScopeOption {
  readonly value: string;
  readonly label: string;
}

function capsuleOptions(chat: Chat, capsules: readonly CapsuleListEntry[]): readonly ScopeOption[] {
  const options = capsules.map((capsule) => ({
    value: `capsule:${capsule.id}`,
    label: `Knowledge capsule: ${capsule.displayName}`,
  }));
  const selectedValue = groundedModeValue(chat);
  if (!selectedValue.startsWith("capsule:")) {
    return options;
  }
  if (options.some((option) => option.value === selectedValue)) {
    return options;
  }
  const capsuleId = selectedValue.slice("capsule:".length);
  return [
    ...options,
    {
      value: selectedValue,
      label: `Knowledge capsule: ${capsuleId} (not ready)`,
    },
  ];
}

function capsuleSetOptions(
  chat: Chat,
  capsuleSets: readonly CapsuleSetListEntry[],
): readonly ScopeOption[] {
  const options = capsuleSets.map((capsuleSet) => ({
    value: `capsule-set:${capsuleSet.id}`,
    label: `Capsule set: ${capsuleSet.displayName}`,
  }));
  const selectedValue = groundedModeValue(chat);
  if (!selectedValue.startsWith("capsule-set:")) {
    return options;
  }
  if (options.some((option) => option.value === selectedValue)) {
    return options;
  }
  const capsuleSetId = selectedValue.slice("capsule-set:".length);
  return [
    ...options,
    {
      value: selectedValue,
      label: `Capsule set: ${capsuleSetId} (unavailable)`,
    },
  ];
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
        const [capsuleResult, capsuleSetResult] = await Promise.allSettled([
          fetchCapsules(),
          fetchCapsuleSets(),
        ]);
        if (capsuleResult.status !== "fulfilled") {
          throw capsuleResult.reason;
        }
        if (cancelled) return;
        setCapsules(
          capsuleResult.value.capsules.filter((entry) => entry.lifecycleState === "ready"),
        );
        if (capsuleSetResult.status === "fulfilled") {
          setCapsuleSets(capsuleSetResult.value.capsuleSets);
        } else {
          setCapsuleSets([]);
          setError(formatScopeUpdateError(capsuleSetResult.reason));
        }
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
  const capsuleChoices = capsuleOptions(chat, capsules);
  const capsuleSetChoices = capsuleSetOptions(chat, capsuleSets);
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
        {capsuleChoices.map((capsule) => (
          <option key={capsule.value} value={capsule.value}>
            {capsule.label}
          </option>
        ))}
        {capsuleSetChoices.map((capsuleSet) => (
          <option key={capsuleSet.value} value={capsuleSet.value}>
            {capsuleSet.label}
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
      {/* Folder pills: one per connected folder/file source (1+N, #532). Self-guards to null. */}
      <ConnectedScopePill chat={chat} onDisconnect={onChatChanged} />
      {/* Connector pills: one per Local Knowledge connector source (#189 Slice 3 M4). Mixed N. */}
      <ConnectorScopePill chat={chat} onDisconnect={onChatChanged} />
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
  // Show the grounded panel when the chat has ANY scope binding (folder or connector, singular or
  // plural). This covers the legacy single-source fields and the #532/#189 plural list fields.
  const hasFolderScope =
    chat.connectedScope !== undefined ||
    (chat.connectedScopes !== undefined && chat.connectedScopes.length > 0);
  const hasConnectorScope =
    chat.localKnowledgeScope !== undefined ||
    (chat.localKnowledgeScopes !== undefined && chat.localKnowledgeScopes.length > 0);
  if (!hasFolderScope && !hasConnectorScope) return null;
  if (answer === undefined && !busy) return null;
  return (
    <div className="chatw-grounded" aria-live="polite">
      <GroundedAnswer answer={answer} busy={busy} />
    </div>
  );
}

function MemoryActionCard({
  action,
  acceptCandidate,
  rejectCandidate,
  forgetMemoryAction,
}: {
  readonly action: ConversationMemoryActionWire;
  readonly acceptCandidate: (proposalId: string) => Promise<void>;
  readonly rejectCandidate: (proposalId: string) => Promise<void>;
  readonly forgetMemoryAction: (memoryId: string) => Promise<void>;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [confirmForget, setConfirmForget] = useState(false);
  if (action.kind === "candidate") {
    return (
      <article className="chat-memory-action">
        <div className="chat-memory-action-head">
          <strong>{action.scopeLabel}</strong>
          <span>{action.requiresApproval ? "Approval required" : "Proposed memory"}</span>
        </div>
        <p>{action.body}</p>
        <div className="chat-memory-action-buttons">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void acceptCandidate(action.proposalId)
                .catch((caught) => {
                  setError(caught instanceof Error ? caught.message : "Unable to accept memory.");
                })
                .finally(() => setBusy(false));
            }}
          >
            Accept
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void rejectCandidate(action.proposalId)
                .catch((caught) => {
                  setError(caught instanceof Error ? caught.message : "Unable to reject memory.");
                })
                .finally(() => setBusy(false));
            }}
          >
            Reject
          </button>
        </div>
        {error !== undefined ? (
          <div role="alert" className="cmp-err">
            {error}
          </div>
        ) : null}
      </article>
    );
  }
  if (action.kind === "update") {
    return (
      <article className="chat-memory-action">
        <div className="chat-memory-action-head">
          <strong>MemoriaViva update detected</strong>
          <span>{action.memoryId}</span>
        </div>
        <p>
          {action.bodyPatch !== undefined
            ? `Suggested update: ${action.bodyPatch}`
            : "Suggested update."}
        </p>
      </article>
    );
  }
  if (action.kind === "forget") {
    const executeForget = (): void => {
      setBusy(true);
      setError(undefined);
      void forgetMemoryAction(action.memoryId)
        .then(() => setConfirmForget(false))
        .catch((caught) => {
          setError(caught instanceof Error ? caught.message : "Unable to forget memory.");
        })
        .finally(() => setBusy(false));
    };
    return (
      <article className="chat-memory-action">
        <div className="chat-memory-action-head">
          <strong>MemoriaViva forget detected</strong>
          <span>{action.requiresConfirmation ? "Confirmation required" : action.memoryId}</span>
        </div>
        <p>{`Matched memory ${action.memoryId} for a forget operation.`}</p>
        <div className="chat-memory-action-buttons">
          {!action.requiresConfirmation ? (
            <button type="button" disabled={busy} onClick={executeForget}>
              Forget
            </button>
          ) : !confirmForget ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(undefined);
                setConfirmForget(true);
              }}
            >
              Review forget
            </button>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={executeForget}>
                Forget permanently
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setError(undefined);
                  setConfirmForget(false);
                }}
              >
                Cancel
              </button>
            </>
          )}
        </div>
        {error !== undefined ? (
          <div role="alert" className="cmp-err">
            {error}
          </div>
        ) : null}
      </article>
    );
  }
  return (
    <article className="chat-memory-action">
      <div className="chat-memory-action-head">
        <strong>MemoriaViva action not created</strong>
      </div>
      <p>{action.reason}</p>
    </article>
  );
}

function MemoryPanel({
  memoryEnabled,
  setMemoryEnabled,
  memoryBudgetTokens,
  setMemoryBudgetTokens,
  latestMemory,
  acceptCandidate,
  rejectCandidate,
  forgetMemoryAction,
}: {
  readonly memoryEnabled: boolean;
  readonly setMemoryEnabled: (next: boolean) => void;
  readonly memoryBudgetTokens: number;
  readonly setMemoryBudgetTokens: (next: number) => void;
  readonly latestMemory: ConversationMemoryResultWire | undefined;
  readonly acceptCandidate: (proposalId: string) => Promise<void>;
  readonly rejectCandidate: (proposalId: string) => Promise<void>;
  readonly forgetMemoryAction: (memoryId: string) => Promise<void>;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const disclosureId = "chat-memory-disclosure";
  const memoryCount = latestMemory?.context.memories.length ?? 0;
  return (
    <section className="chat-memory-panel" aria-label="Conversation memory">
      <div className="chat-memory-panel-head">
        <div className="chat-memory-toggle">
          <Toggle
            on={memoryEnabled}
            onChange={setMemoryEnabled}
            label="Enable memory for the next request"
          />
          <span>MemoriaViva {memoryEnabled ? "on" : "off"}</span>
        </div>
        <label className="chat-memory-budget">
          <span>Budget</span>
          <input
            type="number"
            min={0}
            step={100}
            value={memoryBudgetTokens}
            onChange={(event) =>
              setMemoryBudgetTokens(Math.max(0, Number(event.target.value) || 0))
            }
          />
        </label>
        <button
          type="button"
          className="chip"
          aria-expanded={open}
          aria-controls={disclosureId}
          onClick={() => setOpen((current) => !current)}
        >
          {memoryCount > 0 ? `${String(memoryCount)} memories included` : "No memory included"}
        </button>
      </div>
      {open ? (
        <div id={disclosureId} className="chat-memory-disclosure">
          <p className="chat-memory-summary">
            {latestMemory === undefined
              ? "MemoriaViva disclosure appears after the next response."
              : latestMemory.context.enabled
                ? `Used ${String(latestMemory.context.budget.used)} of ${String(latestMemory.context.budget.tokens)} MemoriaViva tokens.`
                : "MemoriaViva was disabled for the last request."}
          </p>
          {latestMemory?.context.memories.map((memory) => (
            <article key={memory.memoryId} className="chat-memory-item">
              <div className="chat-memory-item-head">
                <strong>{memory.memoryId}</strong>
                <span>{memory.inclusionReason}</span>
              </div>
              <p>{memory.bodyExcerpt}</p>
            </article>
          ))}
          {latestMemory?.actions.map((action) => (
            <MemoryActionCard
              key={
                action.kind === "candidate"
                  ? action.proposalId
                  : action.kind === "rejected"
                    ? action.reason
                    : action.memoryId
              }
              action={action}
              acceptCandidate={acceptCandidate}
              rejectCandidate={rejectCandidate}
              forgetMemoryAction={forgetMemoryAction}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function ChatWindow({ mini = false, linkedRoot = null }: ChatWindowProps): ReactNode {
  const session = useChatSessionContext();
  const {
    messages,
    draft,
    loading,
    sending,
    sendStatus,
    error,
    noEligibleModels,
    sendMessage,
    cancelGrounded,
    activeChat,
    replaceChat,
    latestGrounded,
    latestMemory,
    lastSentDocuments,
    memoryEnabled,
    setMemoryEnabled,
    memoryBudgetTokens,
    setMemoryBudgetTokens,
    acceptMemoryCandidate,
    rejectMemoryCandidate,
    forgetMemoryAction,
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
      {activeChat !== undefined ? (
        <MemoryPanel
          memoryEnabled={memoryEnabled}
          setMemoryEnabled={setMemoryEnabled}
          memoryBudgetTokens={memoryBudgetTokens}
          setMemoryBudgetTokens={setMemoryBudgetTokens}
          latestMemory={latestMemory}
          acceptCandidate={acceptMemoryCandidate}
          rejectCandidate={rejectMemoryCandidate}
          forgetMemoryAction={forgetMemoryAction}
        />
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
            {sending && sendStatus !== "streaming" ? (
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
            {/* Issue #148 — disclose which attached documents contributed extracted context. */}
            <SentDocumentsNote documents={lastSentDocuments} />
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
