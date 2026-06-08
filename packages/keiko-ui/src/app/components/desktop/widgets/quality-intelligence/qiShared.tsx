"use client";

// Shared presentational helpers for the Quality Intelligence workspace windows (Epic #270).
// Used by the QI hub (run list) and the per-run result card. Pure, no data fetching.

import type { ReactNode } from "react";
import { ApiError } from "@/lib/api";

export function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred.";
}

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

const STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_CLASS: Readonly<Record<RunStatus, string>> = {
  running: "qi-badge-running",
  succeeded: "qi-badge-succeeded",
  failed: "qi-badge-failed",
  cancelled: "qi-badge-cancelled",
};

function isRunStatus(s: string): s is RunStatus {
  return s === "running" || s === "succeeded" || s === "failed" || s === "cancelled";
}

// A status badge is a STATIC label, not a live region — it carries no role="status" (that role is
// reserved for the container regions that actually receive async updates). The visible label plus
// the aria-label context ("Status: …") name it for assistive tech.
export function StatusBadge({ status }: { readonly status: string }): ReactNode {
  const label = isRunStatus(status) ? STATUS_LABEL[status] : status;
  const cls = isRunStatus(status) ? STATUS_CLASS[status] : "qi-badge-default";
  return (
    <span aria-label={`Status: ${label}`} className={`qi-badge ${cls}`}>
      {label}
    </span>
  );
}

type FindingSeverity = "critical" | "high" | "medium" | "low";

const SEVERITY_CLASS: Readonly<Record<FindingSeverity, string>> = {
  critical: "qi-sev-critical",
  high: "qi-sev-high",
  medium: "qi-sev-medium",
  low: "qi-sev-low",
};

function isFindingSeverity(s: string): s is FindingSeverity {
  return s === "critical" || s === "high" || s === "medium" || s === "low";
}

export function SeverityBadge({ severity }: { readonly severity: string }): ReactNode {
  const cls = isFindingSeverity(severity) ? SEVERITY_CLASS[severity] : "qi-sev-low";
  return (
    <span aria-label={`Severity: ${severity}`} className={`qi-sev ${cls}`}>
      {severity}
    </span>
  );
}

function SkeletonBlock({
  height = 20,
  width = "100%",
}: {
  height?: number;
  width?: string | number;
}): ReactNode {
  return <div aria-hidden="true" className="qi-skeleton" style={{ height, width }} />;
}

export function LoadingSkeleton(): ReactNode {
  return (
    <div
      data-testid="qi-loading-state"
      aria-busy="true"
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 0" }}
    >
      {[1, 2, 3].map((i) => (
        <div key={i} className="qi-skeleton-row">
          <SkeletonBlock height={14} width="60%" />
          <SkeletonBlock height={12} width="40%" />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <div role="alert" aria-live="assertive" className="lk-alert" data-testid="qi-error-state">
      {message}
      <button type="button" className="lk-alert-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
