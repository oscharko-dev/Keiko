import { Script } from "node:vm";
import { createHash, webcrypto } from "node:crypto";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import { openCodeCatalogAliasFor } from "../tool-catalog/catalogToolFacadeBridge.js";
import { createCodingToolFacade } from "./codingToolFacade.js";
import * as composition from "./opencodeRuntimeComposition.js";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";

import type { CodingToolAuthorityPort } from "./codingToolFacadePorts.js";
import type { CodingToolResult } from "./codingToolIpc.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gatewayBackend from "./devLaneRuntimeProcessBackend.js";
import * as nativeBackend from "./nativeRuntimeProcessBackend.js";
import {
  createRuntimeGatewayConfinement,
  type RuntimeGatewayFilesystem,
} from "@oscharko-dev/keiko-sandbox";
import { codingRuntimeFactDigest } from "./runtimeAuthorityService.js";

afterEach(() => vi.restoreAllMocks());

import { createOpenCodeGatewayReadinessRegistry } from "../coding-sidecar-gateway.js";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createCodingToolApprovalBridge } from "./codingToolApprovalBridge.js";
import { createCodingRuntimeContextUsageRegistry } from "./codingRuntimeContextUsage.js";
import {
  devLaneCheckoutRoot,
  discoverDevLaneOpenCode,
  type DevLanePortableOpenCodeRuntime,
} from "./devLanePortableCodingRuntime.js";
import { buildSandboxEnv } from "@oscharko-dev/keiko-tools";
import { RIPGREP_OVERRIDE_ENV, type RipgrepRuntimeManifest } from "./ripgrepRuntime.js";
import { stageDevLaneFixture } from "./devLaneFixture/_support.js";
import { codingSafeActivityTtlMs } from "./codingSafeActivityProjection.js";
import { scriptedFunctionalPortable } from "./opencodeFunctionalHarness/_support.js";
import {
  createProductionOpenCodeBackend,
  recordContextTelemetry,
} from "./productionOpenCodeBackend.js";
import type {
  ProductionOpenCodeBackendInput,
  ResolvedPortableOpenCodeRuntime,
} from "./productionOpenCodeBackend.js";
import type { QualifiedPortableOpenCodeRuntime } from "./productionPortableCodingRuntime.js";
import type { ProductionRuntimeBackendInput } from "./productionCodingRuntimeResolver.js";
import type { CodingRuntimeTrustedContext } from "./runtimeAuthorityService.js";
import type { OpenCodeContextGeometry } from "./opencodeLaunchProfile.js";

