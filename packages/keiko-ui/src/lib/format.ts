/**
 * Pure presenters for bytes, durations, costClass badges, and token totals.
 * No side effects. No DOM access. No imports from src/.
 */

import type { CostClass, RunStatus, VerificationStatus } from "./types";

// ---------------------------------------------------------------------------
// Bytes → human-readable
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Milliseconds → human-readable
// ---------------------------------------------------------------------------

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toString()} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes.toString()}m ${seconds.toString()}s`;
}

// ---------------------------------------------------------------------------
// costClass badge label
// ---------------------------------------------------------------------------

export function costClassLabel(costClass: CostClass | "unknown"): string {
  switch (costClass) {
    case "low":
      return "Low cost";
    case "medium":
      return "Medium cost";
    case "high":
      return "High cost";
    case "unknown":
      return "Unknown cost";
  }
}

// ---------------------------------------------------------------------------
// Run status label (shared by ReviewWidget + AgentRunWidget — uiux-fix F018 C259)
// ---------------------------------------------------------------------------

export function runStatusLabel(status: RunStatus): string {
  const map: Record<RunStatus, string> = {
    running: "Running",
    completed: "Completed",
    "dry-run": "Dry run",
    rejected: "Rejected",
    cancelled: "Cancelled",
    failed: "Failed",
    "fix-applied": "Fix applied",
    "fix-proposed": "Fix proposed",
    "investigation-only": "Investigation only",
  };
  return map[status] ?? status;
}

// ---------------------------------------------------------------------------
// Verification status label
// ---------------------------------------------------------------------------

export function verificationStatusLabel(status: VerificationStatus): string {
  switch (status) {
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "denied":
      return "Denied";
    case "timed-out":
      return "Timed out";
    case "cancelled":
      return "Cancelled";
    case "resource-exceeded":
      return "Resource exceeded";
  }
}

// ---------------------------------------------------------------------------
// Token counts
// ---------------------------------------------------------------------------

export function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  return `${(n / 1000).toFixed(1)}k`;
}

// ---------------------------------------------------------------------------
// Date → local readable
// Accepts epoch-ms numbers (from the audit layer) or ISO strings.
// ---------------------------------------------------------------------------

export function formatDate(value: number | string): string {
  try {
    return new Date(value).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return typeof value === "string" ? value : value.toString();
  }
}

/**
 * Derive the UTC YYYY-MM-DD string from an epoch-ms timestamp or ISO string.
 * Used by the evidence date filter to compare against the date-input value.
 * UTC is used because the audit layer stores epoch-ms without a timezone offset
 * and the date-input value produced by the browser is always a plain date string
 * in the user's local timezone — but the BFF timestamps are UTC-based epoch-ms.
 * Using UTC methods keeps the comparison consistent regardless of runtime timezone.
 */
export function toDateString(value: number | string): string {
  try {
    const d = new Date(value);
    const yyyy = d.getUTCFullYear().toString();
    const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
    const dd = d.getUTCDate().toString().padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Outcome badge
// ---------------------------------------------------------------------------
// Note: the former costClassClasses/verificationStatusClasses/outcomeClasses
// exports returned Tailwind utility strings, but Tailwind was removed from
// keiko-ui (see postcss.config.mjs) — they were unused, latent-unstyled traps
// and were deleted (uiux-fix F018 C152).

export function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "fix-applied":
      return "Fix applied";
    case "fix-proposed":
      return "Fix proposed (dry-run)";
    case "investigation-only":
      return "Investigation only";
    case "limit-exceeded":
      return "Limit exceeded";
    case "dry-run":
      return "Dry-run";
    default:
      return outcome.charAt(0).toUpperCase() + outcome.slice(1);
  }
}
