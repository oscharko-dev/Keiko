"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
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
import { useSSE } from "../../../../../lib/useSSE";
import type {
  AgentWorkflowId,
  CostClass,
  EvidenceManifest,
  HarnessEvent,
  RunReport,
  SseStatus,
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
      return `Model call started (${formatBytes(event.contextBytes)})`;
    case "model:call:completed":
      return `Model call completed (${formatTokens(event.usage.promptTokens + event.usage.completionTokens)} tokens)`;
    case "model:call:failed":
      return `Model call failed: ${event.message}`;
    case "patch:proposed":
      return `Patch proposed (${formatBytes(event.patchBytes)})`;
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

// uiux-fix F018 C259: human-readable status for the header — ReviewWidget already
// maps the same RunStatus values via the shared runStatusLabel presenter; raw
// kebab-case enums ("dry-run", "fix-proposed") and the "loading" placeholder
// must not surface verbatim.
function reportStatusLabel(report: RunReport | null, evidence: EvidenceManifest | null): string {
  if (report !== null) return runStatusLabel(report.status);
  if (evidence !== null) return outcomeLabel(evidence.run.outcome);
  return "Loading…";
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
): string {
  if (report === null && evidence === null) return "Loading run state…";
  const label = workflow === null ? "Agent run" : WORKFLOW_LABELS[workflow];
  if (report?.status === "running") return `${label} is running.`;
  if (report?.status === "dry-run") return `${label} produced a reviewable dry-run.`;
  if (report?.status === "fix-proposed") return `${label} proposed a fix.`;
  if (report?.status === "fix-applied") return `${label} applied changes.`;
  if (report?.status === "investigation-only") return `${label} completed without a patch.`;
  if (report?.status === "failed" || report?.status === "rejected") return `${label} failed.`;
  if (report?.status === "cancelled") return `${label} was cancelled.`;
  if (report !== null) return `${label} completed.`;
  if (evidence?.patch?.redactedDiff !== undefined) {
    return `${label} evidence loaded with a reviewable diff.`;
  }
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
  if (report === null || report.proposedDiff === undefined || report.appliedAt !== undefined)
    return false;
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
      {/* GEN-UI-KEYBOARD-005 — overflow:auto scroll container (max-height 220px) exposed
          as a focusable named region so keyboard-only users can scroll it (WCAG 2.1.1). */}
      <pre
        role="region"
        aria-label="Report"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 focusable scroll region
        tabIndex={0}
      >
        {report.report}
      </pre>
    </div>
  );
}

