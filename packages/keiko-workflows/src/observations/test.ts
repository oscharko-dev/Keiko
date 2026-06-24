// Pure shaper: VerificationResult -> ShapedTestObservation (ADR-0054, PR3-W3, D4). No IO, no clock,
// no randomness. Total — never throws.
//
// HONEST SOURCE NOTE: the live VerificationResult (keiko-contracts/verification.ts) carries NO
// per-test structured data — no pass/fail/skip counts, no failing test names, no stack frames. Its
// outputSummary is a redacted DIGEST string (e.g. "command output captured (N bytes) and omitted
// from summary" — see keiko-verification/src/orchestrator.ts outputDigest), not a parseable test
// log, and the per-status counts on VerificationReport count STEPS, not individual tests. Per the
// PR3 constraint we do NOT invent counts or names: counts default to zeros and the name/frame arrays
// stay empty until a producer supplies genuinely structured data. The reliably-present fields we DO
// project: kind, status, exitCode, durationMs, truncated, and the redacted outputSummary.

import {
  type ShapedTestCounts,
  type ShapedTestObservation,
  type VerificationResult,
} from "@oscharko-dev/keiko-contracts";

import {
  boundExcerpt,
  buildToolRehydrationHandle,
  estimateTokens,
  injectionSignalsFor,
  makeObservationId,
} from "./shared.js";

export interface ShapeTestOptions {
  readonly observationId?: string | undefined;
}

const TRUNCATED_NOT_PERSISTED = "tool output not persisted in PR3 (artifact store wired in PR5)";

// VerificationResult has no per-test breakdown; the only honest count is all-zero. A future producer
// with structured test data populates this via a richer overload, not by inventing numbers here.
const EMPTY_COUNTS: ShapedTestCounts = { passed: 0, failed: 0, skipped: 0 };

export function shapeTestObservation(
  result: VerificationResult,
  opts?: ShapeTestOptions,
): ShapedTestObservation {
  const observationId = opts?.observationId ?? makeObservationId("");
  const outputSummary = boundExcerpt(result.outputSummary, Number.MAX_SAFE_INTEGER);
  const injection = injectionSignalsFor(outputSummary);
  return {
    kind: "test",
    observationId,
    verificationKind: result.kind,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    truncated: result.truncated,
    counts: EMPTY_COUNTS,
    failingTestNames: [],
    stackFrameExcerpts: [],
    outputSummary,
    injectionSignalCount: injection.count,
    hasCriticalInjectionSignal: injection.critical,
    ...(result.truncated
      ? {
          rehydration: buildToolRehydrationHandle({
            artifactSeed: `${observationId}:full`,
            itemCount: 1,
            approxTokens: estimateTokens(outputSummary),
            notPersistedReason: TRUNCATED_NOT_PERSISTED,
          }),
        }
      : {}),
  };
}
