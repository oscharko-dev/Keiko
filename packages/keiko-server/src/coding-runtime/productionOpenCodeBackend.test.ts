import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodingToolResult } from "./codingToolIpc.js";
import { describe, expect, it } from "vitest";

import { createOpenCodeGatewayReadinessRegistry } from "../coding-sidecar-gateway.js";
import { createCodingToolApprovalBridge } from "./codingToolApprovalBridge.js";
import {
  discoverDevLaneOpenCode,
  type DevLanePortableOpenCodeRuntime,
} from "./devLanePortableCodingRuntime.js";
import { stageDevLaneFixture } from "./devLaneFixture/_support.js";
import { scriptedFunctionalPortable } from "./opencodeFunctionalHarness/_support.js";
import { createProductionOpenCodeBackend } from "./productionOpenCodeBackend.js";
import type { ProductionRuntimeBackendInput } from "./productionCodingRuntimeResolver.js";
import type { CodingRuntimeTrustedContext } from "./runtimeAuthorityService.js";

describe("production OpenCode backend composition", () => {
  it("constructs a resolver without launching the qualified runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-production-opencode-backend-"));
    try {
      const backend = createProductionOpenCodeBackend({
        portable: scriptedFunctionalPortable(root),
        runtimeStateRoot: root,
        gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
        runtimeEvidence: { observe: (): void => undefined },
        gatewayReadiness: createOpenCodeGatewayReadinessRegistry(),
      });

      expect(backend.createRun).toEqual(expect.any(Function));
      expect(backend.safeActivityProjection).toBeDefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("composes a Windows dev-lane run through the native Job Object supervisor", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-production-opencode-windows-backend-"));
    try {
      const portable = windowsDevLaneRuntime(root);
      const backend = createProductionOpenCodeBackend(backendInput(root, portable));

      const run = backend.createRun(runInput(root));

      expect(run.launch.confinement).toMatchObject({
        platform: "win32",
        arch: "x64",
        backend: "windows-job-object",
      });
      await run.dispose?.();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails closed when a Windows dev lane reaches composition without its supervisor", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-production-opencode-windows-missing-"));
    try {
      const portable = windowsDevLaneRuntime(root);
      const backend = createProductionOpenCodeBackend(
        backendInput(root, { ...portable, nativeHelperPath: undefined }),
      );

      expect(() => backend.createRun(runInput(root))).toThrow("dev-lane-supervisor-missing");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function windowsDevLaneRuntime(root: string): DevLanePortableOpenCodeRuntime {
  const staged = stageDevLaneFixture(root, "windows-x64");
  const discovery = discoverDevLaneOpenCode({
    env: staged.env,
    platform: "win32",
    arch: "x64",
  });
  if (discovery.outcome !== "activated") throw new Error("expected-windows-dev-lane-runtime");
  return discovery.runtime;
}

function backendInput(
  root: string,
  portable: DevLanePortableOpenCodeRuntime,
): Parameters<typeof createProductionOpenCodeBackend>[0] {
  return {
    portable,
    runtimeStateRoot: root,
    gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
    runtimeEvidence: { observe: (): void => undefined },
    gatewayReadiness: createOpenCodeGatewayReadinessRegistry(),
  };
}

function runInput(root: string): ProductionRuntimeBackendInput {
  return {
    request: launchRequest(root),
    context: trustedContext(root),
    minted: {
      ok: true,
      authorityRef: { runId: "run-windows", envelopeDigest: "a".repeat(64) },
      modelGatewayCapability: "model-capability",
      toolFacadeCapability: "tool-capability",
      effectiveMode: "supervised-coding",
      treeBindingId: "b".repeat(64),
    },
    toolFacade: {
      execute: (): Promise<CodingToolResult> => Promise.resolve({ status: "denied", evidence: [] }),
    },
    codingToolApprovals: createCodingToolApprovalBridge(),
    authorityLifecycle: {
      abortInFlightActions: (): boolean => true,
      markRuntimeRecoveryRequired: (): boolean => true,
      releaseRuntimeAfterReap: (): boolean => true,
      revokeRuntime: (): boolean => true,
    },
    onRuntimeEvent: (): void => undefined,
    workspaceIsCurrent: (): boolean => true,
    resolveWorkspaceRootAccess: (): undefined => undefined,
  };
}

function launchRequest(workspaceRoot: string): ProductionRuntimeBackendInput["request"] {
  return {
    runId: "run-windows",
    treeBindingId: "b".repeat(64),
    taskRef: "task-windows",
    adapterKind: "opencode-compatible",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    requestedMode: "supervised-coding",
    effectiveMode: "supervised-coding",
    workspaceRoot,
    executablePath: "unused-before-start",
    managedRoot: workspaceRoot,
    gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
    modelProfileId: "profile-windows",
    args: [],
    inheritedEnvAllowlist: [],
    shutdownTimeoutMs: 5_000,
    startTimeoutMs: 120_000,
  };
}

function trustedContext(workspaceRoot: string): CodingRuntimeTrustedContext {
  return {
    operatorId: "operator-windows",
    taskId: "task-windows",
    projectId: "project-windows",
    projectDigest: "c".repeat(64),
    workspaceId: "workspace-windows",
    workspaceRoot,
    branchRef: "codex/windows-runtime",
    branchHeadDigest: "d".repeat(64),
    branch: {
      baseRef: "dev",
      headRef: "codex/windows-runtime",
      allowDetachedHead: false,
      allowedPrefixes: ["codex/"],
    },
    deploymentCeiling: "supervised-coding",
    runtimeSource: "keiko-sidecar",
    actionClasses: ["workspace-read"],
    connectorScopes: [],
    modelProfile: {
      profileId: "profile-windows",
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
    expiresAt: "2026-09-03T00:00:00.000Z",
  };
}
