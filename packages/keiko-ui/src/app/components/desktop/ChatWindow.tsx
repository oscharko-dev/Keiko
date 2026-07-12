"use client";

/**
 * ChatWindow — the desktop chat surface (composer + conversation thread + voice/attachment controls).
 *
 * Ownership boundary: this component owns chat UI state and orchestration only. The domain contracts
 * (chat/message/grounding wire types, connected-scope semantics) live in `@oscharko-dev/keiko-contracts`
 * and `@/lib/types`; all BFF calls go through `@/lib/api`; chat session state is provided by
 * `ChatSessionContext`; and the pure, DOM-free repository-reference string helpers (root/path
 * normalization, `@path` mention insertion/removal, mention detection) live in the sibling leaf module
 * `./chatRepositoryReference` and are imported back here. `copyableMessageText` stays in this file as
 * an exported, test-referenced helper. This file is intentionally large because it composes many
 * controls, but the reusable pure logic is factored out to keep those pieces independently testable.
 */

import Image from "next/image";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent,
  type MutableRefObject,
  type PointerEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  type SetStateAction,
  type SyntheticEvent,
} from "react";
import type {
  VoiceSessionChatContext,
  VoiceSessionGroundingContext,
} from "@oscharko-dev/keiko-contracts";
import {
  useChatSessionCatalog,
  useChatSessionComposer,
  useChatSessionContext,
  type ChatSessionComposerApi,
} from "./context/ChatSessionContext";
import { ErrorNoticeFromError } from "./ErrorNotice";
import { GroundedAnswer } from "./GroundedAnswer";
import { ContextStatusPanel } from "./ContextStatusPanel";
import { Icons } from "./Icons";
import KeikoSelect from "./KeikoSelect";
import {
  SafeMarkdownBoundary,
  type AssistantCodeBlockApply,
  type AssistantCodeBlockApplyOutcome,
} from "./SafeMarkdown";
import {
  repositoryReferenceRoots,
  sanitizeRepositoryEvidenceText,
  type OpenRepositoryReference,
  type RepositoryReferenceRoot,
} from "./repositoryReferences";
import {
  appendRepositoryReference,
  normalizedRepositoryPath,
  omitAncestorRepositoryRoots,
  removeRepositoryReferenceFromDraft,
  repositoryReferenceId,
  repositoryReferenceMentionPaths,
} from "./chatRepositoryReference";
import {
  AttachButton,
  AttachDropZone,
  AttachmentStrip,
  AttachRejectionAlert,
  SentDocumentsNote,
} from "./AttachmentStrip";
import { isRunSummaryMessage, RunSummaryCard } from "./WorkflowHandoff";
import { FileIcon } from "./widgets/shared/projectTree";
import type {
  AttachmentRejectionReason,
  ChatSessionApi,
  SendStatus,
  SentDocumentDisclosure,
} from "./hooks/useChatSession";
import {
  supportsDictation,
  supportsRealtimeVoice,
  supportsSpeechOutput,
  supportsRealtimeToolCalling,
  useVoiceCapability,
} from "./hooks/useVoiceCapability";
import { useDictation, type DictationController } from "./hooks/useDictation";
import { dictationCaptureSupported } from "./hooks/dictation-recorder";
import { realtimeVoiceTransportSupported } from "./hooks/voice-rtc-transport";
import { VoiceDictationButton, VoiceDictationPreviewFromController } from "./VoiceDictation";
import { useAssistantSpeech } from "./hooks/useAssistantSpeech";
import { VoicePlaybackMuteButton } from "./VoicePlayback";
import { useVoiceDialogMode } from "./hooks/useVoiceDialogMode";
import { useRealtimeVoice, type RealtimeVoiceController } from "./hooks/useRealtimeVoice";
import {
  usePdfCitationPreviewController,
  type CitationPreviewController,
  type PdfCitationPreviewWindowApi,
} from "./hooks/usePdfCitationPreview";
import { registerPdfCitationPreviewMessageTarget } from "./widgets/cards/pdf-citation-preview-session";
import {
  deriveVoiceAuraState,
  deriveVoiceDialogState,
  voiceAuraStateHeadline,
  type VoiceAuraIntensity,
  type VoiceAuraState,
  type VoiceAuraStateSnapshot,
} from "./hooks/voice-dialog-state";
import { VoiceDialogModeSwitch } from "./VoiceDialogMode";
import styles from "./ChatWindow.module.css";
import type { OpenEditorFileRequest, OpenEditorFileResult } from "./hooks/useWorkspace.types";
import { fetchFilesSearch, updateChat } from "@/lib/api";
import type { ChatEditorApplyOutcome } from "@/lib/chat-editor-apply";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { formatUserError } from "./format-error";
import {
  capsulesForKnowledgePodUi,
  capsuleSetsForKnowledgePodUi,
  fetchCapsules,
  fetchCapsuleSets,
  type CapsuleListEntry,
  type CapsuleSetListEntry,
} from "@/lib/local-knowledge-api";
import type {
  Chat,
  ChatMessage,
  ChatConnectedScope,
  ChatLocalKnowledgeScope,
  ConversationMemoryActionWire,
  ConversationMemoryResultWire,
  FilesSearchResult,
  GroundedAnswer as GroundedAnswerWire,
  GroundedAnswerContextSummary as GroundedAnswerContextSummaryWire,
  ModelCapability,
  VoiceCapabilityResolution,
} from "@/lib/types";

interface ChatWindowProps {
  readonly windowId?: string;
  readonly mini?: boolean;
  readonly minimalChat?: boolean;
  readonly compact?: boolean;
  readonly controlsNarrow?: boolean;
  readonly barCompact?: boolean;
  readonly workflowCompact?: boolean;
  readonly linkedRoot?: string | null;
  readonly linkedRoots?: readonly string[];
  readonly openEditorFile?: ((request: OpenEditorFileRequest) => OpenEditorFileResult) | undefined;
  readonly previewWindows?: PdfCitationPreviewWindowApi | undefined;
  readonly onOpenRunResult?: ((message: ChatMessage) => void) | undefined;
}

// Stable id for the no-model alert so aria-describedby chains can reference it.
const NO_MODEL_ALERT_ID = "cmp-no-model-alert";

// Stable id for the "type a message" send-button hint for aria-describedby.
const SEND_HINT_ID = "cmp-send-hint";

// Stable id for the loading status so blocked actions can reference it.
const LOADING_STATUS_ID = "cmp-loading-status";

// Stable ids wiring the composer textarea (role="combobox") to the repository
// @-mention results (role="listbox"). aria-controls references the listbox and
// aria-activedescendant references the highlighted option while the picker is
// open, so the combobox keeps DOM focus on the textarea (WCAG combobox pattern).
const REPO_FILE_PICKER_LISTBOX_ID = "repo-file-picker-listbox";
function repositoryFilePickerOptionId(index: number): string {
  return `repo-file-picker-option-${index}`;
}

const CHAT_TURN_WINDOW_THRESHOLD = 120;
const CHAT_TURN_WINDOW_SIZE = 80;
const CHAT_TURN_WINDOW_OVERSCAN = 8;
// Debounce for the spoken-dialogue status live region: rapid aura transitions in a fast turn exchange
// settle before a screen reader announces, so it hears the meaningful state, not every flicker.
const DIALOG_ANNOUNCE_DEBOUNCE_MS = 400;
const CHAT_TURN_ESTIMATED_BLOCK_SIZE_PX = 132;
// GEN-PERF-CHAT-015 — below the windowing threshold every turn is fully rendered; with
// code-block/citation-heavy answers that is ~150-200 DOM nodes per turn, all paying
// layout/paint even when scrolled out of the window's viewport. content-visibility lets
// the browser skip rendering work for off-screen turns (same idiom as WindowFrame's
// win-body containment and globals.css .fpv-line). `auto` in contain-intrinsic-size
// remembers each turn's real size after first render, so scrollbar geometry stays honest;
// the constant seeds the estimate exactly like the windowing spacer does. Inline style —
// globals.css is SHA-gated (#1300) and must not grow for this.
const CHAT_TURN_CONTENT_VISIBILITY_STYLE: CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: `auto ${String(CHAT_TURN_ESTIMATED_BLOCK_SIZE_PX)}px`,
};

function timeLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // uiux-fix F041 (C176) — chats persist across days/weeks: a bare "14:32" from
  // last week is indistinguishable from today's, so older messages carry a date.
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

// Issue #153 — system messages that carry a workflow runId are rendered inline as
// RunSummaryCards (the chat-side projection of the run). Other system messages keep
// the historical "filtered out of the visible log" behaviour.
function visibleOnly(messages: readonly ChatMessage[]): ChatMessage[] {
  // Issue #152 — while the stream is empty, the pending turn is represented by
  // TypingBubble; empty assistant turns are hidden to avoid a duplicate "Keiko"
  // bubble during the contacting wait.
  // Persisted assistant turns are never empty; empty provider responses fail before persistence.
  return messages.filter(
    (m) =>
      m.role === "user" ||
      (m.role === "assistant" && m.content.length > 0) ||
      isRunSummaryMessage(m),
  );
}

interface ConversationTurn {
  readonly id: string;
  readonly user: ChatMessage | null;
  readonly responses: readonly ChatMessage[];
}

function conversationTurns(messages: readonly ChatMessage[]): readonly ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let current: { id: string; user: ChatMessage | null; responses: ChatMessage[] } | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      current = { id: message.id, user: message, responses: [] };
      turns.push(current);
      continue;
    }

    if (current === null) {
      current = { id: message.id, user: null, responses: [] };
      turns.push(current);
    }
    current.responses.push(message);
  }

  return turns;
}

interface ConversationTurnWindow {
  readonly turns: readonly ConversationTurn[];
  readonly beforeCount: number;
  readonly afterCount: number;
}

function turnContainsMessage(turn: ConversationTurn, messageId: string): boolean {
  if (turn.user?.id === messageId) return true;
  return turn.responses.some((response) => response.id === messageId);
}

function conversationTurnWindow(
  turns: readonly ConversationTurn[],
  focusedMessageId: string | null,
): ConversationTurnWindow {
  if (turns.length <= CHAT_TURN_WINDOW_THRESHOLD) {
    return { turns, beforeCount: 0, afterCount: 0 };
  }

  let start = Math.max(0, turns.length - CHAT_TURN_WINDOW_SIZE);
  if (focusedMessageId !== null) {
    const focusedIndex = turns.findIndex((turn) => turnContainsMessage(turn, focusedMessageId));
    if (
      focusedIndex >= 0 &&
      (focusedIndex < start || focusedIndex >= start + CHAT_TURN_WINDOW_SIZE)
    ) {
      start = Math.max(0, focusedIndex - CHAT_TURN_WINDOW_OVERSCAN);
    }
  }
  const end = Math.min(turns.length, start + CHAT_TURN_WINDOW_SIZE);
  return {
    turns: turns.slice(start, end),
    beforeCount: start,
    afterCount: turns.length - end,
  };
}

function conversationTurnSpacerStyle(hiddenTurns: number): CSSProperties {
  return { blockSize: `${String(hiddenTurns * CHAT_TURN_ESTIMATED_BLOCK_SIZE_PX)}px` };
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
    // uiux-fix F041 (C206) — Enter during IME composition (Japanese, Chinese,
    // Korean, …) confirms the composition; it must never submit the message.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };
}

// uiux-fix F042 (C208) — citation markers in grounded answers (ASCII [n], CJK
// lenticular 【n】, fullwidth ［n］ — mirroring citation-attacher's tolerance) are
// stripped together with their leading whitespace so copied prose stays clean.
const CITATION_MARKER_PATTERN = /\s*[[【［]\d+[\]】］]/g;
const COLLAPSIBLE_ANSWER_MIN_CHARS = 1800;
const COLLAPSIBLE_ANSWER_MIN_LINES = 32;
const QUESTION_MAP_PREVIEW_MAX = 76;

export function copyableMessageText(content: string): string {
  return sanitizeRepositoryEvidenceText(content).replace(CITATION_MARKER_PATTERN, "");
}

function questionMapPreview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= QUESTION_MAP_PREVIEW_MAX) return normalized;
  return `${normalized.slice(0, QUESTION_MAP_PREVIEW_MAX - 3).trimEnd()}...`;
}

async function writeTextWithFallback(text: string): Promise<void> {
  const writeText = typeof navigator === "undefined" ? undefined : navigator.clipboard?.writeText;
  if (writeText !== undefined && navigator.clipboard !== undefined) {
    try {
      await writeText.call(navigator.clipboard, text);
      return;
    } catch {
      // Keep the manual-selection fallback below available for restricted clipboard contexts.
    }
  }

  if (typeof document === "undefined" || document.body === null) {
    throw new Error("clipboard-unavailable");
  }

  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    const copied = typeof document.execCommand === "function" && document.execCommand("copy");
    if (!copied) throw new Error("clipboard-fallback-failed");
  } finally {
    textarea.remove();
    previousFocus?.focus();
  }
}

function isCollapsibleAssistantAnswer(content: string): boolean {
  return (
    content.length >= COLLAPSIBLE_ANSWER_MIN_CHARS ||
    content.split(/\r\n|\r|\n/u).length >= COLLAPSIBLE_ANSWER_MIN_LINES
  );
}

// uiux-fix F042 (C208) — quiet per-bubble copy affordance for assistant
// responses. Mirrors SafeMarkdown's code-block CopyButton: clipboard guard for
// non-secure contexts and announced status (WCAG 4.1.3).
function MessageCopyButton({ content }: { readonly content: string }): ReactNode {
  const t = useTranslate();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [status, setStatus] = useState("");

  const handleCopy = useCallback(() => {
    void writeTextWithFallback(copyableMessageText(content)).then(
      () => {
        setCopyState("copied");
        setStatus(t("chat.copy.copiedStatus"));
        setTimeout(() => {
          setCopyState("idle");
          setStatus("");
        }, 1500);
      },
      () => {
        setCopyState("failed");
        setStatus(t("chat.copy.failedStatus"));
      },
    );
  }, [content, t]);

  const copied = copyState === "copied";
  const failed = copyState === "failed";

  return (
    <div className="chat-msg-copy-wrap">
      <button
        type="button"
        className="chat-msg-copy"
        aria-label={copied ? t("chat.copy.copied") : t("chat.copy.message")}
        title={copied ? t("chat.copy.copied") : t("chat.copy.message")}
        data-copied={copied ? "true" : "false"}
        data-failed={failed ? "true" : "false"}
        onClick={handleCopy}
      >
        <Icons.copy size={20} aria-hidden="true" />
      </button>
      <span role="status" className="chat-msg-copy-status">
        {status}
      </span>
    </div>
  );
}

function MessageRegenerateButton({
  messageId,
  regenerating,
  onRegenerate,
  onCancel,
}: {
  readonly messageId: string;
  readonly regenerating: boolean;
  readonly onRegenerate: (assistantMessageId: string) => Promise<void>;
  readonly onCancel: () => void;
}): ReactNode {
  const t = useTranslate();
  const [status, setStatus] = useState("");
  const handleClick = useCallback(() => {
    if (regenerating) {
      onCancel();
      setStatus(t("chat.regenerate.cancelled"));
      return;
    }
    setStatus(t("chat.regenerate.running"));
    void onRegenerate(messageId);
  }, [messageId, onCancel, onRegenerate, regenerating, t]);
  return (
    <>
      <div className="ai-controls" data-live={regenerating ? "true" : "false"}>
        <button
          type="button"
          className="ai-stop"
          aria-label={regenerating ? t("chat.regenerate.cancel") : t("chat.regenerate.action")}
          aria-busy={regenerating ? "true" : undefined}
          onClick={handleClick}
        >
          {regenerating ? t("chat.regenerate.cancelShort") : t("chat.regenerate.short")}
        </button>
      </div>
      <span role="status" className="sr-only">
        {status}
      </span>
    </>
  );
}

// Extracted from ChatBubbleImpl (SonarCloud S3776) — pure predicate, no JSX/hooks involved.
function canCollapseAssistantAnswer(
  streaming: boolean,
  isUser: boolean,
  isRunSummary: boolean,
  content: string,
): boolean {
  return !streaming && !isUser && !isRunSummary && isCollapsibleAssistantAnswer(content);
}

// Extracted from ChatBubbleImpl (SonarCloud S3776) — the branchy body of
// openDocumentationTarget's useCallback, kept as a plain function so the callback itself is a
// one-line delegation.
function resolveDocumentationTarget(
  previewWindows: PdfCitationPreviewWindowApi | undefined,
  target: string,
): boolean {
  if (previewWindows === undefined) return false;
  return previewWindows.add("docbrowser", { target }) !== null;
}

// Extracted from ChatBubbleImpl (SonarCloud S3776) — registers the bubble element as the PDF
// citation preview's scroll target for its assistant message. Same effect body/deps as before,
// now isolated as a named hook so the orchestrating component reads as a flat list of steps.
function useRegisterPdfCitationPreviewTarget(
  message: ChatMessage,
  activeChatId: string | undefined,
  windowId: string | undefined,
  bubbleRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const assistantMessageId = message.groundedAnswer?.assistantMessageId ?? message.id;
    if (
      message.role !== "assistant" ||
      activeChatId === undefined ||
      windowId === undefined ||
      bubbleRef.current === null
    ) {
      return;
    }
    return registerPdfCitationPreviewMessageTarget({
      assistantMessageId,
      chatId: activeChatId,
      chatWindowId: windowId,
      element: bubbleRef.current,
    });
  }, [
    activeChatId,
    bubbleRef,
    message.groundedAnswer?.assistantMessageId,
    message.id,
    message.role,
    windowId,
  ]);
}

// Extracted from ChatBubbleImpl (SonarCloud S3776) — the message body: plain text while
// streaming/for the user, otherwise safe markdown, plus the streaming caret.
function ChatBubbleContentArea({
  message,
  isUser,
  streaming,
  contentId,
  collapsed,
  canCollapse,
  repositoryRoots,
  openRepositoryReference,
  citationPreview,
  onApplyCodeBlock,
}: {
  readonly message: ChatMessage;
  readonly isUser: boolean;
  readonly streaming: boolean;
  readonly contentId: string;
  readonly collapsed: boolean;
  readonly canCollapse: boolean;
  readonly repositoryRoots: readonly RepositoryReferenceRoot[];
  readonly openRepositoryReference: OpenRepositoryReference | undefined;
  readonly citationPreview: CitationPreviewController | undefined;
  readonly onApplyCodeBlock: AssistantCodeBlockApply | undefined;
}): ReactNode {
  return (
    <div
      id={isUser ? undefined : contentId}
      className="chat-msg-content"
      data-collapsed={!isUser && collapsed ? "true" : "false"}
      data-collapsible={canCollapse ? "true" : "false"}
    >
      {isUser || streaming ? (
        message.content
      ) : (
        // AC #1 / #2: assistant responses render as safe markdown.
        // User messages remain plain text — no markdown interpretation.
        // The live streaming assistant turn also stays plain text until the
        // canonical message arrives, avoiding full Markdown parse/highlight
        // work on every token while retaining React's escaping guarantees.
        // SM-1: wrapped in a per-message boundary so a parser/render defect
        // degrades this one bubble to plain text instead of crashing the view.
        <SafeMarkdownBoundary
          source={message.content}
          applyScopeId={`${message.chatId}:${message.id}`}
          repositoryRoots={repositoryRoots}
          openRepositoryReference={openRepositoryReference}
          citationPreview={citationPreview}
          onApplyCodeBlock={onApplyCodeBlock}
        />
      )}
      {/* Issue #1296 — DS 0.4.0 streaming caret at the live edge of the growing
          assistant turn. Decorative (the lifecycle status announces "Receiving
          response…" politely), so it is hidden from assistive tech. */}
      {streaming && !isUser ? <span className="ai-stream-cursor" aria-hidden="true" /> : null}
    </div>
  );
}

// Extracted from ChatBubbleImpl (SonarCloud S3776) — the assistant-only action row (regenerate,
// copy, collapse). Returns null for user messages, mirroring the original `isUser ? null : (…)`.
function ChatBubbleFooterActions({
  isUser,
  message,
  showRegenerate,
  regenerating,
  onRegenerate,
  onCancelRegenerate,
  canCollapse,
  collapsed,
  onToggleCollapsed,
  contentId,
}: {
  readonly isUser: boolean;
  readonly message: ChatMessage;
  readonly showRegenerate: boolean;
  readonly regenerating: boolean;
  readonly onRegenerate: ((assistantMessageId: string) => Promise<void>) | undefined;
  readonly onCancelRegenerate: (() => void) | undefined;
  readonly canCollapse: boolean;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly contentId: string;
}): ReactNode {
  const t = useTranslate();
  if (isUser) return null;
  return (
    <div className="chat-msg-actions">
      {showRegenerate && onRegenerate !== undefined && onCancelRegenerate !== undefined ? (
        <MessageRegenerateButton
          messageId={message.id}
          regenerating={regenerating}
          onRegenerate={onRegenerate}
          onCancel={onCancelRegenerate}
        />
      ) : null}
      <MessageCopyButton content={message.content} />
      {canCollapse ? (
        <button
          type="button"
          className="chat-msg-collapse"
          aria-controls={contentId}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <Icons.chevron size={12} aria-hidden="true" />
          <span>{collapsed ? t("chat.answer.expand") : t("chat.answer.collapse")}</span>
        </button>
      ) : null}
    </div>
  );
}

