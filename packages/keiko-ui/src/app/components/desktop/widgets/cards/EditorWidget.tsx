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
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import {
  createEditorRequestId,
  createFileModel,
  DEFAULT_COMPLETION_TRIGGER_CHARACTERS,
  describeTestGenerationStatus,
  editorFileModelReducer,
  IDLE_TEST_GENERATION_STATE,
  isDocumentDirty,
  isSupportedEditorLanguage,
  isTestGenerationBusy,
  saveStatusReducer,
  testGenerationReducer,
  type EditorBuffer,
  type EditorChangeOrigin,
  type EditorCompletionResolver,
  type EditorContentDelta,
  type EditorDiagnosticsResolver,
  type EditorDocumentIdentity,
  type EditorFileModel,
  type EditorFormattingResolver,
  type EditorHoverResolver,
  type EditorInlineCompletionResolver,
  type EditorLanguageId,
  type EditorRequestIdentity,
  type EditorSaveRequest,
  type EditorSaveStatus,
  type EditorSymbolsResolver,
  type InlineCompletionTelemetrySnapshot,
  type KeikoEditorLoadState,
} from "@oscharko-dev/keiko-editor";
import {
  ApiError,
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
  EditorCompletionContextSelectors,
  EditorDocumentVersion,
  EditorTestGenerationWireTarget,
} from "../../../../../lib/types";
import { Icons } from "../../Icons";
import { useEditorThemeVariant } from "../../hooks/useEditorThemeVariant";
import type { EditorSurfaceProps } from "./EditorSurface";

const EditorSurface = dynamic<EditorSurfaceProps>(() => import("./EditorSurface"), {
  ssr: false,
  loading: () => <div className="ed-host-loading" aria-hidden="true" />,
});

// Issue #1202: advisory coding-context budget for a test-generation run; the BFF clamps it to the
// server-owned `test-generation` purpose budget.
const TEST_GENERATION_CONTEXT_BUDGET_BYTES = 65_536;
// Content-free transport-failure message; the editor stays usable after a failed run.
const TEST_GENERATION_FAILURE_MESSAGE =
  "Test generation could not be reached. The editor is still usable.";

interface EditorWidgetProps {
  readonly root?: string;
  readonly file?: string;
  readonly linkedRoot?: string | null;
  readonly linkedFilePath?: string | undefined;
  readonly linkedCapsuleIds?: readonly string[] | undefined;
  readonly linkedCapsuleSetIds?: readonly string[] | undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "The file could not be loaded.";
}

