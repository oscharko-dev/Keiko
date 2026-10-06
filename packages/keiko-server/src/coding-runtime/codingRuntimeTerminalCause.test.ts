import { describe, expect, it } from "vitest";
import type { CodingWorkbenchTurnFailureCode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import {
  classifyTerminalFailure,
  terminalFailureErrorKind,
  type CodingRuntimeTerminalFacts,
} from "./codingRuntimeTerminalCause.js";

function facts(
  lastModelCallFailure: CodingWorkbenchTurnFailureCode | undefined,
  bounds: { readonly allowance?: boolean; readonly duration?: boolean } = {},
): CodingRuntimeTerminalFacts {
  return {
    promptAllowanceExhausted: (runId) => runId === "run-1" && bounds.allowance === true,
    envelopeDurationExhausted: (runId) => runId === "run-1" && bounds.duration === true,
    lastModelCallFailure: (runId) => (runId === "run-1" ? lastModelCallFailure : undefined),
  };
}

// F9 (#3873, live Gemma qualification): run `run-65084062444586162471229658028402064666` exhausted
// its prompt allowance and run `run-272120967981827964065820685403290179367` reached its 30-minute
// envelope; both were shown as "The coding run ended with an internal error". The terminal cause is
// read from the layers that own the facts, and `runtime-failed` remains only for a run with no
// bound or model-call cause on record.
describe("classifyTerminalFailure", () => {
  it("names the exhausted prompt allowance ahead of the turn rejection it caused", () => {
    expect(classifyTerminalFailure(facts("turn-rejected", { allowance: true }), "run-1")).toEqual({
      failureCode: "prompt-allowance-exhausted",
      basis: "prompt-allowance",
      modelCallFailure: "turn-rejected",
    });
    expect(classifyTerminalFailure(facts(undefined, { allowance: true }), "run-1")).toEqual({
      failureCode: "prompt-allowance-exhausted",
      basis: "prompt-allowance",
    });
  });

  it("names an envelope that ran out of time, with or without a failed call on record", () => {
    // The evidence run: the envelope's end cancelled the call in flight, so no call failed.
    expect(classifyTerminalFailure(facts(undefined, { duration: true }), "run-1")).toEqual({
      failureCode: "envelope-duration-exhausted",
      basis: "envelope-duration",
    });
    // A call refused after the end reads as a rejected turn; the bound behind it names the run.
    expect(classifyTerminalFailure(facts("turn-rejected", { duration: true }), "run-1")).toEqual({
      failureCode: "envelope-duration-exhausted",
      basis: "envelope-duration",
      modelCallFailure: "turn-rejected",
    });
  });

  it("names the allowance that refused the run's last call ahead of a later envelope end", () => {
    expect(
      classifyTerminalFailure(facts(undefined, { allowance: true, duration: true }), "run-1"),
    ).toMatchObject({ failureCode: "prompt-allowance-exhausted", basis: "prompt-allowance" });
  });

  it("names an unreachable or stalled provider as unavailable, never as a rejection", () => {
    expect(classifyTerminalFailure(facts("stream-incomplete"), "run-1")).toEqual({
      failureCode: "provider-unavailable",
      basis: "model-call-failure",
      modelCallFailure: "stream-incomplete",
    });
  });

  it("names a repeated output exhaustion by itself", () => {
    expect(classifyTerminalFailure(facts("output-exhausted"), "run-1")).toEqual({
      failureCode: "output-exhausted-repeated",
      basis: "model-call-failure",
      modelCallFailure: "output-exhausted",
    });
  });

  it.each(["provider-failed", "turn-rejected", "empty-answer", "invalid-tool-call"] as const)(
    "defers a %s model call to the cause its failed turn names",
    (failure) => {
      expect(classifyTerminalFailure(facts(failure), "run-1")).toEqual({
        failureCode: "model-turn-failed",
        basis: "model-call-failure",
        modelCallFailure: failure,
      });
    },
  );

  it("keeps runtime-failed for a run with no bound or model-call cause on record", () => {
    expect(classifyTerminalFailure(facts(undefined), "run-1")).toEqual({
      failureCode: "runtime-failed",
      basis: "no-model-call-failure",
    });
    expect(
      classifyTerminalFailure(
        facts("stream-incomplete", { allowance: true, duration: true }),
        "run-other",
      ),
    ).toEqual({ failureCode: "runtime-failed", basis: "no-model-call-failure" });
  });
});

describe("terminalFailureErrorKind", () => {
  it("states each cause's error class instead of an internal failure", () => {
    const kind = (
      failure: CodingWorkbenchTurnFailureCode | undefined,
      bounds: { readonly allowance?: boolean; readonly duration?: boolean } = {},
    ): string => terminalFailureErrorKind(classifyTerminalFailure(facts(failure, bounds), "run-1"));
    expect(kind(undefined, { allowance: true })).toBe("authority-denied");
    expect(kind("turn-rejected", { duration: true })).toBe("timeout");
    expect(kind("stream-incomplete")).toBe("unavailable");
    expect(kind("turn-rejected")).toBe("validation-failed");
    expect(kind("empty-answer")).toBe("unavailable");
    expect(kind("output-exhausted")).toBe("unavailable");
    expect(kind(undefined)).toBe("internal");
  });
});
