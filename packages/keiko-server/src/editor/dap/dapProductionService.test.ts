import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { DebugLifecycleEvidence, EvidenceStore } from "@oscharko-dev/keiko-contracts";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ServerDiagnosticRecord } from "../../diagnostics-log.js";
import {
  createDapProductionService,
  dapProductionServiceTestBoundary,
  type DapProductionServiceDeps,
  type DapProductionServiceFactories,
} from "./dapProductionService.js";
import type { DebugProvisionedArtifact, QualifiedDebugBackend } from "./debugLaunchContext.js";
import type { DebugLaunchCatalogDeps } from "./debugLaunchCatalog.js";
import type { DebugLaunchRuntimeContext } from "./debugLaunchPlan.js";
import {
  createNodeDapPrivateEndpointDeps,
  type DapPrivateEndpointConnection,
  type DapPrivateEndpointDeps,
} from "./dapPrivateEndpoint.js";
import type {
  DebugCapsuleLayer2Input,
  DebugSpawnEnvelope,
  Layer2DebugCapsulePlan,
} from "./debugCapsulePlan.js";
import type { DapEventBridge } from "./dapEventBridge.js";
import type { DapProcessManager } from "./dapProcessManager.js";

const roots: string[] = [];
type EvidenceStorePutMock = Mock<EvidenceStore["put"]>;

