"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { ApiError, fetchFilesPreview } from "../../../../../lib/api";
import { copyTextToClipboard } from "../../../../../lib/clipboard";
import { formatBytesPrecise as formatBytes } from "../../../../../lib/format";
import type { FilesPreviewResponse } from "../../../../../lib/types";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { Icons } from "../../Icons";
import { FileIcon } from "../shared/projectTree";
import { highlightLines, langOf, type Token } from "./shared/syntaxHighlight";
import { NATIVE_BLOCK_STYLE } from "../../native-element-styles";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const BackIcon = Icons.back;
const CopyIcon = Icons.copy;
const ResetIcon = Icons.reset;
const EditorIcon = Icons.editor;
const CloseIcon = Icons.close;

interface FilePreviewProps {
  readonly root: string;
  readonly path: string;
  readonly onClose: () => void;
  readonly onOpenInEditor?: ((root: string, path: string) => void) | undefined;
}

// Server-defined deny is a safety invariant the user must not be able to probe.
// The UI renders a generic message that names common deny patterns by class but
// never reveals the requested path or the specific matched pattern.
function deniedPreviewMessage(t: I18nTranslate): string {
  return t("filePreview.deniedMessage");
}
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

function searchableDocumentMessage(label: string, t: I18nTranslate): string {
  return t("filePreview.searchableDocument", { format: label });
}

interface PreviewError {
  readonly message: string;
  readonly denied: boolean;
}

type PreviewRefreshStatus = "idle" | "refreshing" | "refreshed" | "failed";
type MetadataCopyTarget = "name" | "path";
type CopyStatusKind = "nameCopied" | "pathCopied" | "clipboardFailed";

function classifyError(error: unknown, t: I18nTranslate): PreviewError {
  if (error instanceof ApiError && error.code === "DENIED") {
    return { message: deniedPreviewMessage(t), denied: true };
  }
  if (error instanceof Error) {
    // fetchJson falls back to a bare "HTTP <status>" when the BFF error envelope is
    // unparseable — not a user-facing sentence (audit F044 C348).
    const message = /^HTTP \d+$/.test(error.message)
      ? t("filePreview.error.loadFailed")
      : error.message;
    return { message, denied: false };
  }
  return { message: t("filePreview.error.unreadable"), denied: false };
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

// Strips trailing "/" and "\" characters from a root path. Plain string scan from the end
// instead of the `/[/\\]+$/` regex it replaces: that pattern was unanchored at the start, so
// matching it against a long run of separators that never reaches the end (e.g. a root string
// built entirely from repeated separators) forced the engine to retry the trailing-run
// backtrack from every position, which is quadratic in the input length (S8786).
function stripTrailingPathSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "/" || value[end - 1] === "\\")) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function fullPreviewPath(root: string, relativePath: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const normalizedRelativePath = relativePath.replaceAll("/", separator);
  return `${stripTrailingPathSeparators(root)}${separator}${normalizedRelativePath}`;
}

