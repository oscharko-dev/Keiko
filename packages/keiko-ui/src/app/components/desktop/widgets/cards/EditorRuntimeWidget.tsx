"use client";

/**
 * Workspace editor card (Issue #1196).
 *
 * Hosts the standalone `@oscharko-dev/keiko-editor` `KeikoCodeEditor` inside a normal Keiko Workspace
 * card. The host owns every BFF call (load/save), the file/save/conflict lifecycle, and the card
 * chrome (tab, dirty indicator, Save/Reload); the editor package owns rendering, the Monaco runtime,
 * theming, keybindings, and accessibility. The dirty-state and save-state bookkeeping reuses the
 * editor package's pure reducers (`editorFileModelReducer`, `saveStatusReducer`) rather than
 * re-implementing them, and the actual Monaco surface is loaded only in the browser through
 * `next/dynamic(..., { ssr: false })` so `monaco-editor` is never evaluated during the Next
 * static-export prerender.
 *
 * Completion is wired here (Issue #1199): the host builds the `provideCompletions` resolver that
 * posts to the governed `/api/editor/completion` BFF and adapts the content-free wire response into
 * the editor render contract. The editor package owns only Monaco provider registration and
 * rendering; all retrieval, model routing, and the BFF call stay in this host (ADR-0042 D5).
 *
 * Test generation is wired here (Issue #1202) as the v1, switched-off scaffold: the host owns the gated
 * `/api/editor/test-generation` BFF call and surfaces the run status; the editor package owns the pure
 * flow reducer and the diff-review surface. The feature ships OFF (ADR-0042 D7), so the server returns
 * `disabled`/`deferred` and no model-generated code is produced or executed in v1.
 */
import { toExactArrayBuffer } from "@/lib/bytes";
import type { EditorAgentSessionSnapshot } from "@/lib/types";
import type {
  EditorCompletionSource,
  EditorM7WatchEvent,
  EditorM7WorkspaceSnippetSnapshot,
  GitEditorBlameLine,
  GitEditorDiffHunk,
  GitEditorDiffResponse,
  ManagedLspSemanticTokenLegend,
  WorkspaceReplaceApplyFile,
  WorkspaceReplacePreviewTextRange,
} from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  type EditorAgentRootBinding,
} from "@oscharko-dev/keiko-contracts/editor-agent";
import { editorBuiltinDocumentFormatting } from "@oscharko-dev/keiko-contracts/runtime/editor-builtin-capabilities";
import { matchingEditorM7Snippets } from "@oscharko-dev/keiko-contracts/runtime/editor-snippets";
import { GIT_EDITOR_BLAME_MAX_LINES } from "@oscharko-dev/keiko-contracts/runtime/git-editor";
import {
  MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS,
  MANAGED_LSP_SEMANTIC_TOKEN_TYPES,
} from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-capabilities";
import {
  applyTextEditsToText,
  buildRenamePreview,
  configureEditorModelRegistry,
  createEditorRequestId,
  createFileModel,
  DEFAULT_COMPLETION_TRIGGER_CHARACTERS,
  deriveEditorStatusBar,
  deriveLargeFileMode,
  disposeAllUnattachedEditorModels,
  disposeEditorModelRegistryRoot,
  EDITOR_HOT_EXIT_SCHEMA_VERSION,
  editorFileModelReducer,
  EditorStatusBar,
  EMPTY_LANGUAGE_INTELLIGENCE_STATE,
  formattingApplyDecision,
  inferMonacoLanguageId,
  isDocumentDirty,
  isSupportedEditorLanguage,
  languageIntelligenceNotice,
  reduceLanguageIntelligence,
  renameChangesetTruncation,
  saveStatusReducer,
  summarizeLanguageIntelligence,
  type EditorBlameHost,
  type EditorBuffer,
  type EditorCallHierarchyQuery,
  type EditorCallHierarchyResolver,
  type EditorChangeOrigin,
  type EditorCodeActionsQuery,
  type EditorCodeActionsResolver,
  type EditorCompletionItem,
  type EditorCompletionQuery,
  type EditorCompletionResolver,
  type EditorContentDelta,
  type EditorDefinitionQuery,
  type EditorDefinitionResolver,
  type EditorDiagnostic,
  type EditorDiagnosticsQuery,
  type EditorDiagnosticsResolver,
  type EditorDiagnosticsSummary,
  type EditorDocumentIdentity,
  type EditorDocumentSymbol,
  type EditorFileModel,
  type EditorFormattingQuery,
  type EditorFormattingResolver,
  type EditorGitGutterHost,
  type EditorGitGutterPeek,
  type EditorHostEditRequest,
  type EditorHotExitSnapshotV1,
  type EditorHoverQuery,
  type EditorHoverResolver,
  type EditorInlayHintsQuery,
  type EditorInlayHintsResolver,
  type EditorInlineCompletionQuery,
  type EditorInlineCompletionResolver,
  type EditorLanguageId,
  type EditorLanguageIntelligenceEvent,
  type EditorLocation,
  type EditorPosition,
  type EditorRange,
  type EditorReferencesQuery,
  type EditorReferencesResolver,
  type EditorRequestIdentity,
  type EditorSaveRequest,
  type EditorSaveStatus,
  type EditorSignatureHelpQuery,
  type EditorSignatureHelpResolver,
  type EditorSymbolsQuery,
  type EditorSymbolsResolver,
  type EditorSymbolsResponse,
  type EditorTextEdit,
  type InlineCompletionTelemetrySnapshot,
  type KeikoEditorLoadState,
  type PatchPreviewModel,
  type PatchPreviewSource,
  type PatchPreviewSourceTruncation,
} from "@oscharko-dev/keiko-editor";
import dynamic from "next/dynamic";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ApiError,
  fetchEditorLanguageCapabilities,
  fetchFilesContent,
  fetchGitBlame,
  fetchGitStatus,
  fetchGitStructuredDiff,
  reportEditorInlineCompletionTelemetry,
  requestEditorCallHierarchy,
  requestEditorCodeActions,
  requestEditorCompletion,
  requestEditorDefinition,
  requestEditorDiagnostics,
  requestEditorFormatting,
  requestEditorHover,
  requestEditorImplementation,
  requestEditorInlayHints,
  requestEditorInlineCompletion,
  requestEditorReferences,
  requestEditorRenameApply,
  requestEditorRenamePrepare,
  requestEditorSemanticTokens,
  requestEditorSignatureHelp,
  requestEditorSymbols,
  requestEditorTypeDefinition,
  saveFilesContent,
} from "../../../../../lib/api";
import { mapWireToEditorCompletionResponse } from "../../../../../lib/editor-completion";
import { mapWireToEditorInlineCompletionResponse } from "../../../../../lib/editor-inline-completion";
import {
  mapWireToEditorCallHierarchyResponse,
  mapWireToEditorCodeActionsResponse,
  mapWireToEditorDefinitionResponse,
  mapWireToEditorDiagnosticsResponse,
  mapWireToEditorFormattingResponse,
  mapWireToEditorHoverResponse,
  mapWireToEditorInlayHintsResponse,
  mapWireToEditorReferencesResponse,
  mapWireToEditorSignatureHelpResponse,
  mapWireToEditorSymbolsResponse,
} from "../../../../../lib/editor-language";
import { useLocale, useTranslate, type I18nTranslate } from "../../../../../lib/i18n";
import { EN_MESSAGES } from "../../../../../lib/i18n-messages.en";
import type {
  EditorAgentPaneSnapshot,
  EditorCompletionContextSelectors,
  EditorDocumentVersion,
  FilesContentResponse,
  LanguageProviderDescriptor,
  LanguageRenameChangeset,
  LanguageRenameChangesetFile,
  LanguageServiceCapabilities,
} from "../../../../../lib/types";
import type { OpenEditorFileRequest, OpenEditorFileResult } from "../../hooks/useWorkspace.types";
import { Icons } from "../../Icons";
import conflictStyles from "./EditorConflicts.module.css";
import runtimeStyles from "./EditorRuntimeWidget.module.css";
import { EditorDocumentActions, type EditorDocumentAction } from "./EditorDocumentActions";
import { useEditorBufferSafety } from "./useEditorBufferSafety";

import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind } from "@/lib/http";
import { useDialogTabTrap } from "../../hooks/useDialogTabTrap";
import { useEditorThemeVariant } from "../../hooks/useEditorThemeVariant";
import { useModalInteractionLock } from "../../hooks/useModalInteractionLock";
import { SupportReportButton } from "../../SupportReportButton";
import {
  useRegisterWorkspaceReplaceBuffer,
  type WorkspaceReplaceOpenBufferResult,
} from "../../WorkspaceReplaceBufferContext";
import { FileIcon } from "../shared/projectTree";
import { AgentConflictBanner, type AgentConflictCode } from "./AgentConflictBanner";
import { useEditorAgentTranslate, type EditorAgentTranslate } from "./editor-agent-i18n";
import {
  EDITOR_BUFFER_RECONCILIATION_REQUEST_EVENT,
  editorBufferReconciliationRequestDetail,
} from "./editor-buffer-reconciliation-events";
import {
  editorLanguageIntelligenceStatus,
  useEditorLanguageIntelligenceTranslate,
} from "./editor-language-intelligence-i18n";
import { useEditorSourceControlTranslate } from "./editor-source-control-i18n";
import { EditorBreadcrumbBar } from "./EditorBreadcrumbBar";
import EditorDiffSurface from "./EditorDiffSurface";
import {
  documentSessionKey,
  documentUri,
  encodePathSegments,
  rootHash,
  safeDomIdSegment,
} from "./editorDocumentUri";
import {
  editorExternalChangeReducer,
  IDLE_EXTERNAL_CHANGE_STATE,
  type EditorExternalChangeState,
} from "./editorExternalChangeState";
import type { EditorFileHistoryPanelProps } from "./EditorFileHistoryPanel";
import { EditorGitHunkPeek } from "./EditorGitHunkPeek";
import {
  deleteEditorHotExitSnapshot,
  readEditorHotExitSnapshot,
  writeEditorHotExitSnapshot,
} from "./editorHotExitStore";
import {
  buildEditorOutlineTree,
  findContainingOutlinePath,
  type EditorOutlineRevealRequest,
  type EditorOutlineSnapshot,
} from "./editorOutlineModel";
import { removePaneDiagnostics, setPaneDiagnostics } from "./editorProblemsStore";
import {
  createEditorSemanticTokensHost,
  type EditorSemanticTokensQuery,
  type EditorSemanticTokensResolver,
} from "./editorSemanticTokens";
import { LruSessionCache } from "./editorSessionCache";
import type { EditorSurfaceProps } from "./EditorSurface";
import EditorSurfaceLoading from "./EditorSurfaceLoading";
import { readableTabCapacity, visibleTabsForCapacity } from "./editorTabViewport";
import {
  GIT_REPOSITORY_STATE_INVALIDATED_EVENT,
  gitRepositoryStateInvalidationRoots,
} from "./git-repository-state-events";
import { useEditorSettings } from "./useEditorSettings";
import { useEditorVerificationRun } from "./useEditorVerificationRun";
import { useWorkspaceSnippets } from "./useWorkspaceSnippets";
import { useWorkspaceWatch } from "./useWorkspaceWatch";
import { notifyWorkspaceFileMutated } from "./workspace-file-events";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const EditorIcon = Icons.editor;

const CloseIcon = Icons.close;

const EditorSurface = dynamic<EditorSurfaceProps>(() => import("./EditorSurface"), {
  ssr: false,
  loading: EditorSurfaceLoading,
});

const EditorDebugSessionHost = dynamic<
  import("./EditorDebugSessionHost").EditorDebugSessionHostProps
>(() => import("./EditorDebugSessionHost").then((mod) => mod.EditorDebugSessionHost), {
  ssr: false,
});

const EditorFileHistoryPanel = dynamic<EditorFileHistoryPanelProps>(
  () => import("./EditorFileHistoryPanel").then((module) => module.EditorFileHistoryPanel),
  { ssr: false },
);

const EDITOR_REVIEW_SURFACE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
};

const EDITOR_REVIEW_DIFF_GROUP_STYLE: CSSProperties = {
  flex: "1 1 auto",
  width: "100%",
  minWidth: 0,
  minHeight: 0,
};

// Blocking notice above a rename review the language service could not complete. Styled inline with
// design tokens like the other review-surface chrome in this file, so no global stylesheet changes
// are needed (the editor globals are behind a byte-exact visual-proof gate).
const EDITOR_RENAME_INCOMPLETE_STYLE: CSSProperties = {
  flex: "0 0 auto",
  padding: "6px 12px",
  color: "var(--text-primary)",
  background: "var(--feedback-warning-surface)",
  borderBottom: "1px solid color-mix(in oklch, var(--feedback-warning) 40%, transparent)",
  fontSize: "var(--text-body-sm)",
};

function hunksForPath(response: GitEditorDiffResponse, path: string): readonly GitEditorDiffHunk[] {
  return response.files.find((candidate) => candidate.path === path)?.hunks ?? [];
}

function relativeAge(locale: string, authorTime: string): string {
  const seconds = (Date.parse(authorTime) - Date.now()) / 1_000;
  const units = [
    [31_536_000, "year"],
    [2_592_000, "month"],
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ] as const;
  const unit = units.find(([size]) => Math.abs(seconds) >= size) ?? ([1, "second"] as const);
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    Math.round(seconds / unit[0]),
    unit[1],
  );
}

const EDITOR_REVIEW_ACTIONS_STYLE: CSSProperties = {
  flex: "0 0 auto",
};

const EDITOR_AGENT_PRESENCE_STYLE: CSSProperties = {
  minHeight: 30,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "5px 12px",
  borderTop: "1px solid color-mix(in oklch, var(--text-secondary) 18%, transparent)",
  borderBottom: "1px solid color-mix(in oklch, var(--text-secondary) 18%, transparent)",
  color: "var(--text-secondary)",
  fontSize: "var(--text-body-sm)",
};

const EDITOR_AGENT_PRESENCE_MARKER_STYLE: CSSProperties = {
  width: 3,
  height: 14,
  flex: "0 0 auto",
  borderRadius: 2,
};

interface MonacoCompatibleEditorUri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  readonly fsPath: string;
  with(
    change: Partial<Pick<MonacoCompatibleEditorUri, "authority" | "path" | "query" | "fragment">>,
  ): MonacoCompatibleEditorUri;
  toString(): string;
  toJSON(): {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
    readonly fragment: string;
  };
}

function monacoUriString(parts: {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
}): string {
  const query = parts.query.length > 0 ? `?${parts.query}` : "";
  const fragment = parts.fragment.length > 0 ? `#${parts.fragment}` : "";
  return `${parts.scheme}://${parts.authority}${parts.path}${query}${fragment}`;
}

function monacoCompatibleUri(parts: {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query?: string | undefined;
  readonly fragment?: string | undefined;
}): MonacoCompatibleEditorUri {
  const complete = {
    scheme: parts.scheme,
    authority: parts.authority,
    path: parts.path,
    query: parts.query ?? "",
    fragment: parts.fragment ?? "",
  };
  return {
    ...complete,
    fsPath: complete.path,
    with: (change): MonacoCompatibleEditorUri => monacoCompatibleUri({ ...complete, ...change }),
    toString: (): string => monacoUriString(complete),
    toJSON: () => complete,
  };
}

function monacoDocumentUri(
  root: string,
  path: string,
  modelScope: string,
): MonacoCompatibleEditorUri {
  return monacoCompatibleUri({
    scheme: "keiko-editor",
    authority: "workspace",
    path: `/${modelScope}/${rootHash(root)}/${encodePathSegments(path)}`,
  });
}

// Per-window session-cache cap (Issue 2.8). Open tabs + recently-visited files stay cached for instant
// switching; the LRU evicts older clean/closed entries beyond this, never a saving/dirty/active one.
const SESSION_CACHE_CAPACITY = 16;
const HOT_EXIT_WRITE_DEBOUNCE_MS = 400;
const CONTENT_HASH_DEBOUNCE_MS = 150;
const FORMAT_ON_SAVE_DEADLINE_MS = 5_000;
/**
 * Stated in full because the user asked for a formatted file and is getting neither the reformat nor
 * the write: what stopped it, that nothing reached disk, and how to proceed. Applying the surviving
 * edits instead would persist a half-formatted file under a clean "saved" — the same silent partial
 * application the rename changeset refuses (0.3.0 release audit).
 */
const FORMAT_ON_SAVE_CAPPED_MESSAGE =
  "Format-on-save stopped because the formatter hit a result limit and returned only part of the " +
  "reformat. Nothing was written. Turn format-on-save off to save this file unformatted.";
const UTF8_ENCODER = new TextEncoder();

/**
 * Out-parameter for `persist`: records the last text it optimistically adopted into the buffer.
 * A save owns the text it wrote, but a restore has to be able to undo an adoption that no write
 * ever justified (#2617), and format-on-save means the adopted text is not always the text passed
 * in. Scoped to a single `persist` call so a concurrent buffer mutation cannot be mistaken for it.
 */
interface BufferAdoptionSink {
  text: string | null;
}

interface FormatOnSaveState {
  readonly enabled: boolean;
  readonly canFormat: boolean;
  readonly document: EditorDocumentIdentity | null;
  readonly file: string | undefined;
  readonly root: string | undefined;
  readonly tabSize: number;
  readonly insertSpaces: boolean;
}
const RUST_SEMANTIC_TOKEN_LEGEND: ManagedLspSemanticTokenLegend = Object.freeze({
  schemaVersion: "1",
  legendVersion: 1,
  tokenTypes: MANAGED_LSP_SEMANTIC_TOKEN_TYPES,
  tokenModifiers: MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS,
  returnedTypeCount: MANAGED_LSP_SEMANTIC_TOKEN_TYPES.length,
  totalTypeCount: MANAGED_LSP_SEMANTIC_TOKEN_TYPES.length,
  returnedModifierCount: MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS.length,
  totalModifierCount: MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS.length,
  truncated: false,
});
const SEMANTIC_TEXT_ENCODER = new TextEncoder();

function semanticLegendMatches(value: ManagedLspSemanticTokenLegend): boolean {
  return (
    value.legendVersion === RUST_SEMANTIC_TOKEN_LEGEND.legendVersion &&
    value.tokenTypes.join("\0") === RUST_SEMANTIC_TOKEN_LEGEND.tokenTypes.join("\0") &&
    value.tokenModifiers.join("\0") === RUST_SEMANTIC_TOKEN_LEGEND.tokenModifiers.join("\0")
  );
}

// Pre-GET bootstrap seed for `languageCapabilities` before the async `/api/editor/language/capabilities`
// GET resolves. It seeds the TypeScript/JavaScript provider as available so the primary editing
// surface registers its governed intelligence at the FIRST `onMount` and does not remount when the GET
// resolves: Monaco language providers are registered once per editor mount (use-editor-handlers.ts),
// and `editorSurfaceKey` includes the resolved provider id, so a bootstrap id that differs from the
// server's would force a Monaco re-initialisation on load. Language *actions* are not TS/JS-gated —
// `providerOperationEnabled` reads the now-exhaustive server registry (Issue #1379 AC1); this seed is
// a transient, best-effort first-paint optimisation that the GET response immediately supersedes for
// every language.
const BOOTSTRAP_LANGUAGE_CAPABILITIES: LanguageServiceCapabilities = {
  schemaVersion: "1",
  providers: [
    {
      id: "typescript",
      languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
      operations: [
        "diagnostics",
        "completion",
        "hover",
        "symbols",
        "formatting",
        "definition",
        "references",
        "renamePrepare",
        "renameApply",
        "codeActions",
        "signatureHelp",
      ],
      availability: "available",
    },
  ],
};

type EditorTabHandleProps = Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "draggable" | "onClickCapture" | "onDragStart" | "onDragEnd" | "onKeyDown" | "onPointerDown"
> & {
  readonly "data-pane-id"?: string | undefined;
  readonly "data-tab-file"?: string | undefined;
  readonly "data-tab-draggable"?: "true" | "false" | undefined;
  readonly "data-tab-held"?: "true" | "false" | undefined;
  readonly "data-merge-conflicts"?: string | undefined;
};

interface EditorTabHandleContext {
  readonly onDragModeStart?: (() => void) | undefined;
  readonly mergeConflicts?: number | undefined;
}

interface EditorTabInsertTarget {
  readonly file: string;
  readonly edge: "before" | "after";
}

interface WorkspaceGitSummary {
  readonly requestedRoot: string;
  readonly repositoryRoot: string;
}

export interface EditorRuntimeWidgetProps {
  readonly windowId?: string | undefined;
  /** Keeps runtime state while omitting the inactive root's Monaco surface. */
  readonly sessionActive?: boolean | undefined;
  readonly paneId?: string | undefined;
  readonly activePaneId?: string | undefined;
  readonly layoutPanes?: readonly EditorAgentPaneSnapshot[] | undefined;
  readonly root?: string;
  readonly safetyRootBinding?: EditorAgentRootBinding | undefined;
  readonly file?: string;
  readonly openFiles?: readonly string[] | undefined;
  readonly revealLineStart?: number | undefined;
  readonly revealLineEnd?: number | undefined;
  readonly revealRequestId?: string | undefined;
  readonly dirtyFiles?: readonly string[] | undefined;
  readonly onSelectOpenFile?: ((file: string) => void) | undefined;
  readonly onCloseOpenFile?: ((file: string) => Promise<boolean> | boolean | void) | undefined;
  readonly onDirtyChange?: ((file: string, dirty: boolean) => void) | undefined;
  readonly openEditorFile?: ((request: OpenEditorFileRequest) => OpenEditorFileResult) | undefined;
  readonly onOpenGitCommit?: ((root: string, commit: string) => void) | undefined;
  readonly onOpenGitDiff?: ((root: string, path: string) => void) | undefined;
  readonly externalSaveRequest?: EditorExternalSaveRequest | undefined;
  readonly onExternalSaveComplete?:
    ((requestId: number, paneId: string, file: string, ok: boolean) => void) | undefined;
  readonly tabInsertTarget?: EditorTabInsertTarget | undefined;
  readonly renderTabHandle?:
    | ((
        file: string,
        active: boolean,
        dirty: boolean,
        context?: EditorTabHandleContext,
      ) => EditorTabHandleProps)
    | undefined;
  /**
   * GEN-PERF-EDITOR-003 — the file currently "held" (pointer-drag armed) in THIS pane, or
   * undefined. A per-pane scalar so a hold-state change re-renders only the affected pane;
   * the stable renderTabHandle reads the actual flag from the host's ref at call time. This
   * prop exists purely to trip React.memo for the one pane that must repaint its tab visual.
   */
  readonly heldTabFile?: string | undefined;
  readonly toolbarExtras?: ReactNode | undefined;
  readonly linkedRoot?: string | null;
  readonly linkedFilePath?: string | undefined;
  readonly linkedCapsuleIds?: readonly string[] | undefined;
  readonly linkedCapsuleSetIds?: readonly string[] | undefined;
  readonly onOutlineStateChange?:
    ((paneId: string, snapshot: EditorOutlineSnapshot) => void) | undefined;
  readonly outlineRevealRequest?: EditorOutlineRevealRequest | undefined;
  /** Monotonic palette request for opening this pane's active file history. */
  readonly fileHistoryRequestNonce?: number | undefined;
  /** Opens the transient bounded debug projection for this editor's resolved workspace. */
  readonly onOpenDebugPanel?: (() => void) | undefined;
}

