"use client";

/**
 * Patch review — static route /run/patch?id=<runId>.
 * Uses useSearchParams() to read the run ID at runtime without dynamic segments.
 */

import { useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Suspense } from "react";
import type { ReactNode } from "react";
import { applyRun, fetchRunReport, ApiError } from "@/lib/api";
import type { ChangedFile, RunReport, VerificationAuditSummary } from "@/lib/types";
import {
  formatMs,
  outcomeClasses,
  outcomeLabel,
  verificationStatusClasses,
  verificationStatusLabel,
} from "@/lib/format";

// ---------------------------------------------------------------------------
// Diff viewer
// ---------------------------------------------------------------------------

type DiffLineKind = "add" | "remove" | "header" | "context";
interface DiffLine { kind: DiffLineKind; text: string; }

function parseDiffLines(diff: string): DiffLine[] {
  return diff.split("\n").map((line): DiffLine => {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return { kind: "header", text: line };
    if (line.startsWith("+")) return { kind: "add", text: line };
    if (line.startsWith("-")) return { kind: "remove", text: line };
    return { kind: "context", text: line };
  });
}

function lineClasses(kind: DiffLineKind): string {
  switch (kind) {
    case "add": return "bg-green-50 text-green-900";
    case "remove": return "bg-red-50 text-red-900";
    case "header": return "bg-surface-subtle text-ink-muted font-semibold";
    case "context": return "text-ink-muted";
  }
}

function linePrefix(kind: DiffLineKind): string {
  switch (kind) {
    case "add": return "[+] ";
    case "remove": return "[-] ";
    default: return "    ";
  }
}

