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
import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { toExactArrayBuffer } from "@/lib/bytes";
import {
  EDITOR_HOT_EXIT_SCHEMA_VERSION,
  applyTextEditsToText,
  buildPatchPreview,
  buildTestGenerationPreview,
  buildRenamePreview,
  configureEditorModelRegistry,
  createEditorRequestId,
  createFileModel,
  DEFAULT_COMPLETION_TRIGGER_CHARACTERS,
  deriveLargeFileMode,
  deriveEditorStatusBar,
  describeTestGenerationStatus,
  disposeAllUnattachedEditorModels,
  disposeEditorModelRegistryRoot,
  editorFileModelReducer,
  EditorStatusBar,
  EMPTY_LANGUAGE_INTELLIGENCE_STATE,
  formattingApplyDecision,
  IDLE_TEST_GENERATION_STATE,
  inferMonacoLanguageId,
  isDocumentDirty,
  isSupportedEditorLanguage,
  isTestGenerationBusy,
  isTestGenerationPreviewing,
  languageIntelligenceNotice,
  reduceLanguageIntelligence,
  renameChangesetTruncation,
  saveStatusReducer,
  summarizeLanguageIntelligence,
  testGenerationReducer,
  type EditorBuffer,
  type EditorChangeOrigin,
  type EditorCallHierarchyQuery,
  type EditorCallHierarchyResolver,
  type EditorCodeActionsQuery,
  type EditorCodeActionsResolver,
  type EditorCompletionQuery,
  type EditorCompletionItem,
  type EditorCompletionResolver,
  type EditorContentDelta,
  type EditorDefinitionQuery,
  type EditorDefinitionResolver,
  type EditorDiagnostic,
  type EditorDocumentSymbol,
  type EditorDiagnosticsResolver,
  type EditorDiagnosticsQuery,
  type EditorDiagnosticsSummary,
  type EditorDocumentIdentity,
  type EditorFileModel,
  type EditorHotExitSnapshotV1,
  type EditorFormattingResolver,
  type EditorFormattingQuery,
  type EditorGitGutterHost,
  type EditorGitGutterPeek,
  type EditorBlameHost,
  type EditorHostEditRequest,
  type EditorHoverResolver,
  type EditorHoverQuery,
  type EditorInlineCompletionResolver,
  type EditorInlineCompletionQuery,
  type EditorInlayHintsQuery,
  type EditorInlayHintsResolver,
  type EditorLanguageIntelligenceEvent,
  type EditorLanguageId,
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
  type EditorStatusRun,
  type EditorSymbolsResponse,
  type EditorSymbolsResolver,
  type EditorSymbolsQuery,
  type EditorTextEdit,
  type InlineCompletionTelemetrySnapshot,
  type KeikoEditorLoadState,
  type PatchPreviewModel,
  type PatchPreviewSource,
  type PatchPreviewSourceTruncation,
  type TestGenerationFlowAction,
  type TestGenerationFlowState,
  type TestGenerationPreview,
} from "@oscharko-dev/keiko-editor";
import {
  editorBuiltinDocumentFormatting,
  type GitEditorDiffResponse,
  type GitEditorDiffHunk,
  type GitEditorBlameLine,
  GIT_EDITOR_BLAME_MAX_LINES,
  type EditorM7WatchEvent,
  MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS,
  MANAGED_LSP_SEMANTIC_TOKEN_TYPES,
  matchingEditorM7Snippets,
  type EditorCompletionSource,
  type ManagedLspSemanticTokenLegend,
  type EditorM7WorkspaceSnippetSnapshot,
  type WorkspaceReplaceApplyFile,
  type WorkspaceReplacePreviewTextRange,
} from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS,
  EDITOR_AGENT_SCHEMA_VERSION,
  type EditorAgentDiagnosticsDetail,
  type EditorAgentRootBinding,
  isEditorAgentActiveBufferActionType,
} from "@oscharko-dev/keiko-contracts/editor-agent";
import conflictStyles from "./EditorConflicts.module.css";
import runtimeStyles from "./EditorRuntimeWidget.module.css";
import {
  ApiError,
  fetchEditorLanguageCapabilities,
  postEditorAgentSessionSnapshot,
  fetchFilesContent,
  fetchGitStatus,
  fetchGitStructuredDiff,
  fetchGitBlame,
  reportEditorInlineCompletionTelemetry,
  requestEditorCompletion,
  requestEditorCodeActions,
  requestEditorDefinition,
  requestEditorTypeDefinition,
  requestEditorImplementation,
  requestEditorCallHierarchy,
  requestEditorInlayHints,
  requestEditorSemanticTokens,
  requestEditorDiagnostics,
  requestEditorFormatting,
  requestEditorHover,
  requestEditorInlineCompletion,
  requestEditorReferences,
  requestEditorRenameApply,
  requestEditorRenamePrepare,
  requestEditorSignatureHelp,
  requestEditorSymbols,
  requestEditorTestGeneration,
  saveFilesContent,
} from "../../../../../lib/api";
import { useLocale, useTranslate } from "../../../../../lib/i18n";
import { mapWireToEditorCompletionResponse } from "../../../../../lib/editor-completion";
import { mapWireToEditorInlineCompletionResponse } from "../../../../../lib/editor-inline-completion";
import { mapWireToEditorTestGenerationOutcome } from "../../../../../lib/editor-test-generation";
import {
  mapWireToEditorDiagnosticsResponse,
  mapWireToEditorDefinitionResponse,
  mapWireToEditorCallHierarchyResponse,
  mapWireToEditorInlayHintsResponse,
  mapWireToEditorFormattingResponse,
  mapWireToEditorHoverResponse,
  mapWireToEditorCodeActionsResponse,
  mapWireToEditorReferencesResponse,
  mapWireToEditorSignatureHelpResponse,
  mapWireToEditorSymbolsResponse,
} from "../../../../../lib/editor-language";
import type {
  EditorAgentAction,
  EditorAgentActionResult,
  EditorAgentActionResultRequest,
  EditorAgentSnapshotResponse,
  EditorAgentPaneSnapshot,
  EditorCompletionContextSelectors,
  EditorDocumentVersion,
  FilesContentResponse,
  LanguageProviderDescriptor,
  LanguageRenameChangeset,
  LanguageRenameChangesetFile,
  LanguageServiceCapabilities,
  EditorTestGenerationWireTarget,
} from "../../../../../lib/types";
import type { OpenEditorFileRequest, OpenEditorFileResult } from "../../hooks/useWorkspace.types";
import { Icons } from "../../Icons";

import { useDialogTabTrap } from "../../hooks/useDialogTabTrap";
import { useModalInteractionLock } from "../../hooks/useModalInteractionLock";
import { useEditorThemeVariant } from "../../hooks/useEditorThemeVariant";
import {
  useRegisterWorkspaceReplaceBuffer,
  type WorkspaceReplaceOpenBufferResult,
} from "../../WorkspaceReplaceBufferContext";
import { FileIcon } from "../shared/projectTree";
import { AgentConflictBanner, type AgentConflictCode } from "./AgentConflictBanner";
import { EditorAgentActionsPanel } from "./EditorAgentActionsPanel";
import {
  IDLE_EXTERNAL_CHANGE_STATE,
  editorExternalChangeReducer,
  type EditorExternalChangeState,
} from "./editorExternalChangeState";
import { useEditorSettings } from "./useEditorSettings";
import { useWorkspaceSnippets } from "./useWorkspaceSnippets";
import { useEditorVerificationRun } from "./useEditorVerificationRun";
import { useWorkspaceWatch } from "./useWorkspaceWatch";
import {
  EDITOR_BUFFER_RECONCILIATION_REQUEST_EVENT,
  editorBufferReconciliationRequestDetail,
} from "./editor-buffer-reconciliation-events";
import { removePaneDiagnostics, setPaneDiagnostics } from "./editorProblemsStore";
import { useEditorAgentTranslate, type EditorAgentTranslate } from "./editor-agent-i18n";
import {
  postEditorAgentResult,
  postEditorAgentResultRequest,
  useEditorAgentBridge,
  type EditorAgentActionControllers,
} from "./editorAgentBridge";
import { buildEditorAgentChangesetPatch } from "./editorAgentChangeset";
import EditorDiffSurface from "./EditorDiffSurface";
import type { EditorFileHistoryPanelProps } from "./EditorFileHistoryPanel";
import type { EditorSurfaceProps } from "./EditorSurface";
import {
  createEditorSemanticTokensHost,
  type EditorSemanticTokensQuery,
  type EditorSemanticTokensResolver,
} from "./editorSemanticTokens";
import { EditorBreadcrumbBar } from "./EditorBreadcrumbBar";
import { EditorGitHunkPeek } from "./EditorGitHunkPeek";
import {
  editorLanguageIntelligenceStatus,
  useEditorLanguageIntelligenceTranslate,
} from "./editor-language-intelligence-i18n";
import { useEditorSourceControlTranslate } from "./editor-source-control-i18n";
import {
  GIT_REPOSITORY_STATE_INVALIDATED_EVENT,
  gitRepositoryStateInvalidationRoots,
} from "./git-repository-state-events";
import { notifyWorkspaceFileMutated } from "./workspace-file-events";
import {
  buildEditorOutlineTree,
  findContainingOutlinePath,
  type EditorOutlineRevealRequest,
  type EditorOutlineSnapshot,
} from "./editorOutlineModel";
import {
  deleteEditorHotExitSnapshot,
  readEditorHotExitSnapshot,
  writeEditorHotExitSnapshot,
} from "./editorHotExitStore";
import { LruSessionCache } from "./editorSessionCache";
import { readableTabCapacity, visibleTabsForCapacity } from "./editorTabViewport";
import type {
  EditorAgentReconciliationEntry,
  EditorAgentReconciliationRequest,
} from "./editorAgentReconciliationQueue";
import { normalizeEditorFile } from "./editorPaneGeometry";
import {
  captureEditorSelection,
  type EditorSelectionAskRequest,
  type EditorSelectionHandoff,
} from "./editorSelectionHandoff";
import {
  documentSessionKey,
  documentUri,
  encodePathSegments,
  rootHash,
  safeDomIdSegment,
} from "./editorDocumentUri";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const EditorIcon = Icons.editor;

const RestoreIcon = Icons.restore;

