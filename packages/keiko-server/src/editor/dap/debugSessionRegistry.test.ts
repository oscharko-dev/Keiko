import { PassThrough } from "node:stream";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { DebugLifecycleEvidence } from "@oscharko-dev/keiko-contracts";
import type { QualifiedDebugCapsuleHandle } from "./dapCapsuleSupervisor.js";
import {
  createDebugSessionRegistry,
  DEBUG_MAX_REPLAY_ENTRIES,
  type DebugProtocolPort,
  type DebugProvisionalReservationInput,
  type DebugReservationPromotion,
  type DebugReservationInput,
  type DebugSessionRegistry,
} from "./debugSessionRegistry.js";

function identity(sessionId = "session_a", partition = "partition_a"): DebugReservationInput {
  return {
    sessionId,
    workspaceId: `workspace_${partition}`,
    workspacePartitionKey: partition,
    browserSessionBinding: "browser_a",
    planId: "plan_a",
    planEpoch: 1,
    planExpiresAtMs: 10_000,
    targetKind: "file",
    activationRevision: 7,
    provisioningDigest: "a".repeat(64),
    backend: "oci",
    network: "none",
    filesystem: "executionRoot",
    runtimeIdentityDigest: "b".repeat(64),
  };
}

function provisional(
  sessionId = "session_a",
  partition = "partition_a",
): DebugProvisionalReservationInput {
  const value = identity(sessionId, partition);
  return {
    sessionId: value.sessionId,
    workspaceId: value.workspaceId,
    workspacePartitionKey: value.workspacePartitionKey,
    browserSessionBinding: value.browserSessionBinding,
    targetKind: value.targetKind,
    activationRevision: value.activationRevision,
    network: value.network,
    filesystem: value.filesystem,
  };
}

