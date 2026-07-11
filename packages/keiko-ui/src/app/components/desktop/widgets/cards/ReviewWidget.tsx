"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { ApiError, applyRun, fetchEvidenceManifest, fetchRunReport } from "../../../../../lib/api";
import { runStatusLabel } from "../../../../../lib/format";
import type { ChangedFile, RunReport } from "../../../../../lib/types";
import type { DiffFile, DiffParseResult } from "./shared/diffParser";
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

function errorFromUnknown(value: unknown): ErrorState {
  if (value instanceof ApiError) return { code: value.code, message: value.message };
  if (value instanceof Error) return { code: "INTERNAL", message: value.message };
  return { code: "INTERNAL", message: "Unexpected error." };
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
  if (hasManifest) {
    return (
      <a className="rv-evidence-link" href={href} target="_blank" rel="noopener noreferrer">
        Evidence
      </a>
    );
  }

  if (error !== null) {
    // message rendered inline — title/aria-label-only details are unreachable
    // for sighted keyboard users (WCAG 1.4.13; uiux-fix F023 C379).
    // role="alert" (assertive) is correct for errors per WCAG 4.1.3 (CW-02).
    return (
      <span className="rv-evidence-link rv-evidence-error" role="alert">
        Evidence error: {error.message}
      </span>
    );
  }

  // Unavailable evidence has no keyboard path — native <button disabled> gives
  // correct role/disabled semantics without requiring a href (WCAG 4.1.2, CW-01).
  // Visual appearance is unchanged via the same CSS classes.
  return (
    <button type="button" className="rv-evidence-link rv-evidence-disabled" disabled>
      Evidence
    </button>
  );
}

// --- run + evidence loading --------------------------------------------------
// Extracted from the runId effect (uiux-fix S3776): module-scope so the branching
// that used to live inside the effect's `.then` closure is assessed on its own
// instead of adding to the component's cognitive complexity.

interface ReviewLoadSetters {
  readonly setReport: Dispatch<SetStateAction<RunReport | null>>;
  readonly setHasManifest: Dispatch<SetStateAction<boolean>>;
  readonly setEvidenceError: Dispatch<SetStateAction<ErrorState | null>>;
  readonly setFetchError: Dispatch<SetStateAction<ErrorState | null>>;
  readonly setLoading: Dispatch<SetStateAction<boolean>>;
  readonly setActiveFile: Dispatch<SetStateAction<number | null>>;
}

type RunReportResult = PromiseSettledResult<Awaited<ReturnType<typeof fetchRunReport>>>;
type EvidenceManifestResult = PromiseSettledResult<
  Awaited<ReturnType<typeof fetchEvidenceManifest>>
>;

function resetReviewLoadState(setters: ReviewLoadSetters): void {
  setters.setLoading(true);
  setters.setFetchError(null);
  setters.setReport(null);
  setters.setHasManifest(false);
  setters.setEvidenceError(null);
  setters.setActiveFile(null);
}

function applyManifestResult(
  manifRes: EvidenceManifestResult,
  setters: Pick<ReviewLoadSetters, "setHasManifest" | "setEvidenceError">,
): void {
  if (manifRes.status === "fulfilled") {
    setters.setHasManifest(true);
    setters.setEvidenceError(null);
    return;
  }
  const manifestError = errorFromUnknown(manifRes.reason);
  setters.setHasManifest(false);
  setters.setEvidenceError(manifestError.code === "NOT_FOUND" ? null : manifestError);
}

function applyRunResult(
  runRes: RunReportResult,
  setters: Pick<ReviewLoadSetters, "setReport" | "setFetchError" | "setLoading">,
): void {
  if (runRes.status === "fulfilled") {
    setters.setReport(runRes.value.report);
    setters.setLoading(false);
    return;
  }
  setters.setFetchError(errorFromUnknown(runRes.reason));
  setters.setLoading(false);
}

function applyLoadResult(
  runRes: RunReportResult,
  manifRes: EvidenceManifestResult,
  setters: ReviewLoadSetters,
): void {
  applyManifestResult(manifRes, setters);
  applyRunResult(runRes, setters);
}

// --- State 1: empty state -----------------------------------------------------

interface ReviewEmptyStateProps {
  readonly onRunIdSubmit: ((runId: string) => void) | undefined;
  readonly runIdInput: string;
  readonly setRunIdInput: Dispatch<SetStateAction<string>>;
}

function ReviewEmptyState({
  onRunIdSubmit,
  runIdInput,
  setRunIdInput,
}: ReviewEmptyStateProps): ReactNode {
  return (
    <section className="review rv-empty" aria-label="Diff review">
      <h2 className="rv-empty-h">Review</h2>
      {onRunIdSubmit !== undefined ? (
        <>
          <p className="rv-empty-p">Paste a run ID below to load a proposed diff.</p>
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
              Run ID
            </label>
            <input
              id="rv-runid-input"
              className="rv-runid-input mono"
              type="text"
              value={runIdInput}
              onChange={(e) => setRunIdInput(e.target.value)}
              placeholder="e.g. 7f3a9c12…"
            />
            <button type="submit" className="arun-btn">
              Load run
            </button>
          </form>
        </>
      ) : (
        <p className="rv-empty-p">
          Enter a run ID in the window configuration to load a proposed diff.
        </p>
      )}
    </section>
  );
}

