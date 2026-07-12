"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ApiError,
  applyRun,
  cancelRun,
  fetchEvidenceManifest,
  fetchModels,
  fetchRunReport,
} from "../../../../../lib/api";
import {
  costClassLabel,
  formatBytes,
  formatMs,
  formatTokens,
  outcomeLabel,
  runStatusLabel,
} from "../../../../../lib/format";
import { useTranslate, type I18nTranslate } from "../../../../../lib/i18n";
import { useSSE } from "../../../../../lib/useSSE";
import type {
  AgentWorkflowId,
  CostClass,
  EvidenceManifest,
  HarnessEvent,
  RunReport,
} from "../../../../../lib/types";
import { Icons } from "../../Icons";

interface AgentRunCfg {
  workflow?: string;
  model?: string;
  runId?: string;
  fingerprint?: string;
  workspaceRoot?: string;
  inputJson?: string;
  keikoMode?: boolean;
  access?: "ask" | "full";
}

interface AgentRunWidgetProps {
  cfg?: AgentRunCfg;
  linkedRoot?: string | null;
  linkedFilePath: string | undefined;
}

interface UsageTotals {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
  readonly requestCount: number;
}

const TERMINAL_REPORT_STATUSES = new Set<RunReport["status"]>([
  "completed",
  "dry-run",
  "rejected",
  "cancelled",
  "failed",
  "fix-applied",
  "fix-proposed",
  "investigation-only",
]);

function workflowLabel(workflow: AgentWorkflowId, t: I18nTranslate): string {
  switch (workflow) {
    case "verify":
      return t("agentRunWidget.workflow.verify");
    case "explain-plan":
      return t("agentRunWidget.workflow.explainPlan");
    case "unit-test-generation":
      return t("agentRunWidget.workflow.unitTestGeneration");
    case "bug-investigation":
      return t("agentRunWidget.workflow.bugInvestigation");
  }
}

