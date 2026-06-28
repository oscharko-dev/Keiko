"use client";

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
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  type SyntheticEvent,
  type WheelEvent,
} from "react";
import type { VoiceSessionGroundingContext } from "@oscharko-dev/keiko-contracts";
import { useChatSessionContext } from "./context/ChatSessionContext";
import { BudgetIndicator, BUDGET_EXCEEDED_ALERT_ID } from "./ContextBudget";
import { ErrorNoticeFromError } from "./ErrorNotice";
import { GroundedAnswer } from "./GroundedAnswer";
import { ContextStatusPanel } from "./ContextStatusPanel";
import { Icons } from "./Icons";
import KeikoSelect from "./KeikoSelect";
import { NumberControlStepper } from "./NumberControlStepper";
import { SafeMarkdownBoundary } from "./SafeMarkdown";
import {
  repositoryReferenceRoots,
  sanitizeRepositoryEvidenceText,
  type OpenRepositoryReference,
  type RepositoryReferenceRoot,
} from "./repositoryReferences";
import {
  AttachButton,
  AttachDropZone,
  AttachmentStrip,
  AttachRejectionAlert,
  SentDocumentsNote,
} from "./AttachmentStrip";
import { isRunSummaryMessage, RunSummaryCard } from "./WorkflowHandoff";
import { Toggle } from "./widgets/shared/Toggle";
import { FileIcon } from "./widgets/shared/projectTree";
import { isBudgetExceeded, type ChatSessionApi, type SendStatus } from "./hooks/useChatSession";
import type { AttachmentRejectionReason } from "./hooks/useChatSession";
import {
  supportsDictation,
  supportsSpeechOutput,
  useVoiceCapability,
} from "./hooks/useVoiceCapability";
import { useDictation, type DictationController } from "./hooks/useDictation";
import { dictationCaptureSupported } from "./hooks/dictation-recorder";
import { VoiceDictationButton, VoiceDictationPreviewFromController } from "./VoiceDictation";
import { useAssistantSpeech } from "./hooks/useAssistantSpeech";
import { VoicePlaybackMuteButton } from "./VoicePlayback";
import { useVoiceDialogMode } from "./hooks/useVoiceDialogMode";
import { useRealtimeVoice } from "./hooks/useRealtimeVoice";
import {
  usePdfCitationPreviewController,
  type PdfCitationPreviewWindowApi,
} from "./hooks/usePdfCitationPreview";
import { registerPdfCitationPreviewMessageTarget } from "./widgets/cards/pdf-citation-preview-session";
import {
  deriveVoiceAuraState,
  deriveVoiceDialogState,
  voiceDialogStateHeadline,
} from "./hooks/voice-dialog-state";
import { VoiceDialogModeSwitch } from "./VoiceDialogMode";
import type { OpenEditorFileRequest, OpenEditorFileResult } from "./hooks/useWorkspace.types";
import { fetchFilesSearch, updateChat } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { formatUserError } from "./format-error";
import {
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
  // Issue #152 — the streaming path inserts an empty assistant bubble before the first token
  // arrives; while it is empty the pending turn is represented by the TypingBubble, so an empty
  // assistant turn is hidden here to avoid a duplicate "Keiko" bubble during the contacting wait.
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

export function copyableMessageText(content: string): string {
  return sanitizeRepositoryEvidenceText(content).replace(CITATION_MARKER_PATTERN, "");
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
// non-secure contexts, announced status (WCAG 4.1.3), width-stable label swap.
function MessageCopyButton({ content }: { readonly content: string }): ReactNode {
  const { t } = useI18n();
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
        className="chat-msg-copy ui-tip"
        aria-label={copied ? t("chat.copy.copied") : t("chat.copy.message")}
        data-tip={copied ? t("chat.copy.copied") : t("chat.copy.message")}
        data-copied={copied ? "true" : "false"}
        data-failed={failed ? "true" : "false"}
        onClick={handleCopy}
      >
        <Icons.copy size={13} aria-hidden="true" />
        <span>{copied ? t("chat.copy.copied") : t("chat.copy.short")}</span>
      </button>
      <span role="status" className="chat-msg-copy-status">
        {status}
      </span>
    </div>
  );
}

function ChatBubbleImpl({
  message,
  onOpenRunResult,
  repositoryRoots,
  openRepositoryReference,
  previewWindows,
  windowId,
  streaming = false,
  layout = "stack",
}: {
  readonly message: ChatMessage;
  readonly onOpenRunResult?: ((message: ChatMessage) => void) | undefined;
  readonly repositoryRoots: readonly RepositoryReferenceRoot[];
  readonly openRepositoryReference: OpenRepositoryReference | undefined;
  readonly previewWindows: PdfCitationPreviewWindowApi | undefined;
  readonly windowId?: string | undefined;
  // Issue #1296 — true only for the live assistant turn while tokens are arriving,
  // so the DS 0.4.0 streaming caret blinks at the growing edge of the text.
  readonly streaming?: boolean;
  readonly layout?: "stack" | "turn";
}): ReactNode {
  const { t } = useI18n();
  const { activeChat } = useChatSessionContext();
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
  const canCollapse = !isUser && !isRunSummary && isCollapsibleAssistantAnswer(message.content);

  useEffect(() => {
    const assistantMessageId = message.groundedAnswer?.assistantMessageId ?? message.id;
    if (
      message.role !== "assistant" ||
      activeChat?.id === undefined ||
      windowId === undefined ||
      bubbleRef.current === null
    ) {
      return;
    }
    return registerPdfCitationPreviewMessageTarget({
      assistantMessageId,
      chatId: activeChat.id,
      chatWindowId: windowId,
      element: bubbleRef.current,
    });
  }, [activeChat?.id, message.groundedAnswer?.assistantMessageId, message.id, message.role, windowId]);

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
        <div
          id={isUser ? undefined : contentId}
          className="chat-msg-content"
          data-collapsed={!isUser && collapsed ? "true" : "false"}
          data-collapsible={canCollapse ? "true" : "false"}
        >
          {isUser ? (
            message.content
          ) : (
            // AC #1 / #2: assistant responses render as safe markdown.
            // User messages remain plain text — no markdown interpretation.
            // SM-1: wrapped in a per-message boundary so a parser/render defect
            // degrades this one bubble to plain text instead of crashing the view.
            <SafeMarkdownBoundary
              source={message.content}
              repositoryRoots={repositoryRoots}
              openRepositoryReference={openRepositoryReference}
              citationPreview={citationPreview}
            />
          )}
          {/* Issue #1296 — DS 0.4.0 streaming caret at the live edge of the growing
              assistant turn. Decorative (the lifecycle status announces "Receiving
              response…" politely), so it is hidden from assistive tech. */}
          {streaming && !isUser ? <span className="ai-stream-cursor" aria-hidden="true" /> : null}
        </div>
        {/* uiux-fix F041 (C176) — full date+time stays reachable via title.
            uiux-fix F042 (C208) — footer row: timestamp left, assistant-only actions right. */}
        <div className="chat-msg-foot">
          <div className="chat-msg-time" title={new Date(message.timestamp).toLocaleString()}>
            {timeLabel(message.timestamp)}
          </div>
          {isUser ? null : (
            <div className="chat-msg-actions">
              <MessageCopyButton content={message.content} />
              {canCollapse ? (
                <button
                  type="button"
                  className="chat-msg-collapse"
                  aria-controls={contentId}
                  aria-expanded={!collapsed}
                  onClick={() => {
                    setCollapsed((current) => !current);
                  }}
                >
                  <Icons.chevron size={12} aria-hidden="true" />
                  <span>{collapsed ? t("chat.answer.expand") : t("chat.answer.collapse")}</span>
                </button>
              ) : null}
            </div>
          )}
        </div>
        {!isUser && message.groundedAnswer !== undefined ? (
          <div className="chatw-grounded chatw-grounded-inline">
            <GroundedAnswer
              answer={message.groundedAnswer}
              busy={false}
              repositoryRoots={repositoryRoots}
              openRepositoryReference={openRepositoryReference}
              citationPreview={citationPreview}
            />
            <ContextStatusPanel contextSummary={contextSummaryOf(message.groundedAnswer)} />
          </div>
        ) : null}
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
  const { t } = useI18n();
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
  const { t } = useI18n();
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
  readonly onOpenRunResult?: ((message: ChatMessage) => void) | undefined;
  readonly repositoryRoots: readonly RepositoryReferenceRoot[];
  readonly openRepositoryReference: OpenRepositoryReference | undefined;
  readonly previewWindows: PdfCitationPreviewWindowApi | undefined;
  readonly windowId?: string | undefined;
  readonly sending: boolean;
  readonly sendStatus: SendStatus;
  readonly activeChat: Chat | undefined;
  readonly onCancelGrounded: () => void;
}

function ConversationThreadImpl({
  messages,
  onOpenRunResult,
  repositoryRoots,
  openRepositoryReference,
  previewWindows,
  windowId,
  sending,
  sendStatus,
  activeChat,
  onCancelGrounded,
}: ConversationThreadProps): ReactNode {
  const { t } = useI18n();
  const turns = useMemo(() => conversationTurns(messages), [messages]);
  return (
    <div className="chatw-thread">
      {turns.map((turn) => (
        <div className="chat-turn" key={turn.id}>
          <div className="chat-turn-cell chat-turn-prompt">
            {turn.user !== null ? (
              <ChatBubble
                message={turn.user}
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
                previewWindows={previewWindows}
                windowId={windowId}
                layout="turn"
                streaming={
                  sendStatus === "streaming" &&
                  response.role === "assistant" &&
                  turn === turns[turns.length - 1] &&
                  index === turn.responses.length - 1
                }
              />
            ))}
          </div>
        </div>
      ))}
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

function normalizedRepositoryRoot(root: string): string {
  return root.replace(/\\/gu, "/").replace(/\/+$/u, "");
}

function repositoryRootContains(parentRoot: string, childRoot: string): boolean {
  const parent = normalizedRepositoryRoot(parentRoot);
  const child = normalizedRepositoryRoot(childRoot);
  return parent.length > 0 && child.length > parent.length && child.startsWith(`${parent}/`);
}

function omitAncestorRepositoryRoots(roots: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const root of roots) {
    const trimmed = root.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique.filter(
    (root) =>
      !unique.some((candidate) => candidate !== root && repositoryRootContains(root, candidate)),
  );
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

function normalizedRepositoryPath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
}

function appendRepositoryReference(draft: string, path: string): string {
  const mention = `@${path}`;
  if (draft.split(/\s+/u).includes(mention)) return draft;
  const trimmed = draft.trimEnd();
  return trimmed.length === 0 ? mention : `${trimmed} ${mention}`;
}

function repositoryReferenceId(root: string, path: string): string {
  return `${root}\u0001${path}`;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function repositoryReferenceMentionPattern(path: string): RegExp {
  return new RegExp(`(^|\\s)@${escapeRegExp(path)}(?=$|\\s)`, "gu");
}

function removeRepositoryReferenceFromDraft(draft: string, path: string): string {
  const next = draft
    .replace(repositoryReferenceMentionPattern(path), "$1")
    .replace(/[ \t]{2,}/gu, " ");
  return next.trim().length === 0 ? "" : next;
}

const COMPOSER_REPOSITORY_REFERENCE_PATTERN =
  /(^|\s)@((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9]{0,15})(?=$|\s)/gu;

function repositoryReferenceMentionPaths(draft: string): readonly string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  COMPOSER_REPOSITORY_REFERENCE_PATTERN.lastIndex = 0;
  for (;;) {
    const match = COMPOSER_REPOSITORY_REFERENCE_PATTERN.exec(draft);
    if (match === null) break;
    const path = normalizedRepositoryPath(match[2] ?? "");
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
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
    throw new Error("Select a repository file first.");
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
        throw new Error(
          `This Files source already references ${String(MAX_REPOSITORY_FOCUS_PATHS)} files.`,
        );
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

function resultDirectoryLabel(result: FilesSearchResult): string {
  return result.directory.length === 0 ? "Repository root" : result.directory;
}

function fileRoleLabel(role: FilesSearchResult["fileRole"] | undefined): string {
  switch (role) {
    case "source":
      return "Source";
    case "test":
      return "Test";
    case "config":
      return "Config";
    case "docs":
      return "Docs";
    case "generated":
      return "Generated";
    case "asset":
      return "Asset";
    case "other":
    case undefined:
      return "File";
  }
}

function fileRoleClassName(role: FilesSearchResult["fileRole"] | undefined): string {
  return `repo-focus-badge repo-focus-badge-${role ?? "other"}`;
}

function fileSearchResultClassName(result: FilesSearchResult): string {
  const secondary = result.fileRole === "generated" || result.fileRole === "asset";
  return `repo-focus-result${secondary ? " repo-focus-result-secondary" : ""}`;
}

function matchQualityLabel(quality: FilesSearchResult["matchQuality"] | undefined): string {
  switch (quality) {
    case "exact":
      return "Exact match";
    case "strong":
      return "Strong match";
    case "path":
      return "Path match";
    case "weak":
    case undefined:
      return "Weak match";
  }
}

function formatRepositoryFocusError(error: unknown): string {
  return formatUserError(error, "Unable to reference repository file.");
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
  const [results, setResults] = useState<readonly FilesSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState("Type after @ to search connected repository files.");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSearching(false);
      setResults([]);
      setError(null);
      return undefined;
    }
    const trimmed = query.trim();
    if (selectedRoot.length === 0 || trimmed.length === 0) {
      setSearching(false);
      setResults([]);
      setMessage("Type after @ to search connected repository files.");
      setError(null);
      return undefined;
    }

    const controller = new AbortController();
    let cancelled = false;
    setSearching(true);
    setError(null);
    setMessage("Searching repository files...");
    const searchTimer = window.setTimeout(() => {
      void fetchFilesSearch(selectedRoot, trimmed, REPOSITORY_FILE_SEARCH_LIMIT, {
        signal: controller.signal,
      })
        .then((response) => {
          if (cancelled) return;
          setResults(response.results);
          if (response.results.length === 0) {
            setMessage("No matching repository files.");
          } else {
            const count = response.results.length;
            setMessage(
              `${String(count)} ${count === 1 ? "file" : "files"} found${response.truncated ? "; refine query; search scanned limit reached." : "."}`,
            );
          }
        })
        .catch((caught: unknown) => {
          if (cancelled || isAbortError(caught)) return;
          setResults([]);
          setError(formatRepositoryFocusError(caught));
          setMessage("Repository search failed.");
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
  }, [open, query, selectedRoot]);

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
  const activeRoot = roots.find((root) => root.root === selectedRoot) ?? roots[0];
  const displayedError = pickError ?? search.error;
  const stopPickerPointer = (event: SyntheticEvent): void => {
    event.stopPropagation();
  };
  const pickFromPointer = (event: PointerEvent<HTMLButtonElement>, result: FilesSearchResult) => {
    if (event.button !== 0 || pickingPath !== null) return;
    event.preventDefault();
    event.stopPropagation();
    onPick(result);
  };
  return (
    // The dialog must be a pointer boundary inside draggable workspace windows.
    // Actual selection controls remain semantic buttons below.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="repo-focus-popover"
      role="dialog"
      aria-label="Reference repository file"
      onPointerDown={stopPickerPointer}
      onMouseDown={stopPickerPointer}
    >
      <div className="repo-focus-head">
        <div>
          <span className="repo-focus-title">Repository file</span>
          <span className="repo-focus-subtitle">{activeRoot?.label ?? "Connected source"}</span>
        </div>
        <button
          type="button"
          className="repo-focus-close"
          aria-label="Close repository file picker"
          onClick={onClose}
        >
          <Icons.close size={13} />
        </button>
      </div>
      {roots.length > 1 ? (
        <KeikoSelect
          triggerClassName="repo-focus-source-select"
          value={selectedRoot}
          ariaLabel="Repository source"
          menuTitle="Connected repositories"
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
        {displayedError ?? (search.searching ? "Searching repository files..." : search.message)}
      </div>
      {search.results.length > 0 ? (
        <div className="repo-focus-results" role="listbox" aria-label="Repository file results">
          {search.results.map((result, index) => (
            <button
              key={`${result.root}:${result.path}`}
              type="button"
              className={fileSearchResultClassName(result)}
              role="option"
              aria-selected={index === highlightedIndex ? "true" : "false"}
              data-highlighted={index === highlightedIndex ? "true" : "false"}
              aria-label={`Reference ${result.path}`}
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
                    {fileRoleLabel(result.fileRole)}
                  </span>
                  {result.rootKind === "nested-git-root" ? (
                    <span className="repo-focus-badge repo-focus-badge-root">Nested repo</span>
                  ) : null}
                </span>
              </span>
              <span className="repo-focus-result-path">{resultDirectoryLabel(result)}</span>
              <span className="sr-only">
                {`${fileRoleLabel(result.fileRole)}; ${matchQualityLabel(result.matchQuality)}${result.rootKind === "nested-git-root" ? "; nested repository root" : ""}.`}
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
  if (references.length === 0) return null;
  return (
    <div className="repo-token-strip" role="list" aria-label="Referenced repository files">
      {references.map((reference) => (
        <div
          key={reference.id}
          className={`repo-token${reference.verified ? "" : " repo-token-unverified"}`}
          role="listitem"
          title={
            reference.verified
              ? `${reference.path} — ${reference.root}`
              : `Reference not verified yet — ${reference.path} — ${reference.root}`
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
            <span className="repo-token-status" aria-label="Reference not verified yet">
              Unverified
            </span>
          )}
          <button
            type="button"
            className="repo-token-remove"
            aria-label={`Remove repository reference ${reference.path}`}
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
  // Issue #151 — when true, the budget for the next send exceeds the model's
  // window and the send button must be focusable but inert.
  readonly budgetExceeded: boolean;
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

function ComposerBar({
  session,
  ready,
  selectedModelCapability,
  onAttachFiles,
  controlsNarrow = false,
  barCompact = false,
  budgetExceeded,
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
  const { t } = useI18n();
  const {
    models,
    selectedModel,
    setSelectedModel,
    draft,
    noEligibleModels,
    loading,
    sending,
    cancelSend,
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

  const selectValue = loading || noEligibleModels ? "" : (selectedModel ?? "");
  const compactModelTip = loading
    ? t("chat.model.loading")
    : noEligibleModels
      ? t("chat.model.noEligible")
      : t("chat.model.change");

  return (
    <div className={`cmp-bar${barCompact ? " cmp-bar-compact" : ""}`}>
      <div className="cmp-bar-main">
        {/* Issue #147: real AttachButton replaces the placeholder "Attach (coming soon)" button.
            uiux-fix F040 C207 — tell the button whether ANY configured model can attach, so its
            sr-only hint does not suggest a model switch that cannot succeed. */}
        <AttachButton
          model={selectedModelCapability}
          onFiles={onAttachFiles}
          anyModelSupportsAttachments={models.some(
            (m) => m.supportsImageInput || m.supportsDocumentInput,
          )}
        />
        {/* AC #3: loading state — show a "Loading models…" option while bootstrapping */}
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
        {/* Issue #495 — capability-gated dictation. Rendered only when the deployment advertises
            speech-to-text and the browser can capture audio; a no-voice deployment shows no mic at
            all so the composer stays clean and fully text-capable (AC1). The button is STT dictation
            only and never implies full voice conversation (AC5). */}
        {voiceDictationVisible ? (
          <VoiceDictationButton
            phase={dictation.phase}
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
      </div>
      {/* AC #2: visually-hidden hint for screen readers when send is blocked by empty draft */}
      {sendDescribedBy === SEND_HINT_ID ? (
        <span id={SEND_HINT_ID} className="sr-only">
          {t("chat.send.hint")}
        </span>
      ) : null}
      {/* Issue #152 — while a send is in flight the primary action button
          flips to "Cancel response" (AC#1 + AC#3). Type="button" so it never
          submits the surrounding form; onClick calls cancelSend which is a
          safe no-op when the status is already terminal. */}
      {sending ? (
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
      ) : (
        <button
          type={sendBlocked ? "button" : "submit"}
          className="cmp-send cmp-tip-end"
          data-on={!sendBlocked}
          data-tip={
            noEligibleModels
              ? t("chat.send.noModel")
              : budgetExceeded
                ? t("chat.send.contextTooLarge")
                : loading
                  ? t("chat.send.connecting")
                  : t("chat.send.label")
          }
          aria-disabled={sendBlocked}
          aria-describedby={sendDescribedBy}
          aria-label={t("chat.send.label")}
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
  const { t } = useI18n();
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
  const { t } = useI18n();
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
  const { t } = useI18n();
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
  readonly session: ChatSessionApi;
  readonly ready: boolean;
  readonly placeholder: string;
  readonly minimal?: boolean;
  readonly compact?: boolean;
  readonly controlsNarrow?: boolean;
  readonly barCompact?: boolean;
}

function ComposerCore({
  session,
  ready,
  placeholder,
  minimal = false,
  compact = false,
  controlsNarrow = false,
  barCompact = false,
}: ComposerCoreProps): ReactNode {
  const { t } = useI18n();
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
    error,
    clearHistory,
    messages,
    activeChat,
    activeProject,
    replaceChat,
  } = session;
  // Issue #151 — budget can be undefined while bootstrapping; treat that as
  // not-exceeded so the composer remains submittable. CB-F1: a runtime-configured
  // model with contextWindow 0 reports pressure "exceeded" from the estimator but
  // has no real window — it must NOT block send (and BudgetIndicator self-hides),
  // so we gate on contextWindowTokens > 0 via the shared predicate. This also keeps
  // aria-describedby from dangling at a BudgetIndicator that renders nothing.
  const budgetExceeded = isBudgetExceeded(budget);

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

  // Issue #495 — capability-gated composer dictation. The probe is non-blocking: the composer
  // renders fully while `useVoiceCapability` resolves, and the mic affordance appears only once the
  // deployment advertises speech-to-text AND the browser can capture audio. A no-voice / unsupported
  // environment shows no voice control at all, so the composer stays clean and fully text-capable.
  const voiceCapability = useVoiceCapability();
  const voiceDictationVisible = supportsDictation(voiceCapability) && dictationCaptureSupported();
  // Issue #501 — assistant speech-output gate: reuse the already-fetched voiceCapability probe (no
  // second fetch). Only true when the deployment advertises speech output; STT-only and no-voice
  // deployments leave it false, so no playback control appears and Keiko answers in text (AC1).
  const voiceSpeechOutputVisible = supportsSpeechOutput(voiceCapability);
  const micButtonRef = useRef<HTMLButtonElement>(null);
  const playbackButtonRef = useRef<HTMLButtonElement>(null);
  const voiceDialogButtonRef = useRef<HTMLButtonElement>(null);
  const motionMicButtonRef = useRef<HTMLButtonElement>(null);
  const motionPlaybackButtonRef = useRef<HTMLButtonElement>(null);
  const motionVoiceDialogButtonRef = useRef<HTMLButtonElement>(null);
  // Insert appends the reviewed transcript into the existing draft (separated by a space) and returns
  // focus to the composer so the keyboard-first text workflow is preserved; it never auto-sends.
  const insertTranscript = useCallback(
    (text: string): void => {
      setDraft(draft.trim().length === 0 ? text : `${draft.replace(/\s+$/u, "")} ${text}`);
      taRef.current?.focus();
    },
    [draft, setDraft],
  );
  const dictation = useDictation({ onInsert: insertTranscript });
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
  const realtimeVoice = useRealtimeVoice({
    persona: voiceDialog.persona,
    chatContext:
      activeChat === undefined
        ? undefined
        : {
            chatId: activeChat.id,
            memory: {
              enabled: session.memoryEnabled,
              budgetTokens: session.memoryBudgetTokens,
            },
            ...(voiceGrounding === undefined ? {} : { grounding: voiceGrounding }),
          },
    groundingActive: voiceGrounding?.enabled === true,
    onGroundedToolCall: session.runRealtimeGroundedTool,
    onUserTranscriptCommitted: (text) =>
      session.appendVoiceTurn?.([{ role: "user", content: text }]),
    onAssistantTranscriptCommitted: (text) =>
      session.appendVoiceTurn?.([{ role: "assistant", content: text }]),
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
    budgetExceeded,
    hasSessionError: error !== undefined || realtimeVoice.error !== undefined,
  });
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
  // Toggling the mode swaps the composer footer between ComposerBar and the voice-control
  // cluster, so the clicked switch unmounts and focus would fall to <body>. Flag the user
  // toggle so the post-swap effect can return focus to the freshly mounted switch (WCAG
  // 2.4.3). Programmatic auto-leave (capability lost) goes through leaveVoiceDialog directly
  // and never sets the flag, so it never steals focus from wherever the user is.
  const restoreVoiceDialogFocusRef = useRef(false);
  const toggleVoiceDialog = useCallback(() => {
    restoreVoiceDialogFocusRef.current = true;
    if (voiceDialog.active) {
      leaveVoiceDialog();
    } else {
      enterVoiceDialog();
    }
  }, [voiceDialog.active, enterVoiceDialog, leaveVoiceDialog]);
  useEffect(() => {
    if (voiceDialog.active && !voiceDialogAvailable) {
      leaveVoiceDialog();
    }
  }, [leaveVoiceDialog, voiceDialog.active, voiceDialogAvailable]);
  useEffect(() => {
    if (!voiceDialog.active && realtimeVoice.phase !== "idle") {
      realtimeVoice.stop();
    }
  }, [voiceDialog.active, realtimeVoice]);
  const voiceMuted = voiceDialog.active ? realtimeVoice.muted : playback.snapshot.muted;
  const toggleVoiceMute = voiceDialog.active ? realtimeVoice.toggleMute : playback.toggleMute;
  const [voiceComposerMotion, setVoiceComposerMotion] = useState<"idle" | "entering" | "leaving">(
    "idle",
  );
  const previousVoiceDialogActiveRef = useRef(voiceDialog.active);
  const voiceComposerMotionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (previousVoiceDialogActiveRef.current === voiceDialog.active) {
      return undefined;
    }
    previousVoiceDialogActiveRef.current = voiceDialog.active;
    // The swap remounted the dialogue switch under a new parent; return focus to it so a
    // keyboard user is not dropped onto <body>. Runs only for a user-driven toggle.
    if (restoreVoiceDialogFocusRef.current) {
      restoreVoiceDialogFocusRef.current = false;
      voiceDialogButtonRef.current?.focus();
    }
    if (voiceComposerMotionTimerRef.current !== undefined) {
      clearTimeout(voiceComposerMotionTimerRef.current);
    }
    setVoiceComposerMotion(voiceDialog.active ? "entering" : "leaving");
    voiceComposerMotionTimerRef.current = setTimeout(() => {
      voiceComposerMotionTimerRef.current = undefined;
      setVoiceComposerMotion("idle");
    }, 460);
    return undefined;
  }, [voiceDialog.active]);
  useEffect(() => {
    return () => {
      if (voiceComposerMotionTimerRef.current !== undefined) {
        clearTimeout(voiceComposerMotionTimerRef.current);
      }
    };
  }, []);

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
        const next =
          mention === null
            ? (() => {
                const value = appendRepositoryReference(draft, result.path);
                return { value, cursor: value.length };
              })()
            : replaceRepositoryMention(draft, mention, result.path);
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
        setRepositoryPickError(formatRepositoryFocusError(caught));
      } finally {
        setRepositoryPickingPath(null);
      }
    },
    [activeChat, draft, replaceChat, repositoryMention, setDraft],
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
        if (event.key === "Escape") {
          event.preventDefault();
          setRepositoryMention(null);
          return;
        }
        if (event.key === "ArrowDown" && repositorySearch.results.length > 0) {
          event.preventDefault();
          setRepositoryHighlightedIndex((current) =>
            Math.min(repositorySearch.results.length - 1, current + 1),
          );
          return;
        }
        if (event.key === "ArrowUp" && repositorySearch.results.length > 0) {
          event.preventDefault();
          setRepositoryHighlightedIndex((current) => Math.max(0, current - 1));
          return;
        }
        if ((event.key === "Enter" || event.key === "Tab") && repositorySearch.results.length > 0) {
          event.preventDefault();
          const picked =
            repositorySearch.results[repositoryHighlightedIndex] ?? repositorySearch.results[0];
          if (picked !== undefined) void insertRepositoryFileReference(picked);
          return;
        }
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

  const composerBoxClassName = [
    "cmp-box",
    compact ? "cmp-box-compact" : "",
    voiceDialog.active ? "cmp-box-voice-dialog" : "",
    voiceComposerMotion === "entering" ? "cmp-box-voice-dialog-entering" : "",
    voiceComposerMotion === "leaving" ? "cmp-box-voice-dialog-leaving" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={composerBoxClassName}
      data-voice-aura={voiceAura.active ? "on" : undefined}
      data-voice-aura-state={voiceAura.active ? voiceAura.state : undefined}
      data-voice-aura-intensity={voiceAura.active ? voiceAura.intensity : undefined}
    >
      <div
        className={`cmp-input-stack${voiceDialog.active ? " cmp-input-stack-voice-dialog" : ""}`}
      >
        {/* Drop zone above the textarea (Part 2 — shown when attachment is supported) */}
        {voiceDialog.active ? null : (
          <AttachDropZone enabled={attachEnabled} onFiles={handleFiles} />
        )}
        <textarea
          className="cmp-input"
          ref={taRef}
          rows={2}
          value={draft}
          aria-label={t("chat.messageLabel")}
          placeholder={placeholder}
          onChange={handleDraftChange}
          onSelect={handleDraftSelect}
          onKeyDown={handleDraftKeyDown}
          // uiux-fix F041 (C205, supersedes F009 C077 readOnly) — the textarea stays
          // fully editable while a send is in flight so the next message can be
          // pre-typed during streaming. Re-submit stays blocked by the isInFlight
          // guard in useChatSession, and the primary button is "Cancel" meanwhile.
        />
        {!voiceDialog.active && repositoryPickerOpen ? (
          <div className="repo-focus repo-focus-inline">
            <span className="sr-only" role="status" aria-live="polite">
              {repositoryPickError ?? repositorySearch.error ?? repositorySearch.message}
            </span>
            <RepositoryFilePickerPanel
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
          </div>
        ) : null}
        {voiceDialog.active ? null : (
          <RepositoryReferenceStrip
            references={repositoryReferences}
            onRemove={removeRepositoryReference}
          />
        )}
        {/* Chip strip below the textarea, above the composer bar (AC #3) */}
        {voiceDialog.active ? null : (
          <AttachmentStrip attachments={pendingAttachments} onRemove={removePendingAttachment} />
        )}
        {/* Inline rejection alert — role="alert" announces immediately (AC #2) */}
        {voiceDialog.active ? null : (
          <AttachRejectionAlert reason={rejectionReason} mimeType={rejectionMime} />
        )}
        {/* Issue #152 / AC#1 + AC#4 — lifecycle status announcement. Renders
            adjacent to the textarea so SR users hear the state without losing
            composer focus. Hidden when there is nothing to announce. */}
        {voiceDialog.active ? null : <SendLifecycleStatus status={sendStatus} />}
        {voiceAura.active ? (
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {voiceDialogStateHeadline(voiceDialogState)}
          </span>
        ) : null}
        {/* Issue #495 — dictation transcript review / transcribing status / error. Lives in the input
            stack so it is contextually adjacent to the textarea and announced to assistive tech. It
            renders nothing while idle or recording (the mic button carries those states). */}
        {!voiceDialog.active && voiceDictationVisible ? (
          <VoiceDictationPreviewFromController
            controller={dictation}
            onAfterDiscard={() => micButtonRef.current?.focus()}
          />
        ) : null}
      </div>
      <div
        className={`cmp-footer-row${voiceComposerMotion !== "idle" ? " cmp-footer-row-motion" : ""}`}
      >
        {voiceDialog.active && voiceComposerMotion === "entering" ? (
          <div
            className="cmp-composer-motion-layer cmp-composer-motion-layer-normal"
            aria-hidden="true"
            inert
          >
            {minimal ? null : (
              <BudgetIndicator
                budget={budget}
                onClearHistory={clearHistory}
                disabled={sending || loading}
                compact={compact}
              />
            )}
            <ComposerBar
              session={session}
              ready={ready}
              selectedModelCapability={selectedModelCapability}
              onAttachFiles={handleFiles}
              controlsNarrow={controlsNarrow}
              barCompact={barCompact}
              budgetExceeded={budgetExceeded}
              voiceDictationVisible={voiceDictationVisible}
              dictation={dictation}
              micButtonRef={motionMicButtonRef}
              voiceSpeechOutputVisible={voiceSpeechOutputVisible}
              voiceMuted={playback.snapshot.muted}
              onToggleVoiceMute={playback.toggleMute}
              playbackButtonRef={motionPlaybackButtonRef}
              voiceDialogAvailable={voiceDialogAvailable}
              voiceDialogActive={false}
              onToggleVoiceDialog={toggleVoiceDialog}
              voiceDialogButtonRef={motionVoiceDialogButtonRef}
            />
          </div>
        ) : null}
        {/* Issue #151 — context-pressure indicator + clear-history affordance */}
        {minimal || voiceDialog.active ? null : (
          <BudgetIndicator
            budget={budget}
            onClearHistory={clearHistory}
            disabled={sending || loading}
            compact={compact}
          />
        )}
        {voiceDialog.active ? (
          <VoiceDialogComposerControls
            voiceMuted={voiceMuted}
            onToggleVoiceMute={toggleVoiceMute}
            playbackButtonRef={playbackButtonRef}
            voiceDialogActive={voiceDialog.active}
            onToggleVoiceDialog={toggleVoiceDialog}
            voiceDialogButtonRef={voiceDialogButtonRef}
            compact={controlsNarrow}
          />
        ) : (
          <ComposerBar
            session={session}
            ready={ready}
            selectedModelCapability={selectedModelCapability}
            onAttachFiles={handleFiles}
            controlsNarrow={controlsNarrow}
            barCompact={barCompact}
            budgetExceeded={budgetExceeded}
            voiceDictationVisible={voiceDictationVisible}
            dictation={dictation}
            micButtonRef={micButtonRef}
            voiceSpeechOutputVisible={voiceSpeechOutputVisible}
            voiceMuted={voiceMuted}
            onToggleVoiceMute={toggleVoiceMute}
            playbackButtonRef={playbackButtonRef}
            voiceDialogAvailable={voiceDialogAvailable}
            voiceDialogActive={voiceDialog.active}
            onToggleVoiceDialog={toggleVoiceDialog}
            voiceDialogButtonRef={voiceDialogButtonRef}
          />
        )}
        {!voiceDialog.active && voiceComposerMotion === "leaving" ? (
          <div
            className="cmp-composer-motion-layer cmp-composer-motion-layer-voice"
            aria-hidden="true"
            inert
          >
            <VoiceDialogComposerControls
              voiceMuted={realtimeVoice.muted}
              onToggleVoiceMute={toggleVoiceMute}
              playbackButtonRef={motionPlaybackButtonRef}
              voiceDialogActive={true}
              onToggleVoiceDialog={toggleVoiceDialog}
              voiceDialogButtonRef={motionVoiceDialogButtonRef}
              compact={controlsNarrow}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Deliverable: polished empty state when no messages are present and an active
// chat exists. Keep the center copy intentionally minimal so the composer
// remains the primary action.
interface EmptyComposerStateProps {
  readonly minimal?: boolean;
}

function EmptyComposerState({ minimal = false }: EmptyComposerStateProps): ReactNode {
  const { t } = useI18n();
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
  const { t } = useI18n();
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

function formatScopeUpdateError(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  // uiux-fix F041 (C171) — message first, machine code as trailing detail.
  return formatUserError(error, t("chat.error.scopeUpdate"));
}

interface ScopeOption {
  readonly value: string;
  readonly label: string;
}

function capsuleOptions(
  chat: Chat,
  capsules: readonly CapsuleListEntry[],
  t: ReturnType<typeof useI18n>["t"],
): readonly ScopeOption[] {
  const options = capsules.map((capsule) => ({
    value: `capsule:${capsule.id}`,
    label: t("chat.grounding.capsule", { name: capsule.displayName }),
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
      // uiux-fix F041 (C173) — "(unavailable)" matches the capsule-set degraded
      // suffix; two different words previously named the same state.
      label: t("chat.grounding.unavailable", {
        label: t("chat.grounding.capsule", { name: capsuleId }),
      }),
    },
  ];
}

function capsuleSetOptions(
  chat: Chat,
  capsuleSets: readonly CapsuleSetListEntry[],
  t: ReturnType<typeof useI18n>["t"],
): readonly ScopeOption[] {
  const options = capsuleSets.map((capsuleSet) => ({
    value: `capsule-set:${capsuleSet.id}`,
    label: t("chat.grounding.capsuleSet", { name: capsuleSet.displayName }),
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
      label: t("chat.grounding.unavailable", {
        label: t("chat.grounding.capsuleSet", { name: capsuleSetId }),
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

function useKnowledgeCatalog(): KnowledgeCatalog {
  const { t } = useI18n();
  const [capsules, setCapsules] = useState<readonly CapsuleListEntry[]>([]);
  const [capsuleSets, setCapsuleSets] = useState<readonly CapsuleSetListEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

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
          setLoadError(formatScopeUpdateError(capsuleSetResult.reason, t));
        }
      } catch (caught) {
        if (!cancelled) setLoadError(formatScopeUpdateError(caught, t));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [t]);

  return { capsules, capsuleSets, loadError };
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
  const { t } = useI18n();
  const { capsules, capsuleSets, loadError } = catalog;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(value: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (value === "none") {
        // #2 — Selecting "Model only" permanently discards ALL active grounding
        // sources (folder scopes + connectors). When sources are present, ask
        // for explicit confirmation. On cancel, revert the <select> without
        // mutating the chat and release the busy lock.
        const sourceCount = activeGroundingSourceCount(chat);
        if (sourceCount > 0) {
          const confirmed = window.confirm(
            t("chat.grounding.disconnectConfirm", {
              count: sourceCount,
              sourceLabel:
                sourceCount === 1
                  ? t("chat.grounding.sourceSingular")
                  : t("chat.grounding.sourcePlural"),
            }),
          );
          if (!confirmed) return;
        }
        const response = await updateChat(chat.id, {
          connectedScopes: null,
          localKnowledgeScopes: null,
        });
        onChatChanged(response.chat);
        return;
      }
      if (value === "files") {
        const response = await updateChat(chat.id, { localKnowledgeScopes: null });
        onChatChanged(response.chat);
        return;
      }
      if (value.startsWith("capsule-set:")) {
        const scope: ChatLocalKnowledgeScope = {
          kind: "capsule-set",
          capsuleSetId: value.slice("capsule-set:".length) as Extract<
            ChatLocalKnowledgeScope,
            { readonly kind: "capsule-set" }
          >["capsuleSetId"],
          connectedAtMs: Date.now(),
        };
        // GRD-009: additive + non-destructive. The server fully supports hybrid grounding
        // (folder scopes + connectors, RRF over both, 16-each cap), so connecting a connector
        // must NOT clear connected folders (no `connectedScopes: null`) or drop already-bound
        // connectors. Append to the existing list (deduped); the BFF enforces the cap.
        const current = currentConnectorScopes(chat);
        const next = current.some(
          (s) => s.kind === "capsule-set" && s.capsuleSetId === scope.capsuleSetId,
        )
          ? current
          : [...current, scope];
        const response = await updateChat(chat.id, { localKnowledgeScopes: next });
        onChatChanged(response.chat);
        return;
      }
      if (value.startsWith("capsule:")) {
        const scope: ChatLocalKnowledgeScope = {
          kind: "capsule",
          capsuleId: value.slice("capsule:".length) as Extract<
            ChatLocalKnowledgeScope,
            { readonly kind: "capsule" }
          >["capsuleId"],
          connectedAtMs: Date.now(),
        };
        // GRD-009: additive + non-destructive (see capsule-set branch above).
        const current = currentConnectorScopes(chat);
        const next = current.some((s) => s.kind === "capsule" && s.capsuleId === scope.capsuleId)
          ? current
          : [...current, scope];
        const response = await updateChat(chat.id, { localKnowledgeScopes: next });
        onChatChanged(response.chat);
      }
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
              })),
              ...capsuleSetChoices.map((capsuleSet) => ({
                value: capsuleSet.value,
                label: capsuleSet.label,
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

function ChatScopeHeader({
  chat,
  onChatChanged,
}: {
  readonly chat: Chat;
  readonly onChatChanged: (chat: Chat) => void;
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
    </div>
  );
}

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

function GroundedAnswerPanel({
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
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [confirmForget, setConfirmForget] = useState(false);
  const runAction = useCallback(
    (actionCallback: () => Promise<void>, successMessage: string, errorMessage: string): void => {
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
            onDismiss={() => setError(undefined)}
          />
        ) : null}
      </article>
    );
  }
  if (action.kind === "update") {
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
  if (action.kind === "forget") {
    const executeForget = (): void => {
      runAction(
        () => forgetMemoryAction(action.memoryId).then(() => setConfirmForget(false)),
        t("chat.memory.forgetCompleted"),
        t("chat.memory.forgetError"),
      );
    };
    return (
      <article className="chat-memory-action">
        <div className="chat-memory-action-head">
          <strong>{t("chat.memory.forgetDetected")}</strong>
          <span>
            {action.requiresConfirmation ? t("chat.memory.confirmationRequired") : action.memoryId}
          </span>
        </div>
        <p>{t("chat.memory.forgetMatched", { id: action.memoryId })}</p>
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
                setError(undefined);
                setConfirmForget(true);
              }}
            >
              {t("chat.memory.reviewForget")}
            </button>
          ) : (
            <>
              <button type="button" aria-disabled={busy} aria-busy={busy} onClick={executeForget}>
                {t("chat.memory.forgetPermanently")}
              </button>
              <button
                type="button"
                aria-disabled={busy}
                aria-busy={busy}
                onClick={() => {
                  if (busy) return;
                  setError(undefined);
                  setConfirmForget(false);
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
            onDismiss={() => setError(undefined)}
          />
        ) : null}
      </article>
    );
  }
  // #28 — explicit case for kind "rejected" (memory proposal declined by the
  // governed capture pipeline). Previously fell through to the default with the
  // misleading title "MemoriaViva action not created".
  if (action.kind === "rejected") {
    return (
      <article className="chat-memory-action">
        <div className="chat-memory-action-head">
          <strong>{t("chat.memory.proposalDeclined")}</strong>
        </div>
        <p>{action.reason !== "" ? action.reason : t("chat.memory.noReason")}</p>
      </article>
    );
  }
  return (
    <article className="chat-memory-action">
      <div className="chat-memory-action-head">
        <strong>{t("chat.memory.actionNotCreated")}</strong>
      </div>
    </article>
  );
}

function formatMemoryCapturedAt(capturedAt: number): string {
  return new Date(capturedAt).toISOString().slice(0, 10);
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
  compact = false,
}: {
  readonly memoryEnabled: boolean;
  readonly setMemoryEnabled: (next: boolean) => void;
  readonly memoryBudgetTokens: number;
  readonly setMemoryBudgetTokens: (next: number) => void;
  readonly latestMemory: ConversationMemoryResultWire | undefined;
  readonly acceptCandidate: (proposalId: string) => Promise<void>;
  readonly rejectCandidate: (proposalId: string) => Promise<void>;
  readonly forgetMemoryAction: (memoryId: string) => Promise<void>;
  readonly compact?: boolean;
}): ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const generatedId = useId();
  const disclosureId = `${generatedId}-chat-memory-disclosure`;
  const budgetInputId = `${generatedId}-chat-memory-budget`;
  const budgetHelpId = `${generatedId}-chat-memory-budget-help`;
  const disclosureButtonRef = useRef<HTMLButtonElement>(null);
  const handleActionSettled = useCallback((message: string): void => {
    setActionStatus(message);
    disclosureButtonRef.current?.focus();
  }, []);
  const memoryCount = latestMemory?.context.memories.length ?? 0;
  const memoryDisclosureLabel =
    memoryCount > 0
      ? t("chat.memory.included", { count: memoryCount })
      : t("chat.memory.noneIncluded");
  const memoryBudgetHelp = t("chat.memory.budgetHelp");
  const stepMemoryBudget = (delta: number): void => {
    setMemoryBudgetTokens(Math.max(0, memoryBudgetTokens + delta));
  };
  const handleBudgetWheel = (event: WheelEvent<HTMLInputElement>): void => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    stepMemoryBudget(direction * 100);
  };
  const budgetControl = (
    <div className="chat-memory-budget">
      <span className="chat-memory-budget-label" data-tip={memoryBudgetHelp}>
        <label htmlFor={budgetInputId}>{t("chat.memory.budget")}</label>
        {/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- matches the existing BudgetIndicator info affordance: keyboard-focusable data-tip tooltip. */}
        <span
          className="cmp-budget-info chat-memory-budget-info"
          role="img"
          tabIndex={0}
          aria-label={memoryBudgetHelp}
        >
          i
        </span>
        {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
      </span>
      <span className="number-control number-control-pill">
        <input
          id={budgetInputId}
          type="number"
          className="number-control-input"
          min={0}
          step={100}
          value={memoryBudgetTokens}
          aria-describedby={budgetHelpId}
          onChange={(event) => setMemoryBudgetTokens(Math.max(0, Number(event.target.value) || 0))}
          onWheel={handleBudgetWheel}
        />
        <NumberControlStepper
          label={t("chat.memory.budgetStepper")}
          onStepUp={() => stepMemoryBudget(100)}
          onStepDown={() => stepMemoryBudget(-100)}
        />
      </span>
      <span id={budgetHelpId} className="sr-only">
        {memoryBudgetHelp}
      </span>
    </div>
  );

  return (
    <section className="chat-memory-panel" aria-label={t("chat.memory.panel")}>
      <div className="chat-memory-panel-head">
        <div className="chat-memory-toggle">
          {/* uiux-fix F042 (C323) — the panel mixed generic "memory" with the
              product name: feature = MemoriaViva, items = memories. The budget
              unit (tokens) was previously only discoverable from the disclosure
              line after the next send. */}
          <Toggle on={memoryEnabled} onChange={setMemoryEnabled} label={t("chat.memory.enable")} />
          <span>{memoryEnabled ? t("chat.memory.stateOn") : t("chat.memory.stateOff")}</span>
        </div>
        {compact ? null : budgetControl}
        <button
          ref={disclosureButtonRef}
          type="button"
          className={`chip${compact ? " chip-icon chat-memory-disclosure-toggle ui-tip cmp-tip-end" : ""}`}
          aria-expanded={open}
          aria-controls={disclosureId}
          aria-label={memoryDisclosureLabel}
          data-tip={compact ? memoryDisclosureLabel : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          {compact ? (
            <Icons.brainSlash size={16} style={{ color: "var(--accent)" }} />
          ) : (
            memoryDisclosureLabel
          )}
        </button>
      </div>
      {open ? (
        <div id={disclosureId} className="chat-memory-disclosure">
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
              onActionSettled={handleActionSettled}
            />
          ))}
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {actionStatus}
          </p>
        </div>
      ) : null}
    </section>
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
  const { t } = useI18n();
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
    activeProject,
    activeChat,
    replaceChat,
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
  const lastVisible = visible.length > 0 ? visible[visible.length - 1] : undefined;
  const lastContent = lastVisible === undefined ? "" : lastVisible.content;
  const effectiveMinimal = minimalChat;
  const effectiveCompact = compact || mini;
  const effectiveControlsNarrow = controlsNarrow || mini || effectiveMinimal || workflowCompact;
  const effectiveBarCompact = barCompact || effectiveMinimal;
  useEffect(() => {
    if (sending && !prevSendingRef.current) stickRef.current = true;
    prevSendingRef.current = sending;
    const el = scrollRef.current;
    if (el !== null && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, sending, lastContent]);

  return (
    <div
      className={`chatw${effectiveCompact ? " chatw-compact" : ""}${effectiveMinimal ? " chatw-minimal" : ""}`}
    >
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
          compact={effectiveCompact || effectiveMinimal}
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
      {/* uiux-fix F009 C078 — the log is a scrollable region with (often) no
          focusable children: tabIndex makes it keyboard-scrollable (axe
          scrollable-region-focusable); role="log" keeps the implicit polite
          live-region semantics the previous aria-live="polite" provided.
          C090 — onScroll tracks whether the reader is near the bottom. */}
      <div
        className="chatw-scroll"
        ref={scrollRef}
        role="log"
        aria-label="Conversation"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable log region must be keyboard-focusable (axe scrollable-region-focusable)
        tabIndex={0}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
        }}
      >
        {visible.length === 0 ? (
          activeChat !== undefined ? (
            <EmptyComposerState minimal={effectiveMinimal} />
          ) : (
            <NoChatState />
          )
        ) : (
          <div className="chatw-log">
            <ConversationThread
              messages={visible}
              onOpenRunResult={onOpenRunResult}
              repositoryRoots={repositoryRoots}
              openRepositoryReference={openRepositoryReference}
              previewWindows={previewWindows}
              windowId={windowId}
              sending={sending}
              sendStatus={sendStatus}
              activeChat={activeChat}
              onCancelGrounded={cancelGrounded}
            />
            <GroundedAnswerPanel chat={activeChat} busy={sending} />
            {/* Issue #148 — disclose which attached documents contributed extracted context. */}
            <SentDocumentsNote documents={lastSentDocuments} />
          </div>
        )}
      </div>

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
              session={session}
              ready={ready}
              placeholder={
                visible.length === 0 && loading
                  ? t("chat.loadingGateway")
                  : t("chat.composer.placeholder")
              }
              minimal={effectiveMinimal}
              compact={effectiveCompact}
              controlsNarrow={effectiveControlsNarrow}
              barCompact={effectiveBarCompact}
            />
            {error !== undefined ? (
              <ErrorNoticeFromError
                error={error}
                fallback={t("chat.error.send")}
                onDismiss={session.clearError}
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
            onDismiss={session.clearError}
          />
        </div>
      ) : null}
    </div>
  );
}
