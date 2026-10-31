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

// A check that ran to its own end and reported failure: a non-zero exit, no signal and no limit
// that cut it short. A truncated output summary still carries the check's own verdict.
function failedStep(result: VerificationResult): boolean {
  return (
    result.status === "failed" &&
    result.exitCode !== null &&
    result.exitCode !== 0 &&
    result.signal === null &&
    !result.appliedLimits.some((limit) => limit.breached === true)
  );
}

function reportIntact(report: VerificationReport, startedAtMs: number, nowMs: number): boolean {
  return [
    report.startedAtMs >= startedAtMs,
    report.startedAtMs <= nowMs,
    Number.isFinite(report.durationMs) && report.durationMs >= 0,
    Object.entries(report.counts).every(
      ([status, count]) =>
        report.results.filter((result) => result.status === status).length === count,
    ),
  ].every(Boolean);
}

/** A summary label cannot turn a denied, cancelled, incomplete or stale check into proof. */
export function commitVerificationReportPassed(
  report: VerificationReport,
  startedAtMs: number,
  nowMs: number,
): boolean {
  return (
    report.overallStatus === "passed" &&
    reportIntact(report, startedAtMs, nowMs) &&
    report.results.some((result) => result.status === "passed") &&
    report.results.every(successfulStep)
  );
}

/**
 * A verification that ran every check to its end and found at least one failing (#3907): failing
 * evidence about the candidate, never a proof. A denied, cancelled, timed-out, limit-breached or
 * entirely skipped run says nothing about the candidate and is neither.
 */
export function commitVerificationReportFailed(
  report: VerificationReport,
  startedAtMs: number,
  nowMs: number,
): boolean {
  return (
    report.overallStatus === "failed" &&
    reportIntact(report, startedAtMs, nowMs) &&
    report.results.some(failedStep) &&
    report.results.every((result) => successfulStep(result) || failedStep(result))
  );
}
