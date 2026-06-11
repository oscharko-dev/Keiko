"use client";

import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { ApiError, fetchFilesContent, saveFilesContent } from "../../../../../lib/api";
import { Icons } from "../../Icons";

interface EditorWidgetProps {
  readonly root?: string;
  readonly file?: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "The file could not be loaded.";
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

export function EditorWidget({ root, file }: EditorWidgetProps): ReactNode {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [modifiedAt, setModifiedAt] = useState<number | null>(null);
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const [loading, setLoading] = useState(root !== undefined && file !== undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const hasTarget = root !== undefined && root.length > 0 && file !== undefined && file.length > 0;
  const dirty = hasTarget && content !== savedContent;

  useEffect(() => {
    if (!hasTarget) {
      setContent("");
      setSavedContent("");
      setModifiedAt(null);
      setMaxBytes(null);
      setLoading(false);
      setSaving(false);
      setError(null);
      setNotice(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotice(null);
    void fetchFilesContent(root, file)
      .then((response) => {
        if (cancelled) return;
        setContent(response.content);
        setSavedContent(response.content);
        setModifiedAt(response.modifiedAt);
        setMaxBytes(response.maxBytes);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hasTarget, root, file]);

  const save = async (): Promise<void> => {
    if (!hasTarget || !dirty || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await saveFilesContent({
        root,
        path: file,
        content,
        expectedModifiedAt: modifiedAt ?? undefined,
      });
      setContent(response.content);
      setSavedContent(response.content);
      setModifiedAt(response.modifiedAt);
      setMaxBytes(response.maxBytes);
      setNotice(`Saved ${formatDate(response.modifiedAt)}`);
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  };

  const statusText = useMemo(() => {
    if (!hasTarget) return "Open a file from the Files window to start editing.";
    if (loading) return "Loading file…";
    if (saving) return "Saving…";
    if (error !== null) return error;
    if (notice !== null) return notice;
    if (dirty) return "Unsaved changes";
    if (modifiedAt !== null) return `Saved ${formatDate(modifiedAt)}`;
    return "Ready";
  }, [dirty, error, hasTarget, loading, modifiedAt, notice, saving]);

  return (
    <div className="editor">
      <div className="ed-tabs mono">
        <span className="ed-tab active">
          <Icons.editor size={12} /> {file ?? "Editor"}
        </span>
        <span className="spacer" />
        {hasTarget ? (
          <button
            type="button"
            className="ed-save"
            onClick={() => void save()}
            disabled={!dirty || loading || saving}
          >
            Save
          </button>
        ) : null}
      </div>
      <div className="ed-meta">
        <span className="ed-status" role={error !== null ? "alert" : "status"}>
          {statusText}
        </span>
        {maxBytes !== null ? <span className="ed-limit mono">Limit {maxBytes.toLocaleString()} B</span> : null}
      </div>
      {!hasTarget ? (
        <div className="ed-empty" role="note">
          Choose a file from the Files window and use <strong>Open in editor</strong>.
        </div>
      ) : (
        <textarea
          className="ed-textarea mono"
          aria-label={file !== undefined ? `Editor: ${file}` : "Editor"}
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            if (notice !== null) setNotice(null);
          }}
          onKeyDown={onEditorKeyDown}
          disabled={loading || saving || error !== null}
          spellCheck={false}
        />
      )}
    </div>
  );
}