function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function executable(root: string, name: string, source: string): string {
  const path = join(root, name);
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function provisioned(path: string, capsulePath: string): DebugProvisionedArtifact {
  return { hostPath: path, approvedRoot: dirname(path), capsulePath };
}

function qualifiedBackend(): QualifiedDebugBackend {
  return {
    platform: "linux",
    availability: {
      bubblewrap: true,
      unshare: false,
      seatbelt: false,
      docker: false,
      podman: false,
    },
    backendExecutable: {
      realPath: "/approved/bwrap",
    } as QualifiedDebugBackend["backendExecutable"],
  };
}

function shortRuntime(): { readonly path: string; cleanup(): void } {
  const root = realpathSync(mkdtempSync("/tmp/keiko-dap-"));
  const path = realpathSync(mkdtempSync(join(root, "session-")));
  chmodSync(root, 0o700);
  chmodSync(path, 0o700);
  roots.push(root);
  return {
    path,
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function evidenceStore(put: EvidenceStorePutMock): EvidenceStore {
  return { put, list: () => [], get: () => undefined, delete: vi.fn() };
}

function traceOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "<trace-unavailable>";
}

function evidence(): DebugLifecycleEvidence {
  return {
    schemaVersion: "1",
    eventKind: "start",
    sessionId: "session_a",
    state: "starting",
    reason: "requested",
    targetKind: "file",
    backend: "linuxNamespace",
    network: "none",
    filesystem: "executionRoot",
    provisioningDigest: "a".repeat(64),
    timestampMs: 100,
    activationRevision: 4,
    outputAcceptedBytes: 0,
    outputTruncatedEvents: 0,
  };
}

function inertEndpoint(): DapPrivateEndpointDeps {
  return {
    platform: "darwin",
    inspectDirectory: () => Promise.reject(new Error("unused")),
    inspectSocket: () => Promise.reject(new Error("unused")),
    realpath: () => Promise.reject(new Error("unused")),
    connect: () => Promise.reject(new Error("unused")),
    wait: () => Promise.resolve(),
    maxAttempts: 1,
  };
}

function portableDeps(endpoint?: DapPrivateEndpointDeps): DapProductionServiceDeps {
  return {
    evidenceStore: evidenceStore(vi.fn<EvidenceStore["put"]>(() => "/evidence")),
    appendJournal: vi.fn(() => Promise.resolve()),
    now: vi.fn(() => 100),
    epoch: vi.fn(() => 7),
    activationCurrent: vi.fn((_partition, revision) => revision === 4),
    platform: "linux",
    emitOutputLimit: vi.fn(),
    onRuntimeFailure: vi.fn(),
    onProjectionFailure: vi.fn(),
    endpoint,
    provisioning: {
      adapter: {
        executableName: "adapter-bin",
        executableArgs: ["--server", "/run/keiko-debug/dap.sock"],
        trustedRoots: ["/approved"],
        provisioningDigest: "b".repeat(64),
        envAllowlist: ["LANG"],
        fixedEnv: { LANG: "C" },
      },
      backendQualification: {
        backend: provisioned("/approved/bwrap", "/opt/keiko-backend/bwrap"),
        platform: "linux",
      },
      adapterPreflight: vi.fn(),
      launchContext: vi.fn(),
      targetCatalog: vi.fn(),
    },
  };
}

interface ObservedFactories {
  readonly factories: DapProductionServiceFactories;
  readonly createEvidenceProjector: Mock<DapProductionServiceFactories["createEvidenceProjector"]>;
  readonly createEventBridge: Mock<DapProductionServiceFactories["createEventBridge"]>;
  readonly createLifecycleLedger: Mock<DapProductionServiceFactories["createLifecycleLedger"]>;
  readonly createRegistry: Mock<DapProductionServiceFactories["createRegistry"]>;
  readonly createLayer2Validator: Mock<DapProductionServiceFactories["createLayer2Validator"]>;
  readonly createEndpointDeps: Mock<DapProductionServiceFactories["createEndpointDeps"]>;
  readonly createTargetRevalidator: Mock<DapProductionServiceFactories["createTargetRevalidator"]>;
  readonly qualifyBackend: Mock<DapProductionServiceFactories["qualifyBackend"]>;
  readonly createLaunchContextResolver: Mock<
    DapProductionServiceFactories["createLaunchContextResolver"]
  >;
  readonly createLauncher: Mock<DapProductionServiceFactories["createLauncher"]>;
  readonly connectEndpoint: Mock<DapProductionServiceFactories["connectEndpoint"]>;
  readonly createManager: Mock<DapProductionServiceFactories["createManager"]>;
  readonly createAdapterCatalog: Mock<DapProductionServiceFactories["createAdapterCatalog"]>;
  readonly createNodeAdapterSpec: Mock<DapProductionServiceFactories["createNodeAdapterSpec"]>;
}

function observedFactories(): ObservedFactories {
  const production = dapProductionServiceTestBoundary.productionFactories;
  const observed = {
    createEvidenceProjector: vi.fn(production.createEvidenceProjector),
    createEventBridge: vi.fn(production.createEventBridge),
    createLifecycleLedger: vi.fn(production.createLifecycleLedger),
    createRegistry: vi.fn(production.createRegistry),
    createLayer2Validator: vi.fn(production.createLayer2Validator),
    createEndpointDeps: vi.fn(production.createEndpointDeps),
    createTargetRevalidator: vi.fn(production.createTargetRevalidator),
    qualifyBackend: vi.fn(() => qualifiedBackend()),
    createLaunchContextResolver: vi.fn(production.createLaunchContextResolver),
    createLauncher: vi.fn(production.createLauncher),
    connectEndpoint: vi.fn(production.connectEndpoint),
    createManager: vi.fn(production.createManager),
    createAdapterCatalog: vi.fn(production.createAdapterCatalog),
    createNodeAdapterSpec: vi.fn(production.createNodeAdapterSpec),
  };
  return { factories: Object.freeze({ ...observed }), ...observed };
}

function inertManager(overrides: Partial<DapProcessManager> = {}): DapProcessManager {
  return {
    start: () => Promise.resolve(),
    request: <T>() => Promise.reject<T>(new Error("unexpected request")),
    stop: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
    failMalformed: () => Promise.resolve(),
    sweepExpired: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    health: () => undefined,
    binding: () => undefined,
    boundSessionId: () => undefined,
    workspaceSessionId: () => undefined,
    pauseContext: () => undefined,
    ...overrides,
  };
}

function inertEventBridge(overrides: Partial<DapEventBridge> = {}): DapEventBridge {
  return {
    publish: () => true,
    subscribe: () => ({ kind: "subscriberLimit", snapshot: emptyReplaySnapshot() }),
    snapshot: () => emptyReplaySnapshot(),
    channelsForPartition: () => [],
    disposeChannel: () => undefined,
    disposeAll: () => undefined,
    ...overrides,
  };
}

function emptyReplaySnapshot(): ReturnType<DapEventBridge["snapshot"]> {
  return {
    sequence: 0,
    retainedCount: 0,
    retainedBytes: 0,
    evictedCount: 0,
    evictedBytes: 0,
  };
}

function capsuleInput(): DebugCapsuleLayer2Input {
  return {
    candidate: { kind: "file", fileId: "app.js" },
    binding: {
      workspacePartitionKey: "partition_a",
      activationRevision: 4,
      targetKind: "file",
    },
    adapter: {
      providerId: "node",
      executable: "/approved/adapter",
      args: ["--server", "/run/keiko-debug/dap.sock"],
      env: { LANG: "C" },
      home: "/tmp/home",
      temp: "/tmp/runtime",
      runtimeRoot: "/tmp/runtime",
    },
  };
}

function envelopeAt(workspaceRealPath: string): DebugSpawnEnvelope {
  return { workspaceIdentity: { realPath: workspaceRealPath } } as DebugSpawnEnvelope;
}

function opaquePlan(): Layer2DebugCapsulePlan {
  return { planId: "plan_a" } as Layer2DebugCapsulePlan;
}

function opaqueContext(): DebugLaunchRuntimeContext {
  return { projectId: "project_a" } as DebugLaunchRuntimeContext;
}

function opaqueConnection(): DapPrivateEndpointConnection {
  return {
    source: Readable.from([]),
    sendFrame: vi.fn(),
    close: () => Promise.resolve(),
    destroy: vi.fn(),
  };
}

function typedValue<T>(value: unknown, _shape?: Partial<T>): T {
  if (value === undefined) throw new Error("MISSING_COMPOSITION_BINDING");
  return value as T;
}

function fakeBubblewrapSource(trace: string): string {
  return `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("bubblewrap 0.11.0\\n"); process.exit(0); }
const runtimeIndex = args.lastIndexOf("/run/keiko-debug");
const adapterIndex = args.indexOf("/opt/keiko-debug/adapter");
if (runtimeIndex < 1) process.exit(2);
const qualificationProbe = args.some((argument) => argument.includes("/run/keiko-debug/.qualification-probe"));
if (qualificationProbe) {
  const marker = join(args[runtimeIndex - 1], ".qualification-probe");
  writeFileSync(marker, "qualified");
  appendFileSync(${JSON.stringify(trace)}, "qualification-probe\\n");
} else {
  if (adapterIndex < 1) process.exit(2);
  appendFileSync(${JSON.stringify(trace)}, "spawn\\n");
  const child = spawn(args[adapterIndex - 1], ["--server", join(args[runtimeIndex - 1], "dap.sock")], {
    stdio: "inherit", env: process.env,
  });
  child.once("error", (error) => appendFileSync(${JSON.stringify(trace)}, "adapter-error:" + error.code + "\\n"));
  process.once("SIGTERM", () => { child.kill("SIGTERM"); process.exit(0); });
  child.once("exit", (code, signal) => process.exitCode = signal ? 1 : (code ?? 1));
}
`;
}

function fakeAdapterSource(trace: string, replaceWorkspace?: string): string {
  const replacement =
    replaceWorkspace === undefined
      ? ""
      : `if (request.command === "initialize") {
        renameSync(${JSON.stringify(replaceWorkspace)}, ${JSON.stringify(`${replaceWorkspace}-mounted`)});
        mkdirSync(${JSON.stringify(replaceWorkspace)});
        writeFileSync(join(${JSON.stringify(replaceWorkspace)}, "app.js"), "export {};", "utf8");
        appendFileSync(${JSON.stringify(trace)}, "workspace-replaced\\n");
      }`;
  return `#!${process.execPath}
const { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");
const socketPath = process.argv.at(-1);
let adapterSequence = 100;
rmSync(socketPath, { force: true });
appendFileSync(${JSON.stringify(trace)}, "adapter-start\\n");
const server = createServer((socket) => {
  appendFileSync(${JSON.stringify(trace)}, "uds\\n");
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (true) {
      const split = buffered.indexOf("\\r\\n\\r\\n");
      if (split < 0) return;
      const match = /^Content-Length: (\\d+)$/m.exec(buffered.subarray(0, split).toString("ascii"));
      if (!match) process.exit(2);
      const length = Number(match[1]);
      if (buffered.length < split + 4 + length) return;
      const request = JSON.parse(buffered.subarray(split + 4, split + 4 + length).toString("utf8"));
      buffered = buffered.subarray(split + 4 + length);
      appendFileSync(${JSON.stringify(trace)}, "dap:" + request.command + "\\n");
      ${replacement}
      if (request.command === "launch") {
        const initialized = JSON.stringify({ seq: adapterSequence++, type: "event", event: "initialized" });
        socket.write("Content-Length: " + Buffer.byteLength(initialized) + "\\r\\n\\r\\n" + initialized);
      }
      const responseBody = request.command === "initialize"
        ? { supportsConfigurationDoneRequest: true, supportsSetVariable: true }
        : {};
      const body = JSON.stringify({ seq: adapterSequence++, type: "response", request_seq: request.seq,
        success: true, command: request.command, body: responseBody });
      socket.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
    }
  });
});
server.listen(socketPath);
`;
}

interface Fixture {
  readonly deps: DapProductionServiceDeps;
  readonly trace: string;
  readonly put: EvidenceStorePutMock;
  readonly node: string;
}

function fixture(replaceWorkspaceOnInitialize = false): Fixture {
  const workspace = temporary("kdp-workspace-");
  roots.push(`${workspace}-mounted`);
  const approved = temporary("kdp-approved-");
  const trace = join(temporary("kdp-trace-"), "order.log");
  writeFileSync(join(workspace, "app.js"), "export {};", "utf8");
  executable(
    approved,
    "fake-adapter",
    fakeAdapterSource(trace, replaceWorkspaceOnInitialize ? workspace : undefined),
  );
  const backend = executable(approved, "bwrap", fakeBubblewrapSource(trace));
  const node = executable(approved, "node-runtime", "#!/bin/sh\nexit 0\n");
  const npm = executable(approved, "npm-runtime", "#!/bin/sh\nexit 0\n");
  const shell = executable(approved, "shell-runtime", "#!/bin/sh\nexit 0\n");
  const npmUserConfig = join(approved, "npm-user-config");
  const npmGlobalConfig = join(approved, "npm-global-config");
  writeFileSync(npmUserConfig, "", "utf8");
  writeFileSync(npmGlobalConfig, "", "utf8");
  const put = vi.fn<EvidenceStore["put"]>((_id, _json) => "/evidence");
  const catalog: DebugLaunchCatalogDeps = {
    workspaceRoot: workspace,
    workspaceTrusted: true,
    projectId: "project_a",
    fs: nodeWorkspaceFs,
    discover: (): ReturnType<DebugLaunchCatalogDeps["discover"]> => ({
      schemaVersion: "1",
      projectId: "project_a",
      tasks: [],
    }),
  };
  return {
    trace,
    put,
    node,
    deps: {
      evidenceStore: evidenceStore(put),
      appendJournal: (_partition, evidence): Promise<void> => {
        appendFileSync(trace, `journal:${evidence.eventKind}\n`);
        return Promise.resolve();
      },
      now: () => 100,
      epoch: () => 7,
      activationCurrent: (_partition, revision) => revision === 4,
      platform: "linux",
      emitOutputLimit: vi.fn(),
      onRuntimeFailure: vi.fn(),
      endpoint: {
        ...createNodeDapPrivateEndpointDeps(),
        maxAttempts: 200,
        wait: () => new Promise((resolve) => setTimeout(resolve, 5)),
      },
      provisioning: {
        adapter: {
          executableName: "fake-adapter",
          executableArgs: ["--server", "/run/keiko-debug/dap.sock"],
          trustedRoots: [approved],
          provisioningDigest: "a".repeat(64),
        },
        backendQualification: {
          backend: provisioned(backend, "/opt/keiko-backend/bwrap"),
          platform: "linux",
        },
        adapterPreflight: () => ({
          workspaceRoot: workspace,
          processEnv: { PATH: approved },
          approvedPath: "/opt/keiko-runtime",
          createEphemeralTemp: shortRuntime,
          commandAllowed: () => true,
        }),
        launchContext: () => ({
          ...catalog,
          adapterApprovedRoot: approved,
          node: provisioned(node, "/opt/keiko-runtime/node"),
          npm: provisioned(npm, "/opt/keiko-runtime/npm/bin/npm-cli.js"),
          shell: provisioned(shell, "/opt/keiko-runtime/shell"),
          npmUserConfig: provisioned(npmUserConfig, "/opt/keiko-debug/npm-user-config"),
          npmGlobalConfig: provisioned(npmGlobalConfig, "/opt/keiko-debug/npm-global-config"),
          backend: provisioned(backend, "/opt/keiko-backend/bwrap"),
          runtimeClosure: [],
          platform: "linux",
          layer1Allowed: (): boolean => {
            appendFileSync(trace, "layer2\n");
            return true;
          },
        }),
        targetCatalog: (): DebugLaunchCatalogDeps => {
          appendFileSync(trace, "target-revalidate\n");
          return catalog;
        },
      },
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DAP production composition", () => {
  it("assembles one portable registry, ledger, evidence, validator, and manager graph", () => {
    const endpoint = inertEndpoint();
    const deps = portableDeps(endpoint);
    const current = observedFactories();
    const service = dapProductionServiceTestBoundary.compose(deps, current.factories);
    const ledger = typedValue<ReturnType<DapProductionServiceFactories["createLifecycleLedger"]>>(
      current.createLifecycleLedger.mock.results[0]?.value,
    );
    const registry = typedValue<ReturnType<DapProductionServiceFactories["createRegistry"]>>(
      current.createRegistry.mock.results[0]?.value,
    );
    const manager = typedValue<ReturnType<DapProductionServiceFactories["createManager"]>>(
      current.createManager.mock.results[0]?.value,
    );
    const eventBridge = typedValue<ReturnType<DapProductionServiceFactories["createEventBridge"]>>(
      current.createEventBridge.mock.results[0]?.value,
    );

    expect(Object.isFrozen(service)).toBe(true);
    expect(service).toStrictEqual({
      manager,
      registry,
      lifecycleLedger: ledger,
      eventBridge,
      dispose: service.dispose,
    });
    expect(current.createEvidenceProjector).toHaveBeenCalledExactlyOnceWith(deps.evidenceStore);
    expect(current.createEventBridge).toHaveBeenCalledTimes(1);
    expect(current.createLifecycleLedger).toHaveBeenCalledTimes(1);
    expect(current.createRegistry).toHaveBeenCalledTimes(1);
    expect(current.createLayer2Validator).toHaveBeenCalledTimes(1);
    expect(current.qualifyBackend).toHaveBeenCalledExactlyOnceWith(
      deps.provisioning.backendQualification,
    );
    expect(current.createLauncher).toHaveBeenCalledTimes(1);
    expect(current.createManager).toHaveBeenCalledTimes(1);
    expect(current.createEndpointDeps).not.toHaveBeenCalled();
  });

  it("fails construction before creating runtime state when backend qualification fails", () => {
    const deps = portableDeps(inertEndpoint());
    const current = observedFactories();
    current.qualifyBackend.mockImplementation(() => {
      throw new Error("INVALID_DEBUG_BACKEND");
    });

    expect(() => dapProductionServiceTestBoundary.compose(deps, current.factories)).toThrow(
      "INVALID_DEBUG_BACKEND",
    );
    expect(current.qualifyBackend).toHaveBeenCalledOnce();
    expect(current.createEvidenceProjector).not.toHaveBeenCalled();
    expect(current.createRegistry).not.toHaveBeenCalled();
    expect(current.createManager).not.toHaveBeenCalled();
  });

  it("sweeps expiry on an unrefed bounded cadence and disposes idempotently in order", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const sweepExpired = vi.fn(() => Promise.resolve());
      const reconcile = vi.fn(() => Promise.resolve());
      const shutdown = vi.fn(() => {
        order.push("shutdown");
        return Promise.resolve();
      });
      const disposeAll = vi.fn(() => {
        order.push("events");
      });
      const current = observedFactories();
      current.createManager.mockReturnValue(inertManager({ sweepExpired, reconcile, shutdown }));
      current.createEventBridge.mockReturnValue(inertEventBridge({ disposeAll }));
      const service = dapProductionServiceTestBoundary.compose(
        { ...portableDeps(inertEndpoint()), expirySweepIntervalMs: 100 },
        current.factories,
      );

      await vi.advanceTimersByTimeAsync(250);
      expect(sweepExpired).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledTimes(2);
      const first = service.dispose();
      const second = service.dispose();
      expect(second).toBe(first);
      await first;
      await vi.advanceTimersByTimeAsync(500);

      expect(sweepExpired).toHaveBeenCalledTimes(2);
      expect(shutdown).toHaveBeenCalledOnce();
      expect(disposeAll).toHaveBeenCalledOnce();
      expect(order).toStrictEqual(["shutdown", "events"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never overlaps expiry sweeps", async () => {
    vi.useFakeTimers();
    try {
      let release: (() => void) | undefined;
      const sweepExpired = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const current = observedFactories();
      current.createManager.mockReturnValue(inertManager({ sweepExpired }));
      const service = dapProductionServiceTestBoundary.compose(
        { ...portableDeps(inertEndpoint()), expirySweepIntervalMs: 100 },
        current.factories,
      );

      await vi.advanceTimersByTimeAsync(350);
      expect(sweepExpired).toHaveBeenCalledOnce();
      release?.();
      await Promise.resolve();
      await service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failed expiry sweep, skips reconciliation, and resumes the next cadence", async () => {
    vi.useFakeTimers();
    try {
      const failure = new Error("EXPIRY_SWEEP_FAILED");
      const sweepExpired = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(undefined);
      const reconcile = vi.fn(() => Promise.resolve());
      const onRuntimeFailure = vi.fn();
      const current = observedFactories();
      current.createManager.mockReturnValue(inertManager({ sweepExpired, reconcile }));
      const service = dapProductionServiceTestBoundary.compose(
        { ...portableDeps(inertEndpoint()), expirySweepIntervalMs: 100, onRuntimeFailure },
        current.factories,
      );

      await vi.advanceTimersByTimeAsync(100);
      expect(onRuntimeFailure).toHaveBeenCalledExactlyOnceWith(failure);
      expect(reconcile).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      expect(sweepExpired).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledOnce();
      await service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes a failed expiry sweep to the operator diagnostic sink with the real error, not a swallowed one", async () => {
    vi.useFakeTimers();
    try {
      const secret = "SENTINEL_EXPIRY_SWEEP_FAILED";
      const sweepExpired = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error(secret));
      const current = observedFactories();
      current.createManager.mockReturnValue(inertManager({ sweepExpired }));
      const records: ServerDiagnosticRecord[] = [];
      const service = dapProductionServiceTestBoundary.compose(
        {
          ...portableDeps(inertEndpoint()),
          expirySweepIntervalMs: 100,
          diagnosticSink: { record: (record): void => void records.push(record) },
        },
        current.factories,
      );

      await vi.advanceTimersByTimeAsync(100);

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        source: "dapProductionService.sweep",
        operation: "dap.production.runtime-failure",
        errorClass: "Error",
        message: "DAP production background operation failed.",
      });
      expect(records[0]?.correlationId).toMatch(/^dap-runtime-failure-.+/u);
      expect(JSON.stringify(records)).not.toContain(secret);
      await service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes a bounded shutdown failure to the operator diagnostic sink", async () => {
    const secret = "SENTINEL_SHUTDOWN_UPSTREAM_FAILURE";
    const shutdown = vi.fn(() => Promise.reject(new Error(secret)));
    const current = observedFactories();
    current.createManager.mockReturnValue(inertManager({ shutdown }));
    const records: ServerDiagnosticRecord[] = [];
    const service = dapProductionServiceTestBoundary.compose(
      {
        ...portableDeps(inertEndpoint()),
        diagnosticSink: { record: (record): void => void records.push(record) },
      },
      current.factories,
    );

    await service.dispose();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: "dapProductionService.dispose",
      operation: "dap.production.runtime-failure",
      errorClass: "Error",
      message: "DAP production background operation failed.",
    });
    expect(records[0]?.correlationId).toMatch(/^dap-runtime-failure-.+/u);
    expect(JSON.stringify(records)).not.toContain(secret);
  });

  it("routes a live-evidence-projection failure to the operator diagnostic sink even when the composition supplies no projection observer", () => {
    const secret = "SENTINEL_PROJECTION_FAILURE";
    const current = observedFactories();
    const records: ServerDiagnosticRecord[] = [];
    const deps: DapProductionServiceDeps = {
      ...portableDeps(inertEndpoint()),
      onProjectionFailure: undefined,
      diagnosticSink: { record: (record): void => void records.push(record) },
    };
    dapProductionServiceTestBoundary.compose(deps, current.factories);
    const ledgerInput = typedValue<
      Parameters<DapProductionServiceFactories["createLifecycleLedger"]>[0]
    >(current.createLifecycleLedger.mock.calls[0]?.[0]);

    ledgerInput.onProjectionFailure?.(new Error(secret));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: "dapProductionService.projectLive",
      operation: "dap.production.projection-failure",
      errorClass: "Error",
      message: "DAP live-evidence projection failed.",
    });
    expect(records[0]?.correlationId).toMatch(/^dap-projection-failure-.+/u);
    expect(JSON.stringify(records)).not.toContain(secret);
  });

  it("still forwards a live-evidence-projection failure to an optional composition-supplied observer", () => {
    const onProjectionFailure = vi.fn();
    const current = observedFactories();
    const deps: DapProductionServiceDeps = {
      ...portableDeps(inertEndpoint()),
      onProjectionFailure,
    };
    dapProductionServiceTestBoundary.compose(deps, current.factories);
    const ledgerInput = typedValue<
      Parameters<DapProductionServiceFactories["createLifecycleLedger"]>[0]
    >(current.createLifecycleLedger.mock.calls[0]?.[0]);
    const failure = new Error("boom");

    ledgerInput.onProjectionFailure?.(failure);

    expect(onProjectionFailure).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("shares one disposer that waits for an active expiry sweep before shutdown", async () => {
    vi.useFakeTimers();
    try {
      let releaseSweep: (() => void) | undefined;
      const sweepExpired = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseSweep = resolve;
          }),
      );
      const shutdown = vi.fn(() => Promise.resolve());
      const current = observedFactories();
      current.createManager.mockReturnValue(inertManager({ sweepExpired, shutdown }));
      const service = dapProductionServiceTestBoundary.compose(
        { ...portableDeps(inertEndpoint()), expirySweepIntervalMs: 100 },
        current.factories,
      );

      await vi.advanceTimersByTimeAsync(100);
      const first = service.dispose();
      expect(service.dispose()).toBe(first);
      await vi.advanceTimersByTimeAsync(0);
      expect(shutdown).not.toHaveBeenCalled();

      releaseSweep?.();
      await first;
      expect(shutdown).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes a non-Error shutdown rejection and still disposes event state", async () => {
    const nonErrorFailure = "transport closed" as unknown as Error;
    const shutdown = vi.fn(() => Promise.reject(nonErrorFailure));
    const disposeAll = vi.fn();
    const onRuntimeFailure = vi.fn();
    const current = observedFactories();
    current.createManager.mockReturnValue(inertManager({ shutdown }));
    current.createEventBridge.mockReturnValue(inertEventBridge({ disposeAll }));
    const service = dapProductionServiceTestBoundary.compose(
      { ...portableDeps(inertEndpoint()), onRuntimeFailure },
      current.factories,
    );

    await service.dispose();

    expect(shutdown).toHaveBeenCalledOnce();
    expect(onRuntimeFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "DAP_SHUTDOWN_FAILED" }),
    );
    expect(disposeAll).toHaveBeenCalledOnce();
  });

  it("bounds a hung shutdown and still releases browser event state", async () => {
    vi.useFakeTimers();
    try {
      const shutdown = vi.fn(() => new Promise<void>(() => undefined));
      const disposeAll = vi.fn();
      const onRuntimeFailure = vi.fn();
      const current = observedFactories();
      current.createManager.mockReturnValue(inertManager({ shutdown }));
      current.createEventBridge.mockReturnValue(inertEventBridge({ disposeAll }));
      const service = dapProductionServiceTestBoundary.compose(
        { ...portableDeps(inertEndpoint()), onRuntimeFailure, shutdownTimeoutMs: 50 },
        current.factories,
      );
      const disposal = service.dispose();
      await vi.advanceTimersByTimeAsync(50);
      await disposal;
      expect(shutdown).toHaveBeenCalledOnce();
      expect(onRuntimeFailure).toHaveBeenCalledWith(
        expect.objectContaining({ message: "DAP_SHUTDOWN_TIMEOUT" }),
      );
      expect(disposeAll).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds the exact adapter, launcher, and manager dependencies", () => {
    const endpoint = inertEndpoint();
    const deps = portableDeps(endpoint);
    const current = observedFactories();
    dapProductionServiceTestBoundary.compose(deps, current.factories);
    const nodeSpec = typedValue<ReturnType<DapProductionServiceFactories["createNodeAdapterSpec"]>>(
      current.createNodeAdapterSpec.mock.results[0]?.value,
    );
    const catalog = typedValue<ReturnType<DapProductionServiceFactories["createAdapterCatalog"]>>(
      current.createAdapterCatalog.mock.results[0]?.value,
    );
    const launcher = typedValue<ReturnType<DapProductionServiceFactories["createLauncher"]>>(
      current.createLauncher.mock.results[0]?.value,
    );
    const launcherInput = typedValue<
      Parameters<DapProductionServiceFactories["createLauncher"]>[0]
    >(current.createLauncher.mock.calls[0]?.[0]);
    const managerInput = typedValue<Parameters<DapProductionServiceFactories["createManager"]>[0]>(
      current.createManager.mock.calls[0]?.[0],
    );
    const registry = typedValue<ReturnType<DapProductionServiceFactories["createRegistry"]>>(
      current.createRegistry.mock.results[0]?.value,
    );
    const validator = typedValue<
      ReturnType<DapProductionServiceFactories["createLayer2Validator"]>
    >(current.createLayer2Validator.mock.results[0]?.value);
    const eventBridge = typedValue<ReturnType<DapProductionServiceFactories["createEventBridge"]>>(
      current.createEventBridge.mock.results[0]?.value,
    );

    expect(current.createNodeAdapterSpec).toHaveBeenCalledExactlyOnceWith(
      "adapter-bin",
      ["--server", "/run/keiko-debug/dap.sock"],
      ["/approved"],
      "b".repeat(64),
      ["LANG"],
      { LANG: "C" },
    );
    expect(current.createAdapterCatalog).toHaveBeenCalledExactlyOnceWith([nodeSpec]);
    expect(launcherInput).toStrictEqual({
      now: deps.now,
      epoch: deps.epoch,
      activationCurrent: deps.activationCurrent,
      platform: "linux",
      revalidateTarget: managerInput.revalidateTarget,
    });
    expect(managerInput).toMatchObject({
      registry,
      adapterCatalog: catalog,
      adapterPreflight: deps.provisioning.adapterPreflight,
      validateCapsulePlan: validator,
      launchCapsule: launcher,
      events: eventBridge,
    });
  });

  it("routes registry evidence through the single ledger and projector", async () => {
    const deps = portableDeps(inertEndpoint());
    const current = observedFactories();
    dapProductionServiceTestBoundary.compose(deps, current.factories);
    const ledgerInput = typedValue<
      Parameters<DapProductionServiceFactories["createLifecycleLedger"]>[0]
    >(current.createLifecycleLedger.mock.calls[0]?.[0]);
    const registryInput = typedValue<
      Parameters<DapProductionServiceFactories["createRegistry"]>[0]
    >(current.createRegistry.mock.calls[0]?.[0]);

    expect(ledgerInput.appendJournal).toBe(deps.appendJournal);
    expect(registryInput.now).toBe(deps.now);
    expect(registryInput.emitOutputLimit).toBe(deps.emitOutputLimit);
    await registryInput.appendEvidence("partition_a", evidence());
    expect(deps.appendJournal).toHaveBeenCalledExactlyOnceWith("partition_a", evidence());
    expect((deps.evidenceStore.put as EvidenceStorePutMock).mock.calls).toHaveLength(1);
  });

  it("wires context, target revalidation, and endpoint callbacks exactly", async () => {
    const endpoint = inertEndpoint();
    const deps = portableDeps(endpoint);
    const current = observedFactories();
    const context = opaqueContext();
    const resolveContext = vi.fn(() => Promise.resolve(context));
    const targetPredicate = vi.fn(() => true);
    const connection = opaqueConnection();
    current.createLaunchContextResolver.mockReturnValue(resolveContext);
    current.createTargetRevalidator.mockReturnValue(targetPredicate);
    current.connectEndpoint.mockResolvedValue(connection);
    dapProductionServiceTestBoundary.compose(deps, current.factories);
    const validatorDeps = typedValue<
      Parameters<DapProductionServiceFactories["createLayer2Validator"]>[0]
    >(current.createLayer2Validator.mock.calls[0]?.[0]);
    const managerInput = typedValue<Parameters<DapProductionServiceFactories["createManager"]>[0]>(
      current.createManager.mock.calls[0]?.[0],
    );
    const input = capsuleInput();
    await expect(validatorDeps.resolveContext(input)).resolves.toBe(context);
    await expect(validatorDeps.resolveContext(input)).resolves.toBe(context);
    expect(current.qualifyBackend).toHaveBeenCalledOnce();
    expect(deps.provisioning.launchContext).toHaveBeenCalledTimes(2);
    expect(deps.provisioning.launchContext).toHaveBeenNthCalledWith(1, input.binding);
    expect(deps.provisioning.launchContext).toHaveBeenNthCalledWith(2, input.binding);
    expect(current.createLaunchContextResolver).toHaveBeenCalledTimes(2);
    expect(resolveContext).toHaveBeenCalledTimes(2);
    expect(resolveContext).toHaveBeenNthCalledWith(1, input);
    expect(resolveContext).toHaveBeenNthCalledWith(2, input);

    const targetCatalog = { workspaceRoot: "/workspace" } as DebugLaunchCatalogDeps;
    const targetCatalogFactory = deps.provisioning.targetCatalog as Mock<
      DapProductionServiceDeps["provisioning"]["targetCatalog"]
    >;
    targetCatalogFactory.mockReturnValue(targetCatalog);
    const envelope = envelopeAt("/workspace");
    expect(managerInput.revalidateTarget(envelope)).toBe(true);
    expect(targetCatalogFactory).toHaveBeenCalledExactlyOnceWith("/workspace");
    expect(current.createTargetRevalidator).toHaveBeenCalledExactlyOnceWith(targetCatalog);
    expect(targetPredicate).toHaveBeenCalledExactlyOnceWith(envelope);

    const plan = opaquePlan();
    await expect(managerInput.connectEndpoint(plan)).resolves.toBe(connection);
    expect(current.connectEndpoint).toHaveBeenCalledExactlyOnceWith(plan, endpoint);
  });

  it("creates the production endpoint dependencies only when none are supplied", () => {
    const current = observedFactories();
    dapProductionServiceTestBoundary.compose(portableDeps(), current.factories);
    expect(current.createEndpointDeps).toHaveBeenCalledTimes(1);
    expect(current.createEndpointDeps).toHaveBeenCalledWith();
  });

  it("keeps fresh production composition defaults and the test boundary immutable", async () => {
    vi.resetModules();
    const fresh: typeof import("./dapProductionService.js") =
      await import("./dapProductionService.js");
    const service = fresh.createDapProductionService(fixture().deps);
    expect(Object.keys(service)).toStrictEqual([
      "manager",
      "registry",
      "lifecycleLedger",
      "eventBridge",
      "dispose",
    ]);
    expect(Object.isFrozen(service)).toBe(true);
    expect(Object.keys(fresh.dapProductionServiceTestBoundary)).toStrictEqual([
      "compose",
      "productionFactories",
    ]);
    expect(Object.isFrozen(fresh.dapProductionServiceTestBoundary)).toBe(true);
    expect(Object.isFrozen(fresh.dapProductionServiceTestBoundary.productionFactories)).toBe(true);
    expect(Object.keys(fresh.dapProductionServiceTestBoundary.productionFactories)).toStrictEqual([
      "createEvidenceProjector",
      "createEventBridge",
      "createLifecycleLedger",
      "createRegistry",
      "createLayer2Validator",
      "createEndpointDeps",
      "createTargetRevalidator",
      "qualifyBackend",
      "createLaunchContextResolver",
      "createLauncher",
      "connectEndpoint",
      "createManager",
      "createAdapterCatalog",
      "createNodeAdapterSpec",
    ]);
    await service.dispose();
  });

  it("does not execute a child process when plan resolution fails after construction", async () => {
    const current = fixture();
    const service = createDapProductionService(current.deps);
    const constructionTrace = readFileSync(current.trace, "utf8");
    expect(constructionTrace).toBe("qualification-probe\n");
    rmSync(current.node);

    await expect(
      service.manager.start({
        identity: {
          sessionId: "session_prestart_failure",
          workspaceId: "workspace_a",
          workspacePartitionKey: "project_a",
          browserSessionBinding: "browser_a",
          targetKind: "file",
          activationRevision: 4,
          network: "none",
          filesystem: "executionRoot",
        },
        adapterRuntime: "node",
        adapterProviderId: "node",
        planCandidate: { kind: "file", fileId: "app.js" },
      }),
    ).rejects.toThrow();

    expect(readFileSync(current.trace, "utf8")).toBe(constructionTrace);
    expect(service.registry.sessionIds()).toStrictEqual([]);
    await service.dispose();
  });

  // LINUX-ONLY. The two tests below drive the real namespace sandbox backend, so on macOS they do
  // not run at all — a green local `dapProductionService` suite says nothing about either. #2643
  // was a production launch failure that both of these caught on Linux CI while every local run
  // stayed green; the requirement is in the title so the skip line names its own reason instead of
  // adding one to an anonymous "2 skipped" count. To run them, see the container recipe in
  // docs/qa/local-gates.md — about two seconds once the image is warm.
  it.skipIf(process.platform !== "linux")(
    "[linux-only: namespace sandbox] runs one canonical production graph from opaque target through UDS teardown",
    async () => {
      const current = fixture();
      const service = createDapProductionService(current.deps);
      const start = service.manager.start({
        identity: {
          sessionId: "session_a",
          workspaceId: "workspace_a",
          workspacePartitionKey: "project_a",
          browserSessionBinding: "browser_a",
          targetKind: "file",
          activationRevision: 4,
          network: "none",
          filesystem: "executionRoot",
        },
        adapterRuntime: "node",
        adapterProviderId: "node",
        planCandidate: { kind: "file", fileId: "app.js" },
      });
      await start.catch((error: unknown) => {
        throw new Error(`START_FAILED:${String(error)}:${traceOrEmpty(current.trace)}`);
      });

      expect(service.manager.health("session_a")).toMatchObject({ state: "running" });
      expect(service.registry.sessionIds()).toStrictEqual(["session_a"]);
      expect(
        service.lifecycleLedger.list("project_a").records.map((event) => event.eventKind),
      ).toStrictEqual(["start", "active"]);
      expect(readFileSync(current.trace, "utf8").trim().split("\n")).toStrictEqual([
        "qualification-probe",
        "layer2",
        "journal:start",
        "target-revalidate",
        "spawn",
        "adapter-start",
        "uds",
        "dap:initialize",
        "target-revalidate",
        "dap:launch",
        "dap:configurationDone",
        "journal:active",
      ]);

      const stopping = service.manager.stop("session_a");
      await vi.waitFor(async () => {
        await service.registry.reconcile();
        expect(service.manager.health("session_a")).toBeUndefined();
      });
      await stopping;
      expect(service.manager.health("session_a")).toBeUndefined();
      expect(
        service.lifecycleLedger.list("project_a").records.map((event) => event.eventKind),
      ).toStrictEqual(["start", "active", "stop", "teardown"]);
      expect(current.put).toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== "linux")(
    "[linux-only: namespace sandbox] rejects workspace replacement after initialize before sending DAP launch",
    async () => {
      const current = fixture(true);
      const service = createDapProductionService(current.deps);

      await expect(
        service.manager.start({
          identity: {
            sessionId: "session_workspace_drift",
            workspaceId: "workspace_a",
            workspacePartitionKey: "project_a",
            browserSessionBinding: "browser_a",
            targetKind: "file",
            activationRevision: 4,
            network: "none",
            filesystem: "executionRoot",
          },
          adapterRuntime: "node",
          adapterProviderId: "node",
          planCandidate: { kind: "file", fileId: "app.js" },
        }),
      ).rejects.toThrow("INVALID_CAPSULE_PLAN");

      const trace = traceOrEmpty(current.trace);
      expect(trace).toContain("spawn\n");
      expect(trace).toContain("dap:initialize\n");
      expect(trace).toContain("workspace-replaced\n");
      expect(trace).not.toContain("dap:launch\n");
      await vi.waitFor(async () => {
        await service.registry.reconcile();
        expect(service.manager.health("session_workspace_drift")).toBeUndefined();
      });
    },
  );
});