// --- State 3: fetch error -----------------------------------------------------

interface ReviewFetchErrorProps {
  readonly fetchError: ErrorState;
  readonly hasManifest: boolean;
  readonly evidenceError: ErrorState | null;
  readonly evidenceHref: string;
}

function ReviewFetchError({
  fetchError,
  hasManifest,
  evidenceError,
  evidenceHref,
}: ReviewFetchErrorProps): ReactNode {
  return (
    <div role="alert" className="rv-error">
      {fetchError.code === "NOT_FOUND" ? (
        "No run with that ID was found."
      ) : (
        <>
          {fetchError.message} <span className="err-code mono">({fetchError.code})</span>
        </>
      )}
      {(hasManifest || evidenceError !== null) && (
        <span className="rv-error-evidence">
          <EvidenceControl href={evidenceHref} hasManifest={hasManifest} error={evidenceError} />
        </span>
      )}
    </div>
  );
}

// --- State 5: loaded with diff ------------------------------------------------

interface ReviewHeaderProps {
  readonly report: RunReport;
  readonly diff: DiffParseResult | null;
  readonly totals: { readonly added: number; readonly removed: number };
  readonly evidenceHref: string;
  readonly hasManifest: boolean;
  readonly evidenceError: ErrorState | null;
}

function ReviewHeader({
  report,
  diff,
  totals,
  evidenceHref,
  hasManifest,
  evidenceError,
}: ReviewHeaderProps): ReactNode {
  return (
    <div className="rv-header">
      <span className="rv-status mono">{runStatusLabel(report.status)}</span>
      {report.modelId !== undefined && <span className="rv-model mono">{report.modelId}</span>}
      <span className="rv-counts mono">
        {diff !== null && `${diff.files.length} file${diff.files.length !== 1 ? "s" : ""}`}{" "}
        <span className="rv-stat add">+{totals.added}</span>{" "}
        <span className="rv-stat del">−{totals.removed}</span>
      </span>
      <span className="spacer" />
      <EvidenceControl href={evidenceHref} hasManifest={hasManifest} error={evidenceError} />
    </div>
  );
}

interface ReviewFileListProps {
  readonly files: readonly DiffFile[];
  readonly changedFiles: readonly ChangedFile[];
  readonly selectedFileIndex: number;
  readonly onSelectFile: (index: number) => void;
}

