import { describe, expect, it } from "vitest";
import { createInitialCodingWorkbenchRuntimeState } from "@/lib/coding-workbench-live-state";
import type { CodingWorkbenchRuntimeState } from "@/lib/coding-workbench-live-state";
import { confirmedMode } from "./CodingWorkbenchWindow";

function stateWith(
  run: { readonly state: string; readonly effectiveMode: string } | null,
  readiness: { readonly effectiveMode: string; readonly liveRunAnchored?: true } | null,
): CodingWorkbenchRuntimeState {
  return {
    ...createInitialCodingWorkbenchRuntimeState(),
    run: { status: run === null ? "idle" : "ready", value: run, error: null },
    runtime: { status: readiness === null ? "idle" : "ready", value: readiness, error: null },
  } as unknown as CodingWorkbenchRuntimeState;
}

// U-37: a readiness answer anchored to a live run states that run's posture; once the run has ended
// the composer must not keep claiming it for the next run.
describe("confirmedMode", () => {
  it("states the active run's own mode", () => {
    const state = stateWith(
      { state: "running", effectiveMode: "autonomous-delivery" },
      { effectiveMode: "governed-assist" },
    );
    expect(confirmedMode(state)).toBe("autonomous-delivery");
  });

  it("does not state an anchored readiness mode once no run is active", () => {
    const state = stateWith(
      { state: "succeeded", effectiveMode: "autonomous-delivery" },
      { effectiveMode: "autonomous-delivery", liveRunAnchored: true },
    );
    expect(confirmedMode(state)).toBeNull();
  });

  // The anchored answer may exceed the selected mode (it states a live run's wider posture). With no
  // live run in this window's state it must never surface as the authority the next run will hold.
  it("never shows an anchored readiness mode as wider authority when no live run is known", () => {
    for (const run of [null, { state: "failed", effectiveMode: "autonomous-delivery" }]) {
      const state = stateWith(run, {
        effectiveMode: "autonomous-delivery",
        liveRunAnchored: true,
      });
      expect(confirmedMode(state)).toBeNull();
    }
  });

  it("states an unanchored readiness mode when no run is active", () => {
    expect(confirmedMode(stateWith(null, { effectiveMode: "governed-assist" }))).toBe(
      "governed-assist",
    );
  });
});
