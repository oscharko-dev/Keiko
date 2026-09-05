import { describe, expect, it, vi } from "vitest";
import type { ToolCatalog } from "@oscharko-dev/keiko-tool-catalog";

import { createOpenCodeGatewayToolCatalogAdvertisement } from "../coding-runtime/opencodeToolSchemas.js";
import { defaultServerDiagnosticSink } from "../diagnostics-log.js";
import { createBufferedServerLogSink } from "../observability/server-log.js";
import {
  createCatalogFacadeBridge,
  createInMemoryCatalogFacadeBudgetPort,
  type CatalogFacadeBudgetPort,
} from "./catalogToolFacadeBridge.js";
import { CatalogDispatchFault } from "./catalogToolRuntimeAuthority.js";
import type { CodingToolActionRequest } from "../coding-runtime/codingToolIpc.js";

const identity = { actionId: "action-1", idempotencyKey: "key-1" } as const;
const discoverRequest: CodingToolActionRequest = {
  ...identity,
  action: "discover",
  query: "governed",
  maxResults: 10,
};
const readRequest: CodingToolActionRequest = {
  ...identity,
  action: "read",
  relativePath: "src/a.ts",
};

// One representative request per catalog-covered action family (#3413 F8), plus the request
// shapes that are structurally uncovered on purpose (read's schema gap, command/connector with no
// descriptor at all, git's low-level read/write operations, delivery's merge intent and undeclared
// phase). Table-driven so every family gets its own assertion (AGENTS.md: cover the input space).
const COVERAGE_TABLE: readonly (readonly [string, CodingToolActionRequest, string | undefined])[] =
  [
    ["discover", discoverRequest, "keiko.workspace.discover"],
    ["read (schema gap, reported not bound)", readRequest, undefined],
    [
      "search",
      {
        ...identity,
        action: "search",
        repositoryRequest: {
          kind: "search",
          mode: "lexical",
          query: "needle",
          caseSensitive: false,
          includeGlobs: [],
          excludeGlobs: [],
          maxResults: 10,
        },
      },
      "keiko.repo.search",
    ],
    [
      "edit",
      {
        ...identity,
        action: "edit",
        changeset: { patch: "diff", files: [{ file: "a.ts" }] },
      },
      "keiko.changeset.edit",
    ],
    [
      "verification",
      { ...identity, action: "verification", verifierId: "test" },
      "keiko.verification.run",
    ],
    [
      "egress",
      { ...identity, action: "egress", target: "https://example.com" },
      "keiko.research.fetch",
    ],
    ["skill", { ...identity, action: "skill", skillId: "skill-1" }, "keiko.skill.invoke"],
    [
      "child-agent",
      { ...identity, action: "child-agent", objective: "x", maxToolCalls: 1 },
      "keiko.child.run",
    ],
    ["git status", { ...identity, action: "git", operation: "status" }, "keiko.git.status"],
    [
      "git diff",
      { ...identity, action: "git", operation: "diff", scope: "working-tree", paths: ["a.ts"] },
      "keiko.git.diff",
    ],
    [
      "git stage propose",
      { ...identity, action: "git", operation: "stage", phase: "propose", paths: ["a.ts"] },
      "keiko.git.stage",
    ],
    [
      "git stage execute",
      { ...identity, action: "git", operation: "stage", phase: "execute", proposalId: "p-1" },
      "keiko.git.execute",
    ],
    ["git ci", { ...identity, action: "git", operation: "ci" }, "keiko.ci.status"],
    ["git read (no descriptor)", { ...identity, action: "git", operation: "read" }, undefined],
    ["git write (no descriptor)", { ...identity, action: "git", operation: "write" }, undefined],
    [
      "delivery commit propose",
      { ...identity, action: "delivery", intent: "commit", phase: "propose", message: "m" },
      "keiko.git.commit",
    ],
    [
      "delivery commit execute",
      {
        ...identity,
        action: "delivery",
        intent: "commit",
        phase: "execute",
        proposalId: "delivery-1",
      },
      "keiko.git.execute",
    ],
    [
      "delivery push propose",
      { ...identity, action: "delivery", intent: "push", phase: "propose" },
      "keiko.git.push",
    ],
    [
      "delivery push execute",
      {
        ...identity,
        action: "delivery",
        intent: "push",
        phase: "execute",
        proposalId: "delivery-1",
      },
      "keiko.git.execute",
    ],
    [
      "delivery pull-request propose",
      { ...identity, action: "delivery", intent: "pull-request", phase: "propose", title: "t" },
      "keiko.git.pullrequest",
    ],
    [
      "delivery pull-request execute",
      {
        ...identity,
        action: "delivery",
        intent: "pull-request",
        phase: "execute",
        proposalId: "delivery-1",
      },
      "keiko.git.execute",
    ],
    [
      "delivery merge (no tool models it)",
      {
        ...identity,
        action: "delivery",
        intent: "merge",
        phase: "execute",
        proposalId: "delivery-1",
      },
      undefined,
    ],
    [
      "delivery with no phase (not model-facing)",
      { ...identity, action: "delivery", intent: "push" },
      undefined,
    ],
    ["command (no descriptor)", { ...identity, action: "command", commandId: "x" }, undefined],
    ["connector (no descriptor)", { ...identity, action: "connector", scope: "x" }, undefined],
  ] as const;

