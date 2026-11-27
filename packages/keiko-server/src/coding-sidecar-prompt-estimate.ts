import {
  PromptCalibrationLedger,
  promptCalibrationMark,
  type PromptCalibrationMark,
} from "@oscharko-dev/keiko-model-gateway/internal/prompt-calibration";
import {
  countGatewayPromptTokens,
  type GatewayPromptTokenInput,
  type ModelTokenAccounting,
} from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";

/** Where the figure a sidecar request is admitted against came from. */
export type RoutePromptEstimateSource = "local" | "usage-calibrated";

export interface RoutePromptEstimate {
  /** What the route admits against: the calibrated figure when one exists, else the local one. */
  readonly tokens: number;
  /** The local tokenizer's estimate of the whole prompt, kept for the log line. */
  readonly localTokens: number;
  readonly source: RoutePromptEstimateSource;
  /** What the provider's reported usage is recorded against once the call settles. */
  readonly mark: PromptCalibrationMark;
}

// The ONE calibration owner is the model-gateway's `PromptCalibrationLedger`; this is its instance
// for the route, which sees the request before the gateway builds its provider payload. It holds
// digests and counts only.
const ledger = new PromptCalibrationLedger();
const estimates = new WeakMap<object, RoutePromptEstimate>();

/**
 * The prompt estimate of a parsed sidecar request. A request that provably extends one whose
 * provider usage is known is estimated as that usage plus the estimated growth, so a tokenizer that
 * over-counts repetitive text cannot refuse a prompt that fits. Anything else keeps the
 * conservative local estimate. The estimate is remembered against the request object itself.
 */
export function estimateRoutePrompt(
  parsed: GatewayPromptTokenInput,
  accounting: ModelTokenAccounting | undefined,
  calibrationKey: string,
): number {
  const localTokens = countGatewayPromptTokens(parsed, accounting);
  const calibrated = ledger.calibrate(calibrationKey, parsed, localTokens);
  const estimate: RoutePromptEstimate = {
    tokens: calibrated ?? localTokens,
    localTokens,
    source: calibrated === undefined ? "local" : "usage-calibrated",
    mark: promptCalibrationMark(calibrationKey, parsed, localTokens),
  };
  estimates.set(parsed, estimate);
  return estimate.tokens;
}

export function routePromptEstimateOf(parsed: object): RoutePromptEstimate | undefined {
  return estimates.get(parsed);
}

/** Records the provider's real prompt usage of an admitted request for later calibration. */
export function recordRoutePromptUsage(
  mark: PromptCalibrationMark | undefined,
  providerPromptTokens: number,
): void {
  if (mark !== undefined) ledger.record(mark, providerPromptTokens);
}

/** Test seam: parallel test files hold their own module instance; a reset keeps cases independent. */
export function _resetRoutePromptCalibrationForTests(): void {
  ledger.reset();
}
