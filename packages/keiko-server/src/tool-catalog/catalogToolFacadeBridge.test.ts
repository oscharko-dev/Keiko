import { describe, expect, it, vi } from "vitest";

import type { CodingToolActionRequest } from "../coding-runtime/codingToolIpc.js";
import { createCodingToolInvocationRegistry } from "../coding-runtime/codingToolInvocationRegistry.js";
import { defaultServerDiagnosticSink } from "../diagnostics-log.js";
import { createBufferedServerLogSink } from "../observability/server-log.js";
import {
  createCanonicalCatalogFacadeBridge,
  type CanonicalCatalogContext,
  type CanonicalCatalogFacadeBridgeInput,
} from "./catalogToolFacadeBridge.js";
import type { CatalogToolBudgetPort } from "./catalogToolPorts.js";

const identity = { actionId: "action-1", idempotencyKey: "key-1" } as const;
const discoverRequest: CodingToolActionRequest = {
  ...identity,
  action: "discover",
  query: "private-query",
  maxResults: 10,
};
const context: CanonicalCatalogContext = {
  runId: "run-1",
  correlationId: "a".repeat(36),
  workspaceRoot: "/workspace",
  workspaceIdentity: "workspace-1",
  workspaceRevision: "b".repeat(64),
  authorityExpiresAt: "2030-01-01T00:00:00.000Z",
  now: 0,
};

function createBridge(overrides: Partial<CanonicalCatalogFacadeBridgeInput> = {}): {
  readonly bridge: ReturnType<typeof createCanonicalCatalogFacadeBridge>;
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
} {
  const log = createBufferedServerLogSink();
  const bridge = createCanonicalCatalogFacadeBridge({
    authority: {
      admit: (): {
        readonly ok: true;
        readonly mutationGuard: { readonly check: () => boolean };
      } => ({ ok: true, mutationGuard: { check: () => true } }),
    },
    previewAuthority: () => ({ ok: true }),
    invocationRegistry: createCodingToolInvocationRegistry({ now: () => 0 }),
    context: () => context,
    logPort: { primary: log, diagnostics: defaultServerDiagnosticSink },
    approvalAvailable: false,
    ...overrides,
  });
  return { bridge, log };
}

function facadeInput(): { readonly body: string; readonly capability: string } {
  return { body: JSON.stringify(discoverRequest), capability: "capability" };
}

const COVERED: readonly CodingToolActionRequest[] = [
  discoverRequest,
  {
    ...identity,
    action: "read",
    relativePath: "README.md",
    startLine: 1,
    maxLines: 20,
  },
  {
    ...identity,
    action: "search",
    repositoryRequest: { kind: "search", mode: "literal", query: "x", maxResults: 3 },
  },
  {
    ...identity,
    action: "edit",
    changeset: { patch: "diff", files: [{ file: "a.ts" }] },
  },
  { ...identity, action: "verification", verifierId: "test" },
  { ...identity, action: "egress", target: "https://example.invalid" },
  { ...identity, action: "skill", skillId: "skill" },
  { ...identity, action: "child-agent", objective: "inspect", maxToolCalls: 1 },
  { ...identity, action: "git", operation: "status" },
  { ...identity, action: "git", operation: "diff", scope: "working-tree", paths: [] },
  { ...identity, action: "git", operation: "stage", phase: "propose", paths: [] },
  { ...identity, action: "git", operation: "ci" },
  { ...identity, action: "delivery", intent: "commit", phase: "propose", message: "change" },
  { ...identity, action: "delivery", intent: "push", phase: "propose" },
  {
    ...identity,
    action: "delivery",
    intent: "pull-request",
    phase: "propose",
    title: "change",
  },
];

const UNCOVERED: readonly CodingToolActionRequest[] = [
  { ...identity, action: "read", relativePath: "README.md" },
  { ...identity, action: "command", commandId: "command" },
  { ...identity, action: "connector", scope: "scope" },
  { ...identity, action: "git", operation: "read" },
  { ...identity, action: "delivery", intent: "merge", phase: "execute", proposalId: "p" },
];