// Extracted from ChatBubbleImpl (SonarCloud S3776) — the inline grounded-answer panel. Returns
// null for user messages or messages without a grounded answer, mirroring the original
// `!isUser && message.groundedAnswer !== undefined ? (…) : null`.
function ChatBubbleGroundedSection({
  message,
  isUser,
  repositoryRoots,
  openRepositoryReference,
  citationPreview,
  openDocumentationTarget,
}: {
  readonly message: ChatMessage;
  readonly isUser: boolean;
  readonly repositoryRoots: readonly RepositoryReferenceRoot[];
  readonly openRepositoryReference: OpenRepositoryReference | undefined;
  readonly citationPreview: CitationPreviewController | undefined;
  readonly openDocumentationTarget: (target: string) => boolean;
}): ReactNode {
  if (isUser || message.groundedAnswer === undefined) return null;
  return (
    <div className="chatw-grounded chatw-grounded-inline">
      <GroundedAnswer
        answer={message.groundedAnswer}
        busy={false}
        repositoryRoots={repositoryRoots}
        openRepositoryReference={openRepositoryReference}
        citationPreview={citationPreview}
        openDocumentationTarget={openDocumentationTarget}
      />
      <ContextStatusPanel contextSummary={contextSummaryOf(message.groundedAnswer)} />
    </div>
  );
}

function ChatBubbleImpl({
  message,
  onOpenRunResult,
  onRegenerate,
  onCancelRegenerate,
  showRegenerate = false,
  regenerating = false,
  repositoryRoots,
  openRepositoryReference,
  onApplyCodeBlock,
  previewWindows,
  windowId,
  streaming = false,
  layout = "stack",
}: {
  readonly message: ChatMessage;
  readonly onOpenRunResult?: ((message: ChatMessage) => void) | undefined;
  readonly onRegenerate?: ((assistantMessageId: string) => Promise<void>) | undefined;
  readonly onCancelRegenerate?: (() => void) | undefined;
  readonly showRegenerate?: boolean;
  readonly regenerating?: boolean;
  readonly repositoryRoots: readonly RepositoryReferenceRoot[];
  readonly openRepositoryReference: OpenRepositoryReference | undefined;
  readonly onApplyCodeBlock?: AssistantCodeBlockApply | undefined;
  readonly previewWindows: PdfCitationPreviewWindowApi | undefined;
  readonly windowId?: string | undefined;
  // Issue #1296 — true only for the live assistant turn while tokens are arriving,
  // so the DS 0.4.0 streaming caret blinks at the growing edge of the text.
  readonly streaming?: boolean;
  readonly layout?: "stack" | "turn";
}): ReactNode {
  const t = useTranslate();
  // GEN-PERF-CHAT-002 — settled bubbles only need activeChat (a low-frequency field). Reading it
  // from the catalog context (whose useMemo excludes draft/streamingAssistantMessage/sendStatus)
  // instead of the full-state context stops every settled bubble from re-rendering on each
  // keystroke or streamed token.
  const { activeChat } = useChatSessionCatalog();
  const contentId = useId();
  const bubbleRef = useRef<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const isRunSummary = isRunSummaryMessage(message);
  const isUser = message.role === "user";
  const citationPreview = usePdfCitationPreviewController({
    answer: message.groundedAnswer,
    chatId: activeChat?.id,
    windowId,
    windows: previewWindows,
  });
  // Epic #1854 (#1881) — opens the target in the existing governed documentation browser widget
  // (ADR-0113) rather than calling navigateDocumentation directly, so the widget's own reason/
  // severity rendering stays the single source of truth for the navigation outcome.
  const openDocumentationTarget = useCallback(
    (target: string): boolean => resolveDocumentationTarget(previewWindows, target),
    [previewWindows],
  );
  const canCollapse = canCollapseAssistantAnswer(streaming, isUser, isRunSummary, message.content);

  useRegisterPdfCitationPreviewTarget(message, activeChat?.id, windowId, bubbleRef);

  // Issue #153 — system messages carrying a workflow runId render as a structural run-summary
  // card rather than a conversation bubble. AC#3: this keeps the run visible in the chat
  // without weakening evidence semantics (the BFF's persisted runId is still the source of
  // truth; this surface is read-only and never exposes apply/exec — AC#4).
  if (isRunSummary) {
    return <RunSummaryCard message={message} onOpenResult={onOpenRunResult} />;
  }
  return (
    <article
      ref={bubbleRef}
      className="chat-msg"
      data-role={message.role}
      data-layout={layout}
      tabIndex={isUser ? undefined : -1}
    >
      <div className="chat-msg-bubble">
        {isUser ? <div className="chat-msg-role">{t("chat.role.user")}</div> : <KeikoMessageMark />}
        <ChatBubbleContentArea
          message={message}
          isUser={isUser}
          streaming={streaming}
          contentId={contentId}
          collapsed={collapsed}
          canCollapse={canCollapse}
          repositoryRoots={repositoryRoots}
          openRepositoryReference={openRepositoryReference}
          citationPreview={citationPreview}
          onApplyCodeBlock={onApplyCodeBlock}
        />
        {/* uiux-fix F041 (C176) — full date+time stays reachable via title.
            uiux-fix F042 (C208) — footer row: timestamp left, assistant-only actions right. */}
        <div className="chat-msg-foot">
          <div className="chat-msg-time" title={new Date(message.timestamp).toLocaleString()}>
            {timeLabel(message.timestamp)}
          </div>
          <ChatBubbleFooterActions
            isUser={isUser}
            message={message}
            showRegenerate={showRegenerate}
            regenerating={regenerating}
            onRegenerate={onRegenerate}
            onCancelRegenerate={onCancelRegenerate}
            canCollapse={canCollapse}
            collapsed={collapsed}
            onToggleCollapsed={() => {
              setCollapsed((current) => !current);
            }}
            contentId={contentId}
          />
        </div>
        <ChatBubbleGroundedSection
          message={message}
          isUser={isUser}
          repositoryRoots={repositoryRoots}
          openRepositoryReference={openRepositoryReference}
          citationPreview={citationPreview}
          openDocumentationTarget={openDocumentationTarget}
        />
      </div>
    </article>
  );
}

// Issue #1580 — memoized so appending a message (or a streaming token) re-renders
// only the new/last bubble, not the whole transcript. The props are stable for
// settled bubbles: `message` keeps its identity, repositoryRoots is useMemo'd,
// openRepositoryReference === openEditorFile (a WindowFrame useCallback), and
// `streaming` is false for every bubble except the live one.
const ChatBubble = memo(ChatBubbleImpl);

function KeikoMessageMark({ pulsing = false }: { readonly pulsing?: boolean }): ReactNode {
  const t = useTranslate();
  return (
    <div
      className="chat-msg-brand"
      data-pulsing={pulsing ? "true" : "false"}
      role="img"
      aria-label={t("chat.keikoLogo")}
    >
      <Image src="/assets/keiko-logo.svg" width={22} height={22} alt="" aria-hidden="true" />
    </div>
  );
}

function TypingBubble(): ReactNode {
  const t = useTranslate();
  return (
    <article className="chat-msg" data-role="assistant">
      <div className="chat-msg-bubble">
        <KeikoMessageMark pulsing />
        {/* uiux-fix F042 (C319) — aria-label is prohibited on a generic span and
            ignored by AT; role="img" makes the label exposed. The lifecycle
            announcement itself comes from SendLifecycleStatus. */}
        <span className="chat-typing" role="img" aria-label={t("chat.keikoResponding")}>
          <i />
          <i />
          <i />
        </span>
      </div>
    </article>
  );
}

interface ConversationThreadProps {
  readonly messages: readonly ChatMessage[];
  readonly streamingAssistantMessage?: ChatMessage | undefined;
  readonly onOpenRunResult?: ((message: ChatMessage) => void) | undefined;
  readonly repositoryRoots: readonly RepositoryReferenceRoot[];
  readonly openRepositoryReference: OpenRepositoryReference | undefined;
  readonly onApplyCodeBlock: AssistantCodeBlockApply | undefined;
  readonly previewWindows: PdfCitationPreviewWindowApi | undefined;
  readonly windowId?: string | undefined;
  readonly sending: boolean;
  readonly sendStatus: SendStatus;
  readonly regeneratingMessageId: string | undefined;
  readonly activeChat: Chat | undefined;
  readonly onCancelGrounded: () => void;
  readonly onRegenerate: (assistantMessageId: string) => Promise<void>;
  readonly onCancelRegenerate: () => void;
  readonly showRegenerateControls: boolean;
  readonly registerQuestionAnchor?: (messageId: string, node: HTMLDivElement | null) => void;
  readonly focusedMessageId: string | null;
}

