"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, applyRun, fetchEvidenceManifest, fetchRunReport } from "../../../../../lib/api";
import { runStatusLabel } from "../../../../../lib/format";
import type { ChangedFile, RunReport } from "../../../../../lib/types";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { parseUnifiedDiff } from "./shared/diffParser";
import { DiffFileSection } from "./shared/diffView";

export interface ReviewWidgetProps {
  /** Run ID for the patch under review. When omitted, shows the empty state. */
  readonly runId?: string;
  /**
   * uiux-fix F018 C110: invoked when the user submits a run ID from the empty
   * state. The window registration persists it via ctx.updateCfg — without this
   * callback a review window opened without a run ID was a dead end.
   */
  readonly onRunIdSubmit?: (runId: string) => void;
}

interface ErrorState {
  readonly code: string;
  readonly message: string;
}

interface EvidenceControlProps {
  readonly href: string;
  readonly hasManifest: boolean;
  readonly error: ErrorState | null;
}

function errorFromUnknown(value: unknown, t: I18nTranslate): ErrorState {
  if (value instanceof ApiError) return { code: value.code, message: value.message };
  if (value instanceof Error) return { code: "INTERNAL", message: value.message };
  return { code: "INTERNAL", message: t("reviewWidget.unexpectedError") };
}

