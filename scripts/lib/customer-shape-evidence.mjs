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
