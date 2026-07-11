"use client";

// Quality Intelligence export control (Issue #283, Epic #270 + #711).
// Local formats (CSV / JSON / spreadsheet-safe CSV / Markdown / plain-text) download a same-origin
// Blob — no credentials. Binary formats (PDF / ZIP bundle) are returned as base64 and decoded
// client-side. External TMS adapters run a dry-run preview ONLY (writes are disabled until a
// connector is configured). Accessible: labelled select, focus-visible controls, aria-live
// preview/error.

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import {
  exportQiRun,
  exportQiRunTraceability,
  type QiTraceabilityFormat,
} from "@/lib/quality-intelligence-api";
import { useQiTranslate as useTranslate, type I18nTranslate } from "./qi-i18n";
import KeikoSelect from "../../KeikoSelect";
import { formatError } from "./qiShared";

// Traceability adapters are served by a dedicated, matrix-driven route (Epic #734, Issue #740);
// they are surfaced here so the audit-ready requirement<->test matrix is reachable for a real user.
const TRACEABILITY_FORMATS: Readonly<Record<string, QiTraceabilityFormat>> = {
  "traceability-csv": "csv",
  "traceability-markdown": "markdown",
};

const ADAPTERS: ReadonlyArray<{ id: string; label: string; tms: boolean }> = [
  { id: "csv", label: "CSV", tms: false },
  { id: "json", label: "JSON", tms: false },
  { id: "spreadsheet-safe-csv", label: "Spreadsheet-safe CSV", tms: false },
  { id: "markdown", label: "Markdown", tms: false },
  { id: "plain-text", label: "Plain text", tms: false },
  { id: "pdf", label: "PDF", tms: false },
  { id: "zip-bundle", label: "ZIP bundle (all formats)", tms: false },
  { id: "traceability-csv", label: "Traceability matrix (CSV)", tms: false },
  { id: "traceability-markdown", label: "Traceability matrix (Markdown)", tms: false },
  { id: "jira-issues", label: "Jira (preview)", tms: true },
  { id: "qtest", label: "qTest (preview)", tms: true },
  { id: "xray", label: "Xray (preview)", tms: true },
  { id: "polarion", label: "Polarion (preview)", tms: true },
  { id: "quality-center", label: "Quality Center (preview)", tms: true },
];

const DOWNLOAD_URL_REVOKE_DELAY_MS = 250;

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function triggerDownload(
  filename: string,
  contentType: string,
  body: string,
  encoding?: "base64",
): void {
  const data = encoding === "base64" ? base64ToUint8Array(body) : body;
  const blob = new Blob([data], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Some browser engines cancel a programmatic Blob download when the object URL is revoked in the
  // same task as the synthetic click. Keep it alive briefly, then release it to avoid leaks.
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, DOWNLOAD_URL_REVOKE_DELAY_MS);
}

export interface ExportBarProps {
  readonly runId: string;
  readonly exportImpl?: typeof exportQiRun;
  readonly traceabilityImpl?: typeof exportQiRunTraceability;
}

// --- runExport extraction (S3776): the traceability branch, the export branch, and the
// preview/error handling used to live inline in a single dense useCallback. Pulled out to a
// module-scope helper taking explicit params (not closures) so the branching is scored on its own,
// small function instead of inflating ExportBar's cognitive complexity. Mirrors the
// driftMessage/regeneratedMessage extraction convention already used in DriftPanel.tsx. ---

interface RunExportContext {
  readonly runId: string;
  readonly adapter: string;
  readonly isTms: boolean;
  readonly approvedOnly: boolean;
  readonly exportImpl: typeof exportQiRun;
  readonly traceabilityImpl: typeof exportQiRunTraceability;
  readonly t: I18nTranslate;
  readonly setPreview: (value: string) => void;
  readonly setDownloaded: (value: string) => void;
}

