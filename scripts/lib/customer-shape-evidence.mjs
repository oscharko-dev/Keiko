export function customerShapeRequestEvidence(requests, firstRequest) {
  const current = requests.slice(firstRequest);
  return {
    rejectedOptionalField: current.some((request) => request.stream && request.hasStreamOptions),
    compatibleRetry: current.some((request) => request.stream && !request.hasStreamOptions),
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
    lines.some(
      (line) =>
        line.op === "coding-sidecar.gateway.outcome" &&
        line.outcome === "accepted" &&
        line.parentCorrelationId === runId &&
        line.correlationId === usage.correlationId,
    )
  );
}
