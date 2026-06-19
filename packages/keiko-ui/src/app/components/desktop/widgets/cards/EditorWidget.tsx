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
 * Test-generation remains out of scope (its wave-2 server features are not yet enabled).
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  createFileModel,
  DEFAULT_COMPLETION_TRIGGER_CHARACTERS,
  editorFileModelReducer,
  isDocumentDirty,
  isSupportedEditorLanguage,
  saveStatusReducer,
  type EditorBuffer,
  type EditorChangeOrigin,
  type EditorCompletionResolver,
  type EditorContentDelta,
  type EditorDocumentIdentity,
  type EditorFileModel,
  type EditorLanguageId,
  type EditorSaveRequest,
  type EditorSaveStatus,
  type KeikoEditorLoadState,
} from "@oscharko-dev/keiko-editor";
import {
  ApiError,
  fetchFilesContent,
  requestEditorCompletion,
  saveFilesContent,
} from "../../../../../lib/api";
import { mapWireToEditorCompletionResponse } from "../../../../../lib/editor-completion";
import type { EditorDocumentVersion } from "../../../../../lib/types";
import { Icons } from "../../Icons";
import { useEditorThemeVariant } from "../../hooks/useEditorThemeVariant";
import type { EditorSurfaceProps } from "./EditorSurface";

const EditorSurface = dynamic<EditorSurfaceProps>(() => import("./EditorSurface"), {
  ssr: false,
  loading: () => <div className="ed-host-loading" aria-hidden="true" />,
});

interface EditorWidgetProps {
  readonly root?: string;
  readonly file?: string;
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

/** A stable, host-scoped Monaco model URI for a (root, file) pair. */
function documentUri(root: string, file: string): string {
  return `${root.replace(/[/\\]+$/, "")}/${file}`;
}

function editorAriaLabel(root: string, file: string): string {
  return `Editor: ${file} in ${root}`;
}

export function EditorWidget({ root, file }: EditorWidgetProps): ReactNode {
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
        },
        signal,
      );
      return mapWireToEditorCompletionResponse(query.request.request, wire, Date.now());
    },
    [hasTarget, root, file],
  );

  // Completion has a governed deterministic provider only for the TS/JS source languages (#1198);
  // non-source buffers register no provider.
  const completionLanguage = fileModel?.identity.language;
  const completionEnabled =
    completionLanguage === "typescript" || completionLanguage === "javascript";

  const canSave = hasTarget && dirty && saveStatus !== "saving" && loadState.status === "ready";
  const saveUnavailable = !canSave;

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
            key={themeVariant}
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
