import type { VerificationReport, VerificationResult } from "@oscharko-dev/keiko-contracts";

function successfulStep(result: VerificationResult): boolean {
  if (result.status === "skipped") return result.exitCode === null && result.signal === null;
  return (
    result.status === "passed" &&
    result.exitCode === 0 &&
    result.signal === null &&
    !result.truncated &&
    !result.appliedLimits.some((limit) => limit.breached === true)
  );
}

/** A summary label cannot turn a denied, cancelled, incomplete or stale check into proof. */
export function commitVerificationReportPassed(
  report: VerificationReport,
  startedAtMs: number,
  nowMs: number,
): boolean {
  return [
    report.overallStatus === "passed",
    report.startedAtMs >= startedAtMs,
    report.startedAtMs <= nowMs,
    Number.isFinite(report.durationMs) && report.durationMs >= 0,
    report.results.some((result) => result.status === "passed"),
    report.results.every(successfulStep),
    Object.entries(report.counts).every(
      ([status, count]) =>
        report.results.filter((result) => result.status === status).length === count,
    ),
  ].every(Boolean);
}
