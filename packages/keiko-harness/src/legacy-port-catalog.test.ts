// Proves the F11 fix: a throwing/rejecting ToolPort, and reserveBudget's own check()-failure
// branch, must both release the reservation and return the ADR-0175 D6 shaped
// `failed / handler-failed` outcome instead of leaking a HarnessCounterBudget charge and a run
// counter through an unshaped throw. Exercises the real HarnessCounterBudget (catalog-budget.ts)
// together with the legacy-port adapter, not a stand-in, so the counter refund is actually proved.
import { describe, expect, it } from "vitest";
import { createInitialToolCatalog, compileToolProjection } from "@oscharko-dev/keiko-tool-catalog";
import type { BoundToolInvocation } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import { createHarnessCatalogBudget } from "./catalog-budget.js";
import { newCounters } from "./context.js";
import { DEFAULT_LIMITS } from "./types.js";
import { createLegacyPortCatalogFactory } from "./legacy-port-catalog.js";
import type { ToolCallResult, ToolPort } from "./ports.js";
import type { HarnessCatalogContext, HarnessToolExecutionEvidence } from "./catalog-runtime.js";

const PROFILE = { id: "legacy-native", version: 1 } as const;

interface Fixture {
  readonly catalog: ReturnType<typeof createInitialToolCatalog>;
  readonly projection: ReturnType<typeof compileToolProjection>;
  readonly counters: ReturnType<typeof newCounters>;
  readonly context: HarnessCatalogContext;
  readonly invocation: BoundToolInvocation;
  readonly observed: HarnessToolExecutionEvidence[];
}

function fixture(now: () => number = () => 0, deadlineAt = 10_000): Fixture {
  const catalog = createInitialToolCatalog();
  const projection = compileToolProjection(catalog, PROFILE);
  const tool = projection.tools.find((entry) => entry.toolRef.canonicalId === "keiko.file.read");
  if (tool === undefined) throw new TypeError("Missing fixture tool");
  const counters = newCounters();
  const controller = new AbortController();
  const budget = createHarnessCatalogBudget({
    runId: "run-1",
    signal: controller.signal,
    counters,
    limits: { ...DEFAULT_LIMITS, maxToolCalls: 5, maxCommandExecutions: 5 },
    now,
    deadlineAt,
  });
  const observed: HarnessToolExecutionEvidence[] = [];
  const context: HarnessCatalogContext = {
    runId: "run-1",
    signal: controller.signal,
    budgetPort: budget.port,
    observeExecution: (evidence): void => {
      observed.push(evidence);
    },
  };
  const invocation: BoundToolInvocation = {
    kind: "bound",
    toolRef: tool.toolRef,
    projectionDigest: projection.projectionDigest,
    offerId: "fixture-offer",
    arguments: { path: "fixture.txt" },
  };
  return { catalog, projection, counters, context, invocation, observed };
}

function scriptedPort(behavior: () => Promise<ToolCallResult>): ToolPort {
  return {
    execute: behavior,
    listTools: (): [] => [],
  };
}

describe("legacy-port catalog dispatch settlement (F11)", () => {
  it("commits the reservation and reports the completed outcome on the happy path", async () => {
    const f = fixture();
    const port = scriptedPort(() =>
      Promise.resolve({ toolCallId: "call-1", output: "ok", durationMs: 3 }),
    );
    const catalogPort = createLegacyPortCatalogFactory(f.catalog, PROFILE, port)(f.context);
    const outcome = await catalogPort.execute({
      toolCallId: "call-1",
      invocation: f.invocation,
      signal: f.context.signal,
    });
    if (outcome.kind !== "settled") throw new TypeError("Expected settled outcome");
    expect(outcome.result.status).toBe("completed");
    expect(outcome.receipt.budgetDisposition).toBe("committed");
    expect(f.counters).toMatchObject({ toolCalls: 1, commandExecutions: 0 });
    expect(f.observed).toHaveLength(1);
  });

  it("releases the reservation and returns failed/handler-failed when the ToolPort rejects", async () => {
    const f = fixture();
    const port = scriptedPort(() => Promise.reject(new Error("legacy port exploded")));
    const catalogPort = createLegacyPortCatalogFactory(f.catalog, PROFILE, port)(f.context);
    const outcome = await catalogPort.execute({
      toolCallId: "call-1",
      invocation: f.invocation,
      signal: f.context.signal,
    });
    if (outcome.kind !== "settled") throw new TypeError("Expected settled outcome");
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.reason).toBe("handler-failed");
    expect(outcome.receipt.budgetDisposition).toBe("released");
    expect(outcome.receipt.reservationId).not.toBeNull();
    // The charge must actually be refunded, not merely reported as refunded.
    expect(f.counters).toMatchObject({ toolCalls: 0, commandExecutions: 0 });
    expect(f.observed).toHaveLength(0);
  });

  it("releases the reservation and returns failed/handler-failed when check() is revoked pre-dispatch", async () => {
    // The budget's constructor consumes the first clock read; reserve() consumes the second
    // (still live); check() consumes the third and observes the deadline has passed, before
    // port.execute() ever runs, so the real budget's own check()-failure branch fires
    // deterministically.
    const values = [0, 0, 100];
    const f = fixture(() => values.shift() ?? 100, 50);
    let executed = false;
    const port = scriptedPort(() => {
      executed = true;
      return Promise.resolve({ toolCallId: "call-1", output: "ok", durationMs: 1 });
    });
    const catalogPort = createLegacyPortCatalogFactory(f.catalog, PROFILE, port)(f.context);
    const outcome = await catalogPort.execute({
      toolCallId: "call-1",
      invocation: f.invocation,
      signal: f.context.signal,
    });
    if (outcome.kind !== "settled") throw new TypeError("Expected settled outcome");
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.reason).toBe("handler-failed");
    expect(outcome.receipt.budgetDisposition).toBe("released");
    expect(f.counters).toMatchObject({ toolCalls: 0, commandExecutions: 0 });
    expect(executed).toBe(false);
  });
});
