import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { validateCodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchPermissionRequestKind,
} from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchRuntimeEvent } from "@oscharko-dev/keiko-contracts";

import {
  createCodingRuntimeManager as createProductionCodingRuntimeManager,
  resolveCodingRuntimeSidecarLaunchTarget,
  type CodingRuntimeManager,
  type CodingRuntimeManagerDeps,
  type CodingRuntimeLaunchRequest,
} from "./codingRuntimeManager.js";
import {
  createRuntimeProcessSupervisor,
  verifyRuntimeReapReceipt,
  type RuntimeProcessBackend,
  type RuntimeProcessSupervisor,
  type RuntimeProcessTree,
  type RuntimeQualificationIdentity,
  type RuntimeSupervisorLaunchRequest,
  type RuntimeTreeSignal,
} from "./runtimeProcessSupervisor.js";
import { createInMemorySupervisedCodingApprovalStore } from "./supervisedCodingApprovalStore.js";
import type { PortableSidecarRuntimeVerification } from "../update-portable-sidecar-verification.js";
import {
  OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256,
  OPEN_CODE_PROTOCOL_SURFACE_ALGORITHM,
} from "./opencodeProtocolSurface.js";

const tempDirs: string[] = [];
const OPENCODE_SCHEMA_SHA256 = "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de";
const TEST_QUALIFICATION: RuntimeQualificationIdentity = {
  platform: "win32",
  arch: "x64",
  backend: "windows-job-object",
  releaseReceipt: `sha256:${"a".repeat(64)}`,
};

type TestCodingRuntimeManagerDeps = Omit<
  CodingRuntimeManagerDeps,
  | "revokeRuntime"
  | "abortInFlightActions"
  | "markRuntimeRecoveryRequired"
  | "releaseRuntimeAfterReap"
> &
  Partial<
    Pick<
      CodingRuntimeManagerDeps,
      | "revokeRuntime"
      | "abortInFlightActions"
      | "markRuntimeRecoveryRequired"
      | "releaseRuntimeAfterReap"
    >
  >;

function createTestCodingRuntimeManager(deps: TestCodingRuntimeManagerDeps): CodingRuntimeManager {
  const portable = createPortableRuntimeFixture();
  return createProductionCodingRuntimeManager({
    revokeRuntime: (): true => true,
    abortInFlightActions: (): true => true,
    markRuntimeRecoveryRequired: (): true => true,
    releaseRuntimeAfterReap: (): true => true,
    portableRuntimeResolver: () => ({
      verification: portable.verification,
      resourceRoot: portable.resourceRoot,
      target: "windows-x64",
    }),
    ...deps,
  });
}

function testSupervisor(
  spawn: CodingRuntimeSpawnFn,
  timer: RuntimeSupervisorTimer = {
    setTimer: (callback, delayMs): ReturnType<typeof setTimeout> => setTimeout(callback, delayMs),
  },
): RuntimeProcessSupervisor {
  return createRuntimeProcessSupervisor({
    backend: new TestRuntimeProcessBackend(spawn, timer, TEST_QUALIFICATION),
    qualifications: [TEST_QUALIFICATION],
  });
}

interface CodingRuntimeSpawnHandle {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid?: number | undefined;
  kill(signal: NodeJS.Signals): void;
  onExit(callback: (code: number | null) => void): void;
  onError(callback: (error: Error) => void): void;
}

type CodingRuntimeSpawnFn = (
  executable: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
) => CodingRuntimeSpawnHandle;

interface RuntimeSupervisorTimer {
  setTimer(callback: () => void, delayMs: number): unknown;
}

interface TestTreeState {
  exited: boolean;
  readonly exitCallbacks: ((code: number | null) => void)[];
  readonly waiters: (() => void)[];
}

class TestRuntimeProcessBackend implements RuntimeProcessBackend {
  private readonly states = new Map<RuntimeProcessTree, TestTreeState>();
  public readonly identity: RuntimeProcessBackend["identity"];

  public constructor(
    private readonly spawn: CodingRuntimeSpawnFn,
    private readonly timer: RuntimeSupervisorTimer,
    qualification: RuntimeQualificationIdentity,
  ) {
    this.identity = {
      platform: qualification.platform,
      arch: qualification.arch,
      backend: qualification.backend,
    };
  }

  public spawnOwnedTree(request: RuntimeSupervisorLaunchRequest): RuntimeProcessTree {
    const child = this.spawn(request.executable, request.args, { ...request.env }, request.cwd);
    const state: TestTreeState = { exited: false, exitCallbacks: [], waiters: [] };
    const tree: RuntimeProcessTree & { readonly child: CodingRuntimeSpawnHandle } = {
      treeId: `test-${String(child.pid ?? "unknown")}`,
      stdout: child.stdout,
      stderr: child.stderr,
      child,
      onTreeExit: (callback): void => {
        state.exitCallbacks.push(callback);
      },
    };
    child.onExit((code) => {
      state.exited = true;
      for (const callback of state.exitCallbacks) callback(code);
      for (const waiter of state.waiters.splice(0)) waiter();
    });
    child.onError(() => {
      state.exited = true;
      for (const callback of state.exitCallbacks) callback(1);
      for (const waiter of state.waiters.splice(0)) waiter();
    });
    this.states.set(tree, state);
    return tree;
  }

  public signalTree(tree: RuntimeProcessTree, signal: RuntimeTreeSignal): void {
    this.childFor(tree).kill(signal === "graceful" ? "SIGTERM" : "SIGKILL");
  }

