"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  Dispatch,
  KeyboardEvent,
  MutableRefObject,
  ReactNode,
  SetStateAction,
} from "react";
import { ApiError, fetchFilesPreview } from "../../../../../lib/api";
import { formatBytesPrecise as formatBytes } from "../../../../../lib/format";
import type { FilesPreviewResponse } from "../../../../../lib/types";
import { Icons } from "../../Icons";
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
// GEN-PERF-WIDGET-005 — the server caps a text preview at ~1 MB (~25k lines). Rendering every
// line eagerly produced ~75k–100k DOM nodes in one synchronous commit. Window the initial
// render to this many lines and reveal more on demand; the full content stays reachable.
const PREVIEW_LINE_BATCH = 500;
// Issue #1285 — Repository Search now extracts bounded text from small DOCX/XLSX/text-layer-PDF
// documents that are explicitly connected to a chat. The preview pane still shows no inline preview
// for these binary formats, but the copy reflects that they are searchable (within limits) rather
// than categorically unsupported.
const SEARCHABLE_DOCUMENT_LABELS: Readonly<Record<string, string>> = {
  docx: "DOCX",
  xlsx: "XLSX",
  pdf: "PDF",
};

function searchableDocumentMessage(label: string): string {
  return `${label} files up to 2 MB are searchable in Repository Search via bounded text extraction when explicitly connected to a chat. Encrypted, scanned, or larger documents are not extracted — use Local Knowledge for those. No inline preview is available for this format here.`;
}

interface PreviewError {
  readonly message: string;
  readonly denied: boolean;
}

