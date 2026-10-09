import {
  ContextOverflowError,
  GatewayError,
  ProviderError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import type { GatewayCallRequest } from "./gateway.js";
import type { UsageMetadata } from "./types.js";

/** Caller authority refusal, even when an earlier compatibility request reached the provider. */
export class CallerAttemptAdmissionError extends ContextOverflowError {}

export function settleCallerAttempt(
  reservation: ReturnType<NonNullable<GatewayCallRequest["attemptAdmission"]>>,
  usage: Pick<UsageMetadata, "promptTokens" | "completionTokens"> | undefined,
  dispatched: boolean,
  outputState: "observed" | "none" | "unknown" = usage === undefined ? "unknown" : "observed",
): void {
  reservation?.settle(usage, dispatched, outputState);
}

export function settleFailedCallerAttempt(
  reservation: ReturnType<NonNullable<GatewayCallRequest["attemptAdmission"]>>,
  failure: unknown,
  dispatched: boolean,
): void {
  settleCallerAttempt(
    reservation,
    failedCallerAttemptUsage(failure),
    dispatched,
    failedCallerOutputState(failure),
  );
}

export function callerAdmittedRequest(
  request: GatewayCallRequest,
  reservation: ReturnType<NonNullable<GatewayCallRequest["attemptAdmission"]>>,
): GatewayCallRequest {
  const limit = reservation?.maxOutputTokens;
  if (limit === undefined) return request;
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    (request.maxOutputTokens !== undefined && limit > request.maxOutputTokens)
  )
    throw new CallerAttemptAdmissionError("Caller output grant must narrow the requested cap");
  return { ...request, maxOutputTokens: limit };
}

function failedCallerOutputState(failure: unknown): "observed" | "none" | "unknown" {
  if (failure instanceof GatewayError && (failure.partialUsage?.completionTokens ?? 0) > 0)
    return "observed";
  if (failure instanceof ContextOverflowError && failure.partialUsage === undefined) return "none";
  if (
    failure instanceof ProviderError &&
    failure.httpStatus >= 400 &&
    failure.partialUsage === undefined
  )
    return "none";
  return "unknown";
}

function failedCallerAttemptUsage(
  failure: unknown,
): Pick<UsageMetadata, "promptTokens" | "completionTokens"> | undefined {
  return failure instanceof GatewayError ? failure.partialUsage : undefined;
}

export function onceCallerReservation(
  reservation: NonNullable<ReturnType<NonNullable<GatewayCallRequest["attemptAdmission"]>>>,
): typeof reservation {
  let settled = false;
  return {
    ...reservation,
    settle(usage, dispatched, outputState): void {
      if (settled) return;
      settled = true;
      reservation.settle(usage, dispatched, outputState);
    },
  };
}
