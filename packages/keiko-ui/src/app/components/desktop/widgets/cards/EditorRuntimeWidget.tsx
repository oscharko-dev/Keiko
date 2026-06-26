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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import {
  EDITOR_HOT_EXIT_SCHEMA_VERSION,
  applyTextEditsToText,
  buildTestGenerationPreview,
  createEditorRequestId,
  createFileModel,
  DEFAULT_COMPLETION_TRIGGER_CHARACTERS,
  deriveLargeFileMode,
  deriveEditorStatusBar,
  describeTestGenerationStatus,
  editorFileModelReducer,
  editorLanguageLabel,
  EditorStatusBar,
  IDLE_TEST_GENERATION_STATE,
  inferMonacoLanguageId,
  isDocumentDirty,
  isSupportedEditorLanguage,
  isTestGenerationBusy,
  isTestGenerationPreviewing,
  saveStatusReducer,
  testGenerationReducer,
  type EditorBuffer,
  type EditorChangeOrigin,
  type EditorCompletionResolver,
  type EditorContentDelta,
  type EditorDiagnosticsResolver,
  type EditorDiagnosticsSummary,
  type EditorDocumentIdentity,
  type EditorFileModel,
  type EditorHotExitSnapshotV1,
  type EditorFormattingResolver,
  type EditorHoverResolver,
  type EditorInlineCompletionResolver,
  type EditorLanguageId,
  type EditorPosition,
  type EditorRange,
  type EditorRequestIdentity,
  type EditorSaveRequest,
  type EditorSaveStatus,
  type EditorStatusRun,
  type EditorSymbolsResolver,
  type InlineCompletionTelemetrySnapshot,
  type KeikoEditorLoadState,
  type PatchPreviewModel,
  type TestGenerationPreview,
} from "@oscharko-dev/keiko-editor";
import { editorBuiltinDocumentFormatting } from "@oscharko-dev/keiko-contracts";
import {
  ApiError,
  fetchEditorLanguageCapabilities,
  postEditorAgentSessionSnapshot,
  fetchFilesContent,
  reportEditorInlineCompletionTelemetry,
  requestEditorCompletion,
  requestEditorDiagnostics,
  requestEditorFormatting,
  requestEditorHover,
  requestEditorInlineCompletion,
  requestEditorSymbols,
  requestEditorTestGeneration,
  saveFilesContent,
} from "../../../../../lib/api";
import { mapWireToEditorCompletionResponse } from "../../../../../lib/editor-completion";
import { mapWireToEditorInlineCompletionResponse } from "../../../../../lib/editor-inline-completion";
import { mapWireToEditorTestGenerationOutcome } from "../../../../../lib/editor-test-generation";
import {
  mapWireToEditorDiagnosticsResponse,
  mapWireToEditorFormattingResponse,
  mapWireToEditorHoverResponse,
  mapWireToEditorSymbolsResponse,
} from "../../../../../lib/editor-language";
import type {
  EditorAgentAction,
  EditorAgentPaneSnapshot,
  EditorCompletionContextSelectors,
  EditorDocumentVersion,
  LanguageProviderDescriptor,
  LanguageServiceCapabilities,
  EditorTestGenerationWireTarget,
} from "../../../../../lib/types";
import { EDITOR_AGENT_SCHEMA_VERSION } from "../../../../../lib/types";
import { Icons } from "../../Icons";
import { useEditorThemeVariant } from "../../hooks/useEditorThemeVariant";
import { FileIcon } from "../shared/projectTree";
import { AgentConflictBanner, type AgentConflictCode } from "./AgentConflictBanner";
import { EditorAgentActionsPanel } from "./EditorAgentActionsPanel";
import {
  postEditorAgentResult,
  useEditorAgentBridge,
  type EditorAgentActionControllers,
} from "./editorAgentBridge";
import type { EditorDiffSurfaceProps } from "./EditorDiffSurface";
import type { EditorSurfaceProps } from "./EditorSurface";
import {
  deleteEditorHotExitSnapshot,
  readEditorHotExitSnapshot,
  writeEditorHotExitSnapshot,
} from "./editorHotExitStore";

const EditorSurface = dynamic<EditorSurfaceProps>(() => import("./EditorSurface"), {
  ssr: false,
  loading: () => <div className="ed-host-loading" aria-hidden="true" />,
});

const EditorDiffSurface = dynamic<EditorDiffSurfaceProps>(() => import("./EditorDiffSurface"), {
  ssr: false,
  loading: () => <div className="ed-host-loading" aria-hidden="true" />,
});

// Issue #1202: advisory coding-context budget for a test-generation run; the BFF clamps it to the
// server-owned `test-generation` purpose budget.
const TEST_GENERATION_CONTEXT_BUDGET_BYTES = 65_536;
// Content-free transport-failure message; the editor stays usable after a failed run.
const TEST_GENERATION_FAILURE_MESSAGE =
  "Test generation could not be reached. The editor is still usable.";
const COMPACT_TABS_ENTER_WIDTH_PX = 420;
const COMPACT_TABS_EXIT_WIDTH_PX = 460;
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
      operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
      availability: "available",
    },
  ],
};

export interface EditorRuntimeWidgetProps {
  readonly windowId?: string | undefined;
  readonly paneId?: string | undefined;
  readonly activePaneId?: string | undefined;
  readonly layoutPanes?: readonly EditorAgentPaneSnapshot[] | undefined;
  readonly root?: string;
  readonly file?: string;
  readonly openFiles?: readonly string[] | undefined;
  readonly revealLineStart?: number | undefined;
  readonly revealLineEnd?: number | undefined;
  readonly revealRequestId?: string | undefined;
  readonly dirtyFiles?: readonly string[] | undefined;
  readonly onSelectOpenFile?: ((file: string) => void) | undefined;
  readonly onSplitPane?: ((paneId: string, direction: "row" | "column") => void) | undefined;
  readonly onMoveTab?: ((fromPaneId: string, file: string, toPaneId: string) => void) | undefined;
  readonly onCloseOpenFile?: ((file: string) => Promise<boolean> | boolean | void) | undefined;
  readonly onDirtyChange?: ((file: string, dirty: boolean) => void) | undefined;
  readonly externalSaveRequest?: EditorExternalSaveRequest | undefined;
  readonly onExternalSaveComplete?:
    | ((requestId: number, paneId: string, file: string, ok: boolean) => void)
    | undefined;
  readonly renderTabHandle?:
    | ((
        file: string,
        active: boolean,
        dirty: boolean,
      ) => Pick<
        ButtonHTMLAttributes<HTMLButtonElement>,
        "draggable" | "onDragStart" | "onDragEnd" | "onKeyDown"
      >)
    | undefined;
  readonly toolbarExtras?: ReactNode | undefined;
  readonly linkedRoot?: string | null;
  readonly linkedFilePath?: string | undefined;
  readonly linkedCapsuleIds?: readonly string[] | undefined;
  readonly linkedCapsuleSetIds?: readonly string[] | undefined;
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

function safeDomIdSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/gu, "-");
  return safe.length > 0 ? safe : "editor";
}