describe("canonical catalog facade bridge", () => {
  it("binds every model-facing canonical action and leaves unsupported authority surfaces unbound", () => {
    const { bridge } = createBridge();
    for (const request of COVERED) expect(bridge.covers(request)).toBe(true);
    for (const request of UNCOVERED) expect(bridge.covers(request)).toBe(false);
  });

  it("runs a covered action through canonical binding, projection, and settlement without logging bodies", async () => {
    const { bridge, log } = createBridge();
    const run = vi.fn((_signal: AbortSignal, mutationGuard: { readonly check: () => boolean }) => {
      expect(mutationGuard.check()).toBe(true);
      return Promise.resolve({
        status: "completed" as const,
        evidence: [{ kind: "governed-delegate", code: "completed" }],
      });
    });

    const result = await bridge.execute(discoverRequest, facadeInput(), run);

    expect(result.status).toBe("completed");
    expect(run).toHaveBeenCalledOnce();
    expect(log.events.map((event) => event.op)).toEqual([
      "tool-catalog.bind-ready",
      "tool-catalog.projection",
      "tool-catalog.invocation-started",
      "tool-catalog.invocation-settled",
    ]);
    expect(JSON.stringify(log.events)).not.toContain("private-query");
    expect(log.events.every((event) => event.correlationId === context.correlationId)).toBe(true);
  });

  it("fails a stale invocation closed with a terminal receipt before the handler when budget availability changed", async () => {
    const budgetPort: CatalogToolBudgetPort = {
      available: () => false,
      reserve: () => {
        throw new Error("must not reserve");
      },
      check: () => false,
      commit: () => undefined,
      release: () => undefined,
    };
    const { bridge, log } = createBridge({ budgetPort });
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const, evidence: [] }));

    await expect(bridge.execute(discoverRequest, facadeInput(), run)).resolves.toEqual({
      status: "denied",
      evidence: [],
    });
    expect(run).not.toHaveBeenCalled();
    expect(log.events.at(-1)?.extra).toMatchObject({
      status: "denied",
      reason: "budget-exhausted",
      effectStarted: false,
      budgetDisposition: "not-reserved",
    });
  });

  it("preserves the governed failure result while canonical settlement commits started work", async () => {
    const { bridge, log } = createBridge();
    const failure = {
      status: "failed" as const,
      evidence: [{ kind: "governed-delegate", code: "failed" }],
      reasonCode: "VERIFICATION_FAILED",
    };

    await expect(
      bridge.execute(discoverRequest, facadeInput(), (_signal, mutationGuard) => {
        expect(mutationGuard.check()).toBe(true);
        return Promise.resolve(failure);
      }),
    ).resolves.toEqual(failure);
    expect(log.events.at(-1)?.extra).toMatchObject({
      status: "failed",
      reason: "handler-failed",
      effectStarted: true,
      budgetDisposition: "committed",
    });
  });

  it("records one body-free event when an unsupported authority surface uses its existing path", () => {
    const { bridge, log } = createBridge();
    const request = UNCOVERED[1];
    if (request === undefined) throw new Error("fixture missing");

    bridge.recordUnbound(request, facadeInput());

    expect(log.events).toHaveLength(1);
    expect(log.events[0]).toMatchObject({
      op: "tool-catalog.dispatch-unbound",
      correlationId: context.correlationId,
      extra: { action: "command" },
    });
  });

  it("revalidates the live branch-head revision at the effect boundary", async () => {
    let revision = context.workspaceRevision;
    let effects = 0;
    const { bridge, log } = createBridge({
      context: () => ({ ...context, workspaceRevision: revision }),
      authority: {
        admit: (): {
          readonly ok: true;
          readonly mutationGuard: { readonly check: () => boolean };
        } => {
          revision = "c".repeat(64);
          return { ok: true, mutationGuard: { check: () => true } };
        },
      },
    });

    const result = await bridge.execute(
      discoverRequest,
      facadeInput(),
      (_signal, mutationGuard) => {
        if (mutationGuard.check()) effects += 1;
        return Promise.resolve({ status: "completed", evidence: [] });
      },
    );

    expect(result).toEqual({ status: "invalid", evidence: [] });
    expect(effects).toBe(0);
    expect(
      log.events.find((event) => event.op === "tool-catalog.invocation-settled")?.extra,
    ).toMatchObject({
      status: "invalid",
      reason: "workspace-stale",
      effectStarted: false,
    });
  });

  it("preserves an authoritative catalog timeout in the model-facing IPC result", async () => {
    vi.useFakeTimers();
    let now = 0;
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { bridge, log } = createBridge({
      context: () => ({
        ...context,
        authorityExpiresAt: new Date(5_000).toISOString(),
        now,
      }),
    });

    const pending = bridge.execute(discoverRequest, facadeInput(), () => {
      started();
      return new Promise(() => undefined);
    });
    await handlerStarted;
    now = 6_000;
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toEqual({ status: "timeout", evidence: [] });
    expect(log.events.at(-1)?.extra).toMatchObject({
      status: "timeout",
      reason: "deadline-exceeded",
    });
    vi.useRealTimers();
  });
});
