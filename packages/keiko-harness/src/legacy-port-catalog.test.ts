// Proves the F11 fix: a throwing/rejecting ToolPort, and reserveBudget's own check()-failure
// branch, must both release the reservation and return the ADR-0175 D6 shaped
// `failed / handler-failed` outcome instead of leaking a HarnessCounterBudget charge and a run
// counter through an unshaped throw. Exercises the real HarnessCounterBudget (catalog-budget.ts)
// together with the legacy-port adapter, not a stand-in, so the counter refund is actually proved.
import { describe, expect, it } from "vitest";
import {
  createInitialToolCatalog,
  compileToolProjection,
  lookupCatalogTool,
} from "@oscharko-dev/keiko-tool-catalog";
import type { BoundToolInvocation } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import { createHarnessCatalogBudget } from "./catalog-budget.js";
import { newCounters } from "./context.js";
import { DEFAULT_LIMITS } from "./types.js";
import {
  createLegacyPortCatalogBinding,
  createLegacyPortCatalogFactory,
  type LegacyPortCatalogHandlerAttestation,
  type LegacyPortCatalogLifecycleObservation,
} from "./legacy-port-catalog.js";
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

function handlerAttestations(f: Fixture): readonly LegacyPortCatalogHandlerAttestation[] {
  return f.projection.tools.map((tool) => {
    const descriptor = lookupCatalogTool(f.catalog, tool.toolRef);
    if (descriptor === undefined) throw new TypeError("Missing fixture descriptor");
    return {
      alias: tool.alias,
      handlerId: descriptor.handlerRequirement.id,
      handlerVersion: descriptor.handlerRequirement.contractVersion,
      catalogAction: tool.alias,
    };
  });
}

describe("legacy-port catalog dispatch settlement (F11)", () => {
  it("cannot advertise ready with missing, duplicate, or mismatched handler attestations", () => {
    const f = fixture();
    const port = scriptedPort(() =>
      Promise.resolve({ toolCallId: "call-1", output: "ok", durationMs: 3 }),
    );
    const handlers = handlerAttestations(f);
    const [first] = handlers;
    if (first === undefined) throw new TypeError("Missing fixture handler");
    expect(() => createLegacyPortCatalogFactory(f.catalog, PROFILE, port, [])).toThrow(
      "Invalid legacy-port handler attestation",
    );
    expect(() =>
      createLegacyPortCatalogFactory(f.catalog, PROFILE, port, [
        first,
        first,
        ...handlers.slice(2),
      ]),
    ).toThrow("Invalid legacy-port handler attestation");
    expect(() =>
      createLegacyPortCatalogFactory(f.catalog, PROFILE, port, [
        { ...first, handlerId: "unbound-handler" },
        ...handlers.slice(1),
      ]),
    ).toThrow("Invalid legacy-port handler attestation");
  });

  it("commits the reservation and reports the completed outcome on the happy path", async () => {
    const f = fixture();
    const port = scriptedPort(() =>
      Promise.resolve({ toolCallId: "call-1", output: "ok", durationMs: 3 }),
    );
    const catalogPort = createLegacyPortCatalogFactory(
      f.catalog,
      PROFILE,
      port,
      handlerAttestations(f),
    )(f.context);
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
    const catalogPort = createLegacyPortCatalogFactory(
      f.catalog,
      PROFILE,
      port,
      handlerAttestations(f),
    )(f.context);
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

  // The pin moved, it did not relax: everything it guarded stays asserted below unchanged (the
  // reservation released, the charge and run counter actually refunded, a shaped ADR-0175 D6
  // outcome instead of an unshaped throw, the handler never reached). Only the reason is
  // corrected. A revoked check() is the budget saying no, which the closed vocabulary calls
  // `denied`/`budget-exhausted`; reporting it as `failed`/`handler-failed` collapsed it with a
  // genuine handler exception and hid "you are out of budget" from the operator (#3384 review).
  it("releases the reservation and returns denied/budget-exhausted when check() is revoked pre-dispatch", async () => {
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
    const catalogPort = createLegacyPortCatalogFactory(
      f.catalog,
      PROFILE,
      port,
      handlerAttestations(f),
    )(f.context);
    const outcome = await catalogPort.execute({
      toolCallId: "call-1",
      invocation: f.invocation,
      signal: f.context.signal,
    });
    if (outcome.kind !== "settled") throw new TypeError("Expected settled outcome");
    expect(outcome.result.status).toBe("denied");
    expect(outcome.result.reason).toBe("budget-exhausted");
    expect(outcome.receipt.status).toBe("denied");
    expect(outcome.receipt.budgetDisposition).toBe("released");
    expect(f.counters).toMatchObject({ toolCalls: 0, commandExecutions: 0 });
    expect(executed).toBe(false);
  });

  // A budget port that THROWS is a different outcome from a budget that declines: the contract
  // separates `failed`/`budget-port-failed` from `denied`/`budget-exhausted`, and the thrown
  // value's class name must survive into the settlement observation so the defect is not lost
  // (AGENTS.md sections 7 and 8: no silent catch).
  it("reports a throwing budget port as failed/budget-port-failed and names the error class", async () => {
    const f = fixture();
    const observations: LegacyPortCatalogLifecycleObservation[] = [];
    const port = scriptedPort(() =>
      Promise.resolve({ toolCallId: "call-1", output: "ok", durationMs: 1 }),
    );
    const context = {
      ...f.context,
      budgetPort: {
        ...f.context.budgetPort,
        reserve: (): never => {
          throw new RangeError("budget port unavailable");
        },
      },
    };
    const binding = createLegacyPortCatalogBinding(
      f.catalog,
      PROFILE,
      port,
      handlerAttestations(f),
      (observation) => observations.push(observation),
    );
    const outcome = await binding.factory(context).execute({
      toolCallId: "call-1",
      invocation: f.invocation,
      signal: f.context.signal,
    });
    if (outcome.kind !== "settled") throw new TypeError("Expected settled outcome");
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.reason).toBe("budget-port-failed");
    expect(outcome.receipt.budgetDisposition).toBe("not-reserved");
    expect(observations.find((entry) => entry.phase === "invocation-settled")).toMatchObject({
      errorName: "RangeError",
    });
  });

  // The same rule for the handler side: the bound port's thrown class must reach the observation.
  it("names the error class when the bound ToolPort throws", async () => {
    const f = fixture();
    const observations: LegacyPortCatalogLifecycleObservation[] = [];
    const port = scriptedPort(() => Promise.reject(new TypeError("handler exploded")));
    const binding = createLegacyPortCatalogBinding(
      f.catalog,
      PROFILE,
      port,
      handlerAttestations(f),
      (observation) => observations.push(observation),
    );
    const outcome = await binding.factory(f.context).execute({
      toolCallId: "call-1",
      invocation: f.invocation,
      signal: f.context.signal,
    });
    if (outcome.kind !== "settled") throw new TypeError("Expected settled outcome");
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.reason).toBe("handler-failed");
    expect(observations.find((entry) => entry.phase === "invocation-settled")).toMatchObject({
      errorName: "TypeError",
    });
  });
});