/** Map a workspace path to a renderable editor language; intelligence is registry/capability-gated below. */
function inferEditorLanguage(path: string): EditorLanguageId {
  const language = inferMonacoLanguageId(path);
  return isSupportedEditorLanguage(language) ? language : "plaintext";
}

function rootHash(root: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < root.length; index += 1) {
    hash ^= root.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function encodePathSegments(path: string): string {
  return path
    .split(/[\\/]+/)
    .map(encodeURIComponent)
    .join("/");
}

/** A stable, host-scoped Monaco model URI for a (root, file) pair, without exposing a filesystem path. */
function documentUri(root: string, file: string): string {
  return `keiko-editor://workspace/${rootHash(root)}/${encodePathSegments(file)}`;
}

function documentSessionKey(root: string, file: string): string {
  return `${root}\u0000${file}`;
}

async function sha256Hex(text: string): Promise<string> {
  const cryptoLike = globalThis.crypto;
  if (cryptoLike?.subtle !== undefined) {
    const digest = await cryptoLike.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
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
}

function editorAriaLabel(root: string, file: string): string {
  return `Editor: ${file} in ${root}`;
}

function currentLineQueryText(text: string, line: number, character: number): string | undefined {
  const currentLine = text.split("\n")[line] ?? "";
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

function providerForLanguage(
  capabilities: LanguageServiceCapabilities | null,
  languageId: string | undefined,
): LanguageProviderDescriptor | null {
  if (capabilities === null || languageId === undefined) return null;
  return capabilities.providers.find((provider) => provider.languages.includes(languageId)) ?? null;
}

function providerOperationEnabled(
  provider: LanguageProviderDescriptor | null,
  operation: "diagnostics" | "completion" | "hover" | "symbols" | "formatting",
): boolean {
  return (
    provider !== null &&
    provider.availability === "available" &&
    provider.operations.includes(operation)
  );
}

function summarizePaths(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  if (paths.length === 1) return paths[0] ?? "";
  if (paths.length === 2) return `${paths[0] ?? ""}, ${paths[1] ?? ""}`;
  return `${paths[0] ?? ""}, ${paths[1] ?? ""} +${String(paths.length - 2)} more`;
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

export default function EditorRuntimeWidget({
  windowId,
  paneId,
  activePaneId,
  layoutPanes,
  root,
  file,
  revealLineStart,
  revealLineEnd,
  revealRequestId,
  openFiles,
  dirtyFiles,
  onSelectOpenFile,
  onSplitPane,
  onMoveTab,
  onCloseOpenFile,
  onDirtyChange,
  externalSaveRequest,
  onExternalSaveComplete,
  renderTabHandle,
  toolbarExtras,
  linkedRoot,
  linkedFilePath,
  linkedCapsuleIds,
  linkedCapsuleSetIds,
}: EditorRuntimeWidgetProps): ReactNode {
  const hasTarget = root !== undefined && root.length > 0 && file !== undefined && file.length > 0;
  const generatedId = useId();
  const editorDomIdPrefix = useMemo(
    () => `ed-${safeDomIdSegment(windowId ?? generatedId)}`,
    [generatedId, windowId],
  );
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
  const [tablistCompact, setTablistCompact] = useState(false);

  useLayoutEffect(() => {
    const el = tablistRef.current;
    if (el === null) return;
    let frame: number | null = null;
    const updateCompactState = (): void => {
      frame = null;
      const width = Math.round(el.getBoundingClientRect().width);
      if (width <= 0) return;
      setTablistCompact((current) => {
        const next = current
          ? width < COMPACT_TABS_EXIT_WIDTH_PX
          : width < COMPACT_TABS_ENTER_WIDTH_PX;
        return current === next ? current : next;
      });
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
  const compactTabs =
    tablistCompact && file !== undefined && file.length > 0 && documentTabs.length > 2;
  const summaryTabs = compactTabs ? documentTabs.filter((path) => path !== file) : [];
  const visibleTabs = compactTabs ? documentTabs.filter((path) => path === file) : documentTabs;
  const summaryTip = summarizePaths(summaryTabs);
  const summaryMenuId = `${editorDomIdPrefix}-summary-menu`;
  const summaryMenuRef = useRef<HTMLDetailsElement>(null);
  const [summaryMenuOpen, setSummaryMenuOpen] = useState(false);

  const [content, setContent] = useState("");
  const [fileModel, setFileModel] = useState<EditorFileModel | null>(null);
  const [modifiedAt, setModifiedAt] = useState<number | null>(null);
  const [version, setVersion] = useState<EditorDocumentVersion | null>(null);
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const [loadState, setLoadState] = useState<KeikoEditorLoadState>(
    hasTarget ? { status: "loading" } : { status: "ready" },
  );
  const [saveStatus, setSaveStatus] = useState<EditorSaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [formatRequestNonce, setFormatRequestNonce] = useState(0);
  // Issue #1202: the governed test-generation flow state (pure reducer owned by the editor package).
  // A monotonic sequence backs the cross-boundary request identity for stale-response discard.
  const [testGenState, dispatchTestGen] = useReducer(
    testGenerationReducer,
    IDLE_TEST_GENERATION_STATE,
  );
  const testGenSeqRef = useRef(0);
  const testGenAbortRef = useRef<AbortController | null>(null);
  const [currentSelection, setCurrentSelection] = useState<EditorRange | null>(null);
  // Issue #1205: live cursor and diagnostic-count state backing the unified status bar.
  const [cursor, setCursor] = useState<EditorPosition | null>(null);
  const [diagnosticsSummary, setDiagnosticsSummary] = useState<EditorDiagnosticsSummary | null>(
    null,
  );
  const [languageCapabilities, setLanguageCapabilities] =
    useState<LanguageServiceCapabilities | null>(BOOTSTRAP_LANGUAGE_CAPABILITIES);
  const [recoverySnapshot, setRecoverySnapshot] = useState<EditorHotExitSnapshotV1 | null>(null);
  // The on-disk content captured at the moment recovery was offered, so the compare view diffs the
  // recovered buffer against the disk file even if the live buffer is edited before Compare is opened.
  const [recoveryDiskBaseline, setRecoveryDiskBaseline] = useState<string | null>(null);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [recoveryCompare, setRecoveryCompare] = useState(false);
  const [activeContentHash, setActiveContentHash] = useState<string | null>(null);
  // Issue #1394 (ADR-0058 D3/D4): conflict banner and applyPatch review state.
  const [agentConflict, setAgentConflict] = useState<{
    readonly code: AgentConflictCode;
    readonly message: string;
  } | null>(null);
  const [agentPatchPending, setAgentPatchPending] = useState<{
    readonly action: EditorAgentAction;
    readonly original: string;
    readonly modified: string;
  } | null>(null);
  // A11Y-2: focus the Accept button whenever a patch review appears.
  const patchAcceptButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (agentPatchPending !== null) {
      patchAcceptButtonRef.current?.focus();
    }
  }, [agentPatchPending]);
  const sessionCacheRef = useRef(new Map<string, EditorFileSessionSnapshot>());
  const activeSessionKeyRef = useRef<string | null>(null);
  activeSessionKeyRef.current =
    root !== undefined && file !== undefined && root.length > 0 && file.length > 0
      ? documentSessionKey(root, file)
      : null;

  // Refs the imperative save path reads so a Cmd/Ctrl+S immediately after an edit always persists
  // the latest values, independent of React state-batching timing. The version-aware
  // optimistic-concurrency token (Issue #1197) is the token the save sends to the BFF.
  const versionRef = useRef<EditorDocumentVersion | null>(null);
  versionRef.current = version;
  const savingRef = useRef(false);
  savingRef.current = saveStatus === "saving";
  // The editor stays editable during a save; this ref lets the success handler tell whether the
  // buffer moved while the save was in flight so it never clobbers mid-flight edits.
  const contentRef = useRef("");
  contentRef.current = content;

  useEffect(() => {
    setCurrentSelection(null);
    setCursor(null);
    setDiagnosticsSummary(null);
    // Switching the active file leaves any per-file recovery-compare view or pending reload
    // confirmation; both are scoped to the file that opened them.
    setRecoveryCompare(false);
    setReloadConfirm(false);
    setRecoveryDiskBaseline(null);
  }, [file, root]);

  useEffect(() => {
    let cancelled = false;
    void sha256Hex(content).then((hash) => {
      if (!cancelled) setActiveContentHash(hash);
    });
    return () => {
      cancelled = true;
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

  useEffect(
    () => () => {
      testGenAbortRef.current?.abort();
    },
    [],
  );

  const currentDocumentUri =
    hasTarget && root !== undefined && file !== undefined ? documentUri(root, file) : null;
  const fileModelMatchesTarget =
    fileModel !== null &&
    currentDocumentUri !== null &&
    fileModel.identity.uri === currentDocumentUri;
  const dirty = fileModelMatchesTarget && isDocumentDirty(fileModel);
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
    if (!hasTarget || root === undefined || file === undefined || !fileModelMatchesTarget) return;
    if (!dirty) {
      void deleteEditorHotExitSnapshot(root, file);
      return;
    }
    const sizeBytes = new TextEncoder().encode(content).length;
    if (maxBytes !== null && sizeBytes > maxBytes) return;
    let cancelled = false;
    void sha256Hex(content).then((contentHash) => {
      if (cancelled) return;
      const snapshot: EditorHotExitSnapshotV1 = {
        schemaVersion: EDITOR_HOT_EXIT_SCHEMA_VERSION,
        workspaceRoot: root,
        relativePath: file,
        content,
        baseVersion: version,
        contentHash,
        savedContentHash: version?.contentHash ?? null,
        updatedAt: Date.now(),
        paneId: paneId ?? "pane-1",
        windowId: windowId ?? "editor",
      };
      void writeEditorHotExitSnapshot(snapshot);
    });
    return () => {
      cancelled = true;
    };
  }, [
    content,
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

  const load = useCallback(
    (signal: { cancelled: boolean }, options: { bypassCache?: boolean } = {}): void => {
      if (!hasTarget) {
        setContent("");
        setFileModel(null);
        setModifiedAt(null);
        setVersion(null);
        setMaxBytes(null);
        setLoadState({ status: "ready" });
        setSaveStatus("idle");
        setSaveError(undefined);
        return;
      }
      const sessionKey = documentSessionKey(root, file);
      const cached =
        options.bypassCache === true ? undefined : sessionCacheRef.current.get(sessionKey);
      if (cached !== undefined) {
        setContent(cached.content);
        setFileModel(cached.fileModel);
        setModifiedAt(cached.modifiedAt);
        setVersion(cached.version);
        setMaxBytes(cached.maxBytes);
        setLoadState(cached.loadState);
        setSaveStatus(cached.saveStatus);
        setSaveError(cached.saveError);
        setCursor(cached.cursor);
        setCurrentSelection(cached.currentSelection);
        setDiagnosticsSummary(cached.diagnosticsSummary);
        return;
      }
      setLoadState({ status: "loading" });
      setSaveStatus("idle");
      setSaveError(undefined);
      void fetchFilesContent(root, file)
        .then(async (response) => {
          if (signal.cancelled) return;
          const identity: EditorDocumentIdentity = {
            uri: documentUri(root, file),
            language: inferEditorLanguage(file),
            version: 0,
          };
          const snapshot = await readEditorHotExitSnapshot(root, file);
          if (signal.cancelled) return;
          setContent(response.content);
          setFileModel(createFileModel(identity));
          setModifiedAt(response.modifiedAt);
          setVersion(response.session.version);
          setMaxBytes(response.maxBytes);
          setLoadState({ status: "ready" });
          // AC3: offer recovery whenever the snapshot's buffer differs from what is on disk now.
          // The content comparison is the authoritative signal; an additional contentHash check is
          // redundant against it (a content difference implies a hash difference) and can only ever
          // suppress a legitimate recovery offer when the client buffer hash and the server-issued
          // version hash are computed over different normalizations — a false negative. Gate solely
          // on the content the user would lose.
          if (snapshot !== null && snapshot.content !== response.content) {
            setRecoverySnapshot(snapshot);
            setRecoveryDiskBaseline(response.content);
          } else {
            setRecoverySnapshot(null);
            setRecoveryDiskBaseline(null);
          }
        })
        .catch((err: unknown) => {
          if (signal.cancelled) return;
          setLoadState({ status: "error", message: errorMessage(err) });
        });
    },
    [hasTarget, root, file],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  const reload = useCallback((): void => {
    const signal = { cancelled: false };
    load(signal, { bypassCache: true });
  }, [load]);

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

  const confirmReloadDiscard = useCallback((): void => {
    setReloadConfirm(false);
    // The user chose to discard the unsaved buffer for the on-disk version, so the hot-exit snapshot
    // holding those edits must go too — otherwise the reload would immediately re-offer them as a
    // recovery. Serialized store mutations keep this delete ordered ahead of the reload's snapshot read.
    if (root !== undefined && file !== undefined) {
      void deleteEditorHotExitSnapshot(root, file);
    }
    reload();
  }, [reload, root, file]);

  const cancelReloadDiscard = useCallback((): void => {
    setReloadConfirm(false);
  }, []);

  const reloadConfirmRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reloadConfirm) return;
    reloadConfirmRef.current?.focus();
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") cancelReloadDiscard();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [reloadConfirm, cancelReloadDiscard]);

  const persist = useCallback(
    async (text: string): Promise<boolean> => {
      if (!hasTarget || savingRef.current) return false;
      const saveSessionKey = documentSessionKey(root, file);
      const textChangedBeforeReactCommitted = text !== contentRef.current;
      if (!dirtyRef.current && !textChangedBeforeReactCommitted) return true;
      if (textChangedBeforeReactCommitted) {
        contentRef.current = text;
        setContent(text);
        setFileModel((model) =>
          model === null
            ? model
            : editorFileModelReducer(model, { type: "edited", origin: "human" }),
        );
      }
      savingRef.current = true;
      setSaveStatus((status) => saveStatusReducer(status, { type: "request" }));
      setSaveError(undefined);
      try {
        const response = await saveFilesContent({
          root,
          path: file,
          content: text,
          // Version-aware token (Issue #1197); supersedes the coarser mtime-only check.
          baseVersion: versionRef.current ?? undefined,
        });
        if (activeSessionKeyRef.current !== saveSessionKey) {
          const cached = sessionCacheRef.current.get(saveSessionKey);
          const cachedContent = cached?.content ?? text;
          const cachedFileModel = cached?.fileModel ?? null;
          sessionCacheRef.current.set(saveSessionKey, {
            content: cachedContent === text ? response.content : cachedContent,
            fileModel:
              cachedFileModel === null
                ? cachedFileModel
                : editorFileModelReducer(cachedFileModel, {
                    type: cachedContent === text ? "saved" : "edited",
                    origin: "human",
                  }),
            modifiedAt: response.modifiedAt,
            version: response.session.version,
            maxBytes: response.maxBytes,
            loadState: cached?.loadState ?? { status: "ready" },
            saveStatus: cachedContent === text ? "saved" : "idle",
            saveError: undefined,
            cursor: cached?.cursor ?? null,
            currentSelection: cached?.currentSelection ?? null,
            diagnosticsSummary: cached?.diagnosticsSummary ?? null,
          });
          await deleteEditorHotExitSnapshot(root, file);
          return true;
        }
        // The persisted file moved on disk regardless of any concurrent edits — always adopt the new
        // concurrency token so the next save validates against it.
        setModifiedAt(response.modifiedAt);
        setVersion(response.session.version);
        setMaxBytes(response.maxBytes);
        if (contentRef.current === text) {
          // No edits arrived during the save: adopt the persisted echo and mark the buffer clean.
          setContent(response.content);
          setFileModel((model) =>
            model === null ? model : editorFileModelReducer(model, { type: "saved" }),
          );
          setSaveStatus((status) => saveStatusReducer(status, { type: "succeeded" }));
        } else {
          // The user kept typing while the save was in flight. Keep their newer text and leave the
          // buffer dirty against the freshly persisted version — never clobber in-flight edits or
          // report a stale buffer as saved. The next save runs against the updated modifiedAt.
          setSaveStatus((status) =>
            saveStatusReducer(saveStatusReducer(status, { type: "succeeded" }), { type: "edited" }),
          );
        }
        await deleteEditorHotExitSnapshot(root, file);
        return true;
      } catch (err: unknown) {
        if (activeSessionKeyRef.current !== saveSessionKey) {
          const cached = sessionCacheRef.current.get(saveSessionKey);
          sessionCacheRef.current.set(saveSessionKey, {
            content: cached?.content ?? text,
            fileModel: cached?.fileModel ?? fileModel,
            modifiedAt: cached?.modifiedAt ?? modifiedAt,
            version: cached?.version ?? versionRef.current,
            maxBytes: cached?.maxBytes ?? maxBytes,
            loadState: cached?.loadState ?? { status: "ready" },
            saveStatus: err instanceof ApiError && err.status === 409 ? "conflict" : "error",
            saveError:
              err instanceof ApiError && err.status === 409 ? undefined : errorMessage(err),
            cursor: cached?.cursor ?? null,
            currentSelection: cached?.currentSelection ?? null,
            diagnosticsSummary: cached?.diagnosticsSummary ?? null,
          });
          return false;
        }
        if (err instanceof ApiError && err.status === 409) {
          // The persisted file moved underneath this save (optimistic-concurrency conflict). Keep the
          // buffer dirty and surface a recoverable conflict — never silently overwrite.
          setSaveStatus((status) => saveStatusReducer(status, { type: "conflicted" }));
        } else {
          setSaveError(errorMessage(err));
          setSaveStatus((status) => saveStatusReducer(status, { type: "failed" }));
        }
        return false;
      } finally {
        savingRef.current = false;
      }
    },
    [file, fileModel, hasTarget, maxBytes, modifiedAt, root],
  );

  const onContentChange = useCallback(
    (next: EditorContentDelta, _origin: EditorChangeOrigin): void => {
      setContent(next.text);
      setFileModel((model) =>
        model === null ? model : editorFileModelReducer(model, { type: "edited", origin: "human" }),
      );
      setSaveStatus((status) => saveStatusReducer(status, { type: "edited" }));
    },
    [],
  );

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
    // than swallowing a system-boundary signal.
    // eslint-disable-next-line no-console -- non-fatal, observable diagnostic only.
    console.warn(`Keiko editor runtime notice: ${message}`);
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
      void deleteEditorHotExitSnapshot(root, file);
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

  const closeRecoveryCompare = useCallback((): void => {
    setRecoveryCompare(false);
  }, []);

  // Issue #1199: the governed completion resolver. The Monaco bridge calls this with the live buffer
  // text and a content-free request; the host posts to `/api/editor/completion` and adapts the wire
  // response. A completion failure rejects here and the editor bridge renders nothing (AC4) — it
  // never breaks editing.
  const provideCompletions = useCallback<EditorCompletionResolver>(
    async (query, signal) => {
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
      return mapWireToEditorCompletionResponse(query.request.request, wire, Date.now());
    },
    [file, hasTarget, linkedCapsuleIds, linkedCapsuleSetIds, linkedFilePath, linkedRoot, root],
  );

  // Issue #1200: the governed inline-completion (ghost-text) resolver. The Monaco inline bridge calls
  // this with the live buffer and a content-free request; the host posts to
  // `/api/editor/inline-completion` and adapts the wire response. A failure rejects here and the editor
  // bridge renders nothing (AC1) — it never breaks editing. The server is authoritative for the
  // policy/cost/rate gates and returns zero items when the feature is degraded or disabled.
  const provideInlineCompletions = useCallback<EditorInlineCompletionResolver>(
    async (query, signal) => {
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
    async (query, signal) => {
      if (!hasTarget || root === undefined || file === undefined) {
        return { request: query.request.request, diagnostics: [] };
      }
      const wire = await requestEditorDiagnostics(
        { root, path: file, languageId: query.request.document.language, text: query.documentText },
        signal,
      );
      return mapWireToEditorDiagnosticsResponse(query.request.request, wire);
    },
    [file, hasTarget, root],
  );

  const provideHover = useCallback<EditorHoverResolver>(
    async (query, signal) => {
      if (!hasTarget || root === undefined || file === undefined) {
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
    [file, hasTarget, root],
  );

  const provideSymbols = useCallback<EditorSymbolsResolver>(
    async (query, signal) => {
      if (!hasTarget || root === undefined || file === undefined) {
        return { request: query.request.request, symbols: [] };
      }
      const wire = await requestEditorSymbols(
        { root, path: file, languageId: query.request.document.language, text: query.documentText },
        signal,
      );
      return mapWireToEditorSymbolsResponse(query.request.request, wire);
    },
    [file, hasTarget, root],
  );

  const provideFormatting = useCallback<EditorFormattingResolver>(
    async (query, signal) => {
      if (!hasTarget || root === undefined || file === undefined) {
        return { request: query.request.request, edits: [] };
      }
      const wire = await requestEditorFormatting(
        {
          root,
          path: file,
          languageId: query.request.document.language,
          text: query.documentText,
          options: {
            tabSize: query.request.options.tabSize,
            insertSpaces: query.request.options.insertSpaces,
          },
        },
        signal,
      );
      return mapWireToEditorFormattingResponse(query.request.request, wire);
    },
    [file, hasTarget, root],
  );

  const contentSizeBytes = useMemo(() => new TextEncoder().encode(content).length, [content]);
  const largeFileMode = useMemo(
    () => deriveLargeFileMode({ sizeBytes: contentSizeBytes, text: content }),
    [content, contentSizeBytes],
  );
  const largeFileDegraded = largeFileMode === "degraded";

  const completionLanguage = fileModel?.identity.language;
  const languageProvider = providerForLanguage(languageCapabilities, completionLanguage);
  const completionEnabled =
    providerOperationEnabled(languageProvider, "completion") && !largeFileDegraded;
  const diagnosticsEnabled =
    providerOperationEnabled(languageProvider, "diagnostics") && !largeFileDegraded;
  const hoverEnabled = providerOperationEnabled(languageProvider, "hover") && !largeFileDegraded;
  const symbolsEnabled =
    providerOperationEnabled(languageProvider, "symbols") && !largeFileDegraded;
  // ADR-0068 D3: formatting availability is browser-reachability truth from the editor-tier registry,
  // NOT the server capability set. `monaco-builtin` languages (json/css/scss/less/html) are formatted
  // by Monaco's bundled workers and need no server; `keiko-language-service` languages (ts/js) format
  // through the Keiko bridge and additionally require the server provider to be up; `none` languages
  // (yaml/markdown/…) have no in-browser formatter and are correctly unavailable (AC5).
  const builtinFormatting = editorBuiltinDocumentFormatting(completionLanguage ?? "plaintext");
  const formattingAvailable =
    builtinFormatting === "monaco-builtin" ||
    (builtinFormatting === "keiko-language-service" &&
      providerOperationEnabled(languageProvider, "formatting"));
  const formattingEnabled = formattingAvailable && !largeFileDegraded;
  // Content-free, human-readable language name for the Format button's dynamic aria-label (ADR-0068
  // D4). Reuses the editor-tier label table; falls back to a generic noun when no language is known.
  const formattingLanguageLabel =
    completionLanguage === undefined ? "this file" : editorLanguageLabel(completionLanguage);
  const editorSurfaceKey = `${themeVariant ?? "dark"}:${languageProvider?.id ?? "none"}:${largeFileMode}`;

  const canSave = hasTarget && dirty && saveStatus !== "saving" && loadState.status === "ready";
  const saveUnavailable = !canSave;
  const canFormat = hasTarget && loadState.status === "ready" && formattingEnabled;

  // Issue #1202: the "Generate Tests" action is offered for governed TS/JS files; the server is the
  // authority and returns `disabled` while the wave-2 feature is switched off. The status line reflects
  // the flow reducer (a content-free message); a busy run disables the action.
  const testGenBusy = isTestGenerationBusy(testGenState);
  const canGenerateTests =
    hasTarget && completionEnabled && loadState.status === "ready" && !testGenBusy;
  const testGenStatusText = describeTestGenerationStatus(testGenState);
  const testGenStatusLabel = testGenState.kind === "disabled" ? "Tests off" : testGenStatusText;

  const buffer: EditorBuffer | null = useMemo(
    () =>
      fileModel === null || !fileModelMatchesTarget
        ? null
        : {
            language: fileModel.identity.language,
            readOnly: largeFileDegraded,
            content: {
              relativePath: file ?? "",
              text: content,
              sizeBytes: contentSizeBytes,
              truncated: false,
            },
          },
    [content, contentSizeBytes, file, fileModel, fileModelMatchesTarget, largeFileDegraded],
  );
  const testGenerationPreview: TestGenerationPreview | null =
    isTestGenerationPreviewing(testGenState) && buffer !== null
      ? buildTestGenerationPreview({
          result: testGenState.result,
          assurance: testGenState.assurance,
          sources: { [buffer.content.relativePath]: { content: buffer.content } },
        })
      : null;

  // Issue #1205: derive the unified status-bar view model from host state. Diagnostics are surfaced
  // only for governed source files (where the deterministic language service runs); the
  // test-generation flow feeds the compact "run" field. The cursor is rendered but never announced
  // (it changes per keystroke) — only meaningful state (save, problems, run) reaches the live region.
  const selectedLineCount =
    currentSelection === null
      ? undefined
      : currentSelection.end.line - currentSelection.start.line + 1;
  const statusBarRun: EditorStatusRun | undefined =
    testGenStatusLabel.length > 0 ? { label: testGenStatusLabel, busy: testGenBusy } : undefined;
  const statusBarViewModel =
    fileModel === null
      ? null
      : deriveEditorStatusBar({
          languageId: fileModel.identity.language,
          cursor,
          ...(selectedLineCount === undefined ? {} : { selectedLineCount }),
          saveStatus,
          dirty,
          completionsEnabled: completionEnabled,
          largeFileMode,
          diagnostics: diagnosticsEnabled ? diagnosticsSummary : null,
          // Issue #1379 (ADR-0067 D4): after the exhaustive registry, providerForLanguage returns a
          // descriptor for every KNOWN language; we read its id/availability/reason directly. The
          // null guard is retained ONLY for the genuinely-unknown plaintext/unknown case (plaintext
          // is intentionally not a registry language, ADR-0067 D5) so the status bar still renders.
          languageService:
            languageProvider === null
              ? { providerId: null, available: false }
              : {
                  providerId: languageProvider.id === "none" ? null : languageProvider.id,
                  available: languageProvider.availability === "available",
                  ...(languageProvider.unavailableReason === undefined
                    ? {}
                    : { unavailableReason: languageProvider.unavailableReason }),
                },
          readOnly: largeFileDegraded,
          // ADR-0068 D4: feed the SAME effective availability that gates the Format button
          // (`formattingEnabled`, which folds in `!largeFileDegraded`) so the command and status can
          // never disagree — in degraded mode both read unavailable, and the large-file field explains
          // why.
          formatting: { available: formattingEnabled, source: builtinFormatting },
          ...(statusBarRun === undefined ? {} : { run: statusBarRun }),
        });

  const showUnifiedStatusBar =
    testGenerationPreview === null &&
    hasTarget &&
    loadState.status === "ready" &&
    buffer !== null &&
    fileModel !== null &&
    statusBarViewModel !== null;

  const effectiveDirtyFiles = useMemo(() => {
    const set = new Set(dirtyFiles ?? []);
    if (file !== undefined && dirty) set.add(file);
    return set;
  }, [dirty, dirtyFiles, file]);
  const handleSelectTab = useCallback(
    (path: string): void => {
      if (path === file || saveStatus === "saving") return;
      onSelectOpenFile?.(path);
    },
    [file, onSelectOpenFile, saveStatus],
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

  const agentSessionId = useMemo(
    () => `${safeDomIdSegment(windowId ?? generatedId)}:${rootHash(root ?? "")}`,
    [generatedId, root, windowId],
  );
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

  // Issue #1392 — post the current pane snapshot to the BFF. Wrapped in `useCallback` so the bridge
  // hook's register effect re-fires exactly when a snapshot dimension changes (its identity is the
  // dependency). Registration is best-effort and must never affect editing.
  const registerAgentSnapshot = useCallback((): void => {
    if (!hasTarget || root === undefined || file === undefined || activeContentHash === null)
      return;
    void postEditorAgentSessionSnapshot({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      sessionId: agentSessionId,
      windowId: windowId ?? "editor",
      workspaceRoot: root,
      activePaneId: activePaneId ?? paneId ?? null,
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
      ...(agentDocumentVersion === null ? {} : { documentVersion: agentDocumentVersion }),
      activeFileContentHash: activeContentHash,
      textMode: "none",
      updatedAt: Date.now(),
    }).catch(() => {
      // Agent bridge registration is best-effort and must never affect editing.
    });
  }, [
    activePaneId,
    activeContentHash,
    agentSessionId,
    currentSelection,
    cursor,
    completionLanguage,
    diagnosticsSummary,
    documentTabs,
    effectiveDirtyFiles,
    agentDocumentVersion,
    file,
    hasTarget,
    languageProvider,
    layoutPanes,
    paneId,
    root,
    windowId,
  ]);

  // Issue #1394 (ADR-0058 D3): apply text edits, guarded for read-only/large-file buffers (AC4 risk #5).
  const applyAgentTextEditsAction = useCallback(
    (action: EditorAgentAction): void => {
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
    [largeFileDegraded],
  );

  // Issue #1394 (ADR-0058 D3): applyPatch — server pre-validates and emits textEdits; the browser
  // computes modified content and enters an explicit review state (AC user-review-before-destructive).
  const applyAgentPatchAction = useCallback(
    (action: EditorAgentAction): void => {
      const targetFile = action.target?.file;
      if (targetFile !== undefined && targetFile !== file) {
        postEditorAgentResult(
          action,
          "conflict",
          "Patch targets a file not open in this pane.",
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
        setAgentPatchPending({ action, original, modified });
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
    [file, largeFileDegraded],
  );

  // Issue #1393 (ADR-0061 D2): the controller bundle the pure dispatcher calls. The two layout
  // controllers (onSplitPane/onMoveTab) are injected by EditorWidget; they are undefined when this
  // pane is rendered standalone, and the dispatcher then answers a structured provider-unavailable
  // failure. The setSelection controller is owned by the bridge hook (it drives hook state), so it is
  // left undefined here and merged in by the hook.
  const agentControllers = useMemo<EditorAgentActionControllers>(
    () => ({
      paneId,
      onSelectOpenFile,
      formattingEnabled,
      formatRequest: { increment: () => setFormatRequestNonce((value) => value + 1) },
      persist,
      currentText: () => contentRef.current,
      applyTextEdits: applyAgentTextEditsAction,
      applyPatch: applyAgentPatchAction,
      onSplitPane,
      onMoveTab,
      onRequestSelectionReveal: undefined,
    }),
    [
      applyAgentPatchAction,
      applyAgentTextEditsAction,
      formattingEnabled,
      onMoveTab,
      onSelectOpenFile,
      onSplitPane,
      paneId,
      persist,
    ],
  );

  // Issue #1395 — bump on any agent activity so the recent-actions audit panel re-fetches its feed.
  const [auditRefreshNonce, setAuditRefreshNonce] = useState(0);
  const { agentSelectionRequest, consumeSelectionRequest } = useEditorAgentBridge({
    agentSessionId,
    controllers: agentControllers,
    registerSnapshot: registerAgentSnapshot,
    onConflict: setAgentConflict,
    onAgentActivity: () => setAuditRefreshNonce((nonce) => nonce + 1),
  });

  const recoveryDiskChanged =
    recoverySnapshot !== null &&
    recoverySnapshot.savedContentHash !== null &&
    version !== null &&
    recoverySnapshot.savedContentHash !== version.contentHash;

  // Issue #1394 (ADR-0058 D3): handlers for the agent-patch review Accept/Reject buttons.
  const handleAgentPatchAccept = useCallback((): void => {
    if (agentPatchPending === null) return;
    if (largeFileDegraded) {
      postEditorAgentResult(
        agentPatchPending.action,
        "failed",
        "Editor is read-only; cannot apply agent edits.",
      );
      setAgentPatchPending(null);
      return;
    }
    setContent(agentPatchPending.modified);
    setFileModel((model) =>
      model === null
        ? model
        : editorFileModelReducer(model, { type: "edited", origin: "applied-patch" }),
    );
    setSaveStatus((status) => saveStatusReducer(status, { type: "edited" }));
    postEditorAgentResult(agentPatchPending.action, "succeeded");
    setAgentPatchPending(null);
  }, [agentPatchPending, largeFileDegraded]);

  const handleAgentPatchReject = useCallback((): void => {
    if (agentPatchPending === null) return;
    postEditorAgentResult(agentPatchPending.action, "failed", "Patch rejected by user.");
    setAgentPatchPending(null);
  }, [agentPatchPending]);

  // Issue #1393 (ADR-0061 D3): merge an agent setSelection request into the editor surface
  // revealRequest, mapping the contract LanguageRange (0-based, `character`) onto the editor's
  // EditorRange (0-based, `column`). Agent selection takes precedence over the line-based reveal; it
  // is consumed one-shot below so a stale agent selection never fights a later user-driven reveal.
  const lineRevealRequest =
    revealLineStart === undefined
      ? undefined
      : {
          id:
            revealRequestId ??
            `${file ?? "file"}:${String(revealLineStart)}:${String(revealLineEnd ?? revealLineStart)}`,
          range: {
            start: { line: Math.max(0, Math.floor(revealLineStart) - 1), column: 0 },
            end: {
              line: Math.max(
                Math.max(0, Math.floor(revealLineStart) - 1),
                Math.floor(revealLineEnd ?? revealLineStart) - 1,
              ),
              column: 0,
            },
          },
        };
  const surfaceRevealRequest =
    agentSelectionRequest === null
      ? lineRevealRequest
      : {
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
  useEffect(() => {
    if (agentSelectionRequest !== null) consumeSelectionRequest();
  }, [agentSelectionRequest, consumeSelectionRequest]);

  let panel: ReactNode;
  if (recoveryCompare && recoverySnapshot !== null) {
    // AC4 "compare": a true side-by-side diff of the on-disk file (left) against the recovered
    // unsaved buffer (right), reusing the same diff surface as agent-patch review. The disk side is
    // the baseline captured when recovery was offered, not the live buffer, so it stays accurate
    // even if the buffer was edited before Compare was opened.
    const recoveryDiffModel = buildAgentPatchDiffModel(
      recoveryDiskBaseline ?? content,
      recoverySnapshot.content,
      file,
    );
    panel = (
      <>
        <div role="group" aria-label={`Compare recovered changes for ${file ?? "this file"}`}>
          <span className="sr-only">
            Side-by-side comparison of the file on disk and the recovered unsaved changes. Keep
            local restores the recovered changes; use disk keeps the file on disk.
          </span>
          <EditorDiffSurface
            model={recoveryDiffModel}
            loadState={{ status: "ready" }}
            themeVariant={themeVariant}
          />
        </div>
        <div className="ed-toolbar-actions">
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
      </>
    );
  } else if (agentPatchPending !== null) {
    const patchDiffModel = buildAgentPatchDiffModel(
      agentPatchPending.original,
      agentPatchPending.modified,
      file,
    );
    panel = (
      <>
        {/* A11Y-3: label the diff review surface and provide an sr-only instruction */}
        <div aria-label={`Agent patch review for ${file ?? "this file"}`}>
          <span className="sr-only">
            Agent generated a patch. Review the changes and accept to apply or reject to discard.
          </span>
          <EditorDiffSurface
            model={patchDiffModel}
            loadState={{ status: "ready" }}
            themeVariant={themeVariant}
          />
        </div>
        <div className="ed-toolbar-actions">
          {/* A11Y-1: explicit aria-labels; A11Y-2: ref for focus management */}
          <button
            ref={patchAcceptButtonRef}
            type="button"
            className="ed-save"
            data-testid="agent-patch-accept"
            aria-label="Accept agent patch and apply changes"
            onClick={handleAgentPatchAccept}
          >
            Accept
          </button>
          <button
            type="button"
            className="ed-reload"
            data-testid="agent-patch-reject"
            aria-label="Reject agent patch and discard changes"
            onClick={handleAgentPatchReject}
          >
            Reject
          </button>
        </div>
      </>
    );
  } else if (testGenerationPreview !== null) {
    panel = (
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
  } else if (hasTarget && loadState.status === "error") {
    panel = (
      <div className="ed-host-loading" role="alert">
        <span>{`Editor failed to load: ${loadState.message}`}</span>
        <button type="button" className="ed-reload" onClick={reload}>
          Retry
        </button>
      </div>
    );
  } else if (hasTarget && buffer !== null && fileModel !== null) {
    panel = (
      <EditorSurface
        key={editorSurfaceKey}
        buffer={buffer}
        fileModel={fileModel}
        fileLoadState={loadState}
        saveStatus={saveStatus}
        saveError={saveError}
        modifiedAt={modifiedAt ?? undefined}
        maxSizeBytes={maxBytes ?? undefined}
        themeVariant={themeVariant}
        ariaLabel={
          root !== undefined && file !== undefined ? editorAriaLabel(root, file) : undefined
        }
        onContentChange={onContentChange}
        onSaveRequested={onSaveRequested}
        onRuntimeError={onRuntimeError}
        provideCompletions={completionEnabled ? provideCompletions : undefined}
        completionTriggerCharacters={DEFAULT_COMPLETION_TRIGGER_CHARACTERS}
        provideInlineCompletions={completionEnabled ? provideInlineCompletions : undefined}
        onInlineCompletionTelemetry={completionEnabled ? onInlineCompletionTelemetry : undefined}
        provideDiagnostics={diagnosticsEnabled ? provideDiagnostics : undefined}
        provideHover={hoverEnabled ? provideHover : undefined}
        provideSymbols={symbolsEnabled ? provideSymbols : undefined}
        provideFormatting={formattingEnabled ? provideFormatting : undefined}
        formatRequestNonce={formatRequestNonce}
        onSelectionChange={setCurrentSelection}
        onCursorChange={setCursor}
        revealRequest={surfaceRevealRequest}
        onDiagnosticsSummary={diagnosticsEnabled ? setDiagnosticsSummary : undefined}
        onGenerateTests={completionEnabled ? runTestGeneration : undefined}
        showStatusFooter={false}
      />
    );
  } else if (hasTarget) {
    panel = (
      <div className="ed-host-loading" role="status">
        Loading file…
      </div>
    );
  } else {
    panel = (
      <div className="ed-empty" role="note">
        Choose a file from the project tree to start editing.
      </div>
    );
  }

  return (
    <div className="editor">
      <div className="ed-tabs mono">
        <div className="ed-tablist" ref={tablistRef} role="tablist" aria-label="Open documents">
          {visibleTabs.length > 0 ? (
            visibleTabs.map((path) => {
              const active = path === file;
              const tabDomId = active
                ? tabId
                : `${editorDomIdPrefix}-tab-${safeDomIdSegment(path)}`;
              const tabDirty = effectiveDirtyFiles.has(path);
              const tabHandle = renderTabHandle?.(path, active, tabDirty);
              return (
                <span
                  className={`ed-tab${active ? " active" : ""}`}
                  data-dirty={tabDirty ? "true" : "false"}
                  key={path}
                >
                  <button
                    type="button"
                    className="ed-tab-hit ui-tip"
                    draggable={tabHandle?.draggable}
                    role="tab"
                    id={tabDomId}
                    aria-selected={active ? "true" : "false"}
                    aria-controls={tabpanelId}
                    tabIndex={active ? 0 : -1}
                    data-tip={path}
                    onDragStart={tabHandle?.onDragStart}
                    onDragEnd={tabHandle?.onDragEnd}
                    onKeyDown={tabHandle?.onKeyDown}
                    onClick={() => handleSelectTab(path)}
                  >
                    <FileIcon name={path} />
                    <span className="ed-tab-label">{path}</span>
                    {tabDirty ? (
                      <span className="ed-dirty" aria-hidden="true">
                        ●
                      </span>
                    ) : null}
                  </button>
                  {onCloseOpenFile !== undefined ? (
                    <button
                      type="button"
                      className="ed-tab-close ui-tip"
                      aria-label={`Close ${path}`}
                      data-tip={`Close ${path}`}
                      onClick={() => void handleCloseTab(path)}
                    >
                      ×
                    </button>
                  ) : null}
                </span>
              );
            })
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
                <Icons.editor size={12} />
                <span className="ed-tab-label">Editor</span>
              </span>
            </span>
          )}
          {compactTabs && summaryTabs.length > 0 ? (
            <details
              ref={summaryMenuRef}
              className="ed-tab-summary-menu"
              open={summaryMenuOpen}
              onToggle={(event) => setSummaryMenuOpen(event.currentTarget.open)}
            >
              <summary
                className="ed-tab-summary ui-tip"
                aria-label={`${String(summaryTabs.length)} more open documents`}
                aria-haspopup="menu"
                aria-expanded={summaryMenuOpen ? "true" : "false"}
                aria-controls={summaryMenuId}
                data-tip={summaryTip}
              >
                +{summaryTabs.length}
              </summary>
              <div
                className="ed-tab-summary-panel"
                id={summaryMenuId}
                aria-label="Hidden open documents"
              >
                {summaryTabs.map((path) => {
                  const tabDirty = effectiveDirtyFiles.has(path);
                  return (
                    <button
                      type="button"
                      key={path}
                      className="ed-tab-summary-item ui-tip"
                      data-tip={path}
                      onClick={() => handleChooseSummaryTab(path)}
                    >
                      <Icons.editor size={12} />
                      <span className="ed-tab-summary-label">{path}</span>
                      {tabDirty ? (
                        <span className="ed-dirty" aria-hidden="true">
                          ●
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </details>
          ) : null}
        </div>
        <div className="ed-toolbar-actions">
          {toolbarExtras}
          {hasTarget && completionEnabled ? (
            <button
              type="button"
              className="ed-save ui-tip"
              onClick={() => {
                if (canGenerateTests) runTestGeneration();
              }}
              aria-disabled={!canGenerateTests}
              data-tip="Generate unit tests for this file"
            >
              {testGenBusy ? "Generating…" : "Generate Tests"}
            </button>
          ) : null}
          {testGenBusy ? (
            <button
              type="button"
              className="ed-reload ui-tip"
              onClick={cancelTestGeneration}
              data-tip="Cancel test generation"
            >
              Cancel
            </button>
          ) : null}
          {hasTarget ? (
            <button
              type="button"
              className="ed-save ui-tip"
              onClick={() => {
                if (canFormat) setFormatRequestNonce((value) => value + 1);
              }}
              aria-disabled={canFormat ? "false" : "true"}
              aria-label={
                canFormat
                  ? "Format document"
                  : `Formatting unavailable for ${formattingLanguageLabel}`
              }
              data-tip="Format document"
            >
              Format
            </button>
          ) : null}
          {hasTarget && saveStatus === "conflict" ? (
            <button
              type="button"
              className="ed-reload ui-tip"
              onClick={requestReload}
              data-tip="Reload from disk"
            >
              Reload
            </button>
          ) : null}
          {hasTarget ? (
            <button
              type="button"
              className="ed-save ui-tip"
              onClick={() => {
                if (canSave) void persist(content);
              }}
              aria-disabled={saveUnavailable}
              data-tip={saveStatus === "saving" ? "Saving changes" : "Save changes"}
            >
              {saveStatus === "saving" ? "Saving…" : "Save"}
            </button>
          ) : null}
        </div>
      </div>
      {recoverySnapshot !== null && !recoveryCompare ? (
        <div className="ed-recovery" role="status">
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
        </div>
      ) : null}
      {reloadConfirm ? (
        <div className="ed-dialog-backdrop" role="presentation">
          <div
            className="ed-dirty-dialog"
            ref={reloadConfirmRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="editor-reload-confirm-title"
            tabIndex={-1}
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
          </div>
        </div>
      ) : null}
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
      <EditorAgentActionsPanel agentSessionId={agentSessionId} refreshNonce={auditRefreshNonce} />
      <div className="ed-host" id={tabpanelId} role="tabpanel" aria-labelledby={tabId}>
        {panel}
      </div>
      {showUnifiedStatusBar && statusBarViewModel !== null ? (
        <EditorStatusBar viewModel={statusBarViewModel} />
      ) : null}
    </div>
  );
}
