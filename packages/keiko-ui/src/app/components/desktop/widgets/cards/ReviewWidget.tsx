"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, applyRun, fetchEvidenceManifest, fetchRunReport } from "../../../../../lib/api";
import { runStatusLabel } from "../../../../../lib/format";
import type { ChangedFile, RunReport } from "../../../../../lib/types";
import { langOf, highlightLines } from "./shared/syntaxHighlight";
import type { Token } from "./shared/syntaxHighlight";
import { parseUnifiedDiff } from "./shared/diffParser";
import type { DiffFile, DiffHunk, DiffLine } from "./shared/diffParser";

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

function lineKindLabel(kind: DiffLine["kind"]): string {
  const map: Record<DiffLine["kind"], string> = {
    add: "Added line",
    del: "Deleted line",
    ctx: "Context line",
    meta: "Diff metadata",
  };
  return map[kind];
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
    // for sighted keyboard users (WCAG 1.4.13; uiux-fix F023 C379)
    return (
      <span className="rv-evidence-link rv-evidence-error" role="status">
        Evidence error: {error.message}
      </span>
    );
  }

  return (
    <span className="rv-evidence-link rv-evidence-disabled" role="link" aria-disabled="true">
      Evidence
    </span>
  );
}

// --- diff rendering helpers -------------------------------------------------

interface TokensProps {
  readonly tokens: readonly Token[];
}

function TokenSpans({ tokens }: TokensProps): ReactNode {
  return (
    <>
      {tokens.map((tok, idx) => (
        <span key={idx} className={`hl-${tok[0]}`}>
          {tok[1]}
        </span>
      ))}
    </>
  );
}

interface DiffLineViewProps {
  readonly line: DiffLine;
  readonly lang: string;
}

function DiffLineView({ line, lang }: DiffLineViewProps): ReactNode {
  // gutter sign provides a non-color channel for add/del/ctx (WCAG 1.4.1)
  const sign =
    line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "ctx" ? "·" : "";
  const cls = line.kind === "ctx" ? "" : ` rv-${line.kind}`;

  let content: ReactNode;
  if (line.kind !== "meta" && lang !== "code") {
    const tokenLines = highlightLines(line.text, langOf(lang));
    const toks = tokenLines[0] ?? [];
    content = <TokenSpans tokens={toks} />;
  } else {
    content = line.text;
  }

  return (
    <div className={`rv-line${cls}`}>
      <span className="rv-sr-only">{lineKindLabel(line.kind)}</span>
      <span className="rv-num-old rv-num">{line.oldLine ?? ""}</span>
      <span className="rv-num-new rv-num">{line.newLine ?? ""}</span>
      <span className="rv-gutter" aria-hidden="true">
        {sign}
      </span>
      <code className="rv-src">{content}</code>
    </div>
  );
}

interface DiffHunkViewProps {
  readonly hunk: DiffHunk;
  readonly lang: string;
}

function DiffHunkView({ hunk, lang }: DiffHunkViewProps): ReactNode {
  return (
    <>
      <div className="rv-hunk mono" aria-label={`Hunk header ${hunk.header}`}>
        <span className="rv-sr-only">Hunk header</span>
        {hunk.header}
      </div>
      {hunk.lines.map((line, idx) => (
        <DiffLineView key={idx} line={line} lang={lang} />
      ))}
    </>
  );
}

interface DiffFileSectionProps {
  readonly file: DiffFile;
  readonly index: number;
  readonly changedFiles: readonly ChangedFile[];
  readonly sectionRef: (el: HTMLElement | null) => void;
}

function DiffFileSection({
  file,
  index,
  changedFiles,
  sectionRef,
}: DiffFileSectionProps): ReactNode {
  const cf = changedFiles.find((c) => c.path === file.path);
  const ext = file.path.includes(".") ? (file.path.split(".").pop() ?? "code") : "code";

  return (
    <section id={`rv-file-${index}`} aria-labelledby={`rv-file-${index}-h`} ref={sectionRef}>
      <h3 id={`rv-file-${index}-h`} className="rv-file mono">
        <span className="rv-path">{file.path}</span>
        {file.oldPath !== undefined && <span className="rv-oldpath"> (was {file.oldPath})</span>}
        <span className="spacer" />
        <span className="rv-stat add">+{file.addedLines}</span>
        <span className="rv-stat del">−{file.removedLines}</span>
        {cf?.elevatedReview === true && (
          <span className="rv-elevated" aria-label="Elevated review">
            !
          </span>
        )}
      </h3>
      <div className="rv-code mono">
        {file.hunks.map((hunk, hi) => (
          <DiffHunkView key={hi} hunk={hunk} lang={ext} />
        ))}
      </div>
    </section>
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
          const manifestError = errorFromUnknown(manifRes.reason);
          setHasManifest(false);
          setEvidenceError(manifestError.code === "NOT_FOUND" ? null : manifestError);
        }

        if (runRes.status === "fulfilled") {
          setReport(runRes.value.report);
          setLoading(false);
          return;
        }

        setFetchError(errorFromUnknown(runRes.reason));
        setLoading(false);
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

  // State 1: no runId — uiux-fix F018 C110: there is no editable "window
  // configuration" after opening, so offer an inline run-ID form instead of
  // pointing at a dead end. Without the persistence callback the old copy stays.
  if (runId === undefined || runId === "") {
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
          <div className="rv-header">
            <span className="rv-status mono">{runStatusLabel(report.status)}</span>
            {report.modelId !== undefined && (
              <span className="rv-model mono">{report.modelId}</span>
            )}
            <span className="rv-counts mono">
              {diff !== null && `${diff.files.length} file${diff.files.length !== 1 ? "s" : ""}`}{" "}
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
                <nav className="rv-filelist" aria-label="Changed files">
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
            )}

          {/* Apply controls */}
          <div className="rv-controls">
            <span role="status" aria-live="polite" className="rv-apply-status">
              {applying ? "Applying…" : report.appliedAt !== undefined ? "Applied" : ""}
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
              <button
                type="button"
                className="arun-btn"
                aria-disabled={applying}
                onClick={onApplyClick}
              >
                {applying
                  ? "Applying…"
                  : confirmApply
                    ? `Confirm apply (${(diff?.files.length ?? 0).toString()} file${diff?.files.length === 1 ? "" : "s"})`
                    : "Apply"}
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