async function runQiExport(ctx: RunExportContext): Promise<void> {
  const traceFormat = TRACEABILITY_FORMATS[ctx.adapter];
  if (traceFormat !== undefined) {
    // The matrix is plain text (no base64), served by the dedicated traceability route.
    const res = await ctx.traceabilityImpl(ctx.runId, traceFormat);
    triggerDownload(res.filename, res.contentType, res.body);
    ctx.setDownloaded(res.filename);
    return;
  }
  // Pass the user-chosen approvedOnly value. TMS adapters force approvedOnly server-side
  // regardless of this value.
  const res = await ctx.exportImpl(ctx.runId, ctx.adapter, {
    dryRun: ctx.isTms,
    approvedOnly: ctx.approvedOnly,
  });
  if (res.dryRun) {
    // "test case(s)", not the internal term "candidates" — the suite-wide object name
    // (uiux-fix F047 C388: ExportBar said "candidates", hub "cases", launcher "test cases").
    ctx.setPreview(
      `${ctx.t("qi.export.previewSummary", {
        count: res.candidateCount,
        bytes: res.byteLen,
      })}\n\n${res.preview}`,
    );
    return;
  }
  // Binary formats (PDF / ZIP) arrive base64-encoded; forward the encoding so the Blob is built
  // from the DECODED bytes, not the base64 text. Omitting it corrupts the downloaded file.
  triggerDownload(res.filename, res.contentType, res.body, res.encoding);
  ctx.setDownloaded(res.filename);
}

// Nested ternary (busy -> isTms -> label) extracted to a named predicate-style helper.
function exportActionLabel(busy: boolean, isTms: boolean, t: I18nTranslate): string {
  if (busy) return t("qi.export.exporting");
  return isTms ? t("qi.export.preview") : t("qi.export.download");
}

// Nested ternary (downloaded -> preview -> "") extracted to a named helper.
function exportStatusMessage(
  downloaded: string | null,
  preview: string | null,
  t: I18nTranslate,
): string {
  if (downloaded !== null) return t("qi.export.downloaded", { filename: downloaded });
  if (preview !== null) return t("qi.export.previewReady");
  return "";
}

// Scope notice: always present for non-TMS adapters so users understand what they are about to
// download (AC3 governance visibility).
function ExportScopeNotice({
  isTms,
  approvedOnly,
  t,
}: {
  readonly isTms: boolean;
  readonly approvedOnly: boolean;
  readonly t: I18nTranslate;
}): ReactNode {
  if (isTms) return null;
  return (
    <p className="qi-export-hint" role="note" data-testid="qi-export-scope-notice">
      {approvedOnly ? t("qi.export.scopeApproved") : t("qi.export.scopeAll")}
    </p>
  );
}

// Issue #282 A11y-3 / AC3: "Approved only" scope control. Hidden for TMS adapters (TMS forces
// approvedOnly server-side; the server owns that decision — showing a checkbox that appears to
// control it would be misleading). Default checked keeps ordinary downloads aligned with the
// review gate.
function ApprovedOnlyToggle({
  isTms,
  approvedOnly,
  busy,
  onChange,
  t,
}: {
  readonly isTms: boolean;
  readonly approvedOnly: boolean;
  readonly busy: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly t: I18nTranslate;
}): ReactNode {
  if (isTms) return null;
  return (
    <label className="qi-export-approved-label">
      <input
        type="checkbox"
        className="qi-checkbox"
        checked={approvedOnly}
        disabled={busy}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
        data-testid="qi-export-approved-only"
      />
      <span>{t("qi.export.approvedOnly")}</span>
    </label>
  );
}

// Issue #723 AC2 a11y: when a TMS (preview-only) adapter such as Quality Center is selected, this
// note is associated with the format picker (via aria-describedby on ExportBar's KeikoSelect) so
// forms-mode screen-reader users hear the disabled/preview state on the control itself, not only
// when reading sequentially. Omitted for local formats, which keeps the reference from dangling.
function ConnectorHint({
  isTms,
  selectedId,
  t,
}: {
  readonly isTms: boolean;
  readonly selectedId: string | undefined;
  readonly t: I18nTranslate;
}): ReactNode {
  if (!isTms) return null;
  return (
    <p
      id="qi-export-connector-hint"
      className="qi-export-hint"
      role="note"
      data-testid="qi-export-connector-hint"
    >
      {selectedId === "quality-center"
        ? t("qi.export.qualityCenterPreviewOnly")
        : t("qi.export.externalPreviewOnly")}
    </p>
  );
}

