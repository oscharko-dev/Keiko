"use client";

// Quality Intelligence export control (Issue #283, Epic #270).
// Local formats (CSV / JSON / spreadsheet-safe CSV) download a same-origin Blob — no credentials.
// External TMS adapters run a dry-run preview ONLY (writes are disabled until a connector is
// configured). Accessible: labelled select, focus-visible controls, aria-live preview/error.

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { exportQiRun } from "@/lib/quality-intelligence-api";
import { ApiError } from "@/lib/api";

const ADAPTERS: ReadonlyArray<{ id: string; label: string; tms: boolean }> = [
  { id: "csv", label: "CSV", tms: false },
  { id: "json", label: "JSON", tms: false },
  { id: "spreadsheet-safe-csv", label: "Spreadsheet-safe CSV", tms: false },
  { id: "jira-issues", label: "Jira (preview)", tms: true },
  { id: "qtest", label: "qTest (preview)", tms: true },
  { id: "xray", label: "Xray (preview)", tms: true },
  { id: "polarion", label: "Polarion (preview)", tms: true },
];

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return "Export failed.";
}

function triggerDownload(filename: string, contentType: string, body: string): void {
  const blob = new Blob([body], { type: contentType });
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
}

export function ExportBar({ runId, exportImpl = exportQiRun }: ExportBarProps): ReactNode {
  const [adapter, setAdapter] = useState("csv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const isTms = ADAPTERS.find((a) => a.id === adapter)?.tms ?? false;

  const handleExport = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const res = await exportImpl(runId, adapter, { dryRun: isTms, approvedOnly: false });
      if (res.dryRun) {
        setPreview(
          `${res.candidateCount.toString()} candidates · ${res.byteLen.toString()} bytes\n\n${res.preview}`,
        );
      } else {
        triggerDownload(res.filename, res.contentType, res.body);
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [runId, adapter, isTms, exportImpl]);

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
        {isTms ? "Preview" : "Download"}
      </button>
      {preview !== null ? (
        <pre
          className="qi-export-preview"
          role="status"
          aria-live="polite"
          data-testid="qi-export-preview"
        >
          {preview}
        </pre>
      ) : null}
      {error !== null ? (
        <p className="lk-alert" role="alert" data-testid="qi-export-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