function bridgeFixture(budget: CatalogFacadeBudgetPort = createInMemoryCatalogFacadeBudgetPort()): {
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
  readonly bridge: ReturnType<typeof createCatalogFacadeBridge>;
} {
  const { catalog, projection } = createOpenCodeGatewayToolCatalogAdvertisement(0);
  const log = createBufferedServerLogSink();
  const bridge = createCatalogFacadeBridge({
    catalog,
    profile: projection.profile,
    budget,
    logPort: { primary: log, diagnostics: defaultServerDiagnosticSink },
    context: () => ({ correlationId: "a".repeat(36) }),
    now: () => 1_000,
    mintId: (() => {
      let count = 0;
      return (): string => {
        count += 1;
        return `id-${String(count)}`;
      };
    })(),
  });
  return { log, bridge };
}

/**
 * A `catalog` provider that returns each entry of `sequence` in order (clamped to the last entry
 * once exhausted) -- lets a test observe a live catalog "changing" between the construction-time
 * compile and a later per-dispatch re-derivation, which a static `ToolCatalog` value can never do
 * (#3413 F8 review, AC3).
 */
function liveCatalogFixture(sequence: readonly ToolCatalog[]): {
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
  readonly bridge: ReturnType<typeof createCatalogFacadeBridge>;
} {
  const { projection } = createOpenCodeGatewayToolCatalogAdvertisement(0);
  const log = createBufferedServerLogSink();
  let calls = 0;
  const provider = (): ToolCatalog => {
    const value = sequence[Math.min(calls, sequence.length - 1)];
    calls += 1;
    if (value === undefined) throw new Error("fixture sequence must not be empty");
    return value;
  };
  const bridge = createCatalogFacadeBridge({
    catalog: provider,
    profile: projection.profile,
    budget: createInMemoryCatalogFacadeBudgetPort(),
    logPort: { primary: log, diagnostics: defaultServerDiagnosticSink },
    context: () => ({ correlationId: "a".repeat(36) }),
    now: () => 1_000,
  });
  return { log, bridge };
}