export interface EditorExternalSaveRequest {
  readonly id: number;
  readonly paneId: string;
  readonly file: string;
}

function errorMessage(error: unknown, genericMessage?: string): string {
  if (error instanceof ApiError) {
    if (error.code === "INTERNAL" || error.code === "UNKNOWN")
      return genericMessage ?? error.message;
    return error.message;
  }
  if (genericMessage !== undefined) return genericMessage;
  return error instanceof Error ? error.message : "The file could not be loaded.";
}

function lineStartOffsets(text: string): readonly number[] {
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\r") {
      if (text[index + 1] === "\n") index += 1;
      starts.push(index + 1);
    } else if (char === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineContentEnd(text: string, starts: readonly number[], lineIndex: number): number {
  const nextStart = starts[lineIndex + 1];
  if (nextStart === undefined) return text.length;
  if (nextStart >= 2 && text[nextStart - 2] === "\r" && text[nextStart - 1] === "\n") {
    return nextStart - 2;
  }
  return nextStart - 1;
}

function oneBasedPositionOffset(
  text: string,
  starts: readonly number[],
  line: number,
  column: number,
): number | null {
  const lineIndex = line - 1;
  if (lineIndex < 0 || lineIndex >= starts.length || column < 1) return null;
  const lineStart = starts[lineIndex] ?? 0;
  const contentEnd = lineContentEnd(text, starts, lineIndex);
  const offset = lineStart + column - 1;
  return offset <= contentEnd + 1 ? offset : null;
}

function textForRange(text: string, range: WorkspaceReplacePreviewTextRange): string | null {
  const starts = lineStartOffsets(text);
  const start = oneBasedPositionOffset(text, starts, range.startLine, range.startColumn);
  const end = oneBasedPositionOffset(text, starts, range.endLine, range.endColumn);
  if (start === null || end === null || end < start) return null;
  return text.slice(start, end);
}

function replaceEditToEditorEdit(edit: WorkspaceReplaceApplyFile["edits"][number]): EditorTextEdit {
  return {
    range: {
      start: { line: edit.range.startLine - 1, column: edit.range.startColumn - 1 },
      end: { line: edit.range.endLine - 1, column: edit.range.endColumn - 1 },
    },
    newText: edit.newText,
  };
}

/** Map a workspace path to a renderable editor language; intelligence is registry/capability-gated below. */
function inferEditorLanguage(path: string): EditorLanguageId {
  const language = inferMonacoLanguageId(path);
  return isSupportedEditorLanguage(language) ? language : "plaintext";
}

function dropHotExitPersistenceFailure(operation: Promise<unknown>): void {
  void operation.catch(() => {
    // Hot-exit persistence is best-effort recovery storage; a vault outage must not surface as an
    // unhandled editor error or block normal file editing.
  });
}

async function deleteHotExitSnapshotBestEffort(root: string, file: string): Promise<void> {
  try {
    await deleteEditorHotExitSnapshot(root, file);
  } catch {
    // Keep file save semantics independent from best-effort recovery cleanup.
  }
}

async function sha256HexBytes(bytes: Uint8Array, fallbackText: string): Promise<string> {
  const cryptoLike = globalThis.crypto;
  if (cryptoLike?.subtle !== undefined) {
    const digest = await cryptoLike.subtle.digest("SHA-256", toExactArrayBuffer(bytes));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < fallbackText.length; index += 1) {
    const code = fallbackText.codePointAt(index) ?? 0;
    hash ^= code;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    if (code > 0xffff) index += 1;
  }
  return hash.toString(16).padStart(8, "0").repeat(8).slice(0, 64);
}

function editorRangeToWire(range: EditorRange): {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
} {
  return {
    start: { line: range.start.line, character: range.start.column },
    end: { line: range.end.line, character: range.end.column },
  };
}

function editorDiagnosticToWire(diagnostic: EditorDiagnostic): {
  readonly range: ReturnType<typeof editorRangeToWire>;
  readonly severity: EditorDiagnostic["severity"];
  readonly message: string;
  readonly source: string;
  readonly code?: string;
} {
  return {
    range: editorRangeToWire(diagnostic.range),
    severity: diagnostic.severity,
    message: diagnostic.message,
    source: diagnostic.source ?? "monaco",
    ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
  };
}

function revealRequestForLocation(location: EditorLocation): {
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
} {
  return {
    path: location.path,
    lineStart: location.range.start.line + 1,
    lineEnd: location.range.end.line + 1,
  };
}

function openCrossFileLocation(input: {
  readonly root: string | undefined;
  readonly file: string | undefined;
  readonly location: EditorLocation;
  readonly openEditorFile: ((request: OpenEditorFileRequest) => OpenEditorFileResult) | undefined;
}): void {
  if (
    input.root === undefined ||
    input.file === undefined ||
    input.openEditorFile === undefined ||
    input.location.path === input.file
  ) {
    return;
  }
  input.openEditorFile({ root: input.root, ...revealRequestForLocation(input.location) });
}

function locationIsOpen(input: {
  readonly path: string;
  readonly file: string | undefined;
  readonly openFiles: readonly string[] | undefined;
  readonly layoutPanes: readonly EditorAgentPaneSnapshot[] | undefined;
}): boolean {
  if (input.path === input.file) return true;
  if (input.openFiles?.includes(input.path) === true) return true;
  return input.layoutPanes?.some((pane) => pane.openFiles.includes(input.path)) === true;
}

function renameEditsToEditor(fileChange: LanguageRenameChangesetFile): readonly EditorTextEdit[] {
  return fileChange.edits.map((edit) => ({
    range: {
      start: { line: edit.range.start.line, column: edit.range.start.character },
      end: { line: edit.range.end.line, column: edit.range.end.character },
    },
    newText: edit.newText,
  }));
}

/**
 * The localized, count-naming notice for a rename the language service could not complete (result
 * caps reached, a reference file it could not read, a bounded project graph). Applying such a
 * changeset renames some occurrences and leaves the rest pointing at the old name, so this text is
 * shown before Accept is offered and Accept is refused while it is present.
 */
function renameIncompleteNotice(
  t: EditorAgentTranslate,
  truncation: PatchPreviewSourceTruncation,
): string {
  const notice = t("editor.rename.incomplete", {
    files: truncation.returnedFileCount,
    totalFiles: truncation.totalFileCount,
    edits: truncation.returnedEditCount,
    totalEdits: truncation.totalEditCount,
  });
  if (truncation.unreadableFileCount === 0) return notice;
  const unreadable = t("editor.rename.incompleteUnreadable", {
    count: truncation.unreadableFileCount,
  });
  return `${notice} ${unreadable}`;
}

function promptRenameSymbol(placeholder: string): string | null {
  const prompt = globalThis.window?.prompt;
  if (typeof prompt !== "function") return null;
  const value = prompt("Rename symbol", placeholder);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function diagnosticMessagePrefix(message: string): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const characters = [...message];
  if (characters.length <= EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS) {
    return { text: message, truncated: false };
  }
  return {
    text: characters.slice(0, EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS).join(""),
    truncated: true,
  };
}

interface EditorFileSessionSnapshot {
  readonly content: string;
  readonly fileModel: EditorFileModel | null;
  readonly modifiedAt: number | null;
  readonly version: EditorDocumentVersion | null;
  readonly maxBytes: number | null;
  readonly loadState: KeikoEditorLoadState;
  readonly loadCorrelationId?: string | undefined;
  readonly loadRetryable?: boolean | undefined;
  readonly saveStatus: EditorSaveStatus;
  readonly saveError: string | undefined;
  readonly cursor: EditorPosition | null;
  readonly currentSelection: EditorRange | null;
  readonly diagnosticsSummary: EditorDiagnosticsSummary | null;
  readonly localHistoryProtection?: NonNullable<FilesContentResponse["localHistoryProtection"]>;
}

interface RenameApplyTarget {
  readonly path: string;
  readonly content: string;
  readonly fileModel: EditorFileModel | null;
  readonly version: EditorDocumentVersion | null;
  readonly active: boolean;
  readonly cached?: EditorFileSessionSnapshot | undefined;
}

interface RenameApplyPlan {
  readonly target: RenameApplyTarget;
  readonly nextContent: string;
}

interface RenameApplyConflict {
  readonly code: AgentConflictCode;
  readonly message: string;
}

interface SymbolCacheEntry {
  readonly root: string;
  readonly path: string;
  readonly language: EditorLanguageId;
  readonly text: string;
  readonly symbols: readonly EditorDocumentSymbol[];
}

type RenameSourcesResult =
  | {
      readonly status: "ready";
      readonly sources: Readonly<Record<string, PatchPreviewSource>>;
      readonly snapshots: Readonly<Record<string, EditorFileSessionSnapshot>>;
    }
  | {
      readonly status: "conflict";
      readonly conflict: RenameApplyConflict;
    };

function patchPreviewSourceFromText(path: string, text: string): PatchPreviewSource {
  return {
    content: {
      relativePath: path,
      text,
      sizeBytes: UTF8_ENCODER.encode(text).length,
      truncated: false,
    },
  };
}

function cleanEditorSessionSnapshot(input: {
  readonly root: string;
  readonly path: string;
  readonly modelScope: string;
  readonly response: FilesContentResponse;
}): EditorFileSessionSnapshot {
  const identity: EditorDocumentIdentity = {
    uri: documentUri(input.root, input.path, input.modelScope),
    language: inferEditorLanguage(input.path),
    version: 0,
  };
  return {
    content: input.response.content,
    fileModel: createFileModel(identity),
    modifiedAt: input.response.modifiedAt,
    version: input.response.session.version,
    maxBytes: input.response.maxBytes,
    loadState: { status: "ready" },
    saveStatus: "idle",
    saveError: undefined,
    cursor: null,
    currentSelection: null,
    diagnosticsSummary: null,
    ...(input.response.localHistoryProtection === undefined
      ? {}
      : { localHistoryProtection: input.response.localHistoryProtection }),
  };
}

function symbolCacheMatches(
  entry: SymbolCacheEntry | null,
  input: {
    readonly root: string;
    readonly path: string;
    readonly language: EditorLanguageId;
    readonly text: string;
  },
): entry is SymbolCacheEntry {
  return (
    entry !== null &&
    entry.root === input.root &&
    entry.path === input.path &&
    entry.language === input.language &&
    entry.text === input.text
  );
}

function targetPreconditionConflict(
  change: LanguageRenameChangesetFile,
  target: RenameApplyTarget | null,
): RenameApplyConflict | null {
  if (target?.version === undefined || target.version === null || target.fileModel === null) {
    return {
      code: "VERSION_MISMATCH",
      message: `Rename target ${change.path} is not loaded in the editor.`,
    };
  }
  if (isDocumentDirty(target.fileModel)) {
    return {
      code: "DIRTY",
      message: `Rename target ${change.path} has unsaved changes.`,
    };
  }
  if (target.version.contentHash !== change.expectedContentHash) {
    return {
      code: "CONTENT_HASH_MISMATCH",
      message: `Rename target ${change.path} changed since the rename was computed.`,
    };
  }
  return null;
}

function buildRenamePlan(
  change: LanguageRenameChangesetFile,
  target: RenameApplyTarget | null,
): RenameApplyPlan | RenameApplyConflict {
  if (target === null) {
    return {
      code: "VERSION_MISMATCH",
      message: `Rename target ${change.path} is not loaded in the editor.`,
    };
  }
  const conflict = targetPreconditionConflict(change, target);
  if (conflict !== null) return conflict;
  return { target, nextContent: applyTextEditsToText(target.content, renameEditsToEditor(change)) };
}

function editorAriaLabel(root: string, file: string): string {
  return `Editor: ${file} in ${root}`;
}

// GEN-PERF-EDITOR-004 — extract a single 0-indexed line without splitting the whole buffer.
// Walks newline boundaries to the target line (O(offset) up to the line, not O(N) with an
// N-line array allocation), then slices the bounded line. Returns "" for out-of-range lines,
// matching the previous `split("\n")[line] ?? ""` behavior.
export function lineAtIndex(text: string, line: number): string {
  if (line < 0) return "";
  let start = 0;
  for (let i = 0; i < line; i += 1) {
    const nextNewline = text.indexOf("\n", start);
    if (nextNewline === -1) return ""; // fewer lines than requested
    start = nextNewline + 1;
  }
  const end = text.indexOf("\n", start);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

export function currentLineQueryText(
  text: string,
  line: number,
  character: number,
): string | undefined {
  const currentLine = lineAtIndex(text, line);
  const beforeCursor = currentLine.slice(0, Math.max(0, character));
  const query = beforeCursor
    .replace(/[^A-Za-z0-9_.$/-]+/g, " ")
    .trim()
    .slice(-160)
    .trim();
  return query.length > 0 ? query : undefined;
}

function completionContextSelectors(input: {
  readonly root: string;
  readonly file: string;
  readonly text: string;
  readonly line: number;
  readonly character: number;
  readonly linkedRoot: string | null | undefined;
  readonly linkedFilePath: string | undefined;
  readonly linkedCapsuleIds: readonly string[] | undefined;
  readonly linkedCapsuleSetIds: readonly string[] | undefined;
}): EditorCompletionContextSelectors | undefined {
  const selectors: {
    queryText?: string;
    changedFiles?: readonly string[];
    capsuleId?: string;
    capsuleSetId?: string;
  } = {};
  const queryText = currentLineQueryText(input.text, input.line, input.character);
  if (queryText !== undefined) {
    selectors.queryText = queryText;
  }
  if (
    input.linkedRoot === input.root &&
    input.linkedFilePath !== undefined &&
    input.linkedFilePath.length > 0 &&
    input.linkedFilePath !== input.file
  ) {
    selectors.changedFiles = [input.linkedFilePath];
  }
  const capsuleId = input.linkedCapsuleIds?.[0];
  const capsuleSetId = input.linkedCapsuleSetIds?.[0];
  if (capsuleId !== undefined) {
    selectors.capsuleId = capsuleId;
  } else if (capsuleSetId !== undefined) {
    selectors.capsuleSetId = capsuleSetId;
  }
  return Object.keys(selectors).length > 0 ? selectors : undefined;
}

function completionPrefixAt(text: string, line: number, character: number): string {
  const currentLine = lineAtIndex(text, line);
  const beforeCursor = currentLine.slice(0, Math.max(0, character));
  let start = beforeCursor.length;
  while (start > 0 && completionPrefixChar(beforeCursor[start - 1] ?? "")) start -= 1;
  return beforeCursor.slice(start);
}

function completionPrefixChar(value: string): boolean {
  return /^[A-Za-z0-9._:-]$/u.test(value);
}

function snippetCompletionItems(input: {
  readonly snapshot: EditorM7WorkspaceSnippetSnapshot | undefined;
  readonly languageId: string;
  readonly relativePath: string;
  readonly prefix: string;
  readonly insertionSafe: boolean;
  readonly signal: AbortSignal;
}): readonly EditorCompletionItem[] {
  const snapshot = input.snapshot;
  if (snapshot === undefined || snapshot.storeState === "unavailable") return [];
  return matchingEditorM7Snippets({
    collection: snapshot,
    languageId: input.languageId,
    relativePath: input.relativePath,
    prefix: input.prefix,
    insertionSafe: input.insertionSafe,
    signal: input.signal,
  }).map((item) => ({
    label: item.label,
    kind: "snippet",
    insertText: item.insertText,
    insertAsSnippet: true,
    detail: item.detail,
    sortText: item.sortText,
    provenance: { origin: "deterministic-completion" },
  }));
}

function providerForLanguage(
  capabilities: LanguageServiceCapabilities | null,
  languageId: string | undefined,
): LanguageProviderDescriptor | null {
  if (capabilities === null || languageId === undefined) return null;
  return capabilities.providers.find((provider) => provider.languages.includes(languageId)) ?? null;
}

function providerOperationEnabled(
  provider: LanguageProviderDescriptor | null,
  operation:
    | "diagnostics"
    | "completion"
    | "hover"
    | "symbols"
    | "formatting"
    | "definition"
    | "typeDefinition"
    | "implementation"
    | "references"
    | "callHierarchy"
    | "inlayHints"
    | "renamePrepare"
    | "renameApply"
    | "codeActions"
    | "signatureHelp",
): boolean {
  return (
    provider !== null &&
    provider.availability === "available" &&
    provider.operations.includes(operation)
  );
}

/** Build a shared diff preview for manual recovery and external-change comparison. */
function buildEditorReviewDiffModel(
  original: string,
  modified: string,
  filePath: string | undefined,
): PatchPreviewModel {
  const uri = filePath ?? "editor-review";
  const language = inferMonacoLanguageId(filePath ?? "");
  const hasChanges = original !== modified;
  return {
    patchId: "editor-review",
    status: "previewed",
    provenance: { origin: "applied-patch" },
    files: [
      {
        uri,
        displayPath: filePath ?? "Patch",
        status: "modified",
        diffable: true,
        original,
        modified,
        language,
        hasChanges,
        truncated: false,
      },
    ],
    fileCount: 1,
    totalFileCount: 1,
    omittedFileCount: 0,
    createdCount: 0,
    modifiedCount: 1,
    deletedCount: 0,
    binaryCount: 0,
    unsupportedCount: 0,
    truncated: false,
  };
}

function workspaceWatchEventTouchesPath(
  event: EditorM7WatchEvent,
  path: string | undefined,
): boolean {
  if (path === undefined || path.length === 0) return event.relativePath.length === 0;
  return (
    event.relativePath.length === 0 || event.relativePath === path || event.oldRelativePath === path
  );
}

function externalChangeMessage(state: EditorExternalChangeState, file: string | undefined): string {
  const subject = file !== undefined && file.length > 0 ? file : "this file";
  switch (state.status) {
    case "cleanChanged":
      return `The file changed on disk: ${subject}.`;
    case "dirtyChanged":
      return `The file changed on disk while you have unsaved edits: ${subject}.`;
    case "deleted":
      return `The file was deleted on disk: ${subject}.`;
    case "renamed":
      return state.oldRelativePath === null
        ? `The file may have moved on disk: ${subject}.`
        : `The file may have moved on disk from ${state.oldRelativePath}.`;
    case "rescanRequired":
      return "Workspace file events fell behind. Refresh before trusting stale editor state.";
    case "degraded":
      return state.reason === null
        ? "Workspace file watching is degraded. Refresh before trusting stale editor state."
        : `Workspace file watching is degraded: ${state.reason}.`;
    case "idle":
      return "";
  }
}

function externalChangeCanCompare(state: EditorExternalChangeState): boolean {
  return state.status === "cleanChanged" || state.status === "dirtyChanged";
}

interface RecentLocalWrite {
  readonly sessionKey: string;
  readonly path: string;
  readonly expiresAt: number;
  readonly expectedVersion: EditorDocumentVersion;
  readonly externalChangeObserved: boolean;
}

interface PendingLocalSave {
  readonly sessionKey: string;
  readonly settled: Promise<void>;
  readonly complete: () => void;
}

function pendingLocalSave(sessionKey: string): PendingLocalSave {
  let complete = (): void => undefined;
  const settled = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { sessionKey, settled, complete };
}

interface WorkspaceWatchReconciliationGeneration {
  readonly root: string | undefined;
  readonly file: string | undefined;
  readonly sessionKey: string | null;
  readonly documentVersion: EditorDocumentVersion | null;
  readonly editorVersion: number | null;
}

function localWriteTargetsEvent(
  localWrite: RecentLocalWrite,
  event: EditorM7WatchEvent,
  sessionKey: string | null,
): boolean {
  return (
    localWrite.sessionKey === sessionKey &&
    (localWrite.path === event.relativePath || localWrite.path === event.oldRelativePath)
  );
}

function eventMatchesSavedMetadata(
  event: EditorM7WatchEvent,
  expectedVersion: EditorDocumentVersion,
): boolean {
  return (
    event.kind === "changed" &&
    event.sizeBytes === expectedVersion.sizeBytes &&
    event.modifiedAt === expectedVersion.modifiedAt
  );
}

// Every editor pane mounts its own EditorRuntimeWidget instance. Root switches use root-scoped model
// ownership; this count reserves the registry-wide shutdown cleanup for the last surviving pane.
let liveEditorRuntimeInstances = 0;

function nonEmptyEditorFile(file: string | undefined): string | null {
  return file === undefined || file.length === 0 ? null : file;
}

function definedOr<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback;
}

function nullishOr<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

function initialEditorLoadState(hasTarget: boolean): KeikoEditorLoadState {
  return hasTarget ? { status: "loading" } : { status: "ready" };
}

// KEIKO-0819: sizeBytes rides along with hash so both are computed from the same single
// UTF8_ENCODER.encode(content) pass inside the debounced effect below, instead of a separate
// per-keystroke encode.
interface ActiveContentDigest {
  readonly content: string;
  readonly hash: string;
  readonly sizeBytes: number;
}

function activeDigestHash(digest: ActiveContentDigest | null, content: string): string | null {
  return digest?.content === content ? digest.hash : null;
}

// The digest object itself, only when it matches the CURRENT content — null while the debounce
// window has not yet settled for the latest edit. hash/sizeBytes read off the result are exact for
// `content`, never stale or estimated (unlike activeContentDigest?.sizeBytes read directly, which
// stays at its last resolved value instead of resetting to unknown on every keystroke).
function freshContentDigest(
  digest: ActiveContentDigest | null,
  content: string,
): ActiveContentDigest | null {
  return digest?.content === content ? digest : null;
}

// Cheap, allocation-free UPPER bound on the UTF-8 byte length of `content`. Every UTF-16 code unit
// encodes to at most 4 UTF-8 bytes, so this can only ever OVER-estimate — safe as a stand-in while
// the exact, debounced digest for this content has not settled yet, never as a substitute for it.
function conservativeByteEstimateUpperBound(content: string): number {
  return content.length * 4;
}

// The byte count the HARD size-limit / write gate must read (`isMaxSizeExceeded` /
// `effectiveReadOnly` in `@oscharko-dev/keiko-editor`'s save-state.ts, via `buffer.content.
// sizeBytes`): byte-exact once the debounced digest has settled for this exact content
// (`readyDigest` non-null), a conservative (never-under) UPPER-bound estimate otherwise. This gate
// must fail SAFE — it must never let an over-limit buffer look smaller than it truly is — instead
// of pairing a stale `ActiveContentDigest.sizeBytes` (whatever content last settled, not
// necessarily `content`) with the current text (PR #3289 review).
function writeGateSizeBytesEstimate(
  readyDigest: ActiveContentDigest | null,
  content: string,
): number {
  return readyDigest?.sizeBytes ?? conservativeByteEstimateUpperBound(content);
}

// The byte count the BEHAVIORAL large-file-mode / automatic-read-only signal must read: byte-exact
// once settled (identical to the write gate above once `readyDigest` is non-null), a conservative
// (never-OVER) LOWER-bound estimate otherwise — `content.length` (UTF-16 code units), which can
// only ever UNDER-estimate the true UTF-8 byte count (minimum 1 byte per code unit). Unlike the
// write gate, this signal must fail PERMISSIVE during the debounce window: feeding it the SAME *4
// upper bound as the write gate marked an actually sub-500KB ASCII file read-only until the
// debounce settled (PR #3289 review, comment 3865167711 — round-2 correction of the round-1 fix
// above). Under-classifying here only ever means a large file stays fully-interactive a little too
// long, never that a small one gets locked down; it resolves to the exact value the moment the
// digest settles.
function modeSelectionSizeBytesEstimate(
  readyDigest: ActiveContentDigest | null,
  content: string,
): number {
  return readyDigest?.sizeBytes ?? content.length;
}

function hasEditorTarget(root: string | undefined, file: string | undefined): boolean {
  return root !== undefined && root.length > 0 && file !== undefined && file.length > 0;
}

function editorSessionKeyOrNull(root: string | undefined, file: string | undefined): string | null {
  return hasEditorTarget(root, file) && root !== undefined && file !== undefined
    ? documentSessionKey(root, file)
    : null;
}

function editorDocumentUriOrNull(
  root: string | undefined,
  file: string | undefined,
  scope: string,
): string | null {
  if (!hasEditorTarget(root, file) || root === undefined || file === undefined) return null;
  return documentUri(root, file, scope);
}

function modelMatchesDocument(
  model: EditorFileModel | null,
  uri: string | null,
): model is EditorFileModel {
  return model !== null && uri !== null && model.identity.uri === uri;
}

function modelDirty(model: EditorFileModel | null): boolean {
  return model !== null && isDocumentDirty(model);
}

interface LargeFileSettings {
  readonly degraded: boolean;
  readonly readOnly: boolean;
}

function largeFileSettings(
  automaticMode: ReturnType<typeof deriveLargeFileMode>,
  preference: ReturnType<typeof useEditorSettings>["applied"]["largeFileMode"],
): LargeFileSettings {
  const automatic = automaticMode === "degraded";
  return {
    degraded: automatic || preference === "degraded" || preference === "readonly",
    readOnly: automatic || preference === "readonly",
  };
}

type EditorLanguageProvider = ReturnType<typeof providerForLanguage>;
type EditorProviderOperation = Parameters<typeof providerOperationEnabled>[1];

function editorProviderFeatureEnabled(
  provider: EditorLanguageProvider,
  operation: EditorProviderOperation,
  degraded: boolean,
): boolean {
  return !degraded && providerOperationEnabled(provider, operation);
}

function editorRenameEnabled(provider: EditorLanguageProvider, degraded: boolean): boolean {
  return (
    !degraded &&
    providerOperationEnabled(provider, "renamePrepare") &&
    providerOperationEnabled(provider, "renameApply")
  );
}

function editorSemanticTokensEnabled(
  language: EditorLanguageId | undefined,
  provider: EditorLanguageProvider,
  degraded: boolean,
): boolean {
  return language === "rust" && editorProviderFeatureEnabled(provider, "hover", degraded);
}

interface EditorFormattingSettings {
  readonly source: ReturnType<typeof editorBuiltinDocumentFormatting>;
  readonly enabled: boolean;
}

function editorFormattingSettings(
  language: EditorLanguageId | undefined,
  provider: EditorLanguageProvider,
  degraded: boolean,
): EditorFormattingSettings {
  const formatting = editorBuiltinDocumentFormatting(definedOr(language, "plaintext"));
  const available =
    formatting === "monaco-builtin" ||
    (formatting === "keiko-language-service" && providerOperationEnabled(provider, "formatting"));
  return { source: formatting, enabled: available && !degraded };
}

function matchingDocumentIdentity(
  model: EditorFileModel | null,
  matches: boolean,
): EditorDocumentIdentity | null {
  return matches && model !== null ? model.identity : null;
}

function editorProviderId(provider: EditorLanguageProvider): string {
  return provider?.id ?? "none";
}

interface EditorActionAvailability {
  readonly canSave: boolean;
  readonly canFormat: boolean;
  readonly canRename: boolean;
}

function editorActionAvailability(input: {
  readonly hasTarget: boolean;
  readonly dirty: boolean;
  readonly saveStatus: EditorSaveStatus;
  readonly loadReady: boolean;
  readonly formattingEnabled: boolean;
  readonly renameEnabled: boolean;
}): EditorActionAvailability {
  return {
    canSave: input.hasTarget && input.dirty && input.saveStatus !== "saving" && input.loadReady,
    canFormat: input.hasTarget && input.loadReady && input.formattingEnabled,
    canRename: input.hasTarget && input.loadReady && input.renameEnabled,
  };
}

function editorModelViewStateKey(
  hasTarget: boolean,
  root: string | undefined,
  file: string | undefined,
  scope: string,
  paneId: string | undefined,
): string | undefined {
  if (!hasTarget || root === undefined || file === undefined) return undefined;
  return `${scope}:${definedOr(paneId, "pane")}:${documentSessionKey(root, file)}`;
}

function recoverySnapshotChanged(
  snapshot: EditorHotExitSnapshotV1 | null,
  version: EditorDocumentVersion | null,
): boolean {
  return (
    typeof snapshot?.savedContentHash === "string" &&
    version !== null &&
    snapshot.savedContentHash !== version.contentHash
  );
}

function tabAriaLabel(
  path: string,
  conflictCount: number,
  sourceControlT: ReturnType<typeof useEditorSourceControlTranslate>,
): string {
  if (conflictCount === 0) return path;
  return `${path}, ${sourceControlT("conflicts.statusAria", { count: conflictCount })}`;
}

function whenEnabled<T>(enabled: boolean, value: T): T | undefined {
  return enabled ? value : undefined;
}

function nullToUndefined<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

function activeEditorAriaLabel(
  root: string | undefined,
  file: string | undefined,
): string | undefined {
  return root === undefined || file === undefined ? undefined : editorAriaLabel(root, file);
}

function navigationResolverEnabled(
  definition: boolean,
  typeDefinition: boolean,
  implementation: boolean,
  references: boolean,
): boolean {
  return definition || typeDefinition || implementation || references;
}

function anyTrue(...values: readonly boolean[]): boolean {
  return values.some(Boolean);
}

function enabledValueOrNull<T>(enabled: boolean, value: T | null): T | null {
  return enabled ? value : null;
}

function retryableEditorLoadError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status < 400 || error.status >= 500 || error.status === 408 || error.status === 429;
}