const EditorSurface = dynamic<EditorSurfaceProps>(() => import("./EditorSurface"), {
  ssr: false,
  loading: () => <div className="ed-host-loading" aria-hidden="true" />,
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

type EditorAgentPresenceKind = "detached" | "idle" | "active" | "review";

interface EditorAgentPresenceView {
  readonly color: string;
  readonly kind: EditorAgentPresenceKind;
  readonly label: string;
}

// Issue #2120: presence labels are localized via `t`; do not reintroduce hardcoded English literals.
function editorAgentPresenceView(args: {
  readonly inFlightActionCount: number;
  readonly recentlyActive: boolean;
  readonly reviewPendingCount: number;
  readonly t: EditorAgentTranslate;
}): EditorAgentPresenceView {
  const { t } = args;
  if (args.reviewPendingCount > 0) {
    return {
      color: "var(--feedback-warning)",
      kind: "review",
      label: args.recentlyActive ? t("presence.review.active") : t("presence.review.idle"),
    };
  }
  if (!args.recentlyActive) {
    return {
      color: "var(--text-secondary)",
      kind: "detached",
      label: t("presence.detached"),
    };
  }
  if (args.inFlightActionCount > 0) {
    return {
      color: "var(--accent)",
      kind: "active",
      label:
        args.inFlightActionCount === 1
          ? t("presence.active.one")
          : t("presence.active.many", { count: args.inFlightActionCount }),
    };
  }
  return {
    color: "var(--feedback-success)",
    kind: "idle",
    label: t("presence.idle"),
  };
}

function EditorAgentPresenceIndicator(props: {
  readonly inFlightActionCount: number;
  readonly recentlyActive: boolean;
  readonly reviewPendingCount: number;
  readonly t: EditorAgentTranslate;
}): ReactNode {
  const view = editorAgentPresenceView(props);
  return (
    <div
      aria-atomic="true"
      aria-live="polite"
      data-presence-state={view.kind}
      data-testid="agent-presence-indicator"
      style={EDITOR_AGENT_PRESENCE_STYLE}
    >
      <span
        aria-hidden="true"
        style={{ ...EDITOR_AGENT_PRESENCE_MARKER_STYLE, background: view.color }}
      />
      <span>{view.label}</span>
    </div>
  );
}

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

// Issue #1202: advisory coding-context budget for a test-generation run; the BFF clamps it to the
// server-owned `test-generation` purpose budget.
const TEST_GENERATION_CONTEXT_BUDGET_BYTES = 65_536;
// Content-free transport-failure message; the editor stays usable after a failed run.
const TEST_GENERATION_FAILURE_MESSAGE =
  "Test generation could not be reached. The editor is still usable.";
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
 * #2347 replaces this consumption seam with its server-resolved, minimum-wins capability result.
 * This slice deliberately cannot infer authorization from the browser-visible workspace root.
 */
export const DEFAULT_DEBUG_CAPABILITY_ENABLED = false;

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
  readonly changedFileCount: number;
  readonly truncated: boolean;
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
  readonly agentRootBinding?: EditorAgentRootBinding | undefined;
  readonly file?: string;
  readonly openFiles?: readonly string[] | undefined;
  readonly revealLineStart?: number | undefined;
  readonly revealLineEnd?: number | undefined;
  readonly revealRequestId?: string | undefined;
  readonly dirtyFiles?: readonly string[] | undefined;
  readonly onAskSelection?: ((handoff: EditorSelectionHandoff) => boolean) | undefined;
  readonly onSelectOpenFile?: ((file: string) => void) | undefined;
  readonly onSplitPane?: ((paneId: string, direction: "row" | "column") => void) | undefined;
  readonly onMoveTab?: ((fromPaneId: string, file: string, toPaneId: string) => void) | undefined;
  readonly onCloseOpenFile?: ((file: string) => Promise<boolean> | boolean | void) | undefined;
  readonly onDirtyChange?: ((file: string, dirty: boolean) => void) | undefined;
  readonly openEditorFile?: ((request: OpenEditorFileRequest) => OpenEditorFileResult) | undefined;
  readonly onOpenGitCommit?: ((root: string, commit: string) => void) | undefined;
  readonly onOpenGitDiff?: ((root: string, path: string) => void) | undefined;
  readonly externalSaveRequest?: EditorExternalSaveRequest | undefined;
  readonly onExternalSaveComplete?:
    ((requestId: number, paneId: string, file: string, ok: boolean) => void) | undefined;
  readonly agentReconciliationRequest?: EditorAgentReconciliationRequest | undefined;
  readonly onAgentChangesetCommitted?:
    ((entries: readonly EditorAgentReconciliationEntry[]) => void) | undefined;
  readonly onAgentReconciliationComplete?:
    ((requestId: number, paneId: string) => void) | undefined;
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

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
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

function rangeToAgentRange(range: EditorRange | null): {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
} | null {
  if (range === null) return null;
  return {
    start: { line: range.start.line, character: range.start.column },
    end: { line: range.end.line, character: range.end.column },
  };
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

function agentDiagnosticsDetail(
  diagnostics: readonly EditorDiagnostic[],
): EditorAgentDiagnosticsDetail {
  let truncated = diagnostics.length > EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS;
  const items = diagnostics.slice(0, EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS).map((diagnostic) => {
    const message = diagnosticMessagePrefix(diagnostic.message);
    truncated ||= message.truncated;
    return {
      severity: diagnostic.severity,
      range: {
        start: { line: diagnostic.range.start.line, character: diagnostic.range.start.column },
        end: { line: diagnostic.range.end.line, character: diagnostic.range.end.column },
      },
      message: message.text,
    };
  });
  return { items, truncated };
}

interface EditorFileSessionSnapshot {
  readonly content: string;
  readonly fileModel: EditorFileModel | null;
  readonly modifiedAt: number | null;
  readonly version: EditorDocumentVersion | null;
  readonly maxBytes: number | null;
  readonly loadState: KeikoEditorLoadState;
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

/**
 * Build a minimal, synthetic {@link PatchPreviewModel} for an agent applyPatch pending review
 * (Issue #1394, ADR-0058 D3). The model is not derived from a patch diff string; it is built
 * directly from the pre-computed original and modified text so that the KeikoDiffEditor can render
 * the diff without any browser-side patch parsing.
 */
function buildAgentPatchDiffModel(
  original: string,
  modified: string,
  filePath: string | undefined,
): PatchPreviewModel {
  const uri = filePath ?? "agent-patch";
  const language = inferMonacoLanguageId(filePath ?? "");
  const hasChanges = original !== modified;
  return {
    patchId: "agent-patch-pending",
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

type AgentPreparedChangeset = NonNullable<NonNullable<EditorAgentAction["changeset"]>["prepared"]>;
type AgentPreparedChangesetFile = AgentPreparedChangeset["files"][number];

interface AgentChangesetReviewState {
  readonly action: EditorAgentAction;
  readonly model: PatchPreviewModel;
  readonly applying: boolean;
}

interface AgentPatchReviewState {
  readonly action: EditorAgentAction;
  readonly original: string;
  readonly modified: string;
  readonly applying: boolean;
}

interface AgentReviewDecisionIntent {
  readonly actionKey: string;
  readonly decision: "accept" | "reject";
}

interface BoundedActionMemory {
  readonly order: string[];
  readonly values: Set<string>;
}

type ChangesetSourceResult =
  | { readonly status: "ready"; readonly sources: Readonly<Record<string, PatchPreviewSource>> }
  | {
      readonly status: "failed" | "conflict";
      readonly message: string;
      readonly conflictCode?: AgentConflictCode | undefined;
    };

type ChangesetFileSourceResult =
  | { readonly status: "ready"; readonly source: PatchPreviewSource }
  | Exclude<ChangesetSourceResult, { readonly status: "ready" }>;

const AGENT_CHANGESET_ACTION_MEMORY_LIMIT = 128;

function normalizeAgentChangesetPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

function runtimeAgentTargetMatches(
  action: EditorAgentAction,
  activeFile: string | undefined,
  activePaneId: string | undefined,
): boolean {
  if (!isEditorAgentActiveBufferActionType(action.type)) return true;
  if (activeFile === undefined) return false;
  const claimedFile = action.target?.file;
  const claimedPane = action.target?.paneId;
  return (
    (claimedFile === undefined ||
      normalizeAgentChangesetPath(claimedFile) === normalizeAgentChangesetPath(activeFile)) &&
    (claimedPane === undefined || (activePaneId !== undefined && claimedPane === activePaneId))
  );
}

function runtimeAgentWritePreconditionMatches(
  action: EditorAgentAction,
  activeContentHash: string | null,
): boolean {
  if (action.type === "applyChangeset") return true;
  const expectedHash =
    action.expectedContentHash ?? action.expectedDocumentVersion?.contentHash ?? null;
  return activeContentHash !== null && expectedHash !== null && activeContentHash === expectedHash;
}

function rememberAgentChangesetAction(memory: BoundedActionMemory, key: string): boolean {
  if (memory.values.has(key)) return false;
  memory.values.add(key);
  memory.order.push(key);
  while (memory.order.length > AGENT_CHANGESET_ACTION_MEMORY_LIMIT) {
    const evicted = memory.order.shift();
    if (evicted !== undefined) memory.values.delete(evicted);
  }
  return true;
}

function agentActionKey(action: EditorAgentAction): string {
  return `${action.sessionId}\u0000${action.actionId}`;
}

function agentResultKey(result: EditorAgentActionResult): string {
  return `${result.sessionId}\u0000${result.actionId}`;
}

function resultMatchesAction(result: EditorAgentActionResult, action: EditorAgentAction): boolean {
  return result.sessionId === action.sessionId && result.actionId === action.actionId;
}

function exactPatchTargetMatches(
  action: EditorAgentAction,
  activeFile: string | undefined,
  activePaneId: string | undefined,
): boolean {
  return (
    activeFile !== undefined &&
    activePaneId !== undefined &&
    action.target?.file !== undefined &&
    action.target.paneId === activePaneId &&
    normalizeAgentChangesetPath(action.target.file) === normalizeAgentChangesetPath(activeFile)
  );
}

function preparedChangesetForReview(action: EditorAgentAction): AgentPreparedChangeset | null {
  const changeset = action.changeset;
  const prepared = changeset?.prepared;
  if (changeset === undefined || prepared === undefined) return null;
  const declared = new Set(changeset.files.map((entry) => normalizeAgentChangesetPath(entry.file)));
  const preparedPaths = prepared.files.map((entry) => normalizeAgentChangesetPath(entry.file));
  if (declared.size !== preparedPaths.length) return null;
  if (preparedPaths.some((path) => !declared.has(path))) return null;
  const selected = changeset.selectedFiles?.map(normalizeAgentChangesetPath);
  if (selected === undefined) return prepared;
  const selectedPaths = new Set(selected);
  const files = prepared.files.filter((entry) =>
    selectedPaths.has(normalizeAgentChangesetPath(entry.file)),
  );
  return files.length === selectedPaths.size && files.length > 0 ? { files } : null;
}

function agentReviewDecisionRequest(
  action: EditorAgentAction,
  status: "succeeded" | "failed",
  message?: string,
): EditorAgentActionResultRequest {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    kind: "result",
    result: {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: action.actionId,
      sessionId: action.sessionId,
      ...(action.rootBinding === undefined
        ? {}
        : {
            rootAttribution: {
              rootRef: action.rootBinding.rootRef,
              rootIdentityDigest: action.rootBinding.rootIdentityDigest,
            },
          }),
      status,
      ...(message === undefined ? {} : { message }),
    },
  };
}

function succeededPreparedChangesetFiles(
  action: EditorAgentAction,
  result: EditorAgentActionResult,
): readonly AgentPreparedChangesetFile[] | null {
  const prepared = action.changeset?.prepared;
  if (result.status !== "succeeded" || prepared === undefined || result.files === undefined) {
    return null;
  }
  const statuses = new Map(
    result.files.map((entry) => [normalizeAgentChangesetPath(entry.file), entry]),
  );
  if (statuses.size !== prepared.files.length) return null;
  for (const file of prepared.files) {
    const status = statuses.get(normalizeAgentChangesetPath(file.file))?.status;
    if (status !== "succeeded" && status !== "not-selected") return null;
  }
  return prepared.files.filter(
    (file) => statuses.get(normalizeAgentChangesetPath(file.file))?.status === "succeeded",
  );
}

function completeChangesetPreview(model: PatchPreviewModel, expectedFiles: number): boolean {
  return (
    model.fileCount === expectedFiles &&
    model.totalFileCount === expectedFiles &&
    model.omittedFileCount === 0 &&
    model.unsupportedCount === 0 &&
    model.binaryCount === 0 &&
    !model.truncated &&
    model.files.every((entry) => entry.diffable && !entry.truncated)
  );
}

function changesetSourceExceedsLimit(content: string, maxBytes: number | null): boolean {
  return maxBytes !== null && UTF8_ENCODER.encode(content).length > maxBytes;
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

function activeDigestHash(
  digest: { readonly content: string; readonly hash: string } | null,
  content: string,
): string | null {
  return digest?.content === content ? digest.hash : null;
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

function canRunEditorTestGeneration(
  hasTarget: boolean,
  completionEnabled: boolean,
  loadReady: boolean,
  busy: boolean,
): boolean {
  return hasTarget && completionEnabled && loadReady && !busy;
}

function testGenerationStatusLabel(
  state: Parameters<typeof describeTestGenerationStatus>[0],
  statusText: string,
): string {
  return state.kind === "disabled" ? "Tests off" : statusText;
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

function paneCanSubscribe(activePaneId: string | undefined, paneId: string | undefined): boolean {
  return paneId === undefined || activePaneId === undefined || paneId === activePaneId;
}

function pendingAgentReviewCount(
  patch: AgentPatchReviewState | null,
  changeset: AgentChangesetReviewState | null,
): number {
  return (
    Number(patch !== null && !patch.applying) + Number(changeset !== null && !changeset.applying)
  );
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

function editorLoadErrorMessage(hasTarget: boolean, state: KeikoEditorLoadState): string | null {
  return hasTarget && state.status === "error" ? state.message : null;
}

function EditorRuntimeWidget({
  windowId,
  sessionActive = true,
  paneId,
  activePaneId,
  layoutPanes,
  root,
  agentRootBinding,
  file,
  revealLineStart,
  revealLineEnd,
  revealRequestId,
  openFiles,
  dirtyFiles,
  onAskSelection,
  onSelectOpenFile,
  onSplitPane,
  onMoveTab,
  onCloseOpenFile,
  onDirtyChange,
  openEditorFile,
  onOpenGitCommit,
  onOpenGitDiff,
  externalSaveRequest,
  onExternalSaveComplete,
  agentReconciliationRequest,
  onAgentChangesetCommitted,
  onAgentReconciliationComplete,
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
      disposeEditorModelRegistryRoot(previousRoot, "root-disposed");
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
          if (liveEditorRuntimeInstances === 0) disposeAllUnattachedEditorModels("shutdown");
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
  const agentSessionId = useMemo(
    () => `${safeDomIdSegment(windowId ?? generatedId)}:${rootHash(root ?? "")}`,
    [generatedId, root, windowId],
  );
  const [diagnosticsDetail, setDiagnosticsDetail] = useState<EditorAgentDiagnosticsDetail>();
  // Issue #2212 fix-up — the diff-review "Run Verification" intent is scoped to the file(s) the
  // active review surface is actually reviewing, never to the pane's currently active file. This
  // matters most for `agentChangesetPending`/rename review: both can legitimately touch a file other
  // than the one open in the pane (`runtimeAgentTargetMatches` deliberately bypasses the active-file
  // match for `applyChangeset`), so resolving from the pane's active file would silently verify the
  // wrong file. `applyPatch` review's target always equals the active file by construction
  // (`runtimeAgentTargetMatches` requires it for admission), so it is scoped explicitly here too for
  // consistency and to stay correct if that invariant ever changes. `reviewedFiles` singular resolves
  // to that file's test counterpart; a multi-file review (or none) falls back to a workspace typecheck
  // rather than guessing which single file represents "the reviewed change".
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
        setDiagnosticsDetail(agentDiagnosticsDetail(diagnostics));
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
  // GEN-UI-INTERACTION-003: the Tests/Format/Save toolbar buttons stay in the tab order with
  // aria-disabled (not native disabled) and guard their onClick internally, so activating one while
  // unavailable is a silent no-op. This holds a brief spoken reason surfaced in the polite live region
  // below so keyboard/screen-reader users learn why nothing happened.
  const [toolbarNotice, setToolbarNotice] = useState("");
  const [mergeConflicts, setMergeConflicts] = useState({ count: 0, truncated: false });
  useEffect(() => setMergeConflicts({ count: 0, truncated: false }), [file]);
  // Issue #2234 (ADR-0127): content-free workspace change-count backing the agent snapshot's
  // gitContextSummary. Event-driven only (root change, save, explicit refresh) — mirrors the
  // gutter's own refresh triggers so this never becomes a polling loop.
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
          setWorkspaceGitSummary({
            requestedRoot: root,
            changedFileCount: status.changes.length,
            truncated: status.truncated,
            repositoryRoot: status.repositoryRoot ?? status.root,
          });
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
  const [testGenState, dispatchTestGen] = useReducer<
    TestGenerationFlowState,
    [TestGenerationFlowAction]
  >(testGenerationReducer, IDLE_TEST_GENERATION_STATE);
  const testGenSeqRef = useRef(0);
  const testGenAbortRef = useRef<AbortController | null>(null);
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
  const [activeContentDigest, setActiveContentDigest] = useState<{
    readonly content: string;
    readonly hash: string;
  } | null>(null);
  // Issue #1394 (ADR-0058 D3/D4): conflict banner and applyPatch review state.
  const [agentConflict, setAgentConflict] = useState<{
    readonly code: AgentConflictCode;
    readonly message: string;
  } | null>(null);
  const [agentPatchPending, setAgentPatchPending] = useState<AgentPatchReviewState | null>(null);
  const [agentChangesetPending, setAgentChangesetPending] =
    useState<AgentChangesetReviewState | null>(null);
  const agentPatchPendingRef = useRef<AgentPatchReviewState | null>(null);
  agentPatchPendingRef.current = agentPatchPending;
  const agentChangesetPendingRef = useRef<AgentChangesetReviewState | null>(null);
  agentChangesetPendingRef.current = agentChangesetPending;
  const agentPatchActiveActionRef = useRef<string | null>(null);
  const agentPatchAutomaticRef = useRef<AgentPatchReviewState | null>(null);
  const agentChangesetActiveActionRef = useRef<string | null>(null);
  const agentChangesetAutomaticRef = useRef<EditorAgentAction | null>(null);
  const agentChangesetSeenRef = useRef<BoundedActionMemory>({ order: [], values: new Set() });
  const agentPatchDecisionRef = useRef<BoundedActionMemory>({ order: [], values: new Set() });
  const agentChangesetDecisionRef = useRef<BoundedActionMemory>({ order: [], values: new Set() });
  const agentPatchSettlementRef = useRef<BoundedActionMemory>({ order: [], values: new Set() });
  const agentChangesetSettlementRef = useRef<BoundedActionMemory>({
    order: [],
    values: new Set(),
  });
  const agentPatchDecisionIntentRef = useRef<AgentReviewDecisionIntent | null>(null);
  const agentChangesetDecisionIntentRef = useRef<AgentReviewDecisionIntent | null>(null);
  const agentTerminalResultHandlerRef = useRef<(result: EditorAgentActionResult) => void>(() => {});
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
  // Issue #2212 fix-up — one scoped "Run Verification" callback per review surface, each resolving its
  // OWN reviewed file(s) rather than the pane's active file (see runScopedVerification above).
  const runChangesetVerification = useCallback((): void => {
    const files = agentChangesetPending?.action.changeset?.files.map((f) => f.file) ?? [];
    runScopedVerification(files);
  }, [agentChangesetPending, runScopedVerification]);
  const runPatchVerification = useCallback((): void => {
    const targetFile = agentPatchPending?.action.target?.file;
    runScopedVerification(targetFile === undefined ? [] : [targetFile]);
  }, [agentPatchPending, runScopedVerification]);
  const runRenameVerification = useCallback((): void => {
    const files = renameReview?.changeset.files.map((f) => f.path) ?? [];
    runScopedVerification(files);
  }, [renameReview, runScopedVerification]);
  const [activeHostEditRequest, setActiveHostEditRequest] = useState<
    EditorHostEditRequest | undefined
  >(undefined);
  // A11Y-2: focus the Accept button whenever a patch review appears.
  const patchAcceptButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (agentPatchPending !== null && !agentPatchPending.applying) {
      patchAcceptButtonRef.current?.focus();
    }
  }, [agentPatchPending]);
  const activeSessionKeyRef = useRef<string | null>(null);
  // Bounded LRU (Issue 2.8): evict the least-recently-used snapshot on overflow, but never the active
  // file, a mid-save, or a dirty buffer — those are the background-tab save-correctness invariants.
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
  const contentBytes = useMemo(() => UTF8_ENCODER.encode(content), [content]);
  const contentSizeBytes = contentBytes.length;
  const activeContentHash = activeDigestHash(activeContentDigest, content);
  const activeContentDigestRef = useRef(activeContentDigest);
  activeContentDigestRef.current = activeContentDigest;
  const lastHotExitSnapshotKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setCurrentSelection(null);
    setCursor(null);
    setDiagnosticsSummary(null);
    setDiagnosticsDetail(undefined);
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
      void sha256HexBytes(contentBytes, content).then((hash) => {
        if (!cancelled) setActiveContentDigest({ content, hash });
      });
    }, CONTENT_HASH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [content, contentBytes]);

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

  useEffect(
    () => () => {
      testGenAbortRef.current?.abort();
    },
    [],
  );

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
      const generation = workspaceWatchGenerationRef.current;
      if (generation.root !== root || generation.file !== file) return;
      const contentAtStart = contentRef.current;
      if (root !== undefined && file !== undefined && workspaceWatchEventTouchesPath(event, file)) {
        setGitGutterPeek(null);
        setGitGutterRefreshNonce((value) => value + 1);
        setDiagnosticsSummary(null);
        setDiagnosticsDetail(undefined);
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
    if (maxBytes !== null && contentSizeBytes > maxBytes) return;
    if (activeContentHash === null) return;
    const timer = window.setTimeout(() => {
      const snapshot: EditorHotExitSnapshotV1 = {
        schemaVersion: EDITOR_HOT_EXIT_SCHEMA_VERSION,
        workspaceRoot: root,
        relativePath: file,
        content,
        baseVersion: version,
        contentHash: activeContentHash,
        savedContentHash: version?.contentHash ?? null,
        updatedAt: Date.now(),
        paneId: paneId ?? "pane-1",
        windowId: windowId ?? "editor",
      };
      lastHotExitSnapshotKeyRef.current = snapshotKey;
      dropHotExitPersistenceFailure(writeEditorHotExitSnapshot(snapshot));
    }, HOT_EXIT_WRITE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeContentHash,
    content,
    contentSizeBytes,
    dirty,
    file,
    fileModelMatchesTarget,
    hasTarget,
    maxBytes,
    paneId,
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
    setSaveStatus(cached.saveStatus);
    setSaveError(cached.saveError);
    setLocalHistoryProtection(cached.localHistoryProtection);
    setCursor(cached.cursor);
    setCurrentSelection(cached.currentSelection);
    setDiagnosticsSummary(cached.diagnosticsSummary);
  }, []);

  const beginLoad = useCallback((): void => {
    setLoadState({ status: "loading" });
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
      try {
        const response = await fetchFilesContent(root, file);
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
        setLoadState({ status: "error", message: errorMessage(err) });
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
      dropHotExitPersistenceFailure(deleteEditorHotExitSnapshot(root, file));
    }
    reload();
  }, [reload, root, file]);

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
  useModalInteractionLock({ active: reloadConfirm, initialFocusRef: reloadConfirmRef });
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
      await deleteHotExitSnapshotBestEffort(targetRoot, targetFile);
    },
    [],
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
    [],
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
        setAgentConflict({
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
      // edit, an agent patch) the buffer no longer holds that text, so the newer state is left alone.
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
    // A non-fatal theme-registration failure (e.g. the editor design tokens are not present on this
    // surface). The editor still renders with Monaco's base theme; surface it for diagnostics rather
    // than swallowing a system-boundary signal. Routed through the one client sink so the console
    // access stays in a single reviewable place (0.3.0 audit, #2802).
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
      dropHotExitPersistenceFailure(deleteEditorHotExitSnapshot(root, file));
    }
    setRecoverySnapshot(null);
    setRecoveryDiskBaseline(null);
    setRecoveryCompare(false);
  }, [file, root]);

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
          editorSessionId: agentSessionId,
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
      agentSessionId,
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
          editorSessionId: agentSessionId,
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
    [
      agentSessionId,
      file,
      hasTarget,
      linkedCapsuleIds,
      linkedCapsuleSetIds,
      linkedFilePath,
      linkedRoot,
      root,
    ],
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

  const cancelTestGeneration = useCallback((): void => {
    testGenAbortRef.current?.abort();
    testGenAbortRef.current = null;
    dispatchTestGen({ type: "cancel" });
  }, []);

  // Issue #1202: trigger governed unit-test generation for the current file or reliable selection. The host owns the
  // gated BFF call; the editor package owns the flow reducer (run status, stale-response discard) and,
  // when a candidate is eventually produced (wave 2), the diff-review surface. In v1 the server returns
  // `disabled`/`deferred`, so this surfaces a content-free status and the editor stays usable.
  const runTestGeneration = useCallback((): void => {
    if (!hasTarget || root === undefined || file === undefined || fileModel === null) {
      return;
    }
    if (
      loadState.status !== "ready" ||
      isTestGenerationBusy(testGenState) ||
      !providerOperationEnabled(
        providerForLanguage(languageCapabilities, fileModel.identity.language),
        "completion",
      )
    ) {
      return;
    }
    testGenAbortRef.current?.abort();
    const abortController = new AbortController();
    testGenAbortRef.current = abortController;
    const sequence = (testGenSeqRef.current += 1);
    const requestIdentity: EditorRequestIdentity = {
      requestId: createEditorRequestId(),
      streamId: "editor-test-generation",
      sequence,
    };
    const document = {
      path: file,
      languageId: fileModel.identity.language,
      text: contentRef.current,
    };
    const target: EditorTestGenerationWireTarget =
      currentSelection === null
        ? { kind: "file", document }
        : {
            kind: "selection",
            document,
            range: {
              start: {
                line: currentSelection.start.line,
                character: currentSelection.start.column,
              },
              end: { line: currentSelection.end.line, character: currentSelection.end.column },
            },
          };
    const selectors = completionContextSelectors({
      root,
      file,
      text: contentRef.current,
      line: 0,
      character: 0,
      linkedRoot,
      linkedFilePath,
      linkedCapsuleIds,
      linkedCapsuleSetIds,
    });
    dispatchTestGen({ type: "request", requestId: requestIdentity.requestId });
    void requestEditorTestGeneration(
      {
        root,
        editorSessionId: agentSessionId,
        target,
        contextBudgetBytes: TEST_GENERATION_CONTEXT_BUDGET_BYTES,
        ...(selectors === undefined ? {} : { context: selectors }),
      },
      abortController.signal,
    )
      .then((wire) => {
        dispatchTestGen({
          type: "resolve",
          outcome: mapWireToEditorTestGenerationOutcome(requestIdentity, wire),
        });
      })
      .catch(() => {
        if (abortController.signal.aborted) {
          dispatchTestGen({ type: "cancel" });
          return;
        }
        dispatchTestGen({ type: "error", reason: TEST_GENERATION_FAILURE_MESSAGE });
      })
      .finally(() => {
        if (testGenAbortRef.current === abortController) {
          testGenAbortRef.current = null;
        }
      });
  }, [
    agentSessionId,
    currentSelection,
    file,
    fileModel,
    hasTarget,
    languageCapabilities,
    linkedCapsuleIds,
    linkedCapsuleSetIds,
    linkedFilePath,
    linkedRoot,
    loadState.status,
    root,
    testGenState,
  ]);

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
    () => deriveLargeFileMode({ sizeBytes: contentSizeBytes, text: content }),
    [content, contentSizeBytes],
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
      resolve: async () => {
        const [staged, unstaged] = await Promise.all([
          fetchGitStructuredDiff({ root, path: file, scope: "staged" }),
          fetchGitStructuredDiff({ root, path: file, scope: "unstaged" }),
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
  useEffect(() => {
    if (!diagnosticsEnabled) setDiagnosticsDetail(undefined);
  }, [diagnosticsEnabled]);
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

  // Issue #1202: the "Generate Tests" action is offered for governed TS/JS files; the server is the
  // authority and returns `disabled` while the wave-2 feature is switched off. The status line reflects
  // the flow reducer (a content-free message); a busy run disables the action.
  const testGenBusy = isTestGenerationBusy(testGenState);
  const canGenerateTests = canRunEditorTestGeneration(
    hasTarget,
    completionEnabled,
    loadState.status === "ready",
    testGenBusy,
  );
  const testGenStatusText = describeTestGenerationStatus(testGenState);
  const testGenStatusLabel = testGenerationStatusLabel(testGenState, testGenStatusText);

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
  const handleAskSelection = useCallback(
    (selection: EditorSelectionAskRequest): void => {
      const relativeFile =
        root === undefined || file === undefined ? "" : normalizeEditorFile(root, file);
      const captured = captureEditorSelection(relativeFile, selection);
      if (!captured.ok) {
        announceToolbarNotice(t("editor.askSelection.selectText"));
        return;
      }
      if (relativeFile.length === 0 || onAskSelection === undefined) {
        announceToolbarNotice(t("editor.askSelection.chatUnavailable"));
        return;
      }
      if (!onAskSelection(captured.handoff)) {
        announceToolbarNotice(t("editor.askSelection.openFailed"));
      }
    },
    [announceToolbarNotice, file, onAskSelection, root, t],
  );
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
              sizeBytes: contentSizeBytes,
              truncated: false,
            },
          },
    [content, contentSizeBytes, editorReadOnlyBySettings, file, fileModel, fileModelMatchesTarget],
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
          setAgentConflict(sources.conflict);
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
  const currentTestGenerationPreview = (): TestGenerationPreview | null => {
    if (!isTestGenerationPreviewing(testGenState) || buffer === null) return null;
    return buildTestGenerationPreview({
      result: testGenState.result,
      assurance: testGenState.assurance,
      sources: { [buffer.content.relativePath]: { content: buffer.content } },
    });
  };
  const testGenerationPreview = currentTestGenerationPreview();
  const hasActiveAgentReview = (): boolean =>
    externalChange.compareOpen ||
    recoveryCompare ||
    agentPatchPending !== null ||
    agentChangesetPending !== null ||
    renameReview !== null ||
    testGenerationPreview !== null;
  const agentReviewActive = hasActiveAgentReview();
  const agentReviewActiveRef = useRef(agentReviewActive);
  agentReviewActiveRef.current = agentReviewActive;

  const loadAgentChangesetFileSource = useCallback(
    async (entry: AgentPreparedChangesetFile): Promise<ChangesetFileSourceResult> => {
      if (entry.kind === "create") {
        return { status: "ready", source: patchPreviewSourceFromText(entry.file, "") };
      }
      if (entry.file === file) {
        if (dirtyRef.current) {
          return {
            status: "conflict",
            conflictCode: "DIRTY",
            message: `Changeset target ${entry.file} has unsaved changes.`,
          };
        }
        return {
          status: "ready",
          source: patchPreviewSourceFromText(entry.file, contentRef.current),
        };
      }
      if (root === undefined) return { status: "failed", message: "Workspace is unavailable." };
      const cached = sessionCacheRef.current.get(documentSessionKey(root, entry.file));
      if (cached?.fileModel !== null && cached?.fileModel !== undefined) {
        if (isDocumentDirty(cached.fileModel)) {
          return {
            status: "conflict",
            conflictCode: "DIRTY",
            message: `Changeset target ${entry.file} has unsaved changes.`,
          };
        }
        if (changesetSourceExceedsLimit(cached.content, cached.maxBytes)) {
          return {
            status: "failed",
            message: `Changeset target ${entry.file} is read-only in the editor.`,
          };
        }
        if (cached.loadState.status === "ready") {
          return {
            status: "ready",
            source: patchPreviewSourceFromText(entry.file, cached.content),
          };
        }
      }
      const response = await fetchFilesContent(root, entry.file);
      if (normalizeAgentChangesetPath(response.path) !== normalizeAgentChangesetPath(entry.file)) {
        return { status: "failed", message: "Changeset source did not match its target." };
      }
      if (changesetSourceExceedsLimit(response.content, response.maxBytes)) {
        return {
          status: "failed",
          message: `Changeset target ${entry.file} is read-only in the editor.`,
        };
      }
      return {
        status: "ready",
        source: patchPreviewSourceFromText(entry.file, response.content),
      };
    },
    [file, root],
  );

  const loadAgentChangesetSources = useCallback(
    async (prepared: AgentPreparedChangeset): Promise<ChangesetSourceResult> => {
      if (root === undefined) return { status: "failed", message: "Workspace is unavailable." };
      const sources: Record<string, PatchPreviewSource> = {};
      for (const entry of prepared.files) {
        const result = await loadAgentChangesetFileSource(entry);
        if (result.status !== "ready") return result;
        sources[entry.file] = result.source;
      }
      return { status: "ready", sources };
    },
    [loadAgentChangesetFileSource, root],
  );

  // Issue #1205: derive the unified status-bar view model from host state. Diagnostics are surfaced
  // only for governed source files (where the deterministic language service runs); the
  // test-generation flow feeds the compact "run" field. The cursor is rendered but never announced
  // (it changes per keystroke) — only meaningful state (save, problems, run) reaches the live region.
  const buildStatusBarViewModel = (): ReturnType<typeof deriveEditorStatusBar> | null => {
    if (fileModel === null) return null;
    const selectedLineCount =
      currentSelection === null
        ? undefined
        : currentSelection.end.line - currentSelection.start.line + 1;
    const fallbackRun: EditorStatusRun | undefined =
      testGenStatusLabel.length === 0
        ? undefined
        : { label: testGenStatusLabel, busy: testGenBusy };
    const statusBarRun = verification.statusBarRun ?? fallbackRun;
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
      ...(statusBarRun === undefined ? {} : { run: statusBarRun }),
      ...(debugSessionState === null
        ? {}
        : { debug: { state: debugSessionState, isExceptionPause: debugPauseIsException } }),
    });
  };
  const statusBarViewModel = buildStatusBarViewModel();
  const shouldShowUnifiedStatusBar = (): boolean =>
    testGenerationPreview === null &&
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

  const effectiveAgentPaneId = definedOr(activePaneId, definedOr(paneId, "pane-1"));
  const shouldSubscribeToAgentActions = paneCanSubscribe(activePaneId, paneId);
  const agentDocumentVersion = useMemo(
    () =>
      version === null
        ? null
        : {
            ...version,
            modifiedAt: Math.max(0, Math.round(version.modifiedAt)),
          },
    [version],
  );

  // GEN-PERF-EDITOR-002 — the JSON signature of the last snapshot we actually POSTed, so an
  // unchanged snapshot (identical cursor/selection/dirty/etc.) is not re-sent.
  const lastPostedSnapshotSignatureRef = useRef<string | null>(null);

  // Issue #1392 — post the current pane snapshot to the BFF. Wrapped in `useCallback` so the bridge
  // hook's register effect re-fires exactly when a snapshot dimension changes (its identity is the
  // dependency). Registration is best-effort and must never affect editing.
  const registerAgentSnapshot = useCallback(
    (bridgeDecisionCapability: string | undefined): Promise<EditorAgentSnapshotResponse | void> => {
      if (!hasTarget || root === undefined || file === undefined || activeContentHash === null)
        return Promise.resolve();
      const snapshot = {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        sessionId: agentSessionId,
        windowId: windowId ?? "editor",
        workspaceRoot: root,
        ...(agentRootBinding === undefined ? {} : { rootBinding: agentRootBinding }),
        activePaneId: effectiveAgentPaneId,
        panes: layoutPanes ?? [
          {
            paneId: paneId ?? "pane-1",
            activeFile: file,
            openFiles: documentTabs,
          },
        ],
        dirtyFiles: effectiveDirtyFiles.size > 0 ? [...effectiveDirtyFiles] : [],
        activeFile: file,
        cursor: cursor === null ? null : { line: cursor.line, character: cursor.column },
        selection: rangeToAgentRange(currentSelection),
        diagnosticsSummary,
        ...(diagnosticsDetail === undefined ? {} : { diagnosticsDetail }),
        // Issue #1379 AC4 (ADR-0067 D6): content-free language-provider availability for the active
        // file, derived from the descriptor we already computed. The synthetic id:"none" maps to
        // providerId:null for honesty; null overall when there is no active language.
        languageCapability:
          completionLanguage === undefined
            ? null
            : {
                languageId: completionLanguage,
                providerId:
                  languageProvider !== null && languageProvider.id !== "none"
                    ? languageProvider.id
                    : null,
                available: languageProvider?.availability === "available",
                ...(languageProvider?.unavailableReason !== undefined
                  ? { unavailableReason: languageProvider.unavailableReason }
                  : {}),
              },
        // Issue #2234 (ADR-0127): content-free Git awareness. hasConflictMarkers reflects the
        // active file's live merge-conflict count (already tracked for the status bar/tab badge);
        // changedFileCount/truncated come from the same workspace status read the file tree and
        // Git window use. root is already guaranteed defined by the early return above.
        gitContextSummary: {
          hasConflictMarkers: mergeConflicts.count > 0,
          changedFileCount: activeWorkspaceGitSummary?.changedFileCount ?? 0,
          truncated: mergeConflicts.truncated || (activeWorkspaceGitSummary?.truncated ?? false),
        },
        ...(agentDocumentVersion === null ? {} : { documentVersion: agentDocumentVersion }),
        activeFileContentHash: activeContentHash,
        textMode: "none" as const,
      };
      // GEN-PERF-EDITOR-002 — dedupe: skip the POST when every snapshot dimension is
      // identical to the last one we sent (the debounce upstream collapses bursts; this
      // additionally suppresses re-posting an unchanged snapshot). `updatedAt` is stamped
      // only when we actually send, so it never falsely defeats the equality check.
      const signature = JSON.stringify(snapshot);
      if (signature === lastPostedSnapshotSignatureRef.current) return Promise.resolve();
      lastPostedSnapshotSignatureRef.current = signature;
      return postEditorAgentSessionSnapshot(
        { ...snapshot, updatedAt: Date.now() },
        bridgeDecisionCapability,
      ).catch(() => {
        if (lastPostedSnapshotSignatureRef.current === signature) {
          lastPostedSnapshotSignatureRef.current = null;
        }
      });
    },
    [
      activeContentHash,
      agentRootBinding,
      agentSessionId,
      currentSelection,
      cursor,
      completionLanguage,
      diagnosticsSummary,
      diagnosticsDetail,
      documentTabs,
      effectiveAgentPaneId,
      effectiveDirtyFiles,
      agentDocumentVersion,
      file,
      hasTarget,
      languageProvider,
      layoutPanes,
      mergeConflicts,
      paneId,
      root,
      windowId,
      activeWorkspaceGitSummary,
    ],
  );

  const verifyActiveAgentTarget = useCallback(
    (action: EditorAgentAction): boolean =>
      runtimeAgentTargetMatches(action, file, effectiveAgentPaneId),
    [effectiveAgentPaneId, file],
  );
  const verifyAgentWritePrecondition = useCallback((action: EditorAgentAction): boolean => {
    const digest = activeContentDigestRef.current;
    const currentHash = digest?.content === contentRef.current ? digest.hash : null;
    return runtimeAgentWritePreconditionMatches(action, currentHash);
  }, []);
  const verifyExactPatchTarget = useCallback(
    (action: EditorAgentAction): boolean =>
      exactPatchTargetMatches(action, file, effectiveAgentPaneId),
    [effectiveAgentPaneId, file],
  );

  const prepareAgentChangesetReview = useCallback(
    async (action: EditorAgentAction, prepared: AgentPreparedChangeset): Promise<void> => {
      const actionKey = agentActionKey(action);
      let staged = false;
      try {
        const sourceResult = await loadAgentChangesetSources(prepared);
        if (sourceResult.status !== "ready") {
          postEditorAgentResult(
            action,
            sourceResult.status,
            sourceResult.message,
            sourceResult.conflictCode,
          );
          return;
        }
        const patch = buildEditorAgentChangesetPatch({
          actionId: action.actionId,
          prepared,
        });
        const model = buildPatchPreview({
          patch,
          sources: sourceResult.sources,
        });
        if (!completeChangesetPreview(model, prepared.files.length)) {
          postEditorAgentResult(action, "failed", "Changeset preview is incomplete or truncated.");
          return;
        }
        if (
          agentChangesetSettlementRef.current.values.has(actionKey) ||
          agentChangesetActiveActionRef.current !== actionKey
        ) {
          return;
        }
        if (agentReviewActiveRef.current || agentPatchActiveActionRef.current !== null) {
          postEditorAgentResult(action, "failed", "Another editor review is already active.");
          return;
        }
        const review = { action, model, applying: false };
        agentChangesetPendingRef.current = review;
        setAgentChangesetPending(review);
        staged = true;
      } catch (error) {
        postEditorAgentResult(
          action,
          "failed",
          error instanceof Error ? error.message : "Changeset review could not be prepared.",
        );
      } finally {
        if (!staged && agentChangesetActiveActionRef.current === actionKey) {
          agentChangesetActiveActionRef.current = null;
        }
      }
    },
    [loadAgentChangesetSources],
  );

  const clearAutomaticAgentChangeset = useCallback((action: EditorAgentAction): void => {
    const actionKey = agentActionKey(action);
    const automatic = agentChangesetAutomaticRef.current;
    if (automatic !== null && agentActionKey(automatic) === actionKey) {
      agentChangesetAutomaticRef.current = null;
    }
    if (agentChangesetActiveActionRef.current === actionKey) {
      agentChangesetActiveActionRef.current = null;
    }
  }, []);

  const clearAutomaticAgentPatch = useCallback((action: EditorAgentAction): void => {
    const actionKey = agentActionKey(action);
    const automatic = agentPatchAutomaticRef.current;
    if (automatic !== null && agentActionKey(automatic.action) === actionKey) {
      agentPatchAutomaticRef.current = null;
    }
    if (agentPatchActiveActionRef.current === actionKey) {
      agentPatchActiveActionRef.current = null;
    }
  }, []);

  const confirmAutomaticAgentPatch = useCallback(
    (action: EditorAgentAction): void => {
      void postEditorAgentResultRequest(action, agentReviewDecisionRequest(action, "succeeded"))
        .then((response) => {
          if (
            response.result.status === "queued" ||
            !resultMatchesAction(response.result, action)
          ) {
            clearAutomaticAgentPatch(action);
            announceToolbarNotice(t("editor.agentReview.unconfirmed"));
            return;
          }
          agentTerminalResultHandlerRef.current(response.result);
        })
        .catch(() => announceToolbarNotice(t("editor.agentReview.awaitingResult")));
    },
    [announceToolbarNotice, clearAutomaticAgentPatch, t],
  );

  const confirmAutomaticAgentChangeset = useCallback(
    (action: EditorAgentAction): void => {
      void postEditorAgentResultRequest(action, agentReviewDecisionRequest(action, "succeeded"))
        .then((response) => {
          if (
            response.result.status === "queued" ||
            !resultMatchesAction(response.result, action)
          ) {
            clearAutomaticAgentChangeset(action);
            announceToolbarNotice(t("editor.agentReview.unconfirmed"));
            return;
          }
          agentTerminalResultHandlerRef.current(response.result);
        })
        .catch(() => announceToolbarNotice(t("editor.agentReview.awaitingResult")));
    },
    [announceToolbarNotice, clearAutomaticAgentChangeset, t],
  );

  const applyAgentChangesetAction = useCallback(
    (action: EditorAgentAction): void => {
      const actionKey = agentActionKey(action);
      if (!rememberAgentChangesetAction(agentChangesetSeenRef.current, actionKey)) return;
      const prepared = preparedChangesetForReview(action);
      if (prepared === null) {
        postEditorAgentResult(action, "failed", "Missing or malformed prepared changeset.");
        return;
      }
      if (largeFileDegraded) {
        postEditorAgentResult(action, "failed", "Editor is read-only; cannot apply agent edits.");
        return;
      }
      if (
        agentReviewActiveRef.current ||
        agentPatchActiveActionRef.current !== null ||
        agentChangesetActiveActionRef.current !== null
      ) {
        postEditorAgentResult(action, "failed", "Another editor review is already active.");
        return;
      }
      agentChangesetActiveActionRef.current = actionKey;
      if (action.requiresReview === false) {
        agentChangesetAutomaticRef.current = action;
        confirmAutomaticAgentChangeset(action);
        return;
      }
      void prepareAgentChangesetReview(action, prepared);
    },
    [confirmAutomaticAgentChangeset, largeFileDegraded, prepareAgentChangesetReview],
  );

  // Issue #1394 (ADR-0058 D3): apply text edits, guarded for read-only/large-file buffers (AC4 risk #5).
  const applyAgentTextEditsAction = useCallback(
    (action: EditorAgentAction): void => {
      if (!verifyActiveAgentTarget(action)) {
        postEditorAgentResult(
          action,
          "conflict",
          "Action target does not match the active editor buffer.",
          "OUT_OF_SCOPE",
        );
        return;
      }
      if (action.textEdits === undefined) {
        postEditorAgentResult(action, "failed", "Missing text edits.");
        return;
      }
      if (largeFileDegraded) {
        postEditorAgentResult(action, "failed", "Editor is read-only; cannot apply agent edits.");
        return;
      }
      const mapped = action.textEdits.map((edit) => ({
        range: {
          start: { line: edit.range.start.line, column: edit.range.start.character },
          end: { line: edit.range.end.line, column: edit.range.end.character },
        },
        newText: edit.newText,
      }));
      try {
        // F2: compute BEFORE setContent so OverlappingPatchEditError is caught by this try/catch.
        const next = applyTextEditsToText(contentRef.current, mapped);
        contentRef.current = next;
        setContent(next);
        setFileModel((model) =>
          model === null
            ? model
            : editorFileModelReducer(model, { type: "edited", origin: "applied-patch" }),
        );
        setSaveStatus((status) => saveStatusReducer(status, { type: "edited" }));
        postEditorAgentResult(action, "succeeded");
      } catch (error) {
        // OverlappingPatchEditError is not re-exported by @oscharko-dev/keiko-editor; identify by name.
        const isOverlap = error instanceof Error && error.name === "OverlappingPatchEditError";
        if (isOverlap) {
          postEditorAgentResult(action, "conflict", error.message, "INVALID_EDITS");
        } else {
          postEditorAgentResult(
            action,
            "failed",
            error instanceof Error ? error.message : "Action failed.",
          );
        }
      }
    },
    [largeFileDegraded, verifyActiveAgentTarget],
  );

  // Issue #1394 (ADR-0058 D3): applyPatch — server pre-validates and emits concrete textEdits.
  // Legacy or policy-reviewed actions enter review; explicitly allowed actions apply immediately.
  const applyAgentPatchAction = useCallback(
    (action: EditorAgentAction): void => {
      if (!verifyExactPatchTarget(action)) {
        postEditorAgentResult(
          action,
          "conflict",
          "Action target does not match the active editor buffer.",
          "OUT_OF_SCOPE",
        );
        return;
      }
      if (action.textEdits === undefined || action.textEdits.length === 0) {
        postEditorAgentResult(action, "failed", "Patch could not be prepared for review.");
        return;
      }
      if (largeFileDegraded) {
        postEditorAgentResult(action, "failed", "Editor is read-only; cannot apply agent edits.");
        return;
      }
      if (
        agentReviewActiveRef.current ||
        agentPatchActiveActionRef.current !== null ||
        agentChangesetActiveActionRef.current !== null
      ) {
        postEditorAgentResult(action, "failed", "Another editor review is already active.");
        return;
      }
      const mapped = action.textEdits.map((edit) => ({
        range: {
          start: { line: edit.range.start.line, column: edit.range.start.character },
          end: { line: edit.range.end.line, column: edit.range.end.character },
        },
        newText: edit.newText,
      }));
      try {
        const original = contentRef.current;
        const modified = applyTextEditsToText(original, mapped);
        const review = { action, original, modified, applying: false };
        agentPatchActiveActionRef.current = agentActionKey(action);
        if (action.requiresReview === false) {
          agentPatchAutomaticRef.current = review;
          confirmAutomaticAgentPatch(action);
          return;
        }
        agentPatchPendingRef.current = review;
        setAgentPatchPending(review);
      } catch (error) {
        const isOverlap = error instanceof Error && error.name === "OverlappingPatchEditError";
        postEditorAgentResult(
          action,
          isOverlap ? "conflict" : "failed",
          error instanceof Error ? error.message : "Patch application failed.",
          isOverlap ? "INVALID_EDITS" : undefined,
        );
      }
    },
    [confirmAutomaticAgentPatch, largeFileDegraded, verifyExactPatchTarget],
  );

  // Issue #1393 (ADR-0061 D2): the controller bundle the pure dispatcher calls. The two layout
  // controllers (onSplitPane/onMoveTab) are injected by EditorWidget; they are undefined when this
  // pane is rendered standalone, and the dispatcher then answers a structured provider-unavailable
  // failure. The setSelection controller is owned by the bridge hook (it drives hook state), so it is
  // left undefined here and merged in by the hook.
  const agentControllers = useMemo<EditorAgentActionControllers>(
    () => ({
      paneId,
      activePaneId: effectiveAgentPaneId,
      activeFile: file,
      verifyActiveTarget: verifyActiveAgentTarget,
      verifyWritePrecondition: verifyAgentWritePrecondition,
      onSelectOpenFile,
      formattingEnabled,
      formatRequest: { increment: () => setFormatRequestNonce((value) => value + 1) },
      persist,
      currentText: () => contentRef.current,
      applyTextEdits: applyAgentTextEditsAction,
      applyPatch: applyAgentPatchAction,
      applyChangeset: applyAgentChangesetAction,
      onSplitPane,
      onMoveTab,
      onRequestSelectionReveal: undefined,
    }),
    [
      applyAgentPatchAction,
      applyAgentChangesetAction,
      applyAgentTextEditsAction,
      effectiveAgentPaneId,
      file,
      formattingEnabled,
      onMoveTab,
      onSelectOpenFile,
      onSplitPane,
      paneId,
      persist,
      verifyActiveAgentTarget,
      verifyAgentWritePrecondition,
    ],
  );

  // Issue #1395 — bump on any agent activity so the recent-actions audit panel re-fetches its feed.
  const [auditRefreshNonce, setAuditRefreshNonce] = useState(0);
  const handleBridgeTerminalResult = useCallback((result: EditorAgentActionResult): void => {
    agentTerminalResultHandlerRef.current(result);
  }, []);
  const handleBridgeConflict = useCallback(
    (conflict: { readonly code: AgentConflictCode }): void => {
      setAgentConflict({ code: conflict.code, message: t("editor.agentReview.conflict") });
    },
    [t],
  );
  const { agentSelectionRequest, bridgeState, consumeSelectionRequest } = useEditorAgentBridge({
    agentSessionId,
    controllers: agentControllers,
    enabled: shouldSubscribeToAgentActions,
    registerSnapshot: registerAgentSnapshot,
    onConflict: handleBridgeConflict,
    onAgentActivity: () => setAuditRefreshNonce((nonce) => nonce + 1),
    onTerminalResult: handleBridgeTerminalResult,
  });
  // Issue #2120 (ADR-0058 through ADR-0062): only staged, undecided reviews are labelled as
  // requiring a human decision. Generic in-flight bridge actions remain ordinary activity.
  const agentReviewPendingCount = pendingAgentReviewCount(agentPatchPending, agentChangesetPending);

  const adoptActiveChangesetResponse = useCallback(
    (path: string, response: FilesContentResponse): void => {
      if (root === undefined || activeSessionKeyRef.current !== documentSessionKey(root, path)) {
        return;
      }
      const snapshot = cleanEditorSessionSnapshot({
        root,
        path,
        modelScope: editorModelScope,
        response,
      });
      contentRef.current = response.content;
      setContent(response.content);
      setFileModel(snapshot.fileModel);
      setModifiedAt(response.modifiedAt);
      setVersion(response.session.version);
      setMaxBytes(response.maxBytes);
      setLocalHistoryProtection(response.localHistoryProtection);
      setLoadState({ status: "ready" });
      setSaveStatus("idle");
      setSaveError(undefined);
      setRecoverySnapshot(null);
      setRecoveryCompare(false);
      setRecoveryDiskBaseline(null);
      setActiveHostEditRequest(undefined);
    },
    [editorModelScope, root],
  );

  const reconcileAgentChangesetDeletion = useCallback(
    async (path: string): Promise<string | null> => {
      if (root === undefined) return "Workspace is unavailable after changeset commit.";
      const sessionKey = documentSessionKey(root, path);
      const cached = sessionCacheRef.current.get(sessionKey);
      const cachedDirty =
        cached?.fileModel !== null && cached?.fileModel !== undefined
          ? isDocumentDirty(cached.fileModel)
          : false;
      if ((activeSessionKeyRef.current === sessionKey && dirtyRef.current) || cachedDirty) {
        return `Committed deletion ${path} has newer unsaved editor changes.`;
      }
      sessionCacheRef.current.delete(sessionKey);
      onDirtyChange?.(path, false);
      await deleteHotExitSnapshotBestEffort(root, path);
      if (documentTabs.includes(path)) {
        if (onCloseOpenFile === undefined) {
          return `Committed deletion ${path} could not be closed in this editor.`;
        }
        try {
          const closed = await onCloseOpenFile(path);
          if (closed === false) return `Committed deletion ${path} could not be closed.`;
        } catch {
          return `Committed deletion ${path} could not be closed.`;
        }
      }
      return null;
    },
    [documentTabs, onCloseOpenFile, onDirtyChange, root],
  );

  const reconcileAgentChangesetFile = useCallback(
    async (entry: EditorAgentReconciliationEntry): Promise<string | null> => {
      if (entry.kind === "delete") return reconcileAgentChangesetDeletion(entry.file);
      if (root === undefined) return "Workspace is unavailable after changeset commit.";
      const sessionKey = documentSessionKey(root, entry.file);
      const cached = sessionCacheRef.current.get(sessionKey);
      const cachedDirty =
        cached?.fileModel !== null && cached?.fileModel !== undefined
          ? isDocumentDirty(cached.fileModel)
          : false;
      if ((entry.file === file && dirtyRef.current) || cachedDirty) {
        return `Committed file ${entry.file} has newer unsaved editor changes.`;
      }
      try {
        const response = await fetchFilesContent(root, entry.file);
        if (
          normalizeAgentChangesetPath(response.path) !== normalizeAgentChangesetPath(entry.file)
        ) {
          return `Committed file ${entry.file} returned mismatched metadata.`;
        }
        const latestCached = sessionCacheRef.current.get(sessionKey);
        const latestCachedDirty =
          latestCached?.fileModel !== null && latestCached?.fileModel !== undefined
            ? isDocumentDirty(latestCached.fileModel)
            : false;
        if ((activeSessionKeyRef.current === sessionKey && dirtyRef.current) || latestCachedDirty) {
          return `Committed file ${entry.file} has newer unsaved editor changes.`;
        }
        const snapshot = cleanEditorSessionSnapshot({
          root,
          path: entry.file,
          modelScope: editorModelScope,
          response,
        });
        sessionCacheRef.current.set(sessionKey, snapshot);
        adoptActiveChangesetResponse(entry.file, response);
        onDirtyChange?.(entry.file, false);
        await deleteHotExitSnapshotBestEffort(root, entry.file);
        return null;
      } catch {
        return `Committed file ${entry.file} could not be refreshed from disk.`;
      }
    },
    [
      adoptActiveChangesetResponse,
      editorModelScope,
      file,
      onDirtyChange,
      reconcileAgentChangesetDeletion,
      root,
    ],
  );

  const reconcileAgentChangeset = useCallback(
    async (entries: readonly EditorAgentReconciliationEntry[]): Promise<readonly string[]> => {
      const failures: string[] = [];
      for (const entry of entries) {
        const failure = await reconcileAgentChangesetFile(entry);
        if (failure !== null) failures.push(failure);
      }
      return failures;
    },
    [reconcileAgentChangesetFile],
  );

  useEffect(() => {
    if (
      agentReconciliationRequest === undefined ||
      paneId === undefined ||
      onAgentReconciliationComplete === undefined
    ) {
      return;
    }
    let active = true;
    const applicable = agentReconciliationRequest.entries.filter((entry) =>
      documentTabs.includes(entry.file),
    );
    const reconcile =
      applicable.length === 0 ? Promise.resolve([]) : reconcileAgentChangeset(applicable);
    void reconcile
      .then((failures) => {
        if (active && failures.length > 0) {
          setAgentConflict({
            code: "VERSION_MISMATCH",
            message: t("editor.agentReview.reconcileFailed"),
          });
        }
      })
      .catch(() => {
        if (active) {
          setAgentConflict({
            code: "VERSION_MISMATCH",
            message: t("editor.agentReview.reconcileFailed"),
          });
        }
      })
      .finally(() => {
        if (active) onAgentReconciliationComplete(agentReconciliationRequest.requestId, paneId);
      });
    return () => {
      active = false;
    };
  }, [
    agentReconciliationRequest,
    documentTabs,
    onAgentReconciliationComplete,
    paneId,
    reconcileAgentChangeset,
    t,
  ]);

  const notifyAgentChangesetCommitted = useCallback(
    (entries: readonly AgentPreparedChangesetFile[]): void => {
      onAgentChangesetCommitted?.(entries.map((entry) => ({ file: entry.file, kind: entry.kind })));
    },
    [onAgentChangesetCommitted],
  );

  const clearAgentPatchReview = useCallback((action: EditorAgentAction): void => {
    const actionKey = agentActionKey(action);
    if (agentPatchPendingRef.current !== null) {
      const currentKey = agentActionKey(agentPatchPendingRef.current.action);
      if (currentKey === actionKey) agentPatchPendingRef.current = null;
    }
    setAgentPatchPending((current) =>
      current !== null && agentActionKey(current.action) === actionKey ? null : current,
    );
    if (agentPatchActiveActionRef.current === actionKey) agentPatchActiveActionRef.current = null;
    if (agentPatchDecisionIntentRef.current?.actionKey === actionKey) {
      agentPatchDecisionIntentRef.current = null;
    }
  }, []);

  const clearAgentChangesetReview = useCallback((action: EditorAgentAction): void => {
    const actionKey = agentActionKey(action);
    if (agentChangesetPendingRef.current !== null) {
      const currentKey = agentActionKey(agentChangesetPendingRef.current.action);
      if (currentKey === actionKey) agentChangesetPendingRef.current = null;
    }
    setAgentChangesetPending((current) =>
      current !== null && agentActionKey(current.action) === actionKey ? null : current,
    );
    if (agentChangesetActiveActionRef.current === actionKey) {
      agentChangesetActiveActionRef.current = null;
    }
    if (agentChangesetDecisionIntentRef.current?.actionKey === actionKey) {
      agentChangesetDecisionIntentRef.current = null;
    }
  }, []);

  const beginAgentPatchDecision = useCallback(
    (review: AgentPatchReviewState, decision: "accept" | "reject"): boolean => {
      const actionKey = agentActionKey(review.action);
      if (!rememberAgentChangesetAction(agentPatchDecisionRef.current, actionKey)) return false;
      agentPatchDecisionIntentRef.current = { actionKey, decision };
      const applying = { ...review, applying: true };
      agentPatchPendingRef.current = applying;
      setAgentPatchPending(applying);
      return true;
    },
    [],
  );

  const beginAgentChangesetDecision = useCallback(
    (review: AgentChangesetReviewState, decision: "accept" | "reject"): boolean => {
      const actionKey = agentActionKey(review.action);
      if (!rememberAgentChangesetAction(agentChangesetDecisionRef.current, actionKey)) return false;
      agentChangesetDecisionIntentRef.current = { actionKey, decision };
      const applying = { ...review, applying: true };
      agentChangesetPendingRef.current = applying;
      setAgentChangesetPending(applying);
      return true;
    },
    [],
  );

  const surfaceAgentReviewResult = useCallback(
    (result: EditorAgentActionResult, decision: "accept" | "reject" | undefined): void => {
      if (decision === "reject" && result.status === "failed" && result.failure === undefined) {
        announceToolbarNotice(t("editor.agentReview.rejected"));
      } else if (result.failure?.code === "TIMED_OUT") {
        announceToolbarNotice(t("editor.agentReview.timedOut"));
      } else if (result.status === "conflict" && result.conflict !== undefined) {
        setAgentConflict({
          code: result.conflict.code,
          message: t("editor.agentReview.conflict"),
        });
      } else {
        announceToolbarNotice(t("editor.agentReview.failed"));
      }
    },
    [announceToolbarNotice, t],
  );

  const commitSettledAgentPatch = useCallback(
    (review: AgentPatchReviewState): boolean => {
      if (
        largeFileDegraded ||
        !verifyExactPatchTarget(review.action) ||
        contentRef.current !== review.original
      ) {
        setAgentConflict({ code: "VERSION_MISMATCH", message: t("editor.agentReview.stale") });
        return false;
      }
      contentRef.current = review.modified;
      setContent(review.modified);
      setFileModel((model) =>
        model === null
          ? model
          : editorFileModelReducer(model, { type: "edited", origin: "applied-patch" }),
      );
      setSaveStatus((status) => saveStatusReducer(status, { type: "edited" }));
      setActiveHostEditRequest({
        id: createEditorRequestId(),
        text: review.modified,
        origin: "applied-patch",
      });
      return true;
    },
    [largeFileDegraded, t, verifyExactPatchTarget],
  );

  const settleAutomaticAgentPatchResult = useCallback(
    (result: EditorAgentActionResult): boolean => {
      const review = agentPatchAutomaticRef.current;
      if (review === null || !resultMatchesAction(result, review.action)) return false;
      const actionKey = agentResultKey(result);
      rememberAgentChangesetAction(agentPatchSettlementRef.current, actionKey);
      if (result.status !== "succeeded") {
        clearAutomaticAgentPatch(review.action);
        surfaceAgentReviewResult(result, undefined);
        return true;
      }
      commitSettledAgentPatch(review);
      clearAutomaticAgentPatch(review.action);
      return true;
    },
    [clearAutomaticAgentPatch, commitSettledAgentPatch, surfaceAgentReviewResult],
  );

  const settleAutomaticAgentChangesetResult = useCallback(
    (result: EditorAgentActionResult): boolean => {
      const action = agentChangesetAutomaticRef.current;
      if (action === null || !resultMatchesAction(result, action)) return false;
      const actionKey = agentResultKey(result);
      rememberAgentChangesetAction(agentChangesetSettlementRef.current, actionKey);
      if (result.status !== "succeeded") {
        clearAutomaticAgentChangeset(action);
        surfaceAgentReviewResult(result, undefined);
        return true;
      }
      const succeeded = succeededPreparedChangesetFiles(action, result);
      if (succeeded === null || succeeded.length === 0) {
        setAgentConflict({ code: "INVALID_EDITS", message: t("editor.agentReview.failed") });
        clearAutomaticAgentChangeset(action);
        return true;
      }
      notifyAgentChangesetCommitted(succeeded);
      void reconcileAgentChangeset(succeeded)
        .then((failures) => {
          if (failures.length > 0) {
            setAgentConflict({
              code: "VERSION_MISMATCH",
              message: t("editor.agentReview.reconcileFailed"),
            });
          }
        })
        .catch(() => {
          setAgentConflict({
            code: "VERSION_MISMATCH",
            message: t("editor.agentReview.reconcileFailed"),
          });
        })
        .finally(() => clearAutomaticAgentChangeset(action));
      return true;
    },
    [
      clearAutomaticAgentChangeset,
      notifyAgentChangesetCommitted,
      reconcileAgentChangeset,
      surfaceAgentReviewResult,
      t,
    ],
  );

  const settleAgentPatchResult = useCallback(
    (result: EditorAgentActionResult): boolean => {
      const actionKey = agentResultKey(result);
      if (agentPatchSettlementRef.current.values.has(actionKey)) return true;
      if (settleAutomaticAgentPatchResult(result)) return true;
      const review = agentPatchPendingRef.current;
      if (review === null || !resultMatchesAction(result, review.action)) return false;
      const intent = agentPatchDecisionIntentRef.current;
      if (result.status !== "succeeded") {
        rememberAgentChangesetAction(agentPatchSettlementRef.current, actionKey);
        clearAgentPatchReview(review.action);
        surfaceAgentReviewResult(result, intent?.decision);
        return true;
      }
      if (intent?.actionKey !== actionKey || intent.decision !== "accept" || !review.applying) {
        rememberAgentChangesetAction(agentPatchSettlementRef.current, actionKey);
        clearAgentPatchReview(review.action);
        announceToolbarNotice(t("editor.agentReview.unexpectedSuccess"));
        return true;
      }
      rememberAgentChangesetAction(agentPatchSettlementRef.current, actionKey);
      commitSettledAgentPatch(review);
      clearAgentPatchReview(review.action);
      return true;
    },
    [
      announceToolbarNotice,
      clearAgentPatchReview,
      commitSettledAgentPatch,
      settleAutomaticAgentPatchResult,
      surfaceAgentReviewResult,
      t,
    ],
  );

  const settleAgentChangesetResult = useCallback(
    (result: EditorAgentActionResult): boolean => {
      const actionKey = agentResultKey(result);
      if (agentChangesetSettlementRef.current.values.has(actionKey)) return true;
      const review = agentChangesetPendingRef.current;
      if (review === null || !resultMatchesAction(result, review.action)) {
        if (settleAutomaticAgentChangesetResult(result)) return true;
        if (agentChangesetActiveActionRef.current !== actionKey) return false;
        rememberAgentChangesetAction(agentChangesetSettlementRef.current, actionKey);
        agentChangesetActiveActionRef.current = null;
        if (result.status === "succeeded") {
          announceToolbarNotice(t("editor.agentReview.unexpectedSuccess"));
        } else {
          surfaceAgentReviewResult(result, undefined);
        }
        return true;
      }
      const intent = agentChangesetDecisionIntentRef.current;
      if (result.status !== "succeeded") {
        rememberAgentChangesetAction(agentChangesetSettlementRef.current, actionKey);
        clearAgentChangesetReview(review.action);
        surfaceAgentReviewResult(result, intent?.decision);
        return true;
      }
      if (intent?.actionKey !== actionKey || intent.decision !== "accept" || !review.applying) {
        rememberAgentChangesetAction(agentChangesetSettlementRef.current, actionKey);
        clearAgentChangesetReview(review.action);
        announceToolbarNotice(t("editor.agentReview.unexpectedSuccess"));
        return true;
      }
      rememberAgentChangesetAction(agentChangesetSettlementRef.current, actionKey);
      const succeeded = succeededPreparedChangesetFiles(review.action, result);
      if (succeeded === null || succeeded.length === 0) {
        setAgentConflict({ code: "INVALID_EDITS", message: t("editor.agentReview.failed") });
        clearAgentChangesetReview(review.action);
        return true;
      }
      notifyAgentChangesetCommitted(succeeded);
      void reconcileAgentChangeset(succeeded)
        .then((failures) => {
          if (failures.length > 0) {
            setAgentConflict({
              code: "VERSION_MISMATCH",
              message: t("editor.agentReview.reconcileFailed"),
            });
          }
        })
        .catch(() => {
          setAgentConflict({
            code: "VERSION_MISMATCH",
            message: t("editor.agentReview.reconcileFailed"),
          });
        })
        .finally(() => clearAgentChangesetReview(review.action));
      return true;
    },
    [
      announceToolbarNotice,
      clearAgentChangesetReview,
      notifyAgentChangesetCommitted,
      reconcileAgentChangeset,
      settleAutomaticAgentChangesetResult,
      surfaceAgentReviewResult,
      t,
    ],
  );

  const settleAgentTerminalResult = useCallback(
    (result: EditorAgentActionResult): void => {
      if (settleAgentPatchResult(result)) return;
      settleAgentChangesetResult(result);
    },
    [settleAgentChangesetResult, settleAgentPatchResult],
  );
  agentTerminalResultHandlerRef.current = settleAgentTerminalResult;

  const handlePatchDecisionPostError = useCallback(
    (action: EditorAgentAction, error: unknown): void => {
      const review = agentPatchPendingRef.current;
      if (review === null || agentActionKey(review.action) !== agentActionKey(action)) return;
      if (error instanceof ApiError && error.status === 409) {
        clearAgentPatchReview(action);
        announceToolbarNotice(t("editor.agentReview.unconfirmed"));
        return;
      }
      announceToolbarNotice(t("editor.agentReview.awaitingResult"));
    },
    [announceToolbarNotice, clearAgentPatchReview, t],
  );

  const handleChangesetDecisionPostError = useCallback(
    (action: EditorAgentAction, error: unknown): void => {
      const review = agentChangesetPendingRef.current;
      if (review === null || agentActionKey(review.action) !== agentActionKey(action)) return;
      if (error instanceof ApiError && error.status === 409) {
        clearAgentChangesetReview(action);
        announceToolbarNotice(t("editor.agentReview.unconfirmed"));
        return;
      }
      announceToolbarNotice(t("editor.agentReview.awaitingResult"));
    },
    [announceToolbarNotice, clearAgentChangesetReview, t],
  );

  const submitAgentPatchDecision = useCallback(
    (review: AgentPatchReviewState, decision: "accept" | "reject"): void => {
      if (!beginAgentPatchDecision(review, decision)) return;
      const status = decision === "accept" ? "succeeded" : "failed";
      const message = decision === "reject" ? t("editor.agentReview.rejected") : undefined;
      void postEditorAgentResultRequest(
        review.action,
        agentReviewDecisionRequest(review.action, status, message),
      )
        .then((response) => {
          if (
            response.result.status === "queued" ||
            !resultMatchesAction(response.result, review.action)
          ) {
            handlePatchDecisionPostError(review.action, new ApiError("RESULT_MISMATCH", "", 409));
            return;
          }
          settleAgentPatchResult(response.result);
        })
        .catch((error: unknown) => handlePatchDecisionPostError(review.action, error));
    },
    [beginAgentPatchDecision, handlePatchDecisionPostError, settleAgentPatchResult, t],
  );

  const submitAgentChangesetDecision = useCallback(
    (review: AgentChangesetReviewState, decision: "accept" | "reject"): void => {
      if (!beginAgentChangesetDecision(review, decision)) return;
      const status = decision === "accept" ? "succeeded" : "failed";
      const message = decision === "reject" ? t("editor.agentReview.rejected") : undefined;
      void postEditorAgentResultRequest(
        review.action,
        agentReviewDecisionRequest(review.action, status, message),
      )
        .then((response) => {
          if (
            response.result.status === "queued" ||
            !resultMatchesAction(response.result, review.action)
          ) {
            handleChangesetDecisionPostError(
              review.action,
              new ApiError("RESULT_MISMATCH", "", 409),
            );
            return;
          }
          settleAgentChangesetResult(response.result);
        })
        .catch((error: unknown) => handleChangesetDecisionPostError(review.action, error));
    },
    [beginAgentChangesetDecision, handleChangesetDecisionPostError, settleAgentChangesetResult, t],
  );

  const handleAgentChangesetAccept = useCallback((): void => {
    const review = agentChangesetPendingRef.current;
    if (review === null || review.applying) return;
    submitAgentChangesetDecision(review, "accept");
  }, [submitAgentChangesetDecision]);

  const handleAgentChangesetReject = useCallback((): void => {
    const review = agentChangesetPendingRef.current;
    if (review === null || review.applying) return;
    submitAgentChangesetDecision(review, "reject");
  }, [submitAgentChangesetDecision]);

  const recoveryDiskChanged = recoverySnapshotChanged(recoverySnapshot, version);

  // Issue #1394 (ADR-0058 D3): handlers for the agent-patch review Accept/Reject buttons.
  const handleAgentPatchAccept = useCallback((): void => {
    const review = agentPatchPendingRef.current;
    if (review === null || review.applying) return;
    const targetMatches = verifyExactPatchTarget(review.action);
    const contentMatches = contentRef.current === review.original;
    if (!targetMatches || !contentMatches || largeFileDegraded) {
      const code = !targetMatches || largeFileDegraded ? "OUT_OF_SCOPE" : "VERSION_MISMATCH";
      const message = t("editor.agentReview.stale");
      postEditorAgentResult(review.action, "conflict", message, code);
      setAgentConflict({ code, message });
      clearAgentPatchReview(review.action);
      return;
    }
    submitAgentPatchDecision(review, "accept");
  }, [
    clearAgentPatchReview,
    largeFileDegraded,
    submitAgentPatchDecision,
    t,
    verifyExactPatchTarget,
  ]);

  const handleAgentPatchReject = useCallback((): void => {
    const review = agentPatchPendingRef.current;
    if (review === null || review.applying) return;
    submitAgentPatchDecision(review, "reject");
  }, [submitAgentPatchDecision]);

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
        setAgentConflict({ code: plan.code, message: plan.message });
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

  // Issue #1393 (ADR-0061 D3): merge an agent setSelection request into the editor surface
  // revealRequest, mapping the contract LanguageRange (0-based, `character`) onto the editor's
  // EditorRange (0-based, `column`). Agent selection takes precedence over the line-based reveal; it
  // is consumed one-shot below so a stale agent selection never fights a later user-driven reveal.
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
    if (agentSelectionRequest !== null) {
      return {
        id: `agentAction:${agentSelectionRequest.actionId}`,
        range: {
          start: {
            line: agentSelectionRequest.selection.start.line,
            column: agentSelectionRequest.selection.start.character,
          },
          end: {
            line: agentSelectionRequest.selection.end.line,
            column: agentSelectionRequest.selection.end.character,
          },
        },
      };
    }
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
  useEffect(() => {
    if (agentSelectionRequest !== null) consumeSelectionRequest();
  }, [agentSelectionRequest, consumeSelectionRequest]);

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
  const editorLoadError = editorLoadErrorMessage(hasTarget, loadState);
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
   * recovered hot-exit buffer, an agent changeset, an agent patch, a rename the language service
   * produced, or generated tests — and each one owns the pane until it is accepted or dismissed.
   * The order is the precedence: the editor itself is only reached once all of them are clear.
   */
  const renderActiveReviewSurface = (): ReactNode => {
    if (externalCompareContent !== null) {
      const externalDiffModel = buildAgentPatchDiffModel(externalCompareContent, content, file);
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
      // unsaved buffer (right), reusing the same diff surface as agent-patch review. The disk side is
      // the baseline captured when recovery was offered, not the live buffer, so it stays accurate
      // even if the buffer was edited before Compare was opened.
      const recoveryDiffModel = buildAgentPatchDiffModel(
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
    if (agentChangesetPending !== null) {
      return (
        <div style={EDITOR_REVIEW_SURFACE_STYLE}>
          <fieldset
            aria-label="Agent changeset review"
            aria-busy={agentChangesetPending.applying}
            style={EDITOR_REVIEW_DIFF_GROUP_STYLE}
          >
            <span className="sr-only">
              Review every changed file before applying this agent changeset to disk.
            </span>
            <span className="sr-only" aria-live="polite">
              {agentChangesetPending.applying
                ? t("editor.agentReview.applying")
                : t("editor.agentReview.ready")}
            </span>
            <EditorDiffSurface
              model={agentChangesetPending.model}
              loadState={{ status: "ready" }}
              themeVariant={themeVariant}
              actions={{
                canApply: !agentChangesetPending.applying,
                canReject: !agentChangesetPending.applying,
                canRunVerification: !verification.verificationRunning,
              }}
              onApply={handleAgentChangesetAccept}
              onReject={handleAgentChangesetReject}
              onRunVerification={runChangesetVerification}
            />
          </fieldset>
        </div>
      );
    }
    if (agentPatchPending !== null) {
      const patchDiffModel = buildAgentPatchDiffModel(
        agentPatchPending.original,
        agentPatchPending.modified,
        file,
      );
      return (
        <div style={EDITOR_REVIEW_SURFACE_STYLE}>
          {/* A11Y-3: label the diff review surface and provide an sr-only instruction */}
          <fieldset
            aria-label={`Agent patch review for ${definedOr(agentPatchPending.action.target?.file, "this file")}`}
            aria-busy={agentPatchPending.applying}
            style={EDITOR_REVIEW_DIFF_GROUP_STYLE}
          >
            <span className="sr-only">
              Agent generated a patch. Review the changes and accept to apply or reject to discard.
            </span>
            <span className="sr-only" aria-live="polite">
              {agentPatchPending.applying
                ? t("editor.agentReview.applying")
                : t("editor.agentReview.ready")}
            </span>
            <EditorDiffSurface
              model={patchDiffModel}
              loadState={{ status: "ready" }}
              themeVariant={themeVariant}
            />
          </fieldset>
          <div className="ed-toolbar-actions" style={EDITOR_REVIEW_ACTIONS_STYLE}>
            {/* A11Y-1: explicit aria-labels; A11Y-2: ref for focus management */}
            <button
              ref={patchAcceptButtonRef}
              type="button"
              className="ed-save"
              data-testid="agent-patch-accept"
              aria-label="Accept agent patch and apply changes"
              disabled={agentPatchPending.applying}
              onClick={handleAgentPatchAccept}
            >
              Accept
            </button>
            <button
              type="button"
              className="ed-reload"
              data-testid="agent-patch-reject"
              aria-label="Reject agent patch and discard changes"
              disabled={agentPatchPending.applying}
              onClick={handleAgentPatchReject}
            >
              Reject
            </button>
            {/* Issue #2212 (ADR-0126) — activate the run-verification intent on this custom-button
              review surface (no built-in KeikoDiffEditor action bar here). Idle-gated. */}
            <button
              type="button"
              className="ed-reload"
              data-testid="agent-patch-run-verification"
              aria-label={commonT("editor.verification.runReviewedChangeLabel")}
              disabled={anyTrue(agentPatchPending.applying, verification.verificationRunning)}
              onClick={runPatchVerification}
            >
              {commonT("editor.verification.run")}
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
    if (testGenerationPreview !== null) {
      return (
        <EditorDiffSurface
          model={testGenerationPreview.model}
          loadState={{ status: "ready" }}
          themeVariant={themeVariant}
          actions={testGenerationPreview.actions}
          onReject={() => {
            dispatchTestGen({ type: "dismiss" });
          }}
        />
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
          <span>{`Editor failed to load: ${editorLoadError}`}</span>
          <button type="button" className="ed-reload" onClick={reload}>
            Retry
          </button>
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
              agentReview: agentReviewActive,
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
            onGenerateTests={whenEnabled(completionEnabled, runTestGeneration)}
            onAskKeikoAboutSelection={whenEnabled(onAskSelection !== undefined, handleAskSelection)}
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
        ×
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

  const handleGenerateTestsClick = (): void => {
    if (canGenerateTests) {
      runTestGeneration();
      return;
    }
    announceToolbarNotice(
      testGenBusy
        ? "Test generation is already running."
        : "Test generation is unavailable for this file.",
    );
  };

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

  const renderEditorToolbar = (): ReactNode => (
    <div className="ed-toolbar-actions">
      {toolbarExtras}
      {hasTarget && root !== undefined && file !== undefined && onOpenGitDiff !== undefined ? (
        <button
          type="button"
          className="ed-reload"
          onClick={() => onOpenGitDiff(root, file)}
          aria-label={sourceControlT("gitDiff.openLabel")}
        >
          {sourceControlT("gitDiff.open")}
        </button>
      ) : null}
      {hasTarget ? (
        <button
          type="button"
          className="ed-reload"
          aria-label={commonT("editor.fileHistory.open")}
          aria-expanded={fileHistoryOpen}
          onClick={() => setFileHistoryOpen((open) => !open)}
        >
          <RestoreIcon size={13} />
          {commonT("editor.fileHistory.title")}
        </button>
      ) : null}
      {hasTarget ? (
        <button
          type="button"
          className="ed-reload"
          onClick={() => {
            setGitGutterPeek(null);
            setGitGutterRefreshNonce((value) => value + 1);
          }}
          aria-label={sourceControlT("gitGutter.refreshLabel")}
        >
          {sourceControlT("gitGutter.refresh")}
        </button>
      ) : null}
      {hasTarget ? (
        <button
          type="button"
          className="ed-save ed-generate-tests"
          onClick={handleGenerateTestsClick}
          aria-disabled={canGenerateTests ? "false" : "true"}
        >
          Tests
        </button>
      ) : null}
      {testGenBusy ? (
        <button type="button" className="ed-reload" onClick={cancelTestGeneration}>
          Cancel
        </button>
      ) : null}
      {hasTarget ? (
        <button
          type="button"
          className="ed-save"
          onClick={handleFormatClick}
          aria-disabled={canFormat ? "false" : "true"}
        >
          Format
        </button>
      ) : null}
      {hasTarget && saveStatus === "conflict" ? (
        <button type="button" className="ed-reload" onClick={requestReload}>
          Reload
        </button>
      ) : null}
      {hasTarget ? (
        <button
          type="button"
          className="ed-save"
          onClick={handleSaveClick}
          aria-disabled={saveUnavailable}
        >
          {saveButtonLabel}
        </button>
      ) : null}
    </div>
  );

  const renderWorkspaceWatchBanner = (): ReactNode => (
    <>
      {workspaceWatchNeedsAttention ? (
        <output className="ed-recovery" data-testid="editor-workspace-watch-status">
          <span>
            {workspaceWatch.snapshotRequired
              ? "Workspace file events require a refresh."
              : `Workspace file watching is ${workspaceWatch.health}.`}
          </span>
          <span className="spacer" />
          <button type="button" className="ed-reload" onClick={requestReload}>
            Refresh
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

  const renderLocalHistoryProtectionBanner = (): ReactNode =>
    localHistoryProtection?.status === "degraded" ? (
      <output className="ed-recovery" data-testid="editor-local-history-protection">
        <span>
          {commonT("editor.localHistoryProtection.savedUnprotected")}{" "}
          {localHistoryProtectionGuidance(localHistoryProtection.reason)}{" "}
          {commonT("editor.localHistoryProtection.diagnosticReference", {
            correlationId: localHistoryProtection.correlationId,
          })}
        </span>
      </output>
    ) : null;

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

  const renderAgentConflictBanner = (): ReactNode => (
    <>
      {agentConflict !== null ? (
        <AgentConflictBanner
          code={agentConflict.code}
          message={agentConflict.message}
          onSave={
            agentConflict.code === "DIRTY"
              ? () => {
                  // F5: only dismiss the banner when persist succeeds (returns true).
                  void persist(contentRef.current).then((ok) => {
                    if (ok) setAgentConflict(null);
                  });
                }
              : undefined
          }
          onReload={
            agentConflict.code === "VERSION_MISMATCH" ||
            agentConflict.code === "CONTENT_HASH_MISMATCH"
              ? () => {
                  reload();
                  setAgentConflict(null);
                }
              : undefined
          }
          onDismiss={() => {
            setAgentConflict(null);
          }}
        />
      ) : null}
    </>
  );

  const renderEditorChrome = (): ReactNode => (
    <div className={`editor ${runtimeStyles.themeTokens}`}>
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
      {renderAgentConflictBanner()}
      <EditorAgentPresenceIndicator
        inFlightActionCount={bridgeState.inFlightActionCount}
        recentlyActive={bridgeState.recentlyAttached}
        reviewPendingCount={agentReviewPendingCount}
        t={t}
      />
      <EditorAgentActionsPanel agentSessionId={agentSessionId} refreshNonce={auditRefreshNonce} />
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
