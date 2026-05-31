"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { fetchFilesPreview } from "../../../../../lib/api";
import type { FilesPreviewResponse } from "../../../../../lib/types";
import { Icons } from "../../Icons";
import { FileIcon } from "../shared/projectTree";
import { highlightLines, langOf } from "./shared/syntaxHighlight";

interface FilePreviewProps {
  readonly root: string;
  readonly path: string;
  readonly onClose: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to read this file.";
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

function MetadataRow({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
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
  const [error, setError] = useState<string | null>(null);

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
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, root]);

  const lang = preview !== null ? previewKindLabel(preview) : "loading";
  const lines = preview?.kind === "text" ? highlightLines(preview.content, langOf(preview.name)) : [];

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
        <FileIcon name={preview?.name ?? path} />
        <span className="fpv-name" title={path}>{preview?.name ?? path}</span>
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
      {error !== null ? <div className="fpv-state fpv-error">{error}</div> : null}

      {preview?.kind === "text" ? (
        <>
          {preview.truncated ? (
            <div className="fpv-banner">
              Preview truncated at {formatBytes(preview.maxBytes)}. Open the file in the editor for full content.
            </div>
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
