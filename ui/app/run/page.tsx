"use client";

/**
 * Live run view — static route /run?id=<runId>.
 * Uses useSearchParams() to read the run ID at runtime without dynamic segments.
 * This keeps the static export compatible (output: "export" in next.config.mjs).
 */

import { useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import type { ReactNode } from "react";
import { useSSE } from "@/lib/useSSE";
import { cancelRun, fetchRunReport, fetchModels, ApiError } from "@/lib/api";
import type { HarnessEvent, ModelCapability, RunReport, SseStatus } from "@/lib/types";
import {
  costClassLabel,
  formatBytes,
  formatMs,
  formatTokens,
  outcomeClasses,
  outcomeLabel,
  verificationStatusClasses,
  verificationStatusLabel,
} from "@/lib/format";
import { ResourceLimitDecisionsTable } from "@/lib/ResourceLimitDecisionsTable";

// ---------------------------------------------------------------------------
// Event timeline item
// ---------------------------------------------------------------------------

function EventCard({
  label,
  detail,
  meta,
  variant,
}: {
  label: string;
  detail?: string;
  meta?: string;
  variant?: "default" | "success" | "error" | "muted";
}): ReactNode {
  const border =
    variant === "success"
      ? "border-l-green-400"
      : variant === "error"
        ? "border-l-red-400"
        : variant === "muted"
          ? "border-l-gray-300"
          : "border-l-accent";
  return (
    <li className={`rounded-r border-l-4 ${border} bg-surface-subtle px-4 py-2`}>
      <p className="text-sm font-medium text-ink">{label}</p>
      {detail !== undefined && detail !== "" && (
        <p className="mt-0.5 text-xs text-ink-muted">{detail}</p>
      )}
      {meta !== undefined && meta !== "" && (
        <p className="mt-0.5 font-mono text-xs text-ink-muted">{meta}</p>
      )}
    </li>
  );
}

function renderEvent(ev: HarnessEvent, models: ModelCapability[]): ReactNode {
  switch (ev.type) {
    case "run:started":
      return (
        <EventCard
          key={`${ev.seq}`}
          label={`Run started — ${ev.taskType}`}
          detail={`Model: ${ev.modelId}`}
          meta={`Limits: ${Object.entries(ev.limits)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(" ")}`}
        />
      );
    case "state:transition":
      return (
        <EventCard
          key={`${ev.seq}`}
          label={`State: ${ev.from} → ${ev.to}`}
          {...(ev.reason !== undefined ? { detail: ev.reason } : {})}
          variant="muted"
        />
      );
    case "model:call:started":
      return (
        <EventCard
          key={`${ev.seq}`}
          label={`Model call started — ${ev.modelId}`}
          detail={`${ev.messageCount.toString()} messages · ${formatBytes(ev.contextBytes)} context`}
        />
      );
    case "model:call:completed": {
      const cap = models.find((m) => m.id === ev.modelId);
      const cc = cap?.costClass ?? "unknown";
      return (
        <EventCard
          key={`${ev.seq}`}
          label={`Model call completed — ${ev.modelId}`}
          detail={`Tokens: ${formatTokens(ev.usage.promptTokens)} in / ${formatTokens(ev.usage.completionTokens)} out · ${formatMs(ev.usage.latencyMs)}`}
          meta={costClassLabel(cc)}
          variant="success"
        />
      );
    }
    case "model:call:failed":
      return (
        <EventCard
          key={`${ev.seq}`}
          label={`Model call failed — ${ev.modelId}`}
          detail={`${ev.errorCode}: ${ev.message}`}
          variant="error"
        />
      );
    case "tool:call:started":
      return (
        <EventCard
          key={`${ev.seq}`}
          label={`Tool: ${ev.toolName}`}
          detail={`ID: ${ev.toolCallId}`}
          variant="muted"
        />
      );
    case "tool:call:completed":
      return (
        <EventCard
          key={`${ev.seq}`}
          label={`Tool completed: ${ev.toolName}`}
          detail={formatMs(ev.durationMs)}
          variant="success"
        />
      );
    case "tool:call:failed":
      return (
        <EventCard
          key={`${ev.seq}`}
          label={`Tool failed: ${ev.toolName}`}
          detail={`${ev.errorCode}: ${ev.message}`}
          variant="error"
        />
      );
    case "reasoning:trace":
      return (
        <EventCard
          key={`${ev.seq}`}
          label={`Reasoning — ${ev.phase}`}
          detail={ev.rationale ?? "[redacted]"}
          variant="muted"
        />
      );
    case "patch:proposed":
      return (
        <EventCard
          key={`${ev.seq}`}
          label="Patch proposed"
          detail={`${ev.targetFile} · ${formatBytes(ev.patchBytes)}`}
          variant="success"
        />
      );
    case "verification:result":
      return (
        <EventCard
          key={`${ev.seq}`}
          label={`Verification: ${ev.passed ? "passed" : "failed"}`}
          detail={ev.detail}
          variant={ev.passed ? "success" : "error"}
        />
      );
    case "run:completed":
      return <EventCard key={`${ev.seq}`} label="Run completed" variant="success" />;
    case "run:cancelled":
      return (
        <EventCard
          key={`${ev.seq}`}
          label="Run cancelled"
          detail={`At state: ${ev.atState}${ev.reason !== undefined ? ` — ${ev.reason}` : ""}`}
          variant="muted"
        />
      );
    case "run:failed":
      return (
        <EventCard
          key={`${ev.seq}`}
          label="Run failed"
          detail={`${ev.failure.category}: ${ev.failure.message}`}
          variant="error"
        />
      );
    default:
      return null;
  }
}

function StatusBadge({ status }: { status: SseStatus }): ReactNode {
  const classes =
    status === "live"
      ? "bg-green-100 text-green-800"
      : status === "terminal"
        ? "bg-gray-100 text-gray-700"
        : status === "error"
          ? "bg-red-100 text-red-800"
          : "bg-yellow-100 text-yellow-800";
  const label =
    status === "live"
      ? "Live"
      : status === "terminal"
        ? "Completed"
        : status === "error"
          ? "Error"
          : "Connecting…";
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${classes}`} aria-live="polite">
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Run view inner (needs useSearchParams)
// ---------------------------------------------------------------------------

function RunViewInner(): ReactNode {
  const searchParams = useSearchParams();
  const runId = searchParams.get("id") ?? "";
  const router = useRouter();

  const [models, setModels] = useState<ModelCapability[]>([]);
  useEffect(() => {
    fetchModels()
      .then(({ models: m }) => { setModels(m); })
      .catch(() => { /* non-fatal */ });
  }, []);

  const { events, status, error } = useSSE(runId || null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [report, setReport] = useState<RunReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const liveRegionRef = useRef<HTMLDivElement | null>(null);
  const lastSeqRef = useRef(-1);

  useEffect(() => {
    const latest = events[events.length - 1];
    if (latest !== undefined && latest.seq > lastSeqRef.current) {
      lastSeqRef.current = latest.seq;
      if (liveRegionRef.current !== null) {
        liveRegionRef.current.textContent = `New event: ${latest.type}`;
      }
    }
  }, [events]);

  useEffect(() => {
    if (status !== "terminal" || runId === "") return;
    let active = true;
    fetchRunReport(runId)
      .then(({ report: r }) => { if (active) setReport(r); })
      .catch((err) => {
        if (!active) return;
        const msg = err instanceof ApiError ? err.message : "Failed to load run report";
        setReportError(msg);
      });
    return () => { active = false; };
  }, [status, runId]);

  const isTerminal = status === "terminal";

  if (runId === "") {
    return (
      <section aria-labelledby="run-heading">
        <h1 id="run-heading" className="text-heading text-ink">Run</h1>
        <p className="mt-4 text-sm text-ink-muted">No run ID specified.</p>
      </section>
    );
  }

  async function handleCancel(): Promise<void> {
    setCancelError(null);
    setCancelling(true);
    try {
      await cancelRun(runId);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Cancel failed";
      setCancelError(msg);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <section aria-labelledby="run-heading">
      <div role="status" aria-live="polite" aria-atomic="true" ref={liveRegionRef} className="sr-only" />

      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 id="run-heading" className="text-heading text-ink">Run</h1>
          <p className="mt-1 font-mono text-xs text-ink-muted">{runId}</p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={status} />
          <button
            type="button"
            onClick={() => { void handleCancel(); }}
            disabled={isTerminal || cancelling}
            aria-label="Cancel this run"
            className="rounded border border-red-300 bg-red-50 px-4 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      </div>

      {error !== null && (
        <p role="alert" className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      {cancelError !== null && (
        <p role="alert" className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{cancelError}</p>
      )}

      <section aria-labelledby="timeline-heading" className="mt-section">
        <h2 id="timeline-heading" className="text-subheading text-ink">Event timeline</h2>
        {events.length === 0 ? (
          <p className="mt-4 text-sm text-ink-muted" aria-busy={status === "connecting"}>
            {status === "connecting" ? "Connecting to event stream…" : "No events yet."}
          </p>
        ) : (
          <ol aria-label="Run events" className="mt-4 grid gap-2">
            {events.map((ev) => renderEvent(ev, models))}
          </ol>
        )}
      </section>

      {isTerminal && (
        <section aria-labelledby="report-heading" className="mt-section">
          <h2 id="report-heading" className="text-subheading text-ink">Run result</h2>
          {reportError !== null && (
            <p role="alert" className="mt-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{reportError}</p>
          )}
          {report !== null && (
            <div className="mt-4 rounded-lg border border-ink/10 p-6">
              <dl className="grid gap-2 text-sm">
                <div className="flex gap-2">
                  <dt className="w-28 font-medium text-ink-muted">Status</dt>
                  <dd>
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${outcomeClasses(report.status)}`}>
                      {outcomeLabel(report.status)}
                    </span>
                  </dd>
                </div>
                {report.modelId !== undefined && (
                  <div className="flex gap-2">
                    <dt className="w-28 font-medium text-ink-muted">Model</dt>
                    <dd>{report.modelId}</dd>
                  </div>
                )}
                {report.durationMs !== undefined && (
                  <div className="flex gap-2">
                    <dt className="w-28 font-medium text-ink-muted">Duration</dt>
                    <dd>{formatMs(report.durationMs)}</dd>
                  </div>
                )}
                {report.verificationSummary !== undefined && (
                  <div className="flex gap-2">
                    <dt className="w-28 font-medium text-ink-muted">Verification</dt>
                    <dd>
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${verificationStatusClasses(report.verificationSummary.overallStatus)}`}>
                        {verificationStatusLabel(report.verificationSummary.overallStatus)}
                      </span>
                    </dd>
                  </div>
                )}
              {report.verificationSummary !== undefined && report.verificationSummary.results.length > 0 && (
                <ResourceLimitDecisionsTable results={report.verificationSummary.results} />
              )}
              </dl>
              {report.proposedDiff !== undefined && (
                <div className="mt-6 rounded border border-accent/30 bg-blue-50 p-4">
                  <p className="text-sm font-medium text-ink">A patch has been proposed. Review and apply it below.</p>
                  <Link
                    href={`/run/patch?id=${encodeURIComponent(runId)}`}
                    className="mt-2 inline-block rounded bg-accent px-4 py-1.5 text-sm font-semibold text-ink-inverse hover:bg-accent-strong focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-2"
                  >
                    Review patch
                  </Link>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <div className="mt-8">
        <button
          type="button"
          onClick={() => { router.push("/launch"); }}
          className="text-sm text-ink-muted underline hover:text-ink focus:outline-none focus:ring-2 focus:ring-focus"
        >
          ← Back to Launch
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page export (wraps in Suspense for useSearchParams)
// ---------------------------------------------------------------------------

export default function RunPage(): ReactNode {
  return (
    <Suspense fallback={
      <section aria-labelledby="run-heading">
        <h1 id="run-heading" className="text-heading text-ink">Run</h1>
        <p className="mt-4 text-ink-muted" aria-busy="true">Loading…</p>
      </section>
    }>
      <RunViewInner />
    </Suspense>
  );
}