/** Map a workspace path to a governed {@link EditorLanguageId}; non-source files are plaintext. */
function inferEditorLanguage(path: string): EditorLanguageId {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const byExt: Record<string, EditorLanguageId> = {
    ts: "typescript",
    tsx: "typescript",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
  };
  const language = byExt[ext] ?? "plaintext";
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

export function EditorWidget({
  root,
  file,
  linkedRoot,
  linkedFilePath,
  linkedCapsuleIds,
  linkedCapsuleSetIds,
}: EditorWidgetProps): ReactNode {
  const hasTarget = root !== undefined && root.length > 0 && file !== undefined && file.length > 0;

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
  // Issue #1202: the governed test-generation flow state (pure reducer owned by the editor package).
  // A monotonic sequence backs the cross-boundary request identity for stale-response discard.
  const [testGenState, dispatchTestGen] = useReducer(
    testGenerationReducer,
    IDLE_TEST_GENERATION_STATE,
  );
  const testGenSeqRef = useRef(0);

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

  const dirty = fileModel !== null && isDocumentDirty(fileModel);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  // Follow the live app appearance (light/dark/high-contrast). Keyed onto the surface below so a
  // theme switch remounts it, which re-runs the editor's on-mount theme registration against the
  // now-current design tokens — the editor registers only its mount-time variant.
  const themeVariant = useEditorThemeVariant();

  const load = useCallback(
    (signal: { cancelled: boolean }): void => {
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
      setLoadState({ status: "loading" });
      setSaveStatus("idle");
      setSaveError(undefined);
      void fetchFilesContent(root, file)
        .then((response) => {
          if (signal.cancelled) return;
          const identity: EditorDocumentIdentity = {
            uri: documentUri(root, file),
            language: inferEditorLanguage(file),
            version: 0,
          };
          setContent(response.content);
          setFileModel(createFileModel(identity));
          setModifiedAt(response.modifiedAt);
          setVersion(response.session.version);
          setMaxBytes(response.maxBytes);
          setLoadState({ status: "ready" });
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
    load(signal);
  }, [load]);

  const persist = useCallback(
    async (text: string): Promise<void> => {
      if (!hasTarget || savingRef.current) return;
      const textChangedBeforeReactCommitted = text !== contentRef.current;
      if (!dirtyRef.current && !textChangedBeforeReactCommitted) return;
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
      } catch (err: unknown) {
        if (err instanceof ApiError && err.status === 409) {
          // The persisted file moved underneath this save (optimistic-concurrency conflict). Keep the
          // buffer dirty and surface a recoverable conflict — never silently overwrite.
          setSaveStatus((status) => saveStatusReducer(status, { type: "conflicted" }));
        } else {
          setSaveError(errorMessage(err));
          setSaveStatus((status) => saveStatusReducer(status, { type: "failed" }));
        }
      } finally {
        savingRef.current = false;
      }
    },
    [hasTarget, root, file],
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

  const onRuntimeError = useCallback((message: string): void => {
    // A non-fatal theme-registration failure (e.g. the editor design tokens are not present on this
    // surface). The editor still renders with Monaco's base theme; surface it for diagnostics rather
    // than swallowing a system-boundary signal.
    // eslint-disable-next-line no-console -- non-fatal, observable diagnostic only.
    console.warn(`Keiko editor runtime notice: ${message}`);
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

  // Issue #1202: trigger governed unit-test generation for the whole current file. The host owns the
  // gated BFF call; the editor package owns the flow reducer (run status, stale-response discard) and,
  // when a candidate is eventually produced (wave 2), the diff-review surface. In v1 the server returns
  // `disabled`/`deferred`, so this surfaces a content-free status and the editor stays usable.
  const runTestGeneration = useCallback((): void => {
    if (!hasTarget || root === undefined || file === undefined || fileModel === null) {
      return;
    }
    const sequence = (testGenSeqRef.current += 1);
    const requestIdentity: EditorRequestIdentity = {
      requestId: createEditorRequestId(),
      streamId: "editor-test-generation",
      sequence,
    };
    const target: EditorTestGenerationWireTarget = {
      kind: "file",
      document: { path: file, languageId: fileModel.identity.language, text: contentRef.current },
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
    void requestEditorTestGeneration({
      root,
      target,
      contextBudgetBytes: TEST_GENERATION_CONTEXT_BUDGET_BYTES,
      ...(selectors === undefined ? {} : { context: selectors }),
    })
      .then((wire) => {
        dispatchTestGen({
          type: "resolve",
          outcome: mapWireToEditorTestGenerationOutcome(requestIdentity, wire),
        });
      })
      .catch(() => {
        dispatchTestGen({ type: "error", reason: TEST_GENERATION_FAILURE_MESSAGE });
      });
  }, [
    file,
    fileModel,
    hasTarget,
    linkedCapsuleIds,
    linkedCapsuleSetIds,
    linkedFilePath,
    linkedRoot,
    root,
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

  // Completion has a governed deterministic provider only for the TS/JS source languages (#1198);
  // non-source buffers register no provider. The #1201 language-intelligence surfaces share the same
  // governed deterministic TS/JS gate.
  const completionLanguage = fileModel?.identity.language;
  const completionEnabled =
    completionLanguage === "typescript" || completionLanguage === "javascript";
  const editorSurfaceKey = `${themeVariant ?? "dark"}:${completionEnabled ? "source" : "plain"}`;

  const canSave = hasTarget && dirty && saveStatus !== "saving" && loadState.status === "ready";
  const saveUnavailable = !canSave;

  // Issue #1202: the "Generate Tests" action is offered for governed TS/JS files; the server is the
  // authority and returns `disabled` while the wave-2 feature is switched off. The status line reflects
  // the flow reducer (a content-free message); a busy run disables the action.
  const testGenBusy = isTestGenerationBusy(testGenState);
  const canGenerateTests =
    hasTarget && completionEnabled && loadState.status === "ready" && !testGenBusy;
  const testGenStatusText = describeTestGenerationStatus(testGenState);

  const buffer: EditorBuffer | null =
    fileModel === null
      ? null
      : {
          language: fileModel.identity.language,
          readOnly: false,
          content: {
            relativePath: file ?? "",
            text: content,
            sizeBytes: new TextEncoder().encode(content).length,
            truncated: false,
          },
        };

  return (
    <div className="editor">
      <div className="ed-tabs mono">
        <span className="ed-tab active">
          <Icons.editor size={12} /> {file ?? "Editor"}
          {dirty ? (
            <span className="ed-dirty" aria-hidden="true" title="Unsaved changes">
              ●
            </span>
          ) : null}
        </span>
        <span className="spacer" />
        {hasTarget && completionEnabled ? (
          <button
            type="button"
            className="ed-save"
            onClick={() => {
              if (canGenerateTests) runTestGeneration();
            }}
            aria-disabled={!canGenerateTests}
            title="Generate unit tests for this file"
          >
            {testGenBusy ? "Generating…" : "Generate Tests"}
          </button>
        ) : null}
        {hasTarget && saveStatus === "conflict" ? (
          <button type="button" className="ed-reload" onClick={reload}>
            Reload
          </button>
        ) : null}
        {hasTarget ? (
          <button
            type="button"
            className="ed-save"
            onClick={() => {
              if (canSave) void persist(content);
            }}
            aria-disabled={saveUnavailable}
          >
            {saveStatus === "saving" ? "Saving…" : "Save"}
          </button>
        ) : null}
      </div>
      {testGenStatusText.length > 0 ? (
        <div className="ed-status" role="status">
          {testGenStatusText}
        </div>
      ) : null}
      {hasTarget && loadState.status === "error" ? (
        <div className="ed-host">
          <div className="ed-host-loading" role="alert">
            <span>{`Editor failed to load: ${loadState.message}`}</span>
            <button type="button" className="ed-reload" onClick={reload}>
              Retry
            </button>
          </div>
        </div>
      ) : hasTarget && buffer !== null && fileModel !== null ? (
        <div className="ed-host">
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
            onInlineCompletionTelemetry={
              completionEnabled ? onInlineCompletionTelemetry : undefined
            }
            provideDiagnostics={completionEnabled ? provideDiagnostics : undefined}
            provideHover={completionEnabled ? provideHover : undefined}
            provideSymbols={completionEnabled ? provideSymbols : undefined}
            provideFormatting={completionEnabled ? provideFormatting : undefined}
          />
        </div>
      ) : hasTarget ? (
        <div className="ed-host">
          <div className="ed-host-loading" role="status">
            Loading file…
          </div>
        </div>
      ) : (
        <div className="ed-empty" role="note">
          Choose a file from the Files window and use <strong>Open in editor</strong>.
        </div>
      )}
    </div>
  );
}
