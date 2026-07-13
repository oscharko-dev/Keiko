import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { CodingWorkbenchRuntimeIntent } from "@oscharko-dev/keiko-contracts";

import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import { createCodingRuntimeEditorMutationLeaseCoordinator } from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import type { CodingRuntimeLaunchRequest, CodingRuntimeManager } from "./codingRuntimeManager.js";
import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import type { OpenCodeRuntimeComposition } from "./opencodeRuntimeComposition.js";
import {
  createProductionCodingRuntimeHost,
  type ProductionCodingRuntimeHost,
  type QualifiedProductionCodingRuntime,
} from "./productionCodingRuntimeHost.js";
import {
  createProductionRuntimeManager,
  createProductionRuntimeTaskDispatcher,
  type ProductionRuntimeRunRecord,
} from "./productionOpenCodeRuntimePorts.js";
import {
  CodingRuntimeAuthorityService,
  type CodingRuntimeMintResult,
  type CodingRuntimeTrustedContext,
} from "./runtimeAuthorityService.js";
import { createInMemoryRuntimeCapabilityStore } from "./runtimeCapabilityStore.js";
import {
  CLOSED_RUNTIME_LAUNCH_PROFILE,
  createRuntimeProcessSupervisor,
  type RuntimeReapReceipt,
} from "./runtimeProcessSupervisor.js";
import { createInMemorySupervisedCodingApprovalStore } from "./supervisedCodingApprovalStore.js";

const NOW = "2026-07-13T12:00:00.000Z";
const ROOT = "/managed/project/task-2258";
const DIGEST = "a".repeat(64);

describe("production OpenCode runtime ports", () => {
  it("disposes a reconciled recovery run before an exact fresh retry", async () => {
    const capabilities = createInMemoryRuntimeCapabilityStore({ nowMs: () => Date.parse(NOW) });
    const authority = new CodingRuntimeAuthorityService(
      new EditorAgentAuthorityRegistry(),
      () => "unused-run-id",
      undefined,
      createInMemorySupervisedCodingApprovalStore(),
      capabilities,
    );
    const runs = new Map<string, ProductionRuntimeRunRecord>();
    const oldMint = mint(authority, "run-2258", "request-2258");
    if (!oldMint.ok) throw new Error("expected old authority mint");
    const old = await recoveryRecord(authority, "run-2258", oldMint.treeBindingId);
    runs.set("run-2258", old.record);
    const manager = createProductionRuntimeManager(runs, authority);
    const dispatcher = createProductionRuntimeTaskDispatcher(runs);
    const host = productionHost(runs, manager, dispatcher);

    await expect(manager.start(launch("run-2258", oldMint.treeBindingId))).resolves.toMatchObject({
      ok: true,
    });
    await expect(manager.stop("run-2258")).resolves.toMatchObject({
      ok: false,
      failureCode: "runtime-reap-unproven",
    });
    expect(host.cancellationRegistry.signalFor("run-2258")).toBeDefined();
    expect(capabilities.authenticate(oldMint.toolFacadeCapability, Date.parse(NOW))).toMatchObject({
      ok: false,
      reason: "revoked",
    });

    await expect(manager.reconcile("run-2258")).resolves.toEqual({ ok: true, status: "stopped" });
    expect(old.adapter).toEqual({ disposed: true, sessionId: undefined });
    expect(old.record.controller.signal.aborted).toBe(true);
    expect(host.cancellationRegistry.signalFor("run-2258")).toBeUndefined();
    await expect(dispatcher.dispatch("run-2258", "stale task")).resolves.toEqual({ ok: false });

    const freshMint = mint(authority, "run-2259", "request-2259");
    if (!freshMint.ok) throw new Error("expected fresh authority mint");
    const fresh = await recoveryRecord(authority, "run-2259", freshMint.treeBindingId);
    runs.set("run-2259", fresh.record);
    await expect(manager.start(launch("run-2259", freshMint.treeBindingId))).resolves.toMatchObject(
      {
        ok: true,
        runId: "run-2259",
      },
    );
    await expect(manager.reconcile("run-2258")).resolves.toMatchObject({
      ok: false,
      failureCode: "runtime-run-mismatch",
    });
    expect(manager.health()).toEqual({ status: "ready", activeRunId: "run-2259" });
    expect(host.cancellationRegistry.signalFor("run-2259")).toBeDefined();
    expect(
      capabilities.authenticate(freshMint.toolFacadeCapability, Date.parse(NOW)),
    ).toMatchObject({
      ok: true,
      binding: { runId: "run-2259" },
    });
  });
});