function previewKindLabel(preview: FilesPreviewResponse, t: I18nTranslate): string {
  // The chip shows the real file type (server-derived extension), not the internal
  // tokenizer bucket from langOf() — that bucket folds .rb into "py", build.gradle
  // into "js" and unknowns into "code", which reads as a wrong type label in the UI
  // (audit F044 C200). langOf stays highlight-only.
  if (preview.kind === "text") return preview.extension ?? t("filePreview.lang.text");
  if (preview.kind === "image") return preview.mime;
  return preview.extension ?? t("filePreview.lang.binary");
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
  t: I18nTranslate,
): string {
  if (preview.reason === "too_large") {
    return t("filePreview.binary.tooLarge", { maxBytes: formatBytes(preview.maxBytes ?? 0) });
  }
  const documentLabel = SEARCHABLE_DOCUMENT_LABELS[extensionForPreview(preview)];
  if (documentLabel !== undefined) {
    return searchableDocumentMessage(documentLabel, t);
  }
  return t("filePreview.binary.unsupported");
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

// The copy feedback owns its own live-region decision so FilePreview does not carry it.
// <output> already carries role="status"; only the clipboard failure needs the more assertive
// region, so that is the one case that names a role — and role="alert" is implicitly assertive,
// so aria-live is dropped there. Declaring both is a conflict screen readers resolve
// inconsistently (#2721).
function CopyStatusOutput({
  status,
  t,
}: {
  readonly status: CopyStatusKind | null;
  readonly t: I18nTranslate;
}): ReactNode {
  if (status === null) return null;
  const failed = status === "clipboardFailed";
  return (
    <output
      className="fpv-status fpv-copy-status"
      role={failed ? "alert" : undefined}
      aria-live={failed ? undefined : "polite"}
    >
      {copyStatusLabel(status, t)}
    </output>
  );
}

function copyStatusLabel(status: CopyStatusKind | null, t: I18nTranslate): string | null {
  switch (status) {
    case "nameCopied":
      return t("filePreview.copyStatus.nameCopied");
    case "pathCopied":
      return t("filePreview.copyStatus.pathCopied");
    case "clipboardFailed":
      return t("filePreview.copyStatus.clipboardFailed");
    case null:
      return null;
  }
}

function previewHeaderName(
  preview: FilesPreviewResponse | null,
  error: PreviewError | null,
  t: I18nTranslate,
): string {
  if (error?.denied === true) return t("filePreview.hiddenFile");
  if (preview !== null) return preview.name;
  return error === null ? t("filePreview.headerLoading") : t("filePreview.previewUnavailable");
}

function previewLanguageLabel(
  preview: FilesPreviewResponse | null,
  error: PreviewError | null,
  t: I18nTranslate,
): string {
  if (preview !== null) return previewKindLabel(preview, t);
  if (error?.denied === true) return t("filePreview.lang.denied");
  return error === null ? t("filePreview.lang.loading") : t("filePreview.lang.error");
}

function refreshStatusLabel(status: PreviewRefreshStatus, t: I18nTranslate): string {
  switch (status) {
    case "refreshing":
      return t("filePreview.refreshStatus.refreshing");
    case "refreshed":
      return t("filePreview.refreshStatus.reloaded");
    case "failed":
      return t("filePreview.refreshStatus.failed");
    case "idle":
      return "";
  }
}

function previewTokenLines(
  preview: FilesPreviewResponse | null,
  shouldHighlight: boolean,
): readonly (readonly Token[])[] {
  if (preview?.kind !== "text") return [];
  if (shouldHighlight) return highlightLines(preview.content, langOf(preview.name));
  return preview.content.split("\n").map((line): readonly Token[] => [["id", line]]);
}

function canOpenPreviewInEditor(
  preview: FilesPreviewResponse | null,
  onOpenInEditor: FilePreviewProps["onOpenInEditor"],
): boolean {
  return onOpenInEditor !== undefined && preview?.kind === "text" && !preview.truncated;
}

function highlightedTokenSpans(tokens: readonly Token[]): ReactNode {
  let offset = 0;
  return tokens.map((tok) => {
    const key = `${tok[0]}:${String(offset)}:${tok[1]}`;
    offset += tok[1].length;
    return (
      <span key={key} className={`hl-${tok[0]}`}>
        {tok[1]}
      </span>
    );
  });
}

interface TextFilePreviewProps {
  readonly preview: Extract<FilesPreviewResponse, { readonly kind: "text" }>;
  readonly shouldHighlight: boolean;
  readonly lines: readonly (readonly Token[])[];
  readonly visibleLineRows: readonly {
    readonly lineNumber: number;
    readonly tokens: readonly Token[];
  }[];
  readonly hiddenLineCount: number;
  readonly onShowMore: () => void;
  readonly t: I18nTranslate;
}

function TextFilePreview(props: TextFilePreviewProps): ReactNode {
  return (
    <>
      {props.preview.truncated ? (
        <div className="fpv-banner">
          {props.t("filePreview.truncatedBanner", {
            maxBytes: formatBytes(props.preview.maxBytes),
          })}
        </div>
      ) : null}
      {!props.shouldHighlight ? (
        <div className="fpv-banner">{props.t("filePreview.syntaxHighlightDisabled")}</div>
      ) : null}
      <section
        className="fpv-code mono"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 focusable scroll region
        tabIndex={0}
        aria-label={props.t("filePreview.previewRegionLabel", { name: props.preview.name })}
        style={
          {
            "--fpv-gutter-w": `max(44px, calc(${String(String(props.lines.length).length)}ch + 16px))`,
          } as CSSProperties
        }
      >
        {props.visibleLineRows.map((row) => (
          <div className="fpv-line" key={`line-${String(row.lineNumber)}`}>
            <span className="fpv-num">{row.lineNumber}</span>
            <span className="fpv-src">{highlightedTokenSpans(row.tokens)}</span>
          </div>
        ))}
        {props.hiddenLineCount > 0 ? (
          <button type="button" className="fpv-retry fpv-show-more" onClick={props.onShowMore}>
            {props.t("filePreview.showMoreLines", {
              count: Math.min(PREVIEW_LINE_BATCH, props.hiddenLineCount),
            })}
          </button>
        ) : null}
      </section>
    </>
  );
}

function ImageFilePreview({
  preview,
  t,
}: {
  readonly preview: Extract<FilesPreviewResponse, { readonly kind: "image" }>;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <div className="fpv-image-pane">
      <div className="fpv-image-card">
        {/* eslint-disable-next-line @next/next/no-img-element -- local BFF streams a size-capped image preview */}
        <img className="fpv-image" src={preview.url} alt={preview.name} />
      </div>
      <div className="fpv-meta">
        <MetadataRow label={t("filePreview.metadata.type")} value={preview.mime} />
        <MetadataRow
          label={t("filePreview.metadata.size")}
          value={formatBytes(preview.sizeBytes)}
        />
        <MetadataRow
          label={t("filePreview.metadata.modified")}
          value={formatDate(preview.modifiedAt)}
        />
      </div>
    </div>
  );
}

function BinaryFilePreview({
  preview,
  t,
}: {
  readonly preview: Extract<FilesPreviewResponse, { readonly kind: "binary" }>;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <div className="fpv-meta-pane">
      <div className="fpv-meta-card">
        <FileIcon name={preview.name} />
        <h3>{preview.name}</h3>
        <p>{binaryPreviewMessage(preview, t)}</p>
        <div className="fpv-meta">
          <MetadataRow label={t("filePreview.metadata.type")} value={preview.mime} />
          <MetadataRow
            label={t("filePreview.metadata.extension")}
            value={preview.extension ?? t("filePreview.metadata.extensionNone")}
          />
          <MetadataRow
            label={t("filePreview.metadata.size")}
            value={formatBytes(preview.sizeBytes)}
          />
          <MetadataRow
            label={t("filePreview.metadata.modified")}
            value={formatDate(preview.modifiedAt)}
          />
        </div>
      </div>
    </div>
  );
}

interface PreviewKindContentProps {
  readonly preview: FilesPreviewResponse | null;
  readonly shouldHighlight: boolean;
  readonly lines: readonly (readonly Token[])[];
  readonly visibleLineRows: readonly {
    readonly lineNumber: number;
    readonly tokens: readonly Token[];
  }[];
  readonly hiddenLineCount: number;
  readonly onShowMore: () => void;
  readonly t: I18nTranslate;
}

function PreviewKindContent(props: PreviewKindContentProps): ReactNode {
  if (props.preview === null) return null;
  switch (props.preview.kind) {
    case "text":
      return <TextFilePreview {...props} preview={props.preview} />;
    case "image":
      return <ImageFilePreview preview={props.preview} t={props.t} />;
    case "binary":
      return <BinaryFilePreview preview={props.preview} t={props.t} />;
  }
}

export function FilePreview({ root, path, onClose, onOpenInEditor }: FilePreviewProps): ReactNode {
  const t = useTranslate();
  const [preview, setPreview] = useState<FilesPreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PreviewError | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshStatus, setRefreshStatus] = useState<PreviewRefreshStatus>("idle");
  const [copyStatus, setCopyStatus] = useState<CopyStatusKind | null>(null);
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
    const targetChanged = previousTarget?.root !== root || previousTarget.path !== path;
    const isManualRefresh = previousTarget !== null && !targetChanged && refreshKey > 0;
    loadTargetRef.current = { root, path };

    setLoading(true);
    setError(null);
    setRefreshStatus(isManualRefresh ? "refreshing" : "idle");
    if (!isManualRefresh) setPreview(null);

    void fetchFilesPreview(root, path)
      .then((response) => {
        if (!cancelled) {
          setPreview(response);
          if (isManualRefresh) setRefreshStatus("refreshed");
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(classifyError(err, t));
          if (isManualRefresh) setRefreshStatus("failed");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, root, refreshKey, t]);

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
    void copyTextToClipboard(value, { restoreFocus: false }).then(
      () => setCopyStatus(target === "name" ? "nameCopied" : "pathCopied"),
      () => setCopyStatus("clipboardFailed"),
    );
  };

  const denied = error?.denied === true;
  const lang = previewLanguageLabel(preview, error, t);
  const headerName = previewHeaderName(preview, error, t);
  const headerTitle = headerName;
  const shouldHighlight = preview?.kind === "text" && preview.content.length <= MAX_HIGHLIGHT_BYTES;
  const canOpenInEditor = canOpenPreviewInEditor(preview, onOpenInEditor);
  const refreshStatusText = refreshStatusLabel(refreshStatus, t);
  const lines: readonly (readonly Token[])[] = useMemo(
    () => previewTokenLines(preview, shouldHighlight),
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
  const visibleLineRows = useMemo(
    () => visibleLines.map((tokens, index) => ({ lineNumber: index + 1, tokens })),
    [visibleLines],
  );
  const hiddenLineCount = Math.max(0, lines.length - visibleLineCount);
  const showMoreLines = (): void => {
    setVisibleLineCount((count) => Math.min(lines.length, count + PREVIEW_LINE_BATCH));
  };

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
          title={t("filePreview.backToFiles")}
          aria-label={t("filePreview.backToFiles")}
        >
          <BackIcon size={15} />
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
              onClick={() => copyMetadata("name")}
              title={t("filePreview.copyFileName")}
              aria-label={t("filePreview.copyFileName")}
            >
              <CopyIcon size={13} />
            </button>
            <button
              className="fpv-back fpv-copy"
              type="button"
              onClick={() => copyMetadata("path")}
              title={t("filePreview.copyFilePath")}
              aria-label={t("filePreview.copyFilePath")}
            >
              <CopyIcon size={13} />
            </button>
          </>
        ) : null}
        <span className="fpv-lang mono">{lang}</span>
        <span className="spacer" />
        <CopyStatusOutput status={copyStatus} t={t} />
        <button
          className="fpv-back fpv-refresh"
          type="button"
          onClick={refreshPreview}
          disabled={loading}
          data-state={refreshStatus}
          title={loading ? t("filePreview.refreshing") : t("filePreview.refresh")}
          aria-label={loading ? t("filePreview.refreshing") : t("filePreview.refresh")}
        >
          <ResetIcon size={14} />
        </button>
        {refreshStatusText.length > 0 ? (
          <output className="fpv-status mono" data-state={refreshStatus} aria-live="polite">
            {refreshStatusText}
          </output>
        ) : null}
        {canOpenInEditor ? (
          <button
            className="fpv-back"
            type="button"
            onClick={() => onOpenInEditor?.(root, path)}
            title={t("filePreview.openInEditor")}
            aria-label={t("filePreview.openInEditor")}
          >
            <EditorIcon size={15} />
          </button>
        ) : null}
        <button
          className="fpv-back"
          type="button"
          onClick={onClose}
          title={t("filePreview.closePreview")}
          aria-label={t("filePreview.closePreview")}
        >
          <CloseIcon size={15} />
        </button>
      </div>

      {loading && preview === null ? (
        <output className="fpv-state" style={NATIVE_BLOCK_STYLE}>
          {t("filePreview.loadingState")}
        </output>
      ) : null}
      {error !== null ? (
        <div className="fpv-state fpv-error" role="alert">
          <span>{error.message}</span>
          {/* Denied is a deliberate safety invariant, not a transient failure — no Retry. */}
          {!error.denied ? (
            <button type="button" className="fpv-retry" onClick={refreshPreview}>
              {t("filePreview.retry")}
            </button>
          ) : null}
        </div>
      ) : null}

      <PreviewKindContent
        preview={preview}
        shouldHighlight={shouldHighlight}
        lines={lines}
        visibleLineRows={visibleLineRows}
        hiddenLineCount={hiddenLineCount}
        onShowMore={showMoreLines}
        t={t}
      />
    </div>
  );
}
