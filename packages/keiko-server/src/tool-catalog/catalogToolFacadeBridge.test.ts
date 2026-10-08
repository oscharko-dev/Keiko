import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";

import { describe, expect, it, vi } from "vitest";
import {
  EDITOR_AGENT_CONFLICT_CODES,
  EDITOR_AGENT_FAILURE_CODES,
} from "@oscharko-dev/keiko-contracts/runtime/editor-agent";

const catalogWork = vi.hoisted(() => ({
  compileProjection: vi.fn(),
  computeHandlerDigest: vi.fn(),
}));
vi.mock("@oscharko-dev/keiko-tool-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-tool-catalog")>();
  return {
    ...actual,
    compileToolProjection: (
      ...args: Parameters<typeof actual.compileToolProjection>
    ): ReturnType<typeof actual.compileToolProjection> => {
      catalogWork.compileProjection();
      return actual.compileToolProjection(...args);
    },
    computeHandlerSetDigest: (
      ...args: Parameters<typeof actual.computeHandlerSetDigest>
    ): ReturnType<typeof actual.computeHandlerSetDigest> => {
      catalogWork.computeHandlerDigest();
      return actual.computeHandlerSetDigest(...args);
    },
  };
});

import type { CodingToolMutationGuard } from "../coding-runtime/codingToolFacadePorts.js";
import { nativeTextSnapshotRegistrationSet } from "@oscharko-dev/keiko-tool-catalog";
import type { CodingToolActionRequest, CodingToolResult } from "../coding-runtime/codingToolIpc.js";
import { createCodingToolInvocationRegistry } from "../coding-runtime/codingToolInvocationRegistry.js";
import type { OpenCodeOptionalToolName } from "../coding-runtime/opencodeLaunchProfile.js";
import { defaultServerDiagnosticSink } from "../diagnostics-log.js";
import { type ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  openCodeCatalogAliasFor,
  createCanonicalOpenCodeHandlerCoverage,
  createCanonicalCatalogFacadeBridge,
  type CanonicalCatalogContext,
  type CanonicalCatalogFacadeBridgeInput,
} from "./catalogToolFacadeBridge.js";
import type { CatalogToolBudgetPort } from "./catalogToolPorts.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((accept) => {
      resolve = accept;
    }),
    resolve,
  };
}

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
    elapsedNow: () => context.now,
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
    repositoryRequest: {
      kind: "search",
      mode: "literal",
      query: "x",
      caseSensitive: false,
      includeGlobs: [],
      excludeGlobs: [],
      maxResults: 3,
    },
  },
  {
    ...identity,
    action: "edit",
    changeset: { patch: "diff", files: [{ file: "a.ts" }] },
  },
  { ...identity, action: "verification", verifierId: "test" },
  { ...identity, action: "egress", target: "https://example.invalid" },
  { ...identity, action: "skill", skillId: "skill" },
  { ...identity, action: "skill-discover" },
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
  it("#3417: reports skill discovery unavailable together with the skill it lists", () => {
    const ready = createCanonicalOpenCodeHandlerCoverage(new Set());
    const hidden = createCanonicalOpenCodeHandlerCoverage(
      new Set(["keiko_skill_discover", "keiko_skill"] as const),
    );
    expect(ready.readinessByToolId.get("keiko.skill.discover")).toBe("ready");
    expect(hidden.readinessByToolId.get("keiko.skill.discover")).toBe("unavailable");
    expect(hidden.readinessByToolId.get("keiko.skill.invoke")).toBe("unavailable");
    expect(hidden.readinessByToolId.get("keiko.workspace.read")).toBe("ready");
    expect(hidden.handlerSetDigest).not.toBe(ready.handlerSetDigest);
  });

  it("binds every model-facing canonical action and leaves unsupported authority surfaces unbound", () => {
    const { bridge } = createBridge();
    for (const request of COVERED) expect(bridge.covers(request)).toBe(true);
    for (const request of UNCOVERED) expect(bridge.covers(request)).toBe(false);
  });

  it.each([
    ["ordinary sentinel", { ...identity, action: "verification" as const, verifierId: "test" }],
    [
      "targeted path",
      {
        ...identity,
        action: "verification" as const,
        verifierId: "targeted-test",
        targetPath: "src/math.test.ts",
      },
    ],
  ])("projects the %s through the canonical verification schema", async (_label, request) => {
    const { bridge, log } = createBridge({ approvalAvailable: true });
    const run = vi.fn((_signal: AbortSignal, mutationGuard: { readonly check: () => boolean }) => {
      expect(mutationGuard.check()).toBe(true);
      return Promise.resolve({
        status: "completed" as const,
        evidence: [{ kind: "governed-delegate", code: "completed" }],
        verification: {
          status: "passed" as const,
          completed: ["test"] as const,
          commit: { commitProof: "recorded" as const },
        },
      });
    });
    const result = await bridge.execute(request, facadeInput(), run);
    expect(run).toHaveBeenCalledOnce();
    expect({ result, lastEvent: log.events.at(-1) }).toMatchObject({
      result: { status: "completed" },
    });
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

  it("settles a known operation as denied when authority was revoked after its model offer", async () => {
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const, evidence: [] }));
    const { bridge, log } = createBridge({
      previewAuthority: () => ({ ok: false, reason: "revoked" }),
    });

    await expect(bridge.execute(discoverRequest, facadeInput(), run)).resolves.toEqual({
      status: "denied",
      evidence: [],
    });

    expect(run).not.toHaveBeenCalled();
    expect(log.events.at(-1)?.extra).toMatchObject({
      status: "denied",
      reason: "hard-denial",
      effectStarted: false,
    });
  });

  it("fails an optional handler closed when live availability disappears after its offer", async () => {
    let unavailable = new Set<OpenCodeOptionalToolName>();
    const { bridge, log } = createBridge({
      unavailableOptionalTools: () => unavailable,
      previewAuthority: () => {
        unavailable = new Set<OpenCodeOptionalToolName>(["keiko_research_fetch"]);
        return { ok: true };
      },
    });
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const, evidence: [] }));
    const request = COVERED.find((entry) => entry.action === "egress");
    if (request === undefined) throw new Error("optional egress fixture missing");

    await expect(bridge.execute(request, facadeInput(), run)).resolves.toEqual({
      status: "failed",
      evidence: [],
    });
    expect(run).not.toHaveBeenCalled();
    expect(log.events.at(-1)?.extra).toMatchObject({
      status: "failed",
      reason: "handler-unavailable",
      effectStarted: false,
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
    expect(log.events.at(-1)).toMatchObject({
      op: "tool-catalog.invocation-settled",
      correlationId: context.correlationId,
      errorKind: "internal",
      extra: {
        status: "failed",
        reason: "handler-failed",
        effectStarted: true,
        budgetDisposition: "committed",
      },
    });
  });

  it("records an executed red Vitest result as a completed handler without hiding failed tests", async () => {
    const { bridge, log } = createBridge();
    const request = COVERED.find((entry) => entry.action === "verification");
    if (request === undefined) throw new Error("verification fixture missing");
    const failedTests = {
      status: "failed" as const,
      evidence: [{ kind: "governed-delegate" as const, code: "VERIFICATION_FAILED" }],
      reasonCode: "VERIFICATION_FAILED",
    };

    await expect(
      bridge.execute(request, facadeInput(), (_signal, mutationGuard) => {
        expect(mutationGuard.check()).toBe(true);
        return Promise.resolve(failedTests);
      }),
    ).resolves.toEqual(failedTests);
    expect(log.events.at(-1)).toMatchObject({
      op: "tool-catalog.invocation-settled",
      extra: {
        status: "completed",
        reason: "none",
        effectStarted: true,
        budgetDisposition: "committed",
      },
    });
    expect(log.events.at(-1)?.errorKind).toBeUndefined();
  });

  // #3615: a refusal the handler gave for the model's own input -- a stale base, a patch that does
  // not apply, a denied or missing path -- settles as that verdict below error level, so it opens no
  // support incident, and the model still receives the handler's own result.
  it.each([
    ["CONTENT_HASH_MISMATCH", "invalid", "workspace-stale"],
    ["INVALID_EDITS", "invalid", "invalid-arguments"],
    ["OUT_OF_SCOPE", "denied", "workspace-denied"],
    ["workspace-read-denied", "denied", "workspace-denied"],
    ["workspace-read-not-found", "invalid", "invalid-arguments"],
    // PR #3617 review: the routine editor refusals are verdicts too.
    ["POLICY_DENIED", "denied", "workspace-denied"],
    ["DIRTY", "invalid", "workspace-stale"],
    ["APPROVAL_REQUIRED", "denied", "approval-required"],
    ["UNSUPPORTED_OPERATION", "invalid", "unsupported-capability"],
    ["DUPLICATE_ACTION", "invalid", "replay-conflict"],
    ["QUEUE_FULL", "busy", "capacity-exhausted"],
    ["MUTATION_IN_FLIGHT", "busy", "invocation-in-flight"],
    ["TIMED_OUT", "timeout", "deadline-exceeded"],
    ["CANCELLED", "cancelled", "explicit-cancellation"],
    ["WORKSPACE_ACCESS_LOST", "denied", "workspace-denied"],
  ] as const)(
    "settles a %s refusal as %s / %s below error level and keeps the handler result",
    async (code, status, reason) => {
      const { bridge, log } = createBridge();
      const refusal = {
        status: "failed" as const,
        evidence: [{ kind: "governed-delegate", code }],
        guidance: "Re-read the file and rebuild the patch.",
      };

      await expect(
        bridge.execute(discoverRequest, facadeInput(), (_signal, mutationGuard) => {
          expect(mutationGuard.check()).toBe(true);
          return Promise.resolve(refusal);
        }),
      ).resolves.toEqual(refusal);
      const settled = log.events.at(-1);
      expect(settled).toMatchObject({
        op: "tool-catalog.invocation-settled",
        extra: { status, reason, effectStarted: true, budgetDisposition: "committed" },
      });
      expect(settled?.level).not.toBe("error");
    },
  );

  // PR #3617 review: every editor-agent conflict and failure code is classified at the bridge, so
  // none becomes a handler fault, none settles as failed, and none opens a support incident. An
  // editor that is not connected is a capability that is unavailable right now.
  const UNAVAILABLE_EDITOR_CODES: ReadonlySet<string> = new Set([
    "NO_ACTIVE_SESSION",
    "NO_ACTIVE_BRIDGE",
    "PROVIDER_UNAVAILABLE",
  ]);
  const EDITOR_CODES = [...EDITOR_AGENT_CONFLICT_CODES, ...EDITOR_AGENT_FAILURE_CODES];

  async function settledEditorRefusal(code: string): Promise<ServerLogEvent | undefined> {
    const { bridge, log } = createBridge();
    const refusal = { status: "failed" as const, evidence: [{ kind: "governed-delegate", code }] };
    await expect(
      bridge.execute(discoverRequest, facadeInput(), (_signal, mutationGuard) => {
        expect(mutationGuard.check()).toBe(true);
        return Promise.resolve(refusal);
      }),
    ).resolves.toEqual(refusal);
    return log.events.at(-1);
  }

  it.each(EDITOR_CODES)(
    "settles the editor refusal %s as its own verdict below error level",
    async (code) => {
      const settled = await settledEditorRefusal(code);
      expect(settled?.op).toBe("tool-catalog.invocation-settled");
      expect(settled?.extra?.status).not.toBe("failed");
      expect(settled?.level).not.toBe("error");
    },
  );

  it.each([...UNAVAILABLE_EDITOR_CODES])(
    "settles the editor code %s as an unavailable capability, not a handler fault",
    async (code) => {
      const settled = await settledEditorRefusal(code);
      expect(settled?.extra).toMatchObject({ status: "invalid", reason: "unsupported-capability" });
      expect(settled?.errorKind).toBe("unavailable");
    },
  );

  it("settles a governed failure without re-entering a revoked live context for its clock", async () => {
    const started = deferred<undefined>();
    const finish = deferred<undefined>();
    let available = true;
    const liveContext = vi.fn((): CanonicalCatalogContext => {
      if (!available) throw new Error("runtime-workspace-drift-private-path");
      return context;
    });
    const { bridge, log } = createBridge({ context: liveContext });
    const failure = {
      status: "failed" as const,
      evidence: [{ kind: "governed-delegate", code: "authority-denied" }],
      reasonCode: "AUTHORITY_DENIED",
    };

    const pending = bridge.execute(discoverRequest, facadeInput(), async (_signal, guard) => {
      expect(guard.check()).toBe(true);
      started.resolve(undefined);
      await finish.promise;
      return failure;
    });
    await started.promise;
    const contextReadsBeforeRevocation = liveContext.mock.calls.length;
    available = false;
    finish.resolve(undefined);

    await expect(pending).resolves.toEqual(failure);
    expect(liveContext).toHaveBeenCalledTimes(contextReadsBeforeRevocation);
    expect(log.events.at(-1)).toMatchObject({
      op: "tool-catalog.invocation-settled",
      correlationId: context.correlationId,
      errorKind: "internal",
      extra: {
        status: "failed",
        reason: "handler-failed",
        effectStarted: true,
        budgetDisposition: "committed",
      },
    });
    expect(JSON.stringify(log.events)).not.toContain("runtime-workspace-drift-private-path");
  });

  it("settles cancellation without re-entering a revoked live context for its clock", async () => {
    const started = deferred<undefined>();
    const finish = deferred<CodingToolResult>();
    const controller = new AbortController();
    let available = true;
    const liveContext = vi.fn((): CanonicalCatalogContext => {
      if (!available) throw new Error("runtime-workspace-drift-private-path");
      return context;
    });
    const { bridge, log } = createBridge({ context: liveContext });
    const pending = bridge.execute(
      discoverRequest,
      { ...facadeInput(), signal: controller.signal },
      async (_signal, guard) => {
        expect(guard.check()).toBe(true);
        started.resolve(undefined);
        return finish.promise;
      },
    );
    await started.promise;
    const contextReadsBeforeRevocation = liveContext.mock.calls.length;
    available = false;
    controller.abort();

    await expect(pending).resolves.toEqual({ status: "cancelled", evidence: [] });
    expect(liveContext).toHaveBeenCalledTimes(contextReadsBeforeRevocation);
    expect(log.events.at(-1)).toMatchObject({
      op: "tool-catalog.invocation-settled",
      correlationId: context.correlationId,
      extra: {
        status: "cancelled",
        reason: "parent-cancelled",
        effectStarted: true,
        budgetDisposition: "committed",
      },
    });
    expect(JSON.stringify(log.events)).not.toContain("runtime-workspace-drift-private-path");
    finish.resolve({ status: "completed", evidence: [] });
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
      errorKind: "unavailable",
      extra: { action: "command" },
    });
    const proven = expectActivityLogProof(
      "tool-catalog.dispatch-unbound.emitted-line",
      formatActivityLogProofLine(log.events[0] ?? {}),
    );
    expect(proven).toMatchObject({ action: "command" });
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

  // PR #3452 (F43/F44): an offer bounds admission, not the call it admitted. The facade's targeted
  // offer lives 30 s, and a verification whose effect guard ran later was refused as `unoffered-tool`.
  it("keeps an admitted call's effect guard valid after the offer that admitted it expired", async () => {
    let now = 0;
    const { bridge, log } = createBridge({
      context: () => ({ ...context, now }),
      elapsedNow: () => now,
    });
    const verification: CodingToolActionRequest = {
      ...identity,
      action: "verification",
      verifierId: "test",
    };
    let guardAfterExpiry: boolean | undefined;
    const result = await bridge.execute(verification, facadeInput(), (_signal, mutationGuard) => {
      now = 60_000;
      guardAfterExpiry = mutationGuard.check();
      return Promise.resolve({
        status: "completed" as const,
        evidence: [{ kind: "governed-delegate" as const, code: "completed" as const }],
      });
    });

    expect(guardAfterExpiry).toBe(true);
    expect(result).toMatchObject({ status: "completed" });
    expect(
      log.events.find((event) => event.op === "tool-catalog.invocation-settled")?.extra,
    ).toMatchObject({ status: "completed" });
  });

  // The live authority still bounds the effect: past its expiry the guard refuses it.
  it("still refuses an admitted call's effect once the live authority expired", async () => {
    let now = 0;
    const { bridge } = createBridge({
      context: () => ({ ...context, authorityExpiresAt: new Date(10_000).toISOString(), now }),
      elapsedNow: () => now,
    });
    let guardAfterExpiry: boolean | undefined;
    await bridge.execute(
      { ...identity, action: "verification", verifierId: "test" },
      facadeInput(),
      (_signal, mutationGuard) => {
        now = 60_000;
        guardAfterExpiry = mutationGuard.check();
        return Promise.resolve({
          status: "completed" as const,
          evidence: [{ kind: "governed-delegate" as const, code: "completed" as const }],
        });
      },
    );

    expect(guardAfterExpiry).toBe(false);
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
      elapsedNow: () => now,
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

  it("prepares the real projection and handler digest once across sequential and concurrent calls", async () => {
    catalogWork.compileProjection.mockClear();
    catalogWork.computeHandlerDigest.mockClear();
    const { bridge } = createBridge();

    const execute = (
      suffix: string,
      run: (
        signal: AbortSignal,
        mutationGuard: { readonly check: () => boolean },
      ) => Promise<{
        readonly status: "completed";
        readonly evidence: readonly [
          { readonly kind: "governed-delegate"; readonly code: "completed" },
        ];
      }>,
    ): Promise<unknown> =>
      bridge.execute(
        {
          ...discoverRequest,
          actionId: `action-${suffix}`,
          idempotencyKey: `key-${suffix}`,
        },
        facadeInput(),
        run,
      );
    const completed = (
      _signal: AbortSignal,
      mutationGuard: { readonly check: () => boolean },
    ): Promise<{
      readonly status: "completed";
      readonly evidence: readonly [
        { readonly kind: "governed-delegate"; readonly code: "completed" },
      ];
    }> => {
      expect(mutationGuard.check()).toBe(true);
      return Promise.resolve({
        status: "completed",
        evidence: [{ kind: "governed-delegate", code: "completed" }],
      });
    };
    const sequentialRun = vi.fn(completed);
    const leftRun = vi.fn(completed);
    const rightRun = vi.fn(completed);
    const first = await execute("sequential", sequentialRun);
    const concurrent = await Promise.all([execute("left", leftRun), execute("right", rightRun)]);

    expect(catalogWork.compileProjection).toHaveBeenCalledOnce();
    expect(catalogWork.computeHandlerDigest).toHaveBeenCalledOnce();
    expect(first).toMatchObject({ status: "completed" });
    expect(concurrent).toEqual([
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(sequentialRun).toHaveBeenCalledOnce();
    expect(leftRun).toHaveBeenCalledOnce();
    expect(rightRun).toHaveBeenCalledOnce();
  });

  it("rechecks optional handler readiness live without recompiling the prepared catalog", async () => {
    const unavailable = new Set<"keiko_research_fetch">(["keiko_research_fetch"]);
    const unavailableDigest = createCanonicalOpenCodeHandlerCoverage(unavailable).handlerSetDigest;
    const readyDigest = createCanonicalOpenCodeHandlerCoverage(new Set()).handlerSetDigest;
    catalogWork.compileProjection.mockClear();
    catalogWork.computeHandlerDigest.mockClear();
    const { bridge, log } = createBridge({ unavailableOptionalTools: () => unavailable });
    const run = vi.fn((_signal: AbortSignal, mutationGuard: { readonly check: () => boolean }) => {
      expect(mutationGuard.check()).toBe(true);
      return Promise.resolve({
        status: "completed" as const,
        evidence: [{ kind: "governed-delegate" as const, code: "completed" as const }],
      });
    });
    const request = (suffix: string): CodingToolActionRequest => ({
      action: "egress",
      actionId: `egress-${suffix}`,
      idempotencyKey: `egress-${suffix}`,
      target: "https://example.invalid/",
    });

    await expect(bridge.execute(request("unavailable"), facadeInput(), run)).resolves.toMatchObject(
      {
        status: "invalid",
      },
    );
    expect(run).not.toHaveBeenCalled();
    unavailable.clear();
    await expect(bridge.execute(request("ready"), facadeInput(), run)).resolves.toMatchObject({
      status: "completed",
    });

    expect(catalogWork.compileProjection).toHaveBeenCalledOnce();
    expect(catalogWork.computeHandlerDigest).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledOnce();
    const bindings = log.events.filter((event) => event.op.startsWith("tool-catalog.bind-"));
    expect(unavailableDigest).not.toBe(readyDigest);
    expect(bindings[0]?.extra?.handlerSetDigest).toBeUndefined();
    expect(bindings[1]?.extra?.handlerSetDigest).toBe(readyDigest);
  });
});

describe("inactive Code Mode handler coverage", () => {
  it("binds the actual same seventeen handlers to the selected projection identity", () => {
    const direct = createCanonicalOpenCodeHandlerCoverage(new Set());
    const grouped = createCanonicalOpenCodeHandlerCoverage(new Set(), "code-mode");
    expect(grouped.readinessByToolId).toEqual(direct.readinessByToolId);
    expect(grouped.readinessByToolId.size).toBe(17);
    expect(grouped.handlerSetDigest).not.toBe(direct.handlerSetDigest);
  });
});

it("derives mapped aliases from the existing canonical request producer", () => {
  expect(openCodeCatalogAliasFor(discoverRequest)).toBe("keiko_workspace_discover");
  expect(
    openCodeCatalogAliasFor({
      ...identity,
      action: "git",
      operation: "stage",
      phase: "execute",
      proposalId: "proposal",
    }),
  ).toBe("keiko_git_execute");
  expect(new Set(COVERED.map(openCodeCatalogAliasFor)).size).toBe(COVERED.length);
  for (const request of UNCOVERED) expect(openCodeCatalogAliasFor(request)).toBeUndefined();
});

describe("private native snapshot canonical binding", () => {
  const request = {
    action: "read" as const,
    relativePath: "src/private.ts",
    actionId: "native-private-1",
    idempotencyKey: "native-private-1",
  };
  it("does not add windowless reads to public coverage or create the private profile by default", () => {
    const { bridge } = createBridge();
    expect(bridge.covers(request)).toBe(false);
    expect(bridge.executeTextSnapshot).toBeUndefined();
  });
  it("refuses private windows before the canonical handler executes", async () => {
    const { bridge, log } = createBridge({ nativeTextSnapshotAvailable: true });
    const run = vi.fn(() => Promise.resolve({ status: "completed" as const, evidence: [] }));
    expect(
      await bridge.executeTextSnapshot?.(
        { ...request, startLine: 1, maxLines: 1 },
        facadeInput(),
        run,
      ),
    ).toEqual({ status: "invalid", evidence: [] });
    expect(run).not.toHaveBeenCalled();
    expect(log.events.map((event) => event.op)).toEqual(["tool-catalog.dispatch-unbound"]);
  });
  it.each([
    { status: "completed" as const, evidence: [] },
    {
      status: "completed" as const,
      evidence: [],
      snapshot: {
        digest: "a".repeat(64),
        byteCount: 0,
        info: { type: "file", size: 0, mtimeMs: 0 },
      },
    },
    {
      status: "completed" as const,
      evidence: [],
      read: {
        text: "PRIVATE_NATIVE_TEXT_SENTINEL",
        byteCount: 28,
        totalLines: 1,
        digest: "a".repeat(64),
      },
    },
  ])(
    "rejects a fabricated model-read completion under the closed private receipt schema",
    async (result) => {
      const { bridge, log } = createBridge({ nativeTextSnapshotAvailable: true });
      const run = vi.fn(
        (_signal: AbortSignal, guard: CodingToolMutationGuard): Promise<CodingToolResult> => {
          expect(guard.check()).toBe(true);
          return Promise.resolve(result);
        },
      );
      expect(await bridge.executeTextSnapshot?.(request, facadeInput(), run)).toEqual({
        status: "failed",
        evidence: [],
      });
      expect(run).toHaveBeenCalledOnce();
      expect(
        log.events.find((event) => event.op === "tool-catalog.invocation-settled")?.extra,
      ).toMatchObject({ status: "failed", reason: "result-contract-failed" });
      expect(JSON.stringify(log.events)).not.toContain("PRIVATE_NATIVE_TEXT_SENTINEL");
      expect(JSON.stringify(log.events)).not.toContain("src/private.ts");
    },
  );

  it("expires the actual private descriptor invocation and withholds late completion", async () => {
    let elapsed = 0;
    const { bridge, log } = createBridge({
      nativeTextSnapshotAvailable: true,
      elapsedNow: () => elapsed,
    });
    const completion = deferred<CodingToolResult>();
    let captured: CodingToolMutationGuard | undefined;
    const run = vi.fn(
      (_signal: AbortSignal, guard: CodingToolMutationGuard): Promise<CodingToolResult> => {
        captured = guard;
        expect(guard.check()).toBe(true);
        return completion.promise;
      },
    );
    const pending = bridge.executeTextSnapshot?.(request, facadeInput(), run);
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledOnce();
    });
    const descriptor = nativeTextSnapshotRegistrationSet().entries[0]?.descriptor;
    if (descriptor === undefined) throw new TypeError("Expected private descriptor");
    elapsed = descriptor.bounds.maxDurationMs + 1;
    expect(captured?.check()).toBe(false);
    await expect(pending).resolves.toEqual({ status: "timeout", evidence: [] });
    completion.resolve({ status: "completed", evidence: [] });
    await vi.waitFor(() => {
      expect(log.events.some((event) => event.op === "tool-catalog.completion-discarded")).toBe(
        true,
      );
    });
    expect(captured?.check()).toBe(false);
    expect(
      log.events.find((event) => event.op === "tool-catalog.invocation-settled")?.extra,
    ).toMatchObject({ status: "timeout", reason: "deadline-exceeded" });
  });
});

