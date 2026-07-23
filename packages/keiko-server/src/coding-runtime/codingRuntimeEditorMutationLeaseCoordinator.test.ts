import { describe, expect, it, vi } from "vitest";

import {
  EDITOR_AGENT_SCHEMA_VERSION,
  type EditorAgentAction,
  type EditorAgentSessionSnapshot,
} from "@oscharko-dev/keiko-contracts";

import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import {
  createCodingRuntimeEditorMutationLeaseBroker,
  createCodingRuntimeEditorMutationLeaseCoordinator,
} from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import { createEditorAgentRegistry } from "../editor/agentSessionRegistry.js";

const RUN_ID = "runtime-run";
const OTHER_RUN_ID = "other-run";
const ENVELOPE_DIGEST = "a".repeat(64);
const ROOT_DIGEST = "b".repeat(64);
const CAPABILITY_DIGEST = "c".repeat(64);

function snapshot(sessionId = "session-1"): EditorAgentSessionSnapshot {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId,
    windowId: "window-1",
    workspaceRoot: "/managed/workspace",
    activePaneId: "pane-1",
    panes: [{ paneId: "pane-1", activeFile: "src/a.ts", openFiles: ["src/a.ts"] }],
    dirtyFiles: [],
    activeFile: "src/a.ts",
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    documentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: ENVELOPE_DIGEST },
    activeFileContentHash: ENVELOPE_DIGEST,
    textMode: "none",
    updatedAt: 1,
  };
}

function action(runId = RUN_ID, sessionId = "session-1"): EditorAgentAction {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: "edit-1",
    idempotencyKey: "edit-key-1",
    sessionId,
    type: "applyChangeset",
    authorityRef: { runId, envelopeDigest: ENVELOPE_DIGEST },
    changeset: {
      patch: "SENTINEL_RUNTIME_CHANGESET",
      files: [{ file: "src/a.ts", expectedContentHash: ENVELOPE_DIGEST }],
    },
  };
}

function registration(mutationGuard: () => boolean = (): boolean => true): {
  readonly authorityRef: { readonly runId: string; readonly envelopeDigest: string };
  readonly workspaceId: string;
  readonly workspaceRootDigest: string;
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly requiresReview: boolean;
  readonly mutationGuard: () => boolean;
} {
  return {
    authorityRef: { runId: RUN_ID, envelopeDigest: ENVELOPE_DIGEST },
    workspaceId: "workspace-1",
    workspaceRootDigest: ROOT_DIGEST,
    actionId: "edit-1",
    idempotencyKey: "edit-key-1",
    requiresReview: true,
    mutationGuard,
  };
}

function request(overrides: Partial<ReturnType<typeof registration>> = {}): {
  readonly authorityRef: { readonly runId: string; readonly envelopeDigest: string };
  readonly workspaceRootDigest: string;
  readonly actionId: string;
  readonly idempotencyKey: string;
} {
  return {
    authorityRef: { runId: RUN_ID, envelopeDigest: ENVELOPE_DIGEST },
    workspaceRootDigest: ROOT_DIGEST,
    actionId: "edit-1",
    idempotencyKey: "edit-key-1",
    ...overrides,
  };
}

