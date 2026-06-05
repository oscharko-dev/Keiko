// Quality Intelligence circuit breaker (Epic #270, Issue #279).
//
// Pure half-open state machine. The dispatcher records each model call outcome via
// `transitionOn` and consults `state` to decide whether to attempt or skip a call. State is
// immutable; every transition returns a new value. Thresholds are configurable but default
// to a frozen constant tuned for QI workloads.

export type QualityIntelligenceCircuitState = "closed" | "open" | "half-open";

export interface QualityIntelligenceCircuitBreakerState {
  readonly state: QualityIntelligenceCircuitState;
  readonly consecutiveFailures: number;
  readonly openedAtMs: number | null;
}

export interface QualityIntelligenceCircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpenProbes: number;
}

export const DEFAULT_QUALITY_INTELLIGENCE_CIRCUIT_BREAKER_CONFIG: QualityIntelligenceCircuitBreakerConfig =
  Object.freeze({
    failureThreshold: 4,
    cooldownMs: 30_000,
    halfOpenProbes: 1,
  });

export function createCircuitBreakerState(): QualityIntelligenceCircuitBreakerState {
  return Object.freeze({
    state: "closed" as const,
    consecutiveFailures: 0,
    openedAtMs: null,
  });
}

export type QualityIntelligenceCircuitEvent =
  | { readonly kind: "success" }
  | { readonly kind: "failure" }
  | { readonly kind: "probe" }
  | { readonly kind: "tick"; readonly nowMs: number };

function onSuccess(): QualityIntelligenceCircuitBreakerState {
  return Object.freeze({
    state: "closed" as const,
    consecutiveFailures: 0,
    openedAtMs: null,
  });
}

function onFailure(
  state: QualityIntelligenceCircuitBreakerState,
  config: QualityIntelligenceCircuitBreakerConfig,
  nowMs: number,
): QualityIntelligenceCircuitBreakerState {
  const nextFailures = state.consecutiveFailures + 1;
  if (nextFailures >= config.failureThreshold) {
    return Object.freeze({
      state: "open" as const,
      consecutiveFailures: nextFailures,
      openedAtMs: nowMs,
    });
  }
  return Object.freeze({
    state: state.state === "half-open" ? ("open" as const) : state.state,
    consecutiveFailures: nextFailures,
    openedAtMs: state.state === "half-open" ? nowMs : state.openedAtMs,
  });
}

function onProbe(
  state: QualityIntelligenceCircuitBreakerState,
): QualityIntelligenceCircuitBreakerState {
  if (state.state === "open") {
    return Object.freeze({
      state: "half-open" as const,
      consecutiveFailures: state.consecutiveFailures,
      openedAtMs: state.openedAtMs,
    });
  }
  return state;
}

function onTick(
  state: QualityIntelligenceCircuitBreakerState,
  config: QualityIntelligenceCircuitBreakerConfig,
  nowMs: number,
): QualityIntelligenceCircuitBreakerState {
  if (state.state !== "open" || state.openedAtMs === null) {
    return state;
  }
  if (nowMs - state.openedAtMs >= config.cooldownMs) {
    return Object.freeze({
      state: "half-open" as const,
      consecutiveFailures: state.consecutiveFailures,
      openedAtMs: state.openedAtMs,
    });
  }
  return state;
}

export function transitionOn(
  state: QualityIntelligenceCircuitBreakerState,
  event: QualityIntelligenceCircuitEvent,
  config: QualityIntelligenceCircuitBreakerConfig = DEFAULT_QUALITY_INTELLIGENCE_CIRCUIT_BREAKER_CONFIG,
  nowMs = 0,
): QualityIntelligenceCircuitBreakerState {
  switch (event.kind) {
    case "success":
      return onSuccess();
    case "failure":
      return onFailure(state, config, nowMs);
    case "probe":
      return onProbe(state);
    case "tick":
      return onTick(state, config, event.nowMs);
  }
}

export function shouldAttempt(state: QualityIntelligenceCircuitBreakerState): boolean {
  return state.state !== "open";
}
