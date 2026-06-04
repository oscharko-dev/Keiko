"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, fetchFilesPreview } from "../../../../../lib/api";
import type { FilesPreviewResponse } from "../../../../../lib/types";
import { Icons } from "../../Icons";
import { FileIcon } from "../shared/projectTree";
import { highlightLines, langOf, type Token } from "./shared/syntaxHighlight";

interface FilePreviewProps {
  readonly root: string;
  readonly path: string;
  readonly onClose: () => void;
}

// Server-defined deny is a safety invariant the user must not be able to probe.
// The UI renders a generic message that names common deny patterns by class but
// never reveals the requested path or the specific matched pattern.
const DENIED_PREVIEW_MESSAGE =
  "This file is excluded from the read surface for safety (matches a deny pattern such as .env, *.pem, node_modules, .git, …).";
const MAX_HIGHLIGHT_BYTES = 200_000;

interface PreviewError {
  readonly message: string;
  readonly denied: boolean;
}

function classifyError(error: unknown): PreviewError {
  if (error instanceof ApiError && error.code === "DENIED") {
    return { message: DENIED_PREVIEW_MESSAGE, denied: true };
  }
  if (error instanceof Error) {
    return { message: error.message, denied: false };
  }
  return { message: "Unable to read this file.", denied: false };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  const value = idx === 0 ? size.toFixed(0) : size.toFixed(size >= 10 ? 1 : 2);
  return `${value} ${units[idx]}`;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function previewKindLabel(preview: FilesPreviewResponse): string {
  if (preview.kind === "text") return langOf(preview.name);
  if (preview.kind === "image") return preview.mime;
  return preview.extension ?? "binary";
}

function MetadataRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className="fpv-meta-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function FilePreview({ root, path, onClose }: FilePreviewProps): ReactNode {
  const [preview, setPreview] = useState<FilesPreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PreviewError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPreview(null);
    void fetchFilesPreview(root, path)
      .then((response) => {
        if (!cancelled) setPreview(response);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(classifyError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, root]);

  const denied = error?.denied === true;
  const lang =
    preview !== null
      ? previewKindLabel(preview)
      : denied
        ? "denied"
        : error !== null
          ? "error"
          : "loading";
  const headerName = denied
    ? "Hidden file"
    : (preview?.name ?? (error !== null ? "Preview unavailable" : "Loading preview"));
  const headerTitle = headerName;
  const shouldHighlight = preview?.kind === "text" && preview.content.length <= MAX_HIGHLIGHT_BYTES;
  const lines: readonly (readonly Token[])[] =
    preview?.kind === "text"
      ? shouldHighlight
        ? highlightLines(preview.content, langOf(preview.name))
        : preview.content.split("\n").map((line): readonly Token[] => [["id", line]])
      : [];

  return (
    <div className="fpv">
      <div className="fpv-bar">
        <button
          className="fpv-back"
          type="button"
          onClick={onClose}
          title="Back to files"
          aria-label="Back to files"
        >
          <Icons.back size={15} />
        </button>
        <FileIcon name={denied || preview === null ? "" : preview.name} />
        <span className="fpv-name" title={headerTitle}>
          {headerName}
        </span>
        <span className="fpv-lang mono">{lang}</span>
        <span className="spacer" />
        <button
          className="fpv-back"
          type="button"
          onClick={onClose}
          title="Close preview"
          aria-label="Close preview"
        >
          <Icons.close size={15} />
        </button>
      </div>

      {loading ? <div className="fpv-state">Loading preview...</div> : null}
      {error !== null ? (
        <div className="fpv-state fpv-error" role="alert">
          {error.message}
        </div>
      ) : null}

      {preview?.kind === "text" ? (
        <>
          {preview.truncated ? (
            <div className="fpv-banner">
              Preview truncated at {formatBytes(preview.maxBytes)}. Open the file in the editor for
              full content.
            </div>
          ) : null}
          {!shouldHighlight ? (
            <div className="fpv-banner">Syntax highlighting disabled for large previews.</div>
          ) : null}
          <div className="fpv-code mono">
            {lines.map((toks, i) => (
              <div className="fpv-line" key={i}>
                <span className="fpv-num">{i + 1}</span>
                <span className="fpv-src">
                  {toks.map((t, j) => (
                    <span key={j} className={`hl-${t[0]}`}>
                      {t[1]}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {preview?.kind === "image" ? (
        <div className="fpv-image-pane">
          <div className="fpv-image-card">
            {/* eslint-disable-next-line @next/next/no-img-element -- local BFF returns a size-capped data URL preview */}
            <img className="fpv-image" src={preview.dataUrl} alt={preview.name} />
          </div>
          <div className="fpv-meta">
            <MetadataRow label="Type" value={preview.mime} />
            <MetadataRow label="Size" value={formatBytes(preview.sizeBytes)} />
            <MetadataRow label="Modified" value={formatDate(preview.modifiedAt)} />
          </div>
        </div>
      ) : null}

      {preview?.kind === "binary" ? (
        <div className="fpv-meta-pane">
          <div className="fpv-meta-card">
            <FileIcon name={preview.name} />
            <h3>{preview.name}</h3>
            <p>
              {preview.reason === "too_large"
                ? `Preview disabled because this file exceeds ${formatBytes(preview.maxBytes ?? 0)}.`
                : "No safe text or image preview is available for this file type."}
            </p>
            <div className="fpv-meta">
              <MetadataRow label="Type" value={preview.mime} />
              <MetadataRow label="Extension" value={preview.extension ?? "none"} />
              <MetadataRow label="Size" value={formatBytes(preview.sizeBytes)} />
              <MetadataRow label="Modified" value={formatDate(preview.modifiedAt)} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