function normalizeWorkflow(value: string | undefined): AgentWorkflowId | null {
  if (
    value === "verify" ||
    value === "explain-plan" ||
    value === "unit-test-generation" ||
    value === "bug-investigation"
  ) {
    return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUsage(event: HarnessEvent): UsageTotals | null {
  if (event.type === "model:call:completed") {
    return {
      promptTokens: event.usage.promptTokens,
      completionTokens: event.usage.completionTokens,
      latencyMs: event.usage.latencyMs,
      requestCount: 1,
    };
  }
  const record = event as unknown as Record<string, unknown>;
  const promptTokens = record.promptTokens;
  const completionTokens = record.completionTokens;
  const latencyMs = record.latencyMs;
  if (
    typeof promptTokens === "number" &&
    typeof completionTokens === "number" &&
    typeof latencyMs === "number"
  ) {
    return { promptTokens, completionTokens, latencyMs, requestCount: 1 };
  }
  return null;
}

function aggregateUsage(events: readonly HarnessEvent[], report: RunReport | null): UsageTotals {
  let promptTokens = report?.usage?.promptTokens ?? 0;
  let completionTokens = report?.usage?.completionTokens ?? 0;
  let latencyMs = report?.usage?.latencyMs ?? 0;
  let requestCount = report?.usage === undefined ? 0 : 1;
  if (requestCount > 0) {
    return { promptTokens, completionTokens, latencyMs, requestCount };
  }
  for (const event of events) {
    const usage = readUsage(event);
    if (usage === null) continue;
    promptTokens += usage.promptTokens;
    completionTokens += usage.completionTokens;
    latencyMs += usage.latencyMs;
    requestCount += usage.requestCount;
  }
  return { promptTokens, completionTokens, latencyMs, requestCount };
}

function eventLabel(event: HarnessEvent, t: I18nTranslate): string {
  switch (event.type) {
    case "ready":
      return t("agentRunWidget.event.ready");
    case "run:started":
      return t("agentRunWidget.event.runStarted", { taskType: event.taskType });
    case "run:completed":
      return t("agentRunWidget.event.runCompleted");
    case "run:failed":
      return t("agentRunWidget.event.runFailed", { message: event.failure.message });
    case "run:cancelled":
      return t("agentRunWidget.event.runCancelled");
    case "state:transition": {
      const from = event.from;
      const to = event.to;
      return event.reason === undefined
        ? t("agentRunWidget.event.stateTransition", { from, to })
        : t("agentRunWidget.event.stateTransitionReason", { from, to, reason: event.reason });
    }
    case "model:call:started":
      return t("agentRunWidget.event.modelCallStarted", {
        bytes: formatBytes(event.contextBytes),
      });
    case "model:call:completed":
      return t("agentRunWidget.event.modelCallCompleted", {
        tokens: formatTokens(event.usage.promptTokens + event.usage.completionTokens),
      });
    case "model:call:failed":
      return t("agentRunWidget.event.modelCallFailed", { message: event.message });
    case "patch:proposed":
      return t("agentRunWidget.event.patchProposed", { bytes: formatBytes(event.patchBytes) });
    case "verification:result":
      return event.passed
        ? t("agentRunWidget.event.verificationPassed", { detail: event.detail })
        : t("agentRunWidget.event.verificationFailed", { detail: event.detail });
    case "workflow:started":
      return t("agentRunWidget.event.unitTestWorkflowStarted");
    case "workflow:model:call:completed":
      return t("agentRunWidget.event.unitTestModelCallCompleted", {
        tokens: formatTokens(event.promptTokens + event.completionTokens),
      });
    case "workflow:verification:result":
      return t("agentRunWidget.event.unitTestVerificationResult", {
        status: event.overallStatus,
      });
    case "workflow:completed":
      return t("agentRunWidget.event.unitTestWorkflowCompleted", { status: event.status });
    case "workflow:failed":
      return t("agentRunWidget.event.unitTestWorkflowFailed", { message: event.message });
    case "bug:started":
      return t("agentRunWidget.event.bugInvestigationStarted");
    case "bug:model:call:completed":
      return t("agentRunWidget.event.bugModelCallCompleted", {
        tokens: formatTokens(event.promptTokens + event.completionTokens),
      });
    case "bug:rootcause:proposed":
      return event.hasPatch
        ? t("agentRunWidget.event.bugRootCauseProposedWithPatch")
        : t("agentRunWidget.event.bugRootCauseProposed");
    case "bug:verification:result":
      return t("agentRunWidget.event.bugVerificationResult", { status: event.overallStatus });
    case "bug:completed":
      return t("agentRunWidget.event.bugInvestigationCompleted", { status: event.status });
    case "bug:failed":
      return t("agentRunWidget.event.bugInvestigationFailed", { message: event.message });
    default:
      return event.type;
  }
}

function eventTime(event: HarnessEvent): string {
  const ts = typeof event.ts === "number" ? event.ts : Date.parse(event.ts);
  if (!Number.isFinite(ts)) return "";
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function reportStatus(report: RunReport | null, evidence: EvidenceManifest | null): string {
  if (report !== null) return report.status;
  if (evidence !== null) return evidence.run.outcome;
  return "loading";
}

// uiux-fix F018 C259: human-readable status for the header — ReviewWidget already
// maps the same RunStatus values via the shared runStatusLabel presenter; raw
// kebab-case enums ("dry-run", "fix-proposed") and the "loading" placeholder
// must not surface verbatim.
function reportStatusLabel(
  report: RunReport | null,
  evidence: EvidenceManifest | null,
  t: I18nTranslate,
): string {
  if (report !== null) return runStatusLabel(report.status);
  if (evidence !== null) return outcomeLabel(evidence.run.outcome);
  return t("agentRunWidget.status.loading");
}

// uiux-fix F018 C258: count files in a unified diff so Apply can state its blast
// radius before writing to the working tree.
function diffFileCount(diff: string | undefined): number {
  if (diff === undefined || diff.length === 0) return 0;
  const headers = diff.match(/^diff --git /gm);
  if (headers !== null) return headers.length;
  const plusFiles = diff.match(/^\+\+\+ /gm);
  return plusFiles === null ? 0 : plusFiles.length;
}

function shortSummary(
  workflow: AgentWorkflowId | null,
  report: RunReport | null,
  evidence: EvidenceManifest | null,
  t: I18nTranslate,
): string {
  if (report === null && evidence === null) return t("agentRunWidget.summary.loading");
  const label =
    workflow === null ? t("agentRunWidget.workflow.fallback") : workflowLabel(workflow, t);
  if (report?.status === "running") return t("agentRunWidget.summary.running", { label });
  if (report?.status === "dry-run") return t("agentRunWidget.summary.dryRun", { label });
  if (report?.status === "fix-proposed") return t("agentRunWidget.summary.fixProposed", { label });
  if (report?.status === "fix-applied") return t("agentRunWidget.summary.fixApplied", { label });
  if (report?.status === "investigation-only")
    return t("agentRunWidget.summary.investigationOnly", { label });
  if (report?.status === "failed" || report?.status === "rejected")
    return t("agentRunWidget.summary.failed", { label });
  if (report?.status === "cancelled") return t("agentRunWidget.summary.cancelled", { label });
  if (report !== null) return t("agentRunWidget.summary.completed", { label });
  if (evidence?.patch?.redactedDiff !== undefined) {
    return t("agentRunWidget.summary.evidenceWithDiff", { label });
  }
  const outcome = evidence?.run.outcome ?? t("agentRunWidget.summary.unknownOutcome");
  return t("agentRunWidget.summary.evidenceOutcome", { label, outcome });
}

function parseInput(inputJson: string | undefined): Record<string, unknown> | null {
  if (inputJson === undefined || inputJson.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(inputJson);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function canApply(workflow: AgentWorkflowId | null, report: RunReport | null): boolean {
  if (report === null || report.proposedDiff === undefined || report.appliedAt !== undefined)
    return false;
  return (
    (workflow === "unit-test-generation" && report.status === "dry-run") ||
    (workflow === "bug-investigation" && report.status === "fix-proposed")
  );
}

function renderVerification(report: RunReport, t: I18nTranslate): ReactNode {
  const summary = report.verificationSummary;
  if (summary === undefined) return null;
  return (
    <div className="arun-result-card">
      <div className="arun-result-title">{t("agentRunWidget.verification.title")}</div>
      <div className="arun-kv">
        <span>{t("agentRunWidget.field.status")}</span>
        <strong>{summary.overallStatus}</strong>
      </div>
      <div className="arun-kv">
        <span>{t("agentRunWidget.field.duration")}</span>
        <strong>{formatMs(summary.durationMs)}</strong>
      </div>
      {summary.results.slice(0, 5).map((result) => (
        <div className="arun-check-row" key={`${result.kind}:${result.command}`}>
          <span>{result.kind}</span>
          <span className="mono">{result.status}</span>
        </div>
      ))}
    </div>
  );
}

function renderExplainReport(report: RunReport, t: I18nTranslate): ReactNode {
  if (report.report === undefined) return null;
  const title = t("agentRunWidget.result.report");
  return (
    <div className="arun-result-card">
      <div className="arun-result-title">{title}</div>
      {/* GEN-UI-KEYBOARD-005 — overflow:auto scroll container (max-height 220px) exposed
          as a focusable named region so keyboard-only users can scroll it (WCAG 2.1.1). */}
      <pre
        role="region"
        aria-label={title}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 focusable scroll region
        tabIndex={0}
      >
        {report.report}
      </pre>
    </div>
  );
}

function renderVerifyReport(report: RunReport, t: I18nTranslate): ReactNode {
  if (report.overallStatus === undefined || report.results === undefined) return null;
  return (
    <div className="arun-result-card">
      <div className="arun-result-title">{t("agentRunWidget.verification.title")}</div>
      <div className="arun-kv">
        <span>{t("agentRunWidget.field.status")}</span>
        <strong>{report.overallStatus}</strong>
      </div>
      {report.results.slice(0, 8).map((result) => (
        <div className="arun-check-row" key={`${result.kind}:${result.command}`}>
          <span>{result.kind}</span>
          <span className="mono">{result.status}</span>
        </div>
      ))}
    </div>
  );
}

function renderTextCard(title: string, value: string | undefined): ReactNode {
  if (value === undefined || value.length === 0) return null;
  return (
    <div className="arun-result-card">
      <div className="arun-result-title">{title}</div>
      {/* GEN-UI-KEYBOARD-005 — overflow:auto scroll container exposed as a focusable
          named region so keyboard-only users can scroll it (WCAG 2.1.1). */}
      <pre
        role="region"
        aria-label={title}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 focusable scroll region
        tabIndex={0}
      >
        {value}
      </pre>
    </div>
  );
}

function renderListCard(title: string, values: readonly string[] | undefined): ReactNode {
  if (values === undefined || values.length === 0) return null;
  return (
    <div className="arun-result-card">
      <div className="arun-result-title">{title}</div>
      {values.map((value) => (
        <div className="arun-check-row" key={value}>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}

// Issue #1296 — a low/medium/high agent confidence renders as the Design System
// 0.4.0 confidence signal: a 3-segment track PLUS an uppercase word, never colour
// alone. The track is decorative (aria-hidden); the word carries the meaning, so a
// screen reader hears "Confidence High" / "Confidence Low — verify".
type ConfidenceLevel = "low" | "medium" | "high";
function confidenceLabel(level: ConfidenceLevel, t: I18nTranslate): string {
  switch (level) {
    case "high":
      return t("agentRunWidget.confidence.high");
    case "medium":
      return t("agentRunWidget.confidence.medium");
    case "low":
      return t("agentRunWidget.confidence.low");
  }
}
function isConfidenceLevel(value: string): value is ConfidenceLevel {
  return value === "low" || value === "medium" || value === "high";
}
function ConfidenceSignal({ level }: { readonly level: ConfidenceLevel }): ReactNode {
  const t = useTranslate();
  return (
    <div className="arun-kv">
      <span>{t("agentRunWidget.field.confidence")}</span>
      <span className="ai-conf" data-level={level}>
        <span className="track" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="lbl">{confidenceLabel(level, t)}</span>
      </span>
    </div>
  );
}

function applyButtonLabel({
  applying,
  confirmApply,
  fileCount,
  t,
}: {
  readonly applying: boolean;
  readonly confirmApply: boolean;
  readonly fileCount: number;
  readonly t: I18nTranslate;
}): string {
  if (applying) return t("agentRunWidget.apply.applying");
  if (!confirmApply) return t("agentRunWidget.apply.apply");
  return t(
    fileCount === 1 ? "agentRunWidget.apply.confirmSingular" : "agentRunWidget.apply.confirmPlural",
    { count: fileCount },
  );
}

function renderHypothesis(report: RunReport, t: I18nTranslate): ReactNode {
  const hypothesis = report.hypothesis;
  if (hypothesis === undefined) return null;
  const rows = [
    [t("agentRunWidget.hypothesis.rootCause"), hypothesis.rootCause],
    [t("agentRunWidget.hypothesis.regressionTest"), hypothesis.regressionTestStrategy],
    [t("agentRunWidget.hypothesis.uncertainty"), hypothesis.uncertainty],
  ].filter((row): row is [string, string] => typeof row[1] === "string" && row[1].length > 0);
  // A level (low/medium/high) upgrades to the DS confidence signal; any other
  // non-empty confidence string keeps the plain key/value row (behaviour-preserving).
  const confidence = typeof hypothesis.confidence === "string" ? hypothesis.confidence : "";
  const confidenceLevel = isConfidenceLevel(confidence) ? confidence : undefined;
  const confidenceFallback =
    confidence.length > 0 && confidenceLevel === undefined ? confidence : undefined;
  if (rows.length === 0 && confidenceLevel === undefined && confidenceFallback === undefined) {
    return null;
  }
  return (
    <div className="arun-result-card">
      <div className="arun-result-title">{t("agentRunWidget.hypothesis.title")}</div>
      {rows.map(([label, value]) => (
        <div className="arun-kv" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
      {confidenceFallback !== undefined ? (
        <div className="arun-kv">
          <span>{t("agentRunWidget.field.confidence")}</span>
          <strong>{confidenceFallback}</strong>
        </div>
      ) : null}
      {confidenceLevel !== undefined ? <ConfidenceSignal level={confidenceLevel} /> : null}
    </div>
  );
}

export function AgentRunWidget({
  cfg = {},
  linkedRoot = null,
  linkedFilePath,
}: AgentRunWidgetProps): ReactNode {
  const t = useTranslate();
  const runId = cfg.runId ?? null;
  const workflow = normalizeWorkflow(cfg.workflow);
  const modelId = cfg.model ?? "";
  const input = parseInput(cfg.inputJson);
  const sse = useSSE(runId);
  const [report, setReport] = useState<RunReport | null>(null);
  const [evidence, setEvidence] = useState<EvidenceManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [costClass, setCostClass] = useState<CostClass | null>(null);
  // uiux-fix F018 C258: Apply writes to the working tree — require an explicit
  // second click ("Confirm apply (N files)") that times out back to "Apply".
  const [confirmApply, setConfirmApply] = useState(false);
  const confirmTimerRef = useRef<number | null>(null);
  const evidenceLinkRef = useRef<HTMLAnchorElement | null>(null);

  const loadReport = useCallback(async (): Promise<void> => {
    if (runId === null) return;
    setError(null);
    try {
      const response = await fetchRunReport(runId);
      setReport(response.report);
      setEvidence(null);
    } catch (loadError: unknown) {
      if (loadError instanceof ApiError && loadError.status === 404) {
        try {
          const response = await fetchEvidenceManifest(runId);
          setEvidence(response.manifest);
          setReport(null);
        } catch (evidenceError: unknown) {
          setError(
            evidenceError instanceof Error
              ? evidenceError.message
              : t("agentRunWidget.error.loadEvidence"),
          );
        }
        return;
      }
      setError(
        loadError instanceof Error ? loadError.message : t("agentRunWidget.error.loadReport"),
      );
    }
  }, [runId, t]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  useEffect(() => {
    if (sse.status === "terminal") void loadReport();
  }, [loadReport, sse.status]);

  useEffect(() => {
    let cancelled = false;
    if (modelId.length === 0) return;
    void fetchModels()
      .then((payload) => {
        if (cancelled) return;
        setCostClass(payload.models.find((model) => model.id === modelId)?.costClass ?? null);
      })
      .catch(() => {
        if (!cancelled) setCostClass(null);
      });
    return () => {
      cancelled = true;
    };
  }, [modelId]);

  const usage = useMemo(() => aggregateUsage(sse.events, report), [sse.events, report]);
  // GEN-PERF-WIDGET-005 — the newest-first 50-row log view copies/reverses the (≤500
  // entry) buffer; inline in JSX it re-ran on every unrelated widget render. Memoized on
  // the buffer identity it runs once per event batch.
  const visibleLogEvents = useMemo(() => sse.events.slice().reverse().slice(0, 50), [sse.events]);
  const elapsedMs =
    report?.durationMs ??
    evidence?.run.durationMs ??
    (sse.events.length > 0
      ? Math.max(0, Date.now() - Number(new Date(sse.events[0]?.ts ?? Date.now())))
      : 0);
  const status = reportStatus(report, evidence);
  const statusLabel = reportStatusLabel(report, evidence, t);
  const terminal = report !== null && TERMINAL_REPORT_STATUSES.has(report.status);
  const showApply = canApply(workflow, report);
  const showCancel = !terminal && report?.status === "running";
  const applyFileCount = diffFileCount(report?.proposedDiff);
  const runBusy =
    applying ||
    sse.status === "connecting" ||
    report?.status === "running" ||
    (report === null && evidence === null && error === null);

  // uiux-fix F018 C124: the Cancel button unmounts the moment the run turns
  // terminal; if it held keyboard focus the browser silently drops focus to
  // <body>. Restore it to the always-rendered Evidence control instead.
  const prevShowCancelRef = useRef(false);
  useEffect(() => {
    if (prevShowCancelRef.current && !showCancel && document.activeElement === document.body) {
      evidenceLinkRef.current?.focus();
    }
    prevShowCancelRef.current = showCancel;
  }, [showCancel]);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const doCancel = async (): Promise<void> => {
    if (runId === null) return;
    setError(null);
    try {
      await cancelRun(runId);
      await loadReport();
    } catch (cancelError: unknown) {
      setError(
        cancelError instanceof Error ? cancelError.message : t("agentRunWidget.error.cancelRun"),
      );
    }
  };

  const doApply = async (): Promise<void> => {
    if (runId === null || !showApply || applying) return;
    setApplying(true);
    setApplyError(null);
    try {
      const response = await applyRun(runId);
      setReport(response.report);
    } catch (applyRunError: unknown) {
      setApplyError(
        applyRunError instanceof Error ? applyRunError.message : t("agentRunWidget.error.applyRun"),
      );
    } finally {
      setApplying(false);
    }
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
    void doApply();
  };

  if (runId === null || workflow === null) {
    return (
      <div className="arun arun-empty">
        <div className="arun-result-title">{t("agentRunWidget.empty.title")}</div>
        <p>{t("agentRunWidget.empty.body")}</p>
      </div>
    );
  }

  return (
    <div className="arun arun-real" aria-busy={runBusy ? "true" : undefined}>
      <div className="arun-head">
        <span className="arun-role">{workflowLabel(workflow, t)}</span>
        {/* uiux-fix F054 C385: cfg.model is optional — skip the pill entirely so no
            empty bordered artefact renders between the workflow label and status. */}
        {modelId.length > 0 ? <span className="ag-model mono">{modelId}</span> : null}
        {/* uiux-fix F054 C382: human-readable cost class ("Low cost") instead of the
            raw enum, plus a title explaining what the pill refers to. */}
        {costClass !== null ? (
          <span className="arun-gov" title={t("agentRunWidget.costClassTitle")}>
            {costClassLabel(costClass)}
          </span>
        ) : null}
        <span className="spacer" />
        <span className="arun-status">
          {/* uiux-fix F018 C265: data-status feeds the idle/terminal dot colours in
              globals.css — the bare .dot class paints no background at all. */}
          <span className="dot" data-live={report?.status === "running"} data-status={status} />
          {statusLabel}
        </span>
      </div>

      {/* uiux-fix F018 C109: announce run completion (shortSummary changes) to AT.
          title carries the full run id, which is otherwise unobtainable (C110). */}
      <div className="arun-summary" role="status" aria-live="polite">
        <strong>{shortSummary(workflow, report, evidence, t)}</strong>
        <span className="mono" title={runId}>
          {t("agentRunWidget.runIdLabel", { id: runId.slice(0, 8) })}
        </span>
      </div>

      <div className="arun-meters">
        <div className="arun-meter">
          <span className="arun-mk">{t("agentRunWidget.meter.elapsed")}</span>
          <span className="arun-mv mono">{formatMs(elapsedMs)}</span>
        </div>
        <div className="arun-meter">
          <span className="arun-mk">{t("agentRunWidget.meter.usage")}</span>
          <span className="arun-mv mono">
            {usage.requestCount === 0
              ? t("agentRunWidget.meter.noUsage")
              : t("agentRunWidget.meter.tokens", {
                  tokens: formatTokens(usage.promptTokens + usage.completionTokens),
                })}
          </span>
        </div>
        <div className="arun-meter">
          <span className="arun-mk">{t("agentRunWidget.meter.latency")}</span>
          <span className="arun-mv mono">
            {usage.requestCount === 0 ? "—" : formatMs(usage.latencyMs)}
          </span>
        </div>
      </div>

      {/* uiux-fix F018 C266: absolute paths are single unbreakable words — wrap them in a
          truncating span and expose the full path via title so the end stays reachable. */}
      <div className="arun-perms">
        <span
          className="arun-perm"
          data-on={linkedRoot !== null}
          title={linkedRoot ?? cfg.workspaceRoot ?? undefined}
        >
          <Icons.files size={11} />
          <span className="arun-perm-path">
            {linkedRoot !== null
              ? linkedRoot
              : (cfg.workspaceRoot ?? t("agentRunWidget.perm.noWorkspace"))}
          </span>
        </span>
        {linkedFilePath !== undefined ? (
          <span className="arun-perm" data-on={true} title={linkedFilePath}>
            <Icons.files size={11} />
            <span className="arun-perm-path">{linkedFilePath}</span>
          </span>
        ) : null}
      </div>

      {input !== null ? (
        <details className="arun-input">
          <summary>{t("agentRunWidget.runInput.summary")}</summary>
          {/* GEN-UI-KEYBOARD-005 — overflow:auto scroll container exposed as a focusable
              named region so keyboard-only users can scroll it (WCAG 2.1.1). */}
          <pre
            role="region"
            aria-label={t("agentRunWidget.runInput.summary")}
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 focusable scroll region
            tabIndex={0}
          >
            {JSON.stringify(input, null, 2)}
          </pre>
        </details>
      ) : null}

      {/* uiux-fix F018 C109: role=log announces appended entries (TerminalWidget
          pattern). The C026 disconnect row below lives inside this live region, so
          it needs no role of its own. */}
      <div
        className="arun-log"
        role="log"
        aria-live="polite"
        aria-label={t("agentRunWidget.log.ariaLabel")}
        aria-busy={runBusy ? "true" : undefined}
      >
        {sse.status === "error" && sse.error !== null ? (
          // uiux-fix F018 C026: a dropped stream froze the log without any hint;
          // useSSE clears the error again once the auto-reconnect succeeds.
          <div className="arun-log-row">
            <span className="arun-log-ico">
              <Icons.reset size={12} />
            </span>
            <span className="arun-log-text">{sse.error}</span>
          </div>
        ) : null}
        {sse.events.length === 0 ? (
          sse.status === "error" ? null : (
            <div className="arun-log-row">
              <span className="arun-log-ico">
                <Icons.reset size={12} />
              </span>
              <span className="arun-log-text">
                {sse.status === "connecting"
                  ? t("agentRunWidget.log.connecting")
                  : t("agentRunWidget.log.waiting")}
              </span>
            </div>
          )
        ) : (
          visibleLogEvents.map((event) => (
            <div className="arun-log-row" key={`${event.runId}:${event.seq}:${event.type}`}>
              <span className="arun-log-ico">
                <Icons.spark size={12} />
              </span>
              <span className="arun-log-text">{eventLabel(event, t)}</span>
              <span className="arun-log-t mono">{eventTime(event)}</span>
            </div>
          ))
        )}
      </div>

      {report !== null ? (
        <div className="arun-results">
          {renderExplainReport(report, t)}
          {renderVerifyReport(report, t)}
          {renderTextCard(t("agentRunWidget.result.failure"), report.failureReason)}
          {renderTextCard(t("agentRunWidget.result.coveredBehavior"), report.coveredBehavior)}
          {renderTextCard(t("agentRunWidget.result.knownGaps"), report.knownGaps)}
          {renderTextCard(
            t("agentRunWidget.result.verificationNote"),
            report.verificationSkipReason,
          )}
          {renderHypothesis(report, t)}
          {renderListCard(t("agentRunWidget.result.nextActions"), report.nextActions)}
          {report.dryRunPreview !== undefined ? (
            <div className="arun-result-card">
              <div className="arun-result-title">{t("agentRunWidget.result.dryRunPreview")}</div>
              {/* GEN-UI-KEYBOARD-005 — focusable named scroll region (WCAG 2.1.1). */}
              <pre
                role="region"
                aria-label={t("agentRunWidget.result.dryRunPreview")}
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 focusable scroll region
                tabIndex={0}
              >
                {report.dryRunPreview}
              </pre>
            </div>
          ) : null}
          {report.proposedDiff !== undefined ? (
            <div className="arun-result-card">
              <div className="arun-result-title">{t("agentRunWidget.result.proposedDiff")}</div>
              {/* GEN-UI-KEYBOARD-005 — focusable named scroll region (WCAG 2.1.1). */}
              <pre
                role="region"
                aria-label={t("agentRunWidget.result.proposedDiff")}
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 focusable scroll region
                tabIndex={0}
              >
                {report.proposedDiff}
              </pre>
            </div>
          ) : null}
          {renderVerification(report, t)}
          {report.applyReport !== undefined ? (
            <div className="arun-result-card arun-applied">
              <div className="arun-result-title">{t("agentRunWidget.result.applied")}</div>
              {/* GEN-UI-KEYBOARD-005 — focusable named scroll region (WCAG 2.1.1). */}
              <pre
                role="region"
                aria-label={t("agentRunWidget.result.applied")}
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 focusable scroll region
                tabIndex={0}
              >
                {JSON.stringify(report.applyReport, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : evidence !== null ? (
        <div className="arun-results">
          <div className="arun-result-card">
            <div className="arun-result-title">{t("agentRunWidget.evidence.title")}</div>
            <div className="arun-kv">
              <span>{t("agentRunWidget.field.outcome")}</span>
              <strong>{evidence.run.outcome}</strong>
            </div>
            <div className="arun-kv">
              <span>{t("agentRunWidget.field.duration")}</span>
              <strong>{formatMs(evidence.run.durationMs)}</strong>
            </div>
            {evidence.patch !== undefined ? (
              <>
                <div className="arun-kv">
                  <span>{t("agentRunWidget.field.changedFiles")}</span>
                  <strong>{evidence.patch.changedFiles.toString()}</strong>
                </div>
                <div className="arun-kv">
                  <span>{t("agentRunWidget.field.patchSize")}</span>
                  <strong>{formatBytes(evidence.patch.patchBytes)}</strong>
                </div>
              </>
            ) : null}
          </div>
          {evidence.patch?.redactedDiff !== undefined ? (
            <div className="arun-result-card">
              <div className="arun-result-title">{t("agentRunWidget.result.proposedDiff")}</div>
              {/* GEN-UI-KEYBOARD-005 — focusable named scroll region (WCAG 2.1.1). */}
              <pre
                role="region"
                aria-label={t("agentRunWidget.result.proposedDiff")}
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 focusable scroll region
                tabIndex={0}
              >
                {evidence.patch.redactedDiff}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* uiux-fix F018 C109: async failures must be announced (WCAG 4.1.3) */}
      {error !== null ? (
        <div className="arun-error" role="alert">
          {error}
        </div>
      ) : null}
      {applyError !== null ? (
        <div className="arun-error" role="alert">
          {applyError}
        </div>
      ) : null}

      <div className="arun-controls">
        <a
          className="arun-btn ghost"
          href={`/api/evidence/${encodeURIComponent(runId)}`}
          target="_blank"
          rel="noreferrer"
          ref={evidenceLinkRef}
        >
          {t("agentRunWidget.evidence.title")}
        </a>
        {showApply ? (
          // uiux-fix F018 C124: aria-disabled + click guard instead of HTML disabled
          // so the focused button does not throw focus to <body> while applying.
          <button
            type="button"
            className="arun-btn"
            aria-disabled={applying}
            onClick={onApplyClick}
          >
            {applyButtonLabel({ applying, confirmApply, fileCount: applyFileCount, t })}
          </button>
        ) : report?.appliedAt !== undefined ? (
          <span className="arun-final mono">{t("agentRunWidget.result.applied")}</span>
        ) : null}
        {showCancel ? (
          <button type="button" className="arun-btn danger" onClick={() => void doCancel()}>
            {t("agentRunWidget.controls.cancel")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export type { AgentRunCfg };