describe("CatalogFacadeBridge (#3413 F8)", () => {
  it.each(COVERAGE_TABLE)(
    "resolves %s to its exact catalog descriptor (or stays uncovered)",
    (_name, request, expectedCanonicalId) => {
      const { bridge } = bridgeFixture();
      expect(bridge.resolve(request)?.toolRef.canonicalId).toBe(expectedCanonicalId);
    },
  );

  it("runs an uncovered action unwrapped and records one body-free dispatch-unbound line", async () => {
    const { bridge, log } = bridgeFixture();
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const }));

    await expect(bridge.dispatch(readRequest, run)).resolves.toEqual({ status: "completed" });

    expect(run).toHaveBeenCalledOnce();
    expect(log.events).toHaveLength(1);
    expect(log.events[0]?.op).toBe("tool-catalog.dispatch-unbound");
    expect(log.events[0]?.correlationId).toBe("a".repeat(36));
    expect(log.events[0]?.extra).toEqual({ action: "read" });
  });

  it("settles a covered action from a second action family (search), not only discover", async () => {
    const { bridge, log } = bridgeFixture();
    const searchRequest = COVERAGE_TABLE.find(([name]) => name === "search")?.[1];
    if (searchRequest === undefined) throw new Error("fixture missing");
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const }));

    await expect(bridge.dispatch(searchRequest, run)).resolves.toEqual({ status: "completed" });

    const ops = log.events.map((event) => event.op);
    expect(ops).toEqual(["tool-catalog.invocation-started", "tool-catalog.invocation-settled"]);
    const started = log.events[0]?.extra as Record<string, unknown>;
    expect((started.toolRef as { canonicalId: string }).canonicalId).toBe("keiko.repo.search");
  });

  it("emits a real tool-catalog.* binding-started and settled pair with a correlation id and no bodies", async () => {
    const { bridge, log } = bridgeFixture();
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const, secret: "never-log" }));

    const result = await bridge.dispatch(discoverRequest, run);

    expect(result).toEqual({ status: "completed", secret: "never-log" });
    expect(run).toHaveBeenCalledOnce();
    const ops = log.events.map((event) => event.op);
    expect(ops).toEqual(["tool-catalog.invocation-started", "tool-catalog.invocation-settled"]);
    for (const event of log.events) {
      expect(event.correlationId).toBe("a".repeat(36));
      expect(JSON.stringify(event)).not.toContain("never-log");
      expect(JSON.stringify(event)).not.toContain("governed");
    }
    const settled = log.events[1]?.extra as Record<string, unknown>;
    expect(settled.status).toBe("completed");
    expect(settled.budgetDisposition).toBe("committed");
  });

  it("denies before the handler ever runs when the budget disposition is exhausted", async () => {
    const budget: CatalogFacadeBudgetPort = {
      available: () => false,
      reserve: () => {
        throw new Error("must not reserve when unavailable");
      },
      commit: vi.fn(),
      release: vi.fn(),
    };
    const { bridge, log } = bridgeFixture(budget);
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const }));

    const rejection: unknown = await bridge
      .dispatch(discoverRequest, run)
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(CatalogDispatchFault);
    expect((rejection as CatalogDispatchFault).status).toBe("denied");
    expect((rejection as CatalogDispatchFault).reason).toBe("budget-exhausted");

    expect(run).not.toHaveBeenCalled();
    expect(log.events).toHaveLength(1);
    expect(log.events[0]?.op).toBe("tool-catalog.invocation-settled");
    const settled = log.events[0]?.extra as Record<string, unknown>;
    expect(settled.status).toBe("denied");
    expect(settled.reason).toBe("budget-exhausted");
    expect(settled.reservationId).toBeNull();
    expect(settled.effectStarted).toBe(false);
    expect(settled.budgetDisposition).toBe("not-reserved");
  });

  it("records handler-failed and commits the reservation after the wrapped handler starts and throws", async () => {
    const commit = vi.fn();
    const release = vi.fn();
    const budget: CatalogFacadeBudgetPort = {
      available: () => true,
      reserve: () => ({ reservationId: "reservation-1" }),
      commit,
      release,
    };
    const { bridge, log } = bridgeFixture(budget);
    const failure = new Error("handler exploded");
    const run = vi.fn(() => Promise.reject(failure));

    await expect(bridge.dispatch(discoverRequest, run)).rejects.toBe(failure);

    expect(run).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith({ reservationId: "reservation-1" });
    expect(release).not.toHaveBeenCalled();
    expect(log.events[1]?.op).toBe("tool-catalog.invocation-settled");
    const settled = log.events[1]?.extra as Record<string, unknown>;
    expect(settled.status).toBe("failed");
    expect(settled.reason).toBe("handler-failed");
    expect(settled.effectStarted).toBe(true);
    expect(settled.budgetDisposition).toBe("committed");
    expect(settled.reservationId).toBe("reservation-1");
    expect(JSON.stringify(settled)).not.toContain("handler exploded");
  });

  // Review finding: ADR-0175 D6's "Mid-flight abort" row requires `cancelled`/`parent-cancelled`,
  // not the generic `failed`/`handler-failed` classification -- the wrapped handler rejects with
  // the same `AbortError` shape a fired `AbortSignal` produces (`DOMException(..., "AbortError")`,
  // the exact shape `generationPort.ts`/`judgePort.ts` fabricate and `errorKindOf` -- already
  // imported here for the settlement's `errorKind` field -- already classifies specifically), and
  // `classifyFailure` must recognize it instead of falling through to the opaque-rejection branch.
  it("records cancelled/parent-cancelled and commits the reservation when the started handler rejects with an AbortError", async () => {
    const commit = vi.fn();
    const release = vi.fn();
    const budget: CatalogFacadeBudgetPort = {
      available: () => true,
      reserve: () => ({ reservationId: "reservation-1" }),
      commit,
      release,
    };
    const { bridge, log } = bridgeFixture(budget);
    const aborted = new DOMException("The operation was aborted.", "AbortError");
    const run = vi.fn(() => Promise.reject(aborted));

    await expect(bridge.dispatch(discoverRequest, run)).rejects.toBe(aborted);

    expect(run).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith({ reservationId: "reservation-1" });
    expect(release).not.toHaveBeenCalled();
    expect(log.events[1]?.op).toBe("tool-catalog.invocation-settled");
    const settled = log.events[1]?.extra as Record<string, unknown>;
    expect(settled.status).toBe("cancelled");
    expect(settled.reason).toBe("parent-cancelled");
    expect(settled.effectStarted).toBe(true);
    expect(settled.budgetDisposition).toBe("committed");
    expect(settled.reservationId).toBe("reservation-1");
  });

  // Review finding on #3413 F8: the bridge must never call both `commit()` and `release()` for the
  // same reservation when accounting itself fails partway through -- mirroring
  // `CatalogInvocation.account()` (catalogToolSettlement.ts) rather than re-deriving a thinner,
  // divergent accounting rule. Fails before this change (a throwing `commit()` fell into the
  // generic catch, which called `release()` on the same reservation and mis-reported the outcome
  // as "handler-failed" instead of the canonical "budget-port-failed").
  it("fails closed as budget-port-failed without also releasing when commit itself throws", async () => {
    const release = vi.fn();
    const commitFailure = new Error("ledger unavailable");
    const budget: CatalogFacadeBudgetPort = {
      available: () => true,
      reserve: () => ({ reservationId: "reservation-2" }),
      commit: () => {
        throw commitFailure;
      },
      release,
    };
    const { bridge, log } = bridgeFixture(budget);
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const }));

    const rejection: unknown = await bridge
      .dispatch(discoverRequest, run)
      .catch((error: unknown) => error);

    expect(rejection).toBe(commitFailure);
    expect(run).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    const settled = log.events[1]?.extra as Record<string, unknown>;
    expect(settled.status).toBe("failed");
    expect(settled.reason).toBe("budget-port-failed");
    expect(settled.budgetDisposition).toBe("commit-uncertain");
    expect(settled.effectStarted).toBe(true);
    expect(JSON.stringify(settled)).not.toContain("ledger unavailable");
  });

  // Review finding on #3413 F8: a budget-port exception BEFORE reservation (available() or
  // reserve() itself throwing) used to propagate straight out of dispatch() with zero
  // tool-catalog.* evidence, even though the call still failed closed to the caller -- an evidence
  // gap in exactly the surface F8/#3413 exists to close. Fails before this change: log.events was
  // empty.
  it("settles budget-port-failed with no reservation when available() itself throws", async () => {
    const portFailure = new Error("budget backend unreachable");
    const budget: CatalogFacadeBudgetPort = {
      available: () => {
        throw portFailure;
      },
      reserve: vi.fn(),
      commit: vi.fn(),
      release: vi.fn(),
    };
    const { bridge, log } = bridgeFixture(budget);
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const }));

    const rejection: unknown = await bridge
      .dispatch(discoverRequest, run)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(CatalogDispatchFault);
    expect((rejection as CatalogDispatchFault).status).toBe("failed");
    expect((rejection as CatalogDispatchFault).reason).toBe("budget-port-failed");
    expect(run).not.toHaveBeenCalled();
    expect(log.events).toHaveLength(1);
    expect(log.events[0]?.op).toBe("tool-catalog.invocation-settled");
    const settled = log.events[0]?.extra as Record<string, unknown>;
    expect(settled.status).toBe("failed");
    expect(settled.reason).toBe("budget-port-failed");
    expect(settled.reservationId).toBeNull();
    expect(settled.effectStarted).toBe(false);
    expect(settled.budgetDisposition).toBe("not-reserved");
    expect(JSON.stringify(settled)).not.toContain("budget backend unreachable");
  });

  it("settles budget-port-failed with no reservation when reserve() itself throws", async () => {
    const reserveFailure = new Error("ledger locked");
    const budget: CatalogFacadeBudgetPort = {
      available: () => true,
      reserve: () => {
        throw reserveFailure;
      },
      commit: vi.fn(),
      release: vi.fn(),
    };
    const { bridge, log } = bridgeFixture(budget);
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const }));

    const rejection: unknown = await bridge
      .dispatch(discoverRequest, run)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(CatalogDispatchFault);
    expect(run).not.toHaveBeenCalled();
    const settled = log.events[0]?.extra as Record<string, unknown>;
    expect(settled.status).toBe("failed");
    expect(settled.reason).toBe("budget-port-failed");
    expect(settled.reservationId).toBeNull();
    expect(settled.effectStarted).toBe(false);
    expect(settled.budgetDisposition).toBe("not-reserved");
  });

  // A thrown handler has already started effects, so its budget accounting is the same conservative
  // commit path as a successful handler. A failed commit remains exactly-once and uncertain.
  it("records commit-uncertain without releasing when handler and commit both throw", async () => {
    const commitFailure = new Error("ledger unavailable");
    const release = vi.fn();
    const budget: CatalogFacadeBudgetPort = {
      available: () => true,
      reserve: () => ({ reservationId: "reservation-3" }),
      commit: () => {
        throw commitFailure;
      },
      release,
    };
    const { bridge, log } = bridgeFixture(budget);
    const handlerFailure = new Error("handler exploded");
    const run = vi.fn(() => Promise.reject(handlerFailure));

    // The caller still sees the ORIGINAL handler failure (the actual reason this call failed);
    // only the settlement's own bookkeeping fields report the release accounting could not be
    // confirmed, exactly mirroring the (tested) commit-throws branch's "the log knows more than
    // the exception" split.
    const rejection: unknown = await bridge
      .dispatch(discoverRequest, run)
      .catch((error: unknown) => error);

    expect(rejection).toBe(handlerFailure);
    expect(run).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    const settled = log.events[1]?.extra as Record<string, unknown>;
    expect(settled.status).toBe("failed");
    expect(settled.reason).toBe("budget-port-failed");
    expect(settled.budgetDisposition).toBe("commit-uncertain");
    expect(settled.effectStarted).toBe(true);
    expect(JSON.stringify(settled)).not.toContain("ledger unavailable");
    expect(JSON.stringify(settled)).not.toContain("handler exploded");
  });

  // #3413 F8 review, findings b1-1/AC10/AC11: a canonical id `catalogIdFor` maps a request to but
  // the composed catalog does not contain must fail closed with a real readiness signal, never run
  // the handler unwrapped as if the action were merely uncovered by design.
  it("fails closed with tool-catalog.bind-unavailable and never runs the handler when the composed catalog drops a canonical id this bridge maps to", async () => {
    const { catalog: fullCatalog } = createOpenCodeGatewayToolCatalogAdvertisement(0);
    const strippedCatalog: ToolCatalog = {
      ...fullCatalog,
      descriptors: fullCatalog.descriptors.filter(
        (descriptor) => descriptor.toolRef.canonicalId !== "keiko.workspace.discover",
      ),
    };
    const { bridge, log } = liveCatalogFixture([fullCatalog, strippedCatalog]);
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const }));

    const rejection: unknown = await bridge
      .dispatch(discoverRequest, run)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(CatalogDispatchFault);
    expect((rejection as CatalogDispatchFault).status).toBe("invalid");
    expect((rejection as CatalogDispatchFault).reason).toBe("unknown-tool");
    expect(run).not.toHaveBeenCalled();
    expect(log.events).toHaveLength(1);
    expect(log.events[0]?.op).toBe("tool-catalog.bind-unavailable");
    const extra = log.events[0]?.extra as Record<string, unknown>;
    expect(extra.readiness).toBe("unavailable");
    expect(extra.reason).toBe("unknown-tool");
  });

  // #3413 F8 review, AC3: a static catalog value cannot drift (the current, only production
  // wiring), but a live provider must be re-derived and revalidated before the handler runs.
  it("settles invalid/projection-mismatch and never runs the handler when a live catalog provider drifts after construction", async () => {
    const { catalog: baseCatalog } = createOpenCodeGatewayToolCatalogAdvertisement(0);
    const drifted: ToolCatalog = {
      ...baseCatalog,
      catalogRevision: "1".repeat(64) as ToolCatalog["catalogRevision"],
    };
    const { bridge, log } = liveCatalogFixture([baseCatalog, drifted]);
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const }));

    const rejection: unknown = await bridge
      .dispatch(discoverRequest, run)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(CatalogDispatchFault);
    expect((rejection as CatalogDispatchFault).status).toBe("invalid");
    expect((rejection as CatalogDispatchFault).reason).toBe("projection-mismatch");
    expect(run).not.toHaveBeenCalled();
    const settled = log.events.at(-1)?.extra as Record<string, unknown>;
    expect(settled.status).toBe("invalid");
    expect(settled.reason).toBe("projection-mismatch");
  });

  // #3413 F8 review, AC6/AC8: an authoritative deadline settles `timeout`, never `cancelled`, and a
  // handler completion that arrives after that settlement is quarantined -- discarded, never a
  // second terminal event, never a second budget charge.
  it("settles timeout/deadline-exceeded at the authoritative deadline and quarantines a later handler completion", async () => {
    vi.useFakeTimers();
    try {
      const { bridge, log } = bridgeFixture();
      let releaseHandler: (() => void) | undefined;
      const handlerGate = new Promise<{ status: "completed" }>((resolve) => {
        releaseHandler = (): void => {
          resolve({ status: "completed" });
        };
      });
      const run = vi.fn(() => handlerGate);

      const rejectionPromise = bridge
        .dispatch(discoverRequest, run)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      const rejection: unknown = await rejectionPromise;

      expect(rejection).toBeInstanceOf(CatalogDispatchFault);
      expect((rejection as CatalogDispatchFault).status).toBe("timeout");
      expect((rejection as CatalogDispatchFault).reason).toBe("deadline-exceeded");
      expect(log.events.map((event) => event.op)).toEqual([
        "tool-catalog.invocation-started",
        "tool-catalog.invocation-settled",
      ]);
      const settled = log.events[1]?.extra as Record<string, unknown>;
      expect(settled.status).toBe("timeout");
      expect(settled.reason).toBe("deadline-exceeded");
      expect(settled.budgetDisposition).toBe("committed");

      if (releaseHandler === undefined) throw new Error("fixture wiring failed");
      releaseHandler();
      await vi.runAllTimersAsync();

      expect(log.events.map((event) => event.op)).toEqual([
        "tool-catalog.invocation-started",
        "tool-catalog.invocation-settled",
        "tool-catalog.completion-discarded",
      ]);
      const discarded = log.events[2]?.extra as Record<string, unknown>;
      expect(discarded.reason).toBe("late-completion");
    } finally {
      vi.useRealTimers();
    }
  });
});