function DiffViewer({ diff }: { diff: string }): ReactNode {
  const lines = parseDiffLines(diff);
  return (
    <figure aria-label="Proposed diff">
      <figcaption className="sr-only">
        Proposed patch diff. Lines prefixed with [+] are additions; [-] are removals.
      </figcaption>
      <div
        aria-label="Diff content"
        tabIndex={0} // eslint-disable-line jsx-a11y/no-noninteractive-tabindex
        className="overflow-x-auto rounded border border-ink/10 bg-surface p-4 focus:outline-none focus:ring-2 focus:ring-focus"
      >
        <pre className="font-mono text-xs leading-5">
          {lines.map((line, idx) => (
            <span key={`${String(idx)}-${line.kind}`} className={`block whitespace-pre ${lineClasses(line.kind)}`}>
              <span aria-hidden="true">{linePrefix(line.kind)}</span>
              {line.text}
            </span>
          ))}
        </pre>
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Changed files table
// ---------------------------------------------------------------------------

function ChangedFilesTable({ files }: { files: ChangedFile[] }): ReactNode {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Changed files in proposed patch</caption>
        <thead>
          <tr className="border-b border-ink/10 text-left text-xs text-ink-muted">
            <th scope="col" className="py-2 pr-4 font-medium">Path</th>
            <th scope="col" className="py-2 pr-4 font-medium">Kind</th>
            <th scope="col" className="py-2 pr-4 font-medium">+Lines</th>
            <th scope="col" className="py-2 pr-4 font-medium">-Lines</th>
            <th scope="col" className="py-2 font-medium">Review flag</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.path} className={`border-b border-ink/10 ${f.elevatedReview ? "bg-orange-50" : ""}`}>
              <td className="py-2 pr-4 font-mono text-xs">{f.path}</td>
              <td className="py-2 pr-4 text-ink-muted">{f.kind}</td>
              <td className="py-2 pr-4 text-green-700">+{f.addedLines.toString()}</td>
              <td className="py-2 pr-4 text-red-700">-{f.removedLines.toString()}</td>
              <td className="py-2">
                {f.elevatedReview ? (
                  <span className="rounded bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800">Elevated review</span>
                ) : (
                  <span className="text-ink-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verification summary
// ---------------------------------------------------------------------------

function VerificationSummary({ summary }: { summary: VerificationAuditSummary }): ReactNode {
  return (
    <div className="rounded-lg border border-ink/10 p-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-ink">Dry-run verification</span>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${verificationStatusClasses(summary.overallStatus)}`}>
          {verificationStatusLabel(summary.overallStatus)}
        </span>
        <span className="text-xs text-ink-muted">{formatMs(summary.durationMs)}</span>
      </div>
      {summary.results.length > 0 && (
        <ul className="mt-3 grid gap-1">
          {summary.results.map((r, idx) => (
            <li key={`${r.kind}-${String(idx)}`} className="flex items-center gap-2 text-xs text-ink-muted">
              <span className={`rounded px-1.5 py-0.5 font-medium ${verificationStatusClasses(r.status)}`}>{r.status}</span>
              <span className="font-mono">{r.command}</span>
              <span>({formatMs(r.durationMs)})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Apply confirm
// ---------------------------------------------------------------------------

interface ApplyConfirmProps { onConfirm: () => void; onCancel: () => void; applying: boolean; }

function ApplyConfirm({ onConfirm, onCancel, applying }: ApplyConfirmProps): ReactNode {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { confirmRef.current?.focus(); }, []);

  // Escape dismisses the dialog. A document-level listener (rather than a handler on the
  // non-interactive alertdialog container) keeps Escape working whichever control inside the dialog
  // holds focus, and avoids assigning an interaction to a non-interactive element.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape" && !applying) {
        e.preventDefault();
        onCancel();
      }
    }
    document.addEventListener("keydown", onKey);
    return (): void => {
      document.removeEventListener("keydown", onKey);
    };
  }, [applying, onCancel]);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="apply-confirm-heading"
      aria-describedby="apply-confirm-desc"
      className="rounded-lg border border-orange-300 bg-orange-50 p-4"
    >
      <h3 id="apply-confirm-heading" className="font-semibold text-orange-900">Apply patch to workspace?</h3>
      <p id="apply-confirm-desc" className="mt-1 text-sm text-orange-800">This will write the proposed changes to your workspace. Use version control to revert if needed.</p>
      <div className="mt-4 flex gap-3">
        <button ref={confirmRef} type="button" onClick={onConfirm} disabled={applying}
          className="rounded bg-orange-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-orange-800 focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-2 disabled:opacity-50">
          {applying ? "Applying…" : "Confirm apply"}
        </button>
        <button type="button" onClick={onCancel} disabled={applying}
          className="rounded border border-orange-300 px-4 py-1.5 text-sm text-orange-800 hover:bg-orange-100 focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-2 disabled:opacity-50">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Patch view inner
// ---------------------------------------------------------------------------

type ApplyState = "idle" | "confirming" | "applying" | "done" | "error";

function isAppliable(report: RunReport): boolean {
  return (report.status === "dry-run" || report.status === "fix-proposed") && report.proposedDiff !== undefined;
}

function PatchViewInner(): ReactNode {
  const searchParams = useSearchParams();
  const runId = searchParams.get("id") ?? "";
  const router = useRouter();

  const [report, setReport] = useState<RunReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applyState, setApplyState] = useState<ApplyState>("idle");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyReport, setApplyReport] = useState<RunReport | null>(null);
  const applyBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (runId === "") return;
    let active = true;
    fetchRunReport(runId)
      .then(({ report: r }) => { if (active) setReport(r); })
      .catch((err) => {
        if (!active) return;
        const msg = err instanceof ApiError ? err.message : "Failed to load run report";
        setLoadError(msg);
      });
    return () => { active = false; };
  }, [runId]);

  async function handleApply(): Promise<void> {
    setApplyState("applying");
    setApplyError(null);
    try {
      const { report: r } = await applyRun(runId);
      setApplyReport(r);
      setApplyState("done");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Apply failed";
      setApplyError(msg);
      setApplyState("error");
    }
  }

  function handleCancelConfirm(): void {
    setApplyState("idle");
    // Focus is restored via useEffect below, after the Apply button re-mounts.
  }

  useEffect(() => {
    if (applyState === "idle") {
      applyBtnRef.current?.focus();
    }
  }, [applyState]);

  if (runId === "") {
    return (
      <section aria-labelledby="patch-heading">
        <h1 id="patch-heading" className="text-heading text-ink">Patch review</h1>
        <p className="mt-4 text-sm text-ink-muted">No run ID specified.</p>
      </section>
    );
  }

  if (loadError !== null) {
    return (
      <section aria-labelledby="patch-heading">
        <h1 id="patch-heading" className="text-heading text-ink">Patch review</h1>
        <p role="alert" className="mt-4 rounded bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p>
      </section>
    );
  }

  if (report === null) {
    return (
      <section aria-labelledby="patch-heading">
        <h1 id="patch-heading" className="text-heading text-ink">Patch review</h1>
        <p className="mt-4 text-ink-muted" aria-busy="true">Loading run report…</p>
      </section>
    );
  }

  const appliable = isAppliable(report);

  return (
    <section aria-labelledby="patch-heading">
      <div className="flex items-center gap-4">
        <h1 id="patch-heading" className="text-heading text-ink">Patch review</h1>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${outcomeClasses(report.status)}`}>
          {outcomeLabel(report.status)}
        </span>
      </div>
      <p className="mt-1 font-mono text-xs text-ink-muted">{runId}</p>

      {report.dryRunPreview !== undefined && (
        <section aria-labelledby="preview-heading" className="mt-6">
          <h2 id="preview-heading" className="text-subheading text-ink">Validation summary</h2>
          <p className="mt-2 rounded border border-ink/10 bg-surface-subtle px-4 py-3 font-mono text-xs text-ink-muted">{report.dryRunPreview}</p>
        </section>
      )}

      {report.verificationSummary !== undefined && (
        <section aria-labelledby="verify-heading" className="mt-6">
          <h2 id="verify-heading" className="text-subheading text-ink">Verification</h2>
          <div className="mt-2"><VerificationSummary summary={report.verificationSummary} /></div>
        </section>
      )}

      {report.changedFiles !== undefined && report.changedFiles.length > 0 && (
        <section aria-labelledby="files-heading" className="mt-6">
          <h2 id="files-heading" className="text-subheading text-ink">Changed files</h2>
          <div className="mt-2"><ChangedFilesTable files={report.changedFiles} /></div>
        </section>
      )}

      {report.addedTestFiles !== undefined && report.addedTestFiles.length > 0 && (
        <section aria-labelledby="test-files-heading" className="mt-6">
          <h2 id="test-files-heading" className="text-subheading text-ink">Added test files</h2>
          <ul className="mt-2 grid gap-1">
            {report.addedTestFiles.map((f) => (
              <li key={f.path} className="font-mono text-sm text-ink">
                {f.path}
                {f.estimatedTestCount !== undefined && (
                  <span className="ml-2 text-xs text-ink-muted">(~{f.estimatedTestCount.toString()} tests)</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.proposedDiff !== undefined ? (
        <section aria-labelledby="diff-heading" className="mt-6">
          <h2 id="diff-heading" className="text-subheading text-ink">Proposed diff</h2>
          <div className="mt-2"><DiffViewer diff={report.proposedDiff} /></div>
        </section>
      ) : (
        <p className="mt-6 text-sm text-ink-muted">No diff available for this run.</p>
      )}

      <section aria-labelledby="apply-heading" className="mt-section">
        <h2 id="apply-heading" className="text-subheading text-ink">Apply patch</h2>
        {!appliable && applyState !== "done" && (
          <p className="mt-2 text-sm text-ink-muted">
            The patch can only be applied when the run is in a dry-run-success state. Current: {outcomeLabel(report.status)}.
          </p>
        )}
        {appliable && applyState === "idle" && (
          <div className="mt-4">
            <p className="text-sm text-ink-muted">No files changed yet. Review the diff carefully before applying.</p>
            <button ref={applyBtnRef} type="button" onClick={() => { setApplyState("confirming"); }}
              className="mt-3 rounded bg-accent px-6 py-2 text-sm font-semibold text-ink-inverse hover:bg-accent-strong focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-2">
              Apply patch
            </button>
          </div>
        )}
        {applyState === "confirming" && (
          <div className="mt-4">
            <ApplyConfirm onConfirm={() => { void handleApply(); }} onCancel={handleCancelConfirm} applying={false} />
          </div>
        )}
        {applyState === "applying" && (
          <p className="mt-4 text-sm text-ink-muted" aria-busy="true">Applying patch…</p>
        )}
        {applyState === "error" && applyError !== null && (
          <p role="alert" className="mt-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{applyError}</p>
        )}
        {applyState === "done" && applyReport !== null && (
          <div className="mt-4 rounded-lg border border-green-300 bg-green-50 p-4">
            <p className="font-semibold text-green-900">Patch applied successfully.</p>
            <p className="mt-1 text-sm text-green-800">Status: {outcomeLabel(applyReport.status)}</p>
          </div>
        )}
      </section>

      <div className="mt-8">
        <button type="button" onClick={() => { router.push(`/run?id=${encodeURIComponent(runId)}`); }}
          className="text-sm text-ink-muted underline hover:text-ink focus:outline-none focus:ring-2 focus:ring-focus">
          ← Back to run view
        </button>
      </div>
    </section>
  );
}

export default function PatchPage(): ReactNode {
  return (
    <Suspense fallback={
      <section aria-labelledby="patch-heading">
        <h1 id="patch-heading" className="text-heading text-ink">Patch review</h1>
        <p className="mt-4 text-ink-muted" aria-busy="true">Loading…</p>
      </section>
    }>
      <PatchViewInner />
    </Suspense>
  );
}
