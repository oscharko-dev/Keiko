import { describe, expect, it } from "vitest";
import {
  ORCHESTRATION_ALLOWED_STATE_TRANSITIONS,
  ORCHESTRATION_CHILD_OUTCOMES,
  ORCHESTRATION_CHILD_ROLES,
  ORCHESTRATION_EXECUTION_MODES,
  ORCHESTRATION_RUN_KINDS,
  ORCHESTRATION_SCHEMA_VERSION,
  ORCHESTRATION_SETTLEMENT_OUTCOMES,
  ORCHESTRATION_SETTLEMENT_STRATEGIES,
  ORCHESTRATION_STATES,
  ORCHESTRATION_TERMINAL_STATES,
  assertOrchestrationStateTransition,
  isOrchestrationStateTransitionAllowed,
} from "./orchestration.js";

describe("multi-agent orchestration contract", () => {
  it("exports the schema version and closed enumerations", () => {
    expect(ORCHESTRATION_SCHEMA_VERSION).toBe("1");
    expect(ORCHESTRATION_RUN_KINDS).toEqual(["single-run", "parent-run", "child-run"]);
    expect(ORCHESTRATION_EXECUTION_MODES).toContain("mixed");
    expect(ORCHESTRATION_STATES).toContain("merging");
    expect(ORCHESTRATION_TERMINAL_STATES.has("cancelled")).toBe(true);
    expect(ORCHESTRATION_CHILD_ROLES).toEqual([
      "planner",
      "implementer",
      "reviewer",
      "validator",
      "merger",
    ]);
    expect(ORCHESTRATION_CHILD_OUTCOMES).toContain("escalated");
    expect(ORCHESTRATION_SETTLEMENT_OUTCOMES).toContain("merged");
    expect(ORCHESTRATION_SETTLEMENT_STRATEGIES).toContain("escalate-to-reviewer");
  });

  it("allows the documented forward transitions", () => {
    expect(ORCHESTRATION_ALLOWED_STATE_TRANSITIONS.planning).toContain("ready");
    expect(isOrchestrationStateTransitionAllowed("dispatching", "running")).toBe(true);
    expect(isOrchestrationStateTransitionAllowed("running", "merging")).toBe(true);
    expect(isOrchestrationStateTransitionAllowed("cancelling", "cancelled")).toBe(true);
  });

  it("rejects invalid lifecycle jumps", () => {
    expect(isOrchestrationStateTransitionAllowed("planning", "running")).toBe(false);
    expect(assertOrchestrationStateTransition("planning", "running")).toEqual({
      from: "planning",
      to: "running",
      reason: "Illegal orchestration transition: planning -> running",
    });
  });

  it("treats terminal states as terminal", () => {
    for (const state of ORCHESTRATION_TERMINAL_STATES) {
      expect(isOrchestrationStateTransitionAllowed(state, "running")).toBe(false);
    }
  });
});
