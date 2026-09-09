import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodingToolResult } from "./codingToolIpc.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as nativeBackend from "./nativeRuntimeProcessBackend.js";
import { createRuntimeGatewayConfinement } from "@oscharko-dev/keiko-sandbox";
import { codingRuntimeFactDigest } from "./runtimeAuthorityService.js";

afterEach(() => vi.restoreAllMocks());

import { createOpenCodeGatewayReadinessRegistry } from "../coding-sidecar-gateway.js";
import { createCodingToolApprovalBridge } from "./codingToolApprovalBridge.js";
import {
  discoverDevLaneOpenCode,
  type DevLanePortableOpenCodeRuntime,
} from "./devLanePortableCodingRuntime.js";
import { stageDevLaneFixture } from "./devLaneFixture/_support.js";
import { scriptedFunctionalPortable } from "./opencodeFunctionalHarness/_support.js";
import { createProductionOpenCodeBackend } from "./productionOpenCodeBackend.js";
import type {
  ProductionOpenCodeBackendInput,
  ResolvedPortableOpenCodeRuntime,
} from "./productionOpenCodeBackend.js";
import type { QualifiedPortableOpenCodeRuntime } from "./productionPortableCodingRuntime.js";
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
        // ADR-0043 D11-D14 (#3390): the SAME single attested loopback origin as `gatewayUrl` above.
        toolFacadeUrl: "http://127.0.0.1:1983/api/coding-sidecar/tool",
        runtimeEvidence: { observe: (): void => undefined },
        gatewayReadiness: createOpenCodeGatewayReadinessRegistry(),
      });

      expect(backend.createRun).toEqual(expect.any(Function));
      expect(backend.safeActivityProjection).toBeDefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails closed when the selected model has no admitted gateway geometry", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-production-opencode-metadata-"));
    try {
      const input = backendInput(root, windowsDevLaneRuntime(root));
      const backend = createProductionOpenCodeBackend({
        ...input,
        resolveGatewayRunMetadata: () => undefined,
      });

      expect(() => backend.createRun(runInput(root))).toThrow("runtime-unqualified");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("resolves gateway geometry for the exact model bound to the run", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-production-opencode-model-"));
    try {
      const input = backendInput(root, windowsDevLaneRuntime(root));
      const resolveGatewayRunMetadata = vi.fn((modelId: string) =>
        input.resolveGatewayRunMetadata?.(modelId),
      );
      createProductionOpenCodeBackend({ ...input, resolveGatewayRunMetadata }).createRun(
        runInput(root),
      );

      expect(resolveGatewayRunMetadata).toHaveBeenCalledExactlyOnceWith("profile-windows");
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

  // Process-tree qualification does not prove gateway-only network enforcement. Composition
  // can prepare the run, but the native backend must receive the policy and refuse an unsafe start.
  it("composes a release-qualified Windows native run", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-production-opencode-native-release-"));
    try {
      const portable = releaseQualifiedNativeRuntime(root);
      const backend = createProductionOpenCodeBackend(backendInput(root, portable));

      const run = backend.createRun(runInput(root));

      expect(run.launch.confinement).toMatchObject({
        platform: "win32",
        arch: "x64",
        backend: "windows-job-object",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
  it.each(["dev", "release"] as const)(
    "binds gateway confinement into the %s native supervisor",
    (lane) => {
      const root = mkdtempSync(join(tmpdir(), "keiko-native-gateway-policy-"));
      try {
        const portable =
          lane === "dev" ? windowsDevLaneRuntime(root) : releaseQualifiedNativeRuntime(root);
        const input = backendInput(root, portable);
        const request = runInput(root);
        const factory = vi.spyOn(nativeBackend, "createNativeRuntimeProcessBackend");
        createProductionOpenCodeBackend(input).createRun(request);
        expect(factory).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            gatewayConfinement: createRuntimeGatewayConfinement({
              gatewayUrl: input.gatewayUrl,
              runId: request.minted.authorityRef.runId,
              treeBindingId: request.minted.treeBindingId,
              envelopeDigest: request.minted.authorityRef.envelopeDigest,
              runtimeArtifactDigest: portable.sidecar.shippedExecutableSha256,
              modelProfileDigest: codingRuntimeFactDigest(request.context.modelProfile),
            }),
          }),
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );
});

function releaseQualifiedNativeRuntime(root: string): QualifiedPortableOpenCodeRuntime {
  const installRoot = join(root, "install");
  const payloadRootPath = "runtime/sidecars/opencode-compatible";
  mkdirSync(join(installRoot, payloadRootPath), { recursive: true });
  const helperPath = join(root, "keiko-runtime-supervisor.exe");
  writeFileSync(helperPath, "helper");
  const digest = "a".repeat(64);
  return {
    installRoot,
    target: "windows-x64",
    platformAssurance: "release-qualified",
    manifest: {},
    sidecar: {
      summary: {
        name: "opencode-compatible",
        kind: "coding-runtime",
        upstreamName: "opencode",
        upstreamVersion: "1.17.17",
        adapterName: "keiko-coding-sidecar",
        adapterVersion: "1",
        protocolVersion: "coding-sidecar-v1",
        platformTarget: "windows-x64",
        payloadSha256: digest,
        payloadSha256Prefix: digest.slice(0, 12),
        sizeBytes: 1,
        status: "verified",
      },
      payloadRootPath,
      executablePath: `${payloadRootPath}/opencode.exe`,
      shippedExecutableSha256: digest,
      executableTreeSha256: digest,
      licenseEvidencePath: "LICENSE.txt",
      licenseEvidenceSha256: digest,
      sbomEvidencePath: "sbom.cdx.json",
      sbomEvidenceSha256: digest,
      protocolSchemaRawSha256: digest,
      protocolHandshakeDigest: digest,
      protocolHandshakeAlgorithm: "keiko-opencode-protocol-surface-v1",
      availability: {
        redistributionApproved: true,
        payloadPresent: true,
        archiveDigestVerified: true,
        executableTreeDigestVerified: true,
        runtimeVersionVerified: true,
        protocolSchemaVerified: true,
        signatureVerified: true,
        qualificationVerified: true,
      },
    },
    qualification: {
      platform: "win32",
      arch: "x64",
      backend: "windows-job-object",
      releaseReceipt: `sha256:${digest}`,
    },
    nativeHelperPath: helperPath,
  };
}

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
  portable: ResolvedPortableOpenCodeRuntime,
): ProductionOpenCodeBackendInput {
  return {
    portable,
    runtimeStateRoot: root,
    gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
    resolveGatewayRunMetadata: () => ({
      maxPromptTokens: 128_000,
      maxOutputTokens: 4_096,
      maxInputMessages: 512,
      maxRequestBytes: 1_048_576,
    }),
    // ADR-0043 D11-D14 (#3390): the SAME single attested loopback origin as `gatewayUrl` above.
    toolFacadeUrl: "http://127.0.0.1:1983/api/coding-sidecar/tool",
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
    requestId: "request-windows",
    taskIntent: "compose the Windows runtime",
    requestedMode: "supervised-coding",
    runtimePreference: "managed-gateway",
    workspaceId: "workspace-windows",
    workspaceRoot,
    serverPrincipal: "operator-windows",
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
