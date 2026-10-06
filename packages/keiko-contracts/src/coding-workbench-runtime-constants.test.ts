import { describe, expect, it } from "vitest";

import {
  CODING_WORKBENCH_RUNTIME_FAILURE_CODES,
  type CodingWorkbenchRuntimeFailureCode,
} from "./coding-workbench-runtime-constants.js";

// F9 (#3873): the closed causes a failed run settles with instead of `runtime-failed` (an internal
// error): its own bounds, a repeated output exhaustion, an unreachable provider, a failed model call.
const TERMINAL_RUN_CAUSES = [
  "prompt-allowance-exhausted",
  "envelope-duration-exhausted",
  "output-exhausted-repeated",
  "provider-unavailable",
  "model-turn-failed",
] as const;

// #3390: a start against a durable issue binding with no fresh pasted reference re-resolves the
// attachment through the same authorized reader the preview uses; when that re-resolution fails,
// the orchestrator refuses with this new closed code rather than the generic "invalid-intent" so
// the Workbench can render a specific, actionable message instead of starting a context-free run.
describe("CODING_WORKBENCH_RUNTIME_FAILURE_CODES", () => {
  it("carries the issue-context-unavailable closed code", () => {
    expect(CODING_WORKBENCH_RUNTIME_FAILURE_CODES).toContain("issue-context-unavailable");
  });

  // Owner audit finding F-question-answer-rejected (PR #3394): a free-text answer to a question
  // whose options carry no `custom` flag is refused by the runtime reply itself; this closed code
  // lets the coordinator distinguish that runtime rejection from a real authority failure.
  it("carries the question-answer-rejected closed code", () => {
    expect(CODING_WORKBENCH_RUNTIME_FAILURE_CODES).toContain("question-answer-rejected");
  });

  // F9 (#3873): the terminal causes a run that ended on one of its bounds or on a failed model call
  // settles with, so the Workbench never presents an exhausted bound or an unreachable provider as
  // an internal error.
  it.each(TERMINAL_RUN_CAUSES)("carries the %s terminal cause", (failureCode) => {
    expect(CODING_WORKBENCH_RUNTIME_FAILURE_CODES).toContain(failureCode);
  });

  it("is a frozen array with no duplicate entries", () => {
    expect(Object.isFrozen(CODING_WORKBENCH_RUNTIME_FAILURE_CODES)).toBe(true);
    expect(new Set(CODING_WORKBENCH_RUNTIME_FAILURE_CODES).size).toBe(
      CODING_WORKBENCH_RUNTIME_FAILURE_CODES.length,
    );
  });

  it("keeps every listed value assignable to the closed union type", () => {
    const values: readonly CodingWorkbenchRuntimeFailureCode[] =
      CODING_WORKBENCH_RUNTIME_FAILURE_CODES;
    expect(values.length).toBeGreaterThan(0);
  });
});
