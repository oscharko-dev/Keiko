import { ACTIVITY_LOG_ERROR_KINDS } from "../../packages/keiko-contracts/dist/observability.js";

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
const DIAGNOSTIC_OPERATIONS = new Set([
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
    requests: requests.slice(firstRequest, firstRequest + 12).map((request) => ({
      stream: request.stream === true,
      hasStreamOptions: request.hasStreamOptions === true,
      delayed: request.delayed === true,
      truncated: request.truncated === true,
      deliveredToolCall: request.deliveredToolCall === true,
    })),
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
