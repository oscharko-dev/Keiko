import { describe, expect, it } from "vitest";
import { createInitialToolCatalog } from "@oscharko-dev/keiko-tool-catalog";
import type { ToolInvocationReceipt } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import { createHarnessCatalogBudget } from "./catalog-budget.js";
import { newCounters } from "./context.js";
import { DEFAULT_LIMITS } from "./types.js";

function fixture(): {
  command: import("@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog").ToolDescriptor;
  read: import("@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog").ToolDescriptor;
  controller: AbortController;
  counters: ReturnType<typeof newCounters>;
  context: { runId: string; signal: AbortSignal };
  budget: ReturnType<typeof createHarnessCatalogBudget>;
  expire: () => void;
} {
  const descriptors = createInitialToolCatalog().descriptors;
  const command = descriptors.find((entry) => entry.effects.includes("command-execution"));
  const read = descriptors.find((entry) => entry.toolRef.canonicalId === "keiko.file.read");
  if (command === undefined || read === undefined)
    throw new TypeError("Missing native descriptors");
  const controller = new AbortController();
  const counters = newCounters();
  const context = { runId: "run-1", signal: controller.signal };
  let now = 0;
  const budget = createHarnessCatalogBudget({
    ...context,
    counters,
    limits: { ...DEFAULT_LIMITS, maxToolCalls: 1, maxCommandExecutions: 1 },
    now: () => now,
    deadlineAt: 10,
  });
  return {
    command,
    read,
    controller,
    counters,
    context,
    budget,
    expire: (): void => {
      now = 10;
    },
  };
}
function receipt(change: Partial<ToolInvocationReceipt> = {}): ToolInvocationReceipt {
  return {
    invocationId: "invocation-1",
    reservationId: "invocation-1",
    settlementId: "settlement-1",
    effectStarted: true,
    budgetDisposition: "committed",
    status: "completed",
    ...change,
  };
}
describe("harness counter owner catalog reservations", () => {
  it("reserves the final slot atomically and accepts the binder's captured scalar receipt", () => {
    const f = fixture();
    const reservation = f.budget.port.reserve(f.command, f.context, "invocation-1");
    if (reservation === undefined) throw new TypeError("Expected reservation");
    expect(f.counters).toMatchObject({ toolCalls: 1, commandExecutions: 1 });
    expect(f.budget.port.reserve(f.command, f.context, "invocation-2")).toBeUndefined();
    expect(f.budget.port.check({ ...reservation }, f.context)).toBe(true);
    f.budget.port.commit({ ...reservation });
    f.budget.acceptReceipt(receipt(), f.command);
    expect(f.counters).toMatchObject({ toolCalls: 1, commandExecutions: 1 });
    expect(() => {
      f.budget.port.release(reservation);
    }).toThrow();
  });
  it("refunds only a released pre-effect reservation, allowing reads with no command charge", () => {
    const f = fixture();
    const reservation = f.budget.port.reserve(f.command, f.context, "invocation-1");
    if (reservation === undefined) throw new TypeError("Expected reservation");
    f.budget.port.release(reservation);
    f.budget.acceptReceipt(
      receipt({ effectStarted: false, budgetDisposition: "released", status: "denied" }),
      f.command,
    );
    expect(f.counters).toMatchObject({ toolCalls: 0, commandExecutions: 0 });
    expect(f.budget.port.reserve(f.read, f.context, "invocation-2")).toBeDefined();
    expect(f.counters.commandExecutions).toBe(0);
  });
  it.each(["commit-uncertain", "release-uncertain"] as const)(
    "stops further effects after %s without compensation",
    (budgetDisposition) => {
      const f = fixture();
      f.budget.port.reserve(f.command, f.context, "invocation-1");
      expect(() => {
        f.budget.acceptReceipt(
          receipt({
            budgetDisposition,
            status: "failed",
            effectStarted: budgetDisposition === "commit-uncertain",
          }),
          f.command,
        );
      }).toThrow();
      expect(f.budget.port.available(f.read, f.context)).toBe(false);
      expect(f.counters).toMatchObject({ toolCalls: 1, commandExecutions: 1 });
    },
  );
  it("rejects fabricated completion and descriptor drift", () => {
    const f = fixture();
    expect(() => {
      f.budget.acceptReceipt(
        receipt({ reservationId: null, effectStarted: false, budgetDisposition: "not-reserved" }),
        f.read,
      );
    }).toThrow();
    const g = fixture();
    const reservation = g.budget.port.reserve(g.command, g.context, "invocation-1");
    if (reservation === undefined) throw new TypeError("Expected reservation");
    g.budget.port.commit(reservation);
    expect(() => {
      g.budget.acceptReceipt(receipt(), g.read);
    }).toThrow();
  });
  it("rejects a settled receipt whose charge was never reserved on this run", () => {
    const f = fixture();
    // No reserve() call: `charges` is empty, so this receipt is a settled disposition with no
    // matching tracked charge -- distinct from the "not-reserved" early-return path above, this
    // exercises the `charge === undefined` arm of the settlement identity check.
    expect(() => {
      f.budget.acceptReceipt(receipt(), f.command);
    }).toThrow();
  });
  it("rejects a settled receipt claiming a reservationId that does not match the tracked charge", () => {
    const f = fixture();
    const reservation = f.budget.port.reserve(f.command, f.context, "invocation-1");
    if (reservation === undefined) throw new TypeError("Expected reservation");
    f.budget.port.commit(reservation);
    expect(() => {
      f.budget.acceptReceipt(receipt({ reservationId: "forged-reservation" }), f.command);
    }).toThrow();
  });
  it.each(["abort", "expiry", "wrong-run", "external-exhaustion"])(
    "rechecks %s at the live effect boundary",
    (kind) => {
      const f = fixture();
      const reservation = f.budget.port.reserve(f.command, f.context, "invocation-1");
      if (reservation === undefined) throw new TypeError("Expected reservation");
      if (kind === "abort") f.controller.abort();
      if (kind === "expiry") f.expire();
      if (kind === "external-exhaustion") f.counters.commandExecutions += 1;
      expect(
        f.budget.port.check(reservation, {
          ...f.context,
          runId: kind === "wrong-run" ? "other" : f.context.runId,
        }),
      ).toBe(false);
    },
  );
});
