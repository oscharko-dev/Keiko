import { expect, vi, type MockInstance } from "vitest";
import { ACTIVITY_LOG_UNKNOWN_CORRELATION_ID } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import type { ModelGatewayLogEvent } from "../observability.js";
import { GATEWAY_VOICE_TIMEOUT_FLOOR_MS } from "../resilience.js";

/** Makes `AbortSignal.timeout` at the voice floor return an already-fired timeout signal. */
export function fireVoiceTimeoutAtFloor(): MockInstance<typeof AbortSignal.timeout> {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    if (ms !== GATEWAY_VOICE_TIMEOUT_FLOOR_MS) return nativeTimeout(ms);
    const controller = new AbortController();
    controller.abort(new DOMException("the provider did not answer in time", "TimeoutError"));
    return controller.signal;
  });
}

/** A fetch body that fails the way a fetch on an already-fired signal does. */
export function rethrowAbortedRequest(_url: string, init: RequestInit): never {
  if (init.signal?.aborted === true) {
    const reason: unknown = init.signal.reason;
    throw reason instanceof Error ? reason : new Error("the aborted signal carried no error");
  }
  throw new Error("the request should have carried an already-aborted signal");
}

/** A healthy completion line joins its dispatch and carries no failure fields. */
export function expectHealthyVoiceCompletion(
  dispatch: ModelGatewayLogEvent | undefined,
  completed: ModelGatewayLogEvent | undefined,
  correlationId: string,
): void {
  expect(completed?.extra?.endpointDigest).toBe(dispatch?.extra?.endpointDigest);
  expect(completed?.correlationId).toBe(correlationId);
  expect(completed).not.toHaveProperty("errorKind");
  expect(completed?.extra).not.toHaveProperty("failureKind");
}

/** A rate-limited completion line for the invalid fixture endpoint, without a correlation. */
export function expectRateLimitedVoiceCompletion(
  completed: ModelGatewayLogEvent | undefined,
): void {
  expect(completed?.extra?.endpointDigest).toBe(sha256Hex("invalid-endpoint"));
  expect(completed?.extra?.failureKind).toBe("rate-limited");
  expect(completed?.errorKind).toBe("rate-limited");
  expect(completed?.correlationId).toBe(ACTIVITY_LOG_UNKNOWN_CORRELATION_ID);
}
