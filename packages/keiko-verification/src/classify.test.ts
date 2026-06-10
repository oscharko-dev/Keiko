import { describe, expect, it } from "vitest";
import {
  CommandCancelledError,
  CommandDeniedError,
  CommandTimeoutError,
} from "@oscharko-dev/keiko-tools";
import type { CommandResult } from "@oscharko-dev/keiko-tools";
import { classifyOutcome } from "./classify.js";

function result(overrides: Partial<CommandResult>): CommandResult {
  return {
    command: "npm",
    args: ["test"],
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}

describe("classifyOutcome — precedence (ADR-0007 D1), each branch independent", () => {
  it("branch 1: a pre-marked skip wins over everything else", () => {
    expect(
      classifyOutcome({
        skipped: true,
        result: result({ exitCode: 0 }),
        error: new CommandDeniedError("denied", "npm"),
        abortReason: "memory",
      }),
    ).toBe("skipped");
  });

  it("branch 2: CommandDeniedError → denied, even under a memory abort", () => {
    expect(
      classifyOutcome({
        skipped: false,
        result: undefined,
        error: new CommandDeniedError("denied", "npm"),
        abortReason: "memory",
      }),
    ).toBe("denied");
  });

  it("branch 3: abortReason memory (non-denied error) → resource-exceeded", () => {
    expect(
      classifyOutcome({
        skipped: false,
        result: undefined,
        error: new CommandTimeoutError("t", 1),
        abortReason: "memory",
      }),
    ).toBe("resource-exceeded");
  });

  it("branch 4: abortReason harness (non-denied, non-timeout error) → cancelled", () => {
    expect(
      classifyOutcome({
        skipped: false,
        result: undefined,
        error: new Error("boom"),
        abortReason: "harness",
      }),
    ).toBe("cancelled");
  });

  it("branch 5: CommandTimeoutError without a memory/harness abort → timed-out", () => {
    expect(
      classifyOutcome({
        skipped: false,
        result: undefined,
        error: new CommandTimeoutError("t", 1),
        abortReason: undefined,
      }),
    ).toBe("timed-out");
  });

  it("branch 6a: CommandCancelledError with no reason → cancelled", () => {
    expect(
      classifyOutcome({
        skipped: false,
        result: undefined,
        error: new CommandCancelledError("c"),
        abortReason: undefined,
      }),
    ).toBe("cancelled");
  });

  it("branch 7: any other error → failed", () => {
    expect(
      classifyOutcome({
        skipped: false,
        result: undefined,
        error: new Error("spawn ENOENT"),
        abortReason: undefined,
      }),
    ).toBe("failed");
  });

  it("branch 8: resolved timedOut → timed-out", () => {
    expect(
      classifyOutcome({
        skipped: false,
        result: result({ timedOut: true, exitCode: null }),
        error: undefined,
        abortReason: undefined,
      }),
    ).toBe("timed-out");
  });

  it("branch 9: resolved truncated → resource-exceeded", () => {
    expect(
      classifyOutcome({
        skipped: false,
        result: result({ truncated: true, exitCode: null }),
        error: undefined,
        abortReason: undefined,
      }),
    ).toBe("resource-exceeded");
  });

  it("branch 10: resolved exit 0 → passed", () => {
    expect(
      classifyOutcome({
        skipped: false,
        result: result({ exitCode: 0 }),
        error: undefined,
        abortReason: undefined,
      }),
    ).toBe("passed");
  });

  it("branch 11: resolved non-zero exit → failed", () => {
    expect(
      classifyOutcome({
        skipped: false,
        result: result({ exitCode: 1 }),
        error: undefined,
        abortReason: undefined,
      }),
    ).toBe("failed");
  });

  it("timedOut takes precedence over truncated on a resolved result", () => {
    expect(
      classifyOutcome({
        skipped: false,
        result: result({ timedOut: true, truncated: true, exitCode: null }),
        error: undefined,
        abortReason: undefined,
      }),
    ).toBe("timed-out");
  });

  it("denied takes precedence over timeout error", () => {
    expect(
      classifyOutcome({
        skipped: false,
        result: undefined,
        error: new CommandDeniedError("denied", "npm"),
        abortReason: undefined,
      }),
    ).toBe("denied");
  });

  it("fallback: no result and no error → failed (documents the unreachable-but-total branch)", () => {
    // classify.ts returns "failed" defensively when neither result nor error is present.
    // This test catches a mutation of that line (e.g. returning "skipped" or throwing).
    expect(
      classifyOutcome({
        skipped: false,
        result: undefined,
        error: undefined,
        abortReason: undefined,
      }),
    ).toBe("failed");
  });
});