describe("coding-runtime editor mutation lease coordinator (Issue #2332)", () => {
  it("registers a content-free lease with review policy and waits for its one-use claim", async () => {
    const invocationRegistry = createCodingToolInvocationRegistry();
    const cancelPendingByAuthorityRun = vi.fn((): number => 0);
    const mutationGuard = vi.fn((): boolean => true);
    const coordinator = createCodingRuntimeEditorMutationLeaseCoordinator({
      invocationRegistry,
      cancelPendingByAuthorityRun,
    });
    const contentFreeRegistration = {
      ...registration(mutationGuard),
      get changeset(): never {
        throw new Error("the lease coordinator must never retain an edit payload");
      },
    };

    expect(coordinator.register(contentFreeRegistration)).toBe(true);
    expect(coordinator.register({ ...registration(), workspaceId: "other-workspace" })).toBe(false);
    expect(coordinator.lease.matches(request())).toBe(true);
    expect(coordinator.lease.requiresReview(request())).toBe(true);
    expect(coordinator.lease.matches(request({ actionId: "other-action" }))).toBe(false);
    expect(coordinator.lease.matches(request({ idempotencyKey: "other-key" }))).toBe(false);
    expect(
      coordinator.lease.matches(
        request({ authorityRef: { runId: OTHER_RUN_ID, envelopeDigest: ENVELOPE_DIGEST } }),
      ),
    ).toBe(false);
    expect(
      coordinator.lease.matches(
        request({ authorityRef: { runId: RUN_ID, envelopeDigest: ROOT_DIGEST } }),
      ),
    ).toBe(false);
    expect(coordinator.lease.matches(request({ workspaceRootDigest: ENVELOPE_DIGEST }))).toBe(
      false,
    );

    const idle = coordinator.waitForIdle(new AbortController().signal);
    expect(coordinator.lease.claim(request())).toBe(true);
    expect(coordinator.lease.matches(request())).toBe(true);
    expect(coordinator.lease.complete(request(), true)).toBe(true);
    await expect(idle).resolves.toBe(true);
    expect(mutationGuard).toHaveBeenCalledTimes(1);
    expect(coordinator.lease.claim(request())).toBe(false);
    expect(mutationGuard).toHaveBeenCalledTimes(1);
    expect(cancelPendingByAuthorityRun).not.toHaveBeenCalled();
  });

  it("releases terminal waiters on rejection and cancellation without claiming mutation", async () => {
    const coordinator = createCodingRuntimeEditorMutationLeaseCoordinator({
      invocationRegistry: createCodingToolInvocationRegistry(),
      cancelPendingByAuthorityRun: (): number => 0,
    });
    expect(coordinator.register(registration())).toBe(true);
    const rejected = coordinator.waitForIdle(new AbortController().signal);
    expect(coordinator.lease.discard(request())).toBe(true);
    await expect(rejected).resolves.toBe(false);

    expect(coordinator.register(registration())).toBe(true);
    const controller = new AbortController();
    const cancelled = coordinator.waitForIdle(controller.signal);
    controller.abort();
    await expect(cancelled).resolves.toBe(false);
    expect(coordinator.lease.matches(request())).toBe(true);
  });

  it("revokes a run atomically: it closes staging, aborts raw reads, cancels pending browser work, and rejects a late result", () => {
    const scheduled = new Set<number>();
    let nextTimer = 0;
    const editorRegistry = createEditorAgentRegistry({
      setTimer: (): number => {
        const timer = (nextTimer += 1);
        scheduled.add(timer);
        return timer;
      },
      clearTimer: (timer): void => {
        scheduled.delete(timer as number);
      },
    });
    editorRegistry.registerSnapshot(snapshot(), CAPABILITY_DIGEST);
    editorRegistry.registerSnapshot(snapshot("session-2"), CAPABILITY_DIGEST);
    editorRegistry.connect("session-1", () => undefined);
    editorRegistry.connect("session-2", () => undefined);
    const invocationRegistry = createCodingToolInvocationRegistry();
    const payload = Buffer.from("SENTINEL_RAW_READ_PAYLOAD", "utf8");
    expect(
      invocationRegistry.stage({
        runId: RUN_ID,
        actionId: "read-1",
        idempotencyKey: "read-key-1",
        digest: ENVELOPE_DIGEST,
        authorityExpiresAt: "2099-01-01T00:00:00.000Z",
        payload,
      }),
    ).toEqual({ kind: "staged" });
    const revokeStaging = vi.spyOn(invocationRegistry, "revokeRun");
    const cancelPendingByAuthorityRun = vi.spyOn(editorRegistry, "cancelPendingByAuthorityRun");
    const coordinator = createCodingRuntimeEditorMutationLeaseCoordinator({
      invocationRegistry,
      cancelPendingByAuthorityRun,
    });
    const runtimeAction = action();
    const otherRunAction = action(OTHER_RUN_ID, "session-2");
    editorRegistry.queueAction(runtimeAction, runtimeAction, { runtimeOwned: true });
    editorRegistry.queueAction(otherRunAction, otherRunAction);
    expect(coordinator.register(registration())).toBe(true);
    expect(scheduled.size).toBe(2);

    expect(coordinator.revokeRun(RUN_ID)).toBe(true);

    expect(cancelPendingByAuthorityRun).toHaveBeenCalledExactlyOnceWith(RUN_ID);
    expect(revokeStaging).toHaveBeenCalledExactlyOnceWith(RUN_ID);
    expect(editorRegistry.pendingCount("session-1")).toBe(0);
    expect(scheduled.size).toBe(1);
    expect(
      editorRegistry.takePendingAction("session-1", runtimeAction.actionId, CAPABILITY_DIGEST),
    ).toBeUndefined();
    expect(
      editorRegistry.takePendingAction("session-2", otherRunAction.actionId, CAPABILITY_DIGEST),
    ).toEqual(otherRunAction);
    expect(
      invocationRegistry.take({
        runId: RUN_ID,
        actionId: "read-1",
        idempotencyKey: "read-key-1",
      }),
    ).toEqual({ kind: "revoked" });
    expect(payload.equals(Buffer.alloc(payload.length))).toBe(true);
    expect(coordinator.lease.matches(request())).toBe(false);
    expect(coordinator.lease.requiresReview(request())).toBeUndefined();
    expect(coordinator.lease.claim(request())).toBe(false);
  });

  it("rejects old leases after restart or dispose, including a guard that throws", () => {
    const invocationRegistry = createCodingToolInvocationRegistry();
    const coordinator = createCodingRuntimeEditorMutationLeaseCoordinator({
      invocationRegistry,
      cancelPendingByAuthorityRun: (): number => 0,
    });
    expect(
      coordinator.register(
        registration((): never => {
          throw new Error("live facts changed");
        }),
      ),
    ).toBe(true);

    expect(coordinator.lease.claim(request())).toBe(false);
    expect(coordinator.register(registration())).toBe(true);
    const oldLease = coordinator.lease;
    coordinator.dispose();
    const restarted = createCodingRuntimeEditorMutationLeaseCoordinator({
      invocationRegistry: createCodingToolInvocationRegistry(),
      cancelPendingByAuthorityRun: (): number => 0,
    });
    const replacement = {
      ...registration(),
      authorityRef: { runId: "replacement-run", envelopeDigest: ENVELOPE_DIGEST },
    };

    expect(oldLease.matches(request())).toBe(false);
    expect(oldLease.claim(request())).toBe(false);
    expect(restarted.register(replacement)).toBe(true);
    expect(
      restarted.lease.claim(
        request({ authorityRef: { runId: "replacement-run", envelopeDigest: ENVELOPE_DIGEST } }),
      ),
    ).toBe(true);
  });
});

