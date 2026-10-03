import {
  ACTIVITY_LOG_ERROR_KINDS,
  ACTIVITY_LOG_OPERATION_REGISTRY,
  DIAGNOSTIC_SUFFICIENCY_REASONS,
  diagnosticSufficiencyStatus,
} from "../../packages/keiko-contracts/dist/observability.js";

// The release failure report is printed to public CI logs. Only reviewed closed values may cross
// that boundary; a future producer that changes its vocabulary is redacted until reviewed here.
const FAILURE_CODES = new Set([
  "runtime-unavailable",
  "active-run-conflict",
  "invalid-intent",
  "approval-activation-failed",
  "authority-resolution-failed",
  "authority-expired",
  "authority-replayed",
  "task-drift",
  "workspace-drift",
  "project-drift",
  "branch-drift",
  "scope-drift",
  "budget-drift",
  "authority-budget-exceeded",
  "source-drift",
  "runtime-failed",
  "revoked",
  "recovery-required",
  "replay-cap-exhausted",
  "issue-context-unavailable",
  "question-answer-rejected",
  "delivery-not-evidenced",
  "model-unavailable",
  "workspace-unqualified",
  "provider-failed",
  "stream-incomplete",
  "turn-rejected",
]);
const ERROR_KINDS = new Set(ACTIVITY_LOG_ERROR_KINDS);
const REGISTERED_OPERATIONS = new Set(ACTIVITY_LOG_OPERATION_REGISTRY.map(({ op }) => op));
const SUFFICIENCY_REASONS = new Set(DIAGNOSTIC_SUFFICIENCY_REASONS);
const OUTCOMES = new Set(["accepted", "cancelled", "failed", "output-limit"]);
const PUBLICATION_REASONS = new Set([
  "published",
  "event-hub-unavailable",
  "terminal-run",
  "invalid-event",
  "sequence-exhausted",
  "capacity-pressure",
]);
const START_DIAGNOSTIC_CODES = [
  "adapter-profile-mismatch",
  "archive-digest-mismatch",
  "egress-unqualified",
  "env-secret-denied",
  "executable-tree-digest-mismatch",
  "gateway-non-loopback",
  "history-initialization",
  "host-unavailable",
  "initial-turn-dispatch",
  "initial-turn-recovery",
  "launch-resolution",
  "manager-exception",
  "model-unavailable",
  "payload-missing",
  "platform-unsupported",
  "protocol-schema-mismatch",
  "qualification-missing",
  "redistribution-unapproved",
  "repository-unavailable",
  "run-mismatch",
  "runtime-already-running",
  "runtime-crashed",
  "runtime-profile-open",
  "runtime-reap-unproven",
  "runtime-run-mismatch",
  "spawn-failed",
  "start-aborted",
  "start-timeout",
  "sidecar-missing",
  "sidecar-unmanaged",
  "runtime-state-unavailable",
  "runtime-unqualified",
  "runtime-version-mismatch",
  "signature-unverified",
  "workspace-root-denied",
  "workspace-unqualified",
].map((reason) => `stage=start:reason=${reason}`);
const HANDSHAKE_DIAGNOSTIC_CODES = [
  "target-attestation",
  "config-materialization",
  "endpoint",
  "authenticated-health",
  "authenticated-health-version",
  "unauthenticated-health",
  "openapi-digest",
  "gateway-challenge",
  "tool-facade-challenge",
  "sse-history-reconciliation",
  "session-echo",
  "endpoint-invalid",
  "preparation-missing",
  "readiness-failed",
  "handshake-rejected",
  "timeout",
  "unclassified",
];
const DIAGNOSTIC_CODES = new Set([...START_DIAGNOSTIC_CODES, ...HANDSHAKE_DIAGNOSTIC_CODES]);
const DIAGNOSTIC_SOURCES = new Set([
  "coding-runtime.start",
  "coding-runtime.history",
  "coding-runtime.handshake",
  "coding-runtime.exit",
  "coding-runtime.stderr",
]);
const TASK_OUTCOME_STATUSES = new Set(["cancelled", "failed", "signalled", "succeeded"]);
const DROPPED_EVENT_REASONS = new Set(["no-live-run", "run-mismatch"]);
const LAUNCH_PHASES = new Set([
  "gateway-policy",
  "platform-identity",
  "runtime-path",
  "workspace-path",
  "git-attestation",
  "sandbox-plan",
  "process-spawn",
  "launcher-diagnostics",
  "tree-ownership",
]);
const DIAGNOSTIC_OPERATIONS = new Set([
  "runtime.confinement.failed",
  "runtime.confinement.unavailable",
  "coding-runtime.run.started",
  "coding-runtime.dev-lane.activated",
  "coding-runtime.readiness.phase",
  "coding-runtime.readiness.failed",
  "coding-runtime.initial-turn.dispatch-failed",
  "coding-runtime.run.settled",
  "coding-runtime.run.shutdown",
  "coding-runtime.safe-activity",
  "coding-runtime.event.dropped",
  "coding-runtime.operation.refused",
  "coding-sidecar.gateway.request-validated",
  "coding-sidecar.gateway.tool-availability",
  "coding-sidecar.gateway.rejected",
  "coding-sidecar.gateway.turn-failed",
  "coding-sidecar.gateway.outcome",
  "coding-sidecar.gateway.usage-settled",
  "server.diagnostic.failure",
  "chat.request.compatibility-retry",
]);

