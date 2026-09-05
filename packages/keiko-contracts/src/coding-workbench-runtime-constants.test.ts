import { describe, expect, it } from "vitest";

import {
  CODING_WORKBENCH_RUNTIME_FAILURE_CODES,
  type CodingWorkbenchRuntimeFailureCode,
} from "./coding-workbench-runtime-constants.js";

// #3390: a start against a durable issue binding with no fresh pasted reference re-resolves the
// attachment through the same authorized reader the preview uses; when that re-resolution fails,
// the orchestrator refuses with this new closed code rather than the generic "invalid-intent" so
// the Workbench can render a specific, actionable message instead of starting a context-free run.
describe("CODING_WORKBENCH_RUNTIME_FAILURE_CODES", () => {
  it("carries the issue-context-unavailable closed code", () => {
    expect(CODING_WORKBENCH_RUNTIME_FAILURE_CODES).toContain("issue-context-unavailable");
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