function ReviewFileList({
  files,
  changedFiles,
  selectedFileIndex,
  onSelectFile,
}: ReviewFileListProps): ReactNode {
  return (
    <nav className="rv-filelist" aria-label="Changed files">
      <ul>
        {files.map((file, idx) => {
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
                onClick={() => onSelectFile(idx)}
              >
                <span className="rv-filerow-path mono">{shortPath(file.path)}</span>
                <span className="rv-stat add">+{file.addedLines}</span>
                <span className="rv-stat del">−{file.removedLines}</span>
                {cf?.elevatedReview === true && (
                  <span className="rv-elevated" aria-label="Elevated review">
                    !
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

interface ReviewDiffLayoutProps {
  readonly diff: DiffParseResult;
  readonly changedFiles: readonly ChangedFile[];
  readonly selectedFileIndex: number;
  readonly selectedFile: DiffFile;
  readonly hasManifest: boolean;
  readonly evidenceHref: string;
  readonly onSelectFile: (index: number) => void;
}

function ReviewDiffLayout({
  diff,
  changedFiles,
  selectedFileIndex,
  selectedFile,
  hasManifest,
  evidenceHref,
  onSelectFile,
}: ReviewDiffLayoutProps): ReactNode {
  return (
    <div className="rv-layout">
      {/* File list */}
      <ReviewFileList
        files={diff.files}
        changedFiles={changedFiles}
        selectedFileIndex={selectedFileIndex}
        onSelectFile={onSelectFile}
      />

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
            Diff truncated at 512 KB. Open the{" "}
            {hasManifest ? (
              <a href={evidenceHref} target="_blank" rel="noopener noreferrer">
                evidence manifest
              </a>
            ) : (
              "evidence manifest"
            )}{" "}
            for the full record.
          </p>
        )}
      </div>
    </div>
  );
}

function applyStatusText(applying: boolean, appliedAt: number | undefined): string {
  if (applying) return "Applying…";
  if (appliedAt !== undefined) return "Applied";
  return "";
}

function applyButtonLabel(applying: boolean, confirmApply: boolean, fileCount: number): string {
  if (applying) return "Applying…";
  if (confirmApply) {
    return `Confirm apply (${fileCount.toString()} file${fileCount === 1 ? "" : "s"})`;
  }
  return "Apply";
}

interface ReviewApplyControlsProps {
  readonly report: RunReport;
  readonly applying: boolean;
  readonly applyError: ErrorState | null;
  readonly confirmApply: boolean;
  readonly diff: DiffParseResult | null;
  readonly onApplyClick: () => void;
}

function ReviewApplyControls({
  report,
  applying,
  applyError,
  confirmApply,
  diff,
  onApplyClick,
}: ReviewApplyControlsProps): ReactNode {
  return (
    <div className="rv-controls">
      <span role="status" aria-live="polite" className="rv-apply-status">
        {applyStatusText(applying, report.appliedAt)}
      </span>
      {applyError !== null && (
        <span role="alert" className="rv-apply-error">
          {applyError.message}
        </span>
      )}
      {report.appliedAt !== undefined ? (
        <span className="rv-final mono">Applied</span>
      ) : canApplyReport(report) ? (
        // uiux-fix F018 C124/C258: aria-disabled keeps focus on the button while
        // applying; the confirm step names the blast radius before writing.
        <button type="button" className="arun-btn" aria-disabled={applying} onClick={onApplyClick}>
          {applyButtonLabel(applying, confirmApply, diff?.files.length ?? 0)}
        </button>
      ) : null}
    </div>
  );
}

// --- main widget ------------------------------------------------------------

export function ReviewWidget({ runId, onRunIdSubmit }: ReviewWidgetProps): ReactNode {
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
    resetReviewLoadState({
      setLoading,
      setFetchError,
      setReport,
      setHasManifest,
      setEvidenceError,
      setActiveFile,
    });

    void Promise.allSettled([fetchRunReport(runId), fetchEvidenceManifest(runId)]).then(
      ([runRes, manifRes]) => {
        if (cancelled) return;
        applyLoadResult(runRes, manifRes, {
          setReport,
          setHasManifest,
          setEvidenceError,
          setFetchError,
          setLoading,
          setActiveFile,
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [runId]);

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
        setApplyError(errorFromUnknown(err));
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
  const selectedFileIndex =
    diff !== null && diff.files.length > 0
      ? Math.min(activeFile ?? 0, diff.files.length - 1)
      : null;
  const selectedFile = selectedFileIndex !== null ? diff?.files[selectedFileIndex] : undefined;
  const isRunning = report?.status === "running";
  const showRunningStatus = !loading && fetchError === null && report !== null && isRunning;

  // State 1: no runId — uiux-fix F018 C110: there is no editable "window
  // configuration" after opening, so offer an inline run-ID form instead of
  // pointing at a dead end. Without the persistence callback the old copy stays.
  if (runId === undefined || runId === "") {
    return (
      <ReviewEmptyState
        onRunIdSubmit={onRunIdSubmit}
        runIdInput={runIdInput}
        setRunIdInput={setRunIdInput}
      />
    );
  }

  return (
    <section className="review" aria-label="Diff review">
      {/* State 2: loading. role="status" exposes the aria-label and announces the
          loading state; aria-label on a bare div has no effect for AT (C256). */}
      {loading && (
        <div className="rv-loading" role="status" aria-busy="true" aria-label="Loading diff">
          <div className="rv-skel" />
          <div className="rv-skel rv-skel-sm" />
        </div>
      )}

      {/* State 3: fetch error. uiux-fix F018 C124: the human message leads; the
          machine code is demoted to a small mono detail instead of a bold prefix. */}
      {!loading && fetchError !== null && (
        <ReviewFetchError
          fetchError={fetchError}
          hasManifest={hasManifest}
          evidenceError={evidenceError}
          evidenceHref={evidenceHref}
        />
      )}

      {/* State 4: running. uiux-fix F018 C124: the live region stays mounted (class
          swaps to .sr-only when empty) so AT reliably announce the text — a region
          mounted together with its content is often missed by NVDA/VoiceOver. */}
      <p role="status" aria-live="polite" className={showRunningStatus ? "rv-no-diff" : "sr-only"}>
        {showRunningStatus
          ? "Run is still running. The proposed diff will appear when the run completes."
          : ""}
      </p>

      {/* State 4: no diff */}
      {!loading && fetchError === null && report !== null && !isRunning && !hasDiff(report) && (
        <p className="rv-no-diff">This run has no proposed diff to review.</p>
      )}

      {/* State 5: loaded with diff */}
      {!loading && fetchError === null && report !== null && hasDiff(report) && (
        <>
          <ReviewHeader
            report={report}
            diff={diff}
            totals={totals}
            evidenceHref={evidenceHref}
            hasManifest={hasManifest}
            evidenceError={evidenceError}
          />

          {diff !== null &&
            diff.files.length > 0 &&
            selectedFileIndex !== null &&
            selectedFile !== undefined && (
              <ReviewDiffLayout
                diff={diff}
                changedFiles={changedFiles}
                selectedFileIndex={selectedFileIndex}
                selectedFile={selectedFile}
                hasManifest={hasManifest}
                evidenceHref={evidenceHref}
                onSelectFile={selectFile}
              />
            )}

          {/* Apply controls */}
          <ReviewApplyControls
            report={report}
            applying={applying}
            applyError={applyError}
            confirmApply={confirmApply}
            diff={diff}
            onApplyClick={onApplyClick}
          />
        </>
      )}
    </section>
  );
}