function closedField(line, name, values) {
  const value = line[name];
  if (typeof value !== "string") return {};
  return { [name]: values.has(value) ? value : "[redacted]" };
}

function relevantFailureLine(line) {
  return line !== null && typeof line === "object" && DIAGNOSTIC_OPERATIONS.has(line.op);
}

export function customerShapeFailureSummary(lines, requests, firstRequest) {
  const timeline = lines
    .filter(relevantFailureLine)
    .slice(-24)
    .map((line) => ({
      op: line.op,
      ...closedField(line, "failureCode", FAILURE_CODES),
      ...closedField(line, "errorKind", ERROR_KINDS),
      ...closedField(line, "outcome", OUTCOMES),
      ...closedField(line, "publicationReason", PUBLICATION_REASONS),
      ...closedField(line, "diagnosticOperation", DIAGNOSTIC_SOURCES),
      ...closedField(line, "code", DIAGNOSTIC_CODES),
      ...closedField(line, "taskOutcomeStatus", TASK_OUTCOME_STATUSES),
      ...closedField(line, "reason", DROPPED_EVENT_REASONS),
      ...closedField(line, "launchPhase", LAUNCH_PHASES),
      ...(typeof line.terminal === "boolean" ? { terminal: line.terminal } : {}),
      ...(Number.isInteger(line.exitCode) ? { exitCode: line.exitCode } : {}),
      ...(Number.isInteger(line.diagnosticLineCount)
        ? { diagnosticLineCount: line.diagnosticLineCount }
        : {}),
    }));
  return {
    activityLineCount: lines.length,
    timeline,
    requestCount: requests.length - firstRequest,
    requests: requests.slice(firstRequest, firstRequest + 12).map((request) => {
      const fields = request !== null && typeof request === "object" ? request : {};
      return {
        stream: fields.stream === true,
        hasStreamOptions: fields.hasStreamOptions === true,
        delayed: fields.delayed === true,
        truncated: fields.truncated === true,
        deliveredToolCall: fields.deliveredToolCall === true,
      };
    }),
  };
}

export function customerShapeRequestEvidence(requests, firstRequest) {
  const current = requests.slice(firstRequest);
  return {
    rejectedOptionalField: current.some((request) => request.stream && request.hasStreamOptions),
    compatibleRetry: current.some((request) => request.stream && !request.hasStreamOptions),
    delayedAcceptedStream: current.some(
      (request) => request.stream && !request.hasStreamOptions && request.delayed === true,
    ),
  };
}

export function completedToolRoundTripEvidence(requests, firstRequest) {
  const current = requests.slice(firstRequest);
  const emitted = current.findIndex((request) => request.deliveredToolCall === true);
  return (
    emitted >= 0 && current.slice(emitted + 1).some((request) => request.completedDiscoveryResult)
  );
}

export function completedTurnEvidence(lines, runId) {
  const usage = lines.find(
    (line) =>
      line.op === "coding-sidecar.gateway.usage-settled" &&
      line.parentCorrelationId === runId &&
      Number.isInteger(line.completionTokens) &&
      line.completionTokens > 0,
  );
  return (
    usage !== undefined &&
    typeof usage.correlationId === "string" &&
    usage.correlationId.length > 0 &&
    lines.some(
      (line) =>
        line.op === "coding-sidecar.gateway.outcome" &&
        line.outcome === "accepted" &&
        line.parentCorrelationId === runId &&
        line.correlationId === usage.correlationId,
    )
  );
}

