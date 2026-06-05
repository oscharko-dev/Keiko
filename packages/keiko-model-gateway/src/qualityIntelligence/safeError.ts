// Safe-error shapes for the Quality Intelligence dispatcher (Epic #270, Issue #279).
//
// Errors that escape the dispatcher MUST NOT carry secrets, raw prompts, deployment endpoints,
// or untrusted-evidence text. Each error is a discriminated union member carrying only the
// minimum reason metadata callers need to branch on. The `message` field is a short,
// statically-derived phrase — never templated with a value from the request.
//
// The QI namespace deliberately uses a flat, code-prefixed error taxonomy ("qi/*") so the
// audit ledger (issue #10) and the BFF (issue #166) can route safely without parsing.

export type QualityIntelligenceSafeErrorCode =
  | "qi/capability-mismatch"
  | "qi/budget-exhausted"
  | "qi/timeout"
  | "qi/cancelled"
  | "qi/provider-error"
  | "qi/redaction-failed";

interface SafeErrorBase<TCode extends QualityIntelligenceSafeErrorCode> {
  readonly code: TCode;
  readonly message: string;
}

export interface QualityIntelligenceCapabilityMismatchError extends SafeErrorBase<"qi/capability-mismatch"> {
  readonly profileId: string;
  readonly missingCapabilities: readonly string[];
}

export interface QualityIntelligenceBudgetExhaustedError extends SafeErrorBase<"qi/budget-exhausted"> {
  readonly profileId: string;
}

export interface QualityIntelligenceTimeoutError extends SafeErrorBase<"qi/timeout"> {
  readonly profileId: string;
  readonly timeoutMs: number;
}

export interface QualityIntelligenceCancelledError extends SafeErrorBase<"qi/cancelled"> {
  readonly profileId: string;
}

export interface QualityIntelligenceProviderError extends SafeErrorBase<"qi/provider-error"> {
  readonly profileId: string;
}

export interface QualityIntelligenceRedactionFailedError extends SafeErrorBase<"qi/redaction-failed"> {
  readonly profileId: string;
}

export type QualityIntelligenceSafeError =
  | QualityIntelligenceCapabilityMismatchError
  | QualityIntelligenceBudgetExhaustedError
  | QualityIntelligenceTimeoutError
  | QualityIntelligenceCancelledError
  | QualityIntelligenceProviderError
  | QualityIntelligenceRedactionFailedError;

// Thin throwable wrapper so call sites can `throw` while preserving the safe shape.
// Instances of this class carry ONLY the safe payload — never raw inputs.
export class QualityIntelligenceSafeErrorException extends Error {
  public readonly safe: QualityIntelligenceSafeError;

  public constructor(safe: QualityIntelligenceSafeError) {
    super(safe.message);
    this.name = "QualityIntelligenceSafeErrorException";
    this.safe = safe;
  }
}

export function makeCapabilityMismatchError(
  profileId: string,
  missingCapabilities: readonly string[],
): QualityIntelligenceCapabilityMismatchError {
  return Object.freeze({
    code: "qi/capability-mismatch" as const,
    message: "Model does not satisfy the Quality Intelligence task profile capabilities.",
    profileId,
    missingCapabilities: Object.freeze([...missingCapabilities]),
  });
}

export function makeBudgetExhaustedError(
  profileId: string,
): QualityIntelligenceBudgetExhaustedError {
  return Object.freeze({
    code: "qi/budget-exhausted" as const,
    message: "Token budget exhausted for the Quality Intelligence run.",
    profileId,
  });
}

export function makeTimeoutError(
  profileId: string,
  timeoutMs: number,
): QualityIntelligenceTimeoutError {
  return Object.freeze({
    code: "qi/timeout" as const,
    message: "Quality Intelligence model call exceeded the profile timeout.",
    profileId,
    timeoutMs,
  });
}

export function makeCancelledError(profileId: string): QualityIntelligenceCancelledError {
  return Object.freeze({
    code: "qi/cancelled" as const,
    message: "Quality Intelligence model call was cancelled.",
    profileId,
  });
}

export function makeProviderError(profileId: string): QualityIntelligenceProviderError {
  return Object.freeze({
    code: "qi/provider-error" as const,
    message: "Quality Intelligence provider returned an error.",
    profileId,
  });
}

export function makeRedactionFailedError(
  profileId: string,
): QualityIntelligenceRedactionFailedError {
  return Object.freeze({
    code: "qi/redaction-failed" as const,
    message: "Quality Intelligence evidence redaction failed.",
    profileId,
  });
}