// Downloaded confirmation / preview text / error message — the mutually-exclusive result regions
// rendered below the controls.
function ExportResultRegions({
  downloaded,
  preview,
  error,
  t,
}: {
  readonly downloaded: string | null;
  readonly preview: string | null;
  readonly error: string | null;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <>
      {downloaded !== null ? (
        <p className="qi-export-success" data-testid="qi-export-success">
          {t("qi.export.downloaded", { filename: downloaded })}
        </p>
      ) : null}
      {preview !== null ? (
        // tabIndex makes the scrollable preview keyboard-reachable (max-height + overflow:auto cut
        // off longer previews with no way to scroll them by keyboard — uiux-fix F047 C269, WCAG
        // 2.1.1 / axe scrollable-region-focusable); role+label name the region for AT.
        /* eslint-disable jsx-a11y/no-noninteractive-tabindex -- scrollable preview region must be keyboard-focusable (axe scrollable-region-focusable) */
        <pre
          className="qi-export-preview"
          role="region"
          aria-label={t("qi.export.previewAria")}
          tabIndex={0}
          data-testid="qi-export-preview"
        >
          {preview}
        </pre>
      ) : /* eslint-enable jsx-a11y/no-noninteractive-tabindex */
      null}
      {error !== null ? (
        <p className="lk-alert" role="alert" data-testid="qi-export-error">
          {error}
        </p>
      ) : null}
    </>
  );
}

export function ExportBar({
  runId,
  exportImpl = exportQiRun,
  traceabilityImpl = exportQiRunTraceability,
}: ExportBarProps): ReactNode {
  const t = useTranslate();
  const [adapter, setAdapter] = useState("csv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  // Deliverable-safe default: local downloads start with the same reviewed scope that external TMS
  // adapters enforce server-side. Users can still opt into a local diagnostic all-candidate export.
  const [approvedOnly, setApprovedOnly] = useState(true);
  const selected = ADAPTERS.find((a) => a.id === adapter);
  const isTms = selected?.tms ?? false;

  const runExport = useCallback(async (): Promise<void> => {
    await runQiExport({
      runId,
      adapter,
      isTms,
      approvedOnly,
      exportImpl,
      traceabilityImpl,
      t,
      setPreview,
      setDownloaded,
    });
  }, [runId, adapter, isTms, approvedOnly, exportImpl, traceabilityImpl, t]);

  const handleExport = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setPreview(null);
    setDownloaded(null);
    try {
      await runExport();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [runExport]);

  return (
    <div className="qi-export" data-testid="qi-export-bar">
      <div className="qi-export-head">
        <div className="qi-export-copy">
          <p className="qi-export-title">{t("qi.export.title")}</p>
          <ExportScopeNotice isTms={isTms} approvedOnly={approvedOnly} t={t} />
        </div>
        <ApprovedOnlyToggle
          isTms={isTms}
          approvedOnly={approvedOnly}
          busy={busy}
          onChange={setApprovedOnly}
          t={t}
        />
      </div>
      <div className="qi-export-controls">
        <div className="qi-field qi-export-format">
          <span className="qi-field-label">{t("qi.export.format")}</span>
          <KeikoSelect
            triggerClassName="qi-select"
            value={adapter}
            ariaLabel={t("qi.export.title")}
            disabled={busy}
            // Issue #723 AC2 a11y: when a TMS (preview-only) adapter such as Quality Center is
            // selected, associate the "preview only — configure a connector" note with the picker so
            // forms-mode screen-reader users hear the disabled/preview state on the control itself,
            // not only when reading sequentially. Omitted for local formats (no such note renders),
            // which keeps the reference from ever dangling.
            ariaDescribedBy={isTms ? "qi-export-connector-hint" : undefined}
            menuTitle={t("qi.export.title")}
            sections={[
              {
                options: ADAPTERS.map((adapterOption) => ({
                  value: adapterOption.id,
                  label: adapterOption.label,
                })),
              },
            ]}
            onValueChange={(next) => {
              setAdapter(next);
              setPreview(null);
              setError(null);
              setDownloaded(null);
            }}
          />
        </div>
        <button
          type="button"
          className="qi-btn qi-btn-primary qi-export-action"
          disabled={busy}
          onClick={() => {
            void handleExport();
          }}
        >
          {/* Explicit busy label — a 40-candidate PDF/ZIP export takes a noticeable moment, and the
              neighbouring DriftPanel/RunLauncher both signal busy (uiux-fix F047 C155). */}
          {exportActionLabel(busy, isTms, t)}
        </button>
      </div>
      {/* Persistent live region (uiux-fix F047 C155): exists before any result arrives so screen
          readers reliably announce the download confirmation / preview readiness — a role="status"
          element inserted together with its content is often skipped. The visible confirmation and
          preview below stay conditional and are no longer live regions themselves. */}
      <p className="sr-only" role="status" aria-live="polite">
        {exportStatusMessage(downloaded, preview, t)}
      </p>
      <ConnectorHint isTms={isTms} selectedId={selected?.id} t={t} />
      <ExportResultRegions downloaded={downloaded} preview={preview} error={error} t={t} />
    </div>
  );
}