it("passes the actual opaque catalog invocation to the private original-read delegate with one settlement", async () => {
  const { bridge, log } = createBridge({ nativeTextSnapshotAvailable: true });
  const request = { ...identity, action: "read" as const, relativePath: "README.md" };
  const seen: string[] = [];
  const result = await bridge.executeNativeReadInvocation?.(
    request,
    {
      body: JSON.stringify(request),
      capability: "capability",
      context: { sessionID: "session", messageID: "message", id: "call", agent: "build" },
      offset: 0,
      limit: 20,
    },
    (_signal, guard, invocationId): Promise<CodingToolResult> => {
      expect(guard.check()).toBe(true);
      seen.push(invocationId);
      return Promise.resolve({
        status: "completed",
        evidence: [{ kind: "native-read-invocation", code: "completed" }],
      });
    },
  );
  expect(result?.status).toBe("completed");
  const admitted = log.events.filter((event) => event.op === "tool-catalog.invocation-started");
  const settled = log.events.filter((event) => event.op === "tool-catalog.invocation-settled");
  expect(admitted).toHaveLength(1);
  expect(settled).toHaveLength(1);
  expect(seen).toEqual([admitted[0]?.extra?.invocationId]);
  expect(settled[0]?.extra?.invocationId).toBe(seen[0]);
  expect(JSON.stringify(log.events)).not.toContain("README.md");
  expect(JSON.stringify(log.events)).not.toContain("capability");
});

