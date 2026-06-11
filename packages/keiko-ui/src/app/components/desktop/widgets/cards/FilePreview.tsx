"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { ApiError, fetchFilesPreview } from "../../../../../lib/api";
import type { FilesPreviewResponse } from "../../../../../lib/types";
import { useOptionalChatSessionContext } from "../../context/ChatSessionContext";
import { Icons } from "../../Icons";
import { ScopeConnectButton } from "../../ScopeConnectButton";
import { FileIcon } from "../shared/projectTree";
import { highlightLines, langOf, type Token } from "./shared/syntaxHighlight";

interface FilePreviewProps {
  readonly root: string;
  readonly path: string;
  readonly onClose: () => void;
  readonly onOpenInEditor?: ((root: string, path: string) => void) | undefined;
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
    // fetchJson falls back to a bare "HTTP <status>" when the BFF error envelope is
    // unparseable — not a user-facing sentence (audit F044 C348).
    const message = /^HTTP \d+$/.test(error.message)
      ? "The file could not be loaded. Try again."
      : error.message;
    return { message, denied: false };
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
  // The chip shows the real file type (server-derived extension), not the internal
  // tokenizer bucket from langOf() — that bucket folds .rb into "py", build.gradle
  // into "js" and unknowns into "code", which reads as a wrong type label in the UI
  // (audit F044 C200). langOf stays highlight-only.
  if (preview.kind === "text") return preview.extension ?? "text";
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

export function FilePreview({
  root,
  path,
  onClose,
  onOpenInEditor,
}: FilePreviewProps): ReactNode {
  // Issue #184 — the connector binds the currently-previewed file (workspace-relative path)
  // onto the active chat. The chat session is consulted optionally: if no chat is active the
  // connector is hidden. The candidate is always a single-file scope (length 1) because the
  // FilesWidget routes selection through this preview view one file at a time.
  // useOptional* returns null when this component is rendered outside the chat session
  // (e.g. legacy file-browser-only tests or storybook usage); the connector then hides.
  const session = useOptionalChatSessionContext();
  const activeChat = session?.activeChat;
  const candidatePaths = path.length > 0 ? ([path] as const) : ([] as const);

  const [preview, setPreview] = useState<FilesPreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PreviewError | null>(null);
  // Bumping retryKey re-runs the fetch effect — transient failures (network, 500) get the
  // same Retry affordance the file tree already offers (audit F044 C348).
  const [retryKey, setRetryKey] = useState(0);
  const backRef = useRef<HTMLButtonElement | null>(null);

  // Focus management (WCAG 2.4.3): opening the preview unmounts the focused tree row, which
  // would drop focus onto document.body. Move it onto the Back button so keyboard and
  // screen-reader users land at the top of the new surface. preventScroll keeps the window
  // from jumping while the preview lays out.
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, []);

  // Escape closes the preview (shortcut for Back/Close). Scoped to the preview container and
  // stopped from propagating so global window shortcuts never double-handle it.
  const onPreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  };

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
  }, [path, root, retryKey]);

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
  const canOpenInEditor =
    onOpenInEditor !== undefined && preview?.kind === "text" && !preview.truncated;
  const lines: readonly (readonly Token[])[] =
    preview?.kind === "text"
      ? shouldHighlight
        ? highlightLines(preview.content, langOf(preview.name))
        : preview.content.split("\n").map((line): readonly Token[] => [["id", line]])
      : [];

  return (
    // The keydown listener is a keyboard shortcut for the Back/Close buttons inside this
    // container, not a standalone interaction — static-element-interactions does not apply.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div className="fpv" onKeyDown={onPreviewKeyDown}>
      <div className="fpv-bar">
        <button
          className="fpv-back"
          type="button"
          ref={backRef}
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
        {canOpenInEditor ? (
          <button
            className="fpv-back"
            type="button"
            onClick={() => onOpenInEditor(root, path)}
            title="Open in editor"
            aria-label="Open in editor"
          >
            <Icons.editor size={15} />
          </button>
        ) : null}
        {activeChat !== undefined && session !== null ? (
          <ScopeConnectButton
            chatId={activeChat.id}
            scopeKind="files"
            scopeRoot={root}
            currentScopeKind={activeChat.connectedScope?.kind}
            candidateRelativePaths={candidatePaths}
            chat={activeChat}
            onConnected={session.replaceChat}
          />
        ) : null}
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

      {loading ? (
        <div className="fpv-state" role="status">
          Loading preview…
        </div>
      ) : null}
      {error !== null ? (
        <div className="fpv-state fpv-error" role="alert">
          <span>{error.message}</span>
          {/* Denied is a deliberate safety invariant, not a transient failure — no Retry. */}
          {!error.denied ? (
            <button
              type="button"
              className="fpv-retry"
              onClick={() => setRetryKey((key) => key + 1)}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {preview?.kind === "text" ? (
        <>
          {preview.truncated ? (
            <div className="fpv-banner">
              Preview truncated at {formatBytes(preview.maxBytes)}. Larger files can&apos;t be shown
              in full here.
            </div>
          ) : null}
          {!shouldHighlight ? (
            <div className="fpv-banner">Syntax highlighting disabled for large previews.</div>
          ) : null}
          <div
            className="fpv-code mono"
            // Scrollable code pane: tabIndex makes the overflow region keyboard-scrollable
            // (WCAG 2.1.1); jsx-a11y's default allowlist only covers role="tabpanel".
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label={`File preview: ${preview.name}`}
            // The 44px default gutter fits 4 digits; previews under MAX_HIGHLIGHT_BYTES can
            // exceed 9,999 lines, so the gutter grows with the widest line number instead of
            // overflowing its fixed box (audit F044 C351). 16px = the gutter's padding-right.
            style={
              {
                "--fpv-gutter-w": `max(44px, calc(${String(String(lines.length).length)}ch + 16px))`,
              } as CSSProperties
            }
          >
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
