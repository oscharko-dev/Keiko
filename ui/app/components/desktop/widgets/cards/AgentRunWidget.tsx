"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ApiError,
  applyRun,
  cancelRun,
  fetchEvidenceManifest,
  fetchModels,
  fetchRunReport,
} from "../../../../../lib/api";
import { formatMs, formatTokens } from "../../../../../lib/format";
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

const WORKFLOW_LABELS: Readonly<Record<AgentWorkflowId, string>> = {
  verify: "Verify",
  "explain-plan": "Explain plan",
  "unit-test-generation": "Generate unit tests",
  "bug-investigation": "Investigate bug",
};

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

function eventLabel(event: HarnessEvent): string {
  switch (event.type) {
    case "ready":
      return "SSE stream ready";
    case "run:started":
      return `Started ${event.taskType}`;
    case "run:completed":
      return "Run completed";
    case "run:failed":
      return `Run failed: ${event.failure.message}`;
    case "run:cancelled":
      return "Run cancelled";
    case "state:transition":
      return `${event.from} -> ${event.to}${event.reason === undefined ? "" : `: ${event.reason}`}`;
    case "model:call:started":
      return `Model call started (${event.contextBytes.toString()} bytes)`;
    case "model:call:completed":
      return `Model call completed (${formatTokens(event.usage.promptTokens + event.usage.completionTokens)} tokens)`;
    case "model:call:failed":
      return `Model call failed: ${event.message}`;
    case "patch:proposed":
      return `Patch proposed (${event.patchBytes.toString()} bytes)`;
    case "verification:result":
      return `Verification ${event.passed ? "passed" : "failed"}: ${event.detail}`;
    case "workflow:started":
      return "Unit-test workflow started";
    case "workflow:model:call:completed":
      return `Unit-test model call completed (${formatTokens(event.promptTokens + event.completionTokens)} tokens)`;
    case "workflow:verification:result":
      return `Unit-test verification ${event.overallStatus}`;
    case "workflow:completed":
      return `Unit-test workflow ${event.status}`;
    case "workflow:failed":
      return `Unit-test workflow failed: ${event.message}`;
    case "bug:started":
      return "Bug investigation started";
    case "bug:model:call:completed":
      return `Bug model call completed (${formatTokens(event.promptTokens + event.completionTokens)} tokens)`;
    case "bug:rootcause:proposed":
      return `Root cause proposed${event.hasPatch ? " with patch" : ""}`;
    case "bug:verification:result":
      return `Bug verification ${event.overallStatus}`;
    case "bug:completed":
      return `Bug investigation ${event.status}`;
    case "bug:failed":
      return `Bug investigation failed: ${event.message}`;
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

function shortSummary(
  workflow: AgentWorkflowId | null,
  report: RunReport | null,
  evidence: EvidenceManifest | null,
): string {
  if (report === null && evidence === null) return "Loading run state...";
  const label = workflow === null ? "Agent run" : WORKFLOW_LABELS[workflow];
  if (report?.status === "running") return `${label} is running.`;
  if (report?.status === "dry-run") return `${label} produced a reviewable dry-run.`;
  if (report?.status === "fix-proposed") return `${label} proposed a fix.`;
  if (report?.status === "fix-applied") return `${label} applied changes.`;
  if (report?.status === "investigation-only") return `${label} completed without a patch.`;
  if (report?.status === "failed" || report?.status === "rejected") return `${label} failed.`;
  if (report?.status === "cancelled") return `${label} was cancelled.`;
  if (report !== null) return `${label} completed.`;
  return `${label} evidence loaded: ${evidence?.run.outcome ?? "unknown"}.`;
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
  if (report === null || report.proposedDiff === undefined || report.appliedAt !== undefined) return false;
  return (
    (workflow === "unit-test-generation" && report.status === "dry-run") ||
    (workflow === "bug-investigation" && report.status === "fix-proposed")
  );
}

function renderVerification(report: RunReport): ReactNode {
  const summary = report.verificationSummary;
  if (summary === undefined) return null;
  return (
    <div className="arun-result-card">
      <div className="arun-result-title">Verification</div>
      <div className="arun-kv">
        <span>Status</span>
        <strong>{summary.overallStatus}</strong>
      </div>
      <div className="arun-kv">
        <span>Duration</span>
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

function renderExplainReport(report: RunReport): ReactNode {
  if (report.report === undefined) return null;
  return (
    <div className="arun-result-card">
      <div className="arun-result-title">Report</div>
      <pre>{report.report}</pre>
    </div>
  );
}

function renderVerifyReport(report: RunReport): ReactNode {
  if (report.overallStatus === undefined || report.results === undefined) return null;
  return (
    <div className="arun-result-card">
      <div className="arun-result-title">Verification</div>
      <div className="arun-kv"><span>Status</span><strong>{report.overallStatus}</strong></div>
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
      <pre>{value}</pre>
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

function renderHypothesis(report: RunReport): ReactNode {
  const hypothesis = report.hypothesis;
  if (hypothesis === undefined) return null;
  const rows = [
    ["Root cause", hypothesis.rootCause],
    ["Regression test", hypothesis.regressionTestStrategy],
    ["Uncertainty", hypothesis.uncertainty],
    ["Confidence", hypothesis.confidence],
  ].filter((row): row is [string, string] => typeof row[1] === "string" && row[1].length > 0);
  if (rows.length === 0) return null;
  return (
    <div className="arun-result-card">
      <div className="arun-result-title">Hypothesis</div>
      {rows.map(([label, value]) => (
        <div className="arun-kv" key={label}><span>{label}</span><strong>{value}</strong></div>
      ))}
    </div>
  );
}

export function AgentRunWidget({
  cfg = {},
  linkedRoot = null,
  linkedFilePath,
}: AgentRunWidgetProps): ReactNode {
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
          setError(evidenceError instanceof Error ? evidenceError.message : "Unable to load evidence.");
        }
        return;
      }
      setError(loadError instanceof Error ? loadError.message : "Unable to load run report.");
    }
  }, [runId]);

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
  const elapsedMs =
    report?.durationMs ??
    evidence?.run.durationMs ??
    (sse.events.length > 0
      ? Math.max(0, Date.now() - Number(new Date(sse.events[0]?.ts ?? Date.now())))
      : 0);
  const status = reportStatus(report, evidence);
  const terminal = report !== null && TERMINAL_REPORT_STATUSES.has(report.status);
  const showApply = canApply(workflow, report);

  const doCancel = async (): Promise<void> => {
    if (runId === null) return;
    setError(null);
    try {
      await cancelRun(runId);
      await loadReport();
    } catch (cancelError: unknown) {
      setError(cancelError instanceof Error ? cancelError.message : "Unable to cancel run.");
    }
  };

  const doApply = async (): Promise<void> => {
    if (runId === null || !showApply) return;
    setApplying(true);
    setApplyError(null);
    try {
      const response = await applyRun(runId);
      setReport(response.report);
    } catch (applyRunError: unknown) {
      setApplyError(applyRunError instanceof Error ? applyRunError.message : "Unable to apply run.");
    } finally {
      setApplying(false);
    }
  };

  if (runId === null || workflow === null) {
    return (
      <div className="arun arun-empty">
        <div className="arun-result-title">Agent run is not configured.</div>
        <p>Open a new Agent window from the launcher to start a BFF workflow.</p>
      </div>
    );
  }

  return (
    <div className="arun arun-real">
      <div className="arun-head">
        <span className="arun-role">{WORKFLOW_LABELS[workflow]}</span>
        <span className="ag-model mono">{modelId}</span>
        {costClass !== null ? <span className="arun-gov">{costClass}</span> : null}
        <span className="spacer" />
        <span className="arun-status">
          <span className="dot" data-live={report?.status === "running"} />
          {status}
        </span>
      </div>

      <div className="arun-summary">
        <strong>{shortSummary(workflow, report, evidence)}</strong>
        <span className="mono">run {runId.slice(0, 8)}</span>
      </div>

      <div className="arun-meters">
        <div className="arun-meter">
          <span className="arun-mk">Elapsed</span>
          <span className="arun-mv mono">{formatMs(elapsedMs)}</span>
        </div>
        <div className="arun-meter">
          <span className="arun-mk">Usage</span>
          <span className="arun-mv mono">
            {usage.requestCount === 0
              ? "No model usage"
              : `${formatTokens(usage.promptTokens + usage.completionTokens)} tok`}
          </span>
        </div>
        <div className="arun-meter">
          <span className="arun-mk">Latency</span>
          <span className="arun-mv mono">
            {usage.requestCount === 0 ? "-" : formatMs(usage.latencyMs)}
          </span>
        </div>
      </div>

      <div className="arun-perms">
        <span className="arun-perm" data-on={linkedRoot !== null}>
          <Icons.files size={11} />
          {linkedRoot !== null ? linkedRoot : cfg.workspaceRoot ?? "no workspace"}
        </span>
        {linkedFilePath !== undefined ? (
          <span className="arun-perm" data-on={true}>
            <Icons.files size={11} />{linkedFilePath}
          </span>
        ) : null}
        <span className="arun-perm" aria-disabled="true">
          <Icons.plugins size={11} />permissions coming soon
        </span>
      </div>

      {input !== null ? (
        <details className="arun-input">
          <summary>Run input</summary>
          <pre>{JSON.stringify(input, null, 2)}</pre>
        </details>
      ) : null}

      <div className="arun-log">
        {sse.events.length === 0 ? (
          <div className="arun-log-row">
            <span className="arun-log-ico"><Icons.reset size={12} /></span>
            <span className="arun-log-text">Waiting for run events...</span>
          </div>
        ) : sse.events.slice().reverse().slice(0, 50).map((event) => (
          <div className="arun-log-row" key={`${event.runId}:${event.seq}:${event.type}`}>
            <span className="arun-log-ico"><Icons.spark size={12} /></span>
            <span className="arun-log-text">{eventLabel(event)}</span>
            <span className="arun-log-t mono">{eventTime(event)}</span>
          </div>
        ))}
      </div>

      {report !== null ? (
        <div className="arun-results">
          {renderExplainReport(report)}
          {renderVerifyReport(report)}
          {renderTextCard("Failure", report.failureReason)}
          {renderTextCard("Covered behavior", report.coveredBehavior)}
          {renderTextCard("Known gaps", report.knownGaps)}
          {renderTextCard("Verification note", report.verificationSkipReason)}
          {renderHypothesis(report)}
          {renderListCard("Next actions", report.nextActions)}
          {report.dryRunPreview !== undefined ? (
            <div className="arun-result-card">
              <div className="arun-result-title">Dry-run preview</div>
              <pre>{report.dryRunPreview}</pre>
            </div>
          ) : null}
          {report.proposedDiff !== undefined ? (
            <div className="arun-result-card">
              <div className="arun-result-title">Proposed diff</div>
              <pre>{report.proposedDiff}</pre>
            </div>
          ) : null}
          {renderVerification(report)}
          {report.applyReport !== undefined ? (
            <div className="arun-result-card arun-applied">
              <div className="arun-result-title">Applied</div>
              <pre>{JSON.stringify(report.applyReport, null, 2)}</pre>
            </div>
          ) : null}
        </div>
      ) : evidence !== null ? (
        <div className="arun-result-card">
          <div className="arun-result-title">Evidence</div>
          <div className="arun-kv"><span>Outcome</span><strong>{evidence.run.outcome}</strong></div>
          <div className="arun-kv"><span>Duration</span><strong>{formatMs(evidence.run.durationMs)}</strong></div>
        </div>
      ) : null}

      {error !== null ? <div className="arun-error">{error}</div> : null}
      {applyError !== null ? <div className="arun-error">{applyError}</div> : null}

      <div className="arun-controls">
        <a
          className="arun-btn ghost"
          href={`/api/evidence/${encodeURIComponent(runId)}`}
          target="_blank"
          rel="noreferrer"
        >
          Evidence
        </a>
        {showApply ? (
          <button type="button" className="arun-btn" disabled={applying} onClick={() => void doApply()}>
            {applying ? "Applying..." : "Apply"}
          </button>
        ) : report?.appliedAt !== undefined ? (
          <span className="arun-final mono">Applied</span>
        ) : null}
        {!terminal && report?.status === "running" ? (
          <button type="button" className="arun-btn danger" onClick={() => void doCancel()}>
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}

export type { AgentRunCfg };
