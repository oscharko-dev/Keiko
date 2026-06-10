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
  URL.revokeObjectURL(url);
}

export interface ExportBarProps {
  readonly runId: string;
  readonly exportImpl?: typeof exportQiRun;
  readonly traceabilityImpl?: typeof exportQiRunTraceability;
}

export function ExportBar({
  runId,
  exportImpl = exportQiRun,
  traceabilityImpl = exportQiRunTraceability,
}: ExportBarProps): ReactNode {
  const [adapter, setAdapter] = useState("csv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const selected = ADAPTERS.find((a) => a.id === adapter);
  const isTms = selected?.tms ?? false;

  const runExport = useCallback(async (): Promise<void> => {
    const traceFormat = TRACEABILITY_FORMATS[adapter];
    if (traceFormat !== undefined) {
      // The matrix is plain text (no base64), served by the dedicated traceability route.
      const res = await traceabilityImpl(runId, traceFormat);
      triggerDownload(res.filename, res.contentType, res.body);
      setDownloaded(res.filename);
      return;
    }
    const res = await exportImpl(runId, adapter, { dryRun: isTms, approvedOnly: false });
    if (res.dryRun) {
      // "test case(s)", not the internal term "candidates" — the suite-wide object name
      // (uiux-fix F047 C388: ExportBar said "candidates", hub "cases", launcher "test cases").
      setPreview(
        `${res.candidateCount.toString()} test case${res.candidateCount === 1 ? "" : "s"} · ${res.byteLen.toString()} bytes\n\n${res.preview}`,
      );
    } else {
      // Binary formats (PDF / ZIP) arrive base64-encoded; forward the encoding so the Blob is built
      // from the DECODED bytes, not the base64 text. Omitting it corrupts the downloaded file.
      triggerDownload(res.filename, res.contentType, res.body, res.encoding);
      setDownloaded(res.filename);
    }
  }, [runId, adapter, isTms, exportImpl, traceabilityImpl]);

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
      <label className="qi-field qi-field-inline">
        <span className="qi-field-label">Export</span>
        <select
          className="qi-select"
          value={adapter}
          disabled={busy}
          onChange={(e) => {
            setAdapter(e.target.value);
            setPreview(null);
            setError(null);
            setDownloaded(null);
          }}
        >
          {ADAPTERS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="qi-btn qi-btn-secondary"
        disabled={busy}
        onClick={() => {
          void handleExport();
        }}
      >
        {/* Explicit busy label — a 40-candidate PDF/ZIP export takes a noticeable moment, and the
            neighbouring DriftPanel/RunLauncher both signal busy (uiux-fix F047 C155). */}
        {busy ? "Exporting…" : isTms ? "Preview" : "Download"}
      </button>
      {/* Persistent live region (uiux-fix F047 C155): exists before any result arrives so screen
          readers reliably announce the download confirmation / preview readiness — a role="status"
          element inserted together with its content is often skipped. The visible confirmation and
          preview below stay conditional and are no longer live regions themselves. */}
      <p className="sr-only" role="status" aria-live="polite">
        {downloaded !== null
          ? `Downloaded ${downloaded}`
          : preview !== null
            ? "Export preview ready below."
            : ""}
      </p>
      {isTms ? (
        <p className="qi-export-hint" role="note" data-testid="qi-export-connector-hint">
          {selected?.id === "quality-center"
            ? "Quality Center is preview-only. Configure a connector to enable live export."
            : "External target — preview only. Configure a connector to enable live export."}
        </p>
      ) : null}
      {downloaded !== null ? (
        <p className="qi-export-success" data-testid="qi-export-success">
          {`Downloaded ${downloaded}`}
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
          aria-label="Export preview"
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
    </div>
  );
}