function ConversationThreadImpl({
  messages,
  streamingAssistantMessage,
  onOpenRunResult,
  repositoryRoots,
  openRepositoryReference,
  onApplyCodeBlock,
  previewWindows,
  windowId,
  sending,
  sendStatus,
  regeneratingMessageId,
  activeChat,
  onCancelGrounded,
  onRegenerate,
  onCancelRegenerate,
  showRegenerateControls,
  registerQuestionAnchor,
  focusedMessageId,
}: ConversationThreadProps): ReactNode {
  const t = useTranslate();
  const turns = useMemo(() => conversationTurns(messages), [messages]);
  const turnWindow = useMemo(
    () => conversationTurnWindow(turns, focusedMessageId),
    [focusedMessageId, turns],
  );
  const liveAssistant =
    streamingAssistantMessage !== undefined && streamingAssistantMessage.content.length > 0
      ? streamingAssistantMessage
      : undefined;
  const lastTurnId = turns[turns.length - 1]?.id;
  const latestAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant") return message.id;
    }
    return undefined;
  }, [messages]);
  return (
    <div
      className="chatw-thread"
      data-windowed={turnWindow.beforeCount > 0 || turnWindow.afterCount > 0 ? "true" : "false"}
    >
      {turnWindow.beforeCount > 0 ? (
        <div
          className="chat-turn-spacer"
          aria-hidden="true"
          data-position="before"
          data-hidden-turns={turnWindow.beforeCount}
          style={conversationTurnSpacerStyle(turnWindow.beforeCount)}
        />
      ) : null}
      {turnWindow.turns.map((turn) => {
        const userMessage = turn.user;
        const isLastTurn = turn.id === lastTurnId;
        return (
          <div className="chat-turn" key={turn.id} style={CHAT_TURN_CONTENT_VISIBILITY_STYLE}>
            <div
              className="chat-turn-cell chat-turn-prompt"
              data-chat-question-id={userMessage?.id}
              ref={
                userMessage !== null && registerQuestionAnchor !== undefined
                  ? (node) => registerQuestionAnchor(userMessage.id, node)
                  : undefined
              }
            >
              {userMessage !== null ? (
                <ChatBubble
                  message={userMessage}
                  onOpenRunResult={onOpenRunResult}
                  repositoryRoots={repositoryRoots}
                  openRepositoryReference={openRepositoryReference}
                  previewWindows={previewWindows}
                  windowId={windowId}
                  layout="turn"
                />
              ) : null}
            </div>
            <div className="chat-turn-cell chat-turn-answer">
              {turn.responses.map((response, index) => (
                <ChatBubble
                  key={response.id}
                  message={response}
                  onOpenRunResult={onOpenRunResult}
                  repositoryRoots={repositoryRoots}
                  openRepositoryReference={openRepositoryReference}
                  onApplyCodeBlock={onApplyCodeBlock}
                  previewWindows={previewWindows}
                  windowId={windowId}
                  layout="turn"
                  onRegenerate={onRegenerate}
                  onCancelRegenerate={onCancelRegenerate}
                  showRegenerate={showRegenerateControls && latestAssistantId === response.id}
                  regenerating={regeneratingMessageId === response.id}
                  streaming={
                    liveAssistant === undefined &&
                    sendStatus === "streaming" &&
                    response.role === "assistant" &&
                    isLastTurn &&
                    index === turn.responses.length - 1
                  }
                />
              ))}
              {liveAssistant !== undefined && isLastTurn ? (
                <ChatBubble
                  key={liveAssistant.id}
                  message={liveAssistant}
                  onOpenRunResult={onOpenRunResult}
                  repositoryRoots={repositoryRoots}
                  openRepositoryReference={openRepositoryReference}
                  previewWindows={previewWindows}
                  windowId={windowId}
                  layout="turn"
                  streaming={sendStatus === "streaming"}
                />
              ) : null}
            </div>
          </div>
        );
      })}
      {turnWindow.afterCount > 0 ? (
        <div
          className="chat-turn-spacer"
          aria-hidden="true"
          data-position="after"
          data-hidden-turns={turnWindow.afterCount}
          style={conversationTurnSpacerStyle(turnWindow.afterCount)}
        />
      ) : null}
      {liveAssistant !== undefined && turns.length === 0 ? (
        <div className="chat-turn" key={liveAssistant.id}>
          <div className="chat-turn-cell chat-turn-prompt" />
          <div className="chat-turn-cell chat-turn-answer">
            <ChatBubble
              message={liveAssistant}
              onOpenRunResult={onOpenRunResult}
              repositoryRoots={repositoryRoots}
              openRepositoryReference={openRepositoryReference}
              previewWindows={previewWindows}
              windowId={windowId}
              layout="turn"
              streaming={sendStatus === "streaming"}
            />
          </div>
        </div>
      ) : null}
      {sending && sendStatus !== "streaming" ? (
        <div className="chat-turn chat-turn-pending">
          <div className="chat-turn-cell chat-turn-prompt" />
          <div className="chat-turn-cell chat-turn-answer">
            <div className="chatw-typing-row">
              <TypingBubble />
              {hasGroundingScope(activeChat) ? (
                <button
                  type="button"
                  className="grounded-cancel-btn"
                  aria-label={t("chat.grounded.cancel")}
                  onClick={onCancelGrounded}
                >
                  {t("common.cancel")}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface ConversationQuestionMapItem {
  readonly id: string;
  readonly index: number;
  readonly preview: string;
  readonly time: string;
}

function setQuestionMapButtonWave(button: HTMLButtonElement, wave: number, peak: boolean): void {
  const clamped = Math.max(0, Math.min(1, wave));
  button.style.setProperty("--wave-width", `${(8 + clamped * 16).toFixed(1)}px`);
  button.dataset.peak = peak ? "true" : "false";
}

// Exported for the GEN-PERF-CHAT-012 two-phase read/write regression test.
function ConversationQuestionMapImpl({
  items,
  onJump,
}: {
  readonly items: readonly ConversationQuestionMapItem[];
  readonly onJump: (messageId: string) => void;
}): ReactNode {
  const t = useTranslate();
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  // GEN-PERF-CHAT-012 — last pointer Y and a single pending frame handle, so a burst of pointermove
  // events collapses to one rAF (last-event-wins) instead of one layout pass per event.
  const pendingWaveYRef = useRef<number | null>(null);
  const waveFrameRef = useRef<number | null>(null);

  // Applies the wave to every button in TWO phases: read ALL rects first, THEN write ALL
  // --wave-width values. Interleaving reads and writes (the pre-fix loop) forced a synchronous
  // reflow on every iteration because --wave-width drives a transitioned width; batching the reads
  // ahead of the writes collapses that to one read pass + one write pass.
  const applyWave = useCallback((clientY: number): void => {
    const buttons = Array.from(buttonRefs.current.values());
    if (buttons.length === 0) return;
    const sigmaPx = 23;
    // Phase 1 — read all geometry.
    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    const waves = buttons.map((button, index) => {
      const rect = button.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      const distance = Math.abs(clientY - centerY);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
      return Math.exp(-(distance * distance) / (2 * sigmaPx * sigmaPx));
    });
    // Phase 2 — write all custom properties (no reads in between).
    buttons.forEach((button, index) => {
      const isPeak = index === nearestIndex;
      setQuestionMapButtonWave(button, isPeak ? 1 : (waves[index] ?? 0), isPeak);
    });
  }, []);

  const setWaveFromPointer = useCallback(
    (clientY: number): void => {
      pendingWaveYRef.current = clientY;
      if (typeof requestAnimationFrame !== "function") {
        applyWave(clientY);
        return;
      }
      if (waveFrameRef.current !== null) return;
      waveFrameRef.current = requestAnimationFrame(() => {
        waveFrameRef.current = null;
        const y = pendingWaveYRef.current;
        if (y !== null) applyWave(y);
      });
    },
    [applyWave],
  );

  const resetWave = useCallback((): void => {
    // Cancel any pending wave frame so a stale pointer position does not fight the reset.
    if (waveFrameRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(waveFrameRef.current);
    }
    waveFrameRef.current = null;
    pendingWaveYRef.current = null;
    for (const button of buttonRefs.current.values()) {
      setQuestionMapButtonWave(button, 0, false);
    }
  }, []);
  const registerButton = useCallback((messageId: string, node: HTMLButtonElement | null): void => {
    if (node === null) {
      buttonRefs.current.delete(messageId);
      return;
    }
    buttonRefs.current.set(messageId, node);
  }, []);
  if (items.length < 2) return null;

  return (
    <nav
      className="chat-question-map"
      aria-label={t("chat.questionMap.label")}
      onPointerMove={(event) => setWaveFromPointer(event.clientY)}
      onPointerLeave={resetWave}
    >
      <ol className="chat-question-map-list">
        {items.map((item) => (
          <li key={item.id} className="chat-question-map-item">
            <button
              ref={(node) => registerButton(item.id, node)}
              type="button"
              className="chat-question-map-button"
              data-peak="false"
              style={
                {
                  "--wave-width": "8px",
                } as CSSProperties
              }
              aria-label={t("chat.questionMap.jump", {
                index: item.index,
                preview: item.preview,
              })}
              onFocus={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setWaveFromPointer(rect.top + rect.height / 2);
              }}
              onBlur={resetWave}
              onClick={() => onJump(item.id)}
            >
              <span className="chat-question-map-mark" aria-hidden="true" />
              <span className="chat-question-map-card" aria-hidden="true">
                <span className="chat-question-map-card-title">{item.preview}</span>
                <span className="chat-question-map-card-time">{item.time}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

// GEN-PERF-CHAT-014 — items are useMemo'd off the settled transcript and onJump is a
// stable callback, so the question map skips every per-frame stream-flush re-render.
export const ConversationQuestionMap = memo(ConversationQuestionMapImpl);

// Issue #1580 — memoized so a chat-window re-render that does not change the
// transcript inputs (e.g. a resize, or unrelated composer state) skips reconciling
// the whole thread; combined with the per-bubble memo above, a new message renders
// just the new bubble.
const ConversationThread = memo(ConversationThreadImpl);

const REPOSITORY_FILE_SEARCH_LIMIT = 24;
const MAX_REPOSITORY_FOCUS_PATHS = 50;

interface RepositoryRootOption {
  readonly root: string;
  readonly label: string;
}

interface ComposerRepositoryReference {
  readonly id: string;
  readonly root: string;
  readonly path: string;
  readonly name: string;
  readonly directory: string;
  readonly verified: boolean;
  readonly source: "picker" | "draft";
}

function effectiveConnectedScopes(chat: Chat): readonly ChatConnectedScope[] {
  if (chat.connectedScopes !== undefined) return chat.connectedScopes;
  return chat.connectedScope !== undefined ? [chat.connectedScope] : [];
}

function rootDisplayName(root: string): string {
  const normalized = root.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? root;
}

function connectedRepositoryRoots(
  chat: Chat | undefined,
  activeProjectPath: string | undefined,
): readonly RepositoryRootOption[] {
  if (chat === undefined) return [];
  const fallbackRoot = activeProjectPath ?? chat.projectPath;
  const seen = new Set<string>();
  const roots: RepositoryRootOption[] = [];
  for (const scope of effectiveConnectedScopes(chat)) {
    const root = scope.root ?? fallbackRoot;
    if (root.length === 0 || seen.has(root)) continue;
    seen.add(root);
    roots.push({ root, label: rootDisplayName(root) });
  }
  return roots;
}

function repositoryReferenceRootPaths(args: {
  readonly chat: Chat | undefined;
  readonly activeProjectPath: string | undefined;
  readonly linkedRoot: string | null;
  readonly linkedRoots: readonly string[];
}): readonly string[] {
  const roots = connectedRepositoryRoots(args.chat, args.activeProjectPath).map(
    (root) => root.root,
  );
  if (args.linkedRoots.length > 0) {
    roots.push(...args.linkedRoots);
  } else if (args.linkedRoot !== null) {
    roots.push(args.linkedRoot);
  }
  return omitAncestorRepositoryRoots(roots);
}

function repositoryReferenceFromResult(
  result: FilesSearchResult,
  source: ComposerRepositoryReference["source"] = "picker",
): ComposerRepositoryReference {
  return {
    id: repositoryReferenceId(result.root, result.path),
    root: result.root,
    path: result.path,
    name: result.name,
    directory: result.directory,
    verified: true,
    source,
  };
}

function syntheticRepositoryReferenceFromPath(
  path: string,
  selectedRoot: string,
  roots: readonly RepositoryRootOption[],
): ComposerRepositoryReference | null {
  const normalized = normalizedRepositoryPath(path);
  if (normalized.length === 0 || normalized.includes("..")) return null;
  const root = selectedRoot.length > 0 ? selectedRoot : (roots[0]?.root ?? "");
  if (root.length === 0) return null;
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const name = segments[segments.length - 1] ?? normalized;
  const directory = segments.length > 1 ? segments.slice(0, -1).join("/") : "";
  return {
    id: repositoryReferenceId(root, normalized),
    root,
    path: normalized,
    name,
    directory,
    verified: false,
    source: "draft",
  };
}

function mergeComposerRepositoryReference(
  current: readonly ComposerRepositoryReference[],
  reference: ComposerRepositoryReference,
): readonly ComposerRepositoryReference[] {
  if (current.some((item) => item.id === reference.id)) return current;
  return [...current, reference];
}

function synchronizeComposerRepositoryReferences(args: {
  readonly current: readonly ComposerRepositoryReference[];
  readonly draft: string;
  readonly selectedRoot: string;
  readonly roots: readonly RepositoryRootOption[];
  readonly searchResults: readonly FilesSearchResult[];
}): readonly ComposerRepositoryReference[] {
  return repositoryReferenceMentionPaths(args.draft)
    .map((path) => {
      const existing = args.current.find((reference) => reference.path === path);
      if (existing?.verified === true) return existing;
      const searchResult = args.searchResults.find((result) => result.path === path);
      if (searchResult !== undefined) return repositoryReferenceFromResult(searchResult, "draft");
      return existing ?? syntheticRepositoryReferenceFromPath(path, args.selectedRoot, args.roots);
    })
    .filter((reference): reference is ComposerRepositoryReference => reference !== null);
}

interface RepositoryMentionRange {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

function repositoryMentionAtCursor(value: string, cursor: number): RepositoryMentionRange | null {
  const boundedCursor = Math.max(0, Math.min(cursor, value.length));
  const prefix = value.slice(0, boundedCursor);
  const atIndex = prefix.lastIndexOf("@");
  if (atIndex < 0) return null;
  const before = atIndex === 0 ? "" : (prefix[atIndex - 1] ?? "");
  if (before.length > 0 && !/\s|[(\[{]/u.test(before)) return null;
  const query = prefix.slice(atIndex + 1);
  if (query.includes("@") || /\s/u.test(query)) return null;
  return { start: atIndex, end: boundedCursor, query };
}

function replaceRepositoryMention(
  draft: string,
  mention: RepositoryMentionRange,
  path: string,
): { readonly value: string; readonly cursor: number } {
  const reference = `@${path}`;
  const prefix = draft.slice(0, mention.start);
  const suffix = draft.slice(mention.end);
  const needsSpace = suffix.length === 0 || !/^[\s.,;:!?)}\]]/u.test(suffix);
  const inserted = needsSpace ? `${reference} ` : reference;
  return {
    value: `${prefix}${inserted}${suffix}`,
    cursor: prefix.length + inserted.length,
  };
}

function mergeRepositoryFileScope(
  chat: Chat,
  root: string,
  path: string,
  now: () => number = Date.now,
): { readonly scopes: readonly ChatConnectedScope[]; readonly changed: boolean } {
  const filePath = normalizedRepositoryPath(path);
  if (filePath.length === 0) {
    throw new Error("EMPTY_REPOSITORY_FILE_SELECTION");
  }
  const currentScopes = effectiveConnectedScopes(chat);
  const nextScopes: ChatConnectedScope[] = [];
  let merged = false;
  let changed = false;

  for (const scope of currentScopes) {
    const scopeRoot = scope.root ?? chat.projectPath;
    if (scope.kind === "files" && scopeRoot === root) {
      merged = true;
      if (scope.relativePaths.includes(filePath)) {
        nextScopes.push(scope);
        continue;
      }
      if (scope.relativePaths.length >= MAX_REPOSITORY_FOCUS_PATHS) {
        throw new Error("REPOSITORY_FILE_SCOPE_LIMIT");
      }
      nextScopes.push({
        ...scope,
        root,
        relativePaths: [...scope.relativePaths, filePath],
        connectedAtMs: now(),
      });
      changed = true;
      continue;
    }
    nextScopes.push(scope);
  }

  if (!merged) {
    nextScopes.push({
      kind: "files",
      root,
      relativePaths: [filePath],
      connectedAtMs: now(),
    });
    changed = true;
  }

  return { scopes: nextScopes, changed };
}

function resultDirectoryLabel(result: FilesSearchResult, t: I18nTranslate): string {
  return result.directory.length === 0 ? t("chat.repository.root") : result.directory;
}

function fileRoleLabel(role: FilesSearchResult["fileRole"] | undefined, t: I18nTranslate): string {
  switch (role) {
    case "source":
      return t("chat.repository.role.source");
    case "test":
      return t("chat.repository.role.test");
    case "config":
      return t("chat.repository.role.config");
    case "docs":
      return t("chat.repository.role.docs");
    case "generated":
      return t("chat.repository.role.generated");
    case "asset":
      return t("chat.repository.role.asset");
    case "other":
    case undefined:
      return t("chat.repository.role.file");
  }
}

function fileRoleClassName(role: FilesSearchResult["fileRole"] | undefined): string {
  return `repo-focus-badge repo-focus-badge-${role ?? "other"}`;
}

function fileSearchResultClassName(result: FilesSearchResult): string {
  const secondary = result.fileRole === "generated" || result.fileRole === "asset";
  return `repo-focus-result${secondary ? " repo-focus-result-secondary" : ""}`;
}

function matchQualityLabel(
  quality: FilesSearchResult["matchQuality"] | undefined,
  t: I18nTranslate,
): string {
  switch (quality) {
    case "exact":
      return t("chat.repository.match.exact");
    case "strong":
      return t("chat.repository.match.strong");
    case "path":
      return t("chat.repository.match.path");
    case "weak":
    case undefined:
      return t("chat.repository.match.weak");
  }
}

function formatRepositoryFocusError(error: unknown, t: I18nTranslate): string {
  if (error instanceof Error && error.message === "EMPTY_REPOSITORY_FILE_SELECTION") {
    return t("chat.repository.selectFirst");
  }
  if (error instanceof Error && error.message === "REPOSITORY_FILE_SCOPE_LIMIT") {
    return t("chat.repository.limit", { count: MAX_REPOSITORY_FOCUS_PATHS });
  }
  return formatUserError(error, t("chat.repository.error.reference"));
}

function isAbortError(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

interface RepositoryFileSearchState {
  readonly results: readonly FilesSearchResult[];
  readonly searching: boolean;
  readonly message: string;
  readonly error: string | null;
}

function useRepositoryFileSearch(
  open: boolean,
  selectedRoot: string,
  query: string,
): RepositoryFileSearchState {
  const t = useTranslate();
  const idleMessage = t("chat.repository.searchIdle");
  const [results, setResults] = useState<readonly FilesSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState(idleMessage);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSearching(false);
      setResults([]);
      setMessage(idleMessage);
      setError(null);
      return undefined;
    }
    const trimmed = query.trim();
    if (selectedRoot.length === 0 || trimmed.length === 0) {
      setSearching(false);
      setResults([]);
      setMessage(idleMessage);
      setError(null);
      return undefined;
    }

    const controller = new AbortController();
    let cancelled = false;
    setSearching(true);
    setError(null);
    setMessage(t("chat.repository.searching"));
    const searchTimer = window.setTimeout(() => {
      void fetchFilesSearch(selectedRoot, trimmed, REPOSITORY_FILE_SEARCH_LIMIT, {
        signal: controller.signal,
      })
        .then((response) => {
          if (cancelled) return;
          setResults(response.results);
          if (response.results.length === 0) {
            setMessage(t("chat.repository.noMatches"));
          } else {
            const count = response.results.length;
            setMessage(
              response.truncated
                ? t("chat.repository.foundTruncated", { count })
                : t("chat.repository.found", { count }),
            );
          }
        })
        .catch((caught: unknown) => {
          if (cancelled || isAbortError(caught)) return;
          setResults([]);
          setError(formatRepositoryFocusError(caught, t));
          setMessage(t("chat.repository.searchFailed"));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(searchTimer);
      controller.abort();
    };
  }, [idleMessage, open, query, selectedRoot, t]);

  return { results, searching, message, error };
}

interface RepositoryFilePickerPanelProps {
  readonly roots: readonly RepositoryRootOption[];
  readonly selectedRoot: string;
  readonly onRootChange: (root: string) => void;
  readonly search: RepositoryFileSearchState;
  readonly pickingPath: string | null;
  readonly highlightedIndex: number;
  readonly pickError: string | null;
  readonly onPick: (result: FilesSearchResult) => void;
  readonly onClose: () => void;
}

function RepositoryFilePickerPanel({
  roots,
  selectedRoot,
  onRootChange,
  search,
  pickingPath,
  highlightedIndex,
  pickError,
  onPick,
  onClose,
}: RepositoryFilePickerPanelProps): ReactNode {
  const t = useTranslate();
  const activeRoot = roots.find((root) => root.root === selectedRoot) ?? roots[0];
  const displayedError = pickError ?? search.error;
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const stopPickerPointer = (event: SyntheticEvent): void => {
    event.stopPropagation();
  };
  const pickFromPointer = (event: PointerEvent<HTMLButtonElement>, result: FilesSearchResult) => {
    if (event.button !== 0 || pickingPath !== null) return;
    event.preventDefault();
    event.stopPropagation();
    onPick(result);
  };
  // Keep the highlighted option visible as ArrowUp/ArrowDown move the selection.
  // Focus stays on the textarea (combobox), so we scroll the option manually.
  useEffect(() => {
    const list = resultsRef.current;
    if (list === null) return;
    const option = list.querySelector<HTMLElement>(
      `#${repositoryFilePickerOptionId(highlightedIndex)}`,
    );
    option?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, search.results]);
  return (
    // A combobox popup is not a modal dialog; keep it a plain container. It must
    // still be a pointer boundary inside draggable workspace windows, and the
    // selection controls below remain semantic buttons.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="repo-focus-popover"
      onPointerDown={stopPickerPointer}
      onMouseDown={stopPickerPointer}
    >
      <div className="repo-focus-head">
        <div>
          <span className="repo-focus-title">{t("chat.repository.title")}</span>
          <span className="repo-focus-subtitle">
            {activeRoot?.label ?? t("chat.repository.connectedSource")}
          </span>
        </div>
        <button
          type="button"
          className="repo-focus-close"
          aria-label={t("chat.repository.closePicker")}
          onClick={onClose}
        >
          <Icons.close size={13} />
        </button>
      </div>
      {roots.length > 1 ? (
        <KeikoSelect
          triggerClassName="repo-focus-source-select"
          value={selectedRoot}
          ariaLabel={t("chat.repository.source")}
          menuTitle={t("chat.repository.connectedRepositories")}
          menuClassName="repo-focus-source-menu"
          menuMinWidth={240}
          sections={[
            {
              options: roots.map((root) => ({
                value: root.root,
                label: root.label,
              })),
            },
          ]}
          onValueChange={onRootChange}
        />
      ) : null}
      <div className="repo-focus-message" role={displayedError === null ? "status" : "alert"}>
        {displayedError ?? (search.searching ? t("chat.repository.searching") : search.message)}
      </div>
      {search.results.length > 0 ? (
        <div
          className="repo-focus-results"
          id={REPO_FILE_PICKER_LISTBOX_ID}
          role="listbox"
          aria-label={t("chat.repository.results")}
          ref={resultsRef}
        >
          {search.results.map((result, index) => (
            <button
              key={`${result.root}:${result.path}`}
              id={repositoryFilePickerOptionId(index)}
              type="button"
              className={fileSearchResultClassName(result)}
              role="option"
              aria-selected={index === highlightedIndex ? "true" : "false"}
              data-highlighted={index === highlightedIndex ? "true" : "false"}
              aria-label={t("chat.repository.reference", { path: result.path })}
              disabled={pickingPath !== null}
              onPointerDown={(event) => pickFromPointer(event, result)}
              onClick={(event) => {
                event.stopPropagation();
                if (event.detail === 0 && pickingPath === null) onPick(result);
              }}
            >
              <span className="repo-focus-result-main">
                <span className="repo-focus-result-name">{result.name}</span>
                <span className="repo-focus-result-badges" aria-hidden="true">
                  <span className={fileRoleClassName(result.fileRole)}>
                    {fileRoleLabel(result.fileRole, t)}
                  </span>
                  {result.rootKind === "nested-git-root" ? (
                    <span className="repo-focus-badge repo-focus-badge-root">
                      {t("chat.repository.nestedRepo")}
                    </span>
                  ) : null}
                </span>
              </span>
              <span className="repo-focus-result-path">{resultDirectoryLabel(result, t)}</span>
              <span className="sr-only">
                {`${fileRoleLabel(result.fileRole, t)}; ${matchQualityLabel(result.matchQuality, t)}${result.rootKind === "nested-git-root" ? `; ${t("chat.repository.nestedRoot")}` : ""}.`}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface RepositoryReferenceStripProps {
  readonly references: readonly ComposerRepositoryReference[];
  readonly onRemove: (id: string) => void;
}

function RepositoryReferenceStrip({
  references,
  onRemove,
}: RepositoryReferenceStripProps): ReactNode {
  const t = useTranslate();
  if (references.length === 0) return null;
  return (
    <div className="repo-token-strip" role="list" aria-label={t("chat.repository.references")}>
      {references.map((reference) => (
        <div
          key={reference.id}
          className={`repo-token${reference.verified ? "" : " repo-token-unverified"}`}
          role="listitem"
          title={
            reference.verified
              ? `${reference.path} - ${reference.root}`
              : `${t("chat.repository.notVerified")} - ${reference.path} - ${reference.root}`
          }
        >
          <span className="repo-token-icon" aria-hidden="true">
            <FileIcon name={reference.name} />
          </span>
          <span className="repo-token-main">
            <span className="repo-token-name">{reference.name}</span>
            <span className="repo-token-path">
              {reference.directory.length === 0
                ? rootDisplayName(reference.root)
                : reference.directory}
            </span>
          </span>
          {reference.verified ? null : (
            <span className="repo-token-status" aria-label={t("chat.repository.notVerified")}>
              {t("chat.repository.unverified")}
            </span>
          )}
          <button
            type="button"
            className="repo-token-remove"
            aria-label={t("chat.repository.removeReference", { path: reference.path })}
            onClick={() => onRemove(reference.id)}
          >
            <Icons.close size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

interface ComposerBarProps {
  readonly session: ChatSessionApi;
  readonly ready: boolean;
  readonly selectedModelCapability: ModelCapability | undefined;
  readonly onAttachFiles: (files: readonly File[]) => void;
  readonly controlsNarrow?: boolean;
  readonly barCompact?: boolean;
  // Issue #495 — capability-gated dictation. The mic affordance renders only when
  // `voiceDictationVisible` is true (STT advertised + browser can capture). `dictation` is the
  // composer-local state machine and `micButtonRef` lets the preview return focus to the button.
  readonly voiceDictationVisible: boolean;
  readonly dictation: DictationController;
  readonly micButtonRef: Ref<HTMLButtonElement>;
  // Issue #501 — capability-gated assistant speech output. The mute toggle renders only when the
  // deployment advertises speech output; a no-voice / STT-only deployment shows nothing (AC1).
  readonly voiceSpeechOutputVisible: boolean;
  readonly voiceMuted: boolean;
  readonly onToggleVoiceMute: () => void;
  readonly playbackButtonRef: Ref<HTMLButtonElement>;
  // Issue #1559/#1560 — capability-gated voice dialogue switch. Rendered only when
  // `voiceDialogAvailable` is true (speech capture + speech output + at least one persona).
  // `voiceDialogActive` drives aria-checked.
  readonly voiceDialogAvailable: boolean;
  readonly voiceDialogActive: boolean;
  readonly onToggleVoiceDialog: () => void;
  readonly voiceDialogButtonRef: Ref<HTMLButtonElement>;
}

interface VoiceDialogComposerControlsProps {
  readonly voiceMuted: boolean;
  readonly onToggleVoiceMute: () => void;
  readonly playbackButtonRef: Ref<HTMLButtonElement>;
  readonly voiceDialogActive: boolean;
  readonly onToggleVoiceDialog: () => void;
  readonly voiceDialogButtonRef: Ref<HTMLButtonElement>;
  readonly compact?: boolean | undefined;
}

interface ComposerContextControlsProps {
  readonly session: ChatSessionApi;
  readonly selectedModelCapability: ModelCapability | undefined;
  readonly onAttachFiles: (files: readonly File[]) => void;
  readonly controlsNarrow?: boolean | undefined;
}

interface VoiceDialogMicMuteButtonProps {
  readonly muted: boolean;
  readonly onToggle: () => void;
  readonly buttonRef?: Ref<HTMLButtonElement> | undefined;
  readonly compact?: boolean | undefined;
}

function VoiceDialogMicMuteButton({
  muted,
  onToggle,
  buttonRef,
  compact = false,
}: VoiceDialogMicMuteButtonProps): ReactNode {
  const hintId = useId();
  const label = muted ? "Unmute voice dialogue microphone" : "Mute voice dialogue microphone";
  return (
    <button
      type="button"
      ref={buttonRef}
      className={`cmp-icon cmp-voice cmp-voice-dialog-mute ui-tip${compact ? " cmp-mode-compact" : ""}`}
      data-muted={muted ? "true" : "false"}
      data-tip={label}
      aria-label={label}
      aria-pressed={muted}
      aria-describedby={hintId}
      onClick={onToggle}
    >
      <span className="cmp-voice-dialog-mic-glyph" aria-hidden="true">
        <Icons.mic size={16} />
        {muted ? <span className="cmp-voice-dialog-mic-slash" /> : null}
      </span>
      <span id={hintId} className="sr-only">
        When muted, Keiko cannot hear your microphone until you unmute.
      </span>
    </button>
  );
}

function ComposerContextControls({
  session,
  selectedModelCapability,
  onAttachFiles,
  controlsNarrow = false,
}: ComposerContextControlsProps): ReactNode {
  const t = useTranslate();
  const { models, selectedModel, setSelectedModel, noEligibleModels, loading } = session;
  const selectDescribedBy = noEligibleModels ? NO_MODEL_ALERT_ID : undefined;
  const selectValue = loading || noEligibleModels ? "" : (selectedModel ?? "");
  const compactModelTip = loading
    ? t("chat.model.loading")
    : noEligibleModels
      ? t("chat.model.noEligible")
      : t("chat.model.change");

  return (
    <div className="cmp-bar-model">
      <AttachButton
        model={selectedModelCapability}
        onFiles={onAttachFiles}
        anyModelSupportsAttachments={models.some(
          (m) => m.supportsImageInput || m.supportsDocumentInput,
        )}
      />
      <div
        className={`cmp-model mono ui-tip${controlsNarrow ? " cmp-model-compact" : " cmp-pill-standard"}`}
        data-tip={controlsNarrow ? compactModelTip : undefined}
      >
        <KeikoSelect
          triggerClassName="cmp-model-select"
          value={selectValue}
          ariaLabel={t("chat.model.menuTitle")}
          ariaDescribedBy={selectDescribedBy}
          disabled={loading}
          placeholder={
            loading
              ? t("chat.model.loading")
              : noEligibleModels
                ? t("chat.model.noEligible")
                : t("chat.model.menuTitle")
          }
          leadingVisual={
            <Icons.cube size={controlsNarrow ? 16 : 13} style={{ color: "var(--accent)" }} />
          }
          menuTitle={t("chat.model.menuTitle")}
          menuClassName="cmp-model-menu"
          menuMinWidth={controlsNarrow ? 118 : 280}
          mono
          sections={[
            {
              options: loading
                ? [{ value: "", label: t("chat.model.loading"), disabled: true }]
                : noEligibleModels
                  ? [{ value: "", label: t("chat.model.noEligible"), disabled: true }]
                  : modelList(models).map((model) => ({
                      value: model.id,
                      label: model.id,
                    })),
            },
          ]}
          onValueChange={(next) => {
            if (noEligibleModels || loading) return;
            setSelectedModel(next);
          }}
        />
      </div>
    </div>
  );
}

function VoiceDialogComposerControls({
  voiceMuted,
  onToggleVoiceMute,
  playbackButtonRef,
  voiceDialogActive,
  onToggleVoiceDialog,
  voiceDialogButtonRef,
  compact = false,
}: VoiceDialogComposerControlsProps): ReactNode {
  return (
    <div className="cmp-bar cmp-bar-voice-dialog">
      <div className="cmp-bar-main cmp-bar-main-voice-dialog">
        <VoiceDialogModeSwitch
          active={voiceDialogActive}
          onToggle={onToggleVoiceDialog}
          buttonRef={voiceDialogButtonRef}
          compact={compact}
        />
        <VoiceDialogMicMuteButton
          muted={voiceMuted}
          onToggle={onToggleVoiceMute}
          buttonRef={playbackButtonRef}
          compact={compact}
        />
      </div>
    </div>
  );
}

// Extracted from ComposerBar (SonarCloud S3776) — AC #2's aria-describedby chain as a small
// sequence of checks instead of a 3-deep nested ternary.
function sendDescribedById(
  noEligibleModels: boolean,
  loading: boolean,
  draftEmpty: boolean,
): string | undefined {
  if (noEligibleModels) return NO_MODEL_ALERT_ID;
  if (loading) return LOADING_STATUS_ID;
  if (draftEmpty) return SEND_HINT_ID;
  return undefined;
}

// Extracted from ComposerBar (SonarCloud S3776) — the send button's data-tip label, previously a
// 2-deep nested ternary inline in JSX.
function sendButtonTip(noEligibleModels: boolean, loading: boolean, t: I18nTranslate): string {
  if (noEligibleModels) return t("chat.send.noModel");
  if (loading) return t("chat.send.connecting");
  return t("chat.send.label");
}

// Extracted from ComposerBar (SonarCloud S3776) — the primary action button, which flips between
// "cancel in-flight send" and "submit" (Issue #152). Same markup/behavior, now isolated so the
// sending/type/data-tip branching lives in one small component instead of inline in ComposerBar.
function ComposerSendButton({
  sending,
  cancelSend,
  sendBlocked,
  noEligibleModels,
  loading,
  sendDescribedBy,
}: {
  readonly sending: boolean;
  readonly cancelSend: () => void;
  readonly sendBlocked: boolean;
  readonly noEligibleModels: boolean;
  readonly loading: boolean;
  readonly sendDescribedBy: string | undefined;
}): ReactNode {
  const t = useTranslate();
  // Issue #152 — while a send is in flight the primary action button
  // flips to "Cancel response" (AC#1 + AC#3). Type="button" so it never
  // submits the surrounding form; onClick calls cancelSend which is a
  // safe no-op when the status is already terminal.
  if (sending) {
    return (
      <button
        type="button"
        className="cmp-send cmp-send-cancel cmp-tip-end"
        data-on
        aria-label={t("chat.send.cancel")}
        data-tip={t("chat.send.cancel")}
        onClick={cancelSend}
      >
        <Icons.close size={16} />
      </button>
    );
  }
  return (
    <button
      type={sendBlocked ? "button" : "submit"}
      className="cmp-send cmp-tip-end"
      data-on={!sendBlocked}
      data-tip={sendButtonTip(noEligibleModels, loading, t)}
      aria-disabled={sendBlocked}
      aria-describedby={sendDescribedBy}
      aria-label={t("chat.send.label")}
    >
      <Icons.arrowUp size={16} />
    </button>
  );
}

function ComposerBar({
  session,
  ready,
  selectedModelCapability,
  onAttachFiles,
  controlsNarrow = false,
  barCompact = false,
  voiceDictationVisible,
  dictation,
  micButtonRef,
  voiceSpeechOutputVisible,
  voiceMuted,
  onToggleVoiceMute,
  playbackButtonRef,
  voiceDialogAvailable,
  voiceDialogActive,
  onToggleVoiceDialog,
  voiceDialogButtonRef,
}: ComposerBarProps): ReactNode {
  const t = useTranslate();
  const { draft, noEligibleModels, loading, sending, cancelSend } = session;
  // AC #1 / AC #4: when no eligible model is configured the send button must be
  // focusable (so screen-reader users discover the error) but must not submit.
  // Use aria-disabled rather than the HTML disabled attribute so focus is retained.
  const sendBlocked = noEligibleModels || !ready;
  const draftEmpty = draft.trim().length === 0;

  // AC #2: aria-describedby chains:
  // - model select → NO_MODEL_ALERT_ID when noEligibleModels
  // - send button  → NO_MODEL_ALERT_ID when noEligibleModels,
  //                  LOADING_STATUS_ID while bootstrapping,
  //                  else SEND_HINT_ID when only the draft is empty
  const sendDescribedBy = sendDescribedById(noEligibleModels, loading, draftEmpty);

  return (
    <div className={`cmp-bar${barCompact ? " cmp-bar-compact" : ""}`}>
      {/* Issue #147: real AttachButton replaces the placeholder "Attach (coming soon)" button.
          uiux-fix F040 C207 — tell the button whether ANY configured model can attach, so its
          sr-only hint does not suggest a model switch that cannot succeed. */}
      <ComposerContextControls
        session={session}
        selectedModelCapability={selectedModelCapability}
        onAttachFiles={onAttachFiles}
        controlsNarrow={controlsNarrow}
      />
      <div className="cmp-bar-main">
        {/* Issue #495 — capability-gated dictation. Rendered only when the deployment advertises
            speech-to-text and the browser can capture audio; a no-voice deployment shows no mic at
            all so the composer stays clean and fully text-capable (AC1). The button is STT dictation
            only and never implies full voice conversation (AC5). */}
        {voiceDictationVisible ? (
          <VoiceDictationButton
            phase={dictation.phase}
            audioLevel={dictation.audioLevel}
            onStart={dictation.start}
            onStop={dictation.stop}
            buttonRef={micButtonRef}
            compact={controlsNarrow}
          />
        ) : null}
        {/* Issue #1559/#1560 — capability-gated voice dialogue switch. Rendered only when the deployment
            can capture speech, speak answers, and offers a voice persona; otherwise nothing new appears
            and the composer stays clean and fully text-capable (AC3). The switch enters / leaves spoken
            dialogue; the active-session status and controls render in the input stack above the bar. */}
        {voiceDialogAvailable ? (
          <VoiceDialogModeSwitch
            active={voiceDialogActive}
            onToggle={onToggleVoiceDialog}
            buttonRef={voiceDialogButtonRef}
            compact={controlsNarrow}
          />
        ) : null}
        {/* Issue #501 — capability-gated assistant speech-output mute toggle. Rendered only when the
            deployment advertises speech output; a no-voice / STT-only deployment shows nothing new, so
            the assistant answers in text with no playback control (AC1). */}
        {voiceSpeechOutputVisible ? (
          <VoicePlaybackMuteButton
            muted={voiceMuted}
            onToggle={onToggleVoiceMute}
            buttonRef={playbackButtonRef}
            compact={controlsNarrow}
          />
        ) : null}
        <ComposerSendButton
          sending={sending}
          cancelSend={cancelSend}
          sendBlocked={sendBlocked}
          noEligibleModels={noEligibleModels}
          loading={loading}
          sendDescribedBy={sendDescribedBy}
        />
      </div>
      {/* AC #2: visually-hidden hint for screen readers when send is blocked by empty draft */}
      {sendDescribedBy === SEND_HINT_ID ? (
        <span id={SEND_HINT_ID} className="sr-only">
          {t("chat.send.hint")}
        </span>
      ) : null}
    </div>
  );
}

// AC #1: rendered when no conversation-eligible model is configured. Uses
// role="alert" so screen readers announce immediately on mount. Uses gw-error
// CSS class (var(--fg) text) for WCAG AA contrast compliance.
// Stable id enables aria-describedby wiring from disabled controls (AC #2).
function NoModelAlert(): ReactNode {
  const t = useTranslate();
  return (
    <div id={NO_MODEL_ALERT_ID} role="alert" className="gw-error cmp-no-model">
      {t("chat.noModelAlert")}
    </div>
  );
}

// AC #3: rendered while session.loading is true. role="status" (polite) so
// screen-reader users hear the state without interruption. No fake progress
// percentage — engineering note forbids it.
function LoadingStatus(): ReactNode {
  const t = useTranslate();
  return (
    <div id={LOADING_STATUS_ID} role="status" className="cmp-loading-status">
      <span className="cmp-loading-dot" aria-hidden="true" />
      {t("chat.loadingGateway")}
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
  const t = useTranslate();
  const label =
    status === "queued"
      ? t("chat.send.statusQueued")
      : status === "contacting"
        ? t("chat.send.statusContacting")
        : status === "streaming"
          ? t("chat.send.statusStreaming")
          : status === "cancelled"
            ? t("chat.send.statusCancelled")
            : "";
  // uiux-fix F041 (C170, WCAG 4.1.3) — the live region stays permanently mounted
  // and only its CONTENT changes: a role="status" region inserted into the DOM
  // together with its first message is unreliably announced (VoiceOver/Safari,
  // partly NVDA), so "Submitting your message…" could be lost. The empty region
  // is collapsed via .cmp-send-status:empty in globals.css (not display:none —
  // hidden live regions are dropped by some screen readers).
  return (
    <div role="status" aria-live="polite" data-send-status={status} className="cmp-send-status">
      {label.length === 0 ? null : (
        <>
          <span className="cmp-loading-dot" aria-hidden="true" />
          {label}
        </>
      )}
    </div>
  );
}

interface ComposerCoreProps {
  readonly ready: boolean;
  readonly placeholder: string;
  readonly minimal?: boolean;
  readonly compact?: boolean;
  readonly controlsNarrow?: boolean;
  readonly barCompact?: boolean;
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — attachment intake: adds each dropped or
// picked file via the session API and reports only the first rejection encountered, matching the
// original loop's behavior (later rejections in the same batch don't overwrite the first).
async function collectFirstAttachmentRejection(
  files: readonly File[],
  addPendingAttachment: ChatSessionComposerApi["addPendingAttachment"],
): Promise<{
  readonly reason: AttachmentRejectionReason | undefined;
  readonly mime: string | undefined;
}> {
  let reason: AttachmentRejectionReason | undefined;
  let mime: string | undefined;
  for (const file of files) {
    const result = await addPendingAttachment(file);
    if (!result.ok && reason === undefined) {
      reason = result.reason;
      mime = file.type;
    }
  }
  return { reason, mime };
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — the realtime voice session's chat context
// payload: undefined with no active chat, otherwise the chat id, memory settings, and (if the
// chat has grounding enabled) the grounding context. Same conditional shape as the original.
function composerRealtimeVoiceChatContext(
  activeChat: Chat | undefined,
  memoryEnabled: boolean,
  memoryBudgetTokens: number,
  grounding: VoiceSessionGroundingContext | undefined,
): VoiceSessionChatContext | undefined {
  if (activeChat === undefined) return undefined;
  return {
    chatId: activeChat.id,
    memory: { enabled: memoryEnabled, budgetTokens: memoryBudgetTokens },
    ...(grounding === undefined ? {} : { grounding }),
  };
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — when the active voice composer layer
// (normal vs. voice dialogue) actually changes, move focus to the switch in the newly active
// layer so a keyboard user is not dropped onto <body> (WCAG 2.4.3). Runs only for a user-driven
// toggle — programmatic auto-leave never sets `restoreFocusRef`.
function syncVoiceDialogLayerFocus(params: {
  readonly active: boolean;
  readonly previousActiveRef: MutableRefObject<boolean>;
  readonly restoreFocusRef: MutableRefObject<boolean>;
  readonly voiceDialogButton: HTMLButtonElement | null;
  readonly normalVoiceDialogButton: HTMLButtonElement | null;
}): void {
  const { active, previousActiveRef, restoreFocusRef, voiceDialogButton, normalVoiceDialogButton } =
    params;
  if (previousActiveRef.current === active) return;
  previousActiveRef.current = active;
  if (!restoreFocusRef.current) return;
  restoreFocusRef.current = false;
  const target = active ? voiceDialogButton : normalVoiceDialogButton;
  target?.focus();
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — two independent effects that keep Voice
// Dialogue honest about its own preconditions: auto-leave when it becomes unavailable mid-session
// (e.g. the active chat is cleared), and stop the realtime transport once the dialogue layer is no
// longer active. Same two effects and dependency arrays as the original, just relocated.
function useVoiceDialogAutoLeaveEffects(
  voiceDialogActive: boolean,
  voiceDialogAvailable: boolean,
  realtimeVoice: RealtimeVoiceController,
  leaveVoiceDialog: () => void,
): void {
  useEffect(() => {
    if (voiceDialogActive && !voiceDialogAvailable) {
      leaveVoiceDialog();
    }
  }, [leaveVoiceDialog, voiceDialogActive, voiceDialogAvailable]);
  useEffect(() => {
    if (!voiceDialogActive && realtimeVoice.phase !== "idle") {
      realtimeVoice.stop();
    }
  }, [voiceDialogActive, realtimeVoice]);
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — the @-mention repository picker's
// keyboard navigation: Escape closes it, arrow keys move the highlight, and Enter/Tab accept
// the highlighted (or first) result. Returns true when the key was handled so the caller skips
// the default composer key-down flow, matching the original if-chain's fall-through behavior.
function handleRepositoryPickerKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  params: {
    readonly results: readonly FilesSearchResult[];
    readonly highlightedIndex: number;
    readonly setHighlightedIndex: Dispatch<SetStateAction<number>>;
    readonly closeMention: () => void;
    readonly pickResult: (result: FilesSearchResult) => void;
  },
): boolean {
  const { results, highlightedIndex, setHighlightedIndex, closeMention, pickResult } = params;
  if (event.key === "Escape") {
    event.preventDefault();
    closeMention();
    return true;
  }
  if (event.key === "ArrowDown" && results.length > 0) {
    event.preventDefault();
    setHighlightedIndex((current) => Math.min(results.length - 1, current + 1));
    return true;
  }
  if (event.key === "ArrowUp" && results.length > 0) {
    event.preventDefault();
    setHighlightedIndex((current) => Math.max(0, current - 1));
    return true;
  }
  if ((event.key === "Enter" || event.key === "Tab") && results.length > 0) {
    event.preventDefault();
    const picked = results[highlightedIndex] ?? results[0];
    if (picked !== undefined) pickResult(picked);
    return true;
  }
  return false;
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — resolves where an accepted repository
// file result lands in the draft: appended at the end when there is no active @-mention, or
// substituted into the mention range when there is one. Same two-branch shape as the original
// inline ternary/IIFE.
function resolveRepositoryMentionInsertion(
  draft: string,
  mention: RepositoryMentionRange | null,
  path: string,
): { readonly value: string; readonly cursor: number } {
  if (mention === null) {
    const value = appendRepositoryReference(draft, path);
    return { value, cursor: value.length };
  }
  return replaceRepositoryMention(draft, mention, path);
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — the composer box's outer className: the
// base class plus the compact and voice-dialog-active modifiers, filtered and joined.
function composerBoxClassNameFor(compact: boolean, voiceDialogActive: boolean): string {
  return [
    "cmp-box",
    compact ? "cmp-box-compact" : "",
    voiceDialogActive ? styles.voiceDialogBox : "",
  ]
    .filter(Boolean)
    .join(" ");
}

interface ComposerRepositoryComboboxAria {
  readonly role: "combobox" | undefined;
  readonly ariaLabel: string | undefined;
  readonly ariaExpanded: true | undefined;
  readonly ariaHaspopup: "listbox" | undefined;
  readonly ariaControls: string | undefined;
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — the @-mention combobox wrapper's ARIA
// attributes, active only while the repository file picker is open (aria-controls further
// guarded on results existing, so the idref stays resolvable — aria-valid-attr-value).
function composerRepositoryComboboxAria(
  repositoryPickerOpen: boolean,
  resultsCount: number,
  t: I18nTranslate,
): ComposerRepositoryComboboxAria {
  return {
    role: repositoryPickerOpen ? "combobox" : undefined,
    ariaLabel: repositoryPickerOpen ? t("chat.messageLabel") : undefined,
    ariaExpanded: repositoryPickerOpen ? true : undefined,
    ariaHaspopup: repositoryPickerOpen ? "listbox" : undefined,
    ariaControls:
      repositoryPickerOpen && resultsCount > 0 ? REPO_FILE_PICKER_LISTBOX_ID : undefined,
  };
}

interface ComposerTextareaAutocompleteAria {
  readonly ariaAutocomplete: "list" | undefined;
  readonly ariaActivedescendant: string | undefined;
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — the textarea's autocomplete ARIA pair:
// only present while the repository picker is open, with the active-descendant further guarded
// on results existing.
function composerTextareaAutocompleteAria(
  repositoryPickerOpen: boolean,
  resultsCount: number,
  highlightedIndex: number,
): ComposerTextareaAutocompleteAria {
  return {
    ariaAutocomplete: repositoryPickerOpen ? "list" : undefined,
    ariaActivedescendant:
      repositoryPickerOpen && resultsCount > 0
        ? repositoryFilePickerOptionId(highlightedIndex)
        : undefined,
  };
}

interface ComposerVoiceAuraDataAttributes {
  readonly dataVoiceAura: "on" | undefined;
  readonly dataVoiceAuraState: VoiceAuraState | undefined;
  readonly dataVoiceAuraIntensity: VoiceAuraIntensity | undefined;
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — the voice-aura `data-*` attributes on the
// composer box, present only while the aura is active.
function composerVoiceAuraDataAttributes(
  voiceAura: VoiceAuraStateSnapshot,
): ComposerVoiceAuraDataAttributes {
  if (!voiceAura.active) {
    return {
      dataVoiceAura: undefined,
      dataVoiceAuraState: undefined,
      dataVoiceAuraIntensity: undefined,
    };
  }
  return {
    dataVoiceAura: "on",
    dataVoiceAuraState: voiceAura.state,
    dataVoiceAuraIntensity: voiceAura.intensity,
  };
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — the inline @-mention repository picker: a
// status live-region plus the picker panel, rendered only while a mention is active.
function ComposerRepositoryPickerInline(props: RepositoryFilePickerPanelProps): ReactNode {
  return (
    <div className="repo-focus repo-focus-inline">
      <span className="sr-only" role="status" aria-live="polite">
        {props.pickError ?? props.search.error ?? props.search.message}
      </span>
      <RepositoryFilePickerPanel {...props} />
    </div>
  );
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — whether the attachment drop zone /
// picker is enabled: only once a model is selected and it supports at least one attachment kind.
function composerAttachEnabled(selectedModelCapability: ModelCapability | undefined): boolean {
  return (
    selectedModelCapability !== undefined &&
    (selectedModelCapability.supportsImageInput || selectedModelCapability.supportsDocumentInput)
  );
}

interface ComposerDictationVisibility {
  readonly voiceDictationVisible: boolean;
  readonly liveDictationEnabled: boolean;
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — Issue #495's capability gate: the mic
// affordance appears once the deployment advertises speech-to-text AND the browser can capture
// audio; live (realtime) dictation further requires realtime voice + transport support.
function composerDictationVisibility(
  voiceCapability: VoiceCapabilityResolution | undefined,
): ComposerDictationVisibility {
  const voiceDictationVisible = supportsDictation(voiceCapability) && dictationCaptureSupported();
  const liveDictationEnabled =
    voiceDictationVisible &&
    supportsRealtimeVoice(voiceCapability) &&
    realtimeVoiceTransportSupported();
  return { voiceDictationVisible, liveDictationEnabled };
}

interface ComposerVoiceToolAvailability {
  readonly voiceGroundingToolAvailable: boolean;
  readonly voiceMemoryToolAvailable: boolean;
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — whether the realtime voice session may
// call the grounded-retrieval / memory tools, gated on the relevant feature being active plus the
// deployment's realtime tool-calling support.
function composerVoiceToolAvailability(
  voiceGroundingActive: boolean,
  memoryEnabled: boolean,
  voiceCapability: VoiceCapabilityResolution | undefined,
): ComposerVoiceToolAvailability {
  return {
    voiceGroundingToolAvailable:
      voiceGroundingActive && supportsRealtimeToolCalling(voiceCapability),
    voiceMemoryToolAvailable: memoryEnabled && supportsRealtimeToolCalling(voiceCapability),
  };
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — the composer's post-textarea status row:
// the send-lifecycle announcement (hidden during Voice Dialogue) and the dictation transcript
// preview (hidden during Voice Dialogue or when dictation isn't available).
function ComposerStatusRow({
  voiceDialogActive,
  sendStatus,
  voiceDictationVisible,
  dictation,
  onAfterDictationDiscard,
}: {
  readonly voiceDialogActive: boolean;
  readonly sendStatus: SendStatus;
  readonly voiceDictationVisible: boolean;
  readonly dictation: DictationController;
  readonly onAfterDictationDiscard: () => void;
}): ReactNode {
  return (
    <>
      {voiceDialogActive ? null : <SendLifecycleStatus status={sendStatus} />}
      {!voiceDialogActive && voiceDictationVisible ? (
        <VoiceDictationPreviewFromController
          controller={dictation}
          onAfterDiscard={onAfterDictationDiscard}
        />
      ) : null}
    </>
  );
}

// Extracted from ComposerCoreImpl (SonarCloud S3776) — the voice-dialogue overlay: the announced
// headline live region (only while the aura is active) and the Voice Dialogue control layer
// (only while available), each independently gated.
function ComposerVoiceOverlay({
  voiceAuraActive,
  announcedVoiceHeadline,
  voiceDialogAvailable,
  voiceLayerRef,
  voiceDialogActive,
  realtimeVoiceMuted,
  onToggleVoiceMute,
  playbackButtonRef,
  onToggleVoiceDialog,
  voiceDialogButtonRef,
  compact,
}: {
  readonly voiceAuraActive: boolean;
  readonly announcedVoiceHeadline: string;
  readonly voiceDialogAvailable: boolean;
  readonly voiceLayerRef: Ref<HTMLDivElement>;
  readonly voiceDialogActive: boolean;
  readonly realtimeVoiceMuted: boolean;
  readonly onToggleVoiceMute: () => void;
  readonly playbackButtonRef: Ref<HTMLButtonElement>;
  readonly onToggleVoiceDialog: () => void;
  readonly voiceDialogButtonRef: Ref<HTMLButtonElement>;
  readonly compact: boolean;
}): ReactNode {
  return (
    <>
      {voiceAuraActive ? (
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcedVoiceHeadline}
        </span>
      ) : null}
      {voiceDialogAvailable ? (
        <div
          ref={voiceLayerRef}
          className={`${styles.composerLayer} ${styles.voiceLayer}`}
          data-composer-layer="voice"
          aria-hidden={voiceDialogActive ? undefined : true}
        >
          <VoiceDialogComposerControls
            voiceMuted={realtimeVoiceMuted}
            onToggleVoiceMute={onToggleVoiceMute}
            playbackButtonRef={playbackButtonRef}
            voiceDialogActive={voiceDialogActive}
            onToggleVoiceDialog={onToggleVoiceDialog}
            voiceDialogButtonRef={voiceDialogButtonRef}
            compact={compact}
          />
        </div>
      ) : null}
    </>
  );
}

function ComposerCoreImpl({
  ready,
  placeholder,
  minimal = false,
  compact = false,
  controlsNarrow = false,
  barCompact = false,
}: ComposerCoreProps): ReactNode {
  const t = useTranslate();
  // GEN-PERF-CHAT-014 — the settled slice: identical to the full session API minus the
  // per-frame streaming delta, which the composer never renders. Combined with the memo
  // wrapper below, a token flush no longer re-executes this whole subtree (textarea
  // auto-grow, attachment intake, mention autocomplete, voice-capability gating) up to
  // 60×/s while a reply streams.
  const session = useChatSessionComposer();
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
    error,
    messages,
    activeChat,
    activeProject,
    replaceChat,
  } = session;
  // uiux-fix F009 C089 — auto-grow the composer with its content up to 220px
  // (~8-9 lines at 15px/1.5), then scroll. Clearing the draft after a send
  // collapses the textarea back to its rows={2} minimum. The mini composer
  // (MiniChat) has its own textarea without this effect and stays height:100%.
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = taRef.current;
    if (ta === null) return;
    ta.style.height = "auto";
    ta.style.height = `${String(Math.min(ta.scrollHeight, 220))}px`;
  }, [draft]);

  // Rejection state for the inline alert (AC #2 / Part 2).
  const [rejectionReason, setRejectionReason] = useState<AttachmentRejectionReason | undefined>();
  const [rejectionMime, setRejectionMime] = useState<string | undefined>();

  const selectedModelCapability = models.find((m) => m.id === selectedModel);

  // Derive whether any attachment kinds are supported by the selected model.
  const attachEnabled = composerAttachEnabled(selectedModelCapability);

  const handleFiles = useCallback(
    async (files: readonly File[]) => {
      const { reason, mime } = await collectFirstAttachmentRejection(files, addPendingAttachment);
      setRejectionReason(reason);
      setRejectionMime(mime);
    },
    [addPendingAttachment],
  );

  // Issue #495 — capability-gated composer dictation. The probe is non-blocking: the composer
  // renders fully while `useVoiceCapability` resolves, and the mic affordance appears only once the
  // deployment advertises speech-to-text AND the browser can capture audio. A no-voice / unsupported
  // environment shows no voice control at all, so the composer stays clean and fully text-capable.
  const voiceCapability = useVoiceCapability();
  const { voiceDictationVisible, liveDictationEnabled } =
    composerDictationVisibility(voiceCapability);
  // Issue #501 — assistant speech-output gate: reuse the already-fetched voiceCapability probe (no
  // second fetch). Only true when the deployment advertises speech output; STT-only and no-voice
  // deployments leave it false, so no playback control appears and Keiko answers in text (AC1).
  const voiceSpeechOutputVisible = supportsSpeechOutput(voiceCapability);
  const micButtonRef = useRef<HTMLButtonElement>(null);
  const playbackButtonRef = useRef<HTMLButtonElement>(null);
  const voiceDialogButtonRef = useRef<HTMLButtonElement>(null);
  const normalVoiceDialogButtonRef = useRef<HTMLButtonElement>(null);
  // Insert appends the reviewed transcript into the existing draft (separated by a space) and returns
  // focus to the composer so the keyboard-first text workflow is preserved; it never auto-sends.
  const insertTranscript = useCallback(
    (text: string): void => {
      setDraft(draft.trim().length === 0 ? text : `${draft.replace(/\s+$/u, "")} ${text}`);
      taRef.current?.focus();
    },
    [draft, setDraft],
  );
  const dictation = useDictation({
    onInsert: insertTranscript,
    realtime: { enabled: liveDictationEnabled },
  });
  // Issue #1559/#1560 — dialog-mode availability + persona selection. Voice Dialogue is true
  // WebRTC realtime speech-to-speech; STT dictation remains a separate "speech to draft" feature.
  const voiceDialog = useVoiceDialogMode({ capability: voiceCapability });
  const playback = useAssistantSpeech({
    profile: voiceCapability?.profile ?? "none",
    // Voice output is owned by the explicit Voice Dialogue loop. A reload or normal text chat must not
    // auto-speak the latest settled assistant answer just because speech output is available.
    enabled: false,
    text: undefined,
    messageId: undefined,
  });
  const voiceGrounding = voiceSessionGroundingContext(activeChat);
  const voiceGroundingActive = voiceGrounding?.enabled === true;
  const { voiceGroundingToolAvailable, voiceMemoryToolAvailable } = composerVoiceToolAvailability(
    voiceGroundingActive,
    session.memoryEnabled,
    voiceCapability,
  );
  const realtimeVoice = useRealtimeVoice({
    persona: voiceDialog.persona,
    chatContext: composerRealtimeVoiceChatContext(
      activeChat,
      session.memoryEnabled,
      session.memoryBudgetTokens,
      voiceGrounding,
    ),
    groundingActive: voiceGroundingActive,
    groundingToolActive: voiceGroundingToolAvailable,
    memoryToolActive: voiceMemoryToolAvailable,
    memoryContextText: session.latestMemory?.context.text,
    onGroundedToolCall: session.runRealtimeGroundedTool,
    onMemoryToolCall: session.runRealtimeMemoryTool,
    onVoiceTurnCommitted: (messages) => session.appendVoiceTurn?.(messages),
  });
  const voiceDialogAvailable = voiceDialog.available && activeChat !== undefined;
  const voiceDialogState = deriveVoiceDialogState({
    realtimePhase: realtimeVoice.phase,
    turnState: realtimeVoice.turnSnapshot.state,
    muted: realtimeVoice.muted,
  });
  const voiceAura = deriveVoiceAuraState({
    voiceDialogActive: voiceDialog.active,
    voiceDialogAvailable,
    voiceDialogState,
    listening: realtimeVoice.listening,
    speaking: realtimeVoice.speaking,
    sending,
    sendStatus,
    hasSessionError: error !== undefined || realtimeVoice.error !== undefined,
    // A recovering transport (turn manager) → 'reconnecting'; an in-flight grounded retrieval →
    // 'checking-sources'. Both give the user a specific reason for the wait instead of dead air.
    reconnecting: realtimeVoice.turnSnapshot.recovering,
    retrieving: realtimeVoice.retrieving,
  });
  // Throttle the spoken-dialogue live region: a fast turn exchange can flip listening→thinking→speaking
  // within a second, and an unthrottled aria-live would read every transition aloud. Debouncing to the
  // settled state (after DIALOG_ANNOUNCE_DEBOUNCE_MS of quiet) announces what matters without the chatter,
  // while text chat's own SendLifecycleStatus keeps its immediate announcements.
  const [announcedVoiceHeadline, setAnnouncedVoiceHeadline] = useState("");
  useEffect(() => {
    if (!voiceAura.active) {
      setAnnouncedVoiceHeadline("");
      return undefined;
    }
    const headline = voiceAuraStateHeadline(voiceAura.state);
    const timer = setTimeout(() => {
      setAnnouncedVoiceHeadline(headline);
    }, DIALOG_ANNOUNCE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [voiceAura.active, voiceAura.state]);
  const enterVoiceDialog = useCallback(() => {
    if (!voiceDialogAvailable) {
      return;
    }
    voiceDialog.enter();
    realtimeVoice.start();
  }, [voiceDialog, voiceDialogAvailable, realtimeVoice]);
  const leaveVoiceDialog = useCallback(() => {
    realtimeVoice.stop();
    voiceDialog.leave();
  }, [realtimeVoice, voiceDialog]);
  // The normal and dialogue layers use distinct controls so each state can cross-fade without
  // moving layout. Flag a user-driven toggle and hand focus to the newly active layer (WCAG 2.4.3).
  // Programmatic auto-leave never sets the flag, so it never steals focus from the user.
  const restoreVoiceDialogFocusRef = useRef(false);
  const toggleVoiceDialog = useCallback(() => {
    restoreVoiceDialogFocusRef.current = true;
    if (voiceDialog.active) {
      leaveVoiceDialog();
    } else {
      enterVoiceDialog();
    }
  }, [voiceDialog.active, enterVoiceDialog, leaveVoiceDialog]);
  useVoiceDialogAutoLeaveEffects(
    voiceDialog.active,
    voiceDialogAvailable,
    realtimeVoice,
    leaveVoiceDialog,
  );
  const previousVoiceDialogActiveRef = useRef(voiceDialog.active);
  useEffect(() => {
    // The previously active layer becomes inert; move focus to the switch in the newly active
    // layer so a keyboard user is not dropped onto <body>. Runs only for a user-driven toggle.
    syncVoiceDialogLayerFocus({
      active: voiceDialog.active,
      previousActiveRef: previousVoiceDialogActiveRef,
      restoreFocusRef: restoreVoiceDialogFocusRef,
      voiceDialogButton: voiceDialogButtonRef.current,
      normalVoiceDialogButton: normalVoiceDialogButtonRef.current,
    });
  }, [voiceDialog.active]);

  const repositoryRoots = useMemo(
    () => connectedRepositoryRoots(activeChat, activeProject?.path),
    [activeChat, activeProject?.path],
  );
  const repositoryRootKey = repositoryRoots.map((root) => root.root).join("\u0001");
  const [selectedRepositoryRoot, setSelectedRepositoryRoot] = useState(
    repositoryRoots[0]?.root ?? "",
  );
  const [repositoryMention, setRepositoryMention] = useState<RepositoryMentionRange | null>(null);
  const [repositoryPickingPath, setRepositoryPickingPath] = useState<string | null>(null);
  const [repositoryPickError, setRepositoryPickError] = useState<string | null>(null);
  const [repositoryHighlightedIndex, setRepositoryHighlightedIndex] = useState(0);
  const [repositoryReferences, setRepositoryReferences] = useState<
    readonly ComposerRepositoryReference[]
  >([]);
  const repositoryPickerOpen = repositoryMention !== null && repositoryRoots.length > 0;
  const repositorySearch = useRepositoryFileSearch(
    repositoryPickerOpen,
    selectedRepositoryRoot,
    repositoryMention?.query ?? "",
  );

  useEffect(() => {
    if (repositoryRoots.length === 0) {
      setSelectedRepositoryRoot("");
      setRepositoryMention(null);
      return;
    }
    if (!repositoryRoots.some((root) => root.root === selectedRepositoryRoot)) {
      setSelectedRepositoryRoot(repositoryRoots[0]?.root ?? "");
    }
  }, [repositoryRootKey, repositoryRoots, selectedRepositoryRoot]);

  useEffect(() => {
    setRepositoryHighlightedIndex(0);
  }, [repositoryMention?.query, repositorySearch.results]);

  useEffect(() => {
    setRepositoryReferences((current) =>
      synchronizeComposerRepositoryReferences({
        current,
        draft,
        selectedRoot: selectedRepositoryRoot,
        roots: repositoryRoots,
        searchResults: repositorySearch.results,
      }),
    );
  }, [draft, repositoryRootKey, repositoryRoots, repositorySearch.results, selectedRepositoryRoot]);

  const updateRepositoryMentionFromTextarea = useCallback(
    (value: string, cursor: number): void => {
      if (repositoryRoots.length === 0) {
        setRepositoryMention(null);
        return;
      }
      const mention = repositoryMentionAtCursor(value, cursor);
      setRepositoryMention(mention);
      if (mention !== null) setRepositoryPickError(null);
    },
    [repositoryRoots.length],
  );

  const insertRepositoryFileReference = useCallback(
    async (result: FilesSearchResult): Promise<void> => {
      if (activeChat === undefined) return;
      setRepositoryPickingPath(result.path);
      setRepositoryPickError(null);
      try {
        const merged = mergeRepositoryFileScope(activeChat, result.root, result.path);
        if (merged.changed) {
          const response = await updateChat(activeChat.id, { connectedScopes: merged.scopes });
          replaceChat(response.chat);
        }
        const fallbackCursor = taRef.current?.selectionStart ?? draft.length;
        const mention = repositoryMention ?? repositoryMentionAtCursor(draft, fallbackCursor);
        const next = resolveRepositoryMentionInsertion(draft, mention, result.path);
        setRepositoryReferences((current) =>
          mergeComposerRepositoryReference(current, repositoryReferenceFromResult(result)),
        );
        setDraft(next.value);
        setRepositoryMention(null);
        requestAnimationFrame(() => {
          taRef.current?.focus();
          taRef.current?.setSelectionRange(next.cursor, next.cursor);
        });
      } catch (caught) {
        setRepositoryPickError(formatRepositoryFocusError(caught, t));
      } finally {
        setRepositoryPickingPath(null);
      }
    },
    [activeChat, draft, replaceChat, repositoryMention, setDraft, t],
  );

  const removeRepositoryReference = useCallback(
    (id: string): void => {
      const reference = repositoryReferences.find((item) => item.id === id);
      if (reference === undefined) return;
      setRepositoryReferences((current) => current.filter((item) => item.id !== id));
      setDraft(removeRepositoryReferenceFromDraft(draft, reference.path));
      requestAnimationFrame(() => {
        taRef.current?.focus();
      });
    },
    [draft, repositoryReferences, setDraft],
  );

  const handleDraftChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>): void => {
      const next = event.target.value;
      setDraft(next);
      updateRepositoryMentionFromTextarea(next, event.target.selectionStart ?? next.length);
    },
    [setDraft, updateRepositoryMentionFromTextarea],
  );

  const handleDraftSelect = useCallback(
    (event: SyntheticEvent<HTMLTextAreaElement>): void => {
      if (repositoryMention === null) return;
      const target = event.currentTarget;
      updateRepositoryMentionFromTextarea(
        target.value,
        target.selectionStart ?? target.value.length,
      );
    },
    [repositoryMention, updateRepositoryMentionFromTextarea],
  );

  const handleDraftKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (repositoryPickerOpen) {
        const handled = handleRepositoryPickerKeyDown(event, {
          results: repositorySearch.results,
          highlightedIndex: repositoryHighlightedIndex,
          setHighlightedIndex: setRepositoryHighlightedIndex,
          closeMention: () => setRepositoryMention(null),
          pickResult: (picked) => {
            void insertRepositoryFileReference(picked);
          },
        });
        if (handled) return;
      }
      onComposerKeyDown(sendMessage)(event);
    },
    [
      insertRepositoryFileReference,
      repositoryHighlightedIndex,
      repositoryPickerOpen,
      repositorySearch.results,
      sendMessage,
    ],
  );

  const composerBoxClassName = composerBoxClassNameFor(compact, voiceDialog.active);
  // React 18 treats `inert` as an unknown non-boolean attribute. Toggle the native attribute in
  // the commit ref so each fading layer becomes non-interactive synchronously, without rendering
  // duplicate accessibility targets or emitting a runtime warning.
  const normalLayerRef = useCallback(
    (node: HTMLDivElement | null): void => {
      node?.toggleAttribute("inert", voiceDialog.active);
    },
    [voiceDialog.active],
  );
  const voiceLayerRef = useCallback(
    (node: HTMLDivElement | null): void => {
      node?.toggleAttribute("inert", !voiceDialog.active);
    },
    [voiceDialog.active],
  );

  const voiceAuraDataAttributes = composerVoiceAuraDataAttributes(voiceAura);
  const comboboxAria = composerRepositoryComboboxAria(
    repositoryPickerOpen,
    repositorySearch.results.length,
    t,
  );
  const textareaAutocompleteAria = composerTextareaAutocompleteAria(
    repositoryPickerOpen,
    repositorySearch.results.length,
    repositoryHighlightedIndex,
  );

  return (
    <div
      className={composerBoxClassName}
      data-voice-aura={voiceAuraDataAttributes.dataVoiceAura}
      data-voice-aura-state={voiceAuraDataAttributes.dataVoiceAuraState}
      data-voice-aura-intensity={voiceAuraDataAttributes.dataVoiceAuraIntensity}
    >
      <div
        ref={normalLayerRef}
        className={`${styles.composerLayer} ${styles.normalLayer}`}
        data-composer-layer="normal"
        aria-hidden={voiceDialog.active ? true : undefined}
      >
        <div className="cmp-input-stack">
          {/* Drop zone above the textarea (Part 2 — shown when attachment is supported) */}
          <AttachDropZone enabled={attachEnabled} onFiles={handleFiles} />
          {/* ARIA combobox wrapper: while the @-mention repository picker is open
            this container exposes role="combobox" and owns the results listbox
            (aria-expanded / aria-controls). A multi-line <textarea> may not carry
            role="combobox" itself (ARIA 1.2), so the wrapper holds the combobox
            role while the textarea keeps DOM focus and conveys the highlighted
            option via aria-activedescendant (WAI-ARIA 1.1 combobox pattern). When
            the picker is closed the wrapper is an inert container and the
            textarea is a plain textbox. */}
          <div
            className="cmp-input-combobox"
            role={comboboxAria.role}
            aria-label={comboboxAria.ariaLabel}
            aria-expanded={comboboxAria.ariaExpanded}
            aria-haspopup={comboboxAria.ariaHaspopup}
            // aria-controls references the listbox, which only exists once results
            // have loaded — guarding keeps the idref resolvable (aria-valid-attr-value).
            aria-controls={comboboxAria.ariaControls}
          >
            <textarea
              className="cmp-input"
              ref={taRef}
              rows={2}
              value={draft}
              aria-label={t("chat.messageLabel")}
              placeholder={placeholder}
              // aria-autocomplete + aria-activedescendant are valid on the textbox
              // and communicate the autocomplete behavior and highlighted option
              // without moving DOM focus off the textarea.
              aria-autocomplete={textareaAutocompleteAria.ariaAutocomplete}
              aria-activedescendant={textareaAutocompleteAria.ariaActivedescendant}
              onChange={handleDraftChange}
              onSelect={handleDraftSelect}
              onKeyDown={handleDraftKeyDown}
              // uiux-fix F041 (C205, supersedes F009 C077 readOnly) — the textarea stays
              // fully editable while a send is in flight so the next message can be
              // pre-typed during streaming. Re-submit stays blocked by the isInFlight
              // guard in useChatSession, and the primary button is "Cancel" meanwhile.
            />
          </div>
          {repositoryPickerOpen ? (
            <ComposerRepositoryPickerInline
              roots={repositoryRoots}
              selectedRoot={selectedRepositoryRoot}
              onRootChange={(next) => {
                setSelectedRepositoryRoot(next);
                setRepositoryHighlightedIndex(0);
              }}
              search={repositorySearch}
              pickingPath={repositoryPickingPath}
              highlightedIndex={repositoryHighlightedIndex}
              pickError={repositoryPickError}
              onPick={(result) => {
                void insertRepositoryFileReference(result);
              }}
              onClose={() => setRepositoryMention(null)}
            />
          ) : null}
          <RepositoryReferenceStrip
            references={repositoryReferences}
            onRemove={removeRepositoryReference}
          />
          {/* Chip strip below the textarea, above the composer bar (AC #3) */}
          <AttachmentStrip attachments={pendingAttachments} onRemove={removePendingAttachment} />
          {/* Inline rejection alert — role="alert" announces immediately (AC #2) */}
          <AttachRejectionAlert reason={rejectionReason} mimeType={rejectionMime} />
          {/* Issue #152 / AC#1 + AC#4 — lifecycle status announcement. Renders
            adjacent to the textarea so SR users hear the state without losing
            composer focus. Hidden when there is nothing to announce.
            Issue #495 — dictation transcript review / transcribing status / error. Lives in the
            input stack so it is contextually adjacent to the textarea and announced to assistive
            tech. It renders live capture feedback while recording and stays hidden only when idle. */}
          <ComposerStatusRow
            voiceDialogActive={voiceDialog.active}
            sendStatus={sendStatus}
            voiceDictationVisible={voiceDictationVisible}
            dictation={dictation}
            onAfterDictationDiscard={() => micButtonRef.current?.focus()}
          />
        </div>
        <div className="cmp-footer-row">
          <ComposerBar
            session={session}
            ready={ready}
            selectedModelCapability={selectedModelCapability}
            onAttachFiles={handleFiles}
            controlsNarrow={controlsNarrow}
            barCompact={barCompact}
            voiceDictationVisible={voiceDictationVisible}
            dictation={dictation}
            micButtonRef={micButtonRef}
            voiceSpeechOutputVisible={voiceSpeechOutputVisible}
            voiceMuted={playback.snapshot.muted}
            onToggleVoiceMute={playback.toggleMute}
            playbackButtonRef={playbackButtonRef}
            voiceDialogAvailable={voiceDialogAvailable}
            voiceDialogActive={false}
            onToggleVoiceDialog={toggleVoiceDialog}
            voiceDialogButtonRef={normalVoiceDialogButtonRef}
          />
        </div>
      </div>
      <ComposerVoiceOverlay
        voiceAuraActive={voiceAura.active}
        announcedVoiceHeadline={announcedVoiceHeadline}
        voiceDialogAvailable={voiceDialogAvailable}
        voiceLayerRef={voiceLayerRef}
        voiceDialogActive={voiceDialog.active}
        realtimeVoiceMuted={realtimeVoice.muted}
        onToggleVoiceMute={realtimeVoice.toggleMute}
        playbackButtonRef={playbackButtonRef}
        onToggleVoiceDialog={toggleVoiceDialog}
        voiceDialogButtonRef={voiceDialogButtonRef}
        compact={controlsNarrow}
      />
    </div>
  );
}

// GEN-PERF-CHAT-014 — bail out of stream-flush renders: all props are primitives and the
// consumed contexts (settled state + actions + translate) keep their identity across a
// token flush, so the default shallow comparison is sufficient.
const ComposerCore = memo(ComposerCoreImpl);

// Deliverable: polished empty state when no messages are present and an active
// chat exists. Keep the center copy intentionally minimal so the composer
// remains the primary action.
interface EmptyComposerStateProps {
  readonly minimal?: boolean;
}

function EmptyComposerState({ minimal = false }: EmptyComposerStateProps): ReactNode {
  const t = useTranslate();
  if (minimal) {
    return (
      <div
        className="chatw-empty chatw-empty-minimal"
        role="note"
        aria-label={t("chat.conversationReady")}
      >
        <h2 className="chatw-empty-headline">{t("chat.empty.headline")}</h2>
      </div>
    );
  }
  return (
    <div className="chatw-empty">
      <h2 className="chatw-empty-headline">{t("chat.empty.headline")}</h2>
    </div>
  );
}

// Rendered when no chat has been selected yet (activeChat is undefined).
// Instructs the user to pick or start a chat from the project sidebar.
function NoChatState(): ReactNode {
  const t = useTranslate();
  return (
    <div className="chatw-empty-no-chat">
      <div className="chatw-empty-no-chat-icon" aria-hidden="true">
        <Icons.spark size={20} />
      </div>
      <p className="chatw-empty-no-chat-label">{t("chat.empty.noChat.title")}</p>
      <p className="chatw-empty-no-chat-hint">{t("chat.empty.noChat.hint")}</p>
    </div>
  );
}

// #28 — When multiple grounding sources are active (multiple connectors, or a
// connector plus folder scopes), we cannot represent them as a single select
// value. Return the dedicated sentinel "multi" so the select shows a read-only
// "Multiple sources" summary label instead of silently showing only the first.
function activeGroundingSourceCount(chat: Chat): number {
  const folderCount =
    chat.connectedScopes !== undefined
      ? chat.connectedScopes.length
      : chat.connectedScope !== undefined
        ? 1
        : 0;
  const connectorCount =
    chat.localKnowledgeScopes !== undefined
      ? chat.localKnowledgeScopes.length
      : chat.localKnowledgeScope !== undefined
        ? 1
        : 0;
  return folderCount + connectorCount;
}

function groundedModeValue(chat: Chat): string {
  // Multi-source: more than one grounding scope of any kind.
  if (activeGroundingSourceCount(chat) > 1) return "multi";
  const firstLocalKnowledgeScope = chat.localKnowledgeScopes?.[0] ?? chat.localKnowledgeScope;
  if (firstLocalKnowledgeScope?.kind === "capsule") {
    return `capsule:${firstLocalKnowledgeScope.capsuleId}`;
  }
  if (firstLocalKnowledgeScope?.kind === "capsule-set") {
    return `capsule-set:${firstLocalKnowledgeScope.capsuleSetId}`;
  }
  if (hasFolderGroundingScope(chat)) return "files";
  return "none";
}

// GRD-009: the current connector (local-knowledge) scopes for a chat, normalising the legacy
// single-scope field into the list shape. Used so connecting a connector appends rather than
// replaces, keeping hybrid (folder + connector) grounding intact.
function currentConnectorScopes(chat: Chat): readonly ChatLocalKnowledgeScope[] {
  if (chat.localKnowledgeScopes !== undefined) return chat.localKnowledgeScopes;
  return chat.localKnowledgeScope !== undefined ? [chat.localKnowledgeScope] : [];
}

function hasFolderGroundingScope(chat: Chat | undefined): boolean {
  return (
    chat !== undefined &&
    (chat.connectedScope !== undefined ||
      (chat.connectedScopes !== undefined && chat.connectedScopes.length > 0))
  );
}

function hasConnectorGroundingScope(chat: Chat | undefined): boolean {
  return (
    chat !== undefined &&
    (chat.localKnowledgeScope !== undefined ||
      (chat.localKnowledgeScopes !== undefined && chat.localKnowledgeScopes.length > 0))
  );
}

function hasGroundingScope(chat: Chat | undefined): boolean {
  return hasFolderGroundingScope(chat) || hasConnectorGroundingScope(chat);
}

function voiceSessionGroundingContext(
  chat: Chat | undefined,
): VoiceSessionGroundingContext | undefined {
  if (chat === undefined) return undefined;
  const folderCount =
    chat.connectedScopes !== undefined
      ? chat.connectedScopes.length
      : chat.connectedScope !== undefined
        ? 1
        : 0;
  const connectorCount =
    chat.localKnowledgeScopes !== undefined
      ? chat.localKnowledgeScopes.length
      : chat.localKnowledgeScope !== undefined
        ? 1
        : 0;
  const sourceCount = folderCount + connectorCount;
  if (sourceCount === 0) return undefined;
  const kind: VoiceSessionGroundingContext["kind"] =
    folderCount > 0 && connectorCount > 0
      ? "hybrid"
      : sourceCount > 1
        ? "multi"
        : folderCount > 0
          ? "files"
          : "knowledge";
  return { enabled: true, sourceCount, kind };
}

function formatScopeUpdateError(error: unknown, t: I18nTranslate): string {
  // uiux-fix F041 (C171) — message first, machine code as trailing detail.
  return formatUserError(error, t("chat.error.scopeUpdate"));
}

interface ScopeOption {
  readonly value: string;
  readonly label: string;
  readonly badge?: string;
  readonly description?: string;
}

const UNAVAILABLE_CAPSULE_LABEL = "Knowledge Pod";
const UNAVAILABLE_CAPSULE_SET_LABEL = "Knowledge Pod Set";

function capsuleOptions(
  chat: Chat,
  capsules: readonly CapsuleListEntry[],
  t: I18nTranslate,
): readonly ScopeOption[] {
  const options = capsules.map((capsule) => ({
    value: `capsule:${capsule.id}`,
    label: t("chat.grounding.capsule", { name: capsule.displayName }),
    ...(capsule.knowledgePod?.guidance !== undefined
      ? {
          badge: capsule.knowledgePod.guidance.label,
          description: capsule.knowledgePod.guidance.description,
        }
      : {}),
  }));
  const selectedValue = groundedModeValue(chat);
  if (!selectedValue.startsWith("capsule:")) {
    return options;
  }
  if (options.some((option) => option.value === selectedValue)) {
    return options;
  }
  return [
    ...options,
    {
      value: selectedValue,
      // uiux-fix F041 (C173) — "(unavailable)" matches the capsule-set degraded
      // suffix; two different words previously named the same state.
      label: t("chat.grounding.unavailable", {
        label: UNAVAILABLE_CAPSULE_LABEL,
      }),
    },
  ];
}

function capsuleSetOptions(
  chat: Chat,
  capsuleSets: readonly CapsuleSetListEntry[],
  t: I18nTranslate,
): readonly ScopeOption[] {
  const options = capsuleSets.map((capsuleSet) => ({
    value: `capsule-set:${capsuleSet.id}`,
    label: t("chat.grounding.capsuleSet", { name: capsuleSet.displayName }),
    ...(capsuleSet.knowledgePod?.guidance !== undefined
      ? {
          badge: capsuleSet.knowledgePod.guidance.label,
          description: capsuleSet.knowledgePod.guidance.description,
        }
      : {}),
  }));
  const selectedValue = groundedModeValue(chat);
  if (!selectedValue.startsWith("capsule-set:")) {
    return options;
  }
  if (options.some((option) => option.value === selectedValue)) {
    return options;
  }
  return [
    ...options,
    {
      value: selectedValue,
      label: t("chat.grounding.unavailable", {
        label: UNAVAILABLE_CAPSULE_SET_LABEL,
      }),
    },
  ];
}

// uiux-fix F041 (C172) — the capsule/set catalog is loaded ONCE at the scope-header level and
// shared by the grounding select.
interface KnowledgeCatalog {
  readonly capsules: readonly CapsuleListEntry[];
  readonly capsuleSets: readonly CapsuleSetListEntry[];
  readonly loadError: string | null;
}

interface KnowledgeCatalogSnapshot {
  readonly capsules: readonly CapsuleListEntry[];
  readonly capsuleSets: readonly CapsuleSetListEntry[];
  readonly loadError: unknown | null;
}

const EMPTY_KNOWLEDGE_CATALOG: KnowledgeCatalogSnapshot = {
  capsules: [],
  capsuleSets: [],
  loadError: null,
};
const KNOWLEDGE_CATALOG_TTL_MS = 30_000;
const KNOWLEDGE_CATALOG_ERROR_TTL_MS = 5_000;
let knowledgeCatalogCache:
  | {
      readonly expiresAt: number;
      readonly snapshot: KnowledgeCatalogSnapshot;
    }
  | undefined;
let knowledgeCatalogPending: Promise<KnowledgeCatalogSnapshot> | undefined;

function cachedKnowledgeCatalogSnapshot(now: number): KnowledgeCatalogSnapshot | undefined {
  if (knowledgeCatalogCache === undefined || knowledgeCatalogCache.expiresAt <= now) {
    return undefined;
  }
  return knowledgeCatalogCache.snapshot;
}

async function loadKnowledgeCatalogSnapshot(): Promise<KnowledgeCatalogSnapshot> {
  const now = Date.now();
  const cached = cachedKnowledgeCatalogSnapshot(now);
  if (cached !== undefined) return cached;
  if (knowledgeCatalogPending !== undefined) return knowledgeCatalogPending;

  knowledgeCatalogPending = Promise.allSettled([
    fetchCapsules({ includeKnowledgePods: true }),
    fetchCapsuleSets({ includeKnowledgePods: true }),
  ])
    .then(([capsuleResult, capsuleSetResult]) => {
      if (capsuleResult.status !== "fulfilled") {
        return {
          ...EMPTY_KNOWLEDGE_CATALOG,
          loadError: capsuleResult.reason,
        };
      }
      const capsules = capsulesForKnowledgePodUi(capsuleResult.value).filter(
        (entry) => entry.lifecycleState === "ready",
      );
      const capsuleSets =
        capsuleSetResult.status === "fulfilled"
          ? capsuleSetsForKnowledgePodUi(capsuleSetResult.value)
          : [];
      const snapshot: KnowledgeCatalogSnapshot = {
        capsules,
        capsuleSets,
        loadError: capsuleSetResult.status === "fulfilled" ? null : capsuleSetResult.reason,
      };
      return snapshot;
    })
    .then((snapshot) => {
      const ttl =
        snapshot.loadError === null ? KNOWLEDGE_CATALOG_TTL_MS : KNOWLEDGE_CATALOG_ERROR_TTL_MS;
      knowledgeCatalogCache = { expiresAt: Date.now() + ttl, snapshot };
      return snapshot;
    })
    .finally(() => {
      knowledgeCatalogPending = undefined;
    });
  return knowledgeCatalogPending;
}

export function clearKnowledgeCatalogCacheForTests(): void {
  knowledgeCatalogCache = undefined;
  knowledgeCatalogPending = undefined;
}

function useKnowledgeCatalog(): KnowledgeCatalog {
  const t = useTranslate();
  const [snapshot, setSnapshot] = useState<KnowledgeCatalogSnapshot>(
    cachedKnowledgeCatalogSnapshot(Date.now()) ?? EMPTY_KNOWLEDGE_CATALOG,
  );

  useEffect(() => {
    let cancelled = false;
    void loadKnowledgeCatalogSnapshot().then((next) => {
      if (!cancelled) setSnapshot(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    capsules: snapshot.capsules,
    capsuleSets: snapshot.capsuleSets,
    loadError: snapshot.loadError === null ? null : formatScopeUpdateError(snapshot.loadError, t),
  };
}

// Extracted from LocalKnowledgeScopeControl's handleChange (SonarCloud S3776) — the "Model only"
// branch. #2 — permanently discards ALL active grounding sources (folder scopes + connectors);
// when sources are present, asks for explicit confirmation. On cancel, returns without mutating
// the chat (the caller's finally still releases the busy lock).
async function disconnectAllGroundingScopes(
  chat: Chat,
  t: I18nTranslate,
  onChatChanged: (chat: Chat) => void,
): Promise<void> {
  const sourceCount = activeGroundingSourceCount(chat);
  if (sourceCount > 0) {
    const confirmed = window.confirm(
      t("chat.grounding.disconnectConfirm", {
        count: sourceCount,
        sourceLabel:
          sourceCount === 1 ? t("chat.grounding.sourceSingular") : t("chat.grounding.sourcePlural"),
      }),
    );
    if (!confirmed) return;
  }
  const response = await updateChat(chat.id, { connectedScopes: null, localKnowledgeScopes: null });
  onChatChanged(response.chat);
}

// Extracted from LocalKnowledgeScopeControl's handleChange (SonarCloud S3776) — the "Live files"
// branch.
async function connectLiveFilesScope(
  chat: Chat,
  onChatChanged: (chat: Chat) => void,
): Promise<void> {
  const response = await updateChat(chat.id, { localKnowledgeScopes: null });
  onChatChanged(response.chat);
}

// Extracted from LocalKnowledgeScopeControl's handleChange (SonarCloud S3776) — the
// "capsule-set:" branch. GRD-009: additive + non-destructive. The server fully supports hybrid
// grounding (folder scopes + connectors, RRF over both, 16-each cap), so connecting a connector
// must NOT clear connected folders (no `connectedScopes: null`) or drop already-bound connectors.
// Append to the existing list (deduped); the BFF enforces the cap.
async function connectCapsuleSetScope(
  chat: Chat,
  capsuleSetId: string,
  onChatChanged: (chat: Chat) => void,
): Promise<void> {
  const scope: ChatLocalKnowledgeScope = {
    kind: "capsule-set",
    capsuleSetId: capsuleSetId as Extract<
      ChatLocalKnowledgeScope,
      { readonly kind: "capsule-set" }
    >["capsuleSetId"],
    connectedAtMs: Date.now(),
  };
  const current = currentConnectorScopes(chat);
  const next = current.some(
    (s) => s.kind === "capsule-set" && s.capsuleSetId === scope.capsuleSetId,
  )
    ? current
    : [...current, scope];
  const response = await updateChat(chat.id, { localKnowledgeScopes: next });
  onChatChanged(response.chat);
}

// Extracted from LocalKnowledgeScopeControl's handleChange (SonarCloud S3776) — the "capsule:"
// branch (see capsule-set branch above for the additive/non-destructive rationale).
async function connectCapsuleScope(
  chat: Chat,
  capsuleId: string,
  onChatChanged: (chat: Chat) => void,
): Promise<void> {
  const scope: ChatLocalKnowledgeScope = {
    kind: "capsule",
    capsuleId: capsuleId as Extract<
      ChatLocalKnowledgeScope,
      { readonly kind: "capsule" }
    >["capsuleId"],
    connectedAtMs: Date.now(),
  };
  const current = currentConnectorScopes(chat);
  const next = current.some((s) => s.kind === "capsule" && s.capsuleId === scope.capsuleId)
    ? current
    : [...current, scope];
  const response = await updateChat(chat.id, { localKnowledgeScopes: next });
  onChatChanged(response.chat);
}

// Extracted from LocalKnowledgeScopeControl's handleChange (SonarCloud S3776) — the classifier
// that dispatches the selected <select> value to its handler. Same value-space and behavior as
// the original if-chain (unmatched values are a no-op, matching the original's fall-through).
async function applyLocalKnowledgeScopeChange(
  value: string,
  chat: Chat,
  t: I18nTranslate,
  onChatChanged: (chat: Chat) => void,
): Promise<void> {
  if (value === "none") return disconnectAllGroundingScopes(chat, t, onChatChanged);
  if (value === "files") return connectLiveFilesScope(chat, onChatChanged);
  if (value.startsWith("capsule-set:")) {
    return connectCapsuleSetScope(chat, value.slice("capsule-set:".length), onChatChanged);
  }
  if (value.startsWith("capsule:")) {
    return connectCapsuleScope(chat, value.slice("capsule:".length), onChatChanged);
  }
}

function LocalKnowledgeScopeControl({
  chat,
  onChatChanged,
  catalog,
  connected,
}: {
  readonly chat: Chat;
  readonly onChatChanged: (chat: Chat) => void;
  readonly catalog: KnowledgeCatalog;
  readonly connected: boolean;
}): ReactNode {
  const t = useTranslate();
  const { capsules, capsuleSets, loadError } = catalog;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(value: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await applyLocalKnowledgeScopeChange(value, chat, t, onChatChanged);
    } catch (caught) {
      setError(formatScopeUpdateError(caught, t));
    } finally {
      setBusy(false);
    }
  }

  const value = groundedModeValue(chat);
  const capsuleChoices = capsuleOptions(chat, capsules, t);
  const capsuleSetChoices = capsuleSetOptions(chat, capsuleSets, t);
  // C172 — a catalog load failure surfaces here too; an update error wins.
  const displayedError = error ?? loadError;
  // uiux-fix F041 (C178) — classed instead of inline-styled (theme/hover/focus
  // layer lives in globals.css; the select was the shell's only raw UA widget).
  return (
    <div className="scope-grounding" data-connected={connected ? "true" : "false"}>
      <span className="scope-grounding-label mono">{t("chat.grounding.label")}</span>
      <KeikoSelect
        triggerClassName="scope-grounding-select"
        value={value}
        disabled={busy}
        ariaLabel={t("chat.grounding.mode")}
        menuTitle={t("chat.grounding.strategy")}
        sections={[
          {
            options: [
              { value: "none", label: t("chat.grounding.modelOnly") },
              {
                value: "files",
                label: t("chat.grounding.liveFiles"),
                disabled: !hasFolderGroundingScope(chat),
              },
              ...(value === "multi"
                ? [{ value: "multi", label: t("chat.grounding.multiple"), disabled: true }]
                : []),
              ...capsuleChoices.map((capsule) => ({
                value: capsule.value,
                label: capsule.label,
                ...(capsule.badge !== undefined ? { badge: capsule.badge } : {}),
                ...(capsule.description !== undefined ? { description: capsule.description } : {}),
              })),
              ...capsuleSetChoices.map((capsuleSet) => ({
                value: capsuleSet.value,
                label: capsuleSet.label,
                ...(capsuleSet.badge !== undefined ? { badge: capsuleSet.badge } : {}),
                ...(capsuleSet.description !== undefined
                  ? { description: capsuleSet.description }
                  : {}),
              })),
            ],
          },
        ]}
        onValueChange={(next) => {
          void handleChange(next);
        }}
      />
      {displayedError !== null ? (
        <span role="alert" className="scope-connect-error">
          {displayedError}
        </span>
      ) : null}
    </div>
  );
}

function ChatScopeHeaderImpl({
  chat,
  onChatChanged,
  memoryControl,
}: {
  readonly chat: Chat;
  readonly onChatChanged: (chat: Chat) => void;
  readonly memoryControl?: ReactNode;
}): ReactNode {
  // uiux-fix F041 (C172) — one catalog load feeds both the connector-pill display
  // names and the grounding select's option lists.
  const catalog = useKnowledgeCatalog();
  // uiux-fix F041 (C178/C179) — layout moved from inline styles to the
  // .chat-scope-header rule in globals.css (16px inset, themeable).
  const connected = hasGroundingScope(chat);
  return (
    <div className="chat-scope-header" data-grounded={connected ? "true" : "false"}>
      <LocalKnowledgeScopeControl
        chat={chat}
        onChatChanged={onChatChanged}
        catalog={catalog}
        connected={connected}
      />
      {memoryControl !== undefined ? (
        <div className="chat-scope-header-actions">{memoryControl}</div>
      ) : null}
    </div>
  );
}

// GEN-PERF-CHAT-014 — `chat` keeps identity across a token flush, `onChatChanged` is a
// stable action, and `memoryControl` is memoized at the call site, so the memo skips the
// per-frame stream re-render (this header runs the knowledge-catalog hook — the single
// most expensive sibling of the message list).
const ChatScopeHeader = memo(ChatScopeHeaderImpl);

// Issue #185 — surface the latest grounded answer's citations + uncertainty + omitted-count
// directly under the assistant bubble it explains. Hidden when there is no grounded turn yet
// or when the active chat carries no connectedScope binding (regular gateway chats never
// produce one). Rendered inside the role="log" conversation container, which already announces
// additions politely — no own aria-live (uiux-fix F040 C167: nested live regions caused double
// announcements of the same update).
// ADR-0057 D2 — the path-free context-assembly aggregate is carried on the folder/repo pack
// summary (connected-context answers, and the folder leg of hybrid answers). Local-knowledge
// answers and legacy packs have no such summary; the panel self-guards (renders null) on undefined.
function contextSummaryOf(
  answer: GroundedAnswerWire | undefined,
): GroundedAnswerContextSummaryWire | undefined {
  if (answer === undefined) return undefined;
  if (answer.groundingKind === "connected-context") return answer.contextPack.contextSummary;
  if (answer.groundingKind === "hybrid") return answer.contextPack.folder.contextSummary;
  return undefined;
}

function GroundedAnswerPanelImpl({
  chat,
  busy,
}: {
  readonly chat: Chat | undefined;
  readonly busy: boolean;
}): ReactNode {
  if (chat === undefined) return null;
  // Show the grounded panel when the chat has ANY scope binding (folder or connector, singular or
  // plural). This covers the legacy single-source fields and the #532/#189 plural list fields.
  if (!hasGroundingScope(chat)) return null;
  if (!busy) return null;
  return (
    <div className="chatw-grounded">
      <GroundedAnswer answer={undefined} busy={busy} />
    </div>
  );
}

// Shared shape of MemoryActionCard's async action runner, threaded into each per-kind card below.
type MemoryActionRunner = (
  actionCallback: () => Promise<void>,
  successMessage: string,
  errorMessage: string,
) => void;

// Extracted from MemoryActionCard (SonarCloud S3776) — the "candidate" kind's card.
function MemoryActionCandidateCard({
  action,
  busy,
  error,
  runAction,
  acceptCandidate,
  rejectCandidate,
  onDismissError,
}: {
  readonly action: Extract<ConversationMemoryActionWire, { readonly kind: "candidate" }>;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly runAction: MemoryActionRunner;
  readonly acceptCandidate: (proposalId: string) => Promise<void>;
  readonly rejectCandidate: (proposalId: string) => Promise<void>;
  readonly onDismissError: () => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <article className="chat-memory-action">
      <div className="chat-memory-action-head">
        <strong>{action.scopeLabel}</strong>
        <span>
          {action.requiresApproval
            ? t("chat.memory.approvalRequired")
            : t("chat.memory.proposedMemory")}
        </span>
      </div>
      <p>{action.body}</p>
      <div className="chat-memory-action-buttons">
        <button
          type="button"
          aria-disabled={busy}
          aria-busy={busy}
          onClick={() => {
            runAction(
              () => acceptCandidate(action.proposalId),
              t("chat.memory.accepted"),
              t("chat.memory.acceptError"),
            );
          }}
        >
          {t("chat.memory.accept")}
        </button>
        <button
          type="button"
          aria-disabled={busy}
          aria-busy={busy}
          onClick={() => {
            runAction(
              () => rejectCandidate(action.proposalId),
              t("chat.memory.rejected"),
              t("chat.memory.rejectError"),
            );
          }}
        >
          {t("chat.memory.reject")}
        </button>
      </div>
      {error !== undefined ? (
        <ErrorNoticeFromError
          error={error}
          fallback={t("chat.error.memoryUpdate")}
          onDismiss={onDismissError}
        />
      ) : null}
    </article>
  );
}

// Extracted from MemoryActionCard (SonarCloud S3776) — the "update" kind's card.
function MemoryActionUpdateCard({
  action,
}: {
  readonly action: Extract<ConversationMemoryActionWire, { readonly kind: "update" }>;
}): ReactNode {
  const t = useTranslate();
  return (
    <article className="chat-memory-action">
      <div className="chat-memory-action-head">
        <strong>{t("chat.memory.updateDetected")}</strong>
        <span>{action.memoryId}</span>
      </div>
      <p>
        {action.bodyPatch !== undefined
          ? t("chat.memory.suggestedUpdate", { body: action.bodyPatch })
          : t("chat.memory.suggestedUpdateFallback")}
      </p>
    </article>
  );
}

// Extracted from MemoryActionCard (SonarCloud S3776) — the "forget" kind's card. `confirmForget`
// and `forgetConfirmText` were previously parent state used only by this branch; they move down
// with it (each action instance keeps a stable React key, so this is not a behavior change — see
// the render site's key expression).
function MemoryActionForgetCard({
  action,
  busy,
  error,
  runAction,
  forgetMemoryAction,
  clearError,
}: {
  readonly action: Extract<ConversationMemoryActionWire, { readonly kind: "forget" }>;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly runAction: MemoryActionRunner;
  readonly forgetMemoryAction: (memoryId: string) => Promise<void>;
  readonly clearError: () => void;
}): ReactNode {
  const t = useTranslate();
  const [confirmForget, setConfirmForget] = useState(false);
  const [forgetConfirmText, setForgetConfirmText] = useState("");
  const executeForget = (): void => {
    if (action.requiresConfirmation && forgetConfirmText !== "FORGET") return;
    runAction(
      () =>
        forgetMemoryAction(action.memoryId).then(() => {
          setConfirmForget(false);
          setForgetConfirmText("");
        }),
      t("chat.memory.forgetCompleted"),
      t("chat.memory.forgetError"),
    );
  };
  return (
    <article className={`chat-memory-action${confirmForget ? " ai-danger" : ""}`}>
      <div className={`chat-memory-action-head${confirmForget ? " ai-danger-h" : ""}`}>
        {confirmForget ? (
          <span className="ic" aria-hidden="true">
            !
          </span>
        ) : null}
        <strong>{t("chat.memory.forgetDetected")}</strong>
        <span>
          {action.requiresConfirmation ? t("chat.memory.confirmationRequired") : action.memoryId}
        </span>
      </div>
      <p>{t("chat.memory.forgetMatched", { id: action.memoryId })}</p>
      {confirmForget ? (
        <label className="chat-memory-confirm">
          <span>{`Type FORGET to remove ${action.memoryId}.`}</span>
          <input
            value={forgetConfirmText}
            onChange={(event) => setForgetConfirmText(event.currentTarget.value)}
            autoComplete="off"
          />
        </label>
      ) : null}
      <div className="chat-memory-action-buttons">
        {!action.requiresConfirmation ? (
          <button type="button" aria-disabled={busy} aria-busy={busy} onClick={executeForget}>
            {t("chat.memory.forget")}
          </button>
        ) : !confirmForget ? (
          <button
            type="button"
            aria-disabled={busy}
            aria-busy={busy}
            onClick={() => {
              if (busy) return;
              clearError();
              setConfirmForget(true);
              setForgetConfirmText("");
            }}
          >
            {t("chat.memory.reviewForget")}
          </button>
        ) : (
          <>
            <button
              type="button"
              aria-disabled={busy || forgetConfirmText !== "FORGET"}
              aria-busy={busy}
              onClick={executeForget}
            >
              {t("chat.memory.forgetPermanently")}
            </button>
            <button
              type="button"
              aria-disabled={busy}
              aria-busy={busy}
              onClick={() => {
                if (busy) return;
                clearError();
                setConfirmForget(false);
                setForgetConfirmText("");
              }}
            >
              {t("common.cancel")}
            </button>
          </>
        )}
      </div>
      {error !== undefined ? (
        <ErrorNoticeFromError
          error={error}
          fallback={t("chat.error.memoryUpdate")}
          onDismiss={clearError}
        />
      ) : null}
    </article>
  );
}

// Extracted from MemoryActionCard (SonarCloud S3776) — the "rejected" kind's card.
// #28 — explicit case for kind "rejected" (memory proposal declined by the governed capture
// pipeline). Previously fell through to the default with the misleading title "MemoriaViva
// action not created".
function MemoryActionRejectedCard({
  action,
}: {
  readonly action: Extract<ConversationMemoryActionWire, { readonly kind: "rejected" }>;
}): ReactNode {
  const t = useTranslate();
  return (
    <article className="chat-memory-action">
      <div className="chat-memory-action-head">
        <strong>{t("chat.memory.proposalDeclined")}</strong>
      </div>
      <p>{action.reason !== "" ? action.reason : t("chat.memory.noReason")}</p>
    </article>
  );
}

function MemoryActionCard({
  action,
  acceptCandidate,
  rejectCandidate,
  forgetMemoryAction,
  onActionSettled,
}: {
  readonly action: ConversationMemoryActionWire;
  readonly acceptCandidate: (proposalId: string) => Promise<void>;
  readonly rejectCandidate: (proposalId: string) => Promise<void>;
  readonly forgetMemoryAction: (memoryId: string) => Promise<void>;
  readonly onActionSettled: (message: string) => void;
}): ReactNode {
  const t = useTranslate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const clearError = useCallback(() => setError(undefined), []);
  const runAction: MemoryActionRunner = useCallback(
    (actionCallback, successMessage, errorMessage) => {
      if (busy) return;
      setBusy(true);
      setError(undefined);
      void actionCallback()
        .then(() => {
          onActionSettled(successMessage);
        })
        .catch((caught) => {
          setError(caught instanceof Error ? caught.message : errorMessage);
        })
        .finally(() => setBusy(false));
    },
    [busy, onActionSettled],
  );
  if (action.kind === "candidate") {
    return (
      <MemoryActionCandidateCard
        action={action}
        busy={busy}
        error={error}
        runAction={runAction}
        acceptCandidate={acceptCandidate}
        rejectCandidate={rejectCandidate}
        onDismissError={clearError}
      />
    );
  }
  if (action.kind === "update") {
    return <MemoryActionUpdateCard action={action} />;
  }
  if (action.kind === "forget") {
    return (
      <MemoryActionForgetCard
        action={action}
        busy={busy}
        error={error}
        runAction={runAction}
        forgetMemoryAction={forgetMemoryAction}
        clearError={clearError}
      />
    );
  }
  if (action.kind === "rejected") {
    return <MemoryActionRejectedCard action={action} />;
  }
  return (
    <article className="chat-memory-action">
      <div className="chat-memory-action-head">
        <strong>{t("chat.memory.actionNotCreated")}</strong>
      </div>
    </article>
  );
}

// GEN-PERF-CHAT-014 — both props are stable across a token flush (chat identity, sending
// constant while a stream runs), so the memo skips the per-frame re-render.
const GroundedAnswerPanel = memo(GroundedAnswerPanelImpl);

function formatMemoryCapturedAt(capturedAt: number): string {
  return new Date(capturedAt).toISOString().slice(0, 10);
}

interface MemoryDisclosureState {
  readonly open: boolean;
  readonly actionStatus: string;
  readonly disclosureId: string;
  readonly disclosureButtonRef: RefObject<HTMLButtonElement | null>;
  readonly memoryCount: number;
  readonly memoryCountLabel: string;
  readonly memoryDisclosureLabel: string;
  readonly toggleDisclosure: () => void;
  readonly handleActionSettled: (message: string) => void;
}

function useMemoryDisclosureState(
  latestMemory: ConversationMemoryResultWire | undefined,
): MemoryDisclosureState {
  const t = useTranslate();
  const [open, setOpen] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const generatedId = useId();
  const disclosureId = `${generatedId}-chat-memory-disclosure`;
  const disclosureButtonRef = useRef<HTMLButtonElement>(null);
  const handleActionSettled = useCallback((message: string): void => {
    setActionStatus(message);
    disclosureButtonRef.current?.focus();
  }, []);
  const toggleDisclosure = useCallback((): void => {
    setOpen((current) => !current);
  }, []);
  const memoryCount = latestMemory?.context.memories.length ?? 0;
  const memoryDisclosureLabel =
    memoryCount > 0
      ? t("chat.memory.included", { count: memoryCount })
      : t("chat.memory.noneIncluded");
  const memoryCountLabel = memoryCount > 99 ? "99+" : String(memoryCount);

  // GEN-PERF-CHAT-014 — a fresh object literal here defeated the memo on every consumer
  // (ChatScopeHeader via memoryControl, MemoryPanel via disclosure) on every ChatWindow
  // render, including each per-frame stream flush. The ref is intentionally not a dep —
  // it is identity-stable for the component lifetime.
  return useMemo(
    () => ({
      open,
      actionStatus,
      disclosureId,
      disclosureButtonRef,
      memoryCount,
      memoryCountLabel,
      memoryDisclosureLabel,
      toggleDisclosure,
      handleActionSettled,
    }),
    [
      open,
      actionStatus,
      disclosureId,
      memoryCount,
      memoryCountLabel,
      memoryDisclosureLabel,
      toggleDisclosure,
      handleActionSettled,
    ],
  );
}

function MemoryDisclosureButton({
  disclosure,
}: {
  readonly disclosure: MemoryDisclosureState;
}): ReactNode {
  return (
    <button
      ref={disclosure.disclosureButtonRef}
      type="button"
      className="chat-memory-disclosure-toggle ui-tip cmp-tip-end"
      aria-expanded={disclosure.open}
      aria-controls={disclosure.disclosureId}
      aria-label={disclosure.memoryDisclosureLabel}
      data-empty={disclosure.memoryCount === 0 ? "true" : "false"}
      data-tip={disclosure.memoryDisclosureLabel}
      onClick={disclosure.toggleDisclosure}
    >
      <Icons.brain size={16} />
      {disclosure.memoryCount > 0 ? (
        <span className="chat-memory-count" aria-hidden="true">
          {disclosure.memoryCountLabel}
        </span>
      ) : null}
    </button>
  );
}

function MemoryPanelImpl({
  latestMemory,
  acceptCandidate,
  rejectCandidate,
  forgetMemoryAction,
  disclosure,
}: {
  readonly latestMemory: ConversationMemoryResultWire | undefined;
  readonly acceptCandidate: (proposalId: string) => Promise<void>;
  readonly rejectCandidate: (proposalId: string) => Promise<void>;
  readonly forgetMemoryAction: (memoryId: string) => Promise<void>;
  readonly disclosure: MemoryDisclosureState;
}): ReactNode {
  const t = useTranslate();
  if (!disclosure.open) return null;

  return (
    <section className="chat-memory-panel" aria-label={t("chat.memory.panel")}>
      <div id={disclosure.disclosureId} className="chat-memory-disclosure">
        <p className="chat-memory-summary">
          {latestMemory === undefined
            ? t("chat.memory.disclosurePending")
            : latestMemory.context.enabled
              ? t("chat.memory.usedTokens", {
                  used: latestMemory.context.budget.used,
                  tokens: latestMemory.context.budget.tokens,
                })
              : t("chat.memory.disabledLast")}
        </p>
        {latestMemory?.context.memories.map((memory) => (
          <article key={memory.memoryId} className="chat-memory-item">
            <div className="chat-memory-item-head">
              <strong>{memory.memoryId}</strong>
              <span>{memory.inclusionReason}</span>
            </div>
            <p>{memory.bodyExcerpt}</p>
            <dl
              className="chat-memory-meta"
              aria-label={t("chat.memory.provenance", { id: memory.memoryId })}
            >
              <div>
                <dt>{t("chat.memory.source")}</dt>
                <dd>{memory.sourceKind}</dd>
              </div>
              <div>
                <dt>{t("chat.memory.sensitivity")}</dt>
                <dd>{memory.sensitivity}</dd>
              </div>
              <div>
                <dt>{t("chat.memory.status")}</dt>
                <dd>{memory.status}</dd>
              </div>
              <div>
                <dt>{t("chat.memory.confidence")}</dt>
                <dd>{`${String(Math.round(memory.confidence * 100))}%`}</dd>
              </div>
              <div>
                <dt>{t("chat.memory.captured")}</dt>
                <dd>{formatMemoryCapturedAt(memory.capturedAt)}</dd>
              </div>
            </dl>
            {memory.captureRationale !== undefined ? (
              <p className="chat-memory-rationale">{memory.captureRationale}</p>
            ) : null}
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
            onActionSettled={disclosure.handleActionSettled}
          />
        ))}
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {disclosure.actionStatus}
        </p>
      </div>
    </section>
  );
}

// GEN-PERF-CHAT-014 — memory props and the (memoized) disclosure object keep identity
// across a token flush, so the memo skips the per-frame re-render.
const MemoryPanel = memo(MemoryPanelImpl);

function assistantCodeBlockApplyOutcome(
  outcome: ChatEditorApplyOutcome,
): AssistantCodeBlockApplyOutcome {
  if (outcome.kind === "conflict") return { kind: "conflict", code: outcome.code };
  return { kind: outcome.kind };
}

// Extracted from ChatWindow (SonarCloud S3776) — the code-apply workspace root is only defined
// when the active chat's project root matches the active project (same guard, now as ifs).
function codeApplyWorkspaceRootFor(
  activeChatRoot: string | undefined,
  activeProjectRoot: string | undefined,
): string | undefined {
  if (activeChatRoot === undefined) return undefined;
  if (activeChatRoot.trim().length === 0) return undefined;
  if (activeChatRoot !== activeProjectRoot) return undefined;
  return activeChatRoot;
}

// Extracted from ChatWindow (SonarCloud S3776) — AC #1: block ready when no model is available.
function isComposerReadyToSend(
  draft: string,
  sending: boolean,
  loading: boolean,
  noEligibleModels: boolean,
): boolean {
  return draft.trim().length > 0 && !sending && !loading && !noEligibleModels;
}

// Extracted from ChatWindow (SonarCloud S3776).
function hasLiveStreamingAssistantContent(
  streamingAssistantMessage: ChatMessage | undefined,
): boolean {
  return streamingAssistantMessage !== undefined && streamingAssistantMessage.content.length > 0;
}

// Extracted from ChatWindow (SonarCloud S3776) — the stick-to-bottom autoscroll's notion of "the
// last message on screen", live-streaming turn first.
function lastVisibleChatMessage(
  hasLiveStreamingAssistant: boolean,
  streamingAssistantMessage: ChatMessage | undefined,
  visible: readonly ChatMessage[],
): ChatMessage | undefined {
  if (hasLiveStreamingAssistant) return streamingAssistantMessage;
  if (visible.length > 0) return visible.at(-1);
  return undefined;
}

// Extracted from ChatWindow (SonarCloud S3776) — the mini/compact/minimal/workflow-compact
// prop combination collapsed into the three "effective" flags the render tree consumes.
function composerFooterEffectiveFlags(
  compact: boolean,
  mini: boolean,
  minimalChat: boolean,
  controlsNarrow: boolean,
  workflowCompact: boolean,
  barCompact: boolean,
): {
  readonly effectiveCompact: boolean;
  readonly effectiveControlsNarrow: boolean;
  readonly effectiveBarCompact: boolean;
} {
  return {
    effectiveCompact: compact || mini,
    effectiveControlsNarrow: controlsNarrow || mini || minimalChat || workflowCompact,
    effectiveBarCompact: barCompact || minimalChat,
  };
}

// Extracted from ChatWindow (SonarCloud S3776) — uiux-fix F009 C090's onScroll handler body:
// track whether the reader is near the bottom, and drop a stale pending question-jump once they
// scroll back near it themselves.
function handleChatWindowLogScroll(
  el: HTMLDivElement,
  stickRef: MutableRefObject<boolean>,
  pendingQuestionScrollRef: MutableRefObject<string | null>,
  focusedQuestionId: string | null,
  setFocusedQuestionId: (id: string | null) => void,
): void {
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  stickRef.current = nearBottom;
  if (nearBottom && focusedQuestionId !== null) {
    pendingQuestionScrollRef.current = null;
    setFocusedQuestionId(null);
  }
}

// Extracted from ChatWindow (SonarCloud S3776) — the composer's placeholder text.
function composerPlaceholder(visibleCount: number, loading: boolean, t: I18nTranslate): string {
  if (visibleCount === 0 && loading) return t("chat.loadingGateway");
  return t("chat.composer.placeholder");
}

// Extracted from ChatWindow (SonarCloud S3776) — the chat-scope header, memory panel, and
// no-model/loading alerts that sit above the scrollable log.
function ChatWindowStatusHeader({
  activeChat,
  replaceChat,
  memoryControl,
  latestMemory,
  acceptMemoryCandidate,
  rejectMemoryCandidate,
  forgetMemoryAction,
  memoryDisclosure,
  noEligibleModels,
  loading,
}: {
  readonly activeChat: Chat | undefined;
  readonly replaceChat: (chat: Chat) => void;
  readonly memoryControl: ReactNode;
  readonly latestMemory: ConversationMemoryResultWire | undefined;
  readonly acceptMemoryCandidate: (proposalId: string) => Promise<void>;
  readonly rejectMemoryCandidate: (proposalId: string) => Promise<void>;
  readonly forgetMemoryAction: (memoryId: string) => Promise<void>;
  readonly memoryDisclosure: MemoryDisclosureState;
  readonly noEligibleModels: boolean;
  readonly loading: boolean;
}): ReactNode {
  return (
    <>
      {activeChat !== undefined ? (
        <ChatScopeHeader
          chat={activeChat}
          onChatChanged={replaceChat}
          memoryControl={memoryControl}
        />
      ) : null}
      {activeChat !== undefined ? (
        <MemoryPanel
          latestMemory={latestMemory}
          acceptCandidate={acceptMemoryCandidate}
          rejectCandidate={rejectMemoryCandidate}
          forgetMemoryAction={forgetMemoryAction}
          disclosure={memoryDisclosure}
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
    </>
  );
}

// Extracted from ChatWindow (SonarCloud S3776) — the scrollable conversation log: empty state
// (per whether a chat is open) vs. the question map + conversation thread + grounded panel +
// sent-documents note.
function ChatWindowLog({
  scrollRef,
  stickRef,
  pendingQuestionScrollRef,
  focusedQuestionId,
  setFocusedQuestionId,
  visible,
  hasLiveStreamingAssistant,
  activeChat,
  effectiveMinimal,
  showQuestionMap,
  questionMapItems,
  scrollToQuestion,
  streamingAssistantMessage,
  onOpenRunResult,
  repositoryRoots,
  openRepositoryReference,
  onApplyCodeBlock,
  previewWindows,
  windowId,
  sending,
  sendStatus,
  regeneratingMessageId,
  cancelGrounded,
  regenerateMessage,
  cancelSend,
  registerQuestionAnchor,
  lastSentDocuments,
}: {
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly stickRef: MutableRefObject<boolean>;
  readonly pendingQuestionScrollRef: MutableRefObject<string | null>;
  readonly focusedQuestionId: string | null;
  readonly setFocusedQuestionId: (id: string | null) => void;
  readonly visible: readonly ChatMessage[];
  readonly hasLiveStreamingAssistant: boolean;
  readonly activeChat: Chat | undefined;
  readonly effectiveMinimal: boolean;
  readonly showQuestionMap: boolean;
  readonly questionMapItems: readonly ConversationQuestionMapItem[];
  readonly scrollToQuestion: (messageId: string) => void;
  readonly streamingAssistantMessage: ChatMessage | undefined;
  readonly onOpenRunResult: ((message: ChatMessage) => void) | undefined;
  readonly repositoryRoots: readonly RepositoryReferenceRoot[];
  readonly openRepositoryReference: OpenRepositoryReference | undefined;
  readonly onApplyCodeBlock: AssistantCodeBlockApply | undefined;
  readonly previewWindows: PdfCitationPreviewWindowApi | undefined;
  readonly windowId: string | undefined;
  readonly sending: boolean;
  readonly sendStatus: SendStatus;
  readonly regeneratingMessageId: string | undefined;
  readonly cancelGrounded: () => void;
  readonly regenerateMessage: (assistantMessageId: string) => Promise<void>;
  readonly cancelSend: () => void;
  readonly registerQuestionAnchor: (messageId: string, node: HTMLDivElement | null) => void;
  readonly lastSentDocuments: readonly SentDocumentDisclosure[];
}): ReactNode {
  const t = useTranslate();
  return (
    <div
      className="chatw-scroll"
      ref={scrollRef}
      role="log"
      aria-label={t("chat.conversation")}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable log region must be keyboard-focusable (axe scrollable-region-focusable)
      tabIndex={0}
      onScroll={(event) => {
        handleChatWindowLogScroll(
          event.currentTarget,
          stickRef,
          pendingQuestionScrollRef,
          focusedQuestionId,
          setFocusedQuestionId,
        );
      }}
    >
      {visible.length === 0 && !hasLiveStreamingAssistant ? (
        activeChat !== undefined ? (
          <EmptyComposerState minimal={effectiveMinimal} />
        ) : (
          <NoChatState />
        )
      ) : (
        <div className={`chatw-log-shell${showQuestionMap ? " chatw-log-shell-with-map" : ""}`}>
          {showQuestionMap ? (
            <ConversationQuestionMap items={questionMapItems} onJump={scrollToQuestion} />
          ) : null}
          <div className="chatw-log">
            <ConversationThread
              messages={visible}
              streamingAssistantMessage={streamingAssistantMessage}
              onOpenRunResult={onOpenRunResult}
              repositoryRoots={repositoryRoots}
              openRepositoryReference={openRepositoryReference}
              onApplyCodeBlock={onApplyCodeBlock}
              previewWindows={previewWindows}
              windowId={windowId}
              sending={sending}
              sendStatus={sendStatus}
              regeneratingMessageId={regeneratingMessageId}
              activeChat={activeChat}
              onCancelGrounded={cancelGrounded}
              onRegenerate={regenerateMessage}
              onCancelRegenerate={cancelSend}
              showRegenerateControls={!effectiveMinimal}
              registerQuestionAnchor={registerQuestionAnchor}
              focusedMessageId={focusedQuestionId}
            />
            <GroundedAnswerPanel chat={activeChat} busy={sending} />
            {/* Issue #148 — disclose which attached documents contributed extracted context. */}
            <SentDocumentsNote documents={lastSentDocuments} />
          </div>
        </div>
      )}
    </div>
  );
}

// Extracted from ChatWindow (SonarCloud S3776) — the composer form and its two error-notice
// slots (Issue #1560's single stable composer render site, see the render-site comment kept at
// the call site).
function ChatWindowComposerFooter({
  visible,
  activeChat,
  effectiveCompact,
  effectiveMinimal,
  effectiveControlsNarrow,
  effectiveBarCompact,
  ready,
  loading,
  sendMessage,
  error,
  clearError,
}: {
  readonly visible: readonly ChatMessage[];
  readonly activeChat: Chat | undefined;
  readonly effectiveCompact: boolean;
  readonly effectiveMinimal: boolean;
  readonly effectiveControlsNarrow: boolean;
  readonly effectiveBarCompact: boolean;
  readonly ready: boolean;
  readonly loading: boolean;
  readonly sendMessage: () => Promise<void>;
  readonly error: string | undefined;
  readonly clearError: (() => void) | undefined;
}): ReactNode {
  const t = useTranslate();
  return (
    <>
      {visible.length > 0 || activeChat !== undefined ? (
        <div className="chatw-foot">
          <form
            className={`composer${effectiveCompact ? " composer-chat-compact" : ""}`}
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            <ComposerCore
              ready={ready}
              placeholder={composerPlaceholder(visible.length, loading, t)}
              minimal={effectiveMinimal}
              compact={effectiveCompact}
              controlsNarrow={effectiveControlsNarrow}
              barCompact={effectiveBarCompact}
            />
            {error !== undefined ? (
              <ErrorNoticeFromError
                error={error}
                fallback={t("chat.error.send")}
                onDismiss={clearError}
              />
            ) : null}
          </form>
        </div>
      ) : null}

      {visible.length === 0 && error !== undefined && activeChat === undefined ? (
        <div className="chatw-foot">
          <ErrorNoticeFromError
            error={error}
            fallback="Could not load chat."
            onDismiss={clearError}
          />
        </div>
      ) : null}
    </>
  );
}

export function ChatWindow({
  windowId,
  mini = false,
  minimalChat = false,
  compact = false,
  controlsNarrow = false,
  barCompact = false,
  workflowCompact = false,
  linkedRoot = null,
  linkedRoots = [],
  openEditorFile,
  previewWindows,
  onOpenRunResult,
}: ChatWindowProps): ReactNode {
  const session = useChatSessionContext();
  const {
    messages,
    streamingAssistantMessage,
    draft,
    loading,
    sending,
    sendStatus,
    regeneratingMessageId,
    error,
    noEligibleModels,
    sendMessage,
    regenerateMessage,
    cancelSend,
    cancelGrounded,
    activeProject,
    activeChat,
    replaceChat,
    latestMemory,
    lastSentDocuments,
    acceptMemoryCandidate,
    rejectMemoryCandidate,
    forgetMemoryAction,
  } = session;
  const activeProjectRoot = activeProject?.path;
  const activeChatRoot = activeChat?.projectPath;
  const codeApplyWorkspaceRoot = codeApplyWorkspaceRootFor(activeChatRoot, activeProjectRoot);
  const queueAssistantCodeBlockApply = useCallback<AssistantCodeBlockApply>(
    async ({ codeBlockText, language }) => {
      if (codeApplyWorkspaceRoot === undefined) {
        return { kind: "rejected" };
      }
      const [{ queueChatEditorApply }, { queueLocalEditorAgentAction }] = await Promise.all([
        import("@/lib/chat-editor-apply"),
        import("./widgets/cards/editorAgentBridge"),
      ]);
      const outcome = await queueChatEditorApply(
        {
          codeBlockText,
          language,
          context: { workspaceRoot: codeApplyWorkspaceRoot },
        },
        { queueAction: queueLocalEditorAgentAction },
      );
      return assistantCodeBlockApplyOutcome(outcome);
    },
    [codeApplyWorkspaceRoot],
  );
  const onApplyCodeBlock =
    codeApplyWorkspaceRoot === undefined ? undefined : queueAssistantCodeBlockApply;
  const ready = isComposerReadyToSend(draft, sending, loading, noEligibleModels);
  const visible = useMemo(() => visibleOnly(messages), [messages]);
  const hasLiveStreamingAssistant = hasLiveStreamingAssistantContent(streamingAssistantMessage);
  const scrollRef = useRef<HTMLDivElement>(null);
  const repositoryRoots = useMemo(() => {
    return repositoryReferenceRoots(
      repositoryReferenceRootPaths({
        chat: activeChat,
        activeProjectPath: activeProject?.path,
        linkedRoot,
        linkedRoots,
      }),
    );
  }, [activeChat, activeProject?.path, linkedRoot, linkedRoots]);
  const openRepositoryReference: OpenRepositoryReference | undefined = openEditorFile;
  // uiux-fix F009 C090 — stick-to-bottom autoscroll: follow new messages AND
  // streaming content growth (lastContent dependency), but only while the
  // reader is near the bottom; never yank someone who scrolled up into the
  // history. Starting an own send (sending false→true) always jumps down.
  const stickRef = useRef(true);
  const prevSendingRef = useRef(false);
  const lastVisible = lastVisibleChatMessage(
    hasLiveStreamingAssistant,
    streamingAssistantMessage,
    visible,
  );
  const lastContent = lastVisible === undefined ? "" : lastVisible.content;
  const effectiveMinimal = minimalChat;
  const { effectiveCompact, effectiveControlsNarrow, effectiveBarCompact } =
    composerFooterEffectiveFlags(
      compact,
      mini,
      minimalChat,
      controlsNarrow,
      workflowCompact,
      barCompact,
    );
  const memoryDisclosure = useMemoryDisclosureState(latestMemory);
  // GEN-PERF-CHAT-014 — a JSX literal in the header prop would hand ChatScopeHeader a
  // fresh element identity every render and defeat its memo.
  const memoryControl = useMemo(
    () => <MemoryDisclosureButton disclosure={memoryDisclosure} />,
    [memoryDisclosure],
  );
  const questionAnchorsRef = useRef(new Map<string, HTMLDivElement>());
  const [focusedQuestionId, setFocusedQuestionId] = useState<string | null>(null);
  const pendingQuestionScrollRef = useRef<string | null>(null);
  const questionMapItems = useMemo<readonly ConversationQuestionMapItem[]>(() => {
    return visible
      .filter((message) => message.role === "user")
      .map((message, index) => ({
        id: message.id,
        index: index + 1,
        preview: questionMapPreview(message.content),
        time: timeLabel(message.timestamp),
      }));
  }, [visible]);
  const showQuestionMap = questionMapItems.length >= 2;
  const registerQuestionAnchor = useCallback(
    (messageId: string, node: HTMLDivElement | null): void => {
      if (node === null) {
        questionAnchorsRef.current.delete(messageId);
        return;
      }
      questionAnchorsRef.current.set(messageId, node);
    },
    [],
  );
  const scrollToQuestion = useCallback((messageId: string): void => {
    setFocusedQuestionId(messageId);
    const node = questionAnchorsRef.current.get(messageId);
    if (node === undefined) {
      pendingQuestionScrollRef.current = messageId;
      return;
    }
    stickRef.current = false;
    node.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);
  useEffect(() => {
    const pending = pendingQuestionScrollRef.current;
    if (pending === null) return;
    const node = questionAnchorsRef.current.get(pending);
    if (node === undefined) return;
    pendingQuestionScrollRef.current = null;
    stickRef.current = false;
    node.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focusedQuestionId, visible.length]);
  useEffect(() => {
    if (!sending) return;
    pendingQuestionScrollRef.current = null;
    setFocusedQuestionId(null);
  }, [sending]);
  useEffect(() => {
    pendingQuestionScrollRef.current = null;
    setFocusedQuestionId(null);
  }, [activeChat?.id]);
  // GEN-PERF-CHAT-013 — this effect re-runs on every coalesced stream flush
  // (lastContent changes per chunk commit); the old cleanup cancelled and
  // rescheduled a fresh animation frame each time, doubling the per-chunk rAF
  // churn on top of the content-flush rAF. Keep at most ONE pending frame: an
  // already-scheduled frame reads the live refs, so it covers newer chunks too.
  const stickFrameRef = useRef<number | null>(null);
  useEffect(() => {
    if (sending && !prevSendingRef.current) stickRef.current = true;
    prevSendingRef.current = sending;
    if (!stickRef.current) return;
    if (stickFrameRef.current !== null) return;
    stickFrameRef.current = window.requestAnimationFrame(() => {
      stickFrameRef.current = null;
      const el = scrollRef.current;
      if (el !== null && stickRef.current) el.scrollTop = el.scrollHeight;
    });
  }, [visible.length, sending, lastContent]);
  useEffect(
    () => () => {
      if (stickFrameRef.current !== null) window.cancelAnimationFrame(stickFrameRef.current);
    },
    [],
  );

  return (
    <div
      className={`chatw${effectiveCompact ? " chatw-compact" : ""}${effectiveMinimal ? " chatw-minimal" : ""}`}
    >
      <ChatWindowStatusHeader
        activeChat={activeChat}
        replaceChat={replaceChat}
        memoryControl={memoryControl}
        latestMemory={latestMemory}
        acceptMemoryCandidate={acceptMemoryCandidate}
        rejectMemoryCandidate={rejectMemoryCandidate}
        forgetMemoryAction={forgetMemoryAction}
        memoryDisclosure={memoryDisclosure}
        noEligibleModels={noEligibleModels}
        loading={loading}
      />
      {/* uiux-fix F009 C078 — the log is a scrollable region with (often) no
          focusable children: tabIndex makes it keyboard-scrollable (axe
          scrollable-region-focusable); role="log" keeps the implicit polite
          live-region semantics the previous aria-live="polite" provided.
          C090 — onScroll tracks whether the reader is near the bottom. */}
      <ChatWindowLog
        scrollRef={scrollRef}
        stickRef={stickRef}
        pendingQuestionScrollRef={pendingQuestionScrollRef}
        focusedQuestionId={focusedQuestionId}
        setFocusedQuestionId={setFocusedQuestionId}
        visible={visible}
        hasLiveStreamingAssistant={hasLiveStreamingAssistant}
        activeChat={activeChat}
        effectiveMinimal={effectiveMinimal}
        showQuestionMap={showQuestionMap}
        questionMapItems={questionMapItems}
        scrollToQuestion={scrollToQuestion}
        streamingAssistantMessage={streamingAssistantMessage}
        onOpenRunResult={onOpenRunResult}
        repositoryRoots={repositoryRoots}
        openRepositoryReference={openRepositoryReference}
        onApplyCodeBlock={onApplyCodeBlock}
        previewWindows={previewWindows}
        windowId={windowId}
        sending={sending}
        sendStatus={sendStatus}
        regeneratingMessageId={regeneratingMessageId}
        cancelGrounded={cancelGrounded}
        regenerateMessage={regenerateMessage}
        cancelSend={cancelSend}
        registerQuestionAnchor={registerQuestionAnchor}
        lastSentDocuments={lastSentDocuments}
      />

      {/* Issue #1560 — ONE composer render site across the empty→populated transition. The composer was
          previously rendered in two separate conditional slots (one for visible.length === 0, one for
          > 0). Because those are distinct positions in the child list, React unmounted the empty-state
          ComposerCore and mounted a fresh one the instant the first message landed — resetting its local
          voice-dialogue state (voiceDialog.active / persona, and the freshly-undefined useVoiceCapability
          probe), which silently kicked the user out of an active spoken dialogue right after their first
          committed turn. Rendering a single ComposerCore at one stable position preserves the instance —
          and its live dialogue session — across the empty→populated transition. The condition is the
          exact union of the two prior slots (a chat is open, or messages exist), and the placeholder
          keeps the empty+loading "Connecting…" wording, so the rendered surface is unchanged. */}
      <ChatWindowComposerFooter
        visible={visible}
        activeChat={activeChat}
        effectiveCompact={effectiveCompact}
        effectiveMinimal={effectiveMinimal}
        effectiveControlsNarrow={effectiveControlsNarrow}
        effectiveBarCompact={effectiveBarCompact}
        ready={ready}
        loading={loading}
        sendMessage={sendMessage}
        error={error}
        clearError={session.clearError}
      />
    </div>
  );
}