function productionHost(
  runs: Map<string, ProductionRuntimeRunRecord>,
  manager: CodingRuntimeManager,
  dispatcher: ReturnType<typeof createProductionRuntimeTaskDispatcher>,
): ProductionCodingRuntimeHost {
  const runtime: QualifiedProductionCodingRuntime = {
    createManager: () => manager,
    mintLaunch: { resolve: () => launch("unused", "f".repeat(64)) },
    approvalAuthority: { issue: (request) => manager.issueApproval(request) },
    taskDispatcher: dispatcher,
    recovery: { reconcile: () => Promise.resolve({ status: "unreaped" }) },
    cancellationRegistry: { signalFor: (runId) => runs.get(runId)?.controller.signal },
  };
  const host = createProductionCodingRuntimeHost({
    resolve: () => runtime,
  });
  if (host === undefined) throw new Error("expected production host");
  return host;
}

function mint(
  authority: CodingRuntimeAuthorityService,
  runId: string,
  requestId: string,
): CodingRuntimeMintResult {
  const startIntent: Extract<CodingWorkbenchRuntimeIntent, { readonly command: "start" }> = {
    schemaVersion: "1",
    requestId,
    command: "start",
    taskIntent: "Recover production runtime",
    requestedMode: "supervised-coding",
    modelSource: "keiko-model-gateway",
  };
  const trusted = context();
  const confirmation = authority.confirmStart(startIntent, trusted.taskId, trusted.operatorId, NOW);
  return authority.mintStartForRun(runId, startIntent, trusted, confirmation, NOW);
}

async function recoveryRecord(
  authority: CodingRuntimeAuthorityService,
  runId: string,
  treeBindingId: string,
): Promise<{
  readonly record: ProductionRuntimeRunRecord;
  readonly adapter: { disposed: boolean; sessionId: string | undefined };
}> {
  const receipt = await reapReceipt(runId, treeBindingId);
  const adapter = { disposed: false, sessionId: `session-${runId}` as string | undefined };
  const invocationRegistry = createCodingToolInvocationRegistry();
  const leases = createCodingRuntimeEditorMutationLeaseCoordinator({
    invocationRegistry,
    cancelPendingByAuthorityRun: () => 0,
  });
  return {
    adapter,
    record: {
      context: context(),
      composition: fakeComposition(authority, runId, receipt, adapter),
      invocationRegistry,
      leases,
      controller: new AbortController(),
    },
  };
}

function fakeComposition(
  authority: CodingRuntimeAuthorityService,
  runId: string,
  receipt: RuntimeReapReceipt,
  adapter: { disposed: boolean; sessionId: string | undefined },
): OpenCodeRuntimeComposition {
  let status: "ready" | "recovery-required" | "stopped" = "stopped";
  const manager: CodingRuntimeManager = {
    start: () => {
      status = "ready";
      return { ok: true, runId, status: "ready" };
    },
    issueApproval: () => ({ ok: false, failureCode: "runtime-stopped", retryable: false }),
    stop: () => {
      authority.revokeBeforeTerminate(runId);
      authority.markRecoveryRequired(runId, NOW);
      status = "recovery-required";
      return Promise.resolve({
        ok: false,
        failureCode: "runtime-reap-unproven",
        retryable: false,
      });
    },
    takeover: () => manager.stop(runId),
    reconcile: () => {
      if (status !== "recovery-required") {
        return Promise.resolve({ ok: true, status: "stopped" });
      }
      adapter.disposed = true;
      adapter.sessionId = undefined;
      if (!authority.confirmReaped(runId, receipt, NOW)) {
        return Promise.resolve({
          ok: false,
          failureCode: "runtime-reap-unproven",
          retryable: false,
        });
      }
      status = "stopped";
      return Promise.resolve({ ok: true, status: "stopped" });
    },
    health: () =>
      status === "stopped"
        ? { status: "stopped" }
        : status === "ready"
          ? { status: "ready", activeRunId: runId }
          : {
              status: "recovery-required",
              activeRunId: runId,
              failureCode: "runtime-reap-unproven",
              restartDenied: true,
            },
  };
  return {
    manager,
    toolBridge: {
      url: "http://127.0.0.1:1",
      handle: () => Promise.resolve({ status: 503, body: "" }),
    },
    runPort: {
      submitTask: () => Promise.resolve(adapter.sessionId !== undefined),
      abortTask: () => Promise.resolve(adapter.sessionId !== undefined),
      waitForTerminal: () => Promise.resolve(false),
      listQuestions: () => Promise.resolve([]),
      answerQuestion: () => Promise.resolve(false),
      rejectQuestion: () => Promise.resolve(false),
    },
  };
}

