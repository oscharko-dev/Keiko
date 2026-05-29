"use client";

/**
 * Evidence manifest detail — static route /evidence/detail?id=<runId>.
 * Uses useSearchParams() to read the run ID at runtime without dynamic segments.
 */

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Suspense } from "react";
import type { ReactNode } from "react";
import { fetchEvidenceManifest, ApiError } from "@/lib/api";
import type { EvidenceManifest, EvidenceReasoningEntry } from "@/lib/types";
import {
  costClassClasses,
  costClassLabel,
  formatDate,
  formatMs,
  formatTokens,
  outcomeClasses,
  outcomeLabel,
  verificationStatusClasses,
  verificationStatusLabel,
} from "@/lib/format";

// ---------------------------------------------------------------------------
// Reasoning trace
// ---------------------------------------------------------------------------

function ReasoningTrace({ entries }: { entries: EvidenceReasoningEntry[] }): ReactNode {
  return (
    <section aria-labelledby="reasoning-heading" className="mt-section">
      <h2 id="reasoning-heading" className="text-subheading text-ink">Reasoning trace</h2>
      <ol aria-label="Reasoning entries" className="mt-4 grid gap-3">
        {entries.map((entry) => (
          <li key={`${entry.seq}`} className="rounded border border-ink/10 bg-surface-subtle p-4">
            <div className="flex items-center gap-3 text-xs text-ink-muted">
              <span className="font-mono">seq {entry.seq.toString()}</span>
              <span>{formatDate(entry.ts)}</span>
              <span className="rounded bg-surface px-2 py-0.5 font-medium">{entry.phase}</span>
            </div>
            {entry.rationale !== undefined && <p className="mt-2 text-sm text-ink">{entry.rationale}</p>}
            {entry.modelResponse !== undefined && (
              <pre className="mt-2 overflow-x-auto rounded border border-ink/10 bg-surface p-3 font-mono text-xs text-ink-muted">
                {entry.modelResponse}
              </pre>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Detail inner
// ---------------------------------------------------------------------------

function EvidenceDetailInner(): ReactNode {
  const searchParams = useSearchParams();
  const runId = searchParams.get("id") ?? "";
  const router = useRouter();

  const [manifest, setManifest] = useState<EvidenceManifest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  useEffect(() => {
    if (runId === "") return;
    let active = true;
    fetchEvidenceManifest(runId)
      .then(({ manifest: m }) => { if (active) setManifest(m); })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError) { setErrorCode(err.code); setLoadError(err.message); }
        else setLoadError("Failed to load evidence manifest");
      });
    return () => { active = false; };
  }, [runId]);

  if (runId === "") {
    return (
      <section aria-labelledby="evidence-detail-heading">
        <h1 id="evidence-detail-heading" className="text-heading text-ink">Evidence detail</h1>
        <p className="mt-4 text-sm text-ink-muted">No run ID specified.</p>
      </section>
    );
  }

  if (loadError !== null) {
    const safeMessage =
      errorCode === "EVIDENCE_SCHEMA" ? "This evidence manifest uses an unsupported schema version and cannot be displayed."
      : errorCode === "NOT_FOUND" ? "No evidence manifest found for this run ID."
      : loadError;
    return (
      <section aria-labelledby="evidence-detail-heading">
        <h1 id="evidence-detail-heading" className="text-heading text-ink">Evidence detail</h1>
        <p role="alert" className="mt-4 rounded bg-red-50 px-4 py-3 text-sm text-red-700">{safeMessage}</p>
        <button type="button" onClick={() => { router.push("/evidence"); }}
          className="mt-4 text-sm text-ink-muted underline hover:text-ink focus:outline-none focus:ring-2 focus:ring-focus">
          ← Back to evidence browser
        </button>
      </section>
    );
  }

  if (manifest === null) {
    return (
      <section aria-labelledby="evidence-detail-heading">
        <h1 id="evidence-detail-heading" className="text-heading text-ink">Evidence detail</h1>
        <p className="mt-4 text-ink-muted" aria-busy="true">Loading manifest…</p>
      </section>
    );
  }

  const { run, model, usageTotals, verification, patch, reasoning, failure } = manifest;

  return (
    <section aria-labelledby="evidence-detail-heading">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="evidence-detail-heading" className="text-heading text-ink">Evidence detail</h1>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${outcomeClasses(run.outcome)}`}>
          {outcomeLabel(run.outcome)}
        </span>
      </div>
      <p className="mt-1 font-mono text-xs text-ink-muted">{run.runId}</p>

      <section aria-labelledby="run-id-heading" className="mt-section">
        <h2 id="run-id-heading" className="text-subheading text-ink">Run identity</h2>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-ink-muted">Task type</dt><dd className="font-mono">{run.taskType}</dd></div>
          <div><dt className="text-xs text-ink-muted">Fingerprint</dt><dd className="font-mono text-xs">{run.fingerprint}</dd></div>
          <div><dt className="text-xs text-ink-muted">Started</dt><dd>{formatDate(run.startedAt)}</dd></div>
          <div><dt className="text-xs text-ink-muted">Duration</dt><dd>{formatMs(run.durationMs)}</dd></div>
          <div><dt className="text-xs text-ink-muted">Schema version</dt><dd className="font-mono">v{manifest.evidenceSchemaVersion}</dd></div>
        </dl>
      </section>

      <section aria-labelledby="model-heading" className="mt-section">
        <h2 id="model-heading" className="text-subheading text-ink">Model</h2>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-ink-muted">Model ID</dt><dd className="font-mono">{model.modelId}</dd></div>
          <div>
            <dt className="text-xs text-ink-muted">Cost class</dt>
            <dd><span className={`rounded px-2 py-0.5 text-xs font-medium ${costClassClasses(model.costClass)}`}>{costClassLabel(model.costClass)}</span></dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="usage-heading" className="mt-section">
        <h2 id="usage-heading" className="text-subheading text-ink">Usage totals</h2>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-ink-muted">Prompt tokens</dt><dd className="font-mono">{formatTokens(usageTotals.promptTokens)}</dd></div>
          <div><dt className="text-xs text-ink-muted">Completion tokens</dt><dd className="font-mono">{formatTokens(usageTotals.completionTokens)}</dd></div>
          <div><dt className="text-xs text-ink-muted">Requests</dt><dd className="font-mono">{usageTotals.requestCount.toString()}</dd></div>
          <div><dt className="text-xs text-ink-muted">Total latency</dt><dd>{formatMs(usageTotals.totalLatencyMs)}</dd></div>
        </dl>
      </section>

      {verification !== undefined && (
        <section aria-labelledby="verif-heading" className="mt-section">
          <h2 id="verif-heading" className="text-subheading text-ink">Verification</h2>
          <div className="mt-4 rounded-lg border border-ink/10 p-4">
            <div className="flex items-center gap-3">
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${verificationStatusClasses(verification.overallStatus)}`}>
                {verificationStatusLabel(verification.overallStatus)}
              </span>
              <span className="text-xs text-ink-muted">{formatMs(verification.durationMs)}</span>
            </div>
            {verification.results.length > 0 && (
              <ul className="mt-3 grid gap-1">
                {verification.results.map((r, idx) => (
                  <li key={`${r.kind}-${String(idx)}`} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={`rounded px-1.5 py-0.5 font-medium ${verificationStatusClasses(r.status)}`}>{r.status}</span>
                    <span className="font-mono text-ink-muted">{r.command}</span>
                    <span className="text-ink-muted">({formatMs(r.durationMs)})</span>
                    {r.appliedLimits.map((lim) => (
                      <span key={lim.dimension}
                        className={`rounded px-1 py-0.5 text-xs ${lim.breached === true ? "bg-red-100 text-red-800" : "bg-gray-100 text-gray-700"}`}
                        title={lim.note ?? ""}>
                        {lim.dimension}: {lim.enforced ? "enforced" : "not enforced"}{lim.breached === true ? " (breached)" : ""}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {patch !== undefined && (
        <section aria-labelledby="patch-meta-heading" className="mt-section">
          <h2 id="patch-meta-heading" className="text-subheading text-ink">Patch</h2>
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-ink-muted">Proposed</dt><dd>{patch.proposed ? "Yes" : "No"}</dd></div>
            <div><dt className="text-xs text-ink-muted">Applied</dt><dd>{patch.applied ? "Yes" : "No"}</dd></div>
            <div><dt className="text-xs text-ink-muted">Files changed</dt><dd>{patch.targetFileCount.toString()}</dd></div>
          </dl>
          {patch.redactedDiff !== undefined && (
            <pre className="mt-3 overflow-x-auto rounded border border-ink/10 bg-surface-subtle p-4 font-mono text-xs text-ink-muted">
              {patch.redactedDiff}
            </pre>
          )}
        </section>
      )}

      {failure !== undefined && (
        <section aria-labelledby="failure-heading" className="mt-section">
          <h2 id="failure-heading" className="text-subheading text-ink">Failure</h2>
          <div className="mt-4 rounded border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-medium text-red-800">{failure.category}</p>
            <p className="mt-1 text-sm text-red-700">{failure.message}</p>
          </div>
        </section>
      )}

      {reasoning !== undefined && reasoning.length > 0 && <ReasoningTrace entries={reasoning} />}

      <div className="mt-8">
        <button type="button" onClick={() => { router.push("/evidence"); }}
          className="text-sm text-ink-muted underline hover:text-ink focus:outline-none focus:ring-2 focus:ring-focus">
          ← Back to evidence browser
        </button>
      </div>
    </section>
  );
}

export default function EvidenceDetailPage(): ReactNode {
  return (
    <Suspense fallback={
      <section aria-labelledby="evidence-detail-heading">
        <h1 id="evidence-detail-heading" className="text-heading text-ink">Evidence detail</h1>
        <p className="mt-4 text-ink-muted" aria-busy="true">Loading…</p>
      </section>
    }>
      <EvidenceDetailInner />
    </Suspense>
  );
}
