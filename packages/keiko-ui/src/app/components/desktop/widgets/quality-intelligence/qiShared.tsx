"use client";

// Shared presentational helpers for the Quality Intelligence workspace windows (Epic #270).
// Used by the QI hub (run list) and the per-run result card. Pure, no data fetching.

import type { ReactNode } from "react";
import type {
  QualityIntelligenceReviewState,
  QualityIntelligenceUiWeakTestFlag,
} from "@oscharko-dev/keiko-contracts";
import { ApiError } from "@/lib/api";

// Human labels for review states — shared by the candidate review badges (CandidatesPane) and the
// run summary (QiRunCard) so the same state never renders in two spellings on one card
// (uiux-fix F030 C272: "Changes-Requested" via CSS capitalize vs "Changes requested").
export const REVIEW_LABEL: Readonly<Record<QualityIntelligenceReviewState, string>> = {
  open: "Open",
  approved: "Approved",
  "changes-requested": "Changes requested",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

// CSS class map for review state badges — shared by CandidatesPane (per-candidate badge) and
// QiHubPanel (run-row badge) so the same colour tokens apply consistently in both views
// (Issue #282 / A11y-2: run-row now carries a review badge, must reuse the same CSS map).
export const REVIEW_CLASS: Readonly<Record<QualityIntelligenceReviewState, string>> = {
  open: "qi-review-open",
  approved: "qi-review-approved",
  "changes-requested": "qi-review-changes",
  rejected: "qi-review-rejected",
  withdrawn: "qi-review-withdrawn",
};

// No aria-label here: naming is prohibited on a generic <span> (ARIA 1.2), so assistive tech
// ignores it. The "Review:" context is supplied via a screen-reader-only prefix instead.
// Used by CandidatesPane (per-candidate) and QiHubPanel (run-row) — single source of truth
// (de-duplicated from CandidatesPane.tsx by Issue #282 A11y-2 refactor).
export function ReviewBadge({
  state,
}: {
  readonly state: QualityIntelligenceReviewState;
}): ReactNode {
  return (
    <span className={`qi-review-badge ${REVIEW_CLASS[state]}`}>
      <span className="sr-only">Review: </span>
      {REVIEW_LABEL[state]}
    </span>
  );
}

// Coded errors render message-first with the machine code trailing in parentheses — users read the
// human sentence, auditors still get the stable code (uiux-fix F047 C271: the raw "QI_…: message"
// prefix leaked the machine code as the headline). Also used by the SSE error frames (RunLauncher),
// which carry code + message as plain fields rather than an ApiError instance.
export function formatCodedError(code: string, message: string): string {
  return `${message} (${code})`;
}

export function formatError(err: unknown): string {
  if (err instanceof ApiError) return formatCodedError(err.code, err.message);
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

/** Human label for a run status — falls back to the raw value for unknown statuses. */
export function runStatusLabel(status: string): string {
  return isRunStatus(status) ? STATUS_LABEL[status] : status;
}

// A status badge is a STATIC label, not a live region — it carries no role="status" (that role is
// reserved for the container regions that actually receive async updates). No aria-label either:
// naming is prohibited on a generic <span> (ARIA 1.2) and assistive tech ignores it — the visible
// label is the accessible content.
export function StatusBadge({ status }: { readonly status: string }): ReactNode {
  const label = runStatusLabel(status);
  const cls = isRunStatus(status) ? STATUS_CLASS[status] : "qi-badge-default";
  return <span className={`qi-badge ${cls}`}>{label}</span>;
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

// No aria-label (prohibited on a generic <span>); the "Severity:" context lives in a
// screen-reader-only prefix so the visible chip stays compact.
export function SeverityBadge({ severity }: { readonly severity: string }): ReactNode {
  const cls = isFindingSeverity(severity) ? SEVERITY_CLASS[severity] : "qi-sev-low";
  return (
    <span className={`qi-sev ${cls}`}>
      <span className="sr-only">Severity: </span>
      {severity}
    </span>
  );
}

// Quality score badge (Epic #736 / Issue #748). Colour tier is driven by the rounded score:
// ≥90 strong (green), 70-89 mixed (amber), <70 weak (red). null renders an em-dash placeholder.
// Each tier reuses a token combination already proven ≥4.5:1 in both themes (see globals.css).
function qualityTierClass(rounded: number): string {
  if (rounded >= 90) return "qi-quality-high";
  if (rounded >= 70) return "qi-quality-mid";
  return "qi-quality-low";
}

// aria-label is prohibited (and ignored) on a generic <span>, so the score context is carried by
// screen-reader-only text instead: the bare em-dash / number alone would be meaningless to AT.
export function QualityScoreBadge({ score }: { readonly score: number | null }): ReactNode {
  if (score === null) {
    return (
      <span className="qi-badge qi-badge-default" data-testid="qi-quality-badge">
        <span aria-hidden="true">—</span>
        <span className="sr-only">Quality score not available</span>
      </span>
    );
  }
  const rounded = Math.round(score);
  return (
    <span className={`qi-badge ${qualityTierClass(rounded)}`} data-testid="qi-quality-badge">
      {rounded.toString()}
      <span className="sr-only"> out of 100</span>
    </span>
  );
}

// Per-candidate weak-test flag (Epic #736 / Issue #748). Surfaced only when the adversarial judge
// rated a candidate weak. The redacted rationale is the judge's reason; it is named for assistive
// tech via the role="note" container's aria-label and shown inline for sighted users.
export function WeakTestFlag({
  flag,
}: {
  readonly flag: QualityIntelligenceUiWeakTestFlag;
}): ReactNode {
  return (
    <div
      role="note"
      aria-label={`Weak test flagged by the quality judge: ${flag.rationale}`}
      className="qi-weak-flag"
      data-testid="qi-weak-flag"
    >
      <span className="qi-weak-flag-badge">
        <span aria-hidden="true" className="qi-weak-flag-icon">
          ⚠
        </span>
        Weak test
      </span>
      <p className="qi-weak-flag-reason">{flag.rationale}</p>
    </div>
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
