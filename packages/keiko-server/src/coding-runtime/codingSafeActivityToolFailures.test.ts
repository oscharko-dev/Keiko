import { describe, expect, it } from "vitest";

import {
  countFailedCall,
  countToolFailure,
  createToolFailureLedger,
  exitCodeClass,
  takeUnloggedFailure,
} from "./codingSafeActivityToolFailures.js";

describe("a run's failed tool calls", () => {
  it("counts how often the same command failed and never counts one call twice", () => {
    const ledger = createToolFailureLedger();
    expect(countToolFailure(ledger, "a", "npm test")).toBe(1);
    expect(countToolFailure(ledger, "b", "npm test")).toBe(2);
    expect(countToolFailure(ledger, "b", "npm test")).toBe(2);
    expect(countToolFailure(ledger, "c", "npm run lint")).toBe(1);
    expect(countToolFailure(ledger, "d", undefined)).toBe(1);
    expect(ledger.failedCalls).toBe(4);
    expect(ledger.repeatedFailures).toBe(1);
  });

  it("keeps no command in what it remembers", () => {
    const ledger = createToolFailureLedger();
    countToolFailure(ledger, "a", "echo private-value");
    expect(JSON.stringify([...ledger.byCommand.keys()])).not.toContain("private-value");
  });

  it("hands out one log line per failed call, from the counted signal", () => {
    const ledger = createToolFailureLedger();
    const call = { callId: "a", tool: "shell" };
    const facts = { origin: "command-failed", exitCode: 127, command: "npm tset" } as const;
    expect(countFailedCall(ledger, call, facts)).toBe(1);
    expect(takeUnloggedFailure(ledger)).toEqual({
      callId: "a",
      tool: "shell",
      origin: "command-failed",
      exitCode: 127,
      failureCount: 1,
    });
    expect(takeUnloggedFailure(ledger)).toBeUndefined();
    // A restatement of the same call keeps its count and writes no second line.
    expect(countFailedCall(ledger, call, facts)).toBe(1);
    expect(takeUnloggedFailure(ledger)).toBeUndefined();
    expect(ledger.failedCalls).toBe(1);
  });

  it("counts no call that succeeded or was stopped", () => {
    const ledger = createToolFailureLedger();
    const call = { callId: "a", tool: "shell" };
    expect(
      countFailedCall(ledger, call, { origin: undefined, exitCode: 0, command: "ls" }),
    ).toBeUndefined();
    expect(
      countFailedCall(ledger, call, { origin: "cancelled", exitCode: undefined, command: "ls" }),
    ).toBeUndefined();
    expect(takeUnloggedFailure(ledger)).toBeUndefined();
    expect(ledger.failedCalls).toBe(0);
  });

  it("forgets the oldest of more than 4,096 calls and counts a forgotten one's restatement again", () => {
    const ledger = createToolFailureLedger();
    for (let index = 0; index <= 4_096; index += 1) {
      countToolFailure(ledger, `call-${String(index)}`, `cmd-${String(index)}`);
    }
    expect(ledger.byCall.size).toBe(4_096);
    expect(ledger.byCommand.size).toBe(4_096);
    expect(ledger.byCall.has("call-0")).toBe(false);
    expect(ledger.byCall.has("call-4096")).toBe(true);
    countToolFailure(ledger, "call-0", "cmd-0");
    expect(ledger.failedCalls).toBe(4_098);
  });
});

describe("the exit-code class", () => {
  it.each([
    [undefined, "none"],
    [0, "0"],
    [1, "1"],
    [2, "2"],
    [126, "126"],
    [127, "127"],
    [137, "signal"],
    [255, "signal"],
    [3, "other"],
    [256, "other"],
    [-1, "other"],
  ] as const)("classes %s as %s", (code, klass) => {
    expect(exitCodeClass(code)).toBe(klass);
  });
});
