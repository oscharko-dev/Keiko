"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, applyRun, fetchEvidenceManifest, fetchRunReport } from "../../../../../lib/api";
import type { ChangedFile, RunReport, RunStatus } from "../../../../../lib/types";
import { langOf, highlightLines } from "./shared/syntaxHighlight";
import type { Token } from "./shared/syntaxHighlight";
import { parseUnifiedDiff } from "./shared/diffParser";
import type { DiffFile, DiffHunk, DiffLine } from "./shared/diffParser";

export interface ReviewWidgetProps {
  /** Run ID for the patch under review. When omitted, shows the empty state. */
  readonly runId?: string;
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
  const slash = p.lastIndexOf("/");
  if (slash === -1) return p;
  return `…/${p.slice(slash + 1)}`;
}

function statusLabel(s: RunStatus): string {
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
  return map[s] ?? s;
}

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
      <a
        className="rv-evidence-link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        Evidence
      </a>
    );
  }

  if (error !== null) {
    return (
      <span
        className="rv-evidence-link rv-evidence-error"
        role="status"
        aria-label={`Evidence unavailable: ${error.message}`}
        title={error.message}
      >
        Evidence error
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
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "ctx" ? "·" : "";
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
      <span className="rv-gutter" aria-hidden="true">{sign}</span>
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

function DiffFileSection({ file, index, changedFiles, sectionRef }: DiffFileSectionProps): ReactNode {
  const cf = changedFiles.find((c) => c.path === file.path);
  const ext = file.path.includes(".") ? (file.path.split(".").pop() ?? "code") : "code";

  return (
    <section
      id={`rv-file-${index}`}
      aria-labelledby={`rv-file-${index}-h`}
      ref={sectionRef}
    >
      <h3 id={`rv-file-${index}-h`} className="rv-file mono">
        <span className="rv-path">{file.path}</span>
        {file.oldPath !== undefined && (
          <span className="rv-oldpath"> (was {file.oldPath})</span>
        )}
        <span className="spacer" />
        <span className="rv-stat add">+{file.addedLines}</span>
        <span className="rv-stat del">−{file.removedLines}</span>
        {cf?.elevatedReview === true && (
          <span className="rv-elevated" aria-label="Elevated review">!</span>
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

export function ReviewWidget({ runId }: ReviewWidgetProps): ReactNode {
  const [report, setReport] = useState<RunReport | null>(null);
  const [hasManifest, setHasManifest] = useState(false);
  const [evidenceError, setEvidenceError] = useState<ErrorState | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<ErrorState | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<ErrorState | null>(null);
  const [activeFile, setActiveFile] = useState<number | null>(null);

  useEffect(() => {
    if (runId === undefined || runId === "") return;
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    setReport(null);
    setHasManifest(false);
    setEvidenceError(null);
    setActiveFile(null);

    void Promise.allSettled([
      fetchRunReport(runId),
      fetchEvidenceManifest(runId),
    ]).then(([runRes, manifRes]) => {
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
    });

    return () => { cancelled = true; };
  }, [runId]);

  const doApply = (): void => {
    if (runId === undefined || report === null || !canApplyReport(report)) return;
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

  const selectFile = (index: number): void => {
    setActiveFile(index);
  };

  const evidenceHref = `/api/evidence/${encodeURIComponent(runId ?? "")}`;
  const diff = useMemo(
    () => report?.proposedDiff !== undefined ? parseUnifiedDiff(report.proposedDiff) : null,
    [report?.proposedDiff],
  );
  const changedFiles: readonly ChangedFile[] = report?.changedFiles ?? [];
  const totals = useMemo(() => ({
    added: diff?.files.reduce((s, f) => s + f.addedLines, 0) ?? 0,
    removed: diff?.files.reduce((s, f) => s + f.removedLines, 0) ?? 0,
  }), [diff]);
  const selectedFileIndex =
    diff !== null && diff.files.length > 0
      ? Math.min(activeFile ?? 0, diff.files.length - 1)
      : null;
  const selectedFile = selectedFileIndex !== null ? diff?.files[selectedFileIndex] : undefined;
  const isRunning = report?.status === "running";

  // State 1: no runId
  if (runId === undefined || runId === "") {
    return (
      <section className="review rv-empty" aria-label="Diff review">
        <h2 className="rv-empty-h">Review</h2>
        <p className="rv-empty-p">Enter a run ID in the window configuration to load a proposed diff.</p>
      </section>
    );
  }

  return (
    <section className="review" aria-label="Diff review">
      {/* State 2: loading */}
      {loading && (
        <div className="rv-loading" aria-busy="true" aria-label="Loading diff">
          <div className="rv-skel" />
          <div className="rv-skel rv-skel-sm" />
        </div>
      )}

      {/* State 3: fetch error */}
      {!loading && fetchError !== null && (
        <div role="alert" className="rv-error">
          {fetchError.code === "NOT_FOUND"
            ? "No run with that ID was found."
            : `${fetchError.code}: ${fetchError.message}`}
          {(hasManifest || evidenceError !== null) && (
            <span className="rv-error-evidence">
              <EvidenceControl href={evidenceHref} hasManifest={hasManifest} error={evidenceError} />
            </span>
          )}
        </div>
      )}

      {/* State 4: running */}
      {!loading && fetchError === null && report !== null && isRunning && (
        <p role="status" aria-live="polite" className="rv-no-diff">
          Run is still running. The proposed diff will appear when the run completes.
        </p>
      )}

      {/* State 4: no diff */}
      {!loading && fetchError === null && report !== null && !isRunning && !hasDiff(report) && (
        <p className="rv-no-diff">This run has no proposed diff to review.</p>
      )}

      {/* State 5: loaded with diff */}
      {!loading && fetchError === null && report !== null && hasDiff(report) && (
        <>
          <div className="rv-header">
            <span className="rv-status mono">{statusLabel(report.status)}</span>
            {report.modelId !== undefined && (
              <span className="rv-model mono">{report.modelId}</span>
            )}
            <span className="rv-counts mono">
              {diff !== null && (
                `${diff.files.length} file${diff.files.length !== 1 ? "s" : ""}`
              )}
              {" "}
              <span className="rv-stat add">+{totals.added}</span>
              {" "}
              <span className="rv-stat del">−{totals.removed}</span>
            </span>
            <span className="spacer" />
            <EvidenceControl href={evidenceHref} hasManifest={hasManifest} error={evidenceError} />
          </div>

          {diff !== null && diff.files.length > 0 && selectedFileIndex !== null && selectedFile !== undefined && (
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
                          aria-pressed={selected}
                          aria-controls={selected ? `rv-file-${idx}` : undefined}
                          onClick={() => selectFile(idx)}
                        >
                          <span className="rv-filerow-path mono">{shortPath(file.path)}</span>
                          <span className="rv-stat add">+{file.addedLines}</span>
                          <span className="rv-stat del">−{file.removedLines}</span>
                          {cf?.elevatedReview === true && (
                            <span className="rv-elevated" aria-label="Elevated review">!</span>
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
              <span role="alert" className="rv-apply-error">{applyError.message}</span>
            )}
            {report.appliedAt !== undefined ? (
              <span className="rv-final mono">Applied</span>
            ) : canApplyReport(report) ? (
              <button
                type="button"
                className="arun-btn"
                disabled={applying}
                onClick={doApply}
              >
                {applying ? "Applying…" : "Apply"}
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