it.each(["", "long-segment/".repeat(50) + "é.ts"])(
  "keeps exact original Read targets at private handler capture without public parser substitution (%#)",
  async (relativePath) => {
    const request = { ...identity, action: "read" as const, relativePath };
    const capture = vi.fn(() => request);
    const run = vi.fn(
      (_signal: AbortSignal, guard: CodingToolMutationGuard): Promise<CodingToolResult> => {
        expect(guard.check()).toBe(true);
        return Promise.resolve({
          status: "completed",
          evidence: [{ kind: "native-read-invocation", code: "completed" }],
        });
      },
    );
    const { bridge, log } = createBridge({
      nativeTextSnapshotAvailable: true,
      captureNativeReadAction: capture,
    });
    const result = await bridge.executeNativeReadInvocation?.(
      request,
      {
        body: JSON.stringify(request),
        capability: "capability",
        offset: 0,
        limit: 0,
        context: { sessionID: "session", messageID: "message", id: "call", agent: "build" },
      },
      run,
    );
    expect(result?.status).toBe("completed");
    expect(run).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.events)).not.toContain("long-segment/");
    const ordinary = await bridge.executeTextSnapshot?.(
      { ...request, actionId: "snapshot-next", idempotencyKey: "snapshot-next" },
      facadeInput(),
      run,
    );
    expect(ordinary?.status).not.toBe("completed");
    expect(run).toHaveBeenCalledOnce();
  },
);