  public async waitForCompleteTreeExit(
    tree: RuntimeProcessTree,
    timeoutMs: number,
  ): Promise<boolean> {
    const state = this.stateFor(tree);
    if (state.exited) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (reaped: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(reaped);
      };
      state.waiters.push(() => {
        finish(true);
      });
      this.timer.setTimer(() => {
        finish(state.exited);
      }, timeoutMs);
    });
  }

  public reconcileTreeExit(tree: RuntimeProcessTree): Promise<boolean> {
    return Promise.resolve(this.stateFor(tree).exited);
  }

  private stateFor(tree: RuntimeProcessTree): TestTreeState {
    const state = this.states.get(tree);
    if (state === undefined) throw new Error("runtime-tree-not-owned");
    return state;
  }

  private childFor(tree: RuntimeProcessTree): CodingRuntimeSpawnHandle {
    const child = (tree as RuntimeProcessTree & { child?: CodingRuntimeSpawnHandle }).child;
    if (child === undefined) throw new Error("runtime-child-not-owned");
    return child;
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function executable(root: string, name = "opencode-sidecar"): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

interface FakeChild {
  readonly handle: CodingRuntimeSpawnHandle;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kills: NodeJS.Signals[];
  exit(code?: number | null): void;
  error(error: Error): void;
}

function fakeChild(): FakeChild {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kills: NodeJS.Signals[] = [];
  let onExit: ((code: number | null) => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  return {
    stdout,
    stderr,
    kills,
    handle: {
      stdout,
      stderr,
      pid: 4242,
      kill: (signal): void => {
        kills.push(signal);
      },
      onExit: (callback): void => {
        onExit = callback;
      },
      onError: (callback): void => {
        onError = callback;
      },
    },
    exit: (code = 0): void => {
      onExit?.(code);
      stdout.end();
      stderr.end();
    },
    error: (error): void => {
      onError?.(error);
    },
  };
}

function launchRequest(
  workspaceRoot: string,
  managedRoot: string,
  executablePath: string,
): CodingRuntimeLaunchRequest {
  return {
    runId: "run-1988",
    treeBindingId: "c".repeat(64),
    taskRef: "issue-1988",
    adapterKind: "opencode-compatible",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    requestedMode: "supervised-coding",
    effectiveMode: "supervised-coding",
    workspaceRoot,
    executablePath,
    managedRoot,
    gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
    modelProfileId: "coding-safe-openai-compatible",
    args: ["--stdio"],
    inheritedEnvAllowlist: ["PATH"],
    shutdownTimeoutMs: 5,
    startTimeoutMs: 30_000,
    confinement: TEST_QUALIFICATION,
  };
}

function governedAssistRequest(
  workspaceRoot: string,
  managedRoot: string,
  executablePath: string,
): CodingRuntimeLaunchRequest {
  return {
    ...launchRequest(workspaceRoot, managedRoot, executablePath),
    runId: "run-1991",
    taskRef: "issue-1991",
    requestedMode: "governed-assist",
    effectiveMode: "governed-assist",
  };
}

function autonomousDeliveryRequest(
  workspaceRoot: string,
  managedRoot: string,
  executablePath: string,
): CodingRuntimeLaunchRequest {
  return {
    ...launchRequest(workspaceRoot, managedRoot, executablePath),
    runId: "run-1993",
    taskRef: "issue-1993",
    requestedMode: "autonomous-delivery",
    effectiveMode: "autonomous-delivery",
  };
}

function createManagedFixture(): {
  readonly workspaceRoot: string;
  readonly managedRoot: string;
  readonly executablePath: string;
} {
  const workspaceRoot = tempDir("keiko-runtime-workspace-");
  const managedRoot = tempDir("keiko-runtime-managed-");
  return { workspaceRoot, managedRoot, executablePath: executable(managedRoot) };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createPortableRuntimeFixture(): {
  readonly resourceRoot: string;
  readonly executablePath: string;
  readonly verification: PortableSidecarRuntimeVerification;
} {
  const resourceRoot = tempDir("keiko-runtime-resource-");
  const payloadRootPath = "runtime/sidecars/opencode-compatible";
  const payloadRoot = join(resourceRoot, payloadRootPath);
  const executablePath = executable(payloadRoot, "opencode-sidecar");
  writeFileSync(join(payloadRoot, "LICENSE"), "approved license\n");
  writeFileSync(join(payloadRoot, "sbom.cdx.json"), '{"bomFormat":"CycloneDX"}\n');
  const executableDigest = digest("#!/bin/sh\n");
  const licenseDigest = digest("approved license\n");
  const sbomDigest = digest('{"bomFormat":"CycloneDX"}\n');
  const executableTreeSha256 = digest(`opencode-sidecar\0${executableDigest}\0`);
  const payloadSha256 = digest(
    `LICENSE\0${licenseDigest}\0opencode-sidecar\0${executableDigest}\0sbom.cdx.json\0${sbomDigest}\0`,
  );
  return {
    resourceRoot,
    executablePath,
    verification: {
      payloadRootPath,
      executablePath: `${payloadRootPath}/opencode-sidecar`,
      shippedExecutableSha256: executableDigest,
      executableTreeSha256,
      licenseEvidencePath: `${payloadRootPath}/LICENSE`,
      licenseEvidenceSha256: licenseDigest,
      sbomEvidencePath: `${payloadRootPath}/sbom.cdx.json`,
      sbomEvidenceSha256: sbomDigest,
      protocolSchemaRawSha256: OPENCODE_SCHEMA_SHA256,
      protocolHandshakeDigest: OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256,
      protocolHandshakeAlgorithm: OPEN_CODE_PROTOCOL_SURFACE_ALGORITHM,
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
      summary: {
        name: "opencode-compatible",
        kind: "coding-runtime",
        upstreamName: "opencode",
        upstreamVersion: "1.17.17",
        adapterName: "keiko-coding-sidecar",
        adapterVersion: "1",
        protocolVersion: "http-sse",
        platformTarget: "windows-x64",
        payloadSha256,
        payloadSha256Prefix: payloadSha256.slice(0, 12),
        sizeBytes: 1,
        status: "verified",
      },
    },
  };
}

function createSpawnHarness(): {
  readonly spawn: CodingRuntimeSpawnFn;
  readonly children: FakeChild[];
  readonly captures: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly env: Record<string, string>;
    readonly cwd: string;
  }[];
} {
  const children: FakeChild[] = [];
  const captures: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly env: Record<string, string>;
    readonly cwd: string;
  }[] = [];
  const spawn: CodingRuntimeSpawnFn = (executablePath, args, env, cwd) => {
    const child = fakeChild();
    children.push(child);
    captures.push({ executable: executablePath, args, env, cwd });
    return child.handle;
  };
  return { spawn, children, captures };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface PermissionLineInput {
  readonly requestId: string;
  readonly kind: CodingWorkbenchPermissionRequestKind;
  readonly actionClass: CodingWorkbenchActionClass;
  readonly reasonCode: string;
  readonly actionKind?: string | undefined;
  readonly scopeLabel?: string | undefined;
  readonly risk?: string | undefined;
  readonly policyReason?: string | undefined;
  readonly commandLabel?: string | undefined;
  readonly connectorScopes?: readonly CodingWorkbenchConnectorScope[] | undefined;
  readonly targetPath?: string | undefined;
  readonly allowedRelativePaths?: readonly string[] | undefined;
  readonly fileCount?: number | undefined;
  readonly addedLines?: number | undefined;
  readonly deletedLines?: number | undefined;
  readonly executable?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly passedCount?: number | undefined;
  readonly failedCount?: number | undefined;
  readonly skippedCount?: number | undefined;
  readonly scopeDigest?: string | undefined;
  readonly approvalToken?: ApprovalClaimInput | undefined;
  readonly operatorStopped?: boolean | undefined;
}

interface ApprovalClaimInput {
  readonly approvalId: string;
  readonly approvalToken: string;
}

function permissionLine(input: PermissionLineInput): string {
  return `${JSON.stringify({
    type: "permission-request",
    expiresAt: "2026-07-07T13:05:00.000Z",
    ...input,
  })}\n`;
}

function pushPermissionLine(
  requestId: string,
  approvalToken?: ApprovalClaimInput,
  operatorStopped?: boolean,
): string {
  return permissionLine({
    requestId,
    kind: "delivery-substrate",
    actionClass: "delivery-substrate",
    reasonCode: "approval-required",
    actionKind: "push",
    scopeLabel: "workspace-scope",
    risk: "high",
    policyReason: "approval-required",
    commandLabel: "push",
    ...(approvalToken === undefined ? {} : { approvalToken }),
    ...(operatorStopped === undefined ? {} : { operatorStopped }),
  });
}

describe("coding runtime manager", () => {
  it("resolves launch paths from a verified portable sidecar payload", () => {
    const managedInstallRoot = tempDir("keiko-runtime-install-");
    const sidecarRoot = join(managedInstallRoot, "runtime", "sidecars", "opencode-adapter");
    const executablePath = executable(sidecarRoot);
    const sidecar: PortableSidecarRuntimeVerification = {
      payloadRootPath: "runtime/sidecars/opencode-adapter",
      executablePath: "runtime/sidecars/opencode-adapter/opencode-sidecar",
      shippedExecutableSha256: "e".repeat(64),
      executableTreeSha256: "d".repeat(64),
      licenseEvidencePath: "runtime/sidecars/opencode-adapter/LICENSE.evidence.json",
      licenseEvidenceSha256: "a".repeat(64),
      sbomEvidencePath: "runtime/sidecars/opencode-adapter/sbom.evidence.json",
      sbomEvidenceSha256: "b".repeat(64),
      protocolSchemaRawSha256: OPENCODE_SCHEMA_SHA256,
      protocolHandshakeDigest: OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256,
      protocolHandshakeAlgorithm: OPEN_CODE_PROTOCOL_SURFACE_ALGORITHM,
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
      summary: {
        name: "opencode-adapter",
        kind: "opencode-compatible",
        upstreamName: "opencode",
        upstreamVersion: "1.0.0",
        adapterName: "keiko-opencode-adapter",
        adapterVersion: "1.0.0",
        protocolVersion: "1",
        platformTarget: "macos-arm64",
        payloadSha256: "c".repeat(64),
        payloadSha256Prefix: "c".repeat(12),
        sizeBytes: 12,
        status: "verified",
      },
    };

    const result = resolveCodingRuntimeSidecarLaunchTarget(managedInstallRoot, sidecar, {
      target: "macos-arm64",
      qualificationVerified: true,
    });

    expect(result).toEqual({
      ok: true,
      target: {
        managedRoot: sidecarRoot,
        executablePath,
        runtimeName: "opencode-adapter",
        payloadSha256Prefix: "c".repeat(12),
      },
    });
  });

  it("blocks every sidecar request before supervisor spawn until #2256 provides server-owned provenance", () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      portableRuntimeResolver: undefined,
    });
    expect(
      manager.start(
        launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      ),
    ).toEqual({ ok: false, failureCode: "qualification-missing", retryable: false });
    expect(harness.children).toHaveLength(0);
  });

  it("launches only the resolver-owned executable when the request supplies another path", () => {
    const fixture = createManagedFixture();
    const unmanaged = executable(tempDir("keiko-runtime-unmanaged-"));
    const harness = createSpawnHarness();
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: { PATH: "/usr/bin", CODEX_ACCESS_TOKEN: "super-secret-token" },
    });

    const result = manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, unmanaged),
    );

    expect(result).toMatchObject({ ok: true });
    expect(harness.children).toHaveLength(1);
    expect(harness.captures[0]?.executable).not.toBe(unmanaged);
    expect(JSON.stringify(result)).not.toContain(fixture.managedRoot);
    expect(JSON.stringify(result)).not.toContain(unmanaged);
  });

  it("fails closed when OpenCode is paired with a Codex subscription profile", () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
    });
    const request: CodingRuntimeLaunchRequest = {
      ...launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      modelSource: "chatgpt-codex-subscription-profile",
    };

    const result = manager.start(request);

    expect(result).toEqual({
      ok: false,
      failureCode: "adapter-profile-mismatch",
      retryable: false,
    });
    expect(harness.children).toHaveLength(0);
  });

  it("keeps Codex unavailable without a reviewed bundled payload and never falls back globally", () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
    });

    expect(
      manager.start({
        ...launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
        adapterKind: "codex-cli",
        runtimeSource: "codex-cli-adapter",
        modelSource: "chatgpt-codex-subscription-profile",
      }),
    ).toEqual({ ok: false, failureCode: "redistribution-unapproved", retryable: false });
    expect(harness.children).toHaveLength(0);
  });

  it("rejects a tampered resolver-owned executable immediately before spawn", () => {
    const fixture = createManagedFixture();
    const portable = createPortableRuntimeFixture();
    const harness = createSpawnHarness();
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      portableRuntimeResolver: () => ({
        verification: portable.verification,
        resourceRoot: portable.resourceRoot,
        target: "windows-x64",
      }),
    });
    writeFileSync(portable.executablePath, "tampered executable\n");

    expect(
      manager.start(
        launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      ),
    ).toEqual({
      ok: false,
      failureCode: "archive-digest-mismatch",
      retryable: false,
    });
    expect(harness.children).toHaveLength(0);
  });

  it("rejects a stale shipped executable digest immediately before spawn", () => {
    const fixture = createManagedFixture();
    const portable = createPortableRuntimeFixture();
    const harness = createSpawnHarness();
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      portableRuntimeResolver: () => ({
        verification: {
          ...portable.verification,
          shippedExecutableSha256: "9".repeat(64),
        },
        resourceRoot: portable.resourceRoot,
        target: "windows-x64",
      }),
    });

    expect(
      manager.start(
        launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      ),
    ).toEqual({
      ok: false,
      failureCode: "executable-tree-digest-mismatch",
      retryable: false,
    });
    expect(harness.children).toHaveLength(0);
  });

  it("rejects a tampered resolver-owned payload immediately before spawn", () => {
    const fixture = createManagedFixture();
    const portable = createPortableRuntimeFixture();
    const harness = createSpawnHarness();
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      portableRuntimeResolver: () => ({
        verification: portable.verification,
        resourceRoot: portable.resourceRoot,
        target: "windows-x64",
      }),
    });
    writeFileSync(
      join(portable.resourceRoot, portable.verification.licenseEvidencePath),
      "tampered\n",
    );

    expect(
      manager.start(
        launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      ),
    ).toEqual({ ok: false, failureCode: "archive-digest-mismatch", retryable: false });
    expect(harness.children).toHaveLength(0);
  });

  it("starts a managed sidecar with only allowlisted inherited env and runtime projection", () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "provider-secret-key",
        CODEX_ACCESS_TOKEN: "subscription-secret-token",
      },
    });

    const result = manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );

    expect(result).toMatchObject({ ok: true, runId: "run-1988", status: "ready" });
    expect(manager.health()).toMatchObject({ status: "ready", activeRunId: "run-1988" });
    expect(harness.captures).toHaveLength(1);
    expect(harness.captures[0]?.env).toMatchObject({
      PATH: "/usr/bin",
      KEIKO_CODING_RUN_ID: "run-1988",
      KEIKO_CODING_TASK_REF: "issue-1988",
      KEIKO_CODING_ADAPTER_KIND: "opencode-compatible",
      KEIKO_CODING_RUNTIME_SOURCE: "keiko-sidecar",
      KEIKO_CODING_MODEL_SOURCE: "keiko-model-gateway",
      KEIKO_CODING_MODE: "supervised-coding",
      KEIKO_CODING_WORKSPACE_ROOT: fixture.workspaceRoot,
      KEIKO_MODEL_GATEWAY_URL: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
      KEIKO_MODEL_PROFILE_ID: "coding-safe-openai-compatible",
    });
    expect(Object.values(harness.captures[0]?.env ?? {})).not.toContain("provider-secret-key");
    expect(Object.values(harness.captures[0]?.env ?? {})).not.toContain(
      "subscription-secret-token",
    );
  });

  it("emits a content-free diagnostic when a runtime event fails validation", () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const diagnostics = { record: vi.fn() };
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      now: () => Date.parse("2026-07-07T13:00:00.000Z"),
      nowIso: () => "not-an-iso-instant",
      diagnostics,
      onRuntimeEvent: (event) => {
        events.push(event);
      },
    });

    const result = manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );

    expect(result).toMatchObject({ ok: true, runId: "run-1988", status: "ready" });
    expect(events).toHaveLength(0);
    expect(diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "run-1988",
        timestamp: "2026-07-07T13:00:00.000Z",
        operation: "coding-runtime.emit",
        source: "coding-runtime-manager.emit",
        errorClass: "InvalidRuntimeEvent",
        message: "runtime-event-invalid:runtime-started",
      }),
    );
    expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain(fixture.workspaceRoot);
  });

  it("actively drains high-volume runtime stderr without emitting it or blocking reap", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const diagnostics = { record: vi.fn() };
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      diagnostics,
      onRuntimeEvent: (event) => {
        events.push(event);
      },
    });

    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    const child = harness.children[0];
    if (child === undefined) throw new Error("runtime-child-not-spawned");
    const stderrPayload = "stderr-sentinel-2251\\n".repeat(4096);
    for (let index = 0; index < 16; index += 1) child.stderr.write(stderrPayload);
    await settle();

    expect(child.stderr.readableLength).toBe(0);
    expect(child.stderr.writableLength).toBe(0);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("stderr-sentinel-2251");
    expect(diagnostics.record).not.toHaveBeenCalled();

    const stopped = manager.stop("run-1988");
    child.exit(0);
    await expect(stopped).resolves.toEqual({ ok: true, status: "stopped" });
  });

  it("rejects non-loopback gateway URLs before spawn", () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
    });
    const request = {
      ...launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      gatewayUrl: "https://provider.example/v1",
    };

    const result = manager.start(request);

    expect(result).toEqual({
      ok: false,
      failureCode: "gateway-non-loopback",
      retryable: false,
    });
    expect(harness.children).toHaveLength(0);
  });

  it("performs zero spawn under the production-default unqualified supervisor", () => {
    const fixture = createManagedFixture();
    const manager = createTestCodingRuntimeManager({ processEnv: {} });

    expect(
      manager.start(
        launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      ),
    ).toEqual({ ok: false, failureCode: "runtime-unqualified", retryable: false });
    expect(manager.health()).toEqual({ status: "stopped" });
  });

  it("fails closed before signalling when the mandatory revocation barrier denies", async () => {
    const fixture = createManagedFixture();
    const portable = createPortableRuntimeFixture();
    const harness = createSpawnHarness();
    const manager = createProductionCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      revokeRuntime: (): false => false,
      abortInFlightActions: (): true => true,
      markRuntimeRecoveryRequired: (): true => true,
      releaseRuntimeAfterReap: (): true => true,
      portableRuntimeResolver: () => ({
        verification: portable.verification,
        resourceRoot: portable.resourceRoot,
        target: "windows-x64",
      }),
    });

    expect(
      manager.start(
        launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      ),
    ).toMatchObject({ ok: true });
    await expect(manager.stop("run-1988")).resolves.toEqual({
      ok: false,
      failureCode: "runtime-reap-unproven",
      retryable: false,
    });
    expect(harness.children[0]?.kills).toEqual([]);
    expect(manager.health()).toMatchObject({ status: "recovery-required" });
  });

  it("stops the active sidecar and allows a clean restart", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
    });

    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    const stop = manager.stop("run-1988");
    harness.children[0]?.exit(0);
    await stop;
    const restart = manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );

    expect(harness.children[0]?.kills).toEqual(["SIGTERM"]);
    expect(manager.health()).toMatchObject({ status: "ready", activeRunId: "run-1988" });
    expect(restart).toMatchObject({ ok: true, status: "ready" });
    expect(harness.children).toHaveLength(2);
  });

  it("revokes and proves tree exit before releasing a crashed runtime", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const revokeRuntime = vi.fn(() => true);
    const abortInFlightActions = vi.fn(() => true);
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      revokeRuntime,
      abortInFlightActions,
    });

    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.exit(1);
    await settle();

    expect(revokeRuntime).toHaveBeenCalledWith("run-1988");
    expect(abortInFlightActions).toHaveBeenCalledWith("run-1988");
    expect(harness.children[0]?.kills).toEqual(["SIGTERM"]);
    expect(manager.health()).toEqual({ status: "stopped" });
    expect(
      manager.start(
        launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      ),
    ).toMatchObject({ ok: true, status: "ready" });
    expect(harness.children).toHaveLength(2);
  });

  it("releases an unexpected clean exit only after revocation and tree-exit proof", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const revokeRuntime = vi.fn(() => true);
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      revokeRuntime,
    });

    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.exit(0);
    await settle();

    expect(revokeRuntime).toHaveBeenCalledWith("run-1988");
    expect(harness.children[0]?.kills).toEqual(["SIGTERM"]);
    expect(manager.health()).toEqual({ status: "stopped" });
  });

  it("normalizes permission requests from the sidecar stream into content-free runtime events", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.stdout.write(
      `${JSON.stringify({
        type: "permission-request",
        requestId: "perm-1988",
        kind: "command-execution",
        actionClass: "command-execution",
        reasonCode: "command-execution",
        commandLabel: "npm",
        expiresAt: "2026-07-07T13:05:00.000Z",
      })}\n`,
    );
    await settle();

    const permissionEvent = events.find((event) => event.kind === "permission-requested");
    expect(permissionEvent).toMatchObject({
      schemaVersion: "1",
      runId: "run-1988",
      kind: "permission-requested",
      permissionRequest: {
        requestId: "perm-1988",
        kind: "command-execution",
        actionClass: "command-execution",
        reasonCode: "command-execution",
        commandLabel: "npm",
      },
    });
    expect(validateCodingWorkbenchRuntimeEvent(permissionEvent).ok).toBe(true);
    expect(JSON.stringify(permissionEvent)).not.toContain(fixture.workspaceRoot);
  });

  it("carries Supervised Coding prompt metadata through permission events", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-push",
        kind: "delivery-substrate",
        actionClass: "delivery-substrate",
        reasonCode: "approval-required",
        actionKind: "push",
        scopeLabel: "workspace-scope",
        risk: "high",
        policyReason: "approval-required",
        scopeDigest: "a".repeat(64),
      }),
    );
    await settle();

    const permissionEvent = events.find((event) => event.kind === "permission-requested");
    expect(permissionEvent).toMatchObject({
      permissionRequest: {
        requestId: "perm-1992-push",
        actionKind: "push",
        scopeLabel: "workspace-scope",
        risk: "high",
        policyReason: "approval-required",
      },
    });
    expect(validateCodingWorkbenchRuntimeEvent(permissionEvent).ok).toBe(true);
    expect(JSON.stringify(permissionEvent)).not.toMatch(/diff --git|stdout|stderr|\/tmp/u);
  });

  it("enforces supervised file-edit scope before emitting a runtime event", async () => {
    const fixture = createManagedFixture();
    mkdirSync(join(fixture.workspaceRoot, "src"), { recursive: true });
    writeFileSync(join(fixture.workspaceRoot, "src", "allowed.ts"), "export const ok = true;\n");
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-file-accepted",
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "scoped-file-edit",
        actionKind: "file-edit",
        scopeLabel: "workspace-scope",
        risk: "medium",
        policyReason: "scoped-file-edit",
        targetPath: "src/allowed.ts",
        allowedRelativePaths: ["src"],
        fileCount: 1,
        addedLines: 2,
        deletedLines: 0,
      }),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-file-denied",
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "scoped-file-edit",
        actionKind: "file-edit",
        scopeLabel: "workspace-scope",
        risk: "medium",
        policyReason: "scoped-file-edit",
        targetPath: "../escape.ts",
        allowedRelativePaths: ["src"],
        fileCount: 1,
        addedLines: 2,
        deletedLines: 0,
      }),
    );
    await settle();

    expect(events.find((event) => event.kind === "diff-summarized")).toMatchObject({
      fileCount: 1,
      addedLines: 2,
      deletedLines: 0,
    });
    expect(events.find((event) => event.failureCode === "out-of-scope-file-edit")).toMatchObject({
      kind: "failure-redacted",
      failureSummary: "out-of-scope-file-edit",
      retryable: false,
    });
    expect(events.some((event) => event.kind === "permission-requested")).toBe(false);
    expect(JSON.stringify(events)).not.toContain(fixture.workspaceRoot);
  });

  it("enforces supervised verification command allowlist before emitting summaries", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-verification-command-accepted",
        kind: "command-execution",
        actionClass: "command-execution",
        reasonCode: "allowlisted-verification-command",
        actionKind: "verification-command",
        scopeLabel: "workspace-scope",
        risk: "low",
        policyReason: "allowlisted-verification-command",
        commandLabel: "verification-command",
        executable: "npm",
        args: ["run", "typecheck"],
        passedCount: 12,
        failedCount: 0,
        skippedCount: 0,
      }),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-verification-command-denied",
        kind: "command-execution",
        actionClass: "command-execution",
        reasonCode: "allowlisted-verification-command",
        actionKind: "verification-command",
        scopeLabel: "workspace-scope",
        risk: "high",
        policyReason: "allowlisted-verification-command",
        commandLabel: "commit",
        executable: "git",
        args: ["commit"],
      }),
    );
    await settle();

    expect(events.find((event) => event.kind === "verification-summarized")).toMatchObject({
      verificationKind: "verification-command",
      verificationStatus: "passed",
      passedCount: 12,
      failedCount: 0,
      skippedCount: 0,
    });
    expect(events.find((event) => event.failureCode === "mutating-command-denied")).toMatchObject({
      kind: "failure-redacted",
      failureSummary: "mutating-command-denied",
      retryable: false,
    });
    expect(events.some((event) => event.kind === "permission-requested")).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/stdout|stderr|npm run typecheck/u);
  });

  it("enforces supervised delivery approval provenance before allowing mutations", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      now: () => 1_000,
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    const issued = manager.issueApproval({
      runId: "run-1988",
      requestId: "perm-1992-push-accepted",
      actionKind: "push",
      approvedByUserId: "operator",
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("expected approval issue to succeed");
    const forged = {
      approvalId: "sca_forgedapproval000000000000000000",
      approvalToken: "f".repeat(64),
    };

    harness.children[0]?.stdout.write(pushPermissionLine("perm-1992-push-missing"));
    harness.children[0]?.stdout.write(pushPermissionLine("perm-1992-push-stale", forged));
    harness.children[0]?.stdout.write(
      pushPermissionLine("perm-1992-push-stopped", undefined, true),
    );
    harness.children[0]?.stdout.write(
      pushPermissionLine("perm-1992-push-accepted", issued.approval),
    );
    harness.children[0]?.stdout.write(
      pushPermissionLine("perm-1992-push-accepted", issued.approval),
    );
    await settle();

    expect(events.find((event) => event.kind === "permission-requested")).toMatchObject({
      permissionRequest: {
        requestId: "perm-1992-push-missing",
        actionKind: "push",
        policyReason: "approval-required",
      },
    });
    const staleFailures = events.filter((event) => event.failureCode === "approval-proof-stale");
    expect(staleFailures).toHaveLength(2);
    expect(events.find((event) => event.failureCode === "operator-stopped")).toMatchObject({
      kind: "failure-redacted",
      failureSummary: "operator-stopped",
      retryable: false,
    });
    expect(events.find((event) => event.kind === "artifact-produced")).toMatchObject({
      artifactKind: "approval",
      artifactLabel: "approval-proof-accepted",
      artifactDigest: issued.approvalDigest,
      artifactBytes: 0,
    });
    expect(JSON.stringify(events)).not.toContain(issued.approval.approvalToken);
  });

  it("binds supervised approvals to manager-computed action and connector scope", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      now: () => 1_000,
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    const pushApproval = manager.issueApproval({
      runId: "run-1988",
      requestId: "perm-1992-push-merge",
      actionKind: "push",
      approvedByUserId: "operator",
    });
    const externalApproval = manager.issueApproval({
      runId: "run-1988",
      requestId: "perm-1992-external-write-source-control",
      actionKind: "external-write",
      connectorScopes: ["issue-tracker.write"],
      approvedByUserId: "operator",
    });
    expect(pushApproval.ok).toBe(true);
    expect(externalApproval.ok).toBe(true);
    if (!pushApproval.ok || !externalApproval.ok) throw new Error("expected approvals");

    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-push-merge",
        kind: "delivery-substrate",
        actionClass: "delivery-substrate",
        reasonCode: "approval-required",
        actionKind: "merge",
        scopeLabel: "workspace-scope",
        risk: "critical",
        policyReason: "approval-required",
        commandLabel: "merge",
        approvalToken: pushApproval.approval,
      }),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-external-write-source-control",
        kind: "connector-access",
        actionClass: "connector-access",
        reasonCode: "approval-required",
        actionKind: "external-write",
        scopeLabel: "workspace-scope",
        risk: "high",
        policyReason: "approval-required",
        commandLabel: "external-write",
        connectorScopes: ["source-control.write"],
        approvalToken: externalApproval.approval,
      }),
    );
    await settle();

    const staleFailures = events.filter((event) => event.failureCode === "approval-proof-stale");
    expect(staleFailures).toHaveLength(2);
    expect(events.some((event) => event.kind === "artifact-produced")).toBe(false);
    expect(JSON.stringify(events)).not.toContain(pushApproval.approval.approvalToken);
    expect(JSON.stringify(events)).not.toContain(externalApproval.approval.approvalToken);
  });

  it("suppresses post-stop sidecar mutation events from manager-owned stop state", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const timers: (() => void)[] = [];
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn, {
        setTimer: (callback): unknown => {
          timers.push(callback);
          return undefined;
        },
      }),
      processEnv: {},
      now: () => 1_000,
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    const issued = manager.issueApproval({
      runId: "run-1988",
      requestId: "perm-1992-push-stopped",
      actionKind: "push",
      approvedByUserId: "operator",
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("expected approval issue to succeed");

    const stopping = manager.stop("run-1988");
    expect(
      manager.issueApproval({
        runId: "run-1988",
        requestId: "perm-1992-push-stopped",
        actionKind: "push",
        approvedByUserId: "operator",
      }),
    ).toEqual({ ok: false, failureCode: "runtime-stopped", retryable: false });
    harness.children[0]?.stdout.write(
      pushPermissionLine("perm-1992-push-stopped", issued.approval),
    );
    await settle();

    expect(events.some((event) => event.kind === "artifact-produced")).toBe(false);
    expect(events.some((event) => event.failureCode === "approval-proof-accepted")).toBe(false);
    timers[0]?.();
    await settle();
    timers[1]?.();
    await stopping;
    expect(harness.children[0]?.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(manager.health()).toMatchObject({ status: "recovery-required" });
  });

  it("fails closed for mismatched supervised sidecar permission metadata", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-push-workspace-write",
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "approval-required",
        actionKind: "push",
        scopeLabel: "workspace-scope",
        risk: "high",
        policyReason: "approval-required",
        scopeDigest: "a".repeat(64),
      }),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1992-external-write-connector-read-scope",
        kind: "connector-access",
        actionClass: "connector-access",
        reasonCode: "approval-required",
        actionKind: "external-write",
        scopeLabel: "workspace-scope",
        risk: "high",
        policyReason: "approval-required",
        connectorScopes: ["issue-tracker.read"],
        scopeDigest: "a".repeat(64),
      }),
    );
    await settle();

    const failures = events.filter((event) => event.failureSummary === "sidecar-event-denied");
    expect(failures).toHaveLength(2);
    expect(events.some((event) => event.kind === "permission-requested")).toBe(false);
  });

  it.each([
    {
      kind: "workspace-write",
      actionClass: "workspace-write",
    },
    {
      kind: "command-execution",
      actionClass: "command-execution",
      commandLabel: "npm",
    },
    {
      kind: "network-egress",
      actionClass: "network-egress",
    },
    {
      kind: "delivery-substrate",
      actionClass: "delivery-substrate",
    },
  ] as const)(
    "surfaces governed-assist $actionClass sidecar approval requests without blanket denial",
    async ({ kind, actionClass, commandLabel }) => {
      const fixture = createManagedFixture();
      const harness = createSpawnHarness();
      const events: CodingWorkbenchRuntimeEvent[] = [];
      const manager = createTestCodingRuntimeManager({
        supervisor: testSupervisor(harness.spawn),
        processEnv: {},
        onRuntimeEvent: (event) => {
          events.push(event);
        },
        nowIso: () => "2026-07-07T13:00:00.000Z",
      });

      await manager.start(
        governedAssistRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      );
      harness.children[0]?.stdout.write(
        permissionLine({
          requestId: "perm-1991-policy",
          kind,
          actionClass,
          reasonCode: "permission-requested",
          commandLabel,
        }),
      );
      await settle();

      const permissionEvent = events.find((event) => event.kind === "permission-requested");
      expect(permissionEvent).toMatchObject({
        schemaVersion: "1",
        runId: "run-1991",
        kind: "permission-requested",
        permissionRequest: {
          requestId: "perm-1991-policy",
          kind,
          actionClass,
        },
      });
      expect(events.some((event) => event.failureSummary === `${actionClass}-denied`)).toBe(false);
      expect(validateCodingWorkbenchRuntimeEvent(permissionEvent).ok).toBe(true);
      expect(JSON.stringify(permissionEvent)).not.toContain(fixture.workspaceRoot);
    },
  );

  it("keeps valid governed-assist connector scopes approvable but rejects malformed scopes", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    await manager.start(
      governedAssistRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1991-connector-read",
        kind: "connector-access",
        actionClass: "connector-access",
        reasonCode: "connector-access-requested",
        connectorScopes: ["issue-tracker.read"],
      }),
    );
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1991-connector-write",
        kind: "connector-access",
        actionClass: "connector-access",
        reasonCode: "connector-access-requested",
        connectorScopes: ["source-control.write"],
      }),
    );
    harness.children[0]?.stdout.write(
      `${JSON.stringify({
        type: "permission-request",
        requestId: "perm-1991-connector-malformed",
        kind: "connector-access",
        actionClass: "connector-access",
        reasonCode: "connector-access-requested",
        expiresAt: "2026-07-07T13:05:00.000Z",
        connectorScopes: ["source-control.write", "unexpected.write"],
      })}\n`,
    );
    await settle();

    const permissionEvents = events.filter((event) => event.kind === "permission-requested");
    expect(permissionEvents).toHaveLength(2);
    expect(permissionEvents.map((event) => event.permissionRequest)).toEqual([
      expect.objectContaining({
        requestId: "perm-1991-connector-read",
        connectorScopes: ["issue-tracker.read"],
      }),
      expect.objectContaining({
        requestId: "perm-1991-connector-write",
        connectorScopes: ["source-control.write"],
      }),
    ]);
    expect(events.find((event) => event.failureSummary === "sidecar-event-denied")).toMatchObject({
      kind: "failure-redacted",
      failureCode: "failure-redacted",
      retryable: false,
    });
  });

  it("fails closed for autonomous sidecar mutations outside the server delivery executor", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn),
      processEnv: {},
      onRuntimeEvent: (event) => {
        events.push(event);
      },
      nowIso: () => "2026-07-07T13:00:00.000Z",
    });

    await manager.start(
      autonomousDeliveryRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    harness.children[0]?.stdout.write(pushPermissionLine("perm-1993-push-denied"));
    harness.children[0]?.stdout.write(
      permissionLine({
        requestId: "perm-1993-connector-write-denied",
        kind: "connector-access",
        actionClass: "connector-access",
        reasonCode: "approval-required",
        actionKind: "connector-write",
        scopeLabel: "workspace-scope",
        risk: "high",
        policyReason: "approval-required",
        commandLabel: "connector-write",
        connectorScopes: ["issue-tracker.write"],
      }),
    );
    harness.children[0]?.stdout.write(
      pushPermissionLine("perm-1993-push-stopped", undefined, true),
    );
    await settle();

    expect(events.filter((event) => event.failureCode === "delivery-denied")).toHaveLength(2);
    expect(events.find((event) => event.failureCode === "operator-stopped")).toMatchObject({
      kind: "failure-redacted",
      failureSummary: "operator-stopped",
      retryable: false,
    });
    expect(events.some((event) => event.kind === "permission-requested")).toBe(false);
  });

  it("escalates stop to SIGKILL when the sidecar misses the shutdown deadline", async () => {
    const fixture = createManagedFixture();
    const harness = createSpawnHarness();
    const setTimer = vi.fn((callback: () => void): unknown => {
      callback();
      return undefined;
    });
    const manager = createTestCodingRuntimeManager({
      supervisor: testSupervisor(harness.spawn, { setTimer }),
      processEnv: {},
    });

    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    const result = await manager.stop("run-1988");

    expect(harness.children[0]?.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result).toEqual({
      ok: false,
      failureCode: "runtime-reap-unproven",
      retryable: false,
    });
    expect(manager.health()).toEqual({
      status: "recovery-required",
      activeRunId: "run-1988",
      failureCode: "runtime-reap-unproven",
      restartDenied: true,
    });
    expect(
      manager.start(
        launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      ),
    ).toMatchObject({ ok: false, failureCode: "runtime-already-running" });
    harness.children[0]?.exit(0);
    await expect(manager.reconcile("run-1988")).resolves.toEqual({ ok: true, status: "stopped" });
  });

  it("takeover revokes, invalidates approvals, and aborts actions before signalling", async () => {
    const fixture = createManagedFixture();
    const child = fakeChild();
    const order: string[] = [];
    const approvals = createInMemorySupervisedCodingApprovalStore();
    const approvalStore = {
      ...approvals,
      invalidateRun: (runId: string): void => {
        order.push(`invalidate:${runId}`);
        approvals.invalidateRun(runId);
      },
    };
    const manager = createTestCodingRuntimeManager({
      processEnv: {},
      approvalStore,
      supervisor: testSupervisor(() => ({
        ...child.handle,
        kill: (signal): void => {
          order.push(`signal:${signal}`);
          child.kills.push(signal);
          child.exit(0);
        },
      })),
      revokeRuntime: (runId): true => {
        order.push(`revoke:${runId}`);
        return true;
      },
      abortInFlightActions: (runId): true => {
        order.push(`abort:${runId}`);
        return true;
      },
      releaseRuntimeAfterReap: (runId, receipt): true => {
        expect(verifyRuntimeReapReceipt(receipt, runId, "c".repeat(64))).toBe(true);
        order.push(`release:${runId}`);
        return true;
      },
    });
    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );

    await manager.takeover("run-1988");

    expect(order).toEqual([
      "revoke:run-1988",
      "invalidate:run-1988",
      "abort:run-1988",
      "signal:SIGTERM",
      "release:run-1988",
    ]);
  });

  it.each(["stop", "takeover"] as const)(
    "%s awaits the injected in-flight action abort before any process-tree signal",
    async (operation) => {
      const fixture = createManagedFixture();
      const child = fakeChild();
      const order: string[] = [];
      let releaseAbort: (() => void) | undefined;
      const manager = createTestCodingRuntimeManager({
        processEnv: {},
        supervisor: testSupervisor(() => ({
          ...child.handle,
          kill: (signal): void => {
            order.push(`signal:${signal}`);
            child.kills.push(signal);
            child.exit(0);
          },
        })),
        revokeRuntime: (runId): true => {
          order.push(`revoke:${runId}`);
          return true;
        },
        abortInFlightActions: async (runId): Promise<boolean> => {
          order.push(`abort:${runId}`);
          await new Promise<void>((resolve) => {
            releaseAbort = resolve;
          });
          order.push(`aborted:${runId}`);
          return true;
        },
      });
      await manager.start(
        launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      );

      const stopping =
        operation === "stop" ? manager.stop("run-1988") : manager.takeover("run-1988");
      await vi.waitFor(() => {
        expect(order).toEqual(["revoke:run-1988", "abort:run-1988"]);
      });
      expect(child.kills).toEqual([]);
      if (releaseAbort !== undefined) releaseAbort();

      await expect(stopping).resolves.toEqual({ ok: true, status: "stopped" });
      expect(order).toEqual([
        "revoke:run-1988",
        "abort:run-1988",
        "aborted:run-1988",
        "signal:SIGTERM",
      ]);
    },
  );

  it("does not report ready until the injected OpenCode lifecycle handshake completes", async () => {
    const fixture = createManagedFixture();
    const child = fakeChild();
    let releaseReady: (() => void) | undefined;
    const handshake = vi.fn(
      () =>
        new Promise<{ readonly ok: true }>((resolve) => {
          releaseReady = (): void => {
            resolve({ ok: true });
          };
        }),
    );
    const manager = createTestCodingRuntimeManager({
      processEnv: {},
      supervisor: testSupervisor(() => child.handle),
      openCodeLifecycleAdapter: { handshake },
    });

    let settled = false;
    const starting = Promise.resolve(
      manager.start(
        launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      ),
    ).finally(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(handshake).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(manager.health()).toMatchObject({ status: "starting", activeRunId: "run-1988" });
    releaseReady?.();
    await expect(starting).resolves.toEqual({ ok: true, runId: "run-1988", status: "ready" });
  });

  it("prepares the fixed OpenCode invocation before spawn and never forwards caller arguments", async () => {
    const fixture = createManagedFixture();
    const child = fakeChild();
    let spawnedArgs: readonly string[] | undefined;
    const manager = createTestCodingRuntimeManager({
      processEnv: { PATH: "/safe/bin" },
      supervisor: testSupervisor((_, args) => {
        spawnedArgs = args;
        return child.handle;
      }),
      openCodeLifecycleAdapter: {
        handshake: vi.fn(() => Promise.resolve({ ok: true })),
      },
    } as never);

    const request = {
      ...launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      args: ["--caller-supplied-open-code-argument"],
    };

    await expect(manager.start(request)).resolves.toMatchObject({ ok: true });
    expect(spawnedArgs).not.toContain("--caller-supplied-open-code-argument");
  });

  it("preserves manager-owned run and gateway env while accepting server launch isolation", async () => {
    const fixture = createManagedFixture();
    const child = fakeChild();
    let spawnedEnv: Record<string, string> | undefined;
    const manager = createTestCodingRuntimeManager({
      processEnv: { PATH: "/safe/bin", HOME: "/caller/home" },
      supervisor: testSupervisor((_executable, _args, env) => {
        spawnedEnv = env;
        return child.handle;
      }),
      openCodeLifecycleAdapter: {
        prepare: () =>
          Promise.resolve({
            ok: true,
            env: {
              HOME: "/server/run/home",
              KEIKO_MODEL_GATEWAY_URL: "http://127.0.0.1:9/hostile",
              KEIKO_MODEL_PROFILE_ID: "hostile-profile",
              KEIKO_CODING_RUN_ID: "hostile-run",
            },
          }),
        handshake: () => Promise.resolve({ ok: true }),
      },
    });

    await expect(
      manager.start(
        launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(spawnedEnv).toMatchObject({
      HOME: "/server/run/home",
      KEIKO_MODEL_GATEWAY_URL: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
      KEIKO_MODEL_PROFILE_ID: "coding-safe-openai-compatible",
      KEIKO_CODING_RUN_ID: "run-1988",
    });
  });

  it("uses OpenCode stdout only for startup then drains without legacy event parsing", async () => {
    const fixture = createManagedFixture();
    const child = fakeChild();
    const events: CodingWorkbenchRuntimeEvent[] = [];
    const manager = createTestCodingRuntimeManager({
      processEnv: {},
      onRuntimeEvent: (event): void => {
        events.push(event);
      },
      supervisor: testSupervisor(() => child.handle),
      openCodeLifecycleAdapter: {
        handshake: async ({ startupOutput }) => {
          await startupOutput.nextLine();
          return { ok: true } as const;
        },
      },
    });
    const starting = manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    child.stdout.write("opencode server listening on http://127.0.0.1:43123\n");
    await expect(starting).resolves.toMatchObject({ ok: true });
    child.stdout.write('{"level":"info","message":"runtime log"}\n');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events.filter((event) => event.kind === "failure-redacted")).toEqual([]);
  });

  it("revokes and proves complete-tree reap when OpenCode readiness fails", async () => {
    const fixture = createManagedFixture();
    const child = fakeChild();
    const order: string[] = [];
    const manager = createTestCodingRuntimeManager({
      processEnv: {},
      supervisor: testSupervisor(() => ({
        ...child.handle,
        kill: (signal): void => {
          order.push(`signal:${signal}`);
          child.kills.push(signal);
          child.exit(0);
        },
      })),
      openCodeLifecycleAdapter: {
        handshake: vi.fn(() => Promise.resolve({ ok: false, reason: "gateway-handshake-failed" })),
      },
      revokeRuntime: (runId): true => {
        order.push(`revoke:${runId}`);
        return true;
      },
      abortInFlightActions: (runId): true => {
        order.push(`abort:${runId}`);
        return true;
      },
      releaseRuntimeAfterReap: (runId, receipt): true => {
        expect(verifyRuntimeReapReceipt(receipt, runId, "c".repeat(64))).toBe(true);
        order.push(`release:${runId}`);
        return true;
      },
    });

    await expect(
      manager.start(
        launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(order).toEqual([
      "revoke:run-1988",
      "abort:run-1988",
      "signal:SIGTERM",
      "release:run-1988",
    ]);
    expect(manager.health()).toEqual({ status: "stopped" });
  });

  it("aborts the adapter-visible handshake signal on timeout and rejects a late ready result", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createManagedFixture();
      const child = fakeChild();
      let observedSignal: AbortSignal | undefined;
      let resolveHandshake: ((result: { readonly ok: true }) => void) | undefined;
      const manager = createTestCodingRuntimeManager({
        processEnv: {},
        supervisor: testSupervisor(() => ({
          ...child.handle,
          kill: (signal): void => {
            child.kills.push(signal);
            child.exit(0);
          },
        })),
        openCodeLifecycleAdapter: {
          handshake: ({ signal }) => {
            observedSignal = signal;
            return new Promise<{ readonly ok: true }>((resolve) => {
              resolveHandshake = resolve;
            });
          },
        },
      });

      const starting = Promise.resolve(
        manager.start({
          ...launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
          startTimeoutMs: 50,
        }),
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);

      await expect(starting).resolves.toEqual({
        ok: false,
        failureCode: "start-timeout",
        retryable: true,
      });
      expect(observedSignal?.aborted).toBe(true);
      resolveHandshake?.({ ok: true });
      await Promise.resolve();
      expect(manager.health()).toEqual({ status: "stopped" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a post-ready lifecycle monitor failure as a fail-closed stop", async () => {
    const fixture = createManagedFixture();
    const child = fakeChild();
    const revokeRuntime = vi.fn(() => true);
    const abortInFlightActions = vi.fn(() => true);
    const events: CodingWorkbenchRuntimeEvent[] = [];
    let failMonitor: (() => void) | undefined;
    const monitor = vi.fn(
      ({ onFailure }: { readonly runId: string; readonly onFailure: () => void }): (() => void) => {
        failMonitor = onFailure;
        return (): void => undefined;
      },
    );
    const manager = createTestCodingRuntimeManager({
      processEnv: {},
      onRuntimeEvent: (event): void => {
        events.push(event);
      },
      supervisor: testSupervisor(() => ({
        ...child.handle,
        kill: (signal): void => {
          child.kills.push(signal);
          child.exit(0);
        },
      })),
      revokeRuntime,
      abortInFlightActions,
      openCodeLifecycleAdapter: {
        handshake: vi.fn(() => Promise.resolve({ ok: true })),
        // #2254 lifecycle monitor contract: failures after ready must route through manager stop.
        monitor,
      } as never,
    });

    await expect(
      manager.start(
        launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
      ),
    ).resolves.toMatchObject({ ok: true, status: "ready" });
    expect(monitor).toHaveBeenCalledOnce();
    const [monitorInput] = monitor.mock.calls[0] ?? [];
    expect(monitorInput?.runId).toBe("run-1988");
    expect(typeof monitorInput?.onFailure).toBe("function");
    failMonitor?.();
    await vi.waitFor(() => {
      expect(revokeRuntime).toHaveBeenCalledWith("run-1988");
      expect(abortInFlightActions).toHaveBeenCalledWith("run-1988");
      expect(manager.health()).toEqual({ status: "stopped" });
    });
    const terminalEvents = events.filter(
      (event) => event.kind === "failure-redacted" || event.kind === "runtime-stopped",
    );
    expect(terminalEvents.map((event) => event.kind)).toEqual([
      "failure-redacted",
      "runtime-stopped",
    ]);
    expect(terminalEvents[0]).toMatchObject({
      failureCode: "failure-redacted",
      failureSummary: "runtime-event-failed",
      retryable: false,
    });
    expect(validateCodingWorkbenchRuntimeEvent(terminalEvents[0]).ok).toBe(true);
    expect(JSON.stringify(terminalEvents[0])).not.toContain(fixture.workspaceRoot);
  });

  it("disposes adapter state only after authentic reap and before authority release", async () => {
    const fixture = createManagedFixture();
    const child = fakeChild();
    const order: string[] = [];
    const manager = createTestCodingRuntimeManager({
      processEnv: {},
      supervisor: testSupervisor(() => ({
        ...child.handle,
        kill: (signal): void => {
          order.push(`signal:${signal}`);
          child.kills.push(signal);
          child.exit(0);
        },
      })),
      revokeRuntime: (runId): true => {
        order.push(`revoke:${runId}`);
        return true;
      },
      abortInFlightActions: (runId): true => {
        order.push(`abort:${runId}`);
        return true;
      },
      openCodeLifecycleAdapter: {
        handshake: vi.fn(() => Promise.resolve({ ok: true as const })),
        dispose: (runId): true => {
          order.push(`dispose:${runId}`);
          return true;
        },
      },
      releaseRuntimeAfterReap: (runId, receipt): true => {
        expect(verifyRuntimeReapReceipt(receipt, runId, "c".repeat(64))).toBe(true);
        order.push(`release:${runId}`);
        return true;
      },
    });

    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    await expect(manager.stop("run-1988")).resolves.toEqual({ ok: true, status: "stopped" });
    expect(order).toEqual([
      "revoke:run-1988",
      "abort:run-1988",
      "signal:SIGTERM",
      "dispose:run-1988",
      "release:run-1988",
    ]);
  });

  it("does not dispose or release a runtime whose complete-tree reap is unproven", async () => {
    const fixture = createManagedFixture();
    const child = fakeChild();
    const dispose = vi.fn(() => true);
    const releaseRuntimeAfterReap = vi.fn(() => true);
    const manager = createTestCodingRuntimeManager({
      processEnv: {},
      supervisor: testSupervisor(() => child.handle, {
        setTimer: (callback): unknown => {
          callback();
          return undefined;
        },
      }),
      openCodeLifecycleAdapter: {
        handshake: vi.fn(() => Promise.resolve({ ok: true as const })),
        dispose,
      },
      releaseRuntimeAfterReap,
    });

    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );
    await expect(manager.stop("run-1988")).resolves.toEqual({
      ok: false,
      failureCode: "runtime-reap-unproven",
      retryable: false,
    });
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(dispose).not.toHaveBeenCalled();
    expect(releaseRuntimeAfterReap).not.toHaveBeenCalled();
    expect(manager.health()).toMatchObject({ status: "recovery-required" });
  });

  it("keeps the slot in recovery when tree signalling fails", async () => {
    const fixture = createManagedFixture();
    const child = fakeChild();
    const manager = createTestCodingRuntimeManager({
      processEnv: {},
      supervisor: testSupervisor(() => ({
        ...child.handle,
        kill: (): never => {
          throw new Error("backend-signal-failed");
        },
      })),
    });
    await manager.start(
      launchRequest(fixture.workspaceRoot, fixture.managedRoot, fixture.executablePath),
    );

    await expect(manager.stop("run-1988")).resolves.toEqual({
      ok: false,
      failureCode: "runtime-reap-unproven",
      retryable: false,
    });
    expect(manager.health()).toMatchObject({ status: "recovery-required" });
  });
});