function promotion(overrides: Partial<DebugReservationPromotion> = {}): DebugReservationPromotion {
  return {
    planId: "plan_a",
    planEpoch: 1,
    planExpiresAtMs: 10_000,
    provisioningDigest: "a".repeat(64),
    backend: "oci",
    runtimeIdentityDigest: "b".repeat(64),
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

type TestCapsule = QualifiedDebugCapsuleHandle & {
  readonly terminateScope: Mock<
    () => Promise<{ readonly terminated: boolean; readonly descendantsRemaining: number }>
  >;
  readonly cleanup: Mock<QualifiedDebugCapsuleHandle["cleanup"]>;
};

function capsule(
  terminate: () => Promise<{
    readonly terminated: boolean;
    readonly descendantsRemaining: number;
  }> = () => Promise.resolve({ terminated: true, descendantsRemaining: 0 }),
  cleanup: QualifiedDebugCapsuleHandle["cleanup"] = () => Promise.resolve(),
  planId = "plan_a",
): TestCapsule {
  let signalled = false;
  let inspectTermination = false;
  const terminateScope = vi.fn(terminate);
  return {
    planId,
    source: new PassThrough(),
    sink: { write: vi.fn() },
    processGroup: {
      pid: 42,
      kill: (): void => {
        signalled = true;
        inspectTermination = true;
      },
    },
    exited: () => signalled,
    inspectScope: async (): Promise<{
      readonly qualified: true;
      readonly backend: "oci";
      readonly runtimeIdentityDigest: string;
      readonly descendants: number;
    }> => {
      const shouldInspectTermination = inspectTermination;
      inspectTermination = false;
      const result = shouldInspectTermination
        ? await terminateScope()
        : { terminated: false, descendantsRemaining: 1 };
      return {
        qualified: true,
        backend: "oci" as const,
        runtimeIdentityDigest: "b".repeat(64),
        descendants: result.descendantsRemaining,
      };
    },
    terminateContainment: (): Promise<void> => {
      signalled = true;
      return Promise.resolve();
    },
    terminateScope,
    cleanup: vi.fn(cleanup),
  };
}

function protocol(): DebugProtocolPort {
  return {
    dispose: vi.fn(),
    pendingCount: () => 0,
    request: <T>() => Promise.resolve({} as T),
  };
}

function ignoreOutputLimit(): void {
  // Tests without a live projection still exercise the required canonical notification port.
}

function setup(now: () => number = () => 1): {
  readonly records: { readonly partition: string; readonly evidence: DebugLifecycleEvidence }[];
  readonly append: Mock<(partition: string, evidence: DebugLifecycleEvidence) => Promise<void>>;
  readonly registry: DebugSessionRegistry;
} {
  const records: { partition: string; evidence: DebugLifecycleEvidence }[] = [];
  const append: Mock<(partition: string, evidence: DebugLifecycleEvidence) => Promise<void>> =
    vi.fn((partition: string, evidence: DebugLifecycleEvidence) => {
      records.push({ partition, evidence });
      return Promise.resolve();
    });
  return {
    records,
    append,
    registry: createDebugSessionRegistry({
      appendEvidence: append,
      now,
      emitOutputLimit: ignoreOutputLimit,
    }),
  };
}

async function activate(registry: DebugSessionRegistry, handle = capsule()): Promise<TestCapsule> {
  await registry.reserve(identity());
  const attempt = await registry.beginStartupAttempt("session_a");
  await registry.attachCapsule("session_a", attempt.attemptId, handle, {
    backend: "oci",
    runtimeIdentityDigest: "b".repeat(64),
  });
  registry.attachProtocol("session_a", attempt.attemptId, protocol());
  await registry.markRunning("session_a", attempt.attemptId);
  return handle;
}

describe("DebugSessionRegistry canonical lifecycle", () => {
  it("builds canonical start evidence from trusted identity and registry time", async () => {
    const { records, registry } = setup(() => 42);
    await registry.reserve(identity());
    expect(records).toHaveLength(1);
    expect(records[0]?.partition).toBe("partition_a");
    expect(records[0]?.evidence).toMatchObject({
      schemaVersion: "1",
      eventKind: "start",
      state: "starting",
      reason: "requested",
      timestampMs: 42,
      outputAcceptedBytes: 0,
      outputTruncatedEvents: 0,
    });
    expect(records[0]?.evidence).not.toHaveProperty("workspacePartitionKey");
  });

  it("binds a session to the exact workspace and browser capability without projecting either", async () => {
    const { registry } = setup();
    await registry.reserve(identity());

    expect(registry.isBoundTo("session_a", "partition_a", "browser_a")).toBe(true);
    expect(registry.isBoundTo("session_a", "partition_b", "browser_a")).toBe(false);
    expect(registry.isBoundTo("session_a", "partition_a", "browser_b")).toBe(false);
    expect(registry.isBoundTo("missing", "partition_a", "browser_a")).toBe(false);
    expect(registry.sessionBinding("session_a")).toEqual({
      workspaceId: "workspace_partition_a",
      workspacePartitionKey: "partition_a",
      browserSessionBinding: "browser_a",
    });
    expect(Object.isFrozen(registry.sessionBinding("session_a"))).toBe(true);
    expect(registry.sessionBinding("missing")).toBeUndefined();
    expect(registry.boundSessionId("partition_a", "browser_a")).toBe("session_a");
    expect(registry.boundSessionId("partition_a", "browser_b")).toBeUndefined();
    expect(registry.session("session_a")).not.toHaveProperty("workspacePartitionKey");
    expect(registry.session("session_a")).not.toHaveProperty("browserSessionBinding");
  });

  it("stores the current set-variable capability only for the active startup attempt", async () => {
    const { registry } = setup();
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    await registry.attachCapsule("session_a", attempt.attemptId, capsule(), {
      backend: "oci",
      runtimeIdentityDigest: "b".repeat(64),
    });

    expect(registry.session("session_a")?.supportsSetVariable).toBe(false);
    registry.setCapabilities("session_a", attempt.attemptId, { supportsSetVariable: true });
    expect(registry.session("session_a")?.supportsSetVariable).toBe(true);
    registry.setCapabilities("session_a", attempt.attemptId, { supportsSetVariable: false });
    expect(registry.session("session_a")?.supportsSetVariable).toBe(false);
    expect((): void => {
      registry.setCapabilities("session_a", attempt.attemptId + 1, {
        supportsSetVariable: true,
      });
    }).toThrow(expect.objectContaining({ code: "SESSION_TERMINATING" }));

    await registry.stop("session_a");
  });

  it("looks up only the exact browser binding and workspace partition", async () => {
    const { registry } = setup();
    await registry.reserve(identity("session_a", "partition_a"));
    await registry.reserve({
      ...identity("session_b", "partition_b"),
      browserSessionBinding: "browser_b",
      planId: "plan_b",
    });

    expect(registry.boundSessionId("partition_a", "browser_a")).toBe("session_a");
    expect(registry.boundSessionId("partition_b", "browser_b")).toBe("session_b");
    expect(registry.boundSessionId("partition_a", "browser_b")).toBeUndefined();
    expect(registry.boundSessionId("partition_b", "browser_a")).toBeUndefined();
    expect(registry.boundSessionId("missing", "browser_a")).toBeUndefined();
    expect(registry.workspaceSessionId("partition_a")).toBe("session_a");
    expect(registry.workspaceSessionId("partition_b")).toBe("session_b");
    expect(registry.workspaceSessionId("missing")).toBeUndefined();

    await registry.stop("session_a");
    await registry.stop("session_b");
  });

  it("emits stop then teardown durably before releasing capacity", async () => {
    const { records, registry } = setup();
    const handle = await activate(registry);
    await registry.stop("session_a");
    expect(handle.terminateScope).toHaveBeenCalledTimes(1);
    expect(handle.cleanup).toHaveBeenCalledTimes(1);
    expect(
      records.slice(-2).map(({ evidence }) => [evidence.eventKind, evidence.state]),
    ).toStrictEqual([
      ["stop", "stopped"],
      ["teardown", "stopped"],
    ]);
    expect(registry.session("session_a")).toBeUndefined();
  });

  it("emits revoked and failure terminal semantics for revoke and crash", async () => {
    const revoked = setup();
    await activate(revoked.registry);
    await revoked.registry.revoke("session_a");
    expect(revoked.records.slice(-2).map(({ evidence }) => evidence)).toMatchObject([
      { eventKind: "session-revoked", state: "revoked", reason: "activationRevoked" },
      { eventKind: "teardown", state: "revoked", reason: "activationRevoked" },
    ]);

    const failed = setup();
    await activate(failed.registry);
    await failed.registry.teardown("session_a", "debuggeeExit");
    expect(failed.records.slice(-2).map(({ evidence }) => evidence)).toMatchObject([
      { eventKind: "failure", state: "failed", reason: "debuggeeExit" },
      { eventKind: "teardown", state: "failed", reason: "debuggeeExit" },
    ]);
  });

  it("continues cleanup after termination throws and retains capacity until retry succeeds", async () => {
    let failTermination = true;
    const handle = capsule(() =>
      failTermination
        ? Promise.reject(new Error("private"))
        : Promise.resolve({
            terminated: true,
            termAttempted: true as const,
            killAttempted: true,
            descendantsRemaining: 0,
          }),
    );
    const { registry } = setup();
    await activate(registry, handle);
    const stopping = registry.stop("session_a");
    await vi.waitFor(() => {
      expect(registry.health()).toBe("terminationPending");
      expect(handle.cleanup).not.toHaveBeenCalled();
    });
    await expect(registry.reserve(identity("session_b", "partition_b"))).rejects.toMatchObject({
      code: "TERMINATION_PENDING",
    });
    failTermination = false;
    await registry.reconcile();
    await stopping;
    expect(handle.terminateScope).toHaveBeenCalledTimes(2);
    expect(handle.cleanup).toHaveBeenCalledTimes(1);
  });

  it("retries cleanup without repeating confirmed whole-scope termination", async () => {
    let failCleanup = true;
    const handle = capsule(undefined, () =>
      failCleanup ? Promise.reject(new Error("private")) : Promise.resolve(),
    );
    const { registry } = setup();
    await activate(registry, handle);
    const stopping = registry.stop("session_a");
    await vi.waitFor(() => {
      expect(registry.health()).toBe("terminationPending");
      expect(handle.cleanup).toHaveBeenCalledTimes(1);
    });
    failCleanup = false;
    await registry.reconcile();
    await stopping;
    expect(handle.terminateScope).toHaveBeenCalledTimes(1);
    expect(handle.cleanup).toHaveBeenCalledTimes(2);
  });

  it("retains capacity while private endpoint cleanup is pending", async () => {
    let failClose = true;
    const { registry } = setup();
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    const handle = capsule();
    await registry.attachCapsule("session_a", attempt.attemptId, handle, {
      backend: "oci",
      runtimeIdentityDigest: "b".repeat(64),
    });
    const close = vi.fn(() =>
      failClose ? Promise.reject(new Error("private")) : Promise.resolve(),
    );
    const destroy = vi.fn();
    await registry.attachEndpoint("session_a", attempt.attemptId, { close, destroy });
    registry.attachProtocol("session_a", attempt.attemptId, protocol());
    await registry.markRunning("session_a", attempt.attemptId);
    const stopping = registry.stop("session_a");
    await vi.waitFor(() => {
      expect(registry.session("session_a")).toMatchObject({
        state: "terminationPending",
        health: "terminationPending",
      });
      expect(destroy).toHaveBeenCalledTimes(1);
    });
    failClose = false;
    await registry.reconcile();
    await stopping;
    expect(close).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(handle.terminateScope).toHaveBeenCalledTimes(1);
  });

  it("blocks stale work synchronously and emits one marker when output reaches the terminal cap", async () => {
    const { records, registry } = setup();
    await activate(registry);
    const output = registry.acceptOutput("session_a", Buffer.alloc(1024 * 1024, 65));
    expect(() => registry.protocol("session_a")).toThrow(
      expect.objectContaining({ code: "SESSION_TERMINATING" }),
    );
    const accepted = await output;
    expect(accepted.limitReached).toBe(true);
    expect(accepted.accepted.toString("utf8")).toMatch(/\[truncated\]$/);
    expect(records.filter(({ evidence }) => evidence.reason === "outputOverflow")).toHaveLength(2);
  });

  it("records wall timeout terminal reason and leaves no capsule or pending request", async () => {
    let now = 0;
    const { records, registry } = setup(() => now);
    const handle = await activate(registry);
    now = 30 * 60 * 1_000 + 1;
    const sessionId = registry.expiredSessions()[0]?.sessionId;
    expect(sessionId).toBe("session_a");
    await registry.teardown("session_a", "wallTimeout");
    expect(handle.terminateScope).toHaveBeenCalledTimes(1);
    expect(records.at(-2)?.evidence).toMatchObject({ state: "failed", reason: "wallTimeout" });
    expect(registry.session("session_a")).toBeUndefined();
  });

  it("retains evidencePending capacity until both terminal records reconcile", async () => {
    let failTerminal = true;
    const { append, registry } = setup();
    append.mockImplementation((partition: string, evidence: DebugLifecycleEvidence) => {
      if (failTerminal && evidence.eventKind === "teardown")
        return Promise.reject(new Error("private"));
      return Promise.resolve();
    });
    await activate(registry);
    const stopping = registry.stop("session_a");
    let rejected: unknown;
    const guardedStopping = stopping.catch((error: unknown) => {
      rejected = error;
    });
    await vi.waitFor(() => {
      expect(registry.health()).toBe("evidencePending");
    });
    expect(rejected).toBeUndefined();
    failTerminal = false;
    await registry.reconcile();
    await guardedStopping;
    expect(rejected).toBeUndefined();
    expect(registry.health()).toBe("ready");
  });

  it("enforces duplicate session, plan replay, workspace, and server capacity independently", async () => {
    const duplicateSession = setup().registry;
    await duplicateSession.reserve(identity());
    await expect(duplicateSession.reserve(identity())).rejects.toMatchObject({ code: "CAPACITY" });

    const workspace = setup().registry;
    await workspace.reserve(identity());
    await expect(workspace.reserve(identity("session_b", "partition_a"))).rejects.toMatchObject({
      code: "CAPACITY",
    });

    const server = setup().registry;
    await server.reserve(identity("session_a", "partition_a"));
    await server.reserve({ ...identity("session_b", "partition_b"), planId: "plan_b" });
    await expect(
      server.reserve({ ...identity("session_c", "partition_c"), planId: "plan_c" }),
    ).rejects.toMatchObject({ code: "CAPACITY" });

    const replay = setup().registry;
    await replay.reserve(identity());
    await replay.stop("session_a");
    await expect(replay.reserve(identity("session_b", "partition_b"))).rejects.toMatchObject({
      code: "CAPACITY",
    });
  });

  it.each([
    { planId: "", planEpoch: 1, planExpiresAtMs: 10_000 },
    { planId: "plan_a", planEpoch: -1, planExpiresAtMs: 10_000 },
    { planId: "plan_a", planEpoch: 0.5, planExpiresAtMs: 10_000 },
    { planId: "plan_a", planEpoch: Number.POSITIVE_INFINITY, planExpiresAtMs: 10_000 },
    { planId: "plan_a", planEpoch: 1, planExpiresAtMs: 1 },
    { planId: "plan_a", planEpoch: 1, planExpiresAtMs: 1.5 },
    { planId: "plan_a", planEpoch: 1, planExpiresAtMs: Number.NaN },
  ])("rejects hostile replay promotion %# and rolls provisional capacity back", async (hostile) => {
    const { registry } = setup(() => 1);
    registry.reserveProvisional(provisional());
    await expect(
      registry.promoteReservation("session_a", {
        ...hostile,
        provisioningDigest: "a".repeat(64),
        backend: "oci",
        runtimeIdentityDigest: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CAPSULE_PLAN" });
    registry.rollbackProvisional("session_a");
    expect(registry.sessionIds()).toStrictEqual([]);
  });

  it("accepts epoch zero and rejects provisional startup, double promotion, and promoted rollback", async () => {
    const { registry } = setup(() => 1);
    registry.reserveProvisional(provisional());
    expect(() => registry.beginStartupAttempt("session_a")).toThrow(
      expect.objectContaining({ code: "INVALID_CAPSULE_PLAN" }),
    );
    const promotion = {
      planId: "plan_a",
      planEpoch: 0,
      planExpiresAtMs: 10_000,
      provisioningDigest: "a".repeat(64),
      backend: "oci" as const,
      runtimeIdentityDigest: "b".repeat(64),
    };
    await registry.promoteReservation("session_a", promotion);
    await expect(registry.promoteReservation("session_a", promotion)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
    registry.rollbackProvisional("session_a");
    expect(registry.session("session_a")).toMatchObject({ state: "starting" });
    await registry.stop("session_a");
  });

  it("bounds replay retention, denies live replay, and expires entries by revision and epoch", async () => {
    let now = 1;
    const { registry } = setup(() => now);
    for (let index = 0; index < DEBUG_MAX_REPLAY_ENTRIES; index += 1) {
      await registry.reserve({
        ...identity(`session_${String(index)}`, `partition_${String(index)}`),
        planId: `plan_${String(index)}`,
        planEpoch: 4,
        planExpiresAtMs: 1_000,
      });
      await registry.stop(`session_${String(index)}`);
    }
    await expect(
      registry.reserve({
        ...identity("session_overflow", "partition_overflow"),
        planId: "plan_overflow",
        planEpoch: 4,
        planExpiresAtMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "CAPACITY" });
    now = 1_000;
    await expect(
      registry.reserve({
        ...identity("session_reused", "partition_reused"),
        planId: "plan_0",
        planEpoch: 4,
        planExpiresAtMs: 2_000,
      }),
    ).resolves.toMatchObject({ state: "starting" });
    await registry.stop("session_reused");
    await expect(
      registry.reserve({
        ...identity("session_new_revision", "partition_new_revision"),
        activationRevision: 8,
        planId: "plan_0",
        planEpoch: 4,
        planExpiresAtMs: 2_000,
      }),
    ).resolves.toMatchObject({ state: "starting" });
    await registry.stop("session_new_revision");
  });

  it("owns startup attempt identity, counters, stale capsules, and current exits", async () => {
    const { records, registry } = setup();
    await registry.reserve(identity());
    const first = await registry.beginStartupAttempt("session_a");
    expect(first.attemptId).toBe(1);
    expect(first.signal.aborted).toBe(false);
    expect(() => registry.beginStartupAttempt("session_a")).toThrow(
      expect.objectContaining({ code: "CAPACITY" }),
    );
    const wrongPlan = capsule(undefined, undefined, "plan_b");
    await expect(
      registry.attachCapsule("session_a", first.attemptId, wrongPlan, {
        backend: "oci",
        runtimeIdentityDigest: "b".repeat(64),
      }),
    ).resolves.toBe(false);
    expect(registry.session("session_a")).toBeUndefined();
    expect(records.some(({ evidence }) => evidence.reason === "startupFailed")).toBe(true);
  });

  it("rejects stale attachment and closes a late endpoint exactly once", async () => {
    const { registry } = setup();
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    const stopping = registry.stop("session_a");
    const close = vi.fn(() => Promise.resolve());
    const destroy = vi.fn();
    await expect(
      registry.attachEndpoint("session_a", attempt.attemptId, { close, destroy }),
    ).rejects.toMatchObject({ code: "SESSION_TERMINATING" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    await expect(registry.completeLaunchFailure("session_a", attempt.attemptId)).resolves.toBe(
      false,
    );
    await stopping;
    await expect(registry.completeLaunchFailure("session_a", attempt.attemptId)).resolves.toBe(
      false,
    );
  });

  it("binds pause references, activity, protocol health, and pending counts", async () => {
    let now = 10;
    const { registry } = setup(() => now);
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    const handle = capsule();
    await expect(
      registry.attachCapsule("session_a", attempt.attemptId, handle, {
        backend: "oci",
        runtimeIdentityDigest: "b".repeat(64),
      }),
    ).resolves.toBe(true);
    const currentProtocol = protocol();
    vi.spyOn(currentProtocol, "pendingCount").mockReturnValue(3);
    registry.attachProtocol("session_a", attempt.attemptId, currentProtocol);
    await registry.markRunning("session_a", attempt.attemptId);
    const generation = registry.pause("session_a", 101, true);
    expect(generation).toBe(1);
    expect(registry.isCurrentPause("session_a", generation)).toBe(true);
    expect(registry.isCurrentPause("session_a", generation + 1)).toBe(false);
    expect(registry.isCurrentPause("missing", generation)).toBe(false);
    registry.resume("session_a");
    expect(registry.isCurrentPause("session_a", generation)).toBe(false);
    expect(registry.isCurrentPause("session_a", generation + 1)).toBe(false);
    now = 20;
    registry.touch("session_a");
    expect(registry.session("session_a")).toMatchObject({
      state: "running",
      pauseGeneration: 2,
      lastActivityAtMs: 20,
      pendingRequestCount: 3,
      startupAttemptCount: 1,
    });
    expect(registry.protocol("session_a")).toBe(currentProtocol);
    await registry.stop("session_a");
  });

  it("projects exact paused thread and all-thread flags only while a pause is current", async () => {
    const { registry } = setup();
    await activate(registry);

    expect(registry.pauseContext("missing")).toBeUndefined();
    expect(registry.pauseContext("session_a")).toBeUndefined();
    const firstGeneration = registry.pause("session_a", 101, true);
    expect(registry.pauseContext("session_a")).toStrictEqual({
      pauseGeneration: firstGeneration,
      threadId: 101,
      allThreadsStopped: true,
    });
    registry.resume("session_a");
    expect(registry.pauseContext("session_a")).toBeUndefined();
    const secondGeneration = registry.pause("session_a", undefined, false);
    expect(registry.pauseContext("session_a")).toStrictEqual({
      pauseGeneration: secondGeneration,
      threadId: undefined,
      allThreadsStopped: false,
    });

    await registry.stop("session_a");
  });

  it("applies exact output-event, UTF-8, and aggregate boundaries", async () => {
    const events: unknown[] = [];
    const registry = createDebugSessionRegistry({
      appendEvidence: () => Promise.resolve(),
      now: () => 1,
      emitOutputLimit: (event) => {
        events.push(event);
      },
    });
    await activate(registry);
    const exact = await registry.acceptOutput("session_a", Buffer.alloc(16 * 1024, 65));
    expect(exact).toStrictEqual({
      accepted: Buffer.alloc(16 * 1024, 65),
      omittedBytes: 0,
      limitReached: false,
    });
    const multibyte = await registry.acceptOutput("session_a", Buffer.from("€".repeat(6_000)));
    expect(multibyte.accepted).toHaveLength(16_382);
    expect(multibyte.accepted.toString("utf8")).toMatch(/\[truncated\]$/u);
    expect(multibyte.omittedBytes).toBe(1_629);
    expect(multibyte.limitReached).toBe(false);
    expect(registry.session("session_a")).toMatchObject({
      outputAcceptedBytes: 34_384,
      outputTruncatedEvents: 1,
    });
    const remaining = 1024 * 1024 - (16 * 1024 + 18_000);
    const terminal = await registry.acceptOutput("session_a", Buffer.alloc(remaining, 66));
    expect(terminal.limitReached).toBe(true);
    expect(events).toStrictEqual([
      { kind: "output-limit", sessionId: "session_a", acceptedBytes: 1024 * 1024 },
    ]);
  });

  it("expires strictly after idle and wall boundaries, never while terminating", async () => {
    let now = 0;
    const { registry } = setup(() => now);
    await registry.reserve(identity());
    now = 15 * 60 * 1_000;
    expect(registry.expiredSessions()).toStrictEqual([]);
    now += 1;
    expect(registry.expiredSessions()).toStrictEqual([
      { sessionId: "session_a", reason: "inactivityTimeout" },
    ]);
    registry.touch("session_a");
    now = 30 * 60 * 1_000;
    expect(registry.expiredSessions()).toStrictEqual([]);
    now += 1;
    expect(registry.expiredSessions()).toStrictEqual([
      { sessionId: "session_a", reason: "wallTimeout" },
    ]);
    const stopping = registry.stop("session_a");
    expect(registry.expiredSessions()).toStrictEqual([]);
    await stopping;
  });

  it("rolls back a failed start journal without exposing a session", async () => {
    const registry = createDebugSessionRegistry({
      appendEvidence: () => Promise.reject(new Error("private")),
      now: () => 99,
      emitOutputLimit: ignoreOutputLimit,
    });
    await expect(registry.reserve(identity())).rejects.toThrow("private");
    expect(registry.sessionIds()).toStrictEqual([]);
    expect(registry.health()).toBe("ready");
  });

  it("exposes exact typed errors and enumerable codes for missing and terminating work", async () => {
    const { records, registry } = setup();
    expect(registry.session("missing")).toBeUndefined();
    expect(registry.isCurrentPause("missing", 0)).toBe(false);
    for (const operation of [
      (): void => {
        registry.protocol("missing");
      },
      (): void => {
        registry.pause("missing", 101, true);
      },
      (): void => {
        registry.touch("missing");
      },
    ]) {
      try {
        operation();
        throw new Error("expected rejection");
      } catch (error: unknown) {
        expect(error).toMatchObject({ name: "DebugRegistryError", code: "SESSION_NOT_FOUND" });
        expect(Object.keys(error as object)).toContain("code");
      }
    }
    await registry.reserve(identity());
    expect(() => registry.protocol("session_a")).toThrow(
      expect.objectContaining({ code: "SESSION_NOT_FOUND" }),
    );
    const attempt = await registry.beginStartupAttempt("session_a");
    const stopping = registry.stop("session_a");
    expect(attempt.signal.aborted).toBe(true);
    expect(() => registry.beginStartupAttempt("session_a")).toThrow(
      expect.objectContaining({ code: "SESSION_TERMINATING" }),
    );
    expect(() => {
      registry.markInitializing("session_a", attempt.attemptId);
    }).toThrow(expect.objectContaining({ code: "SESSION_TERMINATING" }));
    expect(() => {
      registry.attachProtocol("session_a", attempt.attemptId, protocol());
    }).toThrow(expect.objectContaining({ code: "SESSION_TERMINATING" }));
    await expect(registry.markRunning("session_a", attempt.attemptId)).rejects.toMatchObject({
      code: "SESSION_TERMINATING",
    });
    expect(records.filter(({ evidence }) => evidence.eventKind === "active")).toStrictEqual([]);
    await registry.completeLaunchFailure("session_a", attempt.attemptId);
    await stopping;
  });

  it("tracks initializing, current attempt, active evidence, stale exit, and current crash", async () => {
    const { records, registry } = setup();
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    expect(registry.isAttemptCurrent("session_a", attempt.attemptId)).toBe(false);
    const handle = capsule();
    await registry.attachCapsule("session_a", attempt.attemptId, handle, {
      backend: "oci",
      runtimeIdentityDigest: "b".repeat(64),
    });
    expect(registry.isAttemptCurrent("session_a", attempt.attemptId)).toBe(true);
    expect(registry.isAttemptCurrent("session_a", attempt.attemptId + 1)).toBe(false);
    expect(registry.isAttemptCurrent("missing", attempt.attemptId)).toBe(false);
    registry.markInitializing("session_a", attempt.attemptId);
    expect(registry.session("session_a")?.state).toBe("starting");
    expect(() => {
      registry.attachProtocol("session_a", attempt.attemptId + 1, protocol());
    }).toThrow(expect.objectContaining({ code: "SESSION_TERMINATING" }));
    registry.attachProtocol("session_a", attempt.attemptId, protocol());
    await registry.markRunning("session_a", attempt.attemptId);
    expect(registry.session("session_a")?.state).toBe("running");
    expect(records.at(-1)?.evidence).toMatchObject({
      eventKind: "active",
      state: "running",
      reason: "requested",
    });
    await registry.capsuleExited("session_a", attempt.attemptId + 1);
    expect(registry.session("session_a")?.state).toBe("running");
    await registry.capsuleExited("session_a", attempt.attemptId);
    expect(registry.session("session_a")).toBeUndefined();
    expect(records.at(-2)?.evidence.reason).toBe("debuggeeExit");
  });

  it("keeps startup ownership until active evidence is durably accepted", async () => {
    let acceptActive: (() => void) | undefined;
    const { append, registry } = setup();
    append.mockImplementation((partition: string, evidence: DebugLifecycleEvidence) => {
      if (evidence.eventKind !== "active") return Promise.resolve();
      expect(partition).toBe("partition_a");
      return new Promise<void>((resolve) => {
        acceptActive = resolve;
      });
    });
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    await registry.attachCapsule("session_a", attempt.attemptId, capsule(), {
      backend: "oci",
      runtimeIdentityDigest: "b".repeat(64),
    });

    const marking = registry.markRunning("session_a", attempt.attemptId);
    await vi.waitFor(() => {
      expect(acceptActive).toBeTypeOf("function");
    });
    expect(registry.session("session_a")?.state).toBe("starting");
    expect(() => registry.beginStartupAttempt("session_a")).toThrow(
      expect.objectContaining({ code: "CAPACITY" }),
    );

    acceptActive?.();
    await marking;
    expect(registry.session("session_a")?.state).toBe("running");
    await registry.stop("session_a");
  });

  it("preserves an immediate adapter pause while activation evidence is pending", async () => {
    let acceptActive: (() => void) | undefined;
    const { append, registry } = setup();
    append.mockImplementation((_partition, evidence) =>
      evidence.eventKind === "active"
        ? new Promise<void>((resolve) => {
            acceptActive = resolve;
          })
        : Promise.resolve(),
    );
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    await registry.attachCapsule("session_a", attempt.attemptId, capsule(), {
      backend: "oci",
      runtimeIdentityDigest: "b".repeat(64),
    });

    const marking = registry.markRunning("session_a", attempt.attemptId);
    await vi.waitFor(() => {
      expect(acceptActive).toBeTypeOf("function");
    });
    const generation = registry.pause("session_a", 7, true);
    acceptActive?.();
    await marking;

    expect(registry.session("session_a")).toMatchObject({ state: "paused" });
    expect(registry.isCurrentPause("session_a", generation)).toBe(true);
    await registry.stop("session_a");
  });

  it("owns and terminates a capsule attached after its session was released", async () => {
    const { registry } = setup();
    await registry.reserve(identity());
    await registry.stop("session_a");
    const late = capsule();
    await expect(
      registry.attachCapsule("session_a", 1, late, {
        backend: "oci",
        runtimeIdentityDigest: "b".repeat(64),
      }),
    ).resolves.toBe(false);
    expect(late.terminateScope).toHaveBeenCalledTimes(1);
    expect(late.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    { backend: "linuxNamespace" as const, runtimeIdentityDigest: "b".repeat(64) },
    { backend: "oci" as const, runtimeIdentityDigest: "c".repeat(64) },
  ])("rejects a capsule whose independently qualified identity drifts", async (qualification) => {
    const { records, registry } = setup();
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    const handle = capsule();
    await expect(
      registry.attachCapsule("session_a", attempt.attemptId, handle, qualification),
    ).resolves.toBe(false);
    expect(handle.cleanup).toHaveBeenCalledTimes(1);
    expect(records.at(-2)?.evidence.reason).toBe("startupFailed");
  });

  it("cleans manager resources once and retains capacity after a cleanup failure", async () => {
    let fail = true;
    const cleanup = vi.fn(() => {
      if (fail) throw new Error("private");
    });
    const { registry } = setup();
    await registry.reserve(identity());
    registry.attachResource("session_a", { cleanup });
    const stopping = registry.stop("session_a");
    await vi.waitFor(() => {
      expect(registry.health()).toBe("terminationPending");
      expect(cleanup).toHaveBeenCalledTimes(1);
    });
    fail = false;
    await registry.reconcile();
    await stopping;
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("reports evidence-pending projection health and rejects new capacity with its exact code", async () => {
    let fail = true;
    const registry = createDebugSessionRegistry({
      appendEvidence: (_partition, evidence) =>
        fail && evidence.eventKind === "stop"
          ? Promise.reject(new Error("private"))
          : Promise.resolve(),
      now: () => 1,
      emitOutputLimit: ignoreOutputLimit,
    });
    await registry.reserve(identity());
    const stopping = registry.stop("session_a");
    await vi.waitFor(() => {
      expect(registry.session("session_a")?.health).toBe("evidencePending");
    });
    await expect(
      registry.reserve({ ...identity("session_b", "partition_b"), planId: "plan_b" }),
    ).rejects.toMatchObject({ code: "EVIDENCE_PENDING" });
    fail = false;
    await registry.reconcile();
    await stopping;
  });

  it("distinguishes workspace capacity from replay and preserves the first partition", async () => {
    const { registry } = setup();
    await registry.reserve(identity());
    await expect(
      registry.reserve({ ...identity("session_b", "partition_a"), planId: "plan_b" }),
    ).rejects.toMatchObject({ code: "CAPACITY" });
    expect(registry.sessionIds()).toStrictEqual(["session_a"]);
  });

  it("projects the reserved state while durable start evidence is pending", async () => {
    let release: (() => void) | undefined;
    const registry = createDebugSessionRegistry({
      appendEvidence: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      now: () => 41,
      emitOutputLimit: ignoreOutputLimit,
    });
    const reserving = registry.reserve(identity());
    expect(registry.session("session_a")).toStrictEqual({
      sessionId: "session_a",
      targetKind: "file",
      state: "reserved",
      terminalReason: undefined,
      activationRevision: 7,
      pauseGeneration: 0,
      startedAtMs: 41,
      lastActivityAtMs: 41,
      outputAcceptedBytes: 0,
      outputTruncatedEvents: 0,
      pendingRequestCount: 0,
      startupAttemptCount: 0,
      health: "ready",
      supportsSetVariable: false,
    });
    release?.();
    await expect(reserving).resolves.toMatchObject({ state: "starting" });
  });

  it("returns the same teardown promise, invalidates pause generation once, and disposes once", async () => {
    const { registry } = setup();
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    const handle = capsule();
    await registry.attachCapsule("session_a", attempt.attemptId, handle, {
      backend: "oci",
      runtimeIdentityDigest: "b".repeat(64),
    });
    const currentProtocol = protocol();
    registry.attachProtocol("session_a", attempt.attemptId, currentProtocol);
    await registry.markRunning("session_a", attempt.attemptId);
    registry.pause("session_a", 101, true);
    const first = registry.teardown("session_a", "stopped");
    const second = registry.teardown("session_a", "serverShutdown");
    expect(first).toBe(second);
    await first;
    expect(currentProtocol.dispose).toHaveBeenCalledTimes(1);
    expect(handle.terminateScope).toHaveBeenCalledTimes(1);
  });

  it("does not project terminal evidence again from a queued reconciliation", async () => {
    const { records, registry } = setup();
    await activate(registry);

    const stopping = registry.stop("session_a");
    const reconciling = registry.reconcile();
    await Promise.all([stopping, reconciling]);

    expect(records.map(({ evidence }) => evidence.eventKind)).toStrictEqual([
      "start",
      "active",
      "stop",
      "teardown",
    ]);
  });

  it("continues whole-scope termination when protocol disposal throws", async () => {
    const { records, registry } = setup();
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    const handle = capsule();
    await registry.attachCapsule("session_a", attempt.attemptId, handle, {
      backend: "oci",
      runtimeIdentityDigest: "b".repeat(64),
    });
    registry.attachProtocol("session_a", attempt.attemptId, {
      ...protocol(),
      dispose: () => {
        throw new Error("private");
      },
    });
    await registry.markRunning("session_a", attempt.attemptId);
    await registry.stop("session_a");
    expect(handle.terminateScope).toHaveBeenCalledTimes(1);
    expect(records.at(-1)?.evidence.eventKind).toBe("teardown");
  });

  it("reconciles a still-owned pending termination exactly once at the retry deadline", async () => {
    vi.useFakeTimers();
    try {
      let failTermination = true;
      const handle = capsule(() =>
        failTermination
          ? Promise.reject(new Error("private"))
          : Promise.resolve({ terminated: true, descendantsRemaining: 0 }),
      );
      const { registry } = setup();
      await activate(registry, handle);

      const stopping = registry.stop("session_a");
      await flushMicrotasks();
      expect(registry.health()).toBe("terminationPending");
      expect(handle.terminateScope).toHaveBeenCalledTimes(1);

      failTermination = false;
      await vi.advanceTimersByTimeAsync(249);
      expect(handle.terminateScope).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;

      expect(handle.terminateScope).toHaveBeenCalledTimes(2);
      expect(registry.session("session_a")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules one retry and never reconciles a replacement session", async () => {
    vi.useFakeTimers();
    try {
      let firstFails = true;
      const firstHandle = capsule(() =>
        firstFails
          ? Promise.reject(new Error("private"))
          : Promise.resolve({ terminated: true, descendantsRemaining: 0 }),
      );
      const { registry } = setup();
      await activate(registry, firstHandle);

      const stopping = registry.stop("session_a");
      await flushMicrotasks();
      await registry.reconcile();
      expect(firstHandle.terminateScope).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(250);
      expect(firstHandle.terminateScope).toHaveBeenCalledTimes(3);

      firstFails = false;
      await registry.reconcile();
      await stopping;
      expect(registry.session("session_a")).toBeUndefined();

      const replacement = {
        ...identity(),
        activationRevision: 8,
        planId: "plan_b",
        provisioningDigest: "c".repeat(64),
      };
      const replacementHandle = capsule(undefined, undefined, "plan_b");
      await registry.reserve(replacement);
      const replacementAttempt = await registry.beginStartupAttempt("session_a");
      await registry.attachCapsule("session_a", replacementAttempt.attemptId, replacementHandle, {
        backend: "oci",
        runtimeIdentityDigest: "b".repeat(64),
      });
      registry.attachProtocol("session_a", replacementAttempt.attemptId, protocol());
      await registry.markRunning("session_a", replacementAttempt.attemptId);
      await vi.advanceTimersByTimeAsync(250);
      expect(replacementHandle.terminateScope).not.toHaveBeenCalled();
      expect(registry.session("session_a")?.state).toBe("running");

      await registry.stop("session_a");
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-destroys a hanging endpoint and completes teardown when close then settles", async () => {
    vi.useFakeTimers();
    try {
      let resolveClose: (() => void) | undefined;
      const close = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveClose = resolve;
          }),
      );
      const destroy = vi.fn((): void => {
        resolveClose?.();
      });
      const { registry } = setup();
      await registry.reserve(identity());
      const attempt = await registry.beginStartupAttempt("session_a");
      const handle = capsule();
      await registry.attachCapsule("session_a", attempt.attemptId, handle, {
        backend: "oci",
        runtimeIdentityDigest: "b".repeat(64),
      });
      await registry.attachEndpoint("session_a", attempt.attemptId, { close, destroy });
      registry.attachProtocol("session_a", attempt.attemptId, protocol());
      await registry.markRunning("session_a", attempt.attemptId);

      const stopping = registry.stop("session_a");
      await vi.advanceTimersByTimeAsync(250);
      await stopping;

      expect(close).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(handle.terminateScope).toHaveBeenCalledTimes(1);
      expect(registry.session("session_a")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails endpoint closure closed on rejection and preserves the fixed timeout diagnostic", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(globalThis, "Error");
    try {
      let rejectClose = true;
      const close = vi.fn(() =>
        rejectClose ? Promise.reject(new Error("private")) : Promise.resolve(),
      );
      const destroy = vi.fn();
      const { registry } = setup();
      await registry.reserve(identity());
      const attempt = await registry.beginStartupAttempt("session_a");
      await registry.attachEndpoint("session_a", attempt.attemptId, { close, destroy });

      const stopping = registry.stop("session_a");
      await vi.advanceTimersByTimeAsync(500);
      expect(destroy).toHaveBeenCalledTimes(3);
      expect(error).toHaveBeenCalledWith("DEBUG_ENDPOINT_CLOSE_TIMEOUT");
      expect(registry.session("session_a")?.state).toBe("terminationPending");

      rejectClose = false;
      await registry.completeLaunchFailure("session_a", attempt.attemptId);
      await stopping;
      expect(close).toHaveBeenCalledTimes(4);
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not emit the output-limit event before the exact aggregate boundary", async () => {
    const emit = vi.fn();
    const registry = createDebugSessionRegistry({
      appendEvidence: () => Promise.resolve(),
      now: () => 1,
      emitOutputLimit: emit,
    });
    await activate(registry);
    const below = await registry.acceptOutput("session_a", Buffer.alloc(1024 * 1024 - 1, 65));
    expect(below.limitReached).toBe(false);
    expect(emit).not.toHaveBeenCalled();
    const boundary = await registry.acceptOutput("session_a", Buffer.from("x"));
    expect(boundary.limitReached).toBe(true);
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      kind: "output-limit",
      sessionId: "session_a",
      acceptedBytes: 1024 * 1024,
    });
  });

  it.each(["throw", "reject"] as const)(
    "enters canonical output teardown before a notification sink can %s",
    async (failure) => {
      const records: DebugLifecycleEvidence[] = [];
      let stateSeenBySink: string | undefined;
      const emitOutputLimit = (): Promise<void> | void => {
        stateSeenBySink = registry.session("session_a")?.state;
        if (failure === "throw") throw new Error("private");
        return Promise.reject(new Error("private"));
      };
      const registry = createDebugSessionRegistry({
        appendEvidence: (_partition, evidence) => {
          records.push(evidence);
          return Promise.resolve();
        },
        now: () => 1,
        emitOutputLimit,
      });
      const current = await activate(registry);
      const acceptance = await registry.acceptOutput("session_a", Buffer.alloc(1024 * 1024, 65));
      expect(acceptance.limitReached).toBe(true);
      expect(stateSeenBySink).toBe("stopping");
      expect(current.terminateScope).toHaveBeenCalledTimes(1);
      expect(current.cleanup).toHaveBeenCalledTimes(1);
      expect(records.slice(-2)).toMatchObject([
        { reason: "outputOverflow", eventKind: "failure" },
        { reason: "outputOverflow", eventKind: "teardown" },
      ]);
      expect(registry.sessionIds()).toStrictEqual([]);
      await expect(
        registry.reserve({ ...identity("session_b", "partition_b"), planId: "plan_b" }),
      ).resolves.toMatchObject({ state: "starting" });
      await registry.stop("session_b");
    },
  );

  it("canonically releases a fully cleaned failed startup for exactly one retry", async () => {
    const { registry } = setup();
    await registry.reserve(identity());
    const first = await registry.beginStartupAttempt("session_a");
    const handle = capsule();
    await registry.attachCapsule("session_a", first.attemptId, handle, {
      backend: "oci",
      runtimeIdentityDigest: "b".repeat(64),
    });
    await expect(registry.completeLaunchFailure("session_a", first.attemptId)).resolves.toBe(true);
    expect(handle.terminateScope).toHaveBeenCalledTimes(1);
    expect(handle.cleanup).toHaveBeenCalledTimes(1);
    expect(registry.session("session_a")?.state).toBe("starting");
    const stale = capsule();
    await expect(
      registry.attachCapsule("session_a", first.attemptId, stale, {
        backend: "oci",
        runtimeIdentityDigest: "b".repeat(64),
      }),
    ).resolves.toBe(false);
    expect(stale.terminateScope).toHaveBeenCalledTimes(1);
    const second = await registry.beginStartupAttempt("session_a");
    expect(second.attemptId).toBe(2);
    const stopping = registry.stop("session_a");
    await registry.completeLaunchFailure("session_a", second.attemptId);
    await stopping;
  });

  it("fails a startup closed when whole-scope termination cannot be confirmed", async () => {
    const uncontained = capsule(() =>
      Promise.resolve({ terminated: false, descendantsRemaining: 1 }),
    );
    const { records, registry } = setup();
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    await registry.attachCapsule("session_a", attempt.attemptId, uncontained, {
      backend: "oci",
      runtimeIdentityDigest: "b".repeat(64),
    });
    await expect(registry.completeLaunchFailure("session_a", attempt.attemptId)).resolves.toBe(
      false,
    );
    await vi.waitFor(() => {
      expect(registry.session("session_a")).toMatchObject({
        state: "terminationPending",
        terminalReason: "startupFailed",
        health: "terminationPending",
      });
    });
    expect(records.some(({ evidence }) => evidence.reason === "startupFailed")).toBe(false);
  });

  it("counts truncation only when bytes are actually omitted", async () => {
    const { registry } = setup();
    await activate(registry);
    await registry.acceptOutput("session_a", Buffer.alloc(16 * 1024, 65));
    expect(registry.session("session_a")?.outputTruncatedEvents).toBe(0);
    await registry.stop("session_a");
  });

  it.each([
    [Buffer.from("¢".repeat(9_000)), 16_383],
    [Buffer.from("€".repeat(6_000)), 16_382],
    [Buffer.concat([Buffer.alloc(2, 65), Buffer.from("😀".repeat(5_000))]), 16_381],
  ] as const)("backs up to a complete UTF-8 boundary", async (bytes, expectedLength) => {
    const { registry } = setup();
    await activate(registry);
    const accepted = await registry.acceptOutput("session_a", bytes);
    expect(accepted.accepted).toHaveLength(expectedLength);
    expect(accepted.accepted.toString("utf8")).not.toContain(String.fromCharCode(0xfffd));
    expect(accepted.accepted.toString("utf8")).toMatch(/\[truncated\]$/u);
    await registry.stop("session_a");
  });

  it("uses only the fixed marker when no candidate prefix is valid UTF-8", async () => {
    const { registry } = setup();
    await activate(registry);
    const accepted = await registry.acceptOutput("session_a", Buffer.alloc(20_000, 0xff));
    expect(accepted.accepted.toString("utf8")).toBe("[truncated]");
    await registry.stop("session_a");
  });

  it("rejects missing lifecycle and endpoint attempts without retaining resources", async () => {
    const { registry } = setup();
    await registry.capsuleExited("missing", 1);
    await registry.reserve(identity());
    expect(() => {
      registry.markInitializing("session_a", 1);
    }).toThrow(expect.objectContaining({ code: "SESSION_TERMINATING" }));
    const close = vi.fn(() => Promise.resolve());
    await expect(
      registry.attachEndpoint("session_a", 1, { close, destroy: vi.fn() }),
    ).rejects.toMatchObject({ code: "SESSION_TERMINATING" });
    expect(close).toHaveBeenCalledTimes(1);
    await registry.stop("session_a");
  });

  it("projects stopping synchronously and invalidates pause generation exactly once", async () => {
    let finishClose: (() => void) | undefined;
    const { registry } = setup();
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    await registry.attachCapsule("session_a", attempt.attemptId, capsule(), {
      backend: "oci",
      runtimeIdentityDigest: "b".repeat(64),
    });
    await registry.attachEndpoint("session_a", attempt.attemptId, {
      close: () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
      destroy: vi.fn(),
    });
    registry.attachProtocol("session_a", attempt.attemptId, protocol());
    await registry.markRunning("session_a", attempt.attemptId);
    expect(registry.pause("session_a", 101, true)).toBe(1);
    const stopping = registry.stop("session_a");
    expect(registry.session("session_a")).toMatchObject({
      state: "stopping",
      terminalReason: "stopped",
      pauseGeneration: 2,
    });
    expect(registry.teardown("session_a", "serverShutdown")).toBe(stopping);
    expect(registry.session("session_a")?.pauseGeneration).toBe(2);
    await vi.waitFor(() => {
      expect(finishClose).toBeTypeOf("function");
    });
    finishClose?.();
    await stopping;
  });

  it("resolves a missing teardown as an idempotent no-op", async () => {
    const { registry } = setup();
    await expect(registry.stop("missing")).resolves.toBeUndefined();
    await expect(registry.teardown("missing", "serverShutdown")).resolves.toBeUndefined();
  });

  it("does not duplicate terminal evidence while retrying the durable suffix", async () => {
    let failTeardown = true;
    const records: { partition: string; evidence: DebugLifecycleEvidence }[] = [];
    const appendOnly = createDebugSessionRegistry({
      now: () => 1,
      appendEvidence: (partition, evidence) => {
        records.push({ partition, evidence });
        return failTeardown && evidence.eventKind === "teardown"
          ? Promise.reject(new Error("private"))
          : Promise.resolve();
      },
      emitOutputLimit: ignoreOutputLimit,
    });
    await appendOnly.reserve(identity());
    const stopping = appendOnly.stop("session_a");
    await vi.waitFor(() => {
      expect(appendOnly.health()).toBe("evidencePending");
    });
    failTeardown = false;
    await appendOnly.reconcile();
    await stopping;
    expect(records.map(({ evidence }) => evidence.eventKind)).toStrictEqual([
      "start",
      "stop",
      "teardown",
      "teardown",
    ]);
  });

  it("does not repeat a successfully cleaned resource while another cleanup retries", async () => {
    let failSecond = true;
    const first = vi.fn();
    const second = vi.fn(() => {
      if (failSecond) throw new Error("private");
    });
    const { registry } = setup();
    await registry.reserve(identity());
    registry.attachResource("session_a", { cleanup: first });
    registry.attachResource("session_a", { cleanup: second });
    const stopping = registry.stop("session_a");
    await vi.waitFor(() => {
      expect(second).toHaveBeenCalledTimes(1);
      expect(registry.session("session_a")?.state).toBe("terminationPending");
    });
    failSecond = false;
    await registry.reconcile();
    await stopping;
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("uses elapsed time from a nonzero start instant", async () => {
    let now = 100;
    const { registry } = setup(() => now);
    await registry.reserve(identity());
    now = 15 * 60 * 1_000 + 100;
    registry.touch("session_a");
    now = 30 * 60 * 1_000 + 100;
    expect(registry.expiredSessions()).toStrictEqual([]);
    now += 1;
    expect(registry.expiredSessions()).toStrictEqual([
      { sessionId: "session_a", reason: "wallTimeout" },
    ]);
    await registry.stop("session_a");
  });

  it("clears the endpoint deadline after an orderly close", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const { registry } = setup();
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    await registry.attachEndpoint("session_a", attempt.attemptId, {
      close: () => Promise.resolve(),
      destroy: vi.fn(),
    });
    const stopping = registry.stop("session_a");
    await registry.completeLaunchFailure("session_a", attempt.attemptId);
    await stopping;
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it("owns a capsule that arrives after termination inspection but before endpoint close", async () => {
    let finishClose: (() => void) | undefined;
    const { registry } = setup();
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    await registry.attachEndpoint("session_a", attempt.attemptId, {
      close: () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
      destroy: vi.fn(),
    });
    const stopping = registry.stop("session_a");
    await vi.waitFor(() => {
      expect(finishClose).toBeTypeOf("function");
    });
    const late = capsule();
    const attached = registry.attachCapsule("session_a", attempt.attemptId, late, {
      backend: "oci",
      runtimeIdentityDigest: "b".repeat(64),
    });
    finishClose?.();
    await expect(attached).resolves.toBe(false);
    await stopping;
    expect(late.terminateScope).toHaveBeenCalledTimes(1);
    expect(late.cleanup).toHaveBeenCalledTimes(1);
  });

  it("freshly loads every fixed lifecycle limit and the UTF-8 truncation marker", async () => {
    vi.resetModules();
    const loaded = await import("./debugSessionRegistry.js");
    expect({
      server: loaded.DEBUG_MAX_SESSIONS_PER_SERVER,
      workspace: loaded.DEBUG_MAX_SESSIONS_PER_WORKSPACE,
      wall: loaded.DEBUG_WALL_TIMEOUT_MS,
      idle: loaded.DEBUG_IDLE_TIMEOUT_MS,
      event: loaded.DEBUG_MAX_OUTPUT_EVENT_BYTES,
      aggregate: loaded.DEBUG_MAX_SESSION_OUTPUT_BYTES,
      replay: loaded.DEBUG_MAX_REPLAY_ENTRIES,
    }).toStrictEqual({
      server: 2,
      workspace: 1,
      wall: 1_800_000,
      idle: 900_000,
      event: 16_384,
      aggregate: 1_048_576,
      replay: 256,
    });
    const registry = loaded.createDebugSessionRegistry({
      appendEvidence: () => Promise.resolve(),
      now: () => 1,
      emitOutputLimit: ignoreOutputLimit,
    });
    await activate(registry);
    const output = await registry.acceptOutput("session_a", Buffer.alloc(16_385, 65));
    expect(output.accepted.subarray(-11).toString("utf8")).toBe("[truncated]");
    await registry.stop("session_a");
  });

  it("releases an unpromoted reservation only through explicit rollback", () => {
    const { registry } = setup();
    registry.reserveProvisional(provisional());
    expect(registry.sessionIds()).toStrictEqual(["session_a"]);
    registry.rollbackProvisional("session_a");
    expect(registry.sessionIds()).toStrictEqual([]);
    expect(() => {
      registry.rollbackProvisional("missing");
    }).not.toThrow();
  });

  it("accepts output only for the current capsule attempt", async () => {
    const { registry } = setup();
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    await registry.attachCapsule("session_a", attempt.attemptId, capsule(), {
      backend: "oci",
      runtimeIdentityDigest: "b".repeat(64),
    });
    await expect(
      registry.acceptOutputForAttempt("session_a", attempt.attemptId + 1, Buffer.from("stale")),
    ).resolves.toBeUndefined();
    await expect(
      registry.acceptOutputForAttempt("session_a", attempt.attemptId, Buffer.from("current")),
    ).resolves.toMatchObject({
      accepted: Buffer.from("current"),
      omittedBytes: 0,
      limitReached: false,
    });
    expect(registry.session("session_a")?.outputAcceptedBytes).toBe(7);
    await registry.stop("session_a");
  });

  it("fails an attempt closed when its promoted plan expires at the exact boundary", async () => {
    let now = 1;
    const { records, registry } = setup(() => now);
    await registry.reserve({ ...identity(), planExpiresAtMs: 10 });
    now = 10;
    await expect(registry.beginStartupAttempt("session_a")).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
    expect(registry.session("session_a")).toBeUndefined();
    expect(records.slice(-2).map(({ evidence }) => evidence)).toMatchObject([
      { eventKind: "failure", state: "failed", reason: "startupFailed" },
      { eventKind: "teardown", state: "failed", reason: "startupFailed" },
    ]);
  });

  it("fails the third startup closed with canonical restart-throttled evidence", async () => {
    const { records, registry } = setup(() => 1);
    await registry.reserve(identity());
    const first = await registry.beginStartupAttempt("session_a");
    await expect(registry.completeLaunchFailure("session_a", first.attemptId)).resolves.toBe(true);
    const second = await registry.beginStartupAttempt("session_a");
    await expect(registry.completeLaunchFailure("session_a", second.attemptId)).resolves.toBe(true);
    await expect(registry.beginStartupAttempt("session_a")).rejects.toMatchObject({
      code: "STARTUP_THROTTLED",
    });
    expect(registry.session("session_a")).toBeUndefined();
    expect(records.slice(-2).map(({ evidence }) => evidence)).toMatchObject([
      { eventKind: "failure", state: "restartThrottled", reason: "restartThrottled" },
      { eventKind: "teardown", state: "restartThrottled", reason: "restartThrottled" },
    ]);
  });

  it("refuses a fresh startup attempt once the debuggee has already launched (ADR-0136 D5)", async () => {
    const { records, registry } = setup(() => 1);
    // A single prior attempt is well under the two-per-minute throttle count, so this proves the
    // rejection comes from the "already launched" guard and not from attempt counting.
    await activate(registry);
    await expect(registry.beginStartupAttempt("session_a")).rejects.toMatchObject({
      code: "STARTUP_THROTTLED",
    });
    expect(registry.session("session_a")).toBeUndefined();
    expect(records.slice(-2).map(({ evidence }) => evidence)).toMatchObject([
      { eventKind: "failure", state: "restartThrottled", reason: "restartThrottled" },
      { eventKind: "teardown", state: "restartThrottled", reason: "restartThrottled" },
    ]);
  });

  it("retains termination ownership until every pending launch reports completion", async () => {
    const { registry } = setup();
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    const stopping = registry.stop("session_a");
    await vi.waitFor(() => {
      expect(registry.session("session_a")).toMatchObject({
        state: "terminationPending",
        health: "terminationPending",
      });
    });
    await expect(registry.reserve(identity("session_b", "partition_b"))).rejects.toMatchObject({
      code: "TERMINATION_PENDING",
    });
    await expect(registry.completeLaunchFailure("session_a", attempt.attemptId)).resolves.toBe(
      false,
    );
    await stopping;
  });

  it("closes an endpoint delivered after its session disappeared", async () => {
    const { registry } = setup();
    const close = vi.fn(() => Promise.resolve());
    const destroy = vi.fn();
    await expect(registry.attachEndpoint("missing", 1, { close, destroy })).rejects.toMatchObject({
      code: "SESSION_TERMINATING",
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("forces a hanging endpoint closed at the fixed deadline and then reconciles", async () => {
    vi.useFakeTimers();
    try {
      let closeOrderly = false;
      const { registry } = setup();
      await registry.reserve(identity());
      const attempt = await registry.beginStartupAttempt("session_a");
      const close = vi.fn(() =>
        closeOrderly ? Promise.resolve() : new Promise<void>(() => undefined),
      );
      const destroy = vi.fn();
      await registry.attachEndpoint("session_a", attempt.attemptId, { close, destroy });
      const stopping = registry.stop("session_a");
      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasks();
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(registry.session("session_a")).toMatchObject({ state: "terminationPending" });
      closeOrderly = true;
      await registry.completeLaunchFailure("session_a", attempt.attemptId);
      await stopping;
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tears down when durable active evidence is rejected", async () => {
    const events: DebugLifecycleEvidence[] = [];
    const registry = createDebugSessionRegistry({
      appendEvidence: (_partition, evidence) => {
        events.push(evidence);
        return evidence.eventKind === "active"
          ? Promise.reject(new Error("private"))
          : Promise.resolve();
      },
      now: () => 1,
      emitOutputLimit: ignoreOutputLimit,
    });
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    const handle = capsule();
    await registry.attachCapsule("session_a", attempt.attemptId, handle, {
      backend: "oci",
      runtimeIdentityDigest: "b".repeat(64),
    });
    await expect(registry.markRunning("session_a", attempt.attemptId)).rejects.toThrow("private");
    await vi.waitFor(() => {
      expect(registry.session("session_a")).toBeUndefined();
    });
    expect(handle.cleanup).toHaveBeenCalledTimes(1);
    expect(events.slice(-2)).toMatchObject([
      { eventKind: "failure", reason: "startupFailed" },
      { eventKind: "teardown", reason: "startupFailed" },
    ]);
  });

  it("cannot become running when teardown starts during the active evidence append", async () => {
    let acceptActive: (() => void) | undefined;
    const { append, registry } = setup();
    append.mockImplementation((_partition, evidence) =>
      evidence.eventKind === "active"
        ? new Promise<void>((resolve) => {
            acceptActive = resolve;
          })
        : Promise.resolve(),
    );
    await registry.reserve(identity());
    const attempt = await registry.beginStartupAttempt("session_a");
    await registry.attachCapsule("session_a", attempt.attemptId, capsule(), {
      backend: "oci",
      runtimeIdentityDigest: "b".repeat(64),
    });
    const marking = registry.markRunning("session_a", attempt.attemptId);
    await vi.waitFor(() => {
      expect(acceptActive).toBeTypeOf("function");
    });
    const stopping = registry.stop("session_a");
    acceptActive?.();
    await expect(marking).rejects.toMatchObject({ code: "SESSION_TERMINATING" });
    await stopping;
  });

  it.each(["oci", "linuxNamespace", "windowsContainer"] as const)(
    "binds the exact %s backend and provisioning digest into all lifecycle evidence",
    async (backend) => {
      const { records, registry } = setup();
      await registry.reserve({ ...identity(), backend });
      await registry.stop("session_a");
      expect(records).toHaveLength(3);
      for (const { evidence } of records) {
        expect(evidence).toMatchObject({
          schemaVersion: "1",
          backend,
          provisioningDigest: "a".repeat(64),
        });
      }
    },
  );

  it.each([
    { provisioningDigest: "A".repeat(64) },
    { provisioningDigest: "a".repeat(63) },
    { runtimeIdentityDigest: "B".repeat(64) },
    { runtimeIdentityDigest: "z".repeat(64) },
    { backend: "" as DebugReservationPromotion["backend"] },
  ])("rejects malformed promotion attestation %# before durable evidence", async (hostile) => {
    const { records, registry } = setup();
    registry.reserveProvisional(provisional());
    await expect(
      registry.promoteReservation("session_a", promotion(hostile)),
    ).rejects.toMatchObject({ code: "INVALID_CAPSULE_PLAN" });
    expect(records).toStrictEqual([]);
    expect(registry.sessionIds()).toStrictEqual([]);
  });
});