type PreviewRefreshStatus = "idle" | "refreshing" | "refreshed" | "failed";
type MetadataCopyTarget = "name" | "path";

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

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function fullPreviewPath(root: string, relativePath: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[/\\]+$/u, "")}${separator}${relativePath.replace(/\//gu, separator)}`;
}

async function writeTextWithFallback(text: string): Promise<void> {
  const writeText = typeof navigator === "undefined" ? undefined : navigator.clipboard?.writeText;
  if (writeText !== undefined && navigator.clipboard !== undefined) {
    try {
      await writeText.call(navigator.clipboard, text);
      return;
    } catch {
      // Selection-backed copy can still work in restricted clipboard contexts.
    }
  }

  if (typeof document === "undefined" || document.body === null) {
    throw new Error("clipboard-unavailable");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  textarea.select();
  try {
    const copied = typeof document.execCommand === "function" && document.execCommand("copy");
    if (!copied) throw new Error("clipboard-fallback-failed");
  } finally {
    textarea.remove();
  }
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

function extensionForPreview(preview: FilesPreviewResponse): string {
  const extension = preview.extension?.trim().toLowerCase();
  if (extension !== undefined && extension.length > 0) return extension;
  const lastDot = preview.name.lastIndexOf(".");
  return lastDot >= 0
    ? preview.name
        .slice(lastDot + 1)
        .trim()
        .toLowerCase()
    : "";
}

function binaryPreviewMessage(
  preview: Extract<FilesPreviewResponse, { readonly kind: "binary" }>,
): string {
  if (preview.reason === "too_large") {
    return `Preview disabled because this file exceeds ${formatBytes(preview.maxBytes ?? 0)}.`;
  }
  const documentLabel = SEARCHABLE_DOCUMENT_LABELS[extensionForPreview(preview)];
  if (documentLabel !== undefined) {
    return searchableDocumentMessage(documentLabel);
  }
  return "No safe text or image preview is available for this file type.";
}

function resolvePreviewLangLabel(
  preview: FilesPreviewResponse | null,
  denied: boolean,
  error: PreviewError | null,
): string {
  if (preview !== null) return previewKindLabel(preview);
  if (denied) return "denied";
  if (error !== null) return "error";
  return "loading";
}

function resolveHeaderName(
  preview: FilesPreviewResponse | null,
  denied: boolean,
  error: PreviewError | null,
): string {
  if (denied) return "Hidden file";
  return preview?.name ?? (error !== null ? "Preview unavailable" : "Loading preview");
}

function resolveRefreshStatusText(status: PreviewRefreshStatus): string {
  if (status === "refreshing") return "Refreshing...";
  if (status === "refreshed") return "Reloaded";
  if (status === "failed") return "Refresh failed";
  return "";
}

function computePreviewLines(
  preview: FilesPreviewResponse | null,
  shouldHighlight: boolean,
): readonly (readonly Token[])[] {
  if (preview?.kind !== "text") return [];
  return shouldHighlight
    ? highlightLines(preview.content, langOf(preview.name))
    : preview.content.split("\n").map((line): readonly Token[] => [["id", line]]);
}

// The main load effect below runs on every (root, path, refreshKey) change. These three
// helpers isolate its state-transition logic so the effect body stays a plain sequence of
// calls (audit S3776 — cognitive complexity).
function determineIsManualRefresh(
  previousTarget: { readonly root: string; readonly path: string } | null,
  root: string,
  path: string,
  refreshKey: number,
): boolean {
  const targetChanged =
    previousTarget === null || previousTarget.root !== root || previousTarget.path !== path;
  return previousTarget !== null && !targetChanged && refreshKey > 0;
}

function beginPreviewLoad(
  isManualRefresh: boolean,
  setLoading: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<PreviewError | null>>,
  setRefreshStatus: Dispatch<SetStateAction<PreviewRefreshStatus>>,
  setPreview: Dispatch<SetStateAction<FilesPreviewResponse | null>>,
): void {
  setLoading(true);
  setError(null);
  setRefreshStatus(isManualRefresh ? "refreshing" : "idle");
  if (!isManualRefresh) setPreview(null);
}

function applyPreviewSuccess(
  response: FilesPreviewResponse,
  isManualRefresh: boolean,
  setPreview: Dispatch<SetStateAction<FilesPreviewResponse | null>>,
  setRefreshStatus: Dispatch<SetStateAction<PreviewRefreshStatus>>,
): void {
  setPreview(response);
  if (isManualRefresh) setRefreshStatus("refreshed");
}

function applyPreviewFailure(
  err: unknown,
  isManualRefresh: boolean,
  setError: Dispatch<SetStateAction<PreviewError | null>>,
  setRefreshStatus: Dispatch<SetStateAction<PreviewRefreshStatus>>,
): void {
  setError(classifyError(err));
  if (isManualRefresh) setRefreshStatus("failed");
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

interface FilePreviewBarProps {
  readonly root: string;
  readonly path: string;
  readonly preview: FilesPreviewResponse | null;
  readonly denied: boolean;
  readonly headerName: string;
  readonly headerTitle: string;
  readonly lang: string;
  readonly copyStatus: string | null;
  readonly loading: boolean;
  readonly refreshStatus: PreviewRefreshStatus;
  readonly refreshStatusText: string;
  readonly canOpenInEditor: boolean;
  readonly onCopyMetadata: (target: MetadataCopyTarget) => void;
  readonly onRefresh: () => void;
  readonly onOpenInEditor: ((root: string, path: string) => void) | undefined;
  readonly onClose: () => void;
  readonly backRef: MutableRefObject<HTMLButtonElement | null>;
}

// The header bar's action cluster (copy buttons, refresh, open-in-editor, close) — split out
// of FilePreview so its several independent `? ... : null` toggles don't compound the parent
// component's cognitive complexity (audit S3776).
function FilePreviewBar({
  root,
  path,
  preview,
  denied,
  headerName,
  headerTitle,
  lang,
  copyStatus,
  loading,
  refreshStatus,
  refreshStatusText,
  canOpenInEditor,
  onCopyMetadata,
  onRefresh,
  onOpenInEditor,
  onClose,
  backRef,
}: FilePreviewBarProps): ReactNode {
  return (
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
      {preview !== null ? (
        <>
          <button
            className="fpv-back fpv-copy"
            type="button"
            onClick={() => onCopyMetadata("name")}
            title="Copy file name"
            aria-label="Copy file name"
          >
            <Icons.copy size={13} />
          </button>
          <button
            className="fpv-back fpv-copy"
            type="button"
            onClick={() => onCopyMetadata("path")}
            title="Copy file path"
            aria-label="Copy file path"
          >
            <Icons.copy size={13} />
          </button>
        </>
      ) : null}
      <span className="fpv-lang mono">{lang}</span>
      <span className="spacer" />
      {copyStatus !== null ? (
        <span
          className="fpv-status fpv-copy-status"
          role={copyStatus === "Clipboard access failed." ? "alert" : "status"}
          aria-live="polite"
        >
          {copyStatus}
        </span>
      ) : null}
      <button
        className="fpv-back fpv-refresh"
        type="button"
        onClick={onRefresh}
        disabled={loading}
        data-state={refreshStatus}
        title={loading ? "Refreshing preview" : "Refresh preview"}
        aria-label={loading ? "Refreshing preview" : "Refresh preview"}
      >
        <Icons.reset size={14} />
      </button>
      {refreshStatusText.length > 0 ? (
        <span
          className="fpv-status mono"
          data-state={refreshStatus}
          role="status"
          aria-live="polite"
        >
          {refreshStatusText}
        </span>
      ) : null}
      {canOpenInEditor ? (
        <button
          className="fpv-back"
          type="button"
          onClick={() => onOpenInEditor?.(root, path)}
          title="Open in editor"
          aria-label="Open in editor"
        >
          <Icons.editor size={15} />
        </button>
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
  );
}

interface FilePreviewStatusBlockProps {
  readonly loading: boolean;
  readonly preview: FilesPreviewResponse | null;
  readonly error: PreviewError | null;
  readonly onRetry: () => void;
}

// Loading and error surfaces — the error branch nests a conditional Retry button, which is
// exactly the kind of nested-ternary shape that inflates cognitive complexity in place.
function FilePreviewStatusBlock({
  loading,
  preview,
  error,
  onRetry,
}: FilePreviewStatusBlockProps): ReactNode {
  return (
    <>
      {loading && preview === null ? (
        <div className="fpv-state" role="status">
          Loading preview…
        </div>
      ) : null}
      {error !== null ? (
        <div className="fpv-state fpv-error" role="alert">
          <span>{error.message}</span>
          {/* Denied is a deliberate safety invariant, not a transient failure — no Retry. */}
          {!error.denied ? (
            <button type="button" className="fpv-retry" onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

interface FilePreviewTextBodyProps {
  readonly preview: Extract<FilesPreviewResponse, { readonly kind: "text" }>;
  readonly lines: readonly (readonly Token[])[];
  readonly visibleLines: readonly (readonly Token[])[];
  readonly hiddenLineCount: number;
  readonly shouldHighlight: boolean;
  readonly onShowMore: () => void;
}

// Text-kind preview body: truncation/highlight banners, the windowed code pane, and the
// "show more lines" control (GEN-PERF-WIDGET-005).
function FilePreviewTextBody({
  preview,
  lines,
  visibleLines,
  hiddenLineCount,
  shouldHighlight,
  onShowMore,
}: FilePreviewTextBodyProps): ReactNode {
  return (
    <>
      {preview.truncated ? (
        <div className="fpv-banner">
          Preview truncated at {formatBytes(preview.maxBytes)}. Larger files can&apos;t be shown in
          full here.
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
        {visibleLines.map((toks, i) => (
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
        {hiddenLineCount > 0 ? (
          <button type="button" className="fpv-retry fpv-show-more" onClick={onShowMore}>
            Show {Math.min(PREVIEW_LINE_BATCH, hiddenLineCount)} more lines
          </button>
        ) : null}
      </div>
    </>
  );
}

interface FilePreviewImageBodyProps {
  readonly preview: Extract<FilesPreviewResponse, { readonly kind: "image" }>;
}

function FilePreviewImageBody({ preview }: FilePreviewImageBodyProps): ReactNode {
  return (
    <div className="fpv-image-pane">
      <div className="fpv-image-card">
        {/* eslint-disable-next-line @next/next/no-img-element -- local BFF streams a size-capped image preview */}
        <img className="fpv-image" src={preview.url} alt={preview.name} />
      </div>
      <div className="fpv-meta">
        <MetadataRow label="Type" value={preview.mime} />
        <MetadataRow label="Size" value={formatBytes(preview.sizeBytes)} />
        <MetadataRow label="Modified" value={formatDate(preview.modifiedAt)} />
      </div>
    </div>
  );
}

interface FilePreviewBinaryBodyProps {
  readonly preview: Extract<FilesPreviewResponse, { readonly kind: "binary" }>;
}

function FilePreviewBinaryBody({ preview }: FilePreviewBinaryBodyProps): ReactNode {
  return (
    <div className="fpv-meta-pane">
      <div className="fpv-meta-card">
        <FileIcon name={preview.name} />
        <h3>{preview.name}</h3>
        <p>{binaryPreviewMessage(preview)}</p>
        <div className="fpv-meta">
          <MetadataRow label="Type" value={preview.mime} />
          <MetadataRow label="Extension" value={preview.extension ?? "none"} />
          <MetadataRow label="Size" value={formatBytes(preview.sizeBytes)} />
          <MetadataRow label="Modified" value={formatDate(preview.modifiedAt)} />
        </div>
      </div>
    </div>
  );
}

export function FilePreview({ root, path, onClose, onOpenInEditor }: FilePreviewProps): ReactNode {
  const [preview, setPreview] = useState<FilesPreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PreviewError | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshStatus, setRefreshStatus] = useState<PreviewRefreshStatus>("idle");
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const loadTargetRef = useRef<{ readonly root: string; readonly path: string } | null>(null);

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
    const previousTarget = loadTargetRef.current;
    const isManualRefresh = determineIsManualRefresh(previousTarget, root, path, refreshKey);
    loadTargetRef.current = { root, path };

    beginPreviewLoad(isManualRefresh, setLoading, setError, setRefreshStatus, setPreview);

    void fetchFilesPreview(root, path)
      .then((response) => {
        if (!cancelled)
          applyPreviewSuccess(response, isManualRefresh, setPreview, setRefreshStatus);
      })
      .catch((err: unknown) => {
        if (!cancelled) applyPreviewFailure(err, isManualRefresh, setError, setRefreshStatus);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, root, refreshKey]);

  useEffect(() => {
    if (refreshStatus !== "refreshed") return undefined;
    const timer = window.setTimeout(() => setRefreshStatus("idle"), 2400);
    return () => window.clearTimeout(timer);
  }, [refreshStatus]);

  const refreshPreview = (): void => setRefreshKey((key) => key + 1);
  const copyMetadata = (target: MetadataCopyTarget): void => {
    if (preview === null) return;
    const value = target === "name" ? preview.name : fullPreviewPath(preview.root, preview.path);
    setCopyStatus(null);
    void writeTextWithFallback(value).then(
      () => setCopyStatus(target === "name" ? "File name copied" : "File path copied"),
      () => setCopyStatus("Clipboard access failed."),
    );
  };

  const denied = error?.denied === true;
  const lang = resolvePreviewLangLabel(preview, denied, error);
  const headerName = resolveHeaderName(preview, denied, error);
  const headerTitle = headerName;
  const shouldHighlight = preview?.kind === "text" && preview.content.length <= MAX_HIGHLIGHT_BYTES;
  const canOpenInEditor =
    onOpenInEditor !== undefined && preview?.kind === "text" && !preview.truncated;
  const refreshStatusText = resolveRefreshStatusText(refreshStatus);
  const lines: readonly (readonly Token[])[] = useMemo(
    () => computePreviewLines(preview, shouldHighlight),
    [preview, shouldHighlight],
  );

  // GEN-PERF-WIDGET-005 — bounded initial render window over `lines`. Reset whenever the
  // underlying content changes so a new file always starts at the first batch.
  const [visibleLineCount, setVisibleLineCount] = useState(PREVIEW_LINE_BATCH);
  useEffect(() => {
    setVisibleLineCount(PREVIEW_LINE_BATCH);
  }, [lines]);
  const visibleLines = useMemo(
    () => (lines.length > visibleLineCount ? lines.slice(0, visibleLineCount) : lines),
    [lines, visibleLineCount],
  );
  const hiddenLineCount = Math.max(0, lines.length - visibleLineCount);

  return (
    // The keydown listener is a keyboard shortcut for the Back/Close buttons inside this
    // container, not a standalone interaction — static-element-interactions does not apply.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div className="fpv" onKeyDown={onPreviewKeyDown}>
      <FilePreviewBar
        root={root}
        path={path}
        preview={preview}
        denied={denied}
        headerName={headerName}
        headerTitle={headerTitle}
        lang={lang}
        copyStatus={copyStatus}
        loading={loading}
        refreshStatus={refreshStatus}
        refreshStatusText={refreshStatusText}
        canOpenInEditor={canOpenInEditor}
        onCopyMetadata={copyMetadata}
        onRefresh={refreshPreview}
        onOpenInEditor={onOpenInEditor}
        onClose={onClose}
        backRef={backRef}
      />

      <FilePreviewStatusBlock
        loading={loading}
        preview={preview}
        error={error}
        onRetry={refreshPreview}
      />

      {preview?.kind === "text" ? (
        <FilePreviewTextBody
          preview={preview}
          lines={lines}
          visibleLines={visibleLines}
          hiddenLineCount={hiddenLineCount}
          shouldHighlight={shouldHighlight}
          onShowMore={() =>
            setVisibleLineCount((count) => Math.min(lines.length, count + PREVIEW_LINE_BATCH))
          }
        />
      ) : null}

      {preview?.kind === "image" ? <FilePreviewImageBody preview={preview} /> : null}

      {preview?.kind === "binary" ? <FilePreviewBinaryBody preview={preview} /> : null}
    </div>
  );
}