async function reapReceipt(runId: string, treeBindingId: string): Promise<RuntimeReapReceipt> {
  const qualification = {
    platform: "win32" as const,
    arch: "x64" as const,
    backend: "windows-job-object" as const,
    releaseReceipt: `sha256:${"b".repeat(64)}`,
  };
  const supervisor = createRuntimeProcessSupervisor({
    qualifications: [qualification],
    backend: {
      identity: qualification,
      spawnOwnedTree: () => ({
        treeId: `tree-${runId}`,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        onTreeExit: (): void => undefined,
      }),
      signalTree: (): void => undefined,
      waitForCompleteTreeExit: () => Promise.resolve(true),
      reconcileTreeExit: () => Promise.resolve(true),
    },
  });
  const launched = supervisor.spawnOwnedTree({
    runId,
    recoveryHandle: "d".repeat(32),
    treeBindingId,
    executable: "/managed/runtime",
    args: [],
    cwd: ROOT,
    env: {},
    qualification,
    launchProfile: CLOSED_RUNTIME_LAUNCH_PROFILE,
  });
  if (!launched.ok) throw new Error("expected qualified test launch");
  const result = await supervisor.waitForCompleteTreeExit(launched.tree, 1);
  if (result.status !== "reaped") throw new Error("expected authentic reap receipt");
  return result.receipt;
}

function launch(runId: string, treeBindingId: string): CodingRuntimeLaunchRequest {
  return {
    runId,
    recoveryHandle: "d".repeat(32),
    treeBindingId,
    taskRef: "task-2258",
    adapterKind: "opencode-compatible",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    requestedMode: "supervised-coding",
    effectiveMode: "supervised-coding",
    workspaceRoot: ROOT,
    executablePath: "/managed/runtime",
    managedRoot: "/managed",
    gatewayUrl: "http://127.0.0.1:1",
    modelProfileId: "profile-1",
    args: [],
    inheritedEnvAllowlist: [],
    shutdownTimeoutMs: 1,
    startTimeoutMs: 1,
  };
}

function context(): CodingRuntimeTrustedContext {
  return {
    operatorId: "operator-1",
    taskId: "task-2258",
    projectId: "project-1",
    projectDigest: DIGEST,
    workspaceId: "workspace-1",
    workspaceRoot: ROOT,
    branchRef: "issue-2258",
    branchHeadDigest: DIGEST,
    branch: {
      baseRef: "dev",
      headRef: "issue-2258",
      allowDetachedHead: false,
      allowedPrefixes: ["issue-"],
    },
    deploymentCeiling: "autonomous-delivery",
    runtimeSource: "keiko-sidecar",
    actionClasses: ["workspace-read", "workspace-write", "command-execution", "verification"],
    connectorScopes: [],
    modelProfile: {
      profileId: "profile-1",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 60_000,
      requirePerCommandApproval: false,
    },
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval"],
    budget: {
      maxRuntimeMs: 60_000,
      maxToolCalls: 10,
      maxPromptTokens: 10_000,
      maxPatchBytes: 65_536,
    },
    expiresAt: "2026-07-13T13:00:00.000Z",
  };
}
