"use client";

import { Fragment, useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode, WheelEvent } from "react";
import Link from "next/link";
import {
  cancelMemoryConsolidationJob,
  fetchMemoryConsolidationJob,
  startMemoryConsolidation,
  type MemoryConsolidationJobEnvelope,
  type MemoryConsolidationJob,
  type MemoryConsolidationResult,
  type MemoryConsolidationReviewItem,
  type MemoryConsolidationStaleFlag,
  type StartMemoryConsolidationInput,
} from "@/lib/memory-api";
import { NumberControlStepper } from "@/app/components/desktop/NumberControlStepper";
import { useI18n, type I18nTranslate } from "@/lib/i18n";
import { formatError } from "./format-error";

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_SETTINGS: StartMemoryConsolidationInput = {
  jaccardThreshold: 0.85,
  staleConfidenceThreshold: 0.3,
  maxAgeMs: 90 * DAY_MS,
  maxClustersPerRun: 100,
  maxRecordsPerRun: 1_000,
};

function countLabel(
  t: I18nTranslate,
  count: number,
  singularKey: Parameters<I18nTranslate>[0],
  pluralKey: Parameters<I18nTranslate>[0],
): string {
  return `${count.toString()} ${t(count === 1 ? singularKey : pluralKey)}`;
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
function MemoryIdLink({
  id,
  onOpenDetail,
}: {
  readonly id: string;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
}): ReactNode {
  if (onOpenDetail !== undefined) {
    return (
      <button
        type="button"
        className="mc-id-link mc-link-button"
        title={id}
        onClick={() => onOpenDetail(id)}
      >
        {id}
      </button>
    );
  }
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

function MemoryIdList({
  ids,
  onOpenDetail,
}: {
  readonly ids: readonly string[];
  readonly onOpenDetail?: ((id: string) => void) | undefined;
}): ReactNode {
  return (
    <>
      {ids.map((id, index) => (
        <Fragment key={`${index.toString()}:${id}`}>
          {index > 0 ? ", " : null}
          <MemoryIdLink id={id} onOpenDetail={onOpenDetail} />
        </Fragment>
      ))}
    </>
  );
}

function ReviewAction({
  item,
  onOpenDetail,
  t,
}: {
  readonly item: MemoryConsolidationReviewItem;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
  readonly t: I18nTranslate;
}): ReactNode {
  if (item.proposedAction === undefined) {
    return <>{t("memoria.consolidation.noAutomaticAction")}</>;
  }
  if (item.proposedAction.kind === "merge") {
    return (
      <>
        {t("memoria.consolidation.mergeInto")}{" "}
        <MemoryIdLink id={item.proposedAction.winner} onOpenDetail={onOpenDetail} />;{" "}
        {t("memoria.consolidation.replace")}{" "}
        <MemoryIdList ids={item.proposedAction.losers} onOpenDetail={onOpenDetail} />.
      </>
    );
  }
  return (
    <>
      {t("memoria.consolidation.supersede")}{" "}
      <MemoryIdLink id={item.proposedAction.older} onOpenDetail={onOpenDetail} />{" "}
      {t("memoria.consolidation.with")}{" "}
      <MemoryIdLink id={item.proposedAction.newer} onOpenDetail={onOpenDetail} />.
    </>
  );
}

function StaleFlagEntry({
  flag,
  onOpenDetail,
}: {
  readonly flag: MemoryConsolidationStaleFlag;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
}): ReactNode {
  return (
    <>
      <MemoryIdLink id={flag.memoryId} onOpenDetail={onOpenDetail} /> — {flag.reason}
    </>
  );
}

function SummaryStatusNotice({
  result,
  t,
}: {
  readonly result: MemoryConsolidationResult;
  readonly t: I18nTranslate;
}): ReactNode {
  if (result.summaryStatus.kind === "not-configured") {
    if (result.summaryStatus.updatesProposed > 0) {
      return (
        <p style={{ margin: 0, color: "var(--fg-muted)" }}>
          {t("memoria.consolidation.summary.notConfiguredWithUpdates", {
            count: countLabel(
              t,
              result.summaryStatus.updatesProposed,
              "memoria.consolidation.bodyUpdate.one",
              "memoria.consolidation.bodyUpdate.many",
            ),
          })}
        </p>
      );
    }
    return (
      <p style={{ margin: 0, color: "var(--fg-muted)" }}>
        {t("memoria.consolidation.summary.notConfiguredNone")}
      </p>
    );
  }
  if (result.summaryStatus.updatesProposed === 0) {
    return (
      <p style={{ margin: 0, color: "var(--fg-muted)" }}>
        {t("memoria.consolidation.summary.configuredNone")}
      </p>
    );
  }
  const suffix =
    result.summaryStatus.fallbacksUsed > 0
      ? t("memoria.consolidation.summary.fallbackSuffix", {
          count: countLabel(
            t,
            result.summaryStatus.fallbacksUsed,
            "memoria.consolidation.fallback.one",
            "memoria.consolidation.fallback.many",
          ),
        })
      : ".";
  return (
    <p style={{ margin: 0, color: "var(--fg-muted)" }}>
      {t("memoria.consolidation.summary.configuredWithUpdates", {
        count: countLabel(
          t,
          result.summaryStatus.updatesProposed,
          "memoria.consolidation.bodyUpdate.one",
          "memoria.consolidation.bodyUpdate.many",
        ),
        suffix,
      })}
    </p>
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

function decimalsForStep(step: number): number {
  const [, fraction = ""] = step.toString().split(".");
  return fraction.length;
}

function clamp(value: number, min: number | undefined, max: number | undefined): number {
  if (min !== undefined && value < min) return min;
  if (max !== undefined && value > max) return max;
  return value;
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
  const stepField = (direction: 1 | -1): void => {
    const stepValue = step ?? 1;
    const base = Number.isFinite(value) ? value : (min ?? 0);
    const precision = Math.min(decimalsForStep(stepValue) + 2, 8);
    const next = Number((base + direction * stepValue).toFixed(precision));
    onChange(name, clamp(next, min, max));
  };
  const handleWheel = (event: WheelEvent<HTMLInputElement>): void => {
    if (disabled || event.deltaY === 0) return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    stepField(direction);
  };
  return (
    <div style={{ display: "grid", gap: "var(--space-3)" }}>
      <label style={{ display: "grid", gap: "var(--space-3)" }}>
        <span className="mc-dialog-label">{label}</span>
        <span className="number-control">
          <input
            type="number"
            inputMode="decimal"
            className="mc-dialog-input number-control-input"
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
            onWheel={handleWheel}
          />
          <NumberControlStepper
            label={label.toLowerCase()}
            disabled={disabled}
            onStepUp={() => stepField(1)}
            onStepDown={() => stepField(-1)}
          />
        </span>
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
  readonly onBack?: (() => void) | undefined;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
}

export function MemoryConsolidation({
  startJobImpl = startMemoryConsolidation,
  fetchJobImpl = fetchMemoryConsolidationJob,
  cancelJobImpl = cancelMemoryConsolidationJob,
  pollIntervalMs = 2_000,
  onBack,
  onOpenDetail,
}: MemoryConsolidationProps): ReactNode {
  const { t } = useI18n();
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
      updateCount: result?.updatesProposed.length ?? 0,
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
      <header className="lk-header mc-consolidation-header">
        <div
          className="mc-consolidation-heading"
          style={{ display: "grid", gap: "var(--space-2)" }}
        >
          <h1 className="lk-title">{t("memoria.consolidation.title")}</h1>
          <p style={{ margin: 0, color: "var(--fg-muted)" }}>
            {t("memoria.consolidation.description")}
          </p>
        </div>
        {onBack !== undefined ? (
          <button
            type="button"
            className="lk-btn lk-btn-ghost lk-btn-lg"
            aria-label={t("memoria.backToMemoria")}
            onClick={onBack}
          >
            {t("memoria.back")}
          </button>
        ) : (
          <Link
            href="/memoriaviva"
            className="lk-btn lk-btn-ghost lk-btn-lg"
            aria-label={t("memoria.backToMemoria")}
          >
            {t("memoria.back")}
          </Link>
        )}
      </header>

      {/* Scroll container (uiux-fix F005): html,body clip overflow globally —
          result cards below the fold were unreachable without it. */}
      <div className="mc-consolidation-scroll">
        <section
          aria-label={t("memoria.consolidation.settings")}
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
                gap: "var(--space-5)",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              }}
            >
              <SettingsField
                label={t("memoria.consolidation.jaccardThreshold")}
                name="jaccardThreshold"
                value={settings.jaccardThreshold}
                min={0}
                max={1}
                step={0.01}
                disabled={submitting || hasActiveRun}
                help={t("memoria.consolidation.help.jaccard")}
                onChange={updateSetting}
              />
              <SettingsField
                label={t("memoria.consolidation.staleConfidenceThreshold")}
                name="staleConfidenceThreshold"
                value={settings.staleConfidenceThreshold}
                min={0}
                max={1}
                step={0.01}
                disabled={submitting || hasActiveRun}
                help={t("memoria.consolidation.help.staleConfidence")}
                onChange={updateSetting}
              />
              {/* Days, not raw milliseconds — the ms arithmetic moved into the
                  onChange conversion (uiux-fix F034, C150) */}
              <SettingsField
                label={t("memoria.consolidation.maxAgeDays")}
                name="maxAgeMs"
                value={settings.maxAgeMs / DAY_MS}
                min={0}
                step={1}
                disabled={submitting || hasActiveRun}
                help={t("memoria.consolidation.help.maxAge")}
                onChange={(fieldName, fieldValue) => {
                  updateSetting(fieldName, fieldValue * DAY_MS);
                }}
              />
              <SettingsField
                label={t("memoria.consolidation.maxClustersPerRun")}
                name="maxClustersPerRun"
                value={settings.maxClustersPerRun}
                min={0}
                max={1000}
                step={1}
                disabled={submitting || hasActiveRun}
                help={t("memoria.consolidation.help.maxClusters")}
                onChange={updateSetting}
              />
              <SettingsField
                label={t("memoria.consolidation.maxRecordsPerRun")}
                name="maxRecordsPerRun"
                value={settings.maxRecordsPerRun}
                min={0}
                max={1000}
                step={1}
                disabled={submitting || hasActiveRun}
                help={t("memoria.consolidation.help.maxRecords")}
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
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-5)" }}>
              <button
                type="submit"
                className="lk-btn lk-btn-primary"
                aria-disabled={submitting || hasActiveRun}
                aria-busy={submitting}
              >
                {submitting
                  ? t("memoria.consolidation.starting")
                  : t("memoria.consolidation.start")}
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
                {refreshing
                  ? t("memoria.consolidation.refreshing")
                  : t("memoria.consolidation.refreshStatus")}
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
                  {canceling
                    ? t("memoria.consolidation.canceling")
                    : t("memoria.consolidation.cancelJob")}
                </button>
              ) : null}
            </div>
          </form>
        </section>

        <section
          aria-label={t("memoria.consolidation.jobStatus")}
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
            <p style={{ margin: 0, color: "var(--fg-muted)" }}>
              {t("memoria.consolidation.noJob")}
            </p>
          ) : (
            <>
              <div
                style={{
                  display: "grid",
                  gap: "var(--space-5)",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                }}
              >
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>
                    {t("memoria.consolidation.state")}
                  </div>
                  <div
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                    style={{ fontWeight: 700, textTransform: "capitalize" }}
                  >
                    {activeJob.state}
                  </div>
                </div>
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>
                    {t("memoria.consolidation.jobId")}
                  </div>
                  <div style={{ wordBreak: "break-all" }}>{activeJob.id}</div>
                </div>
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>
                    {t("memoria.consolidation.started")}
                  </div>
                  <div>{formatDateTime(activeJob.startedAt)}</div>
                </div>
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>
                    {t("memoria.consolidation.completed")}
                  </div>
                  <div>{formatDateTime(activeJob.completedAt)}</div>
                </div>
                {/* tabular-nums on the numeric stats — app pattern for number
                    surfaces (uiux-fix F034, C241); Elapsed human-readable (C150) */}
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>
                    {t("memoria.consolidation.clustersInspected")}
                  </div>
                  <div style={{ fontVariantNumeric: "tabular-nums" }}>
                    {activeJob.result?.clustersInspected ?? 0}
                  </div>
                </div>
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>
                    {t("memoria.consolidation.elapsed")}
                  </div>
                  <div style={{ fontVariantNumeric: "tabular-nums" }}>
                    {formatElapsed(activeJob.result?.elapsedMs ?? 0)}
                  </div>
                </div>
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>
                    {t("memoria.consolidation.recordsInspected")}
                  </div>
                  <div style={{ fontVariantNumeric: "tabular-nums" }}>
                    {activeJob.result?.recordsInspected ?? 0}
                    {activeJob.result?.truncated === true
                      ? t("memoria.consolidation.truncated")
                      : ""}
                  </div>
                </div>
                <div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>
                    {t("memoria.consolidation.memoriesLoaded")}
                  </div>
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
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-5)" }}>
                  <span className="mc-badge mc-badge-default">
                    {countLabel(
                      t,
                      summary.reviewCount,
                      "memoria.consolidation.reviewItem.one",
                      "memoria.consolidation.reviewItem.many",
                    )}
                  </span>
                  <span className="mc-badge mc-badge-default">
                    {countLabel(
                      t,
                      summary.staleCount,
                      "memoria.consolidation.staleFlag.one",
                      "memoria.consolidation.staleFlag.many",
                    )}
                  </span>
                  <span className="mc-badge mc-badge-default">
                    {countLabel(
                      t,
                      summary.edgeCount,
                      "memoria.consolidation.proposedEdge.one",
                      "memoria.consolidation.proposedEdge.many",
                    )}
                  </span>
                  <span className="mc-badge mc-badge-default">
                    {countLabel(
                      t,
                      summary.updateCount,
                      "memoria.consolidation.bodyUpdate.one",
                      "memoria.consolidation.bodyUpdate.many",
                    )}
                  </span>
                </div>
              ) : null}
              {activeJob.result !== undefined ? (
                <SummaryStatusNotice result={activeJob.result} t={t} />
              ) : null}
            </>
          )}
        </section>

        {activeJob?.result !== undefined ? (
          <section
            aria-label={t("memoria.consolidation.results")}
            aria-live="polite"
            aria-atomic="false"
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            }}
          >
            <article
              style={{
                display: "grid",
                gap: "var(--space-5)",
                padding: 16,
                border: "1px solid var(--line)",
                borderRadius: 14,
                background: "var(--card)",
              }}
            >
              {/* lk-section-head: UA-default h2 (24px) outranked the 20px page
                  title (uiux-fix F034, C241) */}
              <h2 className="lk-section-head" style={{ margin: 0 }}>
                {t("memoria.consolidation.reviewItems")}
              </h2>
              {activeJob.result.reviewItems.length === 0 ? (
                <p style={{ margin: 0, color: "var(--fg-muted)" }}>
                  {t("memoria.consolidation.noReviewItems")}
                </p>
              ) : (
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: 0,
                    display: "grid",
                    gap: "var(--space-5)",
                  }}
                >
                  {activeJob.result.reviewItems.map((item) => (
                    <li key={item.id} style={{ display: "grid", gap: "var(--space-2)" }}>
                      <strong style={{ textTransform: "capitalize" }}>
                        {item.reason.replaceAll("-", " ")}
                      </strong>
                      <span>
                        <MemoryIdList ids={item.relatedMemoryIds} onOpenDetail={onOpenDetail} />
                      </span>
                      <span style={{ color: "var(--fg-muted)" }}>
                        <ReviewAction item={item} onOpenDetail={onOpenDetail} t={t} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </article>

            <article
              style={{
                display: "grid",
                gap: "var(--space-5)",
                padding: 16,
                border: "1px solid var(--line)",
                borderRadius: 14,
                background: "var(--card)",
              }}
            >
              <h2 className="lk-section-head" style={{ margin: 0 }}>
                {t("memoria.consolidation.staleFlags")}
              </h2>
              {activeJob.result.staleFlags.length === 0 ? (
                <p style={{ margin: 0, color: "var(--fg-muted)" }}>
                  {t("memoria.consolidation.noStaleFlags")}
                </p>
              ) : (
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: 0,
                    display: "grid",
                    gap: "var(--space-5)",
                  }}
                >
                  {activeJob.result.staleFlags.map((flag) => (
                    <li key={`${flag.memoryId}:${flag.reason}`}>
                      <StaleFlagEntry flag={flag} onOpenDetail={onOpenDetail} />
                    </li>
                  ))}
                </ul>
              )}
            </article>

            <article
              style={{
                display: "grid",
                gap: "var(--space-5)",
                padding: 16,
                border: "1px solid var(--line)",
                borderRadius: 14,
                background: "var(--card)",
              }}
            >
              <h2 className="lk-section-head" style={{ margin: 0 }}>
                {t("memoria.consolidation.proposedEdges")}
              </h2>
              {activeJob.result.edgesProposed.length === 0 ? (
                <p style={{ margin: 0, color: "var(--fg-muted)" }}>
                  {t("memoria.consolidation.noEdges")}
                </p>
              ) : (
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: 0,
                    display: "grid",
                    gap: "var(--space-5)",
                  }}
                >
                  {activeJob.result.edgesProposed.map((edge) => (
                    <li key={edge.id} style={{ display: "grid", gap: "var(--space-2)" }}>
                      <strong>{edge.kind}</strong>
                      <span>
                        <MemoryIdLink id={edge.fromMemoryId} onOpenDetail={onOpenDetail} /> →{" "}
                        <MemoryIdLink id={edge.toMemoryId} onOpenDetail={onOpenDetail} />
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
