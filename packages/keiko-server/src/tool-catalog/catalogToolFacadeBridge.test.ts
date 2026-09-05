import { describe, expect, it, vi } from "vitest";

import { createOpenCodeGatewayToolCatalogAdvertisement } from "../coding-runtime/opencodeToolSchemas.js";
import { defaultServerDiagnosticSink } from "../diagnostics-log.js";
import { createBufferedServerLogSink } from "../observability/server-log.js";
import {
  CatalogFacadeDeniedError,
  createCatalogFacadeBridge,
  createInMemoryCatalogFacadeBudgetPort,
  type CatalogFacadeBudgetPort,
} from "./catalogToolFacadeBridge.js";
import type { CodingToolActionRequest } from "../coding-runtime/codingToolIpc.js";

const discoverRequest: CodingToolActionRequest = {
  action: "discover",
  actionId: "action-1",
  idempotencyKey: "key-1",
  query: "governed",
  maxResults: 10,
};
const readRequest: CodingToolActionRequest = {
  action: "read",
  actionId: "action-2",
  idempotencyKey: "key-2",
  relativePath: "src/a.ts",
};

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

describe("CatalogFacadeBridge (#3413 F8)", () => {
  it("resolves keiko.workspace.discover and passes uncovered actions straight through", () => {
    const { bridge } = bridgeFixture();
    expect(bridge.resolve(discoverRequest)?.toolRef.canonicalId).toBe("keiko.workspace.discover");
    expect(bridge.resolve(readRequest)).toBeUndefined();
  });

  it("runs the uncovered action unwrapped: zero lifecycle log lines, unchanged result", async () => {
    const { bridge, log } = bridgeFixture();
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const }));

    await expect(bridge.dispatch(readRequest, run)).resolves.toEqual({ status: "completed" });

    expect(run).toHaveBeenCalledOnce();
    expect(log.events).toHaveLength(0);
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

    await expect(bridge.dispatch(discoverRequest, run)).rejects.toBeInstanceOf(
      CatalogFacadeDeniedError,
    );

    expect(run).not.toHaveBeenCalled();
    expect(log.events).toHaveLength(1);
    expect(log.events[0]?.op).toBe("tool-catalog.invocation-settled");
    const settled = log.events[0]?.extra as Record<string, unknown>;
    expect(settled.status).toBe("denied");
    expect(settled.reason).toBe("budget-exhausted");
    expect(settled.reservationId).toBeNull();
    expect(settled.budgetDisposition).toBe("not-reserved");
  });

  it("records handler-failed and releases the reservation when the wrapped handler throws", async () => {
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
    expect(commit).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith({ reservationId: "reservation-1" });
    expect(log.events[1]?.op).toBe("tool-catalog.invocation-settled");
    const settled = log.events[1]?.extra as Record<string, unknown>;
    expect(settled.status).toBe("failed");
    expect(settled.reason).toBe("handler-failed");
    expect(settled.budgetDisposition).toBe("released");
    expect(settled.reservationId).toBe("reservation-1");
    expect(JSON.stringify(settled)).not.toContain("handler exploded");
  });
});
