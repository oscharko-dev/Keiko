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
 * Completion and test-generation are deliberately not wired here: their server features are
 * out of scope for this issue (#1199/#1200). The host-integration seam for them is the editor
 * package's typed `EditorHostPort`; this card wires only the `loadBuffer`/`saveDocument` equivalents
 * through the existing workspace Files API, leaving no disabled or placeholder affordances behind.
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  createFileModel,
  editorFileModelReducer,
  isDocumentDirty,
  isSupportedEditorLanguage,
  saveStatusReducer,
  type EditorBuffer,
  type EditorChangeOrigin,
  type EditorContentDelta,
  type EditorDocumentIdentity,
  type EditorFileModel,
  type EditorLanguageId,
  type EditorSaveRequest,
  type EditorSaveStatus,
  type KeikoEditorLoadState,
} from "@oscharko-dev/keiko-editor";
import { ApiError, fetchFilesContent, saveFilesContent } from "../../../../../lib/api";
import { Icons } from "../../Icons";
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

export function EditorWidget({ root, file }: EditorWidgetProps): ReactNode {
  const hasTarget = root !== undefined && root.length > 0 && file !== undefined && file.length > 0;

  const [content, setContent] = useState("");
  const [fileModel, setFileModel] = useState<EditorFileModel | null>(null);
  const [modifiedAt, setModifiedAt] = useState<number | null>(null);
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const [loadState, setLoadState] = useState<KeikoEditorLoadState>(
    hasTarget ? { status: "loading" } : { status: "ready" },
  );
  const [saveStatus, setSaveStatus] = useState<EditorSaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  // Refs the imperative save path reads so a Cmd/Ctrl+S immediately after an edit always persists
  // the latest values, independent of React state-batching timing.
  const modifiedAtRef = useRef<number | null>(null);
  modifiedAtRef.current = modifiedAt;
  const savingRef = useRef(false);
  savingRef.current = saveStatus === "saving";
  // The editor stays editable during a save; this ref lets the success handler tell whether the
  // buffer moved while the save was in flight so it never clobbers mid-flight edits.
  const contentRef = useRef("");
  contentRef.current = content;

  const dirty = fileModel !== null && isDocumentDirty(fileModel);

  const load = useCallback(
    (signal: { cancelled: boolean }): void => {
      if (!hasTarget) {
        setContent("");
        setFileModel(null);
        setModifiedAt(null);
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
      savingRef.current = true;
      setSaveStatus((status) => saveStatusReducer(status, { type: "request" }));
      setSaveError(undefined);
      try {
        const response = await saveFilesContent({
          root,
          path: file,
          content: text,
          expectedModifiedAt: modifiedAtRef.current ?? undefined,
        });
        // The persisted file moved on disk regardless of any concurrent edits — always adopt the new
        // concurrency token so the next save validates against it.
        setModifiedAt(response.modifiedAt);
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

  const canSave = hasTarget && dirty && saveStatus !== "saving" && loadState.status === "ready";

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
            onClick={() => void persist(content)}
            disabled={!canSave}
          >
            {saveStatus === "saving" ? "Saving…" : "Save"}
          </button>
        ) : null}
      </div>
      {hasTarget && buffer !== null && fileModel !== null ? (
        <div className="ed-host">
          <EditorSurface
            buffer={buffer}
            fileModel={fileModel}
            fileLoadState={loadState}
            saveStatus={saveStatus}
            saveError={saveError}
            modifiedAt={modifiedAt ?? undefined}
            maxSizeBytes={maxBytes ?? undefined}
            themeVariant="dark"
            onContentChange={onContentChange}
            onSaveRequested={onSaveRequested}
            onRuntimeError={onRuntimeError}
          />
        </div>
      ) : hasTarget ? (
        <div className="ed-host">
          {loadState.status === "error" ? (
            // Error is announced assertively (role="alert"), distinct from the polite loading region,
            // and is recoverable: Retry re-runs the load (the file may now be readable).
            <div className="ed-host-loading" role="alert">
              <span>{`Editor failed to load: ${loadState.message}`}</span>
              <button type="button" className="ed-reload" onClick={reload}>
                Retry
              </button>
            </div>
          ) : (
            <div className="ed-host-loading" role="status">
              Loading file…
            </div>
          )}
        </div>
      ) : (
        <div className="ed-empty" role="note">
          Choose a file from the Files window and use <strong>Open in editor</strong>.
        </div>
      )}
    </div>
  );
}