export function linkedFailureEvidence(lines, runId) {
  const turnFailure = lines.find(
    (line) =>
      line.op === "coding-sidecar.gateway.turn-failed" &&
      line.runId === runId &&
      line.parentCorrelationId === runId &&
      typeof line.correlationId === "string" &&
      line.correlationId.length > 0 &&
      (line.published === true ||
        (line.published === false && line.publicationReason === "terminal-run")),
  );
  if (turnFailure === undefined) return undefined;
  const diagnostic = lines.find(
    (line) =>
      line.op === "server.diagnostic.failure" &&
      line.correlationId === turnFailure.correlationId &&
      line.parentCorrelationId === runId &&
      Array.isArray(line.frames) &&
      line.frames.some((frame) => typeof frame === "string" && frame.includes("/dist/")),
  );
  return diagnostic === undefined ? undefined : { turnFailure, diagnostic };
}

function reportSufficiency(value) {
  if (
    !Array.isArray(value?.reasons) ||
    !value.reasons.every((reason) => SUFFICIENCY_REASONS.has(reason)) ||
    value.status !== diagnosticSufficiencyStatus(value.reasons)
  )
    throw new TypeError("support report has contradictory sufficiency");
  return { status: value.status, reasons: value.reasons };
}

function sameOccurrence(line, original) {
  return (
    typeof original.ts === "string" &&
    Number.isSafeInteger(original.seq) &&
    original.seq > 0 &&
    line.ts === original.ts &&
    line.seq === original.seq &&
    line.pid === original.pid
  );
}

function reconstructedLine(report, correlationId, original) {
  return report.analysis.timelines
    .find((timeline) => timeline.correlationId === correlationId)
    ?.lines.find((line) => line.op === original.op && sameOccurrence(line, original));
}

/** Resolve private IDs through the incident anchor and retained source occurrences, not labels. */
export function customerShapeSupportReportCorrelations(report, evidence, runId) {
  const root = report.incident?.correlation.rootCorrelationId;
  if (
    typeof root !== "string" ||
    root.length === 0 ||
    evidence.diagnostic.parentCorrelationId !== runId ||
    evidence.turnFailure.parentCorrelationId !== runId ||
    evidence.turnFailure.correlationId !== evidence.diagnostic.correlationId
  )
    throw new Error("support report lacks the selected run's causal incident anchor");
  const candidates = report.analysis.timelines.filter(
    (timeline) =>
      timeline.correlationId !== root &&
      timeline.lines.some(
        (line) => line.op === evidence.diagnostic.op && sameOccurrence(line, evidence.diagnostic),
      ) &&
      timeline.lines.some(
        (line) => line.op === evidence.turnFailure.op && sameOccurrence(line, evidence.turnFailure),
      ),
  );
  if (candidates.length !== 1)
    throw new Error("support report lost the linked diagnostic occurrence");
  return { runId: root, diagnosticId: candidates[0].correlationId };
}

function reconstructedDiagnostic(report, evidence, correlations) {
  const diagnostic = reconstructedLine(report, correlations.diagnosticId, evidence.diagnostic);
  if (
    diagnostic?.parentCorrelationId !== correlations.runId ||
    diagnostic.errorKind !== evidence.diagnostic.errorKind ||
    !ERROR_KINDS.has(diagnostic.errorKind) ||
    !diagnostic.frames?.some((frame) => frame.includes("/dist/"))
  )
    throw new Error("support report lost the linked typed diagnostic or installed failure site");
  if (
    JSON.stringify(diagnostic.frames) !== JSON.stringify(evidence.diagnostic.frames) ||
    JSON.stringify(diagnostic.causeChain) !== JSON.stringify(evidence.diagnostic.causeChain)
  )
    throw new Error("support report changed the safe failure frame or cause chain");
  return diagnostic;
}

