import { describe, expect, it } from "vitest";

import {
  decideCodingRuntimeModeChange,
  type CodingRuntimeModeChangeInput,
} from "./codingRuntimeModeChangeGate.js";

function input(overrides: Partial<CodingRuntimeModeChangeInput>): CodingRuntimeModeChangeInput {
  return {
    currentState: "idle",
    currentRequestedMode: "supervised-coding",
    requestedMode: "supervised-coding",
    deploymentCeiling: "autonomous-delivery",
    ...overrides,
  };
}

describe("decideCodingRuntimeModeChange", () => {
  it("admits a narrowing change while paused", () => {
    expect(
      decideCodingRuntimeModeChange(
        input({
          currentState: "paused",
          currentRequestedMode: "autonomous-delivery",
          requestedMode: "governed-assist",
        }),
      ),
    ).toEqual({ ok: true, effectiveMode: "governed-assist" });
  });

  it("admits a widening change from idle", () => {
    expect(
      decideCodingRuntimeModeChange(
        input({
          currentState: "idle",
          currentRequestedMode: "governed-assist",
          requestedMode: "autonomous-delivery",
        }),
      ),
    ).toEqual({ ok: true, effectiveMode: "autonomous-delivery" });
  });

  it("rejects a widening change while paused: a stop is required first", () => {
    expect(
      decideCodingRuntimeModeChange(
        input({
          currentState: "paused",
          currentRequestedMode: "governed-assist",
          requestedMode: "autonomous-delivery",
        }),
      ),
    ).toEqual({ ok: false, reasonCode: "widening-requires-stop" });
  });

  it.each<CodingRuntimeModeChangeInput["currentState"]>([
    "running",
    "awaiting-approval",
    "starting",
    "ready",
    "stopping",
  ])("rejects any mode change while %s", (currentState) => {
    expect(
      decideCodingRuntimeModeChange(input({ currentState, requestedMode: "governed-assist" })),
    ).toEqual({ ok: false, reasonCode: "mode-change-requires-idle-or-paused" });
  });

  it("clamps widening detection to the deployment ceiling", () => {
    // Requesting autonomous while the ceiling is supervised is NOT a widening beyond the current
    // supervised posture, so it is admissible while paused.
    expect(
      decideCodingRuntimeModeChange(
        input({
          currentState: "paused",
          currentRequestedMode: "supervised-coding",
          requestedMode: "autonomous-delivery",
          deploymentCeiling: "supervised-coding",
        }),
      ),
    ).toEqual({ ok: true, effectiveMode: "supervised-coding" });
  });
});
