// The generalized read-only session governance (Issue #4136): the counter-check runs under the same
// gate, deadline and cancellation the read-only child does, with its own allowed classes and
// ceiling. The child's own tests (readOnlyChildOrchestrator.test.ts) stay unchanged.

import { describe, expect, it } from "vitest";

import {
  ReadOnlyChildTrustViolationError,
  runGovernedReadOnlySession,
  type ReadOnlySessionGovernance,
} from "./readOnlyChildOrchestrator.js";

function governance(overrides: Partial<ReadOnlySessionGovernance> = {}): ReadOnlySessionGovernance {
  return {
    allowedActionClasses: ["workspace-read"],
    maxToolCalls: 2,
    charger: { chargeParentToolCall: () => true },
    cancellation: { stopReason: () => undefined },
    clock: { now: () => Date.now() },
    deadlineMs: Date.now() + 60_000,
    signal: new AbortController().signal,
    reportRunnerFault: () => undefined,
    ...overrides,
  };
}

describe("runGovernedReadOnlySession", () => {
  it("returns the runner's value when every call passed the gate", async () => {
    const result = await runGovernedReadOnlySession(governance(), (gate) => {
      expect(gate({ toolClass: "workspace-read" })).toEqual({ ok: true });
      return Promise.resolve("value");
    });
    expect(result).toEqual({ ok: true, value: "value" });
  });

  it("denies every non-read class and nested children, and latches the first denial", async () => {
    const result = await runGovernedReadOnlySession(governance(), (gate) => {
      expect(gate({ toolClass: "workspace-write" })).toMatchObject({
        ok: false,
        terminal: "denied",
      });
      expect(gate({ toolClass: "workspace-read" })).toMatchObject({
        ok: false,
        reasonCode: "workspace-write-denied",
      });
      return Promise.resolve("ignored");
    });
    expect(result).toEqual({
      ok: false,
      terminal: "denied",
      reasonCode: "workspace-write-denied",
      thrown: false,
    });
    const nested = await runGovernedReadOnlySession(governance(), (gate) => {
      gate({ toolClass: "child-agent" });
      return Promise.resolve(undefined);
    });
    expect(nested).toMatchObject({ ok: false, reasonCode: "nested-child-denied" });
  });

  it("ends at the session's own tool-call ceiling and at the parent budget", async () => {
    const ceiling = await runGovernedReadOnlySession(governance({ maxToolCalls: 1 }), (gate) => {
      gate({ toolClass: "workspace-read" });
      gate({ toolClass: "workspace-read" });
      return Promise.resolve(undefined);
    });
    expect(ceiling).toMatchObject({
      ok: false,
      terminal: "limit-reached",
      reasonCode: "child-max-tool-calls",
    });
    const parent = await runGovernedReadOnlySession(
      governance({ charger: { chargeParentToolCall: () => false } }),
      (gate) => {
        gate({ toolClass: "workspace-read" });
        return Promise.resolve(undefined);
      },
    );
    expect(parent).toMatchObject({ ok: false, reasonCode: "parent-budget-exceeded" });
  });

  it("aborts the runner's signal at the deadline and on a parent stop", async () => {
    const deadline = await runGovernedReadOnlySession(
      governance({ deadlineMs: Date.now() + 20 }),
      (_gate, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            resolve("late");
          });
        }),
    );
    expect(deadline).toMatchObject({ ok: false, terminal: "stopped", reasonCode: "timeout" });
    const parent = new AbortController();
    const stopped = runGovernedReadOnlySession(
      governance({ signal: parent.signal }),
      (_gate, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            resolve("late");
          });
        }),
    );
    parent.abort();
    expect(await stopped).toMatchObject({
      ok: false,
      terminal: "stopped",
      reasonCode: "parent-stopped",
    });
  });

  it("classifies a thrown runner: trust violations are denied, other faults unavailable", async () => {
    const violation = await runGovernedReadOnlySession(governance(), () =>
      Promise.reject(new ReadOnlyChildTrustViolationError("fabricated-tool-denied")),
    );
    expect(violation).toMatchObject({
      ok: false,
      terminal: "denied",
      reasonCode: "fabricated-tool-denied",
      thrown: true,
    });
    const reported: string[] = [];
    const fault = await runGovernedReadOnlySession(
      governance({
        reportRunnerFault: (failure) => {
          reported.push(failure.reasonCode);
        },
      }),
      () => Promise.reject(new Error("boom")),
    );
    expect(reported).toEqual(["child-runner-error"]);
    expect(fault).toMatchObject({
      ok: false,
      terminal: "unavailable",
      reasonCode: "child-runner-error",
      thrown: true,
    });
  });
});