describe("coding-runtime editor mutation lease broker (Issue #2483)", () => {
  it("routes one exact active match and detaches it with the run lifecycle", () => {
    const claim = vi.fn((): boolean => true);
    const complete = vi.fn((): boolean => true);
    const discard = vi.fn((): boolean => true);
    const broker = createCodingRuntimeEditorMutationLeaseBroker();
    const detach = broker.attach({
      matches: () => true,
      requiresReview: () => false,
      claim,
      complete,
      discard,
    });
    if (detach === undefined) throw new Error("expected attached runtime lease");

    expect(broker.matches(request())).toBe(true);
    expect(broker.requiresReview(request())).toBe(false);
    expect(broker.claim(request())).toBe(true);
    expect(broker.complete(request(), true)).toBe(true);
    expect(broker.discard(request())).toBe(true);
    expect(claim).toHaveBeenCalledExactlyOnceWith(request());
    expect(complete).toHaveBeenCalledExactlyOnceWith(request(), true);
    expect(discard).toHaveBeenCalledExactlyOnceWith(request());

    detach();
    expect(broker.matches(request())).toBe(false);
    expect(broker.requiresReview(request())).toBeUndefined();
    expect(broker.claim(request())).toBe(false);
    expect(broker.complete(request(), true)).toBe(false);
    expect(broker.discard(request())).toBe(false);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("fails closed for ambiguous or throwing active lease ports", () => {
    const firstClaim = vi.fn((): boolean => true);
    const secondClaim = vi.fn((): boolean => true);
    const broker = createCodingRuntimeEditorMutationLeaseBroker();
    broker.attach({
      matches: () => true,
      requiresReview: () => true,
      claim: firstClaim,
      complete: firstClaim,
      discard: firstClaim,
    });
    broker.attach({
      matches: () => true,
      requiresReview: () => false,
      claim: secondClaim,
      complete: secondClaim,
      discard: secondClaim,
    });

    expect(broker.matches(request())).toBe(false);
    expect(broker.requiresReview(request())).toBeUndefined();
    expect(broker.claim(request())).toBe(false);
    expect(firstClaim).not.toHaveBeenCalled();
    expect(secondClaim).not.toHaveBeenCalled();

    const throwing = createCodingRuntimeEditorMutationLeaseBroker();
    throwing.attach({
      matches: (): never => {
        throw new Error("unavailable");
      },
      claim: (): never => {
        throw new Error("unavailable");
      },
      complete: (): never => {
        throw new Error("unavailable");
      },
      requiresReview: (): never => {
        throw new Error("unavailable");
      },
      discard: (): never => {
        throw new Error("unavailable");
      },
    });
    expect(throwing.matches(request())).toBe(false);
    expect(throwing.requiresReview(request())).toBeUndefined();
    expect(throwing.claim(request())).toBe(false);
  });

  it("invalidates every attached lease and rejects new attachments after disposal", () => {
    const broker = createCodingRuntimeEditorMutationLeaseBroker();
    const port = {
      matches: (): boolean => true,
      requiresReview: (): boolean => true,
      claim: (): boolean => true,
      complete: (): boolean => true,
      discard: (): boolean => true,
    };
    expect(broker.attach(port)).toBeTypeOf("function");

    broker.dispose();

    expect(broker.matches(request())).toBe(false);
    expect(broker.requiresReview(request())).toBeUndefined();
    expect(broker.claim(request())).toBe(false);
    expect(broker.complete(request(), true)).toBe(false);
    expect(broker.discard(request())).toBe(false);
    expect(broker.attach(port)).toBeUndefined();
  });
});
