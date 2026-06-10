"use client";

import { Fragment, useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import Link from "next/link";
import {
  cancelMemoryConsolidationJob,
  fetchMemoryConsolidationJob,
  startMemoryConsolidation,
  type MemoryConsolidationJobEnvelope,
  type MemoryConsolidationJob,
  type MemoryConsolidationReviewItem,
  type MemoryConsolidationStaleFlag,
  type StartMemoryConsolidationInput,
} from "@/lib/memory-api";
import { formatError } from "./format-error";

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_SETTINGS: StartMemoryConsolidationInput = {
  jaccardThreshold: 0.85,
  staleConfidenceThreshold: 0.3,
  maxAgeMs: 90 * DAY_MS,
  maxClustersPerRun: 100,
};

/* "1 review items" → "1 review item" (uiux-fix F034, C372) */
function plural(count: number, singular: string): string {
  return `${count.toString()} ${count === 1 ? singular : `${singular}s`}`;
}

function isTerminalState(state: MemoryConsolidationJob["state"]): boolean {
  return state === "completed" || state === "failed" || state === "canceled" || state === "skipped";
}

function formatDateTime(value?: number): string {
  if (value === undefined) return "—";
  return new Date(value).toLocaleString();
}

/* Sub-second runs read as raw counters ("250") — format human-readable
   (uiux-fix F034, C150) */
function formatElapsed(ms: number): string {
  return ms < 1_000 ? `${ms.toString()} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

/* Raw memory ids were plain text — link each id to the detail route so review
   decisions are actionable (uiux-fix F034, C240; pattern: .mc-row-detail-link) */
function MemoryIdLink({ id }: { readonly id: string }): ReactNode {
  return (
    <Link
      href={`/memoriaviva/detail?id=${encodeURIComponent(id)}`}
      className="mc-id-link"
      title={id}
    >
      {id}
    </Link>
  );
}

function MemoryIdList({ ids }: { readonly ids: readonly string[] }): ReactNode {
  return (
    <>
      {ids.map((id, index) => (
        <Fragment key={`${index.toString()}:${id}`}>
          {index > 0 ? ", " : null}
          <MemoryIdLink id={id} />
        </Fragment>
      ))}
    </>
  );
}

function ReviewAction({ item }: { readonly item: MemoryConsolidationReviewItem }): ReactNode {
  if (item.proposedAction === undefined) return <>No automatic action proposed.</>;
  if (item.proposedAction.kind === "merge") {
    return (
      <>
        Merge into <MemoryIdLink id={item.proposedAction.winner} />; replace{" "}
        <MemoryIdList ids={item.proposedAction.losers} />.
      </>
    );
  }
  return (
    <>
      Supersede <MemoryIdLink id={item.proposedAction.older} /> with{" "}
      <MemoryIdLink id={item.proposedAction.newer} />.
    </>
  );
}

function StaleFlagEntry({ flag }: { readonly flag: MemoryConsolidationStaleFlag }): ReactNode {
  return (
    <>
      <MemoryIdLink id={flag.memoryId} /> — {flag.reason}
    </>
  );
}

interface SettingsFieldProps {
  readonly label: string;
  readonly name: keyof StartMemoryConsolidationInput;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly help: string;
  readonly disabled?: boolean;
  readonly onChange: (name: keyof StartMemoryConsolidationInput, value: number) => void;
}

function SettingsField({
  label,
  name,
  value,
  min,
  max,
  step,
  help,
  disabled = false,
  onChange,
}: SettingsFieldProps): ReactNode {
  /* Help text lives OUTSIDE the <label> and is linked via aria-describedby so
     the accessible name stays the bare label (uiux-fix F034, C134). Labels use
     .mc-dialog-label (12px/600) instead of inheriting 16px (C241); inputs use
     the existing .mc-dialog-input instead of the undefined `lk-input` (C134). */
  const helpId = useId();
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <label style={{ display: "grid", gap: 6 }}>
        <span className="mc-dialog-label">{label}</span>
        <input
          type="number"
          inputMode="decimal"
          className="mc-dialog-input"
          name={name}
          value={Number.isFinite(value) ? value : ""}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-describedby={helpId}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            onChange(name, Number(event.target.value));
          }}
        />
      </label>
      <span id={helpId} style={{ color: "var(--fg-muted)", fontSize: 12 }}>
        {help}
      </span>
    </div>
  );
}

interface MemoryConsolidationProps {
  readonly startJobImpl?: typeof startMemoryConsolidation;
  readonly fetchJobImpl?: typeof fetchMemoryConsolidationJob;
  readonly cancelJobImpl?: typeof cancelMemoryConsolidationJob;
  readonly pollIntervalMs?: number;
}

export function MemoryConsolidation({
  startJobImpl = startMemoryConsolidation,
  fetchJobImpl = fetchMemoryConsolidationJob,
  cancelJobImpl = cancelMemoryConsolidationJob,
  pollIntervalMs = 2_000,
}: MemoryConsolidationProps): ReactNode {
  const [settings, setSettings] = useState<StartMemoryConsolidationInput>(DEFAULT_SETTINGS);
  const [jobRecord, setJobRecord] = useState<MemoryConsolidationJobEnvelope | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  const activeJob = jobRecord?.job ?? null;
  const canCancel = activeJob !== null && !isTerminalState(activeJob.state);
  const hasActiveRun = canCancel;

  const summary = useMemo(() => {
    if (activeJob === null) return null;
    const result = activeJob.result;
    return {
      reviewCount: result?.reviewItems.length ?? 0,
      staleCount: result?.staleFlags.length ?? 0,
      edgeCount: result?.edgesProposed.length ?? 0,
    };
  }, [activeJob]);

  const updateSetting = useCallback(
    (name: keyof StartMemoryConsolidationInput, value: number): void => {
      setSettings((prev) => ({ ...prev, [name]: value }));
    },
    [],
  );

  const refreshJob = useCallback(
    async (jobId: string): Promise<void> => {
      setRefreshing(true);
      try {
        const res = await fetchJobImpl(jobId);
        setJobRecord(res.job);
        setJobError(null);
      } catch (err) {
        setJobError(formatError(err));
      } finally {
        setRefreshing(false);
      }
    },
    [fetchJobImpl],
  );

  useEffect(() => {
    if (activeJob === null || isTerminalState(activeJob.state)) return;
    const intervalId = window.setInterval(() => {
      void refreshJob(activeJob.id);
    }, pollIntervalMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeJob, pollIntervalMs, refreshJob]);

  const handleStart = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      // Guard for aria-disabled submit (uiux-fix F005): native disabled would
      // throw keyboard focus to <body> while the action runs.
      if (submitting || hasActiveRun) return;
      setSubmitting(true);
      setFormError(null);
      setJobError(null);
      try {
        const res = await startJobImpl(settings);
        setJobRecord(res.job);
      } catch (err) {
        setFormError(formatError(err));
      } finally {
        setSubmitting(false);
      }
    },
    [settings, startJobImpl, submitting, hasActiveRun],
  );

  const handleCancel = useCallback(async (): Promise<void> => {
    if (activeJob === null || canceling) return;
    setCanceling(true);
    setJobError(null);
    try {
      const res = await cancelJobImpl(activeJob.id);
      setJobRecord(res.job);
    } catch (err) {
      setJobError(formatError(err));
    } finally {
      setCanceling(false);
    }
  }, [activeJob, cancelJobImpl, canceling]);

  return (
    <>
      <header className="lk-header">
        <div style={{ display: "grid", gap: 4 }}>
          <h1 className="lk-title">MemoriaViva Consolidation</h1>
          <p style={{ margin: 0, color: "var(--fg-muted)" }}>
            Start a bounded consolidation job, inspect its output, and cancel it while it is still
            queued or running.
          </p>
        </div>
        <Link href="/memoriaviva" className="lk-btn lk-btn-ghost lk-btn-lg">
          Back to MemoriaViva
        </Link>
      </header>

      {/* Scroll container (uiux-fix F005): html,body clip overflow globally —
          result cards below the fold were unreachable without it. */}
      <div className="mc-consolidation-scroll">
        <section
          aria-label="Consolidation settings"
          style={{
            display: "grid",
            gap: 16,
            padding: 16,
            border: "1px solid var(--line)",
            borderRadius: 14,
            background: "var(--card)",
          }}
        >
          <form onSubmit={handleStart} style={{ display: "grid", gap: 16 }}>
            <div
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              }}
            >
              <SettingsField
                label="Jaccard threshold"
                name="jaccardThreshold"
                value={settings.jaccardThreshold}
                min={0}
                max={1}
                step={0.01}
                disabled={submitting || hasActiveRun}
                help="Similarity floor for near-duplicate detection."
                onChange={updateSetting}
              />
              <SettingsField
                label="Stale confidence threshold"
                name="staleConfidenceThreshold"
                value={settings.staleConfidenceThreshold}
                min={0}
                max={1}
                step={0.01}
                disabled={submitting || hasActiveRun}
                help="Memories at or below this confidence are flagged stale."
                onChange={updateSetting}
              />
              {/* Days, not raw milliseconds — the ms arithmetic moved into the
                  onChange conversion (uiux-fix F034, C150) */}
              <SettingsField
                label="Max age (days)"
                name="maxAgeMs"
                value={settings.maxAgeMs / DAY_MS}
                min={0}
                step={1}
                disabled={submitting || hasActiveRun}
                help="Memories older than this are checked for staleness."
                onChange={(fieldName, fieldValue) => {
                  updateSetting(fieldName, fieldValue * DAY_MS);
                }}
              />
              <SettingsField
                label="Max clusters per run"
                name="maxClustersPerRun"
                value={settings.maxClustersPerRun}
                min={0}
                step={1}
                disabled={submitting || hasActiveRun}
                help="Hard bound on duplicate clusters inspected in one run."
                onChange={updateSetting}
              />
            </div>

            {formError !== null ? (
              <div role="alert" className="lk-alert">
                {formError}
              </div>
            ) : null}

            {/* aria-disabled + click/submit guards instead of native disabled:
                disabling the focused button throws keyboard focus to <body>
                (uiux-fix F005, PR #823 pattern). */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              <button
                type="submit"
                className="lk-btn lk-btn-primary"
                aria-disabled={submitting || hasActiveRun}
                aria-busy={submitting}
              >
                {submitting ? "Starting…" : "Start consolidation"}
              </button>
              <button
                type="button"
                className="lk-btn lk-btn-ghost"
                aria-disabled={activeJob === null || refreshing}
                aria-busy={refreshing}
                onClick={() => {
                  if (activeJob !== null && !refreshing) {
                    void refreshJob(activeJob.id);
                  }
                }}
              >
                {refreshing ? "Refreshing…" : "Refresh status"}
              </button>
              {canCancel ? (
                <button
                  type="button"
                  className="lk-btn lk-btn-ghost"
                  aria-disabled={canceling}
                  aria-busy={canceling}
                  onClick={() => {
                    void handleCancel();
                  }}
                >
                  {canceling ? "Canceling…" : "Cancel job"}
                </button>
              ) : null}
            </div>
          </form>
        </section>

        <section
          aria-label="Consolidation job status"
          aria-live="polite"
          style={{
            display: "grid",
            gap: 16,
            padding: 16,
            border: "1px solid var(--line)",
            borderRadius: 14,
            background: "var(--card)",
          }}
        >
          {activeJob === null ? (
            <p style={{ margin: 0, color: "var(--fg-muted)" }}>No consolidation job started yet.</p>
          ) : (
            <>
              <div
                style={{
                  display: "grid",
                  gap: 12,
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                }}
              >
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>State</div>
                  <div role="status" style={{ fontWeight: 700, textTransform: "capitalize" }}>
                    {activeJob.state}
                  </div>
                </div>
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>Job ID</div>
                  <div style={{ wordBreak: "break-all" }}>{activeJob.id}</div>
                </div>
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>Started</div>
                  <div>{formatDateTime(activeJob.startedAt)}</div>
                </div>
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>Completed</div>
                  <div>{formatDateTime(activeJob.completedAt)}</div>
                </div>
                {/* tabular-nums on the numeric stats — app pattern for number
                    surfaces (uiux-fix F034, C241); Elapsed human-readable (C150) */}
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>Clusters inspected</div>
                  <div style={{ fontVariantNumeric: "tabular-nums" }}>
                    {activeJob.result?.clustersInspected ?? 0}
                  </div>
                </div>
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>Elapsed</div>
                  <div style={{ fontVariantNumeric: "tabular-nums" }}>
                    {formatElapsed(activeJob.result?.elapsedMs ?? 0)}
                  </div>
                </div>
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>Memories loaded</div>
                  <div style={{ fontVariantNumeric: "tabular-nums" }}>
                    {jobRecord?.memoryCount ?? 0}
                  </div>
                </div>
              </div>

              {jobError !== null ? (
                <div role="alert" className="lk-alert">
                  {jobError}
                </div>
              ) : null}

              {activeJob.error !== undefined && activeJob.error.length > 0 ? (
                <div role="alert" className="lk-alert">
                  {activeJob.error}
                </div>
              ) : null}

              {summary !== null ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                  <span className="mc-badge mc-badge-default">
                    {plural(summary.reviewCount, "review item")}
                  </span>
                  <span className="mc-badge mc-badge-default">
                    {plural(summary.staleCount, "stale flag")}
                  </span>
                  <span className="mc-badge mc-badge-default">
                    {plural(summary.edgeCount, "proposed edge")}
                  </span>
                </div>
              ) : null}
            </>
          )}
        </section>

        {activeJob?.result !== undefined ? (
          <section
            aria-label="Consolidation results"
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            }}
          >
            <article
              style={{
                display: "grid",
                gap: 12,
                padding: 16,
                border: "1px solid var(--line)",
                borderRadius: 14,
                background: "var(--card)",
              }}
            >
              {/* lk-section-head: UA-default h2 (24px) outranked the 20px page
                  title (uiux-fix F034, C241) */}
              <h2 className="lk-section-head" style={{ margin: 0 }}>
                Review items
              </h2>
              {activeJob.result.reviewItems.length === 0 ? (
                <p style={{ margin: 0, color: "var(--fg-muted)" }}>No review items returned.</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12 }}>
                  {activeJob.result.reviewItems.map((item) => (
                    <li key={item.id} style={{ display: "grid", gap: 4 }}>
                      <strong style={{ textTransform: "capitalize" }}>
                        {item.reason.replaceAll("-", " ")}
                      </strong>
                      <span>
                        <MemoryIdList ids={item.relatedMemoryIds} />
                      </span>
                      <span style={{ color: "var(--fg-muted)" }}>
                        <ReviewAction item={item} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </article>

            <article
              style={{
                display: "grid",
                gap: 12,
                padding: 16,
                border: "1px solid var(--line)",
                borderRadius: 14,
                background: "var(--card)",
              }}
            >
              <h2 className="lk-section-head" style={{ margin: 0 }}>
                Stale flags
              </h2>
              {activeJob.result.staleFlags.length === 0 ? (
                <p style={{ margin: 0, color: "var(--fg-muted)" }}>No stale flags returned.</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12 }}>
                  {activeJob.result.staleFlags.map((flag) => (
                    <li key={`${flag.memoryId}:${flag.reason}`}>
                      <StaleFlagEntry flag={flag} />
                    </li>
                  ))}
                </ul>
              )}
            </article>

            <article
              style={{
                display: "grid",
                gap: 12,
                padding: 16,
                border: "1px solid var(--line)",
                borderRadius: 14,
                background: "var(--card)",
              }}
            >
              <h2 className="lk-section-head" style={{ margin: 0 }}>
                Proposed edges
              </h2>
              {activeJob.result.edgesProposed.length === 0 ? (
                <p style={{ margin: 0, color: "var(--fg-muted)" }}>No edges proposed.</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12 }}>
                  {activeJob.result.edgesProposed.map((edge) => (
                    <li key={edge.id} style={{ display: "grid", gap: 4 }}>
                      <strong>{edge.kind}</strong>
                      <span>
                        <MemoryIdLink id={edge.fromMemoryId} /> →{" "}
                        <MemoryIdLink id={edge.toMemoryId} />
                      </span>
                      {edge.provenanceSummary !== undefined ? (
                        <span style={{ color: "var(--fg-muted)" }}>{edge.provenanceSummary}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          </section>
        ) : null}
      </div>
    </>
  );
}