function renderVerifyReport(report: RunReport): ReactNode {
  if (report.overallStatus === undefined || report.results === undefined) return null;
  return (
    <div className="arun-result-card">
      <div className="arun-result-title">Verification</div>
      <div className="arun-kv">
        <span>Status</span>
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

// Same focusable-<pre> shape as renderTextCard, but keyed on presence (`!== undefined`)
// rather than non-empty length — matches the dry-run preview / proposed-diff call sites,
// which must render an (empty) region rather than disappear when the value is "".
function renderPreCard(title: string, value: string | undefined): ReactNode {
  if (value === undefined) return null;
  return (
    <div className="arun-result-card">
      <div className="arun-result-title">{title}</div>
      {/* GEN-UI-KEYBOARD-005 — focusable named scroll region (WCAG 2.1.1). */}
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
const CONFIDENCE_LABEL: Readonly<Record<ConfidenceLevel, string>> = {
  high: "High",
  medium: "Medium",
  low: "Low — verify",
};
function isConfidenceLevel(value: string): value is ConfidenceLevel {
  return value === "low" || value === "medium" || value === "high";
}
function ConfidenceSignal({ level }: { readonly level: ConfidenceLevel }): ReactNode {
  return (
    <div className="arun-kv">
      <span>Confidence</span>
      <span className="ai-conf" data-level={level}>
        <span className="track" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="lbl">{CONFIDENCE_LABEL[level]}</span>
      </span>
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
      <div className="arun-result-title">Hypothesis</div>
      {rows.map(([label, value]) => (
        <div className="arun-kv" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
      {confidenceFallback !== undefined ? (
        <div className="arun-kv">
          <span>Confidence</span>
          <strong>{confidenceFallback}</strong>
        </div>
      ) : null}
      {confidenceLevel !== undefined ? <ConfidenceSignal level={confidenceLevel} /> : null}
    </div>
  );
}

// Extracted from the AgentRunWidget render (SonarCloud S3776) — mirrors the
// report?.durationMs ?? evidence?.run.durationMs ?? (…elapsed fallback) chain. Every
// field on this path is optional-number-or-undefined, never null, so the `!== undefined`
// checks below are behaviour-identical to the original `??` chain.
function computeElapsedMs(
  report: RunReport | null,
  evidence: EvidenceManifest | null,
  events: readonly HarnessEvent[],
): number {
  if (report?.durationMs !== undefined) return report.durationMs;
  if (evidence?.run.durationMs !== undefined) return evidence.run.durationMs;
  if (events.length === 0) return 0;
  return Math.max(0, Date.now() - Number(new Date(events[0]?.ts ?? Date.now())));
}

// Extracted from loadReport's 404 branch (SonarCloud S3776) — the run report is gone,
// so fall back to the redacted evidence manifest.
async function loadEvidenceFallback(
  runId: string,
  setEvidence: Dispatch<SetStateAction<EvidenceManifest | null>>,
  setReport: Dispatch<SetStateAction<RunReport | null>>,
  setError: Dispatch<SetStateAction<string | null>>,
): Promise<void> {
  try {
    const response = await fetchEvidenceManifest(runId);
    setEvidence(response.manifest);
    setReport(null);
  } catch (evidenceError: unknown) {
    setError(evidenceError instanceof Error ? evidenceError.message : "Unable to load evidence.");
  }
}

interface AgentRunHeaderProps {
  readonly workflow: AgentWorkflowId;
  readonly modelId: string;
  readonly costClass: CostClass | null;
  readonly status: string;
  readonly statusLabel: string;
  readonly running: boolean;
}

// Extracted from the AgentRunWidget render (SonarCloud S3776) — the "arun-head" row.
function AgentRunHeader({
  workflow,
  modelId,
  costClass,
  status,
  statusLabel,
  running,
}: AgentRunHeaderProps): ReactNode {
  return (
    <div className="arun-head">
      <span className="arun-role">{WORKFLOW_LABELS[workflow]}</span>
      {/* uiux-fix F054 C385: cfg.model is optional — skip the pill entirely so no
          empty bordered artefact renders between the workflow label and status. */}
      {modelId.length > 0 ? <span className="ag-model mono">{modelId}</span> : null}
      {/* uiux-fix F054 C382: human-readable cost class ("Low cost") instead of the
          raw enum, plus a title explaining what the pill refers to. */}
      {costClass !== null ? (
        <span className="arun-gov" title="Model cost class">
          {costClassLabel(costClass)}
        </span>
      ) : null}
      <span className="spacer" />
      <span className="arun-status">
        {/* uiux-fix F018 C265: data-status feeds the idle/terminal dot colours in
            globals.css — the bare .dot class paints no background at all. */}
        <span className="dot" data-live={running} data-status={status} />
        {statusLabel}
      </span>
    </div>
  );
}

interface AgentRunMetersProps {
  readonly elapsedMs: number;
  readonly usage: UsageTotals;
}

// Extracted from the AgentRunWidget render (SonarCloud S3776) — the elapsed/usage/latency
// meter row.
function AgentRunMeters({ elapsedMs, usage }: AgentRunMetersProps): ReactNode {
  return (
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
          {usage.requestCount === 0 ? "—" : formatMs(usage.latencyMs)}
        </span>
      </div>
    </div>
  );
}

interface AgentRunPermsProps {
  readonly linkedRoot: string | null;
  readonly workspaceRoot: string | undefined;
  readonly linkedFilePath: string | undefined;
}

// Extracted from the AgentRunWidget render (SonarCloud S3776) — the workspace/linked-file
// permission chips.
function AgentRunPerms({
  linkedRoot,
  workspaceRoot,
  linkedFilePath,
}: AgentRunPermsProps): ReactNode {
  // uiux-fix F018 C266: absolute paths are single unbreakable words — wrap them in a
  // truncating span and expose the full path via title so the end stays reachable.
  return (
    <div className="arun-perms">
      <span
        className="arun-perm"
        data-on={linkedRoot !== null}
        title={linkedRoot !== null ? linkedRoot : workspaceRoot}
      >
        <Icons.files size={11} />
        <span className="arun-perm-path">
          {linkedRoot !== null ? linkedRoot : (workspaceRoot ?? "no workspace")}
        </span>
      </span>
      {linkedFilePath !== undefined ? (
        <span className="arun-perm" data-on={true} title={linkedFilePath}>
          <Icons.files size={11} />
          <span className="arun-perm-path">{linkedFilePath}</span>
        </span>
      ) : null}
    </div>
  );
}

// Extracted from the AgentRunWidget render (SonarCloud S3776) — the collapsible run-input
// JSON block.
function AgentRunInputDetails({
  input,
}: {
  readonly input: Record<string, unknown> | null;
}): ReactNode {
  if (input === null) return null;
  return (
    <details className="arun-input">
      <summary>Run input</summary>
      {/* GEN-UI-KEYBOARD-005 — overflow:auto scroll container exposed as a focusable
          named region so keyboard-only users can scroll it (WCAG 2.1.1). */}
      <pre
        role="region"
        aria-label="Run input"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 focusable scroll region
        tabIndex={0}
      >
        {JSON.stringify(input, null, 2)}
      </pre>
    </details>
  );
}

interface AgentRunLogProps {
  readonly sseStatus: SseStatus;
  readonly sseError: string | null;
  readonly visibleLogEvents: readonly HarnessEvent[];
  readonly runBusy: boolean;
}

// Extracted from the AgentRunWidget render (SonarCloud S3776) — the role="log" event feed.
// `visibleLogEvents.length === 0` is equivalent to the original `sse.events.length === 0`:
// visibleLogEvents is a pure slice/reverse/slice(0, 50) of sse.events, so one is empty iff
// the other is.
function AgentRunLog({
  sseStatus,
  sseError,
  visibleLogEvents,
  runBusy,
}: AgentRunLogProps): ReactNode {
  return (
    <div
      className="arun-log"
      role="log"
      aria-live="polite"
      aria-label="Run events"
      aria-busy={runBusy ? "true" : undefined}
    >
      {sseStatus === "error" && sseError !== null ? (
        // uiux-fix F018 C026: a dropped stream froze the log without any hint;
        // useSSE clears the error again once the auto-reconnect succeeds.
        <div className="arun-log-row">
          <span className="arun-log-ico">
            <Icons.reset size={12} />
          </span>
          <span className="arun-log-text">{sseError}</span>
        </div>
      ) : null}
      {visibleLogEvents.length === 0 ? (
        sseStatus === "error" ? null : (
          <div className="arun-log-row">
            <span className="arun-log-ico">
              <Icons.reset size={12} />
            </span>
            <span className="arun-log-text">
              {sseStatus === "connecting" ? "Connecting to run events…" : "Waiting for run events…"}
            </span>
          </div>
        )
      ) : (
        visibleLogEvents.map((event) => (
          <div className="arun-log-row" key={`${event.runId}:${event.seq}:${event.type}`}>
            <span className="arun-log-ico">
              <Icons.spark size={12} />
            </span>
            <span className="arun-log-text">{eventLabel(event)}</span>
            <span className="arun-log-t mono">{eventTime(event)}</span>
          </div>
        ))
      )}
    </div>
  );
}

// Extracted from the AgentRunWidget render (SonarCloud S3776) — the report-backed results
// panel (live run).
function AgentRunReportResults({ report }: { readonly report: RunReport }): ReactNode {
  return (
    <div className="arun-results">
      {renderExplainReport(report)}
      {renderVerifyReport(report)}
      {renderTextCard("Failure", report.failureReason)}
      {renderTextCard("Covered behavior", report.coveredBehavior)}
      {renderTextCard("Known gaps", report.knownGaps)}
      {renderTextCard("Verification note", report.verificationSkipReason)}
      {renderHypothesis(report)}
      {renderListCard("Next actions", report.nextActions)}
      {renderPreCard("Dry-run preview", report.dryRunPreview)}
      {renderPreCard("Proposed diff", report.proposedDiff)}
      {renderVerification(report)}
      {report.applyReport !== undefined ? (
        <div className="arun-result-card arun-applied">
          <div className="arun-result-title">Applied</div>
          {/* GEN-UI-KEYBOARD-005 — focusable named scroll region (WCAG 2.1.1). */}
          <pre
            role="region"
            aria-label="Applied"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WCAG 2.1.1 focusable scroll region
            tabIndex={0}
          >
            {JSON.stringify(report.applyReport, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

// Extracted from the AgentRunWidget render (SonarCloud S3776) — the evidence-backed results
// panel (report gone, evidence manifest loaded instead).
function AgentRunEvidenceResults({ evidence }: { readonly evidence: EvidenceManifest }): ReactNode {
  return (
    <div className="arun-results">
      <div className="arun-result-card">
        <div className="arun-result-title">Evidence</div>
        <div className="arun-kv">
          <span>Outcome</span>
          <strong>{evidence.run.outcome}</strong>
        </div>
        <div className="arun-kv">
          <span>Duration</span>
          <strong>{formatMs(evidence.run.durationMs)}</strong>
        </div>
        {evidence.patch !== undefined ? (
          <>
            <div className="arun-kv">
              <span>Changed files</span>
              <strong>{evidence.patch.changedFiles.toString()}</strong>
            </div>
            <div className="arun-kv">
              <span>Patch size</span>
              <strong>{formatBytes(evidence.patch.patchBytes)}</strong>
            </div>
          </>
        ) : null}
      </div>
      {renderPreCard("Proposed diff", evidence.patch?.redactedDiff)}
    </div>
  );
}

// Extracted from the AgentRunWidget render (SonarCloud S3776) — picks the report vs.
// evidence results panel, mirroring the original `report !== null ? … : evidence !== null
// ? … : null` ternary chain.
function AgentRunResults({
  report,
  evidence,
}: {
  readonly report: RunReport | null;
  readonly evidence: EvidenceManifest | null;
}): ReactNode {
  if (report !== null) return <AgentRunReportResults report={report} />;
  if (evidence !== null) return <AgentRunEvidenceResults evidence={evidence} />;
  return null;
}

// Extracted from the AgentRunWidget render (SonarCloud S3776) — the load/apply error
// announcements (WCAG 4.1.3).
function AgentRunErrors({
  error,
  applyError,
}: {
  readonly error: string | null;
  readonly applyError: string | null;
}): ReactNode {
  return (
    <>
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
    </>
  );
}

interface AgentRunControlsProps {
  readonly runId: string;
  readonly evidenceLinkRef: MutableRefObject<HTMLAnchorElement | null>;
  readonly showApply: boolean;
  readonly applying: boolean;
  readonly confirmApply: boolean;
  readonly applyFileCount: number;
  readonly onApplyClick: () => void;
  readonly appliedAt: number | undefined;
  readonly showCancel: boolean;
  readonly onCancelClick: () => void;
}

// Extracted from the AgentRunWidget render (SonarCloud S3776) — the Evidence/Apply/Cancel
// control row.
function AgentRunControls({
  runId,
  evidenceLinkRef,
  showApply,
  applying,
  confirmApply,
  applyFileCount,
  onApplyClick,
  appliedAt,
  showCancel,
  onCancelClick,
}: AgentRunControlsProps): ReactNode {
  return (
    <div className="arun-controls">
      <a
        className="arun-btn ghost"
        href={`/api/evidence/${encodeURIComponent(runId)}`}
        target="_blank"
        rel="noreferrer"
        ref={evidenceLinkRef}
      >
        Evidence
      </a>
      {showApply ? (
        // uiux-fix F018 C124: aria-disabled + click guard instead of HTML disabled
        // so the focused button does not throw focus to <body> while applying.
        <button type="button" className="arun-btn" aria-disabled={applying} onClick={onApplyClick}>
          {applying
            ? "Applying…"
            : confirmApply
              ? `Confirm apply (${applyFileCount.toString()} file${applyFileCount === 1 ? "" : "s"})`
              : "Apply"}
        </button>
      ) : appliedAt !== undefined ? (
        <span className="arun-final mono">Applied</span>
      ) : null}
      {showCancel ? (
        <button type="button" className="arun-btn danger" onClick={onCancelClick}>
          Cancel
        </button>
      ) : null}
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
        await loadEvidenceFallback(runId, setEvidence, setReport, setError);
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
  // GEN-PERF-WIDGET-005 — the newest-first 50-row log view copies/reverses the (≤500
  // entry) buffer; inline in JSX it re-ran on every unrelated widget render. Memoized on
  // the buffer identity it runs once per event batch.
  const visibleLogEvents = useMemo(() => sse.events.slice().reverse().slice(0, 50), [sse.events]);
  const elapsedMs = computeElapsedMs(report, evidence, sse.events);
  const status = reportStatus(report, evidence);
  const statusLabel = reportStatusLabel(report, evidence);
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
      setError(cancelError instanceof Error ? cancelError.message : "Unable to cancel run.");
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
        applyRunError instanceof Error ? applyRunError.message : "Unable to apply run.",
      );
    } finally {
      setApplying(false);
    }
  };

  // uiux-fix F018 C258: arms the "Confirm apply" state and its 6s auto-reset timer.
  // Kept as a component-local closure (not module-scope) so confirmTimerRef's mutation
  // stays visible to react-hooks/exhaustive-deps for the unmount-cleanup effect above.
  const armApplyConfirmation = (): void => {
    setConfirmApply(true);
    if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = window.setTimeout(() => {
      setConfirmApply(false);
      confirmTimerRef.current = null;
    }, 6000);
  };

  // uiux-fix F018 C258: cancels a pending auto-reset timer (see armApplyConfirmation).
  const clearApplyConfirmation = (): void => {
    if (confirmTimerRef.current !== null) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  };

  // uiux-fix F018 C258: first click arms the confirm state (auto-resets after 6 s),
  // the second click actually applies.
  const onApplyClick = (): void => {
    if (applying) return;
    if (!confirmApply) {
      armApplyConfirmation();
      return;
    }
    clearApplyConfirmation();
    setConfirmApply(false);
    void doApply();
  };

  if (runId === null || workflow === null) {
    return (
      <div className="arun arun-empty">
        <div className="arun-result-title">Agent run is not configured.</div>
        <p>Open a new Agent window from the launcher to start a workflow.</p>
      </div>
    );
  }

  return (
    <div className="arun arun-real" aria-busy={runBusy ? "true" : undefined}>
      <AgentRunHeader
        workflow={workflow}
        modelId={modelId}
        costClass={costClass}
        status={status}
        statusLabel={statusLabel}
        running={report?.status === "running"}
      />

      {/* uiux-fix F018 C109: announce run completion (shortSummary changes) to AT.
          title carries the full run id, which is otherwise unobtainable (C110). */}
      <div className="arun-summary" role="status" aria-live="polite">
        <strong>{shortSummary(workflow, report, evidence)}</strong>
        <span className="mono" title={runId}>
          run {runId.slice(0, 8)}
        </span>
      </div>

      <AgentRunMeters elapsedMs={elapsedMs} usage={usage} />

      <AgentRunPerms
        linkedRoot={linkedRoot}
        workspaceRoot={cfg.workspaceRoot}
        linkedFilePath={linkedFilePath}
      />

      <AgentRunInputDetails input={input} />

      {/* uiux-fix F018 C109: role=log announces appended entries (TerminalWidget
          pattern). The C026 disconnect row below lives inside this live region, so
          it needs no role of its own. */}
      <AgentRunLog
        sseStatus={sse.status}
        sseError={sse.error}
        visibleLogEvents={visibleLogEvents}
        runBusy={runBusy}
      />

      <AgentRunResults report={report} evidence={evidence} />

      {/* uiux-fix F018 C109: async failures must be announced (WCAG 4.1.3) */}
      <AgentRunErrors error={error} applyError={applyError} />

      <AgentRunControls
        runId={runId}
        evidenceLinkRef={evidenceLinkRef}
        showApply={showApply}
        applying={applying}
        confirmApply={confirmApply}
        applyFileCount={applyFileCount}
        onApplyClick={onApplyClick}
        appliedAt={report?.appliedAt}
        showCancel={showCancel}
        onCancelClick={() => void doCancel()}
      />
    </div>
  );
}

export type { AgentRunCfg };