describe("production OpenCode backend composition", () => {
  it("captures the trusted registry profile once without changing the default runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-profile-capture-"));
    try {
      let selected: "direct" | "code-mode" = "code-mode";
      const profile = vi.fn(() => selected);
      const gatewayReadiness = {
        ...createOpenCodeGatewayReadinessRegistry("code-mode"),
        get toolProfile(): "direct" | "code-mode" {
          return profile();
        },
      };
      const backend = createProductionOpenCodeBackend({
        ...backendInput(root, scriptedFunctionalPortable(root)),
        gatewayReadiness,
      });
      selected = "direct";
      expect(Reflect.get(backend, "toolProfile")).toBe("code-mode");
      expect(Reflect.get(backend, "toolProfile")).toBe("code-mode");
      expect(profile).toHaveBeenCalledOnce();
      expect(Object.isFrozen(backend)).toBe(true);
      const direct = createProductionOpenCodeBackend(
        backendInput(root, scriptedFunctionalPortable(root)),
      );
      expect(Reflect.get(direct, "toolProfile")).toBe("direct");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps legacy missing profiles direct and refuses unknown constructor profiles", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-closed-profile-"));
    try {
      const input = backendInput(root, scriptedFunctionalPortable(root));
      const { toolProfile: _profile, ...legacy } = createOpenCodeGatewayReadinessRegistry();
      const backend = createProductionOpenCodeBackend({ ...input, gatewayReadiness: legacy });
      expect(Reflect.get(backend, "toolProfile")).toBe("direct");
      const invalid = { ...createOpenCodeGatewayReadinessRegistry() };
      Reflect.set(invalid, "toolProfile", "unqualified-profile");
      expect(() =>
        createProductionOpenCodeBackend({ ...input, gatewayReadiness: invalid }),
      ).toThrow(TypeError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["canonical", "alias", "missing"] as const)(
    "binds native filesystem and launch state to the same %s root",
    async (kind) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-service-roots-")));
      const factory = vi.spyOn(nativeBackend, "createNativeRuntimeProcessBackend");
      const compose = vi.spyOn(composition, "createOpenCodeRuntimeComposition");
      try {
        const portable = {
          ...releaseQualifiedNativeRuntime(root),
          target: "macos-arm64" as const,
          qualification: {
            platform: "darwin" as const,
            arch: "arm64" as const,
            backend: "macos-app-sandbox" as const,
            releaseReceipt: `sha256:${"a".repeat(64)}`,
          },
        };
        const stateRoot = join(root, ".keiko");
        const selectedStateRoot = createNativeStateRoot(root, kind);
        const input = runInput(root);
        const run = createProductionOpenCodeBackend({
          ...backendInput(root, portable),
          runtimeStateRoot: selectedStateRoot,
        }).createRun(input);
        expect(factory.mock.calls[0]?.[0].gatewayConfinement?.filesystem).toEqual({
          workspaceRoot: input.context.workspaceRoot,
          workspaceAccess: "read-only",
          privateStateRoot: join(
            stateRoot,
            "coding-runtime",
            "opencode",
            input.minted.authorityRef.runId,
          ),
          runtimeReadRoot: join(portable.installRoot, portable.sidecar.payloadRootPath),
        });
        expect(
          join(compose.mock.calls[0]?.[0].stateBaseRoot ?? "", input.minted.authorityRef.runId),
        ).toBe(factory.mock.calls[0]?.[0].gatewayConfinement?.filesystem?.privateStateRoot);
        await run.dispose?.();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("owns presented facts when bridge completion arrives before the native call identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-tool-presentation-race-"));
    const compose = vi.spyOn(composition, "createOpenCodeRuntimeComposition");
    try {
      const backend = createProductionOpenCodeBackend(
        backendInput(root, windowsDevLaneRuntime(root)),
      );
      const run = backend.createRun(runInput(root));
      const activity = compose.mock.calls[0]?.[0].safeActivity;
      const projection = backend.safeActivityProjection;
      if (activity === undefined || projection === undefined)
        throw new Error("Missing activity port");
      projection.open({
        runId: "run-windows",
        workspaceId: "workspace-windows",
        authorityExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        workspaceIsCurrent: () => true,
      });
      activity.arm();
      const occurredAt = new Date().toISOString();
      const presentation = {
        relativePath: "src/ORIGINAL_PATH.ts",
        readByteCount: 7,
        totalFileLines: 30,
        bridgeDurationMs: 15,
      };
      const settlement = {
        actionId: "session:call_presented",
        state: "succeeded" as const,
        occurredAt,
        presentation,
      };
      activity.settleTool(settlement);
      presentation.readByteCount = 999;
      presentation.relativePath = "src/CHANGED_PATH.ts";
      activity.ingest({ kind: "message", messageId: "msg_user", role: "user", occurredAt });
      activity.ingest({
        kind: "message",
        messageId: "msg_assistant",
        role: "assistant",
        parentMessageId: "msg_user",
        occurredAt,
      });
      activity.ingest({
        kind: "tool",
        messageId: "msg_assistant",
        callId: "call_presented",
        tool: "keiko_workspace_read",
        state: "running",
        occurredAt,
      });
      await Promise.resolve();
      expect(projection.currentContent()).toMatchObject({
        feed: {
          turns: [
            {
              tools: [
                {
                  state: "succeeded",
                  presentation: { relativePath: "src/ORIGINAL_PATH.ts", readByteCount: 7 },
                },
              ],
            },
          ],
        },
      });
      await run.dispose?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("captures durable native messages only after readiness is armed, independently of display acceptance", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-native-history-port-"));
    const compose = vi.spyOn(composition, "createOpenCodeRuntimeComposition");
    const historyCapture = vi.fn().mockReturnValue(true);
    try {
      const backend = createProductionOpenCodeBackend({
        ...backendInput(root, windowsDevLaneRuntime(root)),
        historyCapture,
      });
      const input = runInput(root);
      const run = backend.createRun(input);
      // #3873: the composition bounds one submitted task's whole agent loop by the run's own
      // envelope duration, never by a fixed turn wall shorter than the envelope.
      expect(compose.mock.calls[0]?.[0].maxTurnWaitMs).toBe(input.context.budget.maxRuntimeMs);
      const activity = compose.mock.calls[0]?.[0].safeActivity;
      if (activity?.captureMessages === undefined) throw new Error("Missing history capture port");
      const messages = [{ messageId: "msg_user", role: "user" as const, content: "Task" }];
      expect(activity.captureMessages(messages)).toBe(false);
      expect(historyCapture).not.toHaveBeenCalled();
      activity.arm();
      expect(activity.captureMessages(messages)).toBe(true);
      expect(historyCapture).toHaveBeenCalledWith("run-windows", messages);
      activity.clear();
      expect(activity.captureMessages(messages)).toBe(false);
      expect(historyCapture).toHaveBeenCalledOnce();
      await run.dispose?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #3873: a configured envelope duration reaches the safe-activity retention, which must outlive
  // the envelope (`codingSafeActivityTtlMs`) instead of evicting a live run at a fixed 30 minutes.
  it("retains safe activity for the configured envelope duration plus the retention margin", () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "keiko-production-opencode-retention-"));
    try {
      const start = Date.parse("2026-10-06T12:00:00.000Z");
      vi.setSystemTime(start);
      const runtimeMaxDurationMs = 1_000;
      const projection = createProductionOpenCodeBackend({
        ...backendInput(root, scriptedFunctionalPortable(root)),
        runtimeMaxDurationMs,
      }).safeActivityProjection;
      if (projection === undefined) throw new Error("expected a safe-activity projection");
      projection.open({
        runId: "run-retention",
        workspaceId: "workspace-retention",
        authorityExpiresAt: new Date(start + 86_400_000).toISOString(),
        workspaceIsCurrent: () => true,
      });

      vi.setSystemTime(start + codingSafeActivityTtlMs(runtimeMaxDurationMs) - 1);
      expect(projection.currentContent()?.feed.runId).toBe("run-retention");
      vi.setSystemTime(start + codingSafeActivityTtlMs(runtimeMaxDurationMs));
      expect(projection.currentContent()).toBeNull();
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it("records accepted and rejected provider context samples with body-free evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-production-opencode-context-log-"));
    try {
      const events: ServerLogEvent[] = [];
      const geometry: OpenCodeContextGeometry = {
        contextWindowTokens: 128_000,
        maxInputTokens: 123_904,
        maxOutputTokens: 4_096,
      };
      const run: ProductionRuntimeBackendInput = {
        ...runInput(root),
        contextUsage: createCodingRuntimeContextUsageRegistry(),
      };
      const log = { write: (event: ServerLogEvent): void => void events.push(event) };
      const event = {
        id: "provider-event-1",
        aggregateId: "session-1",
        sequence: 1,
        digest: "e".repeat(64),
        kind: "observation" as const,
        providerTokenUsage: { inputTokens: 42_000 },
      };

      recordContextTelemetry(run, event, geometry, log);
      recordContextTelemetry(
        run,
        {
          ...event,
          id: "provider-event-2",
          sequence: 2,
          digest: "f".repeat(64),
          providerTokenUsage: { inputTokens: 124_000 },
        },
        geometry,
        log,
      );

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        op: "coding-runtime.context-usage.observed",
        correlationId: "run-windows",
        level: "info",
        extra: {
          state: "accepted",
          capacityTokens: 128_000,
          usedInputTokens: 42_000,
          reservedOutputTokens: 4_096,
          sampleDigest: "e".repeat(64),
        },
      });
      expect(events[1]).toMatchObject({
        op: "coding-runtime.context-usage.observed",
        correlationId: "run-windows",
        level: "warn",
        errorKind: "conflict",
        extra: {
          state: "rejected",
          capacityTokens: 128_000,
          usedInputTokens: 124_000,
          reservedOutputTokens: 4_096,
          sampleDigest: "f".repeat(64),
        },
      });
      const acceptedProof = expectActivityLogProof(
        "coding-runtime.context-usage.observed.emitted-line",
        formatActivityLogProofLine(events[0] ?? {}),
      );
      expect(acceptedProof).toMatchObject({
        correlationId: "run-windows",
        state: "accepted",
        capacityTokens: 128_000,
        usedInputTokens: 42_000,
        reservedOutputTokens: 4_096,
        sampleDigest: "e".repeat(64),
      });
      const rejectedProof = expectActivityLogProof(
        "coding-runtime.context-usage.observed.emitted-line",
        formatActivityLogProofLine(events[1] ?? {}),
      );
      expect(rejectedProof).toMatchObject({
        correlationId: "run-windows",
        state: "rejected",
        sampleDigest: "f".repeat(64),
      });
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

  it("composes a release-qualified Linux run through the namespace gateway backend", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-linux-gateway-composition-"));
    try {
      const portable = releaseQualifiedLinuxRuntime(root);
      const input = backendInput(root, portable);
      const request = runInput(root);
      const gatewayFactory = vi.spyOn(gatewayBackend, "createDevLaneRuntimeProcessBackend");
      const nativeFactory = vi.spyOn(nativeBackend, "createNativeRuntimeProcessBackend");

      const run = createProductionOpenCodeBackend(input).createRun(request);

      expect(run.launch.confinement).toMatchObject({
        platform: "linux",
        arch: "x64",
        backend: "linux-namespace-gateway",
      });
      expect(gatewayFactory).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          identity: {
            platform: "linux",
            arch: "x64",
            backend: "linux-namespace-gateway",
          },
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
      expect(nativeFactory).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  // #3897: the native profile's kernel network disposition follows the run's EFFECTIVE mode, and
  // the Linux native run receives the same accepted filesystem the macOS run does.
  it.each([
    ["governed-assist", "loopback-only"],
    ["supervised-coding", "loopback-only"],
    ["autonomous-delivery", "inherited"],
  ] as const)(
    "composes a native %s run with %s egress and a read-write filesystem on Linux",
    (mode, egress) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-egress-composition-")));
      mkdirSync(join(root, "toolchain", "bin"), { recursive: true });
      vi.stubEnv("PATH", join(root, "toolchain", "bin"));
      try {
        const portable = releaseQualifiedLinuxRuntime(root);
        const request = runInput(root);
        const gatewayFactory = vi.spyOn(gatewayBackend, "createDevLaneRuntimeProcessBackend");
        createProductionOpenCodeBackend({
          ...backendInput(root, portable),
          gatewayReadiness: createOpenCodeGatewayReadinessRegistry("native"),
        }).createRun({ ...request, minted: { ...request.minted, effectiveMode: mode } });
        const confinement = gatewayFactory.mock.calls[0]?.[0].gatewayConfinement;
        expect(confinement).toMatchObject({
          profile: "keiko-native",
          egress,
          filesystem: {
            workspaceRoot: request.context.workspaceRoot,
            workspaceAccess: "read-write",
            toolchainReadRoots: [join(root, "toolchain")],
          },
        });
        expect(confinement?.filesystem?.deniedReadRoots).toContain(realpathSync(root));
        expectNativeFilesystemHardening(
          confinement?.filesystem,
          root,
          request.minted.authorityRef.runId,
        );
      } finally {
        vi.unstubAllEnvs();
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("binds the mode-derived egress into the policy digest so a different mode cannot replay it", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-egress-digest-")));
    try {
      const digests = (["governed-assist", "autonomous-delivery"] as const).map((mode) => {
        const factory = vi.spyOn(gatewayBackend, "createDevLaneRuntimeProcessBackend");
        const request = runInput(root);
        createProductionOpenCodeBackend({
          ...backendInput(root, releaseQualifiedLinuxRuntime(root)),
          gatewayReadiness: createOpenCodeGatewayReadinessRegistry("native"),
        }).createRun({ ...request, minted: { ...request.minted, effectiveMode: mode } });
        return factory.mock.calls.at(-1)?.[0].gatewayConfinement?.policyDigest;
      });
      expect(digests[0]).toBeDefined();
      expect(digests[0]).not.toBe(digests[1]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

/**
 * #3897 review (P1): the user's other agent state and credential files are denied, and the run's
 * OpenCode configuration directory is protected from writes.
 */
function expectNativeFilesystemHardening(
  filesystem: RuntimeGatewayFilesystem | undefined,
  root: string,
  runId: string,
): void {
  for (const entry of [
    ".ssh",
    ".config/gh",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".local/share/opencode",
    ".local/state/gh",
  ])
    expect(filesystem?.deniedReadRoots).toContain(join(homedir(), entry));
  const privateStateRoot = join(realpathSync(root), "coding-runtime", "opencode", runId);
  expect(filesystem?.privateStateRoot).toBe(privateStateRoot);
  expect(filesystem?.protectedWriteRoots).toEqual([join(privateStateRoot, "config", "opencode")]);
}

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
        upstreamVersion: "2.0.10",
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
      protocolHandshakeAlgorithm: "keiko-opencode-protocol-surface-v2",
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

function releaseQualifiedLinuxRuntime(root: string): QualifiedPortableOpenCodeRuntime {
  const runtime = releaseQualifiedNativeRuntime(root);
  return {
    ...runtime,
    target: "linux-x64",
    qualification: {
      platform: "linux",
      arch: "x64",
      backend: "linux-namespace-gateway",
      releaseReceipt: runtime.qualification.releaseReceipt,
    },
    sidecar: {
      ...runtime.sidecar,
      summary: { ...runtime.sidecar.summary, platformTarget: "linux-x64" },
      executablePath: `${runtime.sidecar.payloadRootPath}/opencode`,
    },
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

function createNativeStateRoot(root: string, kind: "canonical" | "alias" | "missing"): string {
  const stateRoot = join(root, ".keiko");
  if (kind !== "missing") mkdirSync(stateRoot, { mode: 0o700 });
  if (kind !== "alias") return stateRoot;
  const alias = join(root, "state-alias");
  symlinkSync(stateRoot, alias, "dir");
  return alias;
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

function retryActivityFixture(root: string): {
  readonly activity: NonNullable<composition.OpenCodeRuntimeCompositionInput["safeActivity"]>;
  readonly projection: NonNullable<
    ReturnType<typeof createProductionOpenCodeBackend>["safeActivityProjection"]
  >;
  readonly events: import("@oscharko-dev/keiko-contracts").CodingWorkbenchRuntimeEvent[];
  readonly dispose: () => void | Promise<void>;
} {
  const compose = vi.spyOn(composition, "createOpenCodeRuntimeComposition");
  const backend = createProductionOpenCodeBackend(backendInput(root, windowsDevLaneRuntime(root)));
  const events: import("@oscharko-dev/keiko-contracts").CodingWorkbenchRuntimeEvent[] = [];
  const input = runInput(root);
  const run = backend.createRun({
    ...input,
    request: { ...input.request, runId: "run-1" },
    minted: { ...input.minted, authorityRef: { ...input.minted.authorityRef, runId: "run-1" } },
    onRuntimeEvent: (event): void => {
      events.push(event);
    },
  });
  const activity = compose.mock.calls[0]?.[0].safeActivity;
  const projection = backend.safeActivityProjection;
  if (activity === undefined || projection === undefined) throw new Error("Missing activity port");
  projection.open({
    runId: "run-1",
    workspaceId: "workspace-windows",
    authorityExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    workspaceIsCurrent: () => true,
  });
  return { activity, projection, events, dispose: (): void | Promise<void> => run.dispose?.() };
}

function retryMessage(): Extract<
  import("./codingSafeActivityProjection.js").CodingSafeActivitySignal,
  { kind: "message" }
> {
  return {
    kind: "message",
    messageId: "msg_retry_first",
    parentMessageId: "msg_retry_user",
    role: "assistant",
    occurredAt: new Date().toISOString(),
    nativeRetry: { attempt: 2, scheduledAt: "2026-10-07T12:00:02.000Z" },
  };
}

describe("production native retry projection", () => {
  it("rejects accessor facts without invoking them at the real backend projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-native-retry-record-"));
    try {
      const f = retryActivityFixture(root);
      f.activity.arm();
      const message = retryMessage();
      f.activity.ingest({
        kind: "message",
        messageId: "msg_retry_user",
        role: "user",
        occurredAt: message.occurredAt,
      });
      const getter = vi.fn((): number => 2);
      const nativeRetry = Object.defineProperty(
        { attempt: 2, scheduledAt: "2026-10-07T12:00:02.000Z" },
        "attempt",
        { enumerable: true, get: getter },
      );
      expect(f.activity.ingest({ ...message, nativeRetry })).toBe(false);
      expect(f.events).toEqual([]);
      expect(getter).not.toHaveBeenCalled();
      await f.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears the private observation state when the existing controller is cleared and rearmed", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-native-retry-rearm-"));
    try {
      const f = retryActivityFixture(root);
      const message = retryMessage();
      f.activity.arm();
      f.activity.ingest({
        kind: "message",
        messageId: "msg_retry_user",
        role: "user",
        occurredAt: message.occurredAt,
      });
      f.activity.ingest(message);
      f.activity.clear();
      f.activity.arm();
      f.activity.ingest(message);
      expect(f.events).toHaveLength(2);
      expect(new Set(f.events.map((event) => event.eventId)).size).toBe(2);
      await f.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes only armed accepted retry facts, deduplicates them, and reports native clear", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-native-retry-"));
    try {
      const f = retryActivityFixture(root);
      const message = retryMessage();
      f.activity.ingest(message);
      expect(f.events).toEqual([]);
      f.activity.arm();
      f.activity.ingest(message);
      expect(f.events).toEqual([]);
      f.activity.ingest({
        kind: "message",
        messageId: "msg_retry_user",
        role: "user",
        occurredAt: message.occurredAt,
      });
      f.activity.ingest(message);
      f.activity.ingest(message);
      expect(f.events).toMatchObject([
        { kind: "native-retry-changed", nativeRetry: message.nativeRetry },
      ]);
      const { nativeRetry: _nativeRetry, ...clear } = message;
      f.activity.ingest(clear);
      expect(f.events).toMatchObject([{ nativeRetry: message.nativeRetry }, { nativeRetry: null }]);
      expect(f.events.every((event) => validateCodingWorkbenchRuntimeEvent(event).ok)).toBe(true);
      expect(f.projection.currentContent()?.feed).not.toHaveProperty("nativeRetry");
      f.activity.clear();
      f.activity.ingest(message);
      expect(f.events).toHaveLength(2);
      await f.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

interface ChildFixturePlugin {
  readonly setup: (context: {
    readonly tool: {
      readonly hook: (
        name: string,
        callback: (event: Readonly<Record<string, string>>) => void,
      ) => Promise<unknown>;
      readonly transform: (
        register: (editor: {
          readonly add: (tool: {
            readonly name: string;
            readonly execute: (args: object, context: object) => Promise<unknown>;
          }) => void;
        }) => void,
      ) => Promise<unknown>;
    };
  }) => Promise<unknown>;
}

function capturedChildPlugin(actions: string[]): ChildFixturePlugin {
  const source = createGeneratedOpenCodeV2Plugins().keiko_governed_tools;
  if (source === undefined) throw new Error("Missing generated owner");
  return new Script(
    `${source.replace("export default", "const plugin =")}\nplugin;`,
  ).runInNewContext({
    process: {
      env: {
        KEIKO_CODING_MODE: "autonomous-delivery",
        KEIKO_TOOL_FACADE_URL: "http://127.0.0.1/fixture",
        KEIKO_TOOL_FACADE_CAPABILITY: "fixture",
      },
    },
    crypto: webcrypto,
    AbortController,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    fetch: (_url: unknown, input: { readonly body: string }): Promise<Response> => {
      const request: unknown = JSON.parse(input.body);
      if (
        typeof request !== "object" ||
        request === null ||
        !("actionId" in request) ||
        typeof request.actionId !== "string"
      )
        throw new Error("Invalid producer request");
      actions.push(request.actionId);
      return Promise.resolve(new Response(JSON.stringify({ status: "completed", evidence: [] })));
    },
  }) as ChildFixturePlugin;
}

async function capturedChildActions(count: number): Promise<readonly string[]> {
  const actions: string[] = [];
  let before: ((event: Readonly<Record<string, string>>) => void) | undefined;
  let execute: ((args: object, context: object) => Promise<unknown>) | undefined;
  await capturedChildPlugin(actions).setup({
    tool: {
      hook: (name, callback): Promise<unknown> => {
        if (name === "execute.before") before = callback;
        return Promise.resolve();
      },
      transform: (register): Promise<unknown> => {
        register({
          add: (tool): void => {
            if (tool.name === "keiko_git_status") execute = tool.execute;
          },
        });
        return Promise.resolve();
      },
    },
  });
  const context = {
    sessionID: "ses_child_projection",
    id: "call_original_parent",
    messageID: "msg_child_assistant",
    agent: "build",
  };
  if (before === undefined || execute === undefined) throw new Error("Missing native registration");
  before({ ...context, tool: "execute" });
  const tool = execute;
  await Promise.all(
    Array.from({ length: count }, async (): Promise<unknown> => tool({}, { ...context })),
  );
  return actions;
}

function childParent(f: ReturnType<typeof retryActivityFixture>): void {
  const occurredAt = new Date().toISOString();
  f.activity.ingest({ kind: "message", messageId: "msg_child_user", role: "user", occurredAt });
  f.activity.ingest({
    kind: "message",
    messageId: "msg_child_assistant",
    parentMessageId: "msg_child_user",
    role: "assistant",
    occurredAt,
  });
  f.activity.ingest({
    kind: "tool",
    callId: "call_original_parent",
    messageId: "msg_child_assistant",
    tool: "execute",
    state: "running",
    occurredAt,
  });
}

async function answeredChild(
  f: ReturnType<typeof retryActivityFixture>,
  actionId: string,
  outcome: "completed" | "failed" = "completed",
): Promise<void> {
  const subject = createCodingToolFacade({
    authority: {
      admit: (): ReturnType<CodingToolAuthorityPort["admit"]> => ({
        ok: true,
        mutationGuard: { check: () => true },
      }),
    },
    delegate: {
      execute: (): Promise<unknown> =>
        Promise.resolve({
          outcome,
          git: {
            kind: "status",
            headSha: "a".repeat(40),
            stagedTreeDigest: "b".repeat(64),
            branch: "codex/fixture",
            changes: [],
            truncated: false,
          },
        }),
    },
  });
  const request = {
    action: "git",
    operation: "status",
    actionId,
    idempotencyKey: actionId,
  } as const;
  const alias = openCodeCatalogAliasFor(request);
  if (alias === undefined) throw new Error("Missing canonical alias");
  const result = await subject.execute({
    body: JSON.stringify(request),
    onDelegateStarted: (): void => {
      f.activity.beginTool?.({ actionId, tool: alias, occurredAt: new Date().toISOString() });
    },
  });
  f.activity.settleTool({
    actionId,
    delegateStarted: true,
    state: result.status === "completed" ? "succeeded" : "failed",
    occurredAt: new Date().toISOString(),
  });
  await Promise.resolve();
}

it.each([true, false])(
  "joins captured admitted child outcomes with original parent arriving first=%s",
  async (first) => {
    const root = mkdtempSync(join(tmpdir(), "keiko-native-child-join-"));
    try {
      const f = retryActivityFixture(root);
      f.activity.arm("ses_child_projection", "code-mode");
      if (first) childParent(f);
      const ids = await capturedChildActions(2);
      const [one, two] = ids;
      if (one === undefined || two === undefined)
        throw new Error("Missing actual producer identities");
      await answeredChild(f, one);
      await answeredChild(f, two, "failed");
      if (!first) {
        childParent(f);
        await Promise.resolve();
      }
      const content = f.projection.currentContent();
      const feed = content?.feed;
      const tools = feed?.availability === "available" ? feed.turns[0]?.tools : undefined;
      expect(tools).toEqual([
        expect.objectContaining({ callId: "call_original_parent", tool: "execute" }),
        expect.objectContaining({
          callId: one.slice(one.indexOf(":") + 1),
          tool: "keiko_git_status",
          state: "succeeded",
        }),
        expect.objectContaining({
          callId: two.slice(two.indexOf(":") + 1),
          tool: "keiko_git_status",
          state: "failed",
        }),
      ]);
      await f.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

async function withChildActivity(
  test: (fixture: ReturnType<typeof retryActivityFixture>, actionId: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "keiko-native-child-controls-"));
  const fixture = retryActivityFixture(root);
  try {
    fixture.activity.arm("ses_child_projection", "code-mode");
    const actionId = (await capturedChildActions(1))[0];
    if (actionId === undefined) throw new Error("Missing producer identity");
    await test(fixture, actionId);
  } finally {
    await fixture.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

function projectedChildren(f: ReturnType<typeof retryActivityFixture>): readonly {
  readonly callId: string;
  readonly state: string;
}[] {
  const feed = f.projection.currentContent()?.feed;
  return feed?.availability === "available"
    ? (feed.turns[0]?.tools.filter(({ callId }) => callId.startsWith("cm_")) ?? [])
    : [];
}

function beginChild(f: ReturnType<typeof retryActivityFixture>, actionId: string): void {
  f.activity.beginTool?.({
    actionId,
    tool: "keiko_git_status",
    occurredAt: new Date().toISOString(),
  });
}

function settleChild(
  f: ReturnType<typeof retryActivityFixture>,
  actionId: string,
  state: "succeeded" | "failed" | "denied" | "cancelled",
  delegateStarted?: true,
): void {
  f.activity.settleTool({
    actionId,
    state,
    occurredAt: new Date().toISOString(),
    ...(delegateStarted === undefined ? {} : { delegateStarted }),
  });
}

it.each([true, false])(
  "does not let a refused duplicate overwrite the admitted original, parent-first=%s",
  async (first) => {
    await withChildActivity(async (f, actionId) => {
      if (first) childParent(f);
      beginChild(f, actionId);
      settleChild(f, actionId, "denied");
      if (!first) childParent(f);
      await Promise.resolve();
      expect(projectedChildren(f)).toEqual([expect.objectContaining({ state: "running" })]);
      settleChild(f, actionId, "succeeded", true);
      // A refusal can arrive before the admitted terminal's scheduled projection.
      settleChild(f, actionId, "denied");
      await Promise.resolve();
      expect(projectedChildren(f)).toEqual([expect.objectContaining({ state: "succeeded" })]);
      // Nor may a replay arriving after the original settled replace its actual result.
      settleChild(f, actionId, "denied");
      await Promise.resolve();
      expect(projectedChildren(f)).toEqual([expect.objectContaining({ state: "succeeded" })]);
    });
  },
);

it("projects genuine admitted cancellation without treating native completed progress as success", async () => {
  await withChildActivity(async (f, actionId) => {
    childParent(f);
    beginChild(f, actionId);
    settleChild(f, actionId, "cancelled", true);
    await Promise.resolve();
    expect(projectedChildren(f)).toEqual([expect.objectContaining({ state: "cancelled" })]);
  });
});

it("refuses foreign-session, ordinal, parent and uncovered-alias associations", async () => {
  await withChildActivity(async (f, actionId) => {
    childParent(f);
    const invalid = [
      actionId.replace("ses_child_projection:", "ses_foreign:"),
      actionId.replace(/_1$/u, "_0"),
      actionId.replace(/_1$/u, "_2049"),
      actionId.replace(/cm_./u, "cm_x"),
    ];
    for (const id of invalid) {
      beginChild(f, id);
      settleChild(f, id, "succeeded", true);
    }
    f.activity.beginTool?.({ actionId, tool: "foreign", occurredAt: new Date().toISOString() });
    settleChild(f, actionId, "succeeded", true);
    await Promise.resolve();
    expect(projectedChildren(f)).toEqual([]);
    expect(f.projection.currentContent()?.feed.droppedEventCount).toBeGreaterThan(0);
  });
});

it("waits for the exact original parent and never joins by progress order", async () => {
  await withChildActivity(async (f, actionId) => {
    childParent(f);
    beginChild(f, actionId.replace(/cm_[a-f0-9]{64}/u, `cm_${"f".repeat(64)}`));
    settleChild(f, actionId.replace(/cm_[a-f0-9]{64}/u, `cm_${"f".repeat(64)}`), "succeeded", true);
    await Promise.resolve();
    expect(projectedChildren(f)).toEqual([]);
    await answeredChild(f, actionId);
    expect(projectedChildren(f)).toEqual([expect.objectContaining({ state: "succeeded" })]);
  });
});

it.each(["clear", "rebind"] as const)("drops queued old-child facts after %s", async (kind) => {
  await withChildActivity(async (f, actionId) => {
    beginChild(f, actionId);
    settleChild(f, actionId, "succeeded", true);
    if (kind === "clear") {
      f.activity.clear();
      f.activity.arm("ses_child_projection", "code-mode");
    } else {
      f.activity.arm("ses_rebound", "code-mode");
    }
    childParent(f);
    await Promise.resolve();
    expect(projectedChildren(f)).toEqual([]);
  });
});

it("retains the captured backend profile through actual run composition", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiko-profile-child-chain-"));
  const compose = vi.spyOn(composition, "createOpenCodeRuntimeComposition");
  const base = backendInput(root, windowsDevLaneRuntime(root));
  let profile: "code-mode" | "direct" = "code-mode";
  const readProfile = vi.fn(() => profile);
  const gatewayReadiness = {
    ...base.gatewayReadiness,
    get toolProfile(): "code-mode" | "direct" {
      return readProfile();
    },
  };
  const backend = createProductionOpenCodeBackend({ ...base, gatewayReadiness });
  profile = "direct";
  const run = backend.createRun(runInput(root));
  try {
    expect(compose.mock.calls[0]?.[0].toolProfile).toBe("code-mode");
    expect(readProfile).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(backend)).toBe(true);
  } finally {
    await run.dispose?.();
    rmSync(root, { recursive: true, force: true });
  }
});

// #3897 S14: the admitted model's declared image input travels from the run metadata the server
// resolves for the model profile, through the context geometry, into the actual run composition,
// where the launch profile turns it into the native provider binding.
it.each([
  { declared: true, expected: true },
  { declared: false, expected: undefined },
  { declared: undefined, expected: undefined },
])(
  "carries declared image input $declared into the composed context geometry",
  async ({ declared, expected }) => {
    const root = mkdtempSync(join(tmpdir(), "keiko-image-geometry-"));
    const compose = vi.spyOn(composition, "createOpenCodeRuntimeComposition");
    const base = backendInput(root, windowsDevLaneRuntime(root));
    const backend = createProductionOpenCodeBackend({
      ...base,
      resolveGatewayRunMetadata: (modelId) => ({
        ...(base.resolveGatewayRunMetadata?.(modelId) ?? {
          maxPromptTokens: 128_000,
          maxOutputTokens: 4_096,
          maxInputMessages: 512,
          maxRequestBytes: 1_048_576,
        }),
        ...(declared === undefined ? {} : { supportsImageInput: declared }),
      }),
    });
    const run = backend.createRun(runInput(root));
    try {
      const geometry = compose.mock.calls[0]?.[0].contextGeometry;
      expect(geometry?.imageInput).toBe(expected);
    } finally {
      await run.dispose?.();
      compose.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("bounds delayed child correlations and reports eviction without inventing a native child", async () => {
  await withChildActivity(async (f) => {
    const ids = await capturedChildActions(700);
    for (const actionId of ids) {
      beginChild(f, actionId);
      settleChild(f, actionId, "succeeded", true);
    }
    childParent(f);
    await Promise.resolve();
    const first = ids[0]?.split(":")[1];
    expect(projectedChildren(f).some(({ callId }) => callId === first)).toBe(false);
    expect(projectedChildren(f).length).toBeGreaterThan(0);
    expect(f.projection.currentContent()?.feed.droppedEventCount).toBeGreaterThan(0);
  });
});

it("refuses an original parent restated under another actual assistant message", async () => {
  await withChildActivity(async (f, actionId) => {
    childParent(f);
    f.activity.ingest({
      kind: "message",
      messageId: "msg_child_other",
      parentMessageId: "msg_child_user",
      role: "assistant",
      occurredAt: new Date().toISOString(),
    });
    f.activity.ingest({
      kind: "tool",
      callId: "call_original_parent",
      messageId: "msg_child_other",
      tool: "execute",
      state: "running",
      occurredAt: new Date().toISOString(),
    });
    beginChild(f, actionId);
    settleChild(f, actionId, "succeeded", true);
    await Promise.resolve();
    expect(projectedChildren(f)).toEqual([]);
    expect(f.projection.currentContent()?.feed.droppedEventCount).toBeGreaterThan(0);
  });
});

// #3897: OpenCode's glob/grep/file finder run ripgrep and would otherwise download it. The launch
// resolves the one pinned executable, puts ONLY a verified directory on the child PATH, opens
// exactly that directory in the kernel read allowlist, and records the closed outcome.
describe("ripgrep on the OpenCode launch", () => {
  const BINARY = "fixture ripgrep for the launch";
  const CONTENT_ENV = {
    PATH: `/usr/bin${delimiter}/bin`,
    LANG: "C.UTF-8",
    SECRET_TOKEN: "t0k3n-value",
  };

  function manifestFor(key: "linux-x64" | "win32-x64"): RipgrepRuntimeManifest {
    return {
      version: "0.0.0-test",
      sourceCommit: "a".repeat(40),
      licenseExpression: "MIT",
      licenseFileName: "LICENSE-MIT",
      targets: {
        [key]: {
          archiveKind: "tar.gz",
          archiveUrl: "https://example.test/ripgrep.tar.gz",
          archiveSha256: "b".repeat(64),
          archiveSizeBytes: 10,
          binaryMember: "ripgrep/rg",
          binarySha256: createHash("sha256").update(BINARY).digest("hex"),
          binarySizeBytes: BINARY.length,
          licenseMember: "ripgrep/LICENSE-MIT",
          licenseSha256: "c".repeat(64),
        },
      },
    };
  }

  function stage(path: string, content = BINARY): string {
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    chmodSync(dirname(path), 0o755);
    writeFileSync(path, content);
    chmodSync(path, 0o755);
    return dirname(path);
  }

  interface Launch {
    readonly processEnv: NodeJS.ProcessEnv | undefined;
    readonly allowlist: readonly string[];
    readonly toolchainReadRoots: readonly string[] | undefined;
    readonly events: readonly ServerLogEvent[];
  }

  function launch(
    root: string,
    portable: ResolvedPortableOpenCodeRuntime,
    options: {
      readonly native: boolean;
      readonly processEnv?: NodeJS.ProcessEnv | undefined;
      readonly key: "linux-x64" | "win32-x64";
    },
  ): Launch {
    const events: ServerLogEvent[] = [];
    const compose = vi.spyOn(composition, "createOpenCodeRuntimeComposition");
    const gatewayFactory = vi.spyOn(gatewayBackend, "createDevLaneRuntimeProcessBackend");
    const nativeFactory = vi.spyOn(nativeBackend, "createNativeRuntimeProcessBackend");
    const run = createProductionOpenCodeBackend({
      ...backendInput(root, portable),
      gatewayReadiness: createOpenCodeGatewayReadinessRegistry(
        options.native ? "native" : "direct",
      ),
      ripgrepManifest: manifestFor(options.key),
      activityLog: { write: (event) => events.push(event) },
      ...(options.processEnv === undefined ? {} : { processEnv: options.processEnv }),
    }).createRun(runInput(root));
    // A test may launch twice; the spies accumulate, and the latest call is this launch's.
    const confinement = (gatewayFactory.mock.calls.at(-1) ?? nativeFactory.mock.calls.at(-1))?.[0]
      .gatewayConfinement;
    return {
      processEnv: compose.mock.calls.at(-1)?.[0].processEnv,
      allowlist: run.launch.inheritedEnvAllowlist,
      toolchainReadRoots: confinement?.filesystem?.toolchainReadRoots,
      events,
    };
  }

  function tmpRoot(): string {
    return realpathSync(mkdtempSync(join(tmpdir(), "keiko-ripgrep-launch-")));
  }

  it("puts only the verified directory in front of the native child PATH and opens exactly it", () => {
    const root = tmpRoot();
    vi.stubEnv("PATH", `/usr/bin${delimiter}/bin`);
    try {
      const directory = stage(join(root, "install", "runtime", "native", "rg"));
      const result = launch(root, releaseQualifiedLinuxRuntime(root), {
        native: true,
        processEnv: CONTENT_ENV,
        key: "linux-x64",
      });

      expect(result.processEnv?.PATH).toBe(`${directory}${delimiter}/usr/bin${delimiter}/bin`);
      expect(result.allowlist).toContain("PATH");
      // What the manager really hands the child: the allowlisted names of this very environment.
      const child = buildSandboxEnv(result.processEnv ?? {}, result.allowlist);
      expect(child.PATH?.split(delimiter)[0]).toBe(directory);
      expect(child.SECRET_TOKEN).toBeUndefined();
      expect(result.processEnv?.SECRET_TOKEN).toBe("t0k3n-value");
      expect(result.toolchainReadRoots).toEqual([directory]);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        op: "coding-runtime.ripgrep.resolved",
        level: "info",
        correlationId: "run-windows",
        extra: {
          targetKey: "linux-x64",
          outcome: "verified",
          layout: "portable",
          toolProfile: "native",
          digestSource: "pinned",
          version: "0.0.0-test",
        },
      });
      expect(JSON.stringify(result.events)).not.toContain(root);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("starts the run without touching PATH when the executable does not verify", () => {
    const root = tmpRoot();
    vi.stubEnv("PATH", `/usr/bin${delimiter}/bin`);
    try {
      stage(join(root, "install", "runtime", "native", "rg"), "not the pinned bytes");
      const result = launch(root, releaseQualifiedLinuxRuntime(root), {
        native: true,
        processEnv: CONTENT_ENV,
        key: "linux-x64",
      });

      expect(result.processEnv).toBe(CONTENT_ENV);
      expect(result.processEnv?.PATH).toBe(`/usr/bin${delimiter}/bin`);
      expect(result.toolchainReadRoots).toEqual([]);
      expect(result.events[0]).toMatchObject({
        level: "warn",
        extra: { outcome: "unverified", layout: "portable", reason: "digest-mismatch" },
      });
      expect(JSON.stringify(result.events)).not.toContain(root);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("gives a mapped profile the verified directory alone and no inherited entry", () => {
    const root = tmpRoot();
    try {
      const directory = stage(join(root, "install", "runtime", "native", "rg"));
      const result = launch(root, releaseQualifiedLinuxRuntime(root), {
        native: false,
        processEnv: CONTENT_ENV,
        key: "linux-x64",
      });

      expect(result.allowlist).toEqual(["PATH"]);
      expect(result.processEnv?.PATH).toBe(directory);
      expect(buildSandboxEnv(result.processEnv ?? {}, result.allowlist)).toEqual({
        PATH: directory,
      });
      expect(result.events[0]).toMatchObject({ extra: { toolProfile: "mapped" } });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps the mapped profile's empty inheritance when the executable does not verify", () => {
    const root = tmpRoot();
    try {
      const result = launch(root, releaseQualifiedLinuxRuntime(root), {
        native: false,
        processEnv: CONTENT_ENV,
        key: "linux-x64",
      });
      expect(result.allowlist).toEqual([]);
      expect(result.processEnv).toBe(CONTENT_ENV);
      expect(result.events[0]).toMatchObject({
        extra: { outcome: "unverified", reason: "missing", toolProfile: "mapped" },
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("ignores an environment override in a packaged runtime", () => {
    const root = tmpRoot();
    try {
      const named = stage(join(root, "elsewhere", "rg"));
      const result = launch(root, releaseQualifiedLinuxRuntime(root), {
        native: true,
        processEnv: { ...CONTENT_ENV, [RIPGREP_OVERRIDE_ENV]: join(named, "rg") },
        key: "linux-x64",
      });
      expect(result.processEnv?.PATH).toBe(`/usr/bin${delimiter}/bin`);
      expect(result.events[0]).toMatchObject({
        extra: { outcome: "unverified", layout: "portable", reason: "missing" },
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("finds the provisioned executable of a development checkout and honours a verified override", () => {
    const root = tmpRoot();
    try {
      const portable = windowsDevLaneRuntime(root);
      const checkout = devLaneCheckoutRoot(portable);
      expect(checkout).toBeDefined();
      const provisioned = stage(
        join(checkout ?? root, ".ripgrep", "0.0.0-test", "win32-x64", "rg.exe"),
      );
      const result = launch(root, portable, {
        native: true,
        processEnv: CONTENT_ENV,
        key: "win32-x64",
      });
      expect(result.processEnv?.PATH?.split(delimiter)[0]).toBe(provisioned);
      expect(result.events[0]).toMatchObject({
        extra: { outcome: "verified", layout: "provisioned" },
      });

      const named = stage(join(root, "chosen", "rg.exe"));
      const overridden = launch(root, portable, {
        native: true,
        processEnv: { ...CONTENT_ENV, [RIPGREP_OVERRIDE_ENV]: join(named, "rg.exe") },
        key: "win32-x64",
      });
      expect(overridden.processEnv?.PATH?.split(delimiter)[0]).toBe(named);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