function failedEditorSessionSnapshot(
  state: KeikoEditorLoadState,
  correlationId: string,
  retryable: boolean,
): EditorFileSessionSnapshot {
  return {
    content: "",
    fileModel: null,
    modifiedAt: null,
    version: null,
    maxBytes: null,
    loadState: state,
    loadCorrelationId: correlationId,
    loadRetryable: retryable,
    saveStatus: "idle",
    saveError: undefined,
    cursor: null,
    currentSelection: null,
    diagnosticsSummary: null,
  };
}

function editorLoadFailureState(error: unknown): KeikoEditorLoadState {
  return {
    status: "error",
    message: errorMessage(error, EN_MESSAGES["editor.runtime.loadFailed"]),
  };
}

function editorLoadErrorMessage(
  hasTarget: boolean,
  state: KeikoEditorLoadState,
  t: I18nTranslate,
): string | null {
  if (!hasTarget || state.status !== "error") return null;
  return state.message === EN_MESSAGES["editor.runtime.loadFailed"]
    ? t("editor.runtime.loadFailed")
    : state.message;
}

function EditorRuntimeWidget({
  windowId,
  sessionActive = true,
  paneId,
  activePaneId,
  layoutPanes,
  root,
  safetyRootBinding,
  file,
  revealLineStart,
  revealLineEnd,
  revealRequestId,
  openFiles,
  dirtyFiles,
  onSelectOpenFile,
  onCloseOpenFile,
  onDirtyChange,
  openEditorFile,
  onOpenGitCommit,
  onOpenGitDiff,
  externalSaveRequest,
  onExternalSaveComplete,
  tabInsertTarget,
  renderTabHandle,
  toolbarExtras,
  linkedRoot,
  linkedFilePath,
  linkedCapsuleIds,
  linkedCapsuleSetIds,
  onOutlineStateChange,
  outlineRevealRequest,
  fileHistoryRequestNonce,
  onOpenDebugPanel,
  heldTabFile,
}: EditorRuntimeWidgetProps): ReactNode {
  const commonT = useTranslate();
  const sourceControlT = useEditorSourceControlTranslate();
  const languageIntelligenceT = useEditorLanguageIntelligenceTranslate();
  const locale = useLocale();
  const t = useEditorAgentTranslate();
  const editorSettings = useEditorSettings(root);
  const debugActivation = editorSettings.snapshot?.debugging;
  const debugEnabled = debugActivation?.state === "available";
  const debugWorkspaceId = editorSettings.snapshot?.debugWorkspaceId;
  const [debugEditorHost, setDebugEditorHost] = useState<EditorSurfaceProps["debug"]>(undefined);
  const [debugSessionState, setDebugSessionState] = useState<
    import("./EditorDebugSessionHost").DebugSessionState | null
  >(null);
  // Distinguishes an exception pause from an ordinary breakpoint/step pause for the shared status
  // bar live region (status-bar.ts's isExceptionPause); DebugPanel renders the same distinction
  // visually but deliberately never announces it (see its no-duplicate-live-region rationale).
  const [debugPauseIsException, setDebugPauseIsException] = useState(false);
  // The last non-cancelled outcome of every Monaco language bridge (one shared reducer in the editor
  // package). Without it, a language-provider crash, a timeout and a genuinely empty result all reach
  // the user as "nothing found"; the status-bar field below is what makes them distinguishable.
  const [languageIntelligence, dispatchLanguageIntelligence] = useReducer(
    reduceLanguageIntelligence,
    EMPTY_LANGUAGE_INTELLIGENCE_STATE,
  );
  const reportLanguageIntelligence = useCallback((event: EditorLanguageIntelligenceEvent): void => {
    dispatchLanguageIntelligence(event);
  }, []);
  const workspaceSnippets = useWorkspaceSnippets(root);
  // Applies the effective, policy-aware modelRetentionCount/modelRetentionBytes live to the shared
  // Monaco model registry. Every mounted editor surface renders this component, so the registry
  // stays configured to the current effective values without a dedicated global subscriber.
  useEffect(() => {
    configureEditorModelRegistry({
      countBudget: editorSettings.applied.modelRetentionCount,
      byteBudget: editorSettings.applied.modelRetentionBytes,
    });
  }, [editorSettings.applied.modelRetentionCount, editorSettings.applied.modelRetentionBytes]);
  // AC7: release only clean, inactive models owned by the previous canonical root. Sibling panes
  // keep attached models protected, and entries owned by other roots are never considered.
  const previousRuntimeRootRef = useRef(root);
  useEffect(() => {
    const previousRoot = previousRuntimeRootRef.current;
    if (previousRoot === root) return;
    if (previousRoot !== undefined) {
      disposeEditorModelRegistryRoot(previousRoot);
    }
    previousRuntimeRootRef.current = root;
  }, [root]);
  useEffect(() => {
    liveEditorRuntimeInstances += 1;
    return () => {
      liveEditorRuntimeInstances -= 1;
      if (liveEditorRuntimeInstances === 0) {
        // A multi-root focus switch unmounts the inactive Monaco child and mounts the next root in
        // one React commit. Defer final-window cleanup until after that commit's effects so the
        // transient zero does not destroy retained dirty models between sibling root sessions.
        queueMicrotask(() => {
          if (liveEditorRuntimeInstances === 0) disposeAllUnattachedEditorModels();
        });
      }
    };
  }, []);
  const snippetInsertionSafeRef = useRef(false);
  // Issue #2212 (ADR-0126) — verification run state for the status bar + diff-review affordances,
  // derived from the same governed route/stream the palette uses (server-authoritative via SSE).
  const verification = useEditorVerificationRun({
    root: definedOr(root, ""),
    activeFile: nonEmptyEditorFile(file),
  });
  const { runFileTests: runVerificationFileTests, runWorkspaceVerification } = verification;
  const generatedId = useId();
  const diagnosticsProducerId = definedOr(windowId, generatedId);
  // Verify the files in the rename review, which may differ from the active document.
  // Multi-file reviews use workspace verification rather than guessing a representative file.
  const runScopedVerification = useCallback(
    (reviewedFiles: readonly string[]): void => {
      if (reviewedFiles.length === 1 && reviewedFiles[0] !== undefined) {
        runVerificationFileTests(reviewedFiles[0]);
      } else {
        runWorkspaceVerification("typecheck");
      }
    },
    [runVerificationFileTests, runWorkspaceVerification],
  );
  // Issue #2213 (ADR-0126) — feed this pane's diagnostics (keyed by path) into the workspace Problems
  // panel store, and remove them only once a file is truly no longer open (closed, or the pane
  // unmounts) — never merely because the user switched to a different already-open tab. Language
  // diagnostics are inherently bounded to currently-open buffers; the panel copy must not imply
  // full-workspace coverage, but it must also not silently drop a background tab's diagnostics the
  // instant the user looks away from it (Issue #2213 fix-up).
  const onPaneDiagnostics = useCallback(
    (diagnostics: readonly EditorDiagnostic[]): void => {
      if (root !== undefined && root.length > 0 && file !== undefined && file.length > 0) {
        setPaneDiagnostics(root, diagnosticsProducerId, file, diagnostics);
      }
    },
    [diagnosticsProducerId, root, file],
  );
  const hasTarget = root !== undefined && root.length > 0 && file !== undefined && file.length > 0;
  const editorModelScope = useMemo(
    () => safeDomIdSegment(windowId ?? generatedId),
    [generatedId, windowId],
  );
  const editorDomIdPrefix = useMemo(() => `ed-${editorModelScope}`, [editorModelScope]);
  const tabId = `${editorDomIdPrefix}-active-tab`;
  const tabpanelId = `${editorDomIdPrefix}-tabpanel`;
  const tablistRef = useRef<HTMLDivElement>(null);
  const documentTabs = useMemo(() => {
    const deduped: string[] = [];
    for (const path of openFiles ?? []) {
      if (path.length > 0 && !deduped.includes(path)) deduped.push(path);
    }
    if (file !== undefined && file.length > 0 && !deduped.includes(file)) {
      deduped.push(file);
    }
    return deduped;
  }, [file, openFiles]);
  // Issue #2213 fix-up — evict a path's Problems-panel diagnostics only when it leaves documentTabs
  // (a genuine close), never on a mere active-tab switch between still-open tabs. Cleans up every
  // remaining open path on unmount (the whole pane closing).
  const documentTabsRef = useRef<readonly string[]>(documentTabs);
  useEffect(() => {
    const previousTabs = documentTabsRef.current;
    documentTabsRef.current = documentTabs;
    if (root === undefined || root.length === 0) return;
    for (const previousPath of previousTabs) {
      if (!documentTabs.includes(previousPath)) {
        removePaneDiagnostics(root, diagnosticsProducerId, previousPath);
      }
    }
  }, [diagnosticsProducerId, documentTabs, root]);
  useEffect(() => {
    return (): void => {
      if (root === undefined || root.length === 0) return;
      for (const openPath of documentTabsRef.current) {
        removePaneDiagnostics(root, diagnosticsProducerId, openPath);
      }
    };
  }, [diagnosticsProducerId, root]);
  const [tablistWidth, setTablistWidth] = useState(0);

  useLayoutEffect(() => {
    const el = tablistRef.current;
    if (el === null) return;
    let frame: number | null = null;
    const updateCompactState = (): void => {
      frame = null;
      const width = Math.round(el.getBoundingClientRect().width);
      if (width <= 0) return;
      setTablistWidth((current) => (current === width ? current : width));
    };
    const scheduleUpdate = (): void => {
      if (frame !== null) return;
      frame =
        typeof window.requestAnimationFrame === "function"
          ? window.requestAnimationFrame(updateCompactState)
          : window.setTimeout(updateCompactState, 0);
    };
    scheduleUpdate();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    ro?.observe(el);
    return () => {
      if (frame !== null) {
        if (typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(frame);
        } else {
          window.clearTimeout(frame);
        }
      }
      ro?.disconnect();
    };
  }, [documentTabs.length]);
  const visibleTabCapacity = readableTabCapacity(tablistWidth, documentTabs.length);
  const [visibleTabStart, setVisibleTabStart] = useState(0);
  useLayoutEffect(() => {
    setVisibleTabStart((current) => {
      if (visibleTabCapacity >= documentTabs.length) return 0;
      const maxStart = Math.max(0, documentTabs.length - visibleTabCapacity);
      const clampedStart = Math.min(Math.max(0, current), maxStart);
      const activeIndex = file === undefined || file.length === 0 ? -1 : documentTabs.indexOf(file);
      if (activeIndex < 0) return clampedStart;
      if (activeIndex >= clampedStart && activeIndex < clampedStart + visibleTabCapacity) {
        return clampedStart;
      }
      if (activeIndex < clampedStart) return activeIndex;
      return Math.min(activeIndex - visibleTabCapacity + 1, maxStart);
    });
  }, [documentTabs, file, visibleTabCapacity]);
  const visibleTabs = useMemo(
    () => visibleTabsForCapacity(documentTabs, visibleTabStart, visibleTabCapacity),
    [documentTabs, visibleTabCapacity, visibleTabStart],
  );
  const visibleTabSet = useMemo(() => new Set(visibleTabs), [visibleTabs]);
  const summaryTabs = documentTabs.filter((path) => !visibleTabSet.has(path));
  const compactTabs = summaryTabs.length > 0;
  const summaryMenuId = `${editorDomIdPrefix}-summary-menu`;
  const summaryMenuRef = useRef<HTMLDetailsElement>(null);
  const [summaryMenuOpen, setSummaryMenuOpen] = useState(false);

  useEffect(() => {
    if (!summaryMenuOpen) return;
    const closeSummaryMenuOnOutsidePointer = (event: globalThis.PointerEvent): void => {
      const menu = summaryMenuRef.current;
      const target = event.target;
      if (menu === null || !(target instanceof Node) || menu.contains(target)) return;
      setSummaryMenuOpen(false);
      menu.removeAttribute("open");
    };
    document.addEventListener("pointerdown", closeSummaryMenuOnOutsidePointer, true);
    return () => {
      document.removeEventListener("pointerdown", closeSummaryMenuOnOutsidePointer, true);
    };
  }, [summaryMenuOpen]);

  const [content, setContent] = useState("");
  const [fileModel, setFileModel] = useState<EditorFileModel | null>(null);
  const [modifiedAt, setModifiedAt] = useState<number | null>(null);
  const [version, setVersion] = useState<EditorDocumentVersion | null>(null);
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const [loadState, setLoadState] = useState<KeikoEditorLoadState>(
    initialEditorLoadState(hasTarget),
  );
  const [loadCorrelationId, setLoadCorrelationId] = useState<string | undefined>(undefined);
  const [loadRetryable, setLoadRetryable] = useState(true);
  const [saveStatus, setSaveStatus] = useState<EditorSaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [localHistoryProtection, setLocalHistoryProtection] = useState<
    NonNullable<FilesContentResponse["localHistoryProtection"]> | undefined
  >(undefined);
  const [fileHistoryOpen, setFileHistoryOpen] = useState(false);
  useEffect(() => {
    if (fileHistoryRequestNonce !== undefined) setFileHistoryOpen(true);
  }, [fileHistoryRequestNonce]);
  useEffect(() => setFileHistoryOpen(false), [file, root]);
  const [formatRequestNonce, setFormatRequestNonce] = useState(0);
  const [gitGutterRefreshNonce, setGitGutterRefreshNonce] = useState(0);
  const [gitGutterPeek, setGitGutterPeek] = useState<EditorGitGutterPeek | null>(null);
  // GEN-UI-INTERACTION-003: the Save toolbar button stays in the tab order with
  // aria-disabled (not native disabled) and guard their onClick internally, so activating one while
  // unavailable is a silent no-op. This holds a brief spoken reason surfaced in the polite live region
  // below so keyboard/screen-reader users learn why nothing happened.
  const [toolbarNotice, setToolbarNotice] = useState("");
  const [mergeConflicts, setMergeConflicts] = useState({ count: 0, truncated: false });
  useEffect(() => setMergeConflicts({ count: 0, truncated: false }), [file]);
  // Resolve the repository root for invalidation events, including editors opened in subfolders.
  const [workspaceGitSummary, setWorkspaceGitSummary] = useState<WorkspaceGitSummary | null>(null);
  useEffect(() => {
    setWorkspaceGitSummary((current): WorkspaceGitSummary | null =>
      current?.requestedRoot === root ? current : null,
    );
    if (root === undefined) {
      return;
    }
    let cancelled = false;
    fetchGitStatus(root)
      .then((status) => {
        if (!cancelled) {
          setWorkspaceGitSummary(
            status.available
              ? {
                  requestedRoot: root,
                  repositoryRoot: status.repositoryRoot ?? status.root,
                }
              : null,
          );
        }
      })
      .catch(() => {
        if (!cancelled) setWorkspaceGitSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [root, gitGutterRefreshNonce]);
  const activeWorkspaceGitSummary =
    workspaceGitSummary?.requestedRoot === root ? workspaceGitSummary : null;
  const workspaceGitRepositoryRoot = activeWorkspaceGitSummary?.repositoryRoot ?? null;
  useEffect((): (() => void) | undefined => {
    if (root === undefined) return undefined;
    const onRepositoryStateInvalidated = (event: Event): void => {
      const invalidatedRoots = gitRepositoryStateInvalidationRoots(event);
      const matchesEditorRepository = invalidatedRoots.some(
        (invalidatedRoot): boolean =>
          invalidatedRoot === root ||
          (workspaceGitRepositoryRoot !== null && invalidatedRoot === workspaceGitRepositoryRoot),
      );
      if (!matchesEditorRepository) return;
      setGitGutterRefreshNonce((value): number => value + 1);
    };
    window.addEventListener(GIT_REPOSITORY_STATE_INVALIDATED_EVENT, onRepositoryStateInvalidated);
    return (): void =>
      window.removeEventListener(
        GIT_REPOSITORY_STATE_INVALIDATED_EVENT,
        onRepositoryStateInvalidated,
      );
  }, [root, workspaceGitRepositoryRoot]);
  // Issue #1202: the governed test-generation flow state (pure reducer owned by the editor package).
  // A monotonic sequence backs the cross-boundary request identity for stale-response discard.
  const [currentSelection, setCurrentSelection] = useState<EditorRange | null>(null);
  // Issue #1205: live cursor and diagnostic-count state backing the unified status bar.
  const [cursor, setCursor] = useState<EditorPosition | null>(null);
  const [callHierarchyRevealRequest, setCallHierarchyRevealRequest] = useState<
    { readonly id: string; readonly range: EditorRange } | undefined
  >(undefined);
  const callHierarchyRevealSeqRef = useRef(0);
  const [diagnosticsSummary, setDiagnosticsSummary] = useState<EditorDiagnosticsSummary | null>(
    null,
  );
  const [languageCapabilities, setLanguageCapabilities] =
    useState<LanguageServiceCapabilities | null>(BOOTSTRAP_LANGUAGE_CAPABILITIES);
  const [outlineSymbols, setOutlineSymbols] = useState<readonly EditorDocumentSymbol[]>([]);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const symbolCacheRef = useRef<SymbolCacheEntry | null>(null);
  const symbolSeqRef = useRef(0);
  const symbolRevealSeqRef = useRef(0);
  const [symbolRevealRequest, setSymbolRevealRequest] = useState<
    EditorOutlineRevealRequest | undefined
  >(undefined);
  const [confirmedCleanFiles, setConfirmedCleanFiles] = useState<{
    readonly root: string;
    readonly paths: readonly string[];
    readonly sequence: number;
  } | null>(null);
  const confirmBufferClean = useCallback((targetRoot: string, path: string): void => {
    setConfirmedCleanFiles((current) => ({
      root: targetRoot,
      paths: [path],
      sequence: (current?.sequence ?? 0) + 1,
    }));
  }, []);
  const [recoverySnapshot, setRecoverySnapshot] = useState<EditorHotExitSnapshotV1 | null>(null);
  // The on-disk content captured at the moment recovery was offered, so the compare view diffs the
  // recovered buffer against the disk file even if the live buffer is edited before Compare is opened.
  const [recoveryDiskBaseline, setRecoveryDiskBaseline] = useState<string | null>(null);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [recoveryCompare, setRecoveryCompare] = useState(false);
  const [externalChange, dispatchExternalChange] = useReducer(
    editorExternalChangeReducer,
    IDLE_EXTERNAL_CHANGE_STATE,
  );
  const [externalCompareBaseline, setExternalCompareBaseline] = useState<string | null>(null);
  const [activeContentDigest, setActiveContentDigest] = useState<ActiveContentDigest | null>(null);
  // Rename conflicts reuse the existing accessible conflict banner.
  const [editorConflict, setEditorConflict] = useState<{
    readonly code: AgentConflictCode;
    readonly message: string;
  } | null>(null);
  const [renameReview, setRenameReview] = useState<{
    readonly changeset: LanguageRenameChangeset;
    readonly model: PatchPreviewModel;
    // Snapshots of every non-active changeset file, captured at review time so Accept never depends
    // on the bounded LRU session cache surviving (a wide rename can touch far more files than the
    // cache capacity, so relying on the cache produced spurious "not loaded" conflicts — Issue #2105).
    readonly snapshots: Readonly<Record<string, EditorFileSessionSnapshot>>;
    // What the language service left out, or null when the changeset is the whole rename. Non-null
    // blocks Accept: renaming 2 of 400 files leaves every other reference on the old name.
    readonly truncation: PatchPreviewSourceTruncation | null;
  } | null>(null);
  const runRenameVerification = useCallback((): void => {
    const files = renameReview?.changeset.files.map((f) => f.path) ?? [];
    runScopedVerification(files);
  }, [renameReview, runScopedVerification]);
  const [activeHostEditRequest, setActiveHostEditRequest] = useState<
    EditorHostEditRequest | undefined
  >(undefined);
  // Bounded LRU (Issue 2.8): evict the least-recently-used snapshot on overflow, but never the active
  // file, a mid-save, or a dirty buffer — those are the background-tab save-correctness invariants.
  const activeSessionKeyRef = useRef<string | null>(null);
  const sessionCacheRef = useRef(
    new LruSessionCache<EditorFileSessionSnapshot>(
      SESSION_CACHE_CAPACITY,
      (key, snapshot) =>
        key === activeSessionKeyRef.current ||
        snapshot.saveStatus === "saving" ||
        (snapshot.fileModel !== null && isDocumentDirty(snapshot.fileModel)),
    ),
  );
  activeSessionKeyRef.current = editorSessionKeyOrNull(root, file);

  // Refs the imperative save path reads so a Cmd/Ctrl+S immediately after an edit always persists
  // the latest values, independent of React state-batching timing. The version-aware
  // optimistic-concurrency token (Issue #1197) is the token the save sends to the BFF.
  const versionRef = useRef<EditorDocumentVersion | null>(null);
  versionRef.current = version;
  const workspaceWatchGeneration = useMemo<WorkspaceWatchReconciliationGeneration>(
    () => ({
      root,
      file,
      sessionKey: editorSessionKeyOrNull(root, file),
      documentVersion: version,
      editorVersion: fileModel?.identity.version ?? null,
    }),
    [file, fileModel?.identity.version, root, version],
  );
  const workspaceWatchGenerationRef = useRef(workspaceWatchGeneration);
  workspaceWatchGenerationRef.current = workspaceWatchGeneration;
  const savingRef = useRef(false);
  savingRef.current = saveStatus === "saving";
  const recentLocalWriteRef = useRef<RecentLocalWrite | null>(null);
  const pendingLocalSaveRef = useRef<PendingLocalSave | null>(null);
  const workspaceWatchReconciliationRef = useRef<Promise<void>>(Promise.resolve());
  // The editor stays editable during a save; this ref lets the success handler tell whether the
  // buffer moved while the save was in flight so it never clobbers mid-flight edits.
  const contentRef = useRef("");
  contentRef.current = content;
  // Companion to `contentRef`: a restore has to be able to put the dirty-state bookkeeping back
  // exactly as it found it, not merely recompute a plausible one.
  const fileModelRef = useRef<EditorFileModel | null>(null);
  fileModelRef.current = fileModel;
  const formatOnSaveStateRef = useRef<FormatOnSaveState>({
    enabled: false,
    canFormat: false,
    document: null,
    file: undefined,
    root: undefined,
    tabSize: 2,
    insertSpaces: true,
  });
  const activeContentHash = activeDigestHash(activeContentDigest, content);
  const readyContentDigest = freshContentDigest(activeContentDigest, content);
  // PR #3289 review: content.length (UTF-16 code units) alone is only a LOWER bound on the UTF-8
  // byte length — 200,000 CJK characters is ~600 KB of UTF-8 but a length of 200,000 — so it must
  // never stand in for the byte count directly. Both estimates below are byte-exact whenever
  // readyContentDigest has settled for the CURRENT content; they diverge only for the pending
  // (unsettled) case, where the write gate needs a never-under UPPER bound and the behavioral
  // mode-selection gate needs a never-over LOWER bound instead (see the two functions' docs) — a
  // single shared conservative estimate fed BOTH gates fails one of them. Neither may feed
  // sha256HexBytes, which needs the exact, debounced activeContentDigest instead.
  const writeGateSizeBytes = writeGateSizeBytesEstimate(readyContentDigest, content);
  const modeSelectionSizeBytes = modeSelectionSizeBytesEstimate(readyContentDigest, content);
  const lastHotExitSnapshotKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setCurrentSelection(null);
    setCursor(null);
    setDiagnosticsSummary(null);
    setOutlineSymbols([]);
    setOutlineLoading(false);
    setSymbolRevealRequest(undefined);
    symbolCacheRef.current = null;
    // Switching the active file leaves any per-file recovery-compare view or pending reload
    // confirmation; both are scoped to the file that opened them.
    setRecoveryCompare(false);
    setReloadConfirm(false);
    setRecoveryDiskBaseline(null);
    setExternalCompareBaseline(null);
    dispatchExternalChange({ type: "reloadSucceeded" });
    setRenameReview(null);
  }, [file, root]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      // KEIKO-0819: the full-buffer UTF-8 encode happens here, at most once per settled debounce
      // window, not once per keystroke — the resulting byte count rides along with the hash so every
      // byte-exact consumer (hot-exit maxBytes check, the buffer's reported sizeBytes) reads it back
      // from activeContentDigest instead of re-encoding.
      const bytes = UTF8_ENCODER.encode(content);
      void sha256HexBytes(bytes, content).then((hash) => {
        if (!cancelled) setActiveContentDigest({ content, hash, sizeBytes: bytes.length });
      });
    }, CONTENT_HASH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [content]);

  useEffect(() => {
    let cancelled = false;
    void fetchEditorLanguageCapabilities(root)
      .then((capabilities) => {
        if (!cancelled) setLanguageCapabilities(capabilities);
      })
      .catch(() => {
        // Keep the bootstrap TS/JS capability rather than breaking the editor toolbar on a transient
        // capability-route failure. Operation calls still go through the governed BFF and degrade
        // independently if unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  useEffect(() => () => {}, []);

  const currentDocumentUri = editorDocumentUriOrNull(root, file, editorModelScope);
  const fileModelMatchesTarget = modelMatchesDocument(fileModel, currentDocumentUri);
  const dirty = fileModelMatchesTarget && modelDirty(fileModel);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const lastDirtyNotificationRef = useRef<{
    readonly file: string;
    readonly dirty: boolean;
  } | null>(null);
  useEffect(() => {
    if (file === undefined || file.length === 0) return;
    const lastNotification = lastDirtyNotificationRef.current;
    if (lastNotification?.file === file && lastNotification.dirty === dirty) return;
    lastDirtyNotificationRef.current = { file, dirty };
    onDirtyChange?.(file, dirty);
  }, [dirty, file, onDirtyChange]);
  useEffect(() => {
    dispatchExternalChange({ type: "dirtyChanged", dirty });
  }, [dirty]);
  const resolveLocalWriteOrigin = useCallback(
    async (
      localWrite: RecentLocalWrite | null,
      event: EditorM7WatchEvent,
      generation: WorkspaceWatchReconciliationGeneration,
      contentAtStart: string,
    ): Promise<"abort" | { readonly originatedByKeiko: boolean }> => {
      if (localWrite === null) return { originatedByKeiko: false };
      if (Date.now() > localWrite.expiresAt) {
        recentLocalWriteRef.current = null;
        return { originatedByKeiko: false };
      }
      if (!localWriteTargetsEvent(localWrite, event, generation.sessionKey)) {
        return { originatedByKeiko: false };
      }
      const expectedMetadata = eventMatchesSavedMetadata(event, localWrite.expectedVersion);
      if (localWrite.externalChangeObserved && expectedMetadata) {
        // A genuine external event already surfaced while this marker was pending. A later event
        // carrying the exact saved metadata is the delayed self notification. It is a no-op: a
        // self-originated reducer transition would clear the genuine warning that is already
        // visible, violating ADR-0133 D3.
        recentLocalWriteRef.current = null;
        return "abort";
      }
      if (!expectedMetadata || root === undefined) {
        // A path/time match is provenance only. Different metadata is a real external change and
        // cannot consume the saved-version marker.
        recentLocalWriteRef.current = { ...localWrite, externalChangeObserved: true };
        return { originatedByKeiko: false };
      }
      let originatedByKeiko = false;
      try {
        const current = await fetchFilesContent(root, localWrite.path);
        originatedByKeiko =
          current.session.version.sizeBytes === localWrite.expectedVersion.sizeBytes &&
          current.session.version.modifiedAt === localWrite.expectedVersion.modifiedAt &&
          current.session.version.contentHash === localWrite.expectedVersion.contentHash;
      } catch {
        originatedByKeiko = false;
      }
      if (
        workspaceWatchGenerationRef.current !== generation ||
        contentRef.current !== contentAtStart ||
        recentLocalWriteRef.current !== localWrite
      ) {
        return "abort";
      }
      recentLocalWriteRef.current = originatedByKeiko
        ? null
        : { ...localWrite, externalChangeObserved: true };
      return { originatedByKeiko };
    },
    [root],
  );
  const reconcileWorkspaceWatchEvent = useCallback(
    async (event: EditorM7WatchEvent): Promise<void> => {
      const pendingSave = pendingLocalSaveRef.current;
      if (
        pendingSave?.sessionKey === editorSessionKeyOrNull(root, file) &&
        workspaceWatchEventTouchesPath(event, file)
      ) {
        // The watcher can beat the save response. Classify against its acknowledged version,
        // including the existing metadata and content-hash proof, after this save settles.
        await pendingSave.settled;
      }
      const generation = workspaceWatchGenerationRef.current;
      if (generation.root !== root || generation.file !== file) return;
      const contentAtStart = contentRef.current;
      if (root !== undefined && file !== undefined && workspaceWatchEventTouchesPath(event, file)) {
        setGitGutterPeek(null);
        setGitGutterRefreshNonce((value) => value + 1);
        setDiagnosticsSummary(null);
        removePaneDiagnostics(root, diagnosticsProducerId, file);
        symbolCacheRef.current = null;
        setOutlineSymbols([]);
      }
      const localWrite = recentLocalWriteRef.current;
      const originResult = await resolveLocalWriteOrigin(
        localWrite,
        event,
        generation,
        contentAtStart,
      );
      if (originResult === "abort") return;
      dispatchExternalChange({
        type: "observed",
        event,
        activePath: file,
        dirty: dirtyRef.current,
        saving: savingRef.current,
        originatedByKeiko: originResult.originatedByKeiko,
      });
    },
    [diagnosticsProducerId, file, resolveLocalWriteOrigin, root],
  );
  const handleWorkspaceWatchEvent = useCallback(
    (event: EditorM7WatchEvent): void => {
      workspaceWatchReconciliationRef.current = workspaceWatchReconciliationRef.current.then(
        () => reconcileWorkspaceWatchEvent(event),
        () => reconcileWorkspaceWatchEvent(event),
      );
    },
    [reconcileWorkspaceWatchEvent],
  );
  const workspaceWatch = useWorkspaceWatch(root, handleWorkspaceWatchEvent);
  const gitReconciliationSequenceRef = useRef(0);
  useEffect(() => {
    if (!hasTarget || root === undefined || file === undefined || !fileModelMatchesTarget) return;
    const snapshotKey = documentSessionKey(root, file);
    if (!dirty) {
      if (lastHotExitSnapshotKeyRef.current === snapshotKey) {
        lastHotExitSnapshotKeyRef.current = null;
        dropHotExitPersistenceFailure(deleteEditorHotExitSnapshot(root, file));
      }
      return;
    }
    // KEIKO-0819: readyContentDigest is null until the debounced hash/size effect above has settled
    // for this exact content, exactly as activeContentHash === null used to gate this write alone —
    // the size check below is byte-exact for the CURRENT content whenever it runs, never stale or
    // estimated, since content.length is never used here (see freshContentDigest).
    if (readyContentDigest === null) return;
    if (maxBytes !== null && readyContentDigest.sizeBytes > maxBytes) return;
    // KEIKO-0819: readyContentDigest.hash is byte-exact for the current content and non-null by
    // the guard above; activeContentHash is a wider `string | null` derived through activeDigestHash
    // and does not narrow across the guard, so read the hash off the settled digest object directly.
    const readyContentHash = readyContentDigest.hash;
    const flushHotExitSnapshot = (): void => {
      const snapshot: EditorHotExitSnapshotV1 = {
        schemaVersion: EDITOR_HOT_EXIT_SCHEMA_VERSION,
        workspaceRoot: root,
        relativePath: file,
        content,
        baseVersion: version,
        contentHash: readyContentHash,
        savedContentHash: version?.contentHash ?? null,
        updatedAt: Date.now(),
        paneId: paneId ?? "pane-1",
        windowId: windowId ?? "editor",
      };
      lastHotExitSnapshotKeyRef.current = snapshotKey;
      dropHotExitPersistenceFailure(writeEditorHotExitSnapshot(snapshot));
    };
    const timer = window.setTimeout(flushHotExitSnapshot, HOT_EXIT_WRITE_DEBOUNCE_MS);
    // KEIKO-0337: a graceful tab close/refresh fires `pagehide`, not the debounce timer above, so
    // the last <400ms of edits would otherwise never reach the hot-exit store. Clear the pending
    // timer and flush synchronously — fire-and-forget, since `writeEditorHotExitSnapshot` is
    // IndexedDB + async-hash based and pagehide handlers cannot await. `pagehide`, not
    // `beforeunload`, is the correct modern event: it never blocks navigation or triggers a
    // confirm-close prompt.
    const handlePageHide = (): void => {
      window.clearTimeout(timer);
      flushHotExitSnapshot();
    };
    window.addEventListener("pagehide", handlePageHide);
    return (): void => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [
    activeContentHash,
    content,
    dirty,
    file,
    fileModelMatchesTarget,
    hasTarget,
    maxBytes,
    paneId,
    readyContentDigest,
    root,
    version,
    windowId,
  ]);
  useEffect(() => {
    if (
      !hasTarget ||
      root === undefined ||
      file === undefined ||
      root.length === 0 ||
      file.length === 0 ||
      !fileModelMatchesTarget
    ) {
      return;
    }
    sessionCacheRef.current.set(documentSessionKey(root, file), {
      content,
      fileModel,
      modifiedAt,
      version,
      maxBytes,
      loadState,
      loadCorrelationId,
      loadRetryable,
      saveStatus,
      saveError,
      cursor,
      currentSelection,
      diagnosticsSummary,
      ...(localHistoryProtection === undefined ? {} : { localHistoryProtection }),
    });
  }, [
    content,
    currentSelection,
    cursor,
    diagnosticsSummary,
    file,
    fileModel,
    fileModelMatchesTarget,
    hasTarget,
    loadState,
    loadCorrelationId,
    loadRetryable,
    localHistoryProtection,
    maxBytes,
    modifiedAt,
    root,
    saveError,
    saveStatus,
    version,
  ]);
  // Follow the live app appearance (light/dark/high-contrast). Keyed onto the surface below so a
  // theme switch remounts it, which re-runs the editor's on-mount theme registration against the
  // now-current design tokens — the editor registers only its mount-time variant.
  const themeVariant = useEditorThemeVariant();

  const clearLoadedTarget = useCallback((): void => {
    setContent("");
    setFileModel(null);
    setModifiedAt(null);
    setVersion(null);
    setMaxBytes(null);
    setLoadState({ status: "ready" });
    setLoadCorrelationId(undefined);
    setLoadRetryable(true);
    setSaveStatus("idle");
    setSaveError(undefined);
    setLocalHistoryProtection(undefined);
  }, []);

  const restoreLoadedSession = useCallback((cached: EditorFileSessionSnapshot): void => {
    setContent(cached.content);
    setFileModel(cached.fileModel);
    setModifiedAt(cached.modifiedAt);
    setVersion(cached.version);
    setMaxBytes(cached.maxBytes);
    setLoadState(cached.loadState);
    setLoadCorrelationId(cached.loadCorrelationId);
    setLoadRetryable(cached.loadRetryable ?? true);
    setSaveStatus(cached.saveStatus);
    setSaveError(cached.saveError);
    setLocalHistoryProtection(cached.localHistoryProtection);
    setCursor(cached.cursor);
    setCurrentSelection(cached.currentSelection);
    setDiagnosticsSummary(cached.diagnosticsSummary);
  }, []);

  const beginLoad = useCallback((): void => {
    setLoadState({ status: "loading" });
    setLoadCorrelationId(undefined);
    setLoadRetryable(true);
    setSaveStatus("idle");
    setSaveError(undefined);
    setLocalHistoryProtection(undefined);
  }, []);

  const reconcilePreservedDirtyBuffer = useCallback(
    (response: FilesContentResponse, requestedFile: string): void => {
      if (versionRef.current?.contentHash === response.session.version.contentHash) return;
      gitReconciliationSequenceRef.current += 1;
      setExternalCompareBaseline(response.content);
      dispatchExternalChange({
        type: "observed",
        event: {
          schemaVersion: "1",
          sequence: gitReconciliationSequenceRef.current,
          kind: "changed",
          relativePath: requestedFile,
          sizeBytes: response.session.version.sizeBytes,
          modifiedAt: response.session.version.modifiedAt,
          metadataHash: response.session.version.contentHash,
        },
        activePath: requestedFile,
        dirty: true,
        saving: savingRef.current,
        originatedByKeiko: false,
      });
    },
    [],
  );

  const finishLoad = useCallback(
    (
      requestedRoot: string,
      requestedFile: string,
      response: FilesContentResponse,
      snapshot: EditorHotExitSnapshotV1 | null,
    ): void => {
      const identity: EditorDocumentIdentity = {
        uri: documentUri(requestedRoot, requestedFile, editorModelScope),
        language: inferEditorLanguage(requestedFile),
        version: 0,
      };
      setContent(response.content);
      setFileModel(createFileModel(identity));
      setModifiedAt(response.modifiedAt);
      setVersion(response.session.version);
      setMaxBytes(response.maxBytes);
      setLocalHistoryProtection(response.localHistoryProtection);
      setLoadState({ status: "ready" });
      setExternalCompareBaseline(null);
      dispatchExternalChange({ type: "reloadSucceeded" });
      const recoverable = snapshot !== null && snapshot.content !== response.content;
      setRecoverySnapshot(recoverable ? snapshot : null);
      setRecoveryDiskBaseline(recoverable ? response.content : null);
    },
    [editorModelScope],
  );

  const load = useCallback(
    async (
      signal: { cancelled: boolean },
      options: { bypassCache?: boolean; preserveDirty?: boolean } = {},
    ): Promise<void> => {
      if (!hasTarget) {
        clearLoadedTarget();
        return;
      }
      const sessionKey = documentSessionKey(root, file);
      const cached =
        options.bypassCache === true ? undefined : sessionCacheRef.current.get(sessionKey);
      if (cached !== undefined) {
        restoreLoadedSession(cached);
        return;
      }
      if (options.preserveDirty !== true || !dirtyRef.current) {
        beginLoad();
      }
      const requestCorrelationId = newClientCorrelationId();
      try {
        const response = await fetchFilesContent(root, file, requestCorrelationId);
        if (signal.cancelled) return;
        const snapshot = await readEditorHotExitSnapshot(root, file);
        if (signal.cancelled) return;
        if (options.preserveDirty === true && dirtyRef.current) {
          reconcilePreservedDirtyBuffer(response, file);
          return;
        }
        finishLoad(root, file, response, snapshot);
      } catch (err: unknown) {
        if (signal.cancelled) return;
        const correlationId = correlationIdOf(err) ?? requestCorrelationId;
        const failureState = editorLoadFailureState(err);
        const retryable = retryableEditorLoadError(err);
        setLoadCorrelationId(correlationId);
        setLoadRetryable(retryable);
        setLoadState(failureState);
        sessionCacheRef.current.set(
          sessionKey,
          failedEditorSessionSnapshot(failureState, correlationId, retryable),
        );
        reportClientDiagnostic(`[keiko] editor file load failed: ${clientErrorSummary(err)}`, {
          correlationId,
          errorKind: bffRequestErrorKind(err),
          errorEvidence: clientErrorEvidence(err),
        });
        throw err;
      }
    },
    [
      beginLoad,
      clearLoadedTarget,
      file,
      finishLoad,
      hasTarget,
      reconcilePreservedDirtyBuffer,
      restoreLoadedSession,
      root,
    ],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal).catch(() => undefined);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  const reload = useCallback((): void => {
    const signal = { cancelled: false };
    void load(signal, { bypassCache: true }).catch(() => undefined);
  }, [load]);

  useEffect((): (() => void) => {
    const activeSignals = new Set<{ cancelled: boolean }>();
    const onReconciliationRequest = (event: Event): void => {
      const detail = editorBufferReconciliationRequestDetail(event);
      if (detail === null || root === undefined || detail.root !== root) return;
      const signal = { cancelled: false };
      activeSignals.add(signal);
      const reconciliation = load(signal, { bypassCache: true, preserveDirty: true }).finally(() =>
        activeSignals.delete(signal),
      );
      detail.register(reconciliation);
    };
    window.addEventListener(EDITOR_BUFFER_RECONCILIATION_REQUEST_EVENT, onReconciliationRequest);
    return (): void => {
      window.removeEventListener(
        EDITOR_BUFFER_RECONCILIATION_REQUEST_EVENT,
        onReconciliationRequest,
      );
      for (const signal of activeSignals) signal.cancelled = true;
    };
  }, [load, root]);

  // D1/AC1: reloading from disk over a dirty buffer is a destructive discard of unsaved edits, so it
  // must route through the editor's explicit "reload-file" dirty-close policy — a modal acknowledgement
  // that reuses the same dialog surface as the close flows — instead of overwriting the buffer outright.
  // A clean buffer has nothing to lose and reloads immediately.
  const requestReload = useCallback((): void => {
    if (dirtyRef.current) {
      setReloadConfirm(true);
      return;
    }
    reload();
  }, [reload]);

  // ADR-0133 D3: clean buffers may reload only per the effective externalReload setting.
  // "cleanChanged" is only ever dispatched for a non-dirty, non-saving buffer (statusForObserved),
  // so reloading here can never discard unsaved edits — dirty buffers stay on "prompt" regardless.
  const externalReloadPolicy = editorSettings.applied.externalReload;
  useEffect(() => {
    if (externalReloadPolicy === "autoClean" && externalChange.status === "cleanChanged") {
      reload();
    }
  }, [externalChange.sequence, externalChange.status, externalReloadPolicy, reload]);

  const confirmReloadDiscard = useCallback((): void => {
    setReloadConfirm(false);
    setExternalCompareBaseline(null);
    dispatchExternalChange({ type: "reloadStarted" });
    // The user chose to discard the unsaved buffer for the on-disk version, so the hot-exit snapshot
    // holding those edits must go too — otherwise the reload would immediately re-offer them as a
    // recovery. Serialized store mutations keep this delete ordered ahead of the reload's snapshot read.
    if (root !== undefined && file !== undefined) {
      confirmBufferClean(root, file);
      dropHotExitPersistenceFailure(deleteEditorHotExitSnapshot(root, file));
    }
    reload();
  }, [confirmBufferClean, reload, root, file]);

  const cancelReloadDiscard = useCallback((): void => {
    setReloadConfirm(false);
  }, []);

  const reloadConfirmRef = useRef<HTMLDialogElement>(null);
  // GEN-UI-FOCUS-002: this destructive confirm declares `aria-modal="true"`, which promises assistive
  // technology that the rest of the shell is unavailable. Without containment a keyboard or
  // screen-reader user could Tab straight out of "Discard unsaved changes?" into the editor and the
  // window chrome behind it. Reuse the shared containment seam (the same one the gateway, editor
  // settings, and debugging confirms use) instead of re-deriving the wrap here; it is a no-op while
  // the dialog is unmounted because the ref is then null.
  useDialogTabTrap(reloadConfirmRef);
  useModalInteractionLock({
    active: reloadConfirm && sessionActive,
    initialFocusRef: reloadConfirmRef,
  });
  useEffect(() => {
    if (!reloadConfirm) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") cancelReloadDiscard();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [reloadConfirm, cancelReloadDiscard]);

  /** Abandon the save and state why. `null` is `persist`'s "nothing was written" signal. */
  const failFormatOnSave = useCallback((message: string): null => {
    setSaveError(message);
    setSaveStatus((status) => saveStatusReducer(status, { type: "failed" }));
    return null;
  }, []);

  const prepareFormatOnSave = useCallback(
    async (text: string): Promise<string | null> => {
      const state = formatOnSaveStateRef.current;
      if (!state.enabled) return text;
      if (
        !state.canFormat ||
        state.document === null ||
        state.root === undefined ||
        state.file === undefined
      ) {
        return text;
      }
      const baseVersion = versionRef.current;
      const request = {
        request: {
          requestId: createEditorRequestId(),
          streamId: "editor-format-on-save",
          sequence: Date.now(),
        },
        document: state.document,
        options: { tabSize: state.tabSize, insertSpaces: state.insertSpaces },
      };
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), FORMAT_ON_SAVE_DEADLINE_MS);
      try {
        const wire = await requestEditorFormatting(
          {
            root: state.root,
            path: state.file,
            languageId: state.document.language,
            text,
            options: request.options,
          },
          controller.signal,
        );
        if (contentRef.current !== text || versionRef.current !== baseVersion) {
          return failFormatOnSave(
            "Format-on-save stopped because the file changed while formatting.",
          );
        }
        // This path WRITES the result to disk, so the shared apply gate decides — a capped reformat
        // is refused rather than persisted as a finished format. The empty-edit case is inside the
        // gate's `apply` branch on purpose: an empty edit list is "already formatted" only when the
        // result also reports itself uncapped.
        const decision = formattingApplyDecision(
          mapWireToEditorFormattingResponse(request.request, wire),
        );
        if (decision.status === "refused") {
          return failFormatOnSave(FORMAT_ON_SAVE_CAPPED_MESSAGE);
        }
        return decision.edits.length === 0 ? text : applyTextEditsToText(text, decision.edits);
      } catch (error: unknown) {
        return failFormatOnSave(
          error instanceof DOMException && error.name === "AbortError"
            ? "Format-on-save timed out. Save again after formatting is available."
            : `Format-on-save failed: ${errorMessage(error)}`,
        );
      } finally {
        window.clearTimeout(timeout);
      }
    },
    [failFormatOnSave],
  );

  const markBufferEdited = useCallback((text: string): void => {
    contentRef.current = text;
    setContent(text);
    setFileModel((model: EditorFileModel | null) =>
      model === null ? model : editorFileModelReducer(model, { type: "edited", origin: "human" }),
    );
  }, []);

  const settleInactiveSave = useCallback(
    async (
      saveSessionKey: string,
      textToSave: string,
      response: Awaited<ReturnType<typeof saveFilesContent>>,
      targetRoot: string,
      targetFile: string,
    ): Promise<void> => {
      const cached = sessionCacheRef.current.get(saveSessionKey);
      const cachedContent = cached?.content ?? textToSave;
      const cachedFileModel = cached?.fileModel ?? null;
      sessionCacheRef.current.set(saveSessionKey, {
        content: cachedContent === textToSave ? response.content : cachedContent,
        fileModel:
          cachedFileModel === null
            ? cachedFileModel
            : editorFileModelReducer(cachedFileModel, {
                type: cachedContent === textToSave ? "saved" : "edited",
                origin: "human",
              }),
        modifiedAt: response.modifiedAt,
        version: response.session.version,
        maxBytes: response.maxBytes,
        loadState: cached?.loadState ?? { status: "ready" },
        saveStatus: cachedContent === textToSave ? "saved" : "idle",
        saveError: undefined,
        cursor: cached?.cursor ?? null,
        currentSelection: cached?.currentSelection ?? null,
        diagnosticsSummary: cached?.diagnosticsSummary ?? null,
        ...(response.localHistoryProtection === undefined
          ? {}
          : { localHistoryProtection: response.localHistoryProtection }),
      });
      if (cachedContent === textToSave) confirmBufferClean(targetRoot, targetFile);
      await deleteHotExitSnapshotBestEffort(targetRoot, targetFile);
    },
    [confirmBufferClean],
  );

  const settleActiveSave = useCallback(
    async (
      textToSave: string,
      response: Awaited<ReturnType<typeof saveFilesContent>>,
      targetRoot: string,
      targetFile: string,
    ): Promise<void> => {
      setModifiedAt(response.modifiedAt);
      setVersion(response.session.version);
      setMaxBytes(response.maxBytes);
      setLocalHistoryProtection(response.localHistoryProtection);
      if (contentRef.current === textToSave) {
        confirmBufferClean(targetRoot, targetFile);
        setContent(response.content);
        setFileModel((model: EditorFileModel | null) =>
          model === null ? model : editorFileModelReducer(model, { type: "saved" }),
        );
        setSaveStatus((status) => saveStatusReducer(status, { type: "succeeded" }));
      } else {
        setSaveStatus((status) =>
          saveStatusReducer(saveStatusReducer(status, { type: "succeeded" }), { type: "edited" }),
        );
      }
      await deleteHotExitSnapshotBestEffort(targetRoot, targetFile);
      setGitGutterRefreshNonce((value) => value + 1);
    },
    [confirmBufferClean],
  );

  const recordSaveFailure = useCallback(
    (error: unknown, saveSessionKey: string, attemptedSaveText: string): false => {
      if (activeSessionKeyRef.current !== saveSessionKey) {
        const cached = sessionCacheRef.current.get(saveSessionKey);
        const conflict = error instanceof ApiError && error.status === 409;
        sessionCacheRef.current.set(saveSessionKey, {
          content: cached?.content ?? attemptedSaveText,
          fileModel: cached?.fileModel ?? fileModel,
          modifiedAt: cached?.modifiedAt ?? modifiedAt,
          version: cached?.version ?? versionRef.current,
          maxBytes: cached?.maxBytes ?? maxBytes,
          loadState: cached?.loadState ?? { status: "ready" },
          saveStatus: conflict ? "conflict" : "error",
          saveError: conflict ? undefined : errorMessage(error),
          cursor: cached?.cursor ?? null,
          currentSelection: cached?.currentSelection ?? null,
          diagnosticsSummary: cached?.diagnosticsSummary ?? null,
          ...(cached?.localHistoryProtection === undefined
            ? {}
            : { localHistoryProtection: cached.localHistoryProtection }),
        });
        return false;
      }
      if (error instanceof ApiError && error.status === 409) {
        setSaveStatus((status) => saveStatusReducer(status, { type: "conflicted" }));
      } else {
        setSaveError(errorMessage(error));
        setSaveStatus((status) => saveStatusReducer(status, { type: "failed" }));
      }
      return false;
    },
    [fileModel, maxBytes, modifiedAt],
  );

  const persist = useCallback(
    async (
      text: string,
      historyOrigin?: "pre-restore",
      adoption?: BufferAdoptionSink,
    ): Promise<boolean> => {
      if (!hasTarget || savingRef.current) return false;
      const saveSessionKey = documentSessionKey(root, file);
      const textChangedBeforeReactCommitted = text !== contentRef.current;
      if (!dirtyRef.current && !textChangedBeforeReactCommitted) return true;
      // Format-on-save can adopt a SECOND, different text before the write, so a caller that has to
      // undo the adoption cannot assume the buffer holds what it passed in (#2617).
      const adopt = (next: string): void => {
        markBufferEdited(next);
        if (adoption !== undefined) adoption.text = next;
      };
      if (textChangedBeforeReactCommitted) adopt(text);
      savingRef.current = true;
      const pendingSave = pendingLocalSave(saveSessionKey);
      pendingLocalSaveRef.current = pendingSave;
      setSaveStatus((status) => saveStatusReducer(status, { type: "request" }));
      setSaveError(undefined);
      let attemptedSaveText = text;
      try {
        const preparedText = await prepareFormatOnSave(text);
        if (preparedText === null) return false;
        const textToSave = preparedText;
        attemptedSaveText = textToSave;
        if (textToSave !== contentRef.current) adopt(textToSave);
        const response = await saveFilesContent({
          root,
          path: file,
          content: textToSave,
          // Version-aware token (Issue #1197); supersedes the coarser mtime-only check.
          baseVersion: versionRef.current ?? undefined,
          ...(historyOrigin === undefined ? {} : { historyOrigin }),
        });
        recentLocalWriteRef.current = {
          sessionKey: saveSessionKey,
          path: file,
          expiresAt: Date.now() + 2_000,
          expectedVersion: response.session.version,
          externalChangeObserved: false,
        };
        notifyWorkspaceFileMutated(root, {
          kind: "changed",
          relativePath: file,
          provenance: "local",
          ...(workspaceGitRepositoryRoot === null
            ? {}
            : { repositoryRoot: workspaceGitRepositoryRoot }),
        });
        if (activeSessionKeyRef.current !== saveSessionKey) {
          await settleInactiveSave(saveSessionKey, textToSave, response, root, file);
          return true;
        }
        await settleActiveSave(textToSave, response, root, file);
        return true;
      } catch (err: unknown) {
        return recordSaveFailure(err, saveSessionKey, attemptedSaveText);
      } finally {
        savingRef.current = false;
        if (pendingLocalSaveRef.current === pendingSave) pendingLocalSaveRef.current = null;
        pendingSave.complete();
      }
    },
    [
      file,
      hasTarget,
      markBufferEdited,
      prepareFormatOnSave,
      recordSaveFailure,
      root,
      settleActiveSave,
      settleInactiveSave,
      workspaceGitRepositoryRoot,
    ],
  );

  // A restore is atomic from the buffer's point of view (#2617). `persist` adopts the text into the
  // buffer before the write so the save reconciles against it — correct for a save of the user's own
  // edits, but for a restore that text was never in the buffer, so every failure path would leave
  // the checkpoint content sitting there marked dirty while the history panel reports "not
  // restored". Roll the buffer back to the exact pre-restore state whenever no write landed; the
  // save error itself stays visible through saveStatus/saveError.
  const revertRestoredBuffer = useCallback((text: string, model: EditorFileModel | null): void => {
    contentRef.current = text;
    setContent(text);
    setFileModel(model);
  }, []);

  const restoreHistoryContent = useCallback(
    async (checkpointContent: string): Promise<boolean> => {
      if (dirtyRef.current) {
        setEditorConflict({
          code: "DIRTY",
          message: commonT("editor.fileHistory.dirtyConflict"),
        });
        return false;
      }
      const restoreSessionKey = editorSessionKeyOrNull(root, file);
      const bufferBeforeRestore = contentRef.current;
      const modelBeforeRestore = fileModelRef.current;
      const adoption: BufferAdoptionSink = { text: null };
      const restored = await persist(checkpointContent, "pre-restore", adoption);
      // Undo exactly the adoption this restore made — which is the formatted text, not the raw
      // checkpoint, once format-on-save transformed it. If the pane moved on (file switch, a later
      // edit) the buffer no longer holds that text, so the newer state is left alone.
      const sameDocument =
        restoreSessionKey !== null && activeSessionKeyRef.current === restoreSessionKey;
      const adopted = adoption.text;
      if (!restored && adopted !== null) {
        if (sameDocument && contentRef.current === adopted) {
          revertRestoredBuffer(bufferBeforeRestore, modelBeforeRestore);
        } else if (!sameDocument && restoreSessionKey !== null) {
          // The pane switching file does NOT discard the adopted text: an effect mirrors every
          // commit into sessionCacheRef, so the failed restore's content is still the cached state
          // of the document it was made against, and re-opening that file would show checkpoint
          // content the server never accepted. Undo it where the buffer now lives.
          //
          // The identity guard is the same conservative one the live path uses — only revert when
          // the cached content is exactly what this restore adopted. A background document cannot
          // be edited, so this cannot overwrite a newer legitimate state.
          const cached = sessionCacheRef.current.get(restoreSessionKey);
          // `adopted` is non-null inside this branch, so an absent cache entry compares unequal —
          // the optional chain keeps the explicit-undefined check's exact semantics (S6582).
          if (cached?.content === adopted) {
            sessionCacheRef.current.set(restoreSessionKey, {
              ...cached,
              content: bufferBeforeRestore,
              fileModel: modelBeforeRestore,
            });
          }
        }
      }
      return restored;
    },
    [commonT, file, persist, revertRestoredBuffer, root],
  );

  const onContentChange = useCallback(
    (next: EditorContentDelta, origin: EditorChangeOrigin): void => {
      setActiveHostEditRequest(undefined);
      contentRef.current = next.text;
      setContent(next.text);
      setFileModel((model: EditorFileModel | null) =>
        model === null ? model : editorFileModelReducer(model, { type: "edited", origin }),
      );
      setSaveStatus((status) => saveStatusReducer(status, { type: "edited" }));
    },
    [],
  );

  useEffect(() => {
    setActiveHostEditRequest(undefined);
  }, [file, root]);

  const onSaveRequested = useCallback(
    (request: EditorSaveRequest): void => {
      void persist(request.content.text);
    },
    [persist],
  );

  const handledExternalSaveRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      externalSaveRequest === undefined ||
      handledExternalSaveRef.current === externalSaveRequest.id ||
      file !== externalSaveRequest.file
    ) {
      return;
    }
    handledExternalSaveRef.current = externalSaveRequest.id;
    void persist(contentRef.current).then((ok) => {
      onExternalSaveComplete?.(
        externalSaveRequest.id,
        externalSaveRequest.paneId,
        externalSaveRequest.file,
        ok,
      );
    });
  }, [externalSaveRequest, file, onExternalSaveComplete, persist]);

  const onRuntimeError = useCallback((message: string): void => {
    // A non-fatal editor runtime notice: a code-owned sentence such as a theme-registration or a
    // language-load failure (keiko-editor runtime-notice.ts, EditorSurface, EditorDiffSurface). The
    // editor keeps working; the notice goes through the one client sink (0.3.0 audit, #2802), whose
    // server side admits exactly these closed shapes (F29).
    reportClientDiagnostic(`Keiko editor runtime notice: ${message}`);
  }, []);

  const restoreRecovery = useCallback((): void => {
    if (recoverySnapshot === null || fileModel === null) return;
    setContent(recoverySnapshot.content);
    setFileModel(editorFileModelReducer(fileModel, { type: "edited", origin: "human" }));
    setSaveStatus((status) => saveStatusReducer(status, { type: "edited" }));
    setRecoverySnapshot(null);
    setRecoveryDiskBaseline(null);
    setRecoveryCompare(false);
  }, [fileModel, recoverySnapshot]);

  const discardRecovery = useCallback((): void => {
    if (root !== undefined && file !== undefined) {
      confirmBufferClean(root, file);
      dropHotExitPersistenceFailure(deleteEditorHotExitSnapshot(root, file));
    }
    setRecoverySnapshot(null);
    setRecoveryDiskBaseline(null);
    setRecoveryCompare(false);
  }, [confirmBufferClean, file, root]);

  // AC4: surface an actual side-by-side comparison of the recovered buffer against the on-disk file
  // (reusing the editor's diff surface) rather than a prose notice, so the user can see exactly what
  // "Keep local" would restore before choosing.
  const compareRecovery = useCallback((): void => {
    setRecoveryCompare(true);
  }, []);

  // Opening the compare view replaces the editor surface, so move focus to its primary action.
  const recoveryCompareButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (recoveryCompare) recoveryCompareButtonRef.current?.focus();
  }, [recoveryCompare]);
  const externalCompareButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (externalChange.compareOpen) externalCompareButtonRef.current?.focus();
  }, [externalChange.compareOpen]);

  const closeRecoveryCompare = useCallback((): void => {
    setRecoveryCompare(false);
  }, []);

  // Issue #1199: the governed completion resolver. The Monaco bridge calls this with the live buffer
  // text and a content-free request; the host posts to `/api/editor/completion` and adapts the wire
  // response. A completion failure rejects here and the editor bridge renders nothing (AC4) — it
  // never breaks editing.
  const provideCompletions = useCallback<EditorCompletionResolver>(
    async (query: EditorCompletionQuery, signal: AbortSignal) => {
      if (!hasTarget || root === undefined || file === undefined) {
        return {
          request: query.request.request,
          items: [],
          isIncomplete: false,
          provenance: { sources: [], modelMode: "deterministic" },
        };
      }
      const wire = await requestEditorCompletion(
        {
          root,
          path: file,
          languageId: query.request.document.language,
          text: query.documentText,
          position: {
            line: query.request.position.line,
            character: query.request.position.column,
          },
          triggerKind: query.request.triggerKind,
          ...(query.request.triggerCharacter === undefined
            ? {}
            : { triggerCharacter: query.request.triggerCharacter }),
          contextBudgetBytes: query.request.contextBudgetBytes,
          context: completionContextSelectors({
            root,
            file,
            text: query.documentText,
            line: query.request.position.line,
            character: query.request.position.column,
            linkedRoot,
            linkedFilePath,
            linkedCapsuleIds,
            linkedCapsuleSetIds,
          }),
        },
        signal,
      );
      const response = mapWireToEditorCompletionResponse(query.request.request, wire, Date.now());
      const snippetItems = snippetCompletionItems({
        snapshot: workspaceSnippets.snapshot,
        languageId: query.request.document.language,
        relativePath: file,
        prefix: completionPrefixAt(
          query.documentText,
          query.request.position.line,
          query.request.position.column,
        ),
        insertionSafe: snippetInsertionSafeRef.current,
        signal,
      });
      const sources: readonly EditorCompletionSource[] = [
        ...new Set<EditorCompletionSource>(["workspace-snippet", ...response.provenance.sources]),
      ];
      return snippetItems.length === 0
        ? response
        : {
            ...response,
            items: [...snippetItems, ...response.items],
            provenance: {
              ...response.provenance,
              sources,
            },
          };
    },
    [
      file,
      hasTarget,
      linkedCapsuleIds,
      linkedCapsuleSetIds,
      linkedFilePath,
      linkedRoot,
      root,
      workspaceSnippets.snapshot,
    ],
  );

  // Issue #1200: the governed inline-completion (ghost-text) resolver. The Monaco inline bridge calls
  // this with the live buffer and a content-free request; the host posts to
  // `/api/editor/inline-completion` and adapts the wire response. A failure rejects here and the editor
  // bridge renders nothing (AC1) — it never breaks editing. The server is authoritative for the
  // policy/cost/rate gates and returns zero items when the feature is degraded or disabled.
  const provideInlineCompletions = useCallback<EditorInlineCompletionResolver>(
    async (query: EditorInlineCompletionQuery, signal: AbortSignal) => {
      if (!hasTarget || root === undefined || file === undefined) {
        return { request: query.request.request, items: [] };
      }
      const wire = await requestEditorInlineCompletion(
        {
          root,
          path: file,
          languageId: query.request.document.language,
          text: query.documentText,
          position: {
            line: query.request.position.line,
            character: query.request.position.column,
          },
          triggerKind: query.request.triggerKind,
          contextBudgetBytes: query.request.contextBudgetBytes,
          context: completionContextSelectors({
            root,
            file,
            text: query.documentText,
            line: query.request.position.line,
            character: query.request.position.column,
            linkedRoot,
            linkedFilePath,
            linkedCapsuleIds,
            linkedCapsuleSetIds,
          }),
        },
        signal,
      );
      return mapWireToEditorInlineCompletionResponse(
        query.request.request,
        query.request.position,
        wire,
        Date.now(),
      );
    },
    [file, hasTarget, linkedCapsuleIds, linkedCapsuleSetIds, linkedFilePath, linkedRoot, root],
  );

  // Issue #1200 (AC6): forward content-free acceptance/rejection counts to the governed telemetry
  // route. Best-effort and fire-and-forget; a telemetry failure must never affect editing.
  const onInlineCompletionTelemetry = useCallback(
    (snapshot: InlineCompletionTelemetrySnapshot): void => {
      if (!hasTarget || root === undefined) {
        return;
      }
      void reportEditorInlineCompletionTelemetry({ root, ...snapshot }).catch(() => {
        // Telemetry is best-effort; swallow transport errors.
      });
    },
    [hasTarget, root],
  );

  // Issue #1201: governed language-intelligence resolvers (diagnostics, hover, symbols, formatting).
  // Each bridges a Monaco surface to the deterministic `POST /api/editor/language` BFF (#1198) and
  // maps the wire result into the editor render contract. A failure rejects here and the editor bridge
  // degrades to nothing (no markers / no hover / no outline / no edits) — it never breaks editing.
  const provideDiagnostics = useCallback<EditorDiagnosticsResolver>(
    async (query: EditorDiagnosticsQuery, signal: AbortSignal) => {
      const provider = providerForLanguage(languageCapabilities, query.request.document.language);
      if (
        !hasTarget ||
        root === undefined ||
        file === undefined ||
        query.request.document.uri !== currentDocumentUri ||
        !providerOperationEnabled(provider, "diagnostics")
      ) {
        return { request: query.request.request, diagnostics: [] };
      }
      const wire = await requestEditorDiagnostics(
        { root, path: file, languageId: query.request.document.language, text: query.documentText },
        signal,
      );
      return mapWireToEditorDiagnosticsResponse(query.request.request, wire);
    },
    [currentDocumentUri, file, hasTarget, languageCapabilities, root],
  );

  const provideHover = useCallback<EditorHoverResolver>(
    async (query: EditorHoverQuery, signal: AbortSignal) => {
      const provider = providerForLanguage(languageCapabilities, query.request.document.language);
      if (
        !hasTarget ||
        root === undefined ||
        file === undefined ||
        query.request.document.uri !== currentDocumentUri ||
        !providerOperationEnabled(provider, "hover")
      ) {
        return { request: query.request.request, hover: { contents: null } };
      }
      const wire = await requestEditorHover(
        {
          root,
          path: file,
          languageId: query.request.document.language,
          text: query.documentText,
          position: {
            line: query.request.position.line,
            character: query.request.position.column,
          },
        },
        signal,
      );
      return mapWireToEditorHoverResponse(query.request.request, wire);
    },
    [currentDocumentUri, file, hasTarget, languageCapabilities, root],
  );

  const resolveEditorSymbols = useCallback(
    async (query: EditorSymbolsQuery, signal: AbortSignal): Promise<EditorSymbolsResponse> => {
      const request = query.request.request;
      const language = query.request.document.language;
      const provider = providerForLanguage(languageCapabilities, language);
      if (
        !hasTarget ||
        root === undefined ||
        file === undefined ||
        query.request.document.uri !== currentDocumentUri ||
        !providerOperationEnabled(provider, "symbols")
      ) {
        return { request, symbols: [] };
      }
      const cacheInput = { root, path: file, language, text: query.documentText };
      if (symbolCacheMatches(symbolCacheRef.current, cacheInput)) {
        return { request, symbols: symbolCacheRef.current.symbols };
      }
      const wire = await requestEditorSymbols(
        { root, path: file, languageId: language, text: query.documentText },
        signal,
      );
      const response = mapWireToEditorSymbolsResponse(request, wire);
      symbolCacheRef.current = { ...cacheInput, symbols: response.symbols };
      return response;
    },
    [currentDocumentUri, file, hasTarget, languageCapabilities, root],
  );

  const provideSymbols = useCallback<EditorSymbolsResolver>(
    async (query: EditorSymbolsQuery, signal: AbortSignal) => {
      const response = await resolveEditorSymbols(query, signal);
      if (query.documentText === contentRef.current && !signal.aborted) {
        setOutlineSymbols(response.symbols);
        setOutlineLoading(false);
      }
      return response;
    },
    [resolveEditorSymbols],
  );

  const provideFormatting = useCallback<EditorFormattingResolver>(
    async (query: EditorFormattingQuery, signal: AbortSignal) => {
      const provider = providerForLanguage(languageCapabilities, query.request.document.language);
      if (
        !hasTarget ||
        root === undefined ||
        file === undefined ||
        query.request.document.uri !== currentDocumentUri ||
        !providerOperationEnabled(provider, "formatting")
      ) {
        return { request: query.request.request, edits: [] };
      }
      const wire = await requestEditorFormatting(
        {
          root,
          path: file,
          languageId: query.request.document.language,
          text: query.documentText,
          options: {
            tabSize: editorSettings.applied.tabSize,
            insertSpaces: editorSettings.applied.insertSpaces,
          },
        },
        signal,
      );
      return mapWireToEditorFormattingResponse(query.request.request, wire);
    },
    [
      currentDocumentUri,
      editorSettings.applied.insertSpaces,
      editorSettings.applied.tabSize,
      file,
      hasTarget,
      languageCapabilities,
      root,
    ],
  );

  const provideDefinition = useCallback<EditorDefinitionResolver>(
    async (query: EditorDefinitionQuery, signal: AbortSignal) => {
      if (!hasTarget || root === undefined || file === undefined) {
        return { request: query.request.request, locations: [] };
      }
      const wire = await requestEditorDefinition(
        {
          root,
          path: file,
          languageId: query.request.document.language,
          text: query.documentText,
          position: {
            line: query.request.position.line,
            character: query.request.position.column,
          },
        },
        signal,
      );
      const response = mapWireToEditorDefinitionResponse(query.request.request, wire);
      const crossFile = response.locations.find((location) => location.path !== file);
      if (crossFile !== undefined) {
        openCrossFileLocation({ root, file, location: crossFile, openEditorFile });
      }
      return response;
    },
    [file, hasTarget, openEditorFile, root],
  );

  const provideTypeDefinition = useCallback<EditorDefinitionResolver>(
    async (query: EditorDefinitionQuery, signal: AbortSignal) => {
      if (!hasTarget || root === undefined || file === undefined) {
        return { request: query.request.request, locations: [] };
      }
      const wire = await requestEditorTypeDefinition(
        {
          root,
          path: file,
          languageId: query.request.document.language,
          text: query.documentText,
          position: {
            line: query.request.position.line,
            character: query.request.position.column,
          },
        },
        signal,
      );
      const response = mapWireToEditorDefinitionResponse(query.request.request, wire);
      const crossFile = response.locations.find((location) => location.path !== file);
      if (crossFile !== undefined) {
        openCrossFileLocation({ root, file, location: crossFile, openEditorFile });
      }
      return response;
    },
    [file, hasTarget, openEditorFile, root],
  );

  const provideImplementation = useCallback<EditorDefinitionResolver>(
    async (query: EditorDefinitionQuery, signal: AbortSignal) => {
      if (!hasTarget || root === undefined || file === undefined) {
        return { request: query.request.request, locations: [] };
      }
      const wire = await requestEditorImplementation(
        {
          root,
          path: file,
          languageId: query.request.document.language,
          text: query.documentText,
          position: {
            line: query.request.position.line,
            character: query.request.position.column,
          },
        },
        signal,
      );
      const response = mapWireToEditorDefinitionResponse(query.request.request, wire);
      const crossFile = response.locations.find((location) => location.path !== file);
      if (crossFile !== undefined) {
        openCrossFileLocation({ root, file, location: crossFile, openEditorFile });
      }
      return response;
    },
    [file, hasTarget, openEditorFile, root],
  );

  const provideCallHierarchy = useCallback<EditorCallHierarchyResolver>(
    async (query: EditorCallHierarchyQuery, signal: AbortSignal) => {
      if (!hasTarget || root === undefined || file === undefined) {
        return { request: query.request.request, roots: [] };
      }
      const wire = await requestEditorCallHierarchy(
        {
          root,
          path: file,
          languageId: query.request.document.language,
          text: query.documentText,
          position: {
            line: query.request.position.line,
            character: query.request.position.column,
          },
        },
        signal,
      );
      return mapWireToEditorCallHierarchyResponse(query.request.request, wire);
    },
    [file, hasTarget, root],
  );

  const provideInlayHints = useCallback<EditorInlayHintsResolver>(
    async (query: EditorInlayHintsQuery, signal: AbortSignal) => {
      if (!hasTarget || root === undefined || file === undefined) {
        return { request: query.request.request, hints: [] };
      }
      const wire = await requestEditorInlayHints(
        {
          root,
          path: file,
          languageId: query.request.document.language,
          text: query.documentText,
          range: editorRangeToWire(query.request.range),
        },
        signal,
      );
      return mapWireToEditorInlayHintsResponse(query.request.request, wire);
    },
    [file, hasTarget, root],
  );

  const provideSemanticTokens = useCallback<EditorSemanticTokensResolver>(
    async (query: EditorSemanticTokensQuery, signal: AbortSignal) => {
      if (
        !hasTarget ||
        root === undefined ||
        file === undefined ||
        query.request.document.language !== "rust"
      ) {
        return null;
      }
      const response = await requestEditorSemanticTokens(
        {
          root,
          path: file,
          text: query.documentText,
          version: query.request.document.version,
        },
        signal,
      );
      if (
        !response.supported ||
        response.legend === undefined ||
        response.data === undefined ||
        !semanticLegendMatches(response.legend)
      ) {
        return null;
      }
      return response.data;
    },
    [file, hasTarget, root],
  );

  const revealCallHierarchyLocation = useCallback(
    (location: EditorLocation): void => {
      if (location.path === file) {
        callHierarchyRevealSeqRef.current += 1;
        setCallHierarchyRevealRequest({
          id: `call-hierarchy:${String(callHierarchyRevealSeqRef.current)}`,
          range: location.range,
        });
        return;
      }
      openCrossFileLocation({ root, file, location, openEditorFile });
    },
    [file, openEditorFile, root],
  );

  const provideReferences = useCallback<EditorReferencesResolver>(
    async (query: EditorReferencesQuery, signal: AbortSignal) => {
      if (!hasTarget || root === undefined || file === undefined) {
        return { request: query.request.request, locations: [], includesDeclaration: false };
      }
      const wire = await requestEditorReferences(
        {
          root,
          path: file,
          languageId: query.request.document.language,
          text: query.documentText,
          position: {
            line: query.request.position.line,
            character: query.request.position.column,
          },
        },
        signal,
      );
      const response = mapWireToEditorReferencesResponse(query.request.request, wire);
      const crossFile = response.locations.find((location) => location.path !== file);
      if (
        crossFile !== undefined &&
        !locationIsOpen({ path: crossFile.path, file, openFiles, layoutPanes })
      ) {
        openCrossFileLocation({ root, file, location: crossFile, openEditorFile });
      }
      return response;
    },
    [file, hasTarget, layoutPanes, openEditorFile, openFiles, root],
  );

  const provideCodeActions = useCallback<EditorCodeActionsResolver>(
    async (query: EditorCodeActionsQuery, signal: AbortSignal) => {
      if (!hasTarget || root === undefined || file === undefined) {
        return { request: query.request.request, actions: [] };
      }
      const wire = await requestEditorCodeActions(
        {
          root,
          path: file,
          languageId: query.request.document.language,
          text: query.documentText,
          range: editorRangeToWire(query.request.range),
          diagnostics: query.request.diagnostics.map(editorDiagnosticToWire),
        },
        signal,
      );
      return mapWireToEditorCodeActionsResponse(query.request.request, wire);
    },
    [file, hasTarget, root],
  );

  const provideSignatureHelp = useCallback<EditorSignatureHelpResolver>(
    async (query: EditorSignatureHelpQuery, signal: AbortSignal) => {
      if (!hasTarget || root === undefined || file === undefined) {
        return {
          request: query.request.request,
          signatures: [],
          activeSignature: null,
          activeParameter: null,
        };
      }
      const wire = await requestEditorSignatureHelp(
        {
          root,
          path: file,
          languageId: query.request.document.language,
          text: query.documentText,
          position: {
            line: query.request.position.line,
            character: query.request.position.column,
          },
        },
        signal,
      );
      return mapWireToEditorSignatureHelpResponse(query.request.request, wire);
    },
    [file, hasTarget, root],
  );

  const largeFileMode = useMemo(
    () => deriveLargeFileMode({ sizeBytes: modeSelectionSizeBytes, text: content }),
    [content, modeSelectionSizeBytes],
  );
  const preferenceLargeFileMode = editorSettings.applied.largeFileMode;
  const largeFilePolicy = largeFileSettings(largeFileMode, preferenceLargeFileMode);
  const largeFileDegraded = largeFilePolicy.degraded;
  const editorReadOnlyBySettings = largeFilePolicy.readOnly;
  useEffect(() => {
    if (!largeFileDegraded) return;
    setMergeConflicts((current) =>
      current.count === 0 && !current.truncated ? current : { count: 0, truncated: false },
    );
  }, [largeFileDegraded]);
  const editorConflicts = useMemo<EditorSurfaceProps["editorConflicts"]>(() => {
    if (largeFileDegraded) return undefined;
    return {
      labels: {
        next: sourceControlT("conflicts.next"),
        previous: sourceControlT("conflicts.previous"),
        ours: sourceControlT("conflicts.ours"),
        theirs: sourceControlT("conflicts.theirs"),
        both: sourceControlT("conflicts.both"),
      },
      onChange: (count, truncated) => setMergeConflicts({ count, truncated }),
      onStale: () => setToolbarNotice(sourceControlT("conflicts.stale")),
    };
  }, [largeFileDegraded, sourceControlT]);
  const editorGitGutter = useMemo<EditorGitGutterHost | undefined>(() => {
    if (root === undefined || file === undefined || largeFileDegraded) return undefined;
    return {
      labels: {
        staged: sourceControlT("gitGutter.staged"),
        unstaged: sourceControlT("gitGutter.unstaged"),
        added: sourceControlT("gitGutter.added"),
        modified: sourceControlT("gitGutter.modified"),
        deleted: sourceControlT("gitGutter.deleted"),
        openHunk: sourceControlT("gitGutter.openHunk"),
      },
      // #2906 review (comment 3865167732): the resolver used to ignore the AbortSignal
      // git-gutter-bridge.ts passes into it, so a superseded refresh (or dispose) left both
      // in-flight requests running to completion underneath the discarded result. Both hops now
      // carry the SAME signal the bridge gave this call.
      resolve: async (signal) => {
        const [staged, unstaged] = await Promise.all([
          fetchGitStructuredDiff({ root, path: file, scope: "staged" }, signal),
          fetchGitStructuredDiff({ root, path: file, scope: "unstaged" }, signal),
        ]);
        return {
          staged: hunksForPath(staged, file),
          unstaged: hunksForPath(unstaged, file),
        };
      },
      onPeek: setGitGutterPeek,
    };
  }, [file, largeFileDegraded, root, sourceControlT]);
  const editorBlame = useMemo<EditorBlameHost | undefined>(() => {
    if (
      root === undefined ||
      file === undefined ||
      largeFileDegraded ||
      onOpenGitCommit === undefined
    ) {
      return undefined;
    }
    const sessionKey = documentSessionKey(root, file);
    return {
      labels: {
        toggle: sourceControlT("blame.toggle"),
        openCommit: sourceControlT("blame.openCommit"),
        dirtyNotice: sourceControlT("blame.dirtyNotice"),
        truncated: sourceControlT("blame.truncated"),
      },
      describe: (line: GitEditorBlameLine, age: string) =>
        sourceControlT("blame.line", {
          author: line.author,
          age,
          commit: line.commitHash.slice(0, 8),
        }),
      formatAge: (authorTime: string) => relativeAge(locale, authorTime),
      resolve: async () => {
        const response = await fetchGitBlame({
          root,
          path: file,
          startLine: 1,
          maxLines: GIT_EDITOR_BLAME_MAX_LINES,
        });
        return activeSessionKeyRef.current === sessionKey && response.path === file
          ? response
          : null;
      },
      onCommit: (commitHash: string) => onOpenGitCommit(root, commitHash),
    };
  }, [file, largeFileDegraded, locale, onOpenGitCommit, root, sourceControlT]);

  useEffect(() => {
    setGitGutterPeek(null);
  }, [file, root]);
  const applyWorkspaceReplaceBuffer = useCallback(
    (request: WorkspaceReplaceApplyFile): WorkspaceReplaceOpenBufferResult => {
      if (file === undefined || request.path !== file || !fileModelMatchesTarget) {
        return { status: "not-open" as const };
      }
      if (largeFileDegraded) {
        return {
          status: "conflict" as const,
          conflict: {
            path: request.path,
            reason: "invalid-patch" as const,
            detail: "The open editor buffer is read-only for large-file protection.",
          },
        };
      }
      const current = contentRef.current;
      for (const edit of request.edits) {
        if (textForRange(current, edit.range) !== edit.originalText) {
          return {
            status: "conflict" as const,
            conflict: {
              path: request.path,
              reason: "write-conflict" as const,
              detail: "The open editor buffer no longer matches the reviewed replacement preview.",
            },
          };
        }
      }
      try {
        const next = applyTextEditsToText(current, request.edits.map(replaceEditToEditorEdit));
        contentRef.current = next;
        setContent(next);
        setFileModel((model) =>
          model === null
            ? model
            : editorFileModelReducer(model, { type: "edited", origin: "applied-patch" }),
        );
        setSaveStatus((status) => saveStatusReducer(status, { type: "edited" }));
        return { status: "applied" as const, path: request.path };
      } catch {
        return {
          status: "conflict" as const,
          conflict: {
            path: request.path,
            reason: "invalid-patch" as const,
            detail: "The reviewed replacement preview could not be applied to the open buffer.",
          },
        };
      }
    },
    [file, fileModelMatchesTarget, largeFileDegraded],
  );
  useRegisterWorkspaceReplaceBuffer(root, file, applyWorkspaceReplaceBuffer);

  const completionLanguage = fileModel?.identity.language;
  const languageProvider = providerForLanguage(languageCapabilities, completionLanguage);
  const completionEnabled = editorProviderFeatureEnabled(
    languageProvider,
    "completion",
    largeFileDegraded,
  );
  snippetInsertionSafeRef.current = completionEnabled && !editorReadOnlyBySettings;
  const diagnosticsEnabled = editorProviderFeatureEnabled(
    languageProvider,
    "diagnostics",
    largeFileDegraded,
  );
  const hoverEnabled = editorProviderFeatureEnabled(languageProvider, "hover", largeFileDegraded);
  const symbolsEnabled = editorProviderFeatureEnabled(
    languageProvider,
    "symbols",
    largeFileDegraded,
  );
  const definitionEnabled = editorProviderFeatureEnabled(
    languageProvider,
    "definition",
    largeFileDegraded,
  );
  const typeDefinitionEnabled = editorProviderFeatureEnabled(
    languageProvider,
    "typeDefinition",
    largeFileDegraded,
  );
  const implementationEnabled = editorProviderFeatureEnabled(
    languageProvider,
    "implementation",
    largeFileDegraded,
  );
  const callHierarchyEnabled = editorProviderFeatureEnabled(
    languageProvider,
    "callHierarchy",
    largeFileDegraded,
  );
  const inlayHintsEnabled = editorProviderFeatureEnabled(
    languageProvider,
    "inlayHints",
    largeFileDegraded,
  );
  const semanticTokensEnabled = editorSemanticTokensEnabled(
    completionLanguage,
    languageProvider,
    largeFileDegraded,
  );
  const semanticTokens = useMemo(
    () =>
      semanticTokensEnabled && currentDocumentUri !== null
        ? createEditorSemanticTokensHost({
            legend: RUST_SEMANTIC_TOKEN_LEGEND,
            resolve: provideSemanticTokens,
            isCurrentDocument: (uri): boolean => uri === currentDocumentUri,
            language: "rust",
            streamId: "editor-semantic-tokens",
            newRequestId: createEditorRequestId,
            isLargeDocument: (text): boolean =>
              deriveLargeFileMode({
                sizeBytes: SEMANTIC_TEXT_ENCODER.encode(text).length,
                text,
              }) === "degraded",
          })
        : undefined,
    [currentDocumentUri, provideSemanticTokens, semanticTokensEnabled],
  );
  const referencesEnabled = editorProviderFeatureEnabled(
    languageProvider,
    "references",
    largeFileDegraded,
  );
  const renameEnabled = editorRenameEnabled(languageProvider, largeFileDegraded);
  const codeActionsEnabled = editorProviderFeatureEnabled(
    languageProvider,
    "codeActions",
    largeFileDegraded,
  );
  const signatureHelpEnabled = editorProviderFeatureEnabled(
    languageProvider,
    "signatureHelp",
    largeFileDegraded,
  );
  // Formatting availability is browser-reachability truth from the editor-tier registry. The release
  // artifact deliberately ships no rich Monaco language workers (ADR-0042 D3.6), so only
  // `keiko-language-service` languages (ts/js) can format, and only when the server provider is up.
  const formatting = editorFormattingSettings(
    completionLanguage,
    languageProvider,
    largeFileDegraded,
  );
  const builtinFormatting = formatting.source;
  const formattingEnabled = formatting.enabled;
  formatOnSaveStateRef.current = {
    enabled: editorSettings.applied.formatOnSave,
    canFormat: formattingEnabled && loadState.status === "ready",
    document: matchingDocumentIdentity(fileModel, fileModelMatchesTarget),
    file,
    root,
    tabSize: editorSettings.applied.tabSize,
    insertSpaces: editorSettings.applied.insertSpaces,
  };
  // Issue 2.2: only the language-provider id keys the surface (a change there genuinely needs a
  // remount to re-register providers, and it happens once on load before editing). The theme variant
  // and large-file mode are NO LONGER part of the key — a theme toggle re-themes the live editor via
  // `setTheme` (use-editor-handlers `useThemeReapply`), and crossing the large-file boundary flips the
  // degraded options live via `editor.updateOptions` (the `options` prop), so neither discards the
  // undo stack or scroll/fold/cursor view state.
  const editorSurfaceKey = editorProviderId(languageProvider);

  const actions = editorActionAvailability({
    hasTarget,
    dirty,
    saveStatus,
    loadReady: loadState.status === "ready",
    formattingEnabled,
    renameEnabled,
  });
  const canSave = actions.canSave;
  const saveUnavailable = !canSave;
  const canFormat = actions.canFormat;
  const canRename = actions.canRename;
  const outlineTree = useMemo(() => buildEditorOutlineTree(outlineSymbols), [outlineSymbols]);
  const breadcrumbPath = useMemo(
    () => findContainingOutlinePath(outlineTree, cursor),
    [cursor, outlineTree],
  );
  const revealSymbol = useCallback(
    (symbol: EditorDocumentSymbol): void => {
      if (file === undefined) return;
      symbolRevealSeqRef.current += 1;
      setSymbolRevealRequest({
        id: `symbol:${file}:${String(symbolRevealSeqRef.current)}`,
        file,
        range: symbol.range,
      });
    },
    [file],
  );

  useEffect(() => {
    if (!hasTarget || root === undefined || fileModel === null || !symbolsEnabled) {
      setOutlineSymbols([]);
      setOutlineLoading(false);
      return;
    }
    if (loadState.status !== "ready" || activeContentHash === null) {
      setOutlineLoading(loadState.status === "ready");
      return;
    }
    const controller = new AbortController();
    symbolSeqRef.current += 1;
    const request: EditorRequestIdentity = {
      requestId: createEditorRequestId(),
      streamId: "editor-outline",
      sequence: symbolSeqRef.current,
    };
    setOutlineLoading(true);
    void resolveEditorSymbols(
      {
        request: { request, document: fileModel.identity },
        documentText: contentRef.current,
      },
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        setOutlineSymbols(response.symbols);
        setOutlineLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setOutlineSymbols([]);
        setOutlineLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [
    activeContentHash,
    fileModel,
    hasTarget,
    loadState.status,
    resolveEditorSymbols,
    root,
    symbolsEnabled,
  ]);

  const outlineSnapshot = useMemo<EditorOutlineSnapshot>(
    () => ({
      ...(file === undefined ? {} : { filePath: file }),
      symbols: outlineSymbols,
      cursor,
      enabled: symbolsEnabled,
      loading: outlineLoading,
    }),
    [cursor, file, outlineLoading, outlineSymbols, symbolsEnabled],
  );
  useEffect(() => {
    if (paneId === undefined || onOutlineStateChange === undefined) return;
    onOutlineStateChange(paneId, outlineSnapshot);
  }, [onOutlineStateChange, outlineSnapshot, paneId]);

  // GEN-UI-INTERACTION-003: announce why an aria-disabled toolbar action did nothing when activated.
  // A leading zero-width space forces the polite live region's text to differ from any prior identical
  // reason, so repeat activations of the same unavailable button re-announce instead of going silent.
  const announceToolbarNotice = useCallback((reason: string): void => {
    setToolbarNotice((current) => (current === reason ? `\u200B${reason}` : reason));
  }, []);
  const compareExternalChange = useCallback((): void => {
    if (root === undefined || file === undefined || !externalChangeCanCompare(externalChange)) {
      return;
    }
    void fetchFilesContent(root, file)
      .then((response) => {
        setExternalCompareBaseline(response.content);
        dispatchExternalChange({ type: "compareOpened" });
      })
      .catch((error: unknown) => {
        announceToolbarNotice(errorMessage(error));
      });
  }, [announceToolbarNotice, externalChange, file, root]);
  const keepExternalLocal = useCallback((): void => {
    setExternalCompareBaseline(null);
    dispatchExternalChange({ type: "keepLocal" });
  }, []);
  const closeExternalCompare = useCallback((): void => {
    dispatchExternalChange({ type: "compareClosed" });
    setExternalCompareBaseline(null);
  }, []);
  const reloadExternalChange = useCallback((): void => {
    setExternalCompareBaseline(null);
    if (dirtyRef.current) {
      setReloadConfirm(true);
      return;
    }
    dispatchExternalChange({ type: "reloadStarted" });
    reload();
  }, [reload]);
  const saveUnavailableReason = (): string => {
    if (!hasTarget) return "No file open to save.";
    if (saveStatus === "saving") return "Already saving.";
    if (loadState.status !== "ready") return "The file is still loading.";
    return "Nothing to save.";
  };

  const buffer: EditorBuffer | null = useMemo(
    () =>
      fileModel === null || !fileModelMatchesTarget
        ? null
        : {
            language: fileModel.identity.language,
            readOnly: editorReadOnlyBySettings,
            content: {
              relativePath: file ?? "",
              text: content,
              // PR #3289 review: byte-exact once readyContentDigest has settled for this exact
              // content; otherwise writeGateSizeBytes's conservative (never-under) UPPER-bound
              // estimate. Must NEVER pair the current text with a stale, smaller settled sizeBytes
              // (the old `activeContentDigest?.sizeBytes ?? 0`, which stays at whatever content
              // last settled regardless of `content` above) — isMaxSizeExceeded / effectiveReadOnly
              // (@oscharko-dev/keiko-editor's save-state.ts) is a hard size-limit / read-only gate
              // and must never see this buffer look smaller than it actually is, e.g. immediately
              // after a paste that pushes a small file over budget, while the debounce is pending.
              // (This is deliberately the UPPER-bound estimate, unlike largeFileMode's below —
              // see modeSelectionSizeBytesEstimate's doc for why the two gates diverge.)
              sizeBytes: writeGateSizeBytes,
              truncated: false,
            },
          },
    [
      content,
      writeGateSizeBytes,
      editorReadOnlyBySettings,
      file,
      fileModel,
      fileModelMatchesTarget,
    ],
  );
  const modelViewStateKey = editorModelViewStateKey(
    hasTarget,
    root,
    file,
    editorModelScope,
    paneId,
  );

  const loadRenameSources = useCallback(
    async (changeset: LanguageRenameChangeset): Promise<RenameSourcesResult> => {
      const sources: Record<string, PatchPreviewSource> = {};
      const snapshots: Record<string, EditorFileSessionSnapshot> = {};
      for (const fileChange of changeset.files) {
        if (fileChange.path === file) {
          // The active buffer is always read from live editor state, never the session cache.
          sources[fileChange.path] = patchPreviewSourceFromText(
            fileChange.path,
            contentRef.current,
          );
          continue;
        }
        if (root === undefined) continue;
        const cached = sessionCacheRef.current.get(documentSessionKey(root, fileChange.path));
        if (cached !== undefined) {
          snapshots[fileChange.path] = cached;
          sources[fileChange.path] = patchPreviewSourceFromText(fileChange.path, cached.content);
          continue;
        }
        const response = await fetchFilesContent(root, fileChange.path);
        if (response.session.version.contentHash !== fileChange.expectedContentHash) {
          return {
            status: "conflict",
            conflict: {
              code: "CONTENT_HASH_MISMATCH",
              message: `Rename target ${fileChange.path} changed since the rename was computed.`,
            },
          };
        }
        const snapshot = cleanEditorSessionSnapshot({
          root,
          path: fileChange.path,
          modelScope: editorModelScope,
          response,
        });
        sessionCacheRef.current.set(documentSessionKey(root, fileChange.path), snapshot);
        snapshots[fileChange.path] = snapshot;
        sources[fileChange.path] = patchPreviewSourceFromText(fileChange.path, snapshot.content);
      }
      return { status: "ready", sources, snapshots };
    },
    [editorModelScope, file, root],
  );
  const renameTargetForPath = useCallback(
    (
      path: string,
      snapshots?: Readonly<Record<string, EditorFileSessionSnapshot>>,
    ): RenameApplyTarget | null => {
      if (root === undefined) return null;
      if (path === file) {
        return {
          path,
          content: contentRef.current,
          fileModel,
          version,
          active: true,
        };
      }
      // Prefer the live session cache, but fall back to the review-time snapshot so a rename whose
      // sources were evicted from the bounded cache before Accept still applies (Issue #2105).
      const cached =
        sessionCacheRef.current.get(documentSessionKey(root, path)) ?? snapshots?.[path];
      if (cached === undefined) return null;
      return {
        path,
        content: cached.content,
        fileModel: cached.fileModel,
        version: cached.version,
        active: false,
        cached,
      };
    },
    [file, fileModel, root, version],
  );
  const runRename = useCallback((): void => {
    if (!canRename || root === undefined || file === undefined || fileModel === null) {
      announceToolbarNotice("Rename is unavailable for this file.");
      return;
    }
    if (cursor === null) {
      announceToolbarNotice("Place the cursor on a symbol to rename.");
      return;
    }
    void (async (): Promise<void> => {
      try {
        const position = { line: cursor.line, character: cursor.column };
        const prepare = await requestEditorRenamePrepare({
          root,
          path: file,
          languageId: fileModel.identity.language,
          text: contentRef.current,
          position,
        });
        if (prepare.range === null) {
          announceToolbarNotice(prepare.reason);
          return;
        }
        const newName = promptRenameSymbol(prepare.placeholder);
        if (newName === null || newName === prepare.placeholder) return;
        const changeset = await requestEditorRenameApply({
          root,
          path: file,
          languageId: fileModel.identity.language,
          text: contentRef.current,
          position,
          newName,
        });
        const sources = await loadRenameSources(changeset);
        if (sources.status === "conflict") {
          setEditorConflict(sources.conflict);
          return;
        }
        setRenameReview({
          changeset,
          model: buildRenamePreview({
            changeset,
            sources: sources.sources,
            patchId: `rename-symbol:${newName}`,
          }),
          snapshots: sources.snapshots,
          truncation: renameChangesetTruncation(changeset),
        });
      } catch (error) {
        announceToolbarNotice(error instanceof Error ? error.message : "Rename failed.");
      }
    })();
  }, [announceToolbarNotice, canRename, cursor, file, fileModel, loadRenameSources, root]);
  const reviewActive = externalChange.compareOpen || recoveryCompare || renameReview !== null;

  // Issue #1205: derive the unified status-bar view model from host state. Diagnostics are surfaced
  // only for governed source files (where the deterministic language service runs). The cursor is
  // rendered but never announced
  // (it changes per keystroke) — only meaningful state (save, problems, run) reaches the live region.
  const buildStatusBarViewModel = (): ReturnType<typeof deriveEditorStatusBar> | null => {
    if (fileModel === null) return null;
    const selectedLineCount =
      currentSelection === null
        ? undefined
        : currentSelection.end.line - currentSelection.start.line + 1;
    const languageIntelligenceStatus = editorLanguageIntelligenceStatus(
      languageIntelligenceNotice(summarizeLanguageIntelligence(languageIntelligence)),
      languageIntelligenceT,
    );
    const languageService =
      languageProvider === null
        ? { providerId: null, available: false }
        : {
            providerId: languageProvider.id === "none" ? null : languageProvider.id,
            available: languageProvider.availability === "available",
            ...(languageProvider.unavailableReason === undefined
              ? {}
              : { unavailableReason: languageProvider.unavailableReason }),
          };
    return deriveEditorStatusBar({
      languageId: fileModel.identity.language,
      cursor,
      ...(selectedLineCount === undefined ? {} : { selectedLineCount }),
      saveStatus,
      dirty,
      completionsEnabled: completionEnabled,
      largeFileMode,
      diagnostics: diagnosticsEnabled ? diagnosticsSummary : null,
      ...(mergeConflicts.count === 0
        ? {}
        : {
            mergeConflicts: {
              ...mergeConflicts,
              label: sourceControlT("conflicts.status", { count: mergeConflicts.count }),
              ariaLabel: sourceControlT("conflicts.statusAria", { count: mergeConflicts.count }),
            },
          }),
      languageService,
      ...(languageIntelligenceStatus === undefined
        ? {}
        : { languageIntelligence: languageIntelligenceStatus }),
      readOnly: largeFileDegraded,
      formatting: { available: formattingEnabled, source: builtinFormatting },
      ...(verification.statusBarRun === null ? {} : { run: verification.statusBarRun }),
      ...(debugSessionState === null
        ? {}
        : { debug: { state: debugSessionState, isExceptionPause: debugPauseIsException } }),
    });
  };
  const statusBarViewModel = buildStatusBarViewModel();
  const shouldShowUnifiedStatusBar = (): boolean =>
    hasTarget &&
    loadState.status === "ready" &&
    buffer !== null &&
    fileModel !== null &&
    statusBarViewModel !== null;
  const showUnifiedStatusBar = shouldShowUnifiedStatusBar();

  const effectiveDirtyFiles = useMemo(() => {
    const set = new Set(dirtyFiles ?? []);
    if (file !== undefined && dirty) set.add(file);
    return set;
  }, [dirty, dirtyFiles, file]);
  const bufferSafetySnapshot = useMemo<EditorAgentSessionSnapshot | null>(() => {
    if (root === undefined || root.length === 0) return null;
    // Disk loading and hot-exit hydration settle together before any clean state is published.
    if (hasTarget && (loadState.status !== "ready" || !fileModelMatchesTarget)) return null;
    const ownDirtyFiles = documentTabs.filter((path) => effectiveDirtyFiles.has(path));
    if (file !== undefined && recoverySnapshot !== null && !ownDirtyFiles.includes(file)) {
      ownDirtyFiles.push(file);
    }
    const ownerWindowId = windowId ?? generatedId;
    const ownerPaneId = paneId ?? "main";
    return {
      schemaVersion: "1",
      sessionId:
        "buffer:" +
        safeDomIdSegment(ownerWindowId) +
        ":" +
        safeDomIdSegment(ownerPaneId) +
        ":" +
        rootHash(root),
      windowId: ownerWindowId,
      workspaceRoot: root,
      ...(safetyRootBinding === undefined ? {} : { rootBinding: safetyRootBinding }),
      activePaneId: ownerPaneId,
      panes: [{ paneId: ownerPaneId, activeFile: file ?? null, openFiles: documentTabs }],
      dirtyFiles: ownDirtyFiles,
      activeFile: file ?? null,
      cursor: null,
      selection: null,
      diagnosticsSummary: null,
      textMode: "none",
      updatedAt: Date.now(),
    };
  }, [
    root,
    hasTarget,
    loadState.status,
    fileModelMatchesTarget,
    documentTabs,
    effectiveDirtyFiles,
    file,
    recoverySnapshot,
    windowId,
    generatedId,
    paneId,
    safetyRootBinding,
  ]);
  useEditorBufferSafety(
    bufferSafetySnapshot,
    confirmedCleanFiles !== null && confirmedCleanFiles.root === root
      ? confirmedCleanFiles
      : undefined,
  );
  const uriForPath = useCallback<NonNullable<EditorSurfaceProps["uriForPath"]>>(
    (path, currentModelUri) => {
      if (root === undefined) {
        return currentModelUri;
      }
      return monacoDocumentUri(root, path, editorModelScope);
    },
    [editorModelScope, root],
  );
  const handleSelectTab = useCallback(
    (path: string): void => {
      const paneAlreadyActive =
        paneId === undefined || activePaneId === undefined || paneId === activePaneId;
      if ((path === file && paneAlreadyActive) || saveStatus === "saving") return;
      onSelectOpenFile?.(path);
    },
    [activePaneId, file, onSelectOpenFile, paneId, saveStatus],
  );
  const handleCloseTab = useCallback(
    async (path: string): Promise<void> => {
      if (root !== undefined) {
        const cached = sessionCacheRef.current.get(documentSessionKey(root, path));
        if ((path === file && saveStatus === "saving") || cached?.saveStatus === "saving") {
          return;
        }
      }
      const accepted = await onCloseOpenFile?.(path);
      if (accepted === false || root === undefined) return;
      sessionCacheRef.current.delete(documentSessionKey(root, path));
    },
    [file, onCloseOpenFile, root, saveStatus],
  );
  const handleChooseSummaryTab = useCallback(
    (path: string): void => {
      handleSelectTab(path);
      setSummaryMenuOpen(false);
      summaryMenuRef.current?.removeAttribute("open");
    },
    [handleSelectTab],
  );

  const recoveryDiskChanged = recoverySnapshotChanged(recoverySnapshot, version);

  const handleRenameAccept = useCallback((): void => {
    if (renameReview === null || root === undefined) return;
    // Fail closed on a rename the language service could not finish. The Apply control is already
    // disabled for it, but this path is also reachable programmatically, and applying a partial
    // rename would leave the un-renamed references pointing at a symbol that no longer exists.
    if (renameReview.truncation !== null) {
      announceToolbarNotice(t("editor.rename.incompleteRefused"));
      return;
    }
    const plans: RenameApplyPlan[] = [];
    for (const change of renameReview.changeset.files) {
      const plan = buildRenamePlan(
        change,
        renameTargetForPath(change.path, renameReview.snapshots),
      );
      if ("code" in plan) {
        setEditorConflict({ code: plan.code, message: plan.message });
        return;
      }
      plans.push(plan);
    }
    for (const plan of plans) {
      if (plan.target.active) {
        setFileModel((model) =>
          model === null
            ? model
            : editorFileModelReducer(model, { type: "edited", origin: "applied-patch" }),
        );
        setSaveStatus((status) => saveStatusReducer(status, { type: "edited" }));
        setActiveHostEditRequest({
          id: createEditorRequestId(),
          text: plan.nextContent,
          origin: "applied-patch",
        });
      } else if (plan.target.cached !== undefined) {
        sessionCacheRef.current.set(documentSessionKey(root, plan.target.path), {
          ...plan.target.cached,
          content: plan.nextContent,
          fileModel:
            plan.target.cached.fileModel === null
              ? null
              : editorFileModelReducer(plan.target.cached.fileModel, {
                  type: "edited",
                  origin: "applied-patch",
                }),
          saveStatus: saveStatusReducer(plan.target.cached.saveStatus, { type: "edited" }),
        });
        onDirtyChange?.(plan.target.path, true);
      }
    }
    setRenameReview(null);
  }, [announceToolbarNotice, onDirtyChange, renameReview, renameTargetForPath, root, t]);

  const handleRenameReject = useCallback((): void => {
    setRenameReview(null);
  }, []);

  // Manual navigation reveal requests retain outline and call hierarchy priority.
  const buildLineRevealRequest = (): EditorSurfaceProps["revealRequest"] => {
    if (revealLineStart === undefined) return undefined;
    const end = definedOr(revealLineEnd, revealLineStart);
    return {
      id: definedOr(
        revealRequestId,
        `${definedOr(file, "file")}:${String(revealLineStart)}:${String(end)}`,
      ),
      range: {
        start: { line: Math.max(0, Math.floor(revealLineStart) - 1), column: 0 },
        end: {
          line: Math.max(Math.max(0, Math.floor(revealLineStart) - 1), Math.floor(end) - 1),
          column: 0,
        },
      },
    };
  };
  const lineRevealRequest = buildLineRevealRequest();
  const chooseOutlineRevealRequest = (): EditorSurfaceProps["revealRequest"] =>
    outlineRevealRequest?.file === file ? outlineRevealRequest : symbolRevealRequest;
  const outlineSelectionRequest = chooseOutlineRevealRequest();
  const buildSurfaceRevealRequest = (): EditorSurfaceProps["revealRequest"] => {
    return callHierarchyRevealRequest ?? outlineSelectionRequest ?? lineRevealRequest;
  };
  const surfaceRevealRequest = buildSurfaceRevealRequest();
  const callHierarchyLabels = useMemo(
    () => ({
      title: commonT("editor.callHierarchy.title"),
      incoming: commonT("editor.callHierarchy.incoming"),
      outgoing: commonT("editor.callHierarchy.outgoing"),
      callSite: commonT("editor.callHierarchy.callSite"),
      empty: commonT("editor.callHierarchy.empty"),
      close: commonT("editor.callHierarchy.close"),
      command: commonT("editor.callHierarchy.command"),
    }),
    [commonT],
  );

  const renderGitGutterPeek = (): ReactNode => {
    if (gitGutterPeek === null || file === undefined) return null;
    return (
      <EditorGitHunkPeek
        path={file}
        peek={gitGutterPeek}
        labels={{
          close: sourceControlT("gitGutter.closePeek"),
          staged: sourceControlT("gitGutter.staged"),
          unstaged: sourceControlT("gitGutter.unstaged"),
          title: sourceControlT("gitGutter.peekTitle"),
          truncated: sourceControlT("gitGutter.truncated"),
          hunkHeader: sourceControlT("gitGutter.hunkHeader"),
          addedLine: sourceControlT("gitGutter.addedLine"),
          deletedLine: sourceControlT("gitGutter.deletedLine"),
          contextLine: sourceControlT("gitGutter.contextLine"),
          metadataLine: sourceControlT("gitGutter.metadataLine"),
        }}
        onClose={() => setGitGutterPeek(null)}
      />
    );
  };
  const externalCompareContent = enabledValueOrNull(
    externalChange.compareOpen,
    externalCompareBaseline,
  );
  const activeRecoveryCompare = enabledValueOrNull(recoveryCompare, recoverySnapshot);
  const editorLoadError = editorLoadErrorMessage(hasTarget, loadState, commonT);
  const debugSessionHost = enabledValueOrNull(
    debugEnabled,
    <EditorDebugSessionHost
      root={root ?? ""}
      workspaceId={debugWorkspaceId}
      activationRevision={debugActivation?.revision}
      enabled={debugEnabled}
      fileId={file}
      onOpenDebugPanel={onOpenDebugPanel}
      onHostChange={setDebugEditorHost}
      onSessionStateChange={setDebugSessionState}
      onExceptionPauseChange={setDebugPauseIsException}
    />,
  );

  /**
   * The pending-review surface that takes the pane away from the editor, or null when none is.
   *
   * Every branch below is a change waiting on an operator decision — an external write, a
   * recovered hot-exit buffer, a rename the language service
   * produced, or generated tests — and each one owns the pane until it is accepted or dismissed.
   * The order is the precedence: the editor itself is only reached once all of them are clear.
   */
  const renderActiveReviewSurface = (): ReactNode => {
    if (externalCompareContent !== null) {
      const externalDiffModel = buildEditorReviewDiffModel(externalCompareContent, content, file);
      return (
        <div style={EDITOR_REVIEW_SURFACE_STYLE}>
          <fieldset
            aria-label={`Compare external changes for ${definedOr(file, "this file")}`}
            style={EDITOR_REVIEW_DIFF_GROUP_STYLE}
          >
            <span className="sr-only">
              Side-by-side comparison of the latest file on disk and the local editor buffer. Keep
              local preserves your buffer; reload replaces it with the file on disk.
            </span>
            <EditorDiffSurface
              model={externalDiffModel}
              loadState={{ status: "ready" }}
              themeVariant={themeVariant}
            />
          </fieldset>
          <div className="ed-toolbar-actions" style={EDITOR_REVIEW_ACTIONS_STYLE}>
            <button
              ref={externalCompareButtonRef}
              type="button"
              className="ed-save"
              onClick={keepExternalLocal}
            >
              Keep local
            </button>
            <button
              type="button"
              className="ed-reload"
              aria-label="Reload external changes"
              onClick={reloadExternalChange}
            >
              Reload
            </button>
            <button type="button" className="ed-icon-action" onClick={closeExternalCompare}>
              Close compare
            </button>
          </div>
        </div>
      );
    }
    if (activeRecoveryCompare !== null) {
      // AC4 "compare": a true side-by-side diff of the on-disk file (left) against the recovered
      // unsaved buffer (right), reusing the same diff surface as rename review. The disk side is
      // the baseline captured when recovery was offered, not the live buffer, so it stays accurate
      // even if the buffer was edited before Compare was opened.
      const recoveryDiffModel = buildEditorReviewDiffModel(
        nullishOr(recoveryDiskBaseline, content),
        activeRecoveryCompare.content,
        file,
      );
      return (
        <div style={EDITOR_REVIEW_SURFACE_STYLE}>
          <fieldset
            aria-label={`Compare recovered changes for ${definedOr(file, "this file")}`}
            style={EDITOR_REVIEW_DIFF_GROUP_STYLE}
          >
            <span className="sr-only">
              Side-by-side comparison of the file on disk and the recovered unsaved changes. Keep
              local restores the recovered changes; use disk keeps the file on disk.
            </span>
            <EditorDiffSurface
              model={recoveryDiffModel}
              loadState={{ status: "ready" }}
              themeVariant={themeVariant}
            />
          </fieldset>
          <div className="ed-toolbar-actions" style={EDITOR_REVIEW_ACTIONS_STYLE}>
            <button
              ref={recoveryCompareButtonRef}
              type="button"
              className="ed-save"
              onClick={restoreRecovery}
            >
              Keep local
            </button>
            <button type="button" className="ed-reload" onClick={discardRecovery}>
              Use disk
            </button>
            <button type="button" className="ed-icon-action" onClick={closeRecoveryCompare}>
              Close compare
            </button>
          </div>
        </div>
      );
    }
    if (renameReview !== null) {
      // A rename the language service could not finish is stated in full and cannot be applied: the
      // counts come from the changeset's own report, so the reviewer sees how much of the rename is
      // missing before deciding (a preview built from the returned files alone looks complete).
      return (
        <div style={EDITOR_REVIEW_SURFACE_STYLE}>
          {renameReview.truncation === null ? null : (
            <div
              role="note"
              aria-live="polite"
              data-testid="editor-rename-incomplete"
              style={EDITOR_RENAME_INCOMPLETE_STYLE}
            >
              {renameIncompleteNotice(t, renameReview.truncation)}
            </div>
          )}
          <div style={EDITOR_REVIEW_DIFF_GROUP_STYLE}>
            <EditorDiffSurface
              model={renameReview.model}
              loadState={{ status: "ready" }}
              themeVariant={themeVariant}
              actions={{
                canApply: renameReview.truncation === null,
                canReject: true,
                canRunVerification: !verification.verificationRunning,
              }}
              onApply={handleRenameAccept}
              onReject={handleRenameReject}
              onRunVerification={runRenameVerification}
            />
          </div>
        </div>
      );
    }
    return null;
  };

  const renderEditorPanel = (): ReactNode => {
    const reviewSurface = renderActiveReviewSurface();
    if (reviewSurface !== null) return reviewSurface;
    let panel: ReactNode;
    if (editorLoadError !== null) {
      panel = (
        <div className="ed-host-loading" role="alert">
          <span>{editorLoadError}</span>
          {loadRetryable ? (
            <>
              <button type="button" className="ed-reload" onClick={reload}>
                {commonT("editor.runtime.retry")}
              </button>
              <SupportReportButton correlationId={loadCorrelationId} />
            </>
          ) : null}
        </div>
      );
    } else if (hasTarget && buffer !== null && fileModel !== null) {
      panel = (
        <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0, height: "100%" }}>
          {debugSessionHost}
          <EditorSurface
            key={editorSurfaceKey}
            buffer={buffer}
            fileModel={fileModel}
            fileLoadState={loadState}
            saveStatus={saveStatus}
            saveError={saveError}
            modifiedAt={nullToUndefined(modifiedAt)}
            maxSizeBytes={nullToUndefined(maxBytes)}
            themeVariant={themeVariant}
            editorPreferences={editorSettings.applied}
            modelRootKey={root}
            modelViewStateKey={modelViewStateKey}
            modelRetentionProtection={{
              hotExitRecovery: recoverySnapshot !== null,
              agentReview: reviewActive,
            }}
            ariaLabel={activeEditorAriaLabel(root, file)}
            onContentChange={onContentChange}
            onSaveRequested={onSaveRequested}
            onRuntimeError={onRuntimeError}
            provideCompletions={whenEnabled(completionEnabled, provideCompletions)}
            completionTriggerCharacters={DEFAULT_COMPLETION_TRIGGER_CHARACTERS}
            provideInlineCompletions={whenEnabled(completionEnabled, provideInlineCompletions)}
            onInlineCompletionTelemetry={whenEnabled(
              completionEnabled,
              onInlineCompletionTelemetry,
            )}
            provideDiagnostics={whenEnabled(diagnosticsEnabled, provideDiagnostics)}
            provideHover={whenEnabled(hoverEnabled, provideHover)}
            provideSymbols={whenEnabled(symbolsEnabled, provideSymbols)}
            provideFormatting={whenEnabled(formattingEnabled, provideFormatting)}
            provideDefinition={whenEnabled(definitionEnabled, provideDefinition)}
            provideTypeDefinition={whenEnabled(typeDefinitionEnabled, provideTypeDefinition)}
            provideImplementation={whenEnabled(implementationEnabled, provideImplementation)}
            provideCallHierarchy={whenEnabled(callHierarchyEnabled, provideCallHierarchy)}
            callHierarchyLabels={whenEnabled(callHierarchyEnabled, callHierarchyLabels)}
            onRevealCallHierarchyLocation={whenEnabled(
              callHierarchyEnabled,
              revealCallHierarchyLocation,
            )}
            provideInlayHints={whenEnabled(inlayHintsEnabled, provideInlayHints)}
            semanticTokens={semanticTokens}
            uriForPath={whenEnabled(
              navigationResolverEnabled(
                definitionEnabled,
                typeDefinitionEnabled,
                implementationEnabled,
                referencesEnabled,
              ),
              uriForPath,
            )}
            provideReferences={whenEnabled(referencesEnabled, provideReferences)}
            provideCodeActions={whenEnabled(codeActionsEnabled, provideCodeActions)}
            provideSignatureHelp={whenEnabled(signatureHelpEnabled, provideSignatureHelp)}
            formatRequestNonce={formatRequestNonce}
            onSelectionChange={setCurrentSelection}
            onCursorChange={setCursor}
            revealRequest={surfaceRevealRequest}
            hostEditRequest={activeHostEditRequest}
            onDiagnosticsSummary={whenEnabled(diagnosticsEnabled, setDiagnosticsSummary)}
            onDiagnostics={whenEnabled(diagnosticsEnabled, onPaneDiagnostics)}
            onLanguageIntelligence={reportLanguageIntelligence}
            onRenameSymbol={whenEnabled(canRename, runRename)}
            showStatusFooter={false}
            editorGitGutter={editorGitGutter}
            editorBlame={editorBlame}
            debug={debugEditorHost}
            gitGutterRefreshNonce={gitGutterRefreshNonce}
            editorConflicts={editorConflicts}
          />
          {renderGitGutterPeek()}
        </div>
      );
    } else if (hasTarget) {
      panel = <output className="ed-host-loading">Loading file…</output>;
    } else {
      panel = (
        <div className="ed-empty" role="note">
          {commonT("editor.runtime.chooseFile")}
        </div>
      );
    }
    return panel;
  };
  const panel = renderEditorPanel();

  // ADR-0133 D3: "manual" never proactively offers a reload for a clean external change — the
  // operator discovers and reloads it deliberately (e.g. by reopening the file). Dirty/deleted/
  // renamed/degraded statuses still surface regardless of the setting; only unmodified content is
  // affected by this ceiling.
  const suppressCleanBanner =
    externalReloadPolicy === "manual" && externalChange.status === "cleanChanged";
  const showExternalChangeBanner =
    externalChange.status !== "idle" && !externalChange.compareOpen && !suppressCleanBanner;
  const workspaceWatchNeedsAttention =
    workspaceWatch.health !== "healthy" || workspaceWatch.snapshotRequired;

  const renderSummaryTabItem = (path: string): ReactNode => {
    const tabDirty = effectiveDirtyFiles.has(path);
    const tabHandle = renderTabHandle?.(path, false, tabDirty, {
      onDragModeStart: () => setSummaryMenuOpen(false),
    });
    return (
      <button
        type="button"
        key={path}
        className="ed-tab-summary-item"
        draggable={tabHandle?.draggable}
        data-tab-draggable={tabHandle?.["data-tab-draggable"]}
        data-tab-held={tabHandle?.["data-tab-held"]}
        onClickCapture={tabHandle?.onClickCapture}
        onDragStart={tabHandle?.onDragStart}
        onDragEnd={tabHandle?.onDragEnd}
        onPointerDown={tabHandle?.onPointerDown}
        onKeyDown={tabHandle?.onKeyDown}
        onClick={() => handleChooseSummaryTab(path)}
      >
        <FileIcon name={path} />
        <span className="ed-tab-summary-label">{path}</span>
        {tabDirty ? (
          <span className="ed-dirty" aria-hidden="true">
            ●
          </span>
        ) : null}
      </button>
    );
  };

  /**
   * Close the focused tab from the keyboard (0.3.0 release audit, #2802).
   *
   * `role="tab"` presents its children, so the close control inside a tab cannot itself be
   * focusable — axe reports `nested-interactive` for that shape, which is how the previous
   * standalone close button became an owned child of the tablist in the first place. The WAI-ARIA
   * APG's deletable-tabs pattern puts the affordance on the tab instead; Backspace is accepted
   * alongside Delete because that is the key Mac keyboards send.
   */
  const handleTabCloseKey = (path: string, event: ReactKeyboardEvent<HTMLElement>): void => {
    if (onCloseOpenFile === undefined) return;
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    void handleCloseTab(path);
  };

  const renderTabCloseAffordance = (path: string): ReactNode => {
    if (onCloseOpenFile === undefined) return null;
    return (
      <span
        className={`ed-tab-close ${runtimeStyles.tabClose}`}
        // Decoration for the pointer: the tab owns the name and the keyboard path, and an exposed
        // control here would be an unallowed owned child of the tablist again.
        aria-hidden="true"
        data-tab-close-file={path}
        onPointerDown={(event: ReactPointerEvent<HTMLSpanElement>) => {
          // The tab arms pointer drags; pressing × must not start one.
          event.stopPropagation();
        }}
        onClick={(event: ReactMouseEvent<HTMLSpanElement>) => {
          // The tab is the selection target; closing must not also select it.
          event.stopPropagation();
          void handleCloseTab(path);
        }}
      >
        <CloseIcon size={24} sw={2} />
      </span>
    );
  };

  const renderOpenDocumentTab = (path: string): ReactNode => {
    const active = path === file;
    const tabDomId = active ? tabId : `${editorDomIdPrefix}-tab-${safeDomIdSegment(path)}`;
    const tabDirty = effectiveDirtyFiles.has(path);
    const tabConflictCount = active ? mergeConflicts.count : 0;
    const tabHandle = renderTabHandle?.(path, active, tabDirty, {
      mergeConflicts: tabConflictCount,
    });
    const insertEdge = tabInsertTarget?.file === path ? tabInsertTarget.edge : null;
    const conflictAttr = tabHandle?.["data-merge-conflicts"] ?? String(tabConflictCount);
    const closable = onCloseOpenFile !== undefined;
    const tabHitClassName = closable
      ? `ed-tab-hit ui-tip ${runtimeStyles.tabHitClosable}`
      : "ed-tab-hit ui-tip";
    return (
      <span
        className={`ed-tab${active ? " active" : ""}`}
        data-dirty={tabDirty ? "true" : "false"}
        data-pane-id={paneId}
        data-tab-file={path}
        data-tab-draggable={tabHandle?.["data-tab-draggable"]}
        data-tab-held={tabHandle?.["data-tab-held"]}
        data-merge-conflicts={conflictAttr}
        data-tab-insert-before={insertEdge === "before" ? "true" : "false"}
        data-tab-insert-after={insertEdge === "after" ? "true" : "false"}
        key={path}
      >
        <button
          type="button"
          className={tabHitClassName}
          draggable={tabHandle?.draggable}
          role="tab"
          id={tabDomId}
          aria-selected={active ? "true" : "false"}
          aria-controls={tabpanelId}
          tabIndex={active ? 0 : -1}
          data-tip={path}
          data-pane-id={paneId}
          data-tab-file={path}
          data-tab-draggable={tabHandle?.["data-tab-draggable"]}
          data-tab-held={tabHandle?.["data-tab-held"]}
          data-merge-conflicts={conflictAttr}
          aria-label={tabAriaLabel(path, tabConflictCount, sourceControlT)}
          onClickCapture={tabHandle?.onClickCapture}
          onDragStart={tabHandle?.onDragStart}
          onDragEnd={tabHandle?.onDragEnd}
          onPointerDown={tabHandle?.onPointerDown}
          onKeyDown={(event) => {
            handleTabCloseKey(path, event);
            if (event.defaultPrevented) return;
            tabHandle?.onKeyDown?.(event);
          }}
          onClick={() => handleSelectTab(path)}
          onAuxClick={(event) => {
            // Middle-click closes the tab (VS Code parity), routed through the same
            // dirty-close guard as the × affordance.
            if (event.button === 1 && closable) {
              event.preventDefault();
              void handleCloseTab(path);
            }
          }}
        >
          <FileIcon name={path} />
          <span className="ed-tab-label">{path}</span>
          {tabConflictCount > 0 ? (
            <span className={conflictStyles.badge} aria-hidden="true">
              {tabConflictCount}
            </span>
          ) : null}
          {tabDirty ? (
            <span className="ed-dirty" aria-hidden="true">
              ●
            </span>
          ) : null}
          {renderTabCloseAffordance(path)}
        </button>
      </span>
    );
  };

  const renderOpenDocumentTabs = (): ReactNode => (
    <div
      className="ed-tablist"
      ref={tablistRef}
      // GEN-PERF-EDITOR-003: the held-file scalar exists to trip React.memo for the one pane whose
      // tab visual must repaint; surfacing it as a DOM marker is its one real read and gives the
      // drag e2e a stable observation point.
      data-held-tab-file={heldTabFile}
    >
      {/*
        0.3.0 release audit (#2802) — `role="tablist"` sits on this inner row rather than on
        `.ed-tablist`, because a tablist may own nothing but tabs and the overflow chooser below is
        not one. `.ed-tablist` stays the measured element so `readableTabCapacity` keeps reserving
        the chooser's width from a box that still contains it.
      */}
      <div className={runtimeStyles.tabRow} role="tablist" aria-label="Open documents">
        {visibleTabs.length > 0 ? (
          visibleTabs.map((path) => renderOpenDocumentTab(path))
        ) : (
          <span className="ed-tab active" data-dirty="false">
            <span
              className="ed-tab-hit ui-tip"
              role="tab"
              id={tabId}
              aria-selected="true"
              aria-controls={tabpanelId}
              tabIndex={0}
              data-tip="Editor"
            >
              <EditorIcon size={12} />
              <span className="ed-tab-label">Editor</span>
            </span>
          </span>
        )}
      </div>
      {compactTabs && summaryTabs.length > 0 ? (
        <details
          ref={summaryMenuRef}
          className="ed-tab-summary-menu"
          open={summaryMenuOpen}
          onToggle={(event) => setSummaryMenuOpen(event.currentTarget.open)}
        >
          <summary
            className="ed-tab-summary"
            aria-label={`${String(summaryTabs.length)} more open documents`}
            aria-haspopup="menu"
            aria-expanded={summaryMenuOpen ? "true" : "false"}
            aria-controls={summaryMenuId}
          >
            +{summaryTabs.length}
          </summary>
          <div
            className="ed-tab-summary-panel"
            id={summaryMenuId}
            aria-label="Hidden open documents"
          >
            {summaryTabs.map((path) => renderSummaryTabItem(path))}
          </div>
        </details>
      ) : null}
    </div>
  );

  const handleFormatClick = (): void => {
    if (canFormat) setFormatRequestNonce((value) => value + 1);
    else announceToolbarNotice("Formatting is unavailable for this file.");
  };

  const handleSaveClick = (): void => {
    if (canSave) void persist(content);
    else announceToolbarNotice(saveUnavailableReason());
  };
  const saveButtonLabel =
    saveStatus === "saving" ? commonT("common.saving") : commonT("common.save");

  const documentActions: EditorDocumentAction[] = [];
  if (
    root !== undefined &&
    file !== undefined &&
    workspaceGitRepositoryRoot !== null &&
    onOpenGitDiff !== undefined
  ) {
    documentActions.push({
      label: sourceControlT("gitDiff.openLabel"),
      run: () => onOpenGitDiff(root, file),
    });
  }
  documentActions.push({
    label: commonT("editor.fileHistory.open"),
    run: () => setFileHistoryOpen((open) => !open),
  });
  if (canFormat)
    documentActions.push({ label: commonT("editor.actions.format"), run: handleFormatClick });

  const renderEditorToolbar = (): ReactNode => (
    <div className={`ed-toolbar-actions ${runtimeStyles.toolbar}`}>
      {toolbarExtras}
      {hasTarget && saveStatus === "conflict" ? (
        <button type="button" className={runtimeStyles.primaryAction} onClick={requestReload}>
          {commonT("editor.actions.reload")}
        </button>
      ) : null}
      {hasTarget ? (
        <>
          <button
            type="button"
            className={runtimeStyles.primaryAction}
            onClick={handleSaveClick}
            aria-disabled={saveUnavailable}
          >
            {saveButtonLabel}
          </button>
          <EditorDocumentActions label={commonT("editor.actions.more")} actions={documentActions} />
        </>
      ) : null}
    </div>
  );

  const renderWorkspaceWatchBanner = (): ReactNode => (
    <>
      {workspaceWatchNeedsAttention ? (
        <output className="ed-recovery" data-testid="editor-workspace-watch-status">
          <span>
            {workspaceWatch.snapshotRequired
              ? commonT("editor.runtime.watchRefresh")
              : commonT("editor.runtime.watchInterrupted")}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="ed-reload"
            onClick={() => {
              workspaceWatch.refresh();
              requestReload();
            }}
          >
            {commonT("editor.runtime.refresh")}
          </button>
        </output>
      ) : null}
    </>
  );

  const localHistoryProtectionGuidance = (
    reason: Extract<
      NonNullable<FilesContentResponse["localHistoryProtection"]>,
      { readonly status: "degraded" }
    >["reason"],
  ): string => {
    switch (reason) {
      case "workspace-unavailable":
        return commonT("editor.localHistoryProtection.workspaceUnavailable");
      case "filesystem-identity-unsupported":
        return commonT("editor.localHistoryProtection.filesystemIdentityUnsupported");
      default:
        return commonT("editor.localHistoryProtection.historyUnavailable");
    }
  };

  const renderLocalHistoryProtectionBanner = (): ReactNode => {
    if (
      localHistoryProtection?.status !== "degraded" &&
      localHistoryProtection?.status !== "suppressed"
    )
      return null;
    const degraded = localHistoryProtection.status === "degraded";
    return (
      <output className="ed-recovery" data-testid="editor-local-history-protection">
        <span>
          {commonT(
            degraded
              ? "editor.localHistoryProtection.savedBrief"
              : "editor.localHistoryProtection.suppressedBrief",
          )}
        </span>
        {degraded ? (
          <SupportReportButton correlationId={localHistoryProtection.correlationId} />
        ) : null}
        <details>
          <summary>{commonT("editor.runtime.details")}</summary>
          <p>
            {degraded
              ? localHistoryProtectionGuidance(localHistoryProtection.reason)
              : commonT("editor.localHistoryProtection.suppressedSecretDetected")}{" "}
            {commonT("editor.localHistoryProtection.diagnosticReference", {
              correlationId: localHistoryProtection.correlationId,
            })}
          </p>
        </details>
      </output>
    );
  };

  const renderExternalChangeBanner = (): ReactNode => (
    <>
      {showExternalChangeBanner ? (
        <output className="ed-recovery" data-testid="editor-external-change-banner">
          <span>{externalChangeMessage(externalChange, file)}</span>
          <span className="spacer" />
          {externalChangeCanCompare(externalChange) ? (
            <button type="button" className="ed-reload" onClick={compareExternalChange}>
              Compare
            </button>
          ) : null}
          <button type="button" className="ed-save" onClick={keepExternalLocal}>
            Keep local
          </button>
          <button
            type="button"
            className="ed-reload"
            aria-label="Reload external changes"
            onClick={reloadExternalChange}
          >
            Reload
          </button>
        </output>
      ) : null}
    </>
  );

  const renderRecoveryBanner = (): ReactNode => (
    <>
      {recoverySnapshot !== null && !recoveryCompare ? (
        <output className="ed-recovery">
          <span>
            {recoveryDiskChanged
              ? "Recovered editor changes are available, and the disk file changed."
              : "Recovered unsaved editor changes are available."}
          </span>
          <span className="spacer" />
          {recoveryDiskChanged ? (
            <button type="button" className="ed-reload" onClick={compareRecovery}>
              Compare
            </button>
          ) : null}
          <button type="button" className="ed-save" onClick={restoreRecovery}>
            {recoveryDiskChanged ? "Keep local" : "Restore unsaved changes"}
          </button>
          <button type="button" className="ed-reload" onClick={discardRecovery}>
            {recoveryDiskChanged ? "Use disk" : "Discard"}
          </button>
          {recoveryDiskChanged ? (
            <button
              type="button"
              className="ed-icon-action"
              onClick={() => {
                setRecoverySnapshot(null);
                setRecoveryCompare(false);
                setRecoveryDiskBaseline(null);
              }}
            >
              Cancel
            </button>
          ) : null}
        </output>
      ) : null}
    </>
  );

  const renderReloadConfirmation = (): ReactNode => {
    if (!reloadConfirm) return null;
    const dialog = (
      <div className="ed-dialog-backdrop">
        <dialog
          open
          className="ed-dirty-dialog"
          ref={reloadConfirmRef}
          aria-modal="true"
          aria-labelledby="editor-reload-confirm-title"
          tabIndex={-1}
          style={{ position: "relative", inset: "auto", margin: 0, color: "inherit" }}
        >
          <h2 id="editor-reload-confirm-title">Discard unsaved changes?</h2>
          <p>
            {`Reloading from disk replaces this buffer with the saved file and discards your unsaved editor changes${
              file !== undefined && file.length > 0 ? ` in ${file}` : ""
            }.`}
          </p>
          <div className="ed-dialog-actions">
            <button type="button" className="ed-reload" onClick={confirmReloadDiscard}>
              Discard and reload
            </button>
            <button type="button" className="ed-icon-action" onClick={cancelReloadDiscard}>
              Cancel
            </button>
          </div>
        </dialog>
      </div>
    );
    return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
  };

  const renderEditorConflictBanner = (): ReactNode => (
    <>
      {editorConflict !== null ? (
        <AgentConflictBanner
          code={editorConflict.code}
          message={editorConflict.message}
          onSave={
            editorConflict.code === "DIRTY"
              ? () => {
                  // F5: only dismiss the banner when persist succeeds (returns true).
                  void persist(contentRef.current).then((ok) => {
                    if (ok) setEditorConflict(null);
                  });
                }
              : undefined
          }
          onReload={
            editorConflict.code === "VERSION_MISMATCH" ||
            editorConflict.code === "CONTENT_HASH_MISMATCH"
              ? () => {
                  reload();
                  setEditorConflict(null);
                }
              : undefined
          }
          onDismiss={() => {
            setEditorConflict(null);
          }}
        />
      ) : null}
    </>
  );

  const renderEditorChrome = (): ReactNode => (
    <div className={`editor ${runtimeStyles.themeTokens}`} data-workspace-scroll-owner="virtual">
      <div className="ed-tabs mono">
        {renderOpenDocumentTabs()}
        {renderEditorToolbar()}
      </div>
      {/* GEN-UI-INTERACTION-003: polite live region announcing why an aria-disabled toolbar action
          did nothing when a keyboard/AT user activated it (the buttons stay focusable and no-op). Uses
          aria-live (not role="status") so it does not collide with the status bar's role=status region
          for role-based queries; screen readers announce polite live regions regardless of role. */}
      <div
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
        data-testid="editor-toolbar-notice"
      >
        {toolbarNotice}
      </div>
      {renderWorkspaceWatchBanner()}
      {renderLocalHistoryProtectionBanner()}
      {renderExternalChangeBanner()}
      {renderRecoveryBanner()}
      {renderReloadConfirmation()}
      {renderEditorConflictBanner()}
      {hasTarget ? (
        <EditorBreadcrumbBar filePath={file} path={breadcrumbPath} onReveal={revealSymbol} />
      ) : null}
      <div className="ed-host" id={tabpanelId} role="tabpanel" aria-labelledby={tabId}>
        {panel}
        {fileHistoryOpen && root !== undefined && file !== undefined ? (
          <EditorFileHistoryPanel
            root={root}
            file={file}
            currentContent={content}
            dirty={dirty}
            onClose={() => setFileHistoryOpen(false)}
            onRestore={restoreHistoryContent}
          />
        ) : null}
      </div>
      {showUnifiedStatusBar && statusBarViewModel !== null ? (
        <EditorStatusBar viewModel={statusBarViewModel} />
      ) : null}
    </div>
  );

  return sessionActive ? renderEditorChrome() : null;
}

/**
 * Memoized so a layout mutation in one pane (tab-select, split, or — most expensively — a split-resize
 * drag) does not re-render the OTHER panes' editor hosts. The host (`EditorWidget`) feeds each pane a
 * referentially-stable prop bundle for panes the mutation did not touch (stable callbacks via
 * `layoutRef`, memoized snapshots/bindings), so `React.memo`'s shallow compare bails them out. It only
 * skips on shallow-equal props, so it never shows stale content.
 */
export default memo(EditorRuntimeWidget);
