import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUALITY_INTELLIGENCE_CIRCUIT_BREAKER_CONFIG,
  createCircuitBreakerState,
  shouldAttempt,
  transitionOn,
} from "../circuitBreaker.js";

const CONFIG = {
  failureThreshold: 3,
  cooldownMs: 1_000,
  halfOpenProbes: 1,
};

describe("Quality Intelligence circuit breaker", () => {
  it("starts closed and shouldAttempt is true", () => {
    const initial = createCircuitBreakerState();
    expect(initial.state).toBe("closed");
    expect(shouldAttempt(initial)).toBe(true);
  });

  it("opens after consecutive failures reach the threshold", () => {
    let state = createCircuitBreakerState();
    state = transitionOn(state, { kind: "failure" }, CONFIG, 100);
    state = transitionOn(state, { kind: "failure" }, CONFIG, 200);
    expect(state.state).toBe("closed");
    state = transitionOn(state, { kind: "failure" }, CONFIG, 300);
    expect(state.state).toBe("open");
    expect(state.openedAtMs).toBe(300);
    expect(shouldAttempt(state)).toBe(false);
  });

  it("success resets consecutive failures and closes the circuit", () => {
    let state = createCircuitBreakerState();
    state = transitionOn(state, { kind: "failure" }, CONFIG, 1);
    state = transitionOn(state, { kind: "failure" }, CONFIG, 2);
    state = transitionOn(state, { kind: "success" }, CONFIG, 3);
    expect(state.state).toBe("closed");
    expect(state.consecutiveFailures).toBe(0);
  });

  it("transitions to half-open after a tick past the cooldown", () => {
    let state = createCircuitBreakerState();
    for (let i = 0; i < 3; i++) {
      state = transitionOn(state, { kind: "failure" }, CONFIG, 100);
    }
    expect(state.state).toBe("open");
    state = transitionOn(state, { kind: "tick", nowMs: 500 }, CONFIG);
    expect(state.state).toBe("open");
    state = transitionOn(state, { kind: "tick", nowMs: 1_200 }, CONFIG);
    expect(state.state).toBe("half-open");
  });

  it("half-open failure re-opens; half-open success closes", () => {
    let state = createCircuitBreakerState();
    for (let i = 0; i < 3; i++) {
      state = transitionOn(state, { kind: "failure" }, CONFIG, 100);
    }
    state = transitionOn(state, { kind: "tick", nowMs: 2_000 }, CONFIG);
    expect(state.state).toBe("half-open");
    const reopened = transitionOn(state, { kind: "failure" }, CONFIG, 2_100);
    expect(reopened.state).toBe("open");
    const reclosed = transitionOn(state, { kind: "success" }, CONFIG, 2_100);
    expect(reclosed.state).toBe("closed");
  });

  it("uses default config when none is supplied", () => {
    expect(DEFAULT_QUALITY_INTELLIGENCE_CIRCUIT_BREAKER_CONFIG.failureThreshold).toBeGreaterThan(0);
    const initial = createCircuitBreakerState();
    const next = transitionOn(initial, { kind: "success" });
    expect(next.state).toBe("closed");
  });
});