function reconstructedFailure(report, evidence, correlations) {
  const failure = reconstructedLine(report, correlations.runId, evidence.turnFailure);
  const child = reconstructedLine(report, correlations.diagnosticId, evidence.turnFailure);
  if (
    failure?.extra?.failureCode !== evidence.turnFailure.failureCode ||
    !FAILURE_CODES.has(failure.extra.failureCode) ||
    failure.extra.runId !== correlations.runId ||
    child?.parentCorrelationId !== correlations.runId ||
    JSON.stringify(child) !== JSON.stringify(failure)
  )
    throw new Error("support report lost the typed run failure");
  return failure;
}

function reconstructedSeed(report, runId) {
  const seed = report.seed;
  if (
    seed?.correlationId !== runId ||
    seed.sourceArtifact.sha256 !== report.sourceArtifactDigest ||
    seed.sourceArtifact.lineCount !== report.analysis.evidence.supportedLineCount ||
    !seed.timeline.some((line) => line.op === "coding-sidecar.gateway.turn-failed") ||
    !seed.stackFrames?.some((frame) => frame.includes("/dist/")) ||
    !seed.warnings?.some((warning) => warning.includes("no prompt/response body"))
  )
    throw new Error("support report lacks bound deterministic reproduction preparation");
  reportSufficiency(seed.sufficiency);
  return seed;
}

function assertReportEnvelope(report) {
  if (
    report.kind !== "keiko.support.report-analysis" ||
    report.schemaVersion !== 1 ||
    report.authenticity !== "unknown" ||
    !/^[a-f0-9]{64}$/u.test(report.reportDigest) ||
    !/^[a-f0-9]{64}$/u.test(report.sourceArtifactDigest)
  )
    throw new TypeError("support report lacks the validated versioned machine envelope");
}

function partialReportOperations(report) {
  const partial = report.analysis.timelines.flatMap((timeline) =>
    timeline.lines.filter(
      (line) => line.extra?.completeness === "partial" || line.extra?.completeness === "unknown",
    ),
  );
  return [...new Set(partial.map(({ op }) => (REGISTERED_OPERATIONS.has(op) ? op : "[redacted]")))];
}

function timelineOfReport(timeline, report, correlationId) {
  return (
    timeline?.kind === "keiko.support.report-timeline" &&
    timeline.schemaVersion === 1 &&
    timeline.authenticity === "unknown" &&
    timeline.reportDigest === report.reportDigest &&
    timeline.sourceArtifactDigest === report.sourceArtifactDigest &&
    timeline.correlationId === correlationId
  );
}

/**
 * Called on the installed CLI's `--correlation-id --json` view: the validated timeline of one
 * correlation of the same report, the input `keiko investigate --from-timeline` reads.
 */
export function customerShapeSupportTimelineEvidence(timeline, report, correlationId, op) {
  if (
    !timelineOfReport(timeline, report, correlationId) ||
    !Array.isArray(timeline.lines) ||
    !timeline.lines.some((line) => line.op === op)
  )
    throw new TypeError("support report timeline is not the validated view of its correlation");
  return { lineCount: timeline.lines.length, sufficiency: reportSufficiency(timeline.sufficiency) };
}

/** Called on the installed CLI's validated machine view; emits only closed values and counts. */
export function customerShapeSupportReportEvidence(report, evidence, runId, bytes, forbidden) {
  assertReportEnvelope(report);
  const serialized = JSON.stringify(report);
  if (forbidden.some((value) => value.length > 0 && serialized.includes(value)))
    throw new Error("support report analysis retained prohibited synthetic content");
  const selection = reportSufficiency(report.selection);
  const sufficiency = reportSufficiency(report.analysis.sufficiency);
  const correlations = customerShapeSupportReportCorrelations(report, evidence, runId);
  const diagnostic = reconstructedDiagnostic(report, evidence, correlations);
  const failure = reconstructedFailure(report, evidence, correlations);
  const seed = reconstructedSeed(report, correlations.runId);
  return {
    selection,
    sufficiency,
    partialOperations: partialReportOperations(report),
    reportBytes: bytes,
    recordCount: report.analysis.evidence.supportedLineCount,
    errorKind: diagnostic.errorKind,
    failureCode: failure.extra.failureCode,
    frameCount: diagnostic.frames.length,
    causeCount: diagnostic.causeChain?.length ?? 0,
    seedLineCount: seed.timeline.length,
    gatewayAttemptCount: seed.gatewayScript?.attempts.length ?? 0,
    seedWarningCount: seed.warnings.length,
  };
}