function shortPath(p: string): string {
  if (p.length <= 40) return p;
  // keep the last directory so same-named files (index.ts, types.ts) stay
  // distinguishable in the file list (uiux-fix F023 C262)
  const parts = p.split("/");
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

// uiux-fix F018 C259: the RunStatus→label map moved to lib/format runStatusLabel so
// the AgentRunWidget header and this widget share one terminology.

function canApplyReport(report: RunReport): boolean {
  return (
    (report.status === "dry-run" || report.status === "fix-proposed") &&
    report.proposedDiff !== undefined &&
    report.appliedAt === undefined
  );
}

function hasDiff(report: RunReport): boolean {
  // Scoped to unified diffs only — `dryRunPreview` and `changedFiles` are
  // adjacent surfaces the widget does not render, so they do not satisfy
  // "has a diff to review".
  return report.proposedDiff !== undefined && report.proposedDiff !== "";
}

function EvidenceControl({ href, hasManifest, error }: EvidenceControlProps): ReactNode {
  const t = useTranslate();
  if (hasManifest) {
    return (
      <a className="rv-evidence-link" href={href} target="_blank" rel="noopener noreferrer">
        {t("reviewWidget.evidence")}
      </a>
    );
  }

  if (error !== null) {
    // message rendered inline — title/aria-label-only details are unreachable
    // for sighted keyboard users (WCAG 1.4.13; uiux-fix F023 C379).
    // role="alert" (assertive) is correct for errors per WCAG 4.1.3 (CW-02).
    return (
      <span className="rv-evidence-link rv-evidence-error" role="alert">
        {t("reviewWidget.evidenceError", { message: error.message })}
      </span>
    );
  }

  // Unavailable evidence has no keyboard path — native <button disabled> gives
  // correct role/disabled semantics without requiring a href (WCAG 4.1.2, CW-01).
  // Visual appearance is unchanged via the same CSS classes.
  return (
    <button type="button" className="rv-evidence-link rv-evidence-disabled" disabled>
      {t("reviewWidget.evidence")}
    </button>
  );
}

// --- main widget ------------------------------------------------------------

export function ReviewWidget({ runId, onRunIdSubmit }: ReviewWidgetProps): ReactNode {
  const t = useTranslate();
  const [report, setReport] = useState<RunReport | null>(null);
  const [hasManifest, setHasManifest] = useState(false);
  const [evidenceError, setEvidenceError] = useState<ErrorState | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<ErrorState | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<ErrorState | null>(null);
  const [activeFile, setActiveFile] = useState<number | null>(null);
  // uiux-fix F018 C110: inline run-ID entry for the empty state
  const [runIdInput, setRunIdInput] = useState("");
  // uiux-fix F018 C258: Apply writes to the working tree — require an explicit
  // second click ("Confirm apply (N files)") that times out back to "Apply".
  const [confirmApply, setConfirmApply] = useState(false);
  const confirmTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (runId === undefined || runId === "") return;
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    setReport(null);
    setHasManifest(false);
    setEvidenceError(null);
    setActiveFile(null);

    void Promise.allSettled([fetchRunReport(runId), fetchEvidenceManifest(runId)]).then(
      ([runRes, manifRes]) => {
        if (cancelled) return;

        if (manifRes.status === "fulfilled") {
          setHasManifest(true);
          setEvidenceError(null);
        } else {
          const manifestError = errorFromUnknown(manifRes.reason, t);
          setHasManifest(false);
          setEvidenceError(manifestError.code === "NOT_FOUND" ? null : manifestError);
        }

        if (runRes.status === "fulfilled") {
          setReport(runRes.value.report);
          setLoading(false);
          return;
        }

        setFetchError(errorFromUnknown(runRes.reason, t));
        setLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [runId, t]);

  const doApply = (): void => {
    if (runId === undefined || report === null || !canApplyReport(report) || applying) return;
    setApplying(true);
    setApplyError(null);
    void applyRun(runId)
      .then((res) => {
        setReport(res.report);
        setApplying(false);
      })
      .catch((err: unknown) => {
        setApplyError(errorFromUnknown(err, t));
        setApplying(false);
      });
  };

  // uiux-fix F018 C258: first click arms the confirm state (auto-resets after 6 s),
  // the second click actually applies.
  const onApplyClick = (): void => {
    if (applying) return;
    if (!confirmApply) {
      setConfirmApply(true);
      if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = window.setTimeout(() => {
        setConfirmApply(false);
        confirmTimerRef.current = null;
      }, 6000);
      return;
    }
    if (confirmTimerRef.current !== null) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setConfirmApply(false);
    doApply();
  };

  const selectFile = (index: number): void => {
    setActiveFile(index);
  };

  const evidenceHref = `/api/evidence/${encodeURIComponent(runId ?? "")}`;
  const diff = useMemo(
    () => (report?.proposedDiff !== undefined ? parseUnifiedDiff(report.proposedDiff) : null),
    [report?.proposedDiff],
  );
  const changedFiles: readonly ChangedFile[] = report?.changedFiles ?? [];
  const totals = useMemo(
    () => ({
      added: diff?.files.reduce((s, f) => s + f.addedLines, 0) ?? 0,
      removed: diff?.files.reduce((s, f) => s + f.removedLines, 0) ?? 0,
    }),
    [diff],
  );
  const diffFileCount = diff?.files.length ?? 0;
  const selectedFileIndex =
    diff !== null && diff.files.length > 0
      ? Math.min(activeFile ?? 0, diff.files.length - 1)
      : null;
  const selectedFile = selectedFileIndex !== null ? diff?.files[selectedFileIndex] : undefined;
  const isRunning = report?.status === "running";

  // State 1: no runId — uiux-fix F018 C110: there is no editable "window
  // configuration" after opening, so offer an inline run-ID form instead of
  // pointing at a dead end. Without the persistence callback the old copy stays.
  if (runId === undefined || runId === "") {
    return (
      <section className="review rv-empty" aria-label={t("reviewWidget.diffReviewLabel")}>
        <h2 className="rv-empty-h">{t("reviewWidget.heading")}</h2>
        {onRunIdSubmit !== undefined ? (
          <>
            <p className="rv-empty-p">{t("reviewWidget.pasteRunId")}</p>
            <form
              className="rv-empty-form"
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = runIdInput.trim();
                if (trimmed.length === 0) return;
                onRunIdSubmit(trimmed);
              }}
            >
              <label className="rv-empty-label" htmlFor="rv-runid-input">
                {t("reviewWidget.runIdLabel")}
              </label>
              <input
                id="rv-runid-input"
                className="rv-runid-input mono"
                type="text"
                value={runIdInput}
                onChange={(e) => setRunIdInput(e.target.value)}
                placeholder={t("reviewWidget.runIdPlaceholder")}
              />
              <button type="submit" className="arun-btn">
                {t("reviewWidget.loadRun")}
              </button>
            </form>
          </>
        ) : (
          <p className="rv-empty-p">{t("reviewWidget.enterRunIdWindowConfig")}</p>
        )}
      </section>
    );
  }

  return (
    <section className="review" aria-label={t("reviewWidget.diffReviewLabel")}>
      {/* State 2: loading. role="status" exposes the aria-label and announces the
          loading state; aria-label on a bare div has no effect for AT (C256). */}
      {loading && (
        <div
          className="rv-loading"
          role="status"
          aria-busy="true"
          aria-label={t("reviewWidget.loadingDiff")}
        >
          <div className="rv-skel" />
          <div className="rv-skel rv-skel-sm" />
        </div>
      )}

      {/* State 3: fetch error. uiux-fix F018 C124: the human message leads; the
          machine code is demoted to a small mono detail instead of a bold prefix. */}
      {!loading && fetchError !== null && (
        <div role="alert" className="rv-error">
          {fetchError.code === "NOT_FOUND" ? (
            t("reviewWidget.notFound")
          ) : (
            <>
              {fetchError.message} <span className="err-code mono">({fetchError.code})</span>
            </>
          )}
          {(hasManifest || evidenceError !== null) && (
            <span className="rv-error-evidence">
              <EvidenceControl
                href={evidenceHref}
                hasManifest={hasManifest}
                error={evidenceError}
              />
            </span>
          )}
        </div>
      )}

      {/* State 4: running. uiux-fix F018 C124: the live region stays mounted (class
          swaps to .sr-only when empty) so AT reliably announce the text — a region
          mounted together with its content is often missed by NVDA/VoiceOver. */}
      <p
        role="status"
        aria-live="polite"
        className={
          !loading && fetchError === null && report !== null && isRunning ? "rv-no-diff" : "sr-only"
        }
      >
        {!loading && fetchError === null && report !== null && isRunning
          ? t("reviewWidget.stillRunning")
          : ""}
      </p>

      {/* State 4: no diff */}
      {!loading && fetchError === null && report !== null && !isRunning && !hasDiff(report) && (
        <p className="rv-no-diff">{t("reviewWidget.noDiff")}</p>
      )}

      {/* State 5: loaded with diff */}
      {!loading && fetchError === null && report !== null && hasDiff(report) && (
        <>
          <div className="rv-header">
            <span className="rv-status mono">{runStatusLabel(report.status)}</span>
            {report.modelId !== undefined && (
              <span className="rv-model mono">{report.modelId}</span>
            )}
            <span className="rv-counts mono">
              {diff !== null &&
                (diffFileCount === 1
                  ? t("reviewWidget.fileCountSingular", { count: diffFileCount })
                  : t("reviewWidget.fileCountPlural", { count: diffFileCount }))}{" "}
              <span className="rv-stat add">+{totals.added}</span>{" "}
              <span className="rv-stat del">−{totals.removed}</span>
            </span>
            <span className="spacer" />
            <EvidenceControl href={evidenceHref} hasManifest={hasManifest} error={evidenceError} />
          </div>

          {diff !== null &&
            diff.files.length > 0 &&
            selectedFileIndex !== null &&
            selectedFile !== undefined && (
              <div className="rv-layout">
                {/* File list */}
                <nav className="rv-filelist" aria-label={t("reviewWidget.changedFilesLabel")}>
                  <ul>
                    {diff.files.map((file, idx) => {
                      const cf = changedFiles.find((c) => c.path === file.path);
                      const selected = selectedFileIndex === idx;
                      return (
                        <li key={file.path}>
                          <button
                            type="button"
                            className="rv-filerow"
                            title={file.path}
                            aria-pressed={selected}
                            aria-controls={selected ? `rv-file-${idx}` : undefined}
                            onClick={() => selectFile(idx)}
                          >
                            <span className="rv-filerow-path mono">{shortPath(file.path)}</span>
                            <span className="rv-stat add">+{file.addedLines}</span>
                            <span className="rv-stat del">−{file.removedLines}</span>
                            {cf?.elevatedReview === true && (
                              <span
                                className="rv-elevated"
                                aria-label={t("reviewWidget.elevatedReview")}
                              >
                                !
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </nav>

                {/* Diff body */}
                <div className="rv-body">
                  <DiffFileSection
                    key={selectedFile.path}
                    file={selectedFile}
                    index={selectedFileIndex}
                    changedFiles={changedFiles}
                    sectionRef={() => undefined}
                  />
                  {diff.truncated && (
                    <p role="note" className="rv-truncated">
                      {t("reviewWidget.truncated.prefix")}{" "}
                      {hasManifest ? (
                        <a href={evidenceHref} target="_blank" rel="noopener noreferrer">
                          {t("reviewWidget.truncated.linkText")}
                        </a>
                      ) : (
                        t("reviewWidget.truncated.linkText")
                      )}{" "}
                      {t("reviewWidget.truncated.suffix")}
                    </p>
                  )}
                </div>
              </div>
            )}

          {/* Apply controls */}
          <div className="rv-controls">
            <span role="status" aria-live="polite" className="rv-apply-status">
              {applying
                ? t("reviewWidget.applying")
                : report.appliedAt !== undefined
                  ? t("reviewWidget.applied")
                  : ""}
            </span>
            {applyError !== null && (
              <span role="alert" className="rv-apply-error">
                {applyError.message}
              </span>
            )}
            {report.appliedAt !== undefined ? (
              <span className="rv-final mono">{t("reviewWidget.applied")}</span>
            ) : canApplyReport(report) ? (
              // uiux-fix F018 C124/C258: aria-disabled keeps focus on the button while
              // applying; the confirm step names the blast radius before writing.
              <button
                type="button"
                className="arun-btn"
                aria-disabled={applying}
                onClick={onApplyClick}
              >
                {applying
                  ? t("reviewWidget.applying")
                  : confirmApply
                    ? diffFileCount === 1
                      ? t("reviewWidget.confirmApplySingular", { count: diffFileCount })
                      : t("reviewWidget.confirmApplyPlural", { count: diffFileCount })
                    : t("reviewWidget.apply")}
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
