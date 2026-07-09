"use client";

// Shared presentational helpers for the Quality Intelligence workspace windows (Epic #270).
// Used by the QI hub (run list) and the per-run result card. Pure, no data fetching.

import type { ReactNode } from "react";
import type {
  QualityIntelligenceReviewState,
  QualityIntelligenceRunStatus,
  TestQualityRubricDimension,
  QualityIntelligenceUiWeakTestFlag,
} from "@oscharko-dev/keiko-contracts";
import { QUALITY_INTELLIGENCE_RUN_STATUSES } from "@oscharko-dev/keiko-contracts";
import { ApiError } from "@/lib/api";
import { translateQi, useQiTranslate as useTranslate, type I18nTranslate } from "./qi-i18n";

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

export function reviewLabel(state: QualityIntelligenceReviewState, t: I18nTranslate): string {
  if (state === "open") return t("qi.review.open");
  if (state === "approved") return t("qi.review.approved");
  if (state === "changes-requested") return t("qi.review.changesRequested");
  if (state === "rejected") return t("qi.review.rejected");
  return t("qi.review.withdrawn");
}

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
  const t = useTranslate();
  return (
    <span className={`qi-review-badge ${REVIEW_CLASS[state]}`}>
      <span className="sr-only">{t("qi.review.prefix")} </span>
      {reviewLabel(state, t)}
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
  return translateQi("en", "common.error.unexpected");
}

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

type RunStatus = QualityIntelligenceRunStatus;

const STATUS_CLASS: Readonly<Record<RunStatus, string>> = {
  running: "qi-badge-running",
  succeeded: "qi-badge-succeeded",
  failed: "qi-badge-failed",
  cancelled: "qi-badge-cancelled",
};

function isRunStatus(s: string): s is RunStatus {
  return (QUALITY_INTELLIGENCE_RUN_STATUSES as readonly string[]).includes(s);
}

/** Human label for a run status — falls back to the raw value for unknown statuses. */
export function runStatusLabel(
  status: string,
  t: I18nTranslate = (key, values) => translateQi("en", key, values),
): string {
  if (!isRunStatus(status)) return status;
  if (status === "running") return t("qi.status.running");
  if (status === "succeeded") return t("qi.status.succeeded");
  if (status === "failed") return t("qi.status.failed");
  return t("qi.status.cancelled");
}

// A status badge is a STATIC label, not a live region — it carries no role="status" (that role is
// reserved for the container regions that actually receive async updates). No aria-label either:
// naming is prohibited on a generic <span> (ARIA 1.2) and assistive tech ignores it — the visible
// label is the accessible content.
export function StatusBadge({ status }: { readonly status: string }): ReactNode {
  const t = useTranslate();
  const label = runStatusLabel(status, t);
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
  const t = useTranslate();
  const cls = isFindingSeverity(severity) ? SEVERITY_CLASS[severity] : "qi-sev-low";
  return (
    <span className={`qi-sev ${cls}`}>
      <span className="sr-only">{t("qi.severity.prefix")} </span>
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
  const t = useTranslate();
  if (score === null) {
    return (
      <span className="qi-badge qi-badge-default" data-testid="qi-quality-badge">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t("qi.quality.notAvailable")}</span>
      </span>
    );
  }
  const rounded = Math.round(score);
  return (
    <span className={`qi-badge ${qualityTierClass(rounded)}`} data-testid="qi-quality-badge">
      {rounded.toString()}
      <span className="sr-only"> {t("qi.quality.outOf100")}</span>
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
  const t = useTranslate();
  return (
    <div
      role="note"
      aria-label={t("qi.weakTest.aria", { rationale: flag.rationale })}
      className="qi-weak-flag"
      data-testid="qi-weak-flag"
    >
      <span className="qi-weak-flag-badge">
        <span aria-hidden="true" className="qi-weak-flag-icon">
          ⚠
        </span>
        {t("qi.weakTest.label")}
      </span>
      <p className="qi-weak-flag-reason">{flag.rationale}</p>
    </div>
  );
}

export interface CandidateQualityVerdict {
  readonly verdict: "strong" | "weak";
  readonly score: number;
  readonly dimensions: readonly TestQualityRubricDimension[];
  readonly overallRationale: string;
}

function qualityDimensionLabel(name: string, t: I18nTranslate): string {
  if (name === "verifiability") return t("qi.quality.dimension.verifiability");
  if (name === "atomicity") return t("qi.quality.dimension.atomicity");
  if (name === "determinism") return t("qi.quality.dimension.determinism");
  if (name === "ac-fidelity") return t("qi.quality.dimension.acFidelity");
  return name;
}

function qualityVerdictLabel(
  verdict: CandidateQualityVerdict["verdict"],
  t: I18nTranslate,
): string {
  return verdict === "strong" ? t("qi.quality.verdict.strong") : t("qi.quality.verdict.weak");
}

export function CandidateQualityVerdictNote({
  verdict,
}: {
  readonly verdict: CandidateQualityVerdict;
}): ReactNode {
  const t = useTranslate();
  const rounded = Math.round(verdict.score);
  const label = qualityVerdictLabel(verdict.verdict, t);
  return (
    <div
      role="note"
      aria-label={t("qi.quality.verdict.aria", {
        label,
        score: rounded,
        rationale: verdict.overallRationale,
      })}
      className="qi-cand-block"
      data-testid="qi-quality-verdict"
    >
      <p className="qi-cand-block-label">{t("qi.quality.verdict.title")}</p>
      <p>
        {label} - {rounded.toString()}/100
      </p>
      <ul className="qi-cand-list" aria-label={t("qi.quality.dimensions")}>
        {verdict.dimensions.map((dimension) => (
          <li key={dimension.name}>
            {qualityDimensionLabel(dimension.name, t)} {Math.round(dimension.score).toString()}:{" "}
            {dimension.rationale}
          </li>
        ))}
      </ul>
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
  const t = useTranslate();
  return (
    <div role="alert" aria-live="assertive" className="lk-alert" data-testid="qi-error-state">
      {message}
      <button type="button" className="lk-alert-retry" onClick={onRetry}>
        {t("common.retry")}
      </button>
    </div>
  );
}
