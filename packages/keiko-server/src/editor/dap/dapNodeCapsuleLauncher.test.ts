import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveCanonicalDebugProvisioningDigest,
  type DebugSpawnArtifactIdentity,
  type DebugSpawnEnvelope,
} from "./debugCapsulePlan.js";
import {
  createProductionDebugCapsuleLauncher,
  debugCapsuleLauncherInternals,
  type DebugCapsuleLauncherDeps,
  type DebugCapsuleSpawnProcess,
} from "./dapNodeCapsuleLauncher.js";

type ChildProcess = ReturnType<DebugCapsuleSpawnProcess>;
type SpawnOptions = Parameters<DebugCapsuleSpawnProcess>[2];
type SpawnCall = Parameters<DebugCapsuleSpawnProcess>;

const roots: string[] = [];
const linuxIt = process.platform === "linux" ? it : it.skip;

function temporary(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "kdl-")));
  roots.push(path);
  return path;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function artifact(path: string): DebugSpawnArtifactIdentity {
  const stat = lstatSync(path);
  return Object.freeze({
    hostPath: path,
    realPath: path,
    approvedRootRealPath: dirname(path),
    capsulePath: "/opt/keiko-backend/bwrap",
    identityDigest: createHash("sha256").update(readFileSync(path)).digest("hex"),
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mode: stat.mode,
    ownerUid: stat.uid,
  });
}

function signedEnvelope(
  values: Omit<DebugSpawnEnvelope, "identityDigest" | "planId">,
): DebugSpawnEnvelope {
  const identityDigest = hash(values);
  return Object.freeze({ ...values, planId: identityDigest, identityDigest });
}

function fixture(): {
  readonly envelope: DebugSpawnEnvelope;
  readonly runtime: string;
  readonly command: string;
} {
  const root = temporary();
  const command = join(root, "bwrap");
  writeFileSync(command, "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n", "utf8");
  chmodSync(command, 0o755);
  const runtime = join(root, "runtime");
  mkdirSync(runtime, { mode: 0o700 });
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  const workspaceStat = lstatSync(workspace);
  const runtimeStat = lstatSync(runtime);
  const runtimeIdentity = hash([
    runtime,
    runtimeStat.dev,
    runtimeStat.ino,
    runtimeStat.mode,
    runtimeStat.uid,
  ]);
  const endpoint = Object.freeze({
    kind: "posixSocket" as const,
    hostRuntimeDirectory: runtime,
    hostSocketPath: join(runtime, "dap.sock"),
    capsuleRuntimeDirectory: "/run/keiko-debug",
    capsuleSocketPath: "/run/keiko-debug/dap.sock",
    runtimeIdentity,
  });
  const artifacts = Object.freeze([artifact(command)]);
  const values = {
    schemaVersion: "1" as const,
    providerId: "node",
    backend: "linuxNamespace" as const,
    provisioningDigest: deriveCanonicalDebugProvisioningDigest(artifacts),
    runtimeIdentityDigest: "c".repeat(64),
    runtimeDirectoryIdentity: Object.freeze({
      realPath: runtime,
      identityDigest: runtimeIdentity,
      device: runtimeStat.dev,
      inode: runtimeStat.ino,
      mode: runtimeStat.mode,
      ownerUid: runtimeStat.uid,
    }),
    capsuleCommand: command,
    capsuleArgs: Object.freeze([]),
    adapterExecutable: "/opt/keiko-debug/adapter",
    adapterArgs: Object.freeze(["--server", "/run/keiko-debug/dap.sock"]),
    environment: Object.freeze({
      HOME: "/run/keiko-debug/home",
      USERPROFILE: "/run/keiko-debug/home",
      PATH: "/opt/keiko-runtime",
      TMPDIR: "/run/keiko-debug/tmp",
      TEMP: "/run/keiko-debug/tmp",
      TMP: "/run/keiko-debug/tmp",
    }),
    home: join(runtime, "home"),
    temp: runtime,
    cwd: "/keiko-execution-root" as const,
    endpoint,
    artifacts,
    workspaceIdentity: Object.freeze({
      realPath: workspace,
      identityDigest: hash([
        workspace,
        workspaceStat.dev,
        workspaceStat.ino,
        workspaceStat.mode,
        workspaceStat.uid,
      ]),
      device: workspaceStat.dev,
      inode: workspaceStat.ino,
      mode: workspaceStat.mode,
      ownerUid: workspaceStat.uid,
    }),
    targetIdentityDigest: "d".repeat(64),
    targetReference: Object.freeze({ kind: "file" as const, fileId: "app.js" }),
    activationRevision: 7,
    epoch: 3,
    expiresAtMs: 1_000,
  };
  return { envelope: signedEnvelope(values), runtime, command };
}

function writeFlood(stream: PassThrough): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.write(Buffer.alloc(1024 * 1024), (error?: Error | null): void => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function resign(
  envelope: DebugSpawnEnvelope,
  drift: Partial<Omit<DebugSpawnEnvelope, "identityDigest" | "planId">>,
): DebugSpawnEnvelope {
  const values = Object.fromEntries(
    Object.entries(envelope).filter(([key]) => key !== "identityDigest" && key !== "planId"),
  ) as Omit<DebugSpawnEnvelope, "identityDigest" | "planId">;
  return signedEnvelope({ ...values, ...drift });
}

function firstArtifact(envelope: DebugSpawnEnvelope): DebugSpawnArtifactIdentity {
  const value = envelope.artifacts[0];
  if (value === undefined) throw new Error("invalid fixture");
  return value;
}

function dependencies(overrides: Partial<DebugCapsuleLauncherDeps> = {}): DebugCapsuleLauncherDeps {
  return {
    now: () => 10,
    epoch: () => 3,
    activationCurrent: (_partition, revision) => revision === 7,
    revalidateTarget: () => true,
    platform: "linux",
    ...overrides,
  };
}

async function expectInvalidBeforeSpawn(
  envelope: DebugSpawnEnvelope,
  overrides: Partial<DebugCapsuleLauncherDeps> = {},
): Promise<void> {
  const spawnProcess = vi.fn(() => {
    throw new Error("unexpected spawn");
  });
  const launcher = createProductionDebugCapsuleLauncher(
    dependencies({
      spawnProcess: spawnProcess as unknown as DebugCapsuleSpawnProcess,
      ...overrides,
    }),
  );
  await expect(launcher(envelope, new AbortController().signal)).rejects.toMatchObject({
    code: "INVALID_CAPSULE_PLAN",
  });
  expect(spawnProcess).not.toHaveBeenCalled();
}

interface FakeChild {
  readonly child: ChildProcess;
  readonly stdin: PassThrough | null;
  readonly stdout: PassThrough | null;
  readonly stderr: PassThrough | null;
  readonly kill: ReturnType<typeof vi.fn>;
}

function fakeChild(
  values: {
    readonly pid?: number | undefined;
    readonly stdin?: PassThrough | null | undefined;
    readonly stdout?: PassThrough | null | undefined;
    readonly stderr?: PassThrough | null | undefined;
  } = {},
): FakeChild {
  const emitter = new EventEmitter();
  const stdin = values.stdin === undefined ? new PassThrough() : values.stdin;
  const stdout = values.stdout === undefined ? new PassThrough() : values.stdout;
  const stderr = values.stderr === undefined ? new PassThrough() : values.stderr;
  const kill = vi.fn(() => true);
  Object.assign(emitter, {
    pid: Object.hasOwn(values, "pid") ? values.pid : 42_424,
    stdin,
    stdout,
    stderr,
    kill,
  });
  return { child: emitter as unknown as ChildProcess, stdin, stdout, stderr, kill };
}

function spawnReturning(
  child: ChildProcess,
  calls?: SpawnCall[],
  event: "error" | "spawn" = "spawn",
): DebugCapsuleSpawnProcess {
  const implementation: DebugCapsuleSpawnProcess = (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess => {
    calls?.push([command, args, options]);
    queueMicrotask(() => {
      child.emit(event, event === "error" ? new Error("closed spawn") : undefined);
    });
    return child;
  };
  return implementation;
}

function writeProcStat(
  procRoot: string,
  pid: string,
  parent: string,
  startTime = "1000",
  state = "S",
): void {
  const directory = join(procRoot, pid);
  mkdirSync(directory, { recursive: true });
  const fieldsBeforeStartTime = Array.from({ length: 17 }, () => "0").join(" ");
  writeFileSync(
    join(directory, "stat"),
    `${pid} (hostile ) name) ${state} ${parent} ${fieldsBeforeStartTime} ${startTime}\n`,
    "utf8",
  );
}

function writeRawProcStat(procRoot: string, pid: string, value: string): void {
  const directory = join(procRoot, pid);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "stat"), value, "utf8");
}

function envelopeWithArtifacts(
  envelope: DebugSpawnEnvelope,
  artifacts: readonly DebugSpawnArtifactIdentity[],
): DebugSpawnEnvelope {
  return resign(envelope, {
    artifacts,
    provisioningDigest: deriveCanonicalDebugProvisioningDigest(artifacts),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production debug capsule launcher", () => {
  it("spawns the exact absolute backend and returns the exact plan id", async () => {
    const current = fixture();
    const launcher = createProductionDebugCapsuleLauncher({
      now: () => 10,
      epoch: () => 3,
      activationCurrent: (_partition, revision) => revision === 7,
      revalidateTarget: () => true,
      platform: "linux",
    });
    const handle = await launcher(current.envelope, new AbortController().signal);
    expect(handle.planId).toBe(current.envelope.planId);
    expect(current.envelope.capsuleCommand).toBe(current.command);
    expect(JSON.stringify(current.envelope.environment)).not.toContain(current.runtime);
    await handle.terminateContainment("SIGKILL");
    await handle.cleanup();
  });

  it("continuously drains capsule stdout so a flood cannot block UDS-mode progress", async () => {
    const current = fixture();
    const stdout = new PassThrough({ highWaterMark: 64 });
    const child = fakeChild({ stdout });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("controlled missing process group");
    });
    const launcher = createProductionDebugCapsuleLauncher(
      dependencies({ spawnProcess: spawnReturning(child.child) }),
    );
    const handle = await launcher(current.envelope, new AbortController().signal);
    try {
      expect(stdout.readableFlowing).toBe(true);
      await writeFlood(stdout);
    } finally {
      await handle.terminateContainment("SIGKILL");
      child.child.emit("exit", 0, null);
      await handle.cleanup();
    }
    expect(kill).toHaveBeenCalledWith(-42_424, "SIGKILL");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it.each([
    [
      "expiry",
      { now: (): number => 1_000, epoch: (): number => 3, activationCurrent: (): boolean => true },
    ],
    [
      "epoch",
      { now: (): number => 10, epoch: (): number => 4, activationCurrent: (): boolean => true },
    ],
    [
      "activation",
      { now: (): number => 10, epoch: (): number => 3, activationCurrent: (): boolean => false },
    ],
  ])("fails before spawn on final %s drift", async (_label, clocks) => {
    const current = fixture();
    const launcher = createProductionDebugCapsuleLauncher({
      ...clocks,
      revalidateTarget: vi.fn(() => true),
      platform: "linux",
    });
    await expect(launcher(current.envelope, new AbortController().signal)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
  });

  it("binds activation freshness to both workspace partition and exact revision", async () => {
    const first = fixture().envelope;
    const second = fixture().envelope;
    const sameRevisionWrongWorkspace = vi.fn(
      (partition: string, revision: number) =>
        partition === second.workspaceIdentity.identityDigest && revision === 7,
    );
    await expectInvalidBeforeSpawn(first, { activationCurrent: sameRevisionWrongWorkspace });
    expect(sameRevisionWrongWorkspace).toHaveBeenCalledExactlyOnceWith(
      first.workspaceIdentity.identityDigest,
      7,
    );

    const differentRevision = resign(first, { activationRevision: 8 });
    const rightWorkspaceOldRevision = vi.fn(
      (partition: string, revision: number) =>
        partition === first.workspaceIdentity.identityDigest && revision === 7,
    );
    await expectInvalidBeforeSpawn(differentRevision, {
      activationCurrent: rightWorkspaceOldRevision,
    });
    expect(rightWorkspaceOldRevision).toHaveBeenCalledExactlyOnceWith(
      first.workspaceIdentity.identityDigest,
      8,
    );
  });

  it("rechecks epoch in the same turn after target validation", async () => {
    const current = fixture();
    let epoch = 3;
    const launcher = createProductionDebugCapsuleLauncher({
      now: () => 10,
      epoch: () => epoch,
      activationCurrent: (_partition, revision) => revision === 7,
      revalidateTarget: () => {
        epoch = 4;
        return true;
      },
      platform: "linux",
    });
    await expect(launcher(current.envelope, new AbortController().signal)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
  });

  it("rejects forged digest and inode identities", async () => {
    const current = fixture();
    const launcher = createProductionDebugCapsuleLauncher({
      now: () => 10,
      epoch: () => 3,
      activationCurrent: (_partition, revision) => revision === 7,
      revalidateTarget: () => true,
      platform: "linux",
    });
    for (const artifactDrift of [
      { identityDigest: "0".repeat(64) },
      { inode: firstArtifact(current.envelope).inode + 1 },
    ]) {
      const changedArtifact = { ...firstArtifact(current.envelope), ...artifactDrift };
      const changed = resign(current.envelope, { artifacts: [changedArtifact] });
      await expect(launcher(changed, new AbortController().signal)).rejects.toMatchObject({
        code: "INVALID_CAPSULE_PLAN",
      });
    }
  });

  it("creates zero children when the workspace root inode is replaced", async () => {
    const current = fixture();
    const workspace = current.envelope.workspaceIdentity.realPath;
    renameSync(workspace, `${workspace}-old`);
    mkdirSync(workspace, { mode: 0o700 });
    const target = vi.fn(() => true);
    const launcher = createProductionDebugCapsuleLauncher({
      now: () => 10,
      epoch: () => 3,
      activationCurrent: (_partition, revision) => revision === 7,
      revalidateTarget: target,
      platform: "linux",
    });
    await expect(launcher(current.envelope, new AbortController().signal)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
    expect(target).not.toHaveBeenCalled();
  });

  it("creates zero children when the runtime directory inode is replaced", async () => {
    const current = fixture();
    renameSync(current.runtime, `${current.runtime}-old`);
    mkdirSync(current.runtime, { mode: 0o700 });
    const target = vi.fn(() => true);
    const launcher = createProductionDebugCapsuleLauncher({
      now: () => 10,
      epoch: () => 3,
      activationCurrent: (_partition, revision) => revision === 7,
      revalidateTarget: target,
      platform: "linux",
    });
    await expect(launcher(current.envelope, new AbortController().signal)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
    expect(target).not.toHaveBeenCalled();
  });

  it("maps spawn errors to a closed failure and removes a pre-existing socket", async () => {
    const current = fixture();
    if (current.envelope.endpoint.kind !== "posixSocket") throw new Error("invalid fixture");
    writeFileSync(current.envelope.endpoint.hostSocketPath, "stale");
    chmodSync(current.command, 0o644);
    const artifacts = Object.freeze([artifact(current.command)]);
    const changed = resign(current.envelope, {
      artifacts,
      provisioningDigest: deriveCanonicalDebugProvisioningDigest(artifacts),
    });
    const launcher = createProductionDebugCapsuleLauncher({
      now: () => 10,
      epoch: () => 3,
      activationCurrent: (_partition, revision) => revision === 7,
      revalidateTarget: () => true,
      platform: "linux",
    });
    await expect(launcher(changed, new AbortController().signal)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
    expect(() => lstatSync(join(current.runtime, "dap.sock"))).toThrow();
  });

  it("fails closed without spawning an unsupported OCI backend", async () => {
    const current = fixture();
    const unsupported = resign(current.envelope, { backend: "oci" });
    const target = vi.fn(() => true);
    const launcher = createProductionDebugCapsuleLauncher({
      now: () => 10,
      epoch: () => 3,
      activationCurrent: (_partition, revision) => revision === 7,
      revalidateTarget: target,
      platform: "linux",
    });
    await expect(launcher(unsupported, new AbortController().signal)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
    expect(target).not.toHaveBeenCalled();
  });

  it("exposes a fresh, frozen, exact internal verification surface", async () => {
    vi.resetModules();
    const fresh = await import("./dapNodeCapsuleLauncher.js");
    expect(Object.isFrozen(fresh.debugCapsuleLauncherInternals)).toBe(true);
    expect(Object.keys(fresh.debugCapsuleLauncherInternals).sort()).toEqual([
      "artifactUnchanged",
      "cleanupEndpoint",
      "createLinuxScopeTracker",
      "descendantCount",
      "descendantIdentities",
      "groupKill",
      "inspectLinuxScope",
      "processIdentity",
      "processParent",
      "readProcessTable",
      "requirePosixEndpoint",
      "resolveProcRoot",
      "runtimeUnchanged",
      "spawnOptions",
      "targetCurrent",
      "terminateObservedLinuxDescendants",
      "workspaceUnchanged",
    ]);
    expect(fresh.debugCapsuleLauncherInternals.resolveProcRoot(dependencies())).toBe("/proc");
    expect(
      fresh.debugCapsuleLauncherInternals.resolveProcRoot(
        dependencies({ procRoot: "/controlled-proc" }),
      ),
    ).toBe("/controlled-proc");
    const current = fixture();
    expect(fresh.debugCapsuleLauncherInternals.requirePosixEndpoint(current.envelope)).toBe(
      current.envelope.endpoint,
    );
    expect(() =>
      fresh.debugCapsuleLauncherInternals.requirePosixEndpoint(
        resign(current.envelope, {
          endpoint: Object.freeze({
            kind: "windowsPipe" as const,
            pipeName: "keiko-debug",
            runtimeIdentity: current.envelope.runtimeIdentityDigest,
          }),
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_CAPSULE_PLAN" }));
    expect(
      fresh.debugCapsuleLauncherInternals.targetCurrent(dependencies(), current.envelope),
    ).toBe(true);
    expect(
      fresh.debugCapsuleLauncherInternals.targetCurrent(
        dependencies({ revalidateTarget: () => false }),
        current.envelope,
      ),
    ).toBe(false);
    expect(
      fresh.debugCapsuleLauncherInternals.targetCurrent(
        dependencies({
          revalidateTarget: () => {
            throw new Error("hostile target diagnostic");
          },
        }),
        current.envelope,
      ),
    ).toBe(false);
  });

  it("rejects abort, platform, target, plan, and closed-envelope drift before spawn", async () => {
    const current = fixture();
    const aborted = new AbortController();
    aborted.abort();
    const abortedSpawn = vi.fn();
    const abortedLauncher = createProductionDebugCapsuleLauncher(
      dependencies({ spawnProcess: abortedSpawn as unknown as DebugCapsuleSpawnProcess }),
    );
    await expect(abortedLauncher(current.envelope, aborted.signal)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
    expect(abortedSpawn).not.toHaveBeenCalled();

    await expectInvalidBeforeSpawn(current.envelope, { platform: "darwin" });
    await expectInvalidBeforeSpawn(
      resign(current.envelope, {
        endpoint: Object.freeze({
          kind: "windowsPipe" as const,
          pipeName: "keiko-debug",
          runtimeIdentity: current.envelope.runtimeIdentityDigest,
        }),
      }),
    );
    await expectInvalidBeforeSpawn(current.envelope, { revalidateTarget: () => false });
    await expectInvalidBeforeSpawn(current.envelope, {
      revalidateTarget: () => {
        throw new Error("hostile target diagnostic");
      },
    });
    await expectInvalidBeforeSpawn(Object.freeze({ ...current.envelope, planId: "0".repeat(64) }));
    await expectInvalidBeforeSpawn(
      Object.freeze({ ...current.envelope, identityDigest: "0".repeat(64) }),
    );
    await expectInvalidBeforeSpawn(
      Object.freeze({ ...current.envelope, providerId: "forged-provider" }),
    );
  });

  it("requires one exact unchanged backend artifact and the observed provisioning closure", async () => {
    const current = fixture();
    const original = firstArtifact(current.envelope);
    const otherPath = join(dirname(current.command), "other");
    writeFileSync(otherPath, "other", "utf8");
    const other = artifact(otherPath);
    const foreignRoot = temporary();

    const empty = envelopeWithArtifacts(current.envelope, []);
    await expectInvalidBeforeSpawn(empty);
    await expectInvalidBeforeSpawn(
      resign(envelopeWithArtifacts(current.envelope, [original, other]), {
        capsuleCommand: other.realPath,
      }),
    );
    await expectInvalidBeforeSpawn(
      resign(current.envelope, { provisioningDigest: "0".repeat(64) }),
    );

    const scalarDrifts: readonly Partial<DebugSpawnArtifactIdentity>[] = [
      { hostPath: otherPath },
      { realPath: otherPath },
      { approvedRootRealPath: foreignRoot },
      { identityDigest: "0".repeat(64) },
      { device: original.device + 1 },
      { inode: original.inode + 1 },
      { size: original.size + 1 },
      { mode: original.mode ^ 0o100 },
      { ownerUid: original.ownerUid + 1 },
    ];
    for (const drift of scalarDrifts) {
      const changed = Object.freeze({ ...original, ...drift });
      await expectInvalidBeforeSpawn(envelopeWithArtifacts(current.envelope, [changed, other]));
    }

    writeFileSync(current.command, "#!/bin/sh\nexit 0000000000000000000000000000000\n", "utf8");
    await expectInvalidBeforeSpawn(current.envelope);
  });

  it("isolates approved-root canonicalization, strict containment, and artifact read failure", async () => {
    const current = fixture();
    const original = firstArtifact(current.envelope);
    const rootAlias = join(dirname(current.command), "root-alias");
    symlinkSync(dirname(current.command), rootAlias);
    await expectInvalidBeforeSpawn(
      envelopeWithArtifacts(current.envelope, [
        Object.freeze({ ...original, approvedRootRealPath: rootAlias }),
      ]),
    );
    await expectInvalidBeforeSpawn(
      envelopeWithArtifacts(current.envelope, [
        Object.freeze({ ...original, approvedRootRealPath: current.command }),
      ]),
    );
    rmSync(current.command);
    expect(debugCapsuleLauncherInternals.artifactUnchanged(original)).toBe(false);
  });

  it("rejects deleted, replaced, symlinked, non-file, and mode-drifted artifacts", async () => {
    for (const mutation of ["deleted", "directory", "mode", "symlink"] as const) {
      const current = fixture();
      if (mutation === "deleted") rmSync(current.command);
      if (mutation === "directory") {
        rmSync(current.command);
        mkdirSync(current.command);
      }
      if (mutation === "mode") chmodSync(current.command, 0o700);
      if (mutation === "symlink") {
        const replacement = `${current.command}-replacement`;
        renameSync(current.command, replacement);
        symlinkSync(replacement, current.command);
      }
      await expectInvalidBeforeSpawn(current.envelope);
    }
  });

  it("checks every runtime directory path, type, mode, owner, and identity field", async () => {
    const current = fixture();
    if (current.envelope.endpoint.kind !== "posixSocket") throw new Error("invalid fixture");
    const endpoint = current.envelope.endpoint;
    const identity = current.envelope.runtimeDirectoryIdentity;
    const endpointDrifts = [
      { hostRuntimeDirectory: dirname(current.runtime) },
      { runtimeIdentity: "0".repeat(64) },
    ];
    for (const drift of endpointDrifts) {
      await expectInvalidBeforeSpawn(
        resign(current.envelope, { endpoint: Object.freeze({ ...endpoint, ...drift }) }),
      );
    }
    for (const drift of [
      { realPath: dirname(current.runtime) },
      { identityDigest: "0".repeat(64) },
      { device: identity.device + 1 },
      { inode: identity.inode + 1 },
      { mode: identity.mode ^ 0o100 },
      { ownerUid: identity.ownerUid + 1 },
    ]) {
      await expectInvalidBeforeSpawn(
        resign(current.envelope, {
          runtimeDirectoryIdentity: Object.freeze({ ...identity, ...drift }),
        }),
      );
    }

    vi.spyOn(process, "getuid").mockReturnValue(identity.ownerUid + 1);
    await expectInvalidBeforeSpawn(current.envelope);
  });

  it("isolates the fixed runtime mode and canonical runtime identity digest", async () => {
    const current = fixture();
    if (current.envelope.endpoint.kind !== "posixSocket") throw new Error("invalid fixture");
    const posixEndpoint = current.envelope.endpoint;
    chmodSync(current.runtime, 0o755);
    const stat = lstatSync(current.runtime);
    const identityDigest = hash([current.runtime, stat.dev, stat.ino, stat.mode, stat.uid]);
    const identity = Object.freeze({
      realPath: current.runtime,
      identityDigest,
      device: stat.dev,
      inode: stat.ino,
      mode: stat.mode,
      ownerUid: stat.uid,
    });
    const endpoint = Object.freeze({
      ...posixEndpoint,
      runtimeIdentity: identityDigest,
    });
    await expectInvalidBeforeSpawn(
      resign(current.envelope, { endpoint, runtimeDirectoryIdentity: identity }),
    );

    chmodSync(current.runtime, 0o700);
    const restored = lstatSync(current.runtime);
    const forgedDigest = "0".repeat(64);
    await expectInvalidBeforeSpawn(
      resign(current.envelope, {
        endpoint: Object.freeze({ ...posixEndpoint, runtimeIdentity: forgedDigest }),
        runtimeDirectoryIdentity: Object.freeze({
          ...current.envelope.runtimeDirectoryIdentity,
          identityDigest: forgedDigest,
          mode: restored.mode,
        }),
      }),
    );
  });

  it("returns exact false on runtime read failure and when POSIX uid lookup is unavailable", () => {
    const current = fixture();
    if (current.envelope.endpoint.kind !== "posixSocket") throw new Error("invalid fixture");
    rmSync(current.runtime, { recursive: true });
    expect(
      debugCapsuleLauncherInternals.runtimeUnchanged(current.envelope, current.envelope.endpoint),
    ).toBe(false);

    const second = fixture();
    if (second.envelope.endpoint.kind !== "posixSocket") throw new Error("invalid fixture");
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      expect(
        debugCapsuleLauncherInternals.runtimeUnchanged(second.envelope, second.envelope.endpoint),
      ).toBe(false);
    } finally {
      if (descriptor !== undefined) Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("rejects runtime deletion, symlink substitution, non-directory replacement, and mode drift", async () => {
    for (const mutation of ["deleted", "file", "mode", "symlink"] as const) {
      const current = fixture();
      if (mutation === "deleted") rmSync(current.runtime, { recursive: true });
      if (mutation === "file") {
        rmSync(current.runtime, { recursive: true });
        writeFileSync(current.runtime, "hostile", "utf8");
      }
      if (mutation === "mode") chmodSync(current.runtime, 0o755);
      if (mutation === "symlink") {
        const replacement = `${current.runtime}-replacement`;
        renameSync(current.runtime, replacement);
        symlinkSync(replacement, current.runtime);
      }
      await expectInvalidBeforeSpawn(current.envelope);
    }
  });

  it("rejects every workspace identity field and hostile filesystem replacement", async () => {
    const current = fixture();
    const identity = current.envelope.workspaceIdentity;
    for (const drift of [
      { realPath: dirname(identity.realPath) },
      { identityDigest: "0".repeat(64) },
      { device: identity.device + 1 },
      { inode: identity.inode + 1 },
      { mode: identity.mode ^ 0o100 },
      { ownerUid: identity.ownerUid + 1 },
    ]) {
      await expectInvalidBeforeSpawn(
        resign(current.envelope, {
          workspaceIdentity: Object.freeze({ ...identity, ...drift }),
        }),
      );
    }
    rmSync(identity.realPath, { recursive: true });
    writeFileSync(identity.realPath, "hostile", "utf8");
    await expectInvalidBeforeSpawn(current.envelope);
  });

  it("isolates workspace canonical-path, directory-type, and read-failure checks", async () => {
    const current = fixture();
    const identity = current.envelope.workspaceIdentity;
    const alias = `${identity.realPath}-alias`;
    symlinkSync(identity.realPath, alias);
    await expectInvalidBeforeSpawn(
      resign(current.envelope, {
        workspaceIdentity: Object.freeze({ ...identity, realPath: alias }),
      }),
    );

    const file = join(dirname(identity.realPath), "workspace-file");
    writeFileSync(file, "workspace", "utf8");
    const stat = lstatSync(file);
    await expectInvalidBeforeSpawn(
      resign(current.envelope, {
        workspaceIdentity: Object.freeze({
          realPath: file,
          identityDigest: hash([file, stat.dev, stat.ino, stat.mode, stat.uid]),
          device: stat.dev,
          inode: stat.ino,
          mode: stat.mode,
          ownerUid: stat.uid,
        }),
      }),
    );

    rmSync(identity.realPath, { recursive: true });
    expect(debugCapsuleLauncherInternals.workspaceUnchanged(current.envelope)).toBe(false);
  });

  it("uses the exact command, arguments, options, streams, and handle contract", async () => {
    const current = fixture();
    const child = fakeChild();
    if (child.stdout === null || child.stdin === null || child.stderr === null) {
      throw new Error("invalid fake child");
    }
    const stdoutResume = vi.spyOn(child.stdout, "resume");
    const stderrResume = vi.spyOn(child.stderr, "resume");
    const calls: SpawnCall[] = [];
    const envelope = resign(current.envelope, { capsuleArgs: Object.freeze(["--exact", "value"]) });
    const procRoot = temporary();
    writeProcStat(procRoot, "42424", "1");
    writeProcStat(procRoot, "42425", "42424");
    const launcher = createProductionDebugCapsuleLauncher(
      dependencies({ procRoot, spawnProcess: spawnReturning(child.child, calls) }),
    );
    const handle = await launcher(envelope, new AbortController().signal);

    expect(calls).toEqual([
      [
        current.command,
        ["--exact", "value"],
        {
          cwd: "/",
          env: { ...envelope.environment },
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      ],
    ]);
    expect(stdoutResume).toHaveBeenCalledOnce();
    expect(stderrResume).toHaveBeenCalledOnce();
    expect(handle.source).toBe(child.stdout);
    expect(handle.processGroup.pid).toBe(42_424);
    expect(handle.exited()).toBe(false);
    expect(child.stdin.listenerCount("error")).toBe(1);
    expect(child.child.listenerCount("exit")).toBeGreaterThan(0);
    await expect(handle.inspectScope()).resolves.toMatchObject({ descendants: 1, qualified: true });

    const write = vi.spyOn(child.stdin, "write");
    const payload = Buffer.from("Content-Length: 0\r\n\r\n");
    handle.sink.write(payload);
    expect(write).toHaveBeenCalledWith(payload);

    const deferredExit = vi.fn();
    const onExit = vi.fn(() => Promise.resolve());
    handle.whenExited?.(deferredExit);
    handle.onExit?.(onExit);
    expect(deferredExit).not.toHaveBeenCalled();
    child.child.emit("exit", 0, null);
    expect(handle.exited()).toBe(true);
    expect(deferredExit).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(onExit).toHaveBeenCalledOnce();
    });
    const immediateExit = vi.fn();
    handle.whenExited?.(immediateExit);
    expect(immediateExit).toHaveBeenCalledOnce();

    writeFileSync(join(current.runtime, "dap.sock"), "stale", "utf8");
    await handle.cleanup();
    expect(existsSync(join(current.runtime, "dap.sock"))).toBe(false);
    await handle.cleanup();
  });

  it("kills the process group and falls back safely to the direct child", async () => {
    const current = fixture();
    const child = fakeChild();
    const launcher = createProductionDebugCapsuleLauncher(
      dependencies({ spawnProcess: spawnReturning(child.child) }),
    );
    const handle = await launcher(current.envelope, new AbortController().signal);
    const groupKill = vi.spyOn(process, "kill").mockReturnValue(true);
    handle.processGroup.kill("SIGTERM");
    expect(groupKill).toHaveBeenCalledWith(-42_424, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();

    groupKill.mockImplementation(() => {
      throw new Error("no process group");
    });
    await handle.terminateContainment("SIGKILL");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.kill.mockImplementation(() => {
      throw new Error("already exited");
    });
    await expect(handle.terminateContainment("SIGKILL")).resolves.toBeUndefined();
  });

  it.each([
    ["pid", { pid: undefined }],
    ["stdin", { stdin: null }],
    ["stdout", { stdout: null }],
    ["stderr", { stderr: null }],
  ] as const)("rejects a spawned child without required %s state", async (_label, values) => {
    const current = fixture();
    const child = fakeChild(values);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const launcher = createProductionDebugCapsuleLauncher(
      dependencies({ spawnProcess: spawnReturning(child.child) }),
    );
    await expect(launcher(current.envelope, new AbortController().signal)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
    if ("pid" in values) {
      expect(kill).not.toHaveBeenCalled();
    } else {
      expect(kill).toHaveBeenCalledWith(-42_424, "SIGKILL");
    }
  });

  it("normalizes a spawn error, kills containment, and force-cleans a missing socket", async () => {
    const current = fixture();
    const child = fakeChild();
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const launcher = createProductionDebugCapsuleLauncher(
      dependencies({ spawnProcess: spawnReturning(child.child, undefined, "error") }),
    );
    await expect(launcher(current.envelope, new AbortController().signal)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
    expect(kill).toHaveBeenCalledWith(-42_424, "SIGKILL");
  });

  it("parses hostile proc stat names and counts only numeric directory descendants", () => {
    const procRoot = temporary();
    writeProcStat(procRoot, "42424", "1");
    writeProcStat(procRoot, "42425", "42424");
    writeProcStat(procRoot, "42426", "42425");
    writeProcStat(procRoot, "60000", "1");
    writeProcStat(procRoot, "500", "501");
    writeProcStat(procRoot, "501", "500");
    for (const invalid of ["12x", "x12", "1a1", "abc"]) {
      writeProcStat(procRoot, invalid, "42424");
    }
    writeFileSync(join(procRoot, "777"), "not a directory", "utf8");

    writeProcStat(procRoot, "888", "not-a-parent");
    writeProcStat(procRoot, "889", "-2");
    writeProcStat(procRoot, "890", "0");
    expect(debugCapsuleLauncherInternals.processParent(procRoot, "42425")).toBe(42_424);
    expect(debugCapsuleLauncherInternals.processParent(procRoot, "99999")).toBe(-1);
    expect(debugCapsuleLauncherInternals.processParent(procRoot, "888")).toBe(-1);
    expect(debugCapsuleLauncherInternals.processParent(procRoot, "889")).toBe(-1);
    expect(debugCapsuleLauncherInternals.processParent(procRoot, "890")).toBe(0);
    expect(debugCapsuleLauncherInternals.processIdentity(procRoot, "99999")).toBeNull();
    expect(debugCapsuleLauncherInternals.descendantCount(procRoot, 42_424)).toBe(2);
    expect(debugCapsuleLauncherInternals.descendantCount(procRoot, 60_000)).toBe(0);

    const missingParentsRoot = temporary();
    writeProcStat(missingParentsRoot, "700", "999");
    writeProcStat(missingParentsRoot, "701", "998");
    writeProcStat(missingParentsRoot, "702", "997");
    expect(debugCapsuleLauncherInternals.descendantCount(missingParentsRoot, 1)).toBe(0);
  });

  it("fails closed when a process table contains an invalid ancestor identity", () => {
    const processes = new Map([
      [Number.NaN, { pid: Number.NaN, parentPid: 1, startTime: "invalid", state: "S" }],
      [2, { pid: 2, parentPid: 1, startTime: "200", state: "S" }],
      [1, { pid: 1, parentPid: 0, startTime: "100", state: "S" }],
    ]);

    expect(debugCapsuleLauncherInternals.descendantIdentities(processes, 1)).toStrictEqual([]);
  });

  it("parses exact Linux PID and start-time boundaries from variable stat whitespace", () => {
    const procRoot = temporary();
    const fieldsBeforeStartTime = Array.from({ length: 17 }, () => "0").join("   ");
    writeRawProcStat(
      procRoot,
      "1",
      `1 (hostile name)   S   0   ${fieldsBeforeStartTime}   000123   \n`,
    );
    expect(debugCapsuleLauncherInternals.processIdentity(procRoot, "1")).toEqual({
      pid: 1,
      parentPid: 0,
      startTime: "000123",
      state: "S",
    });

    for (const invalidPid of ["0", "1.5", "9007199254740992"]) {
      writeProcStat(procRoot, invalidPid, "1", "200");
      expect(debugCapsuleLauncherInternals.processIdentity(procRoot, invalidPid)).toBeUndefined();
    }
    for (const [pid, startTime] of [
      ["10", "x1"],
      ["11", "1x"],
      ["12", ""],
    ] as const) {
      writeProcStat(procRoot, pid, "1", startTime);
      expect(debugCapsuleLauncherInternals.processIdentity(procRoot, pid)).toBeUndefined();
    }
    writeRawProcStat(procRoot, "13", "13 malformed stat without close delimiter");
    expect(debugCapsuleLauncherInternals.processIdentity(procRoot, "13")).toBeUndefined();
    writeRawProcStat(procRoot, "14", `xS 1 ${fieldsBeforeStartTime} 400`);
    expect(debugCapsuleLauncherInternals.processIdentity(procRoot, "14")).toBeUndefined();
    writeRawProcStat(procRoot, "15", `) S 1 ${fieldsBeforeStartTime} 500`);
    expect(debugCapsuleLauncherInternals.processIdentity(procRoot, "15")).toEqual({
      pid: 15,
      parentPid: 1,
      startTime: "500",
      state: "S",
    });
  });

  it("rejects every non-single-uppercase Linux process state", () => {
    const procRoot = temporary();

    for (const [pid, state] of [
      ["16", "SS"],
      ["17", "s"],
      ["18", "S1"],
    ] as const) {
      writeProcStat(procRoot, pid, "1", "600", state);
      expect(debugCapsuleLauncherInternals.processIdentity(procRoot, pid)).toBeUndefined();
    }
  });

  it("preserves observed descendant identities and proves they disappear after wrapper exit", async () => {
    const current = fixture();
    const procRoot = temporary();
    writeProcStat(procRoot, "42424", "1", "100");
    writeProcStat(procRoot, "42425", "42424", "200");
    const tracker = debugCapsuleLauncherInternals.createLinuxScopeTracker();
    await expect(
      debugCapsuleLauncherInternals.inspectLinuxScope(
        current.envelope,
        42_424,
        false,
        procRoot,
        tracker,
      ),
    ).resolves.toEqual({
      qualified: true,
      backend: "linuxNamespace",
      runtimeIdentityDigest: "c".repeat(64),
      descendants: 1,
    });

    rmSync(join(procRoot, "42424"), { recursive: true });
    writeProcStat(procRoot, "42425", "1", "200");
    await expect(
      debugCapsuleLauncherInternals.inspectLinuxScope(
        current.envelope,
        42_424,
        true,
        procRoot,
        tracker,
      ),
    ).resolves.toMatchObject({ qualified: true, descendants: 1 });

    rmSync(join(procRoot, "42425"), { recursive: true });
    await expect(
      debugCapsuleLauncherInternals.inspectLinuxScope(
        current.envelope,
        42_424,
        true,
        procRoot,
        tracker,
      ),
    ).resolves.toMatchObject({ qualified: true, descendants: 0 });
  });

  it("captures the live scope before an immediate wrapper exit", async () => {
    const current = fixture();
    const child = fakeChild();
    const procRoot = temporary();
    writeProcStat(procRoot, "42424", "1", "100");
    const launcher = createProductionDebugCapsuleLauncher(
      dependencies({ procRoot, spawnProcess: spawnReturning(child.child) }),
    );
    const handle = await launcher(current.envelope, new AbortController().signal);

    child.child.emit("exit", 0, null);
    rmSync(join(procRoot, "42424"), { recursive: true });

    await expect(handle.inspectScope()).resolves.toMatchObject({
      qualified: true,
      descendants: 0,
    });
  });

  it("fails closed without a pre-exit scope observation or readable process table", async () => {
    const current = fixture();
    const procRoot = temporary();
    writeProcStat(procRoot, "42424", "1", "100");
    await expect(
      debugCapsuleLauncherInternals.inspectLinuxScope(current.envelope, 42_424, true, procRoot),
    ).resolves.toMatchObject({ qualified: false, descendants: -1 });

    rmSync(join(procRoot, "42424"), { recursive: true });
    writeProcStat(procRoot, "50000", "1", "300");
    await expect(
      debugCapsuleLauncherInternals.inspectLinuxScope(current.envelope, 42_424, false, procRoot),
    ).resolves.toMatchObject({ qualified: false, descendants: -1 });
    expect(() =>
      debugCapsuleLauncherInternals.inspectLinuxScope(
        current.envelope,
        42_424,
        false,
        join(procRoot, "missing"),
      ),
    ).toThrow(Error);
  });

  it("does not mistake PID reuse for a surviving observed descendant", async () => {
    const current = fixture();
    const procRoot = temporary();
    writeProcStat(procRoot, "42424", "1", "100");
    writeProcStat(procRoot, "42425", "42424", "200");
    const tracker = debugCapsuleLauncherInternals.createLinuxScopeTracker();
    await debugCapsuleLauncherInternals.inspectLinuxScope(
      current.envelope,
      42_424,
      false,
      procRoot,
      tracker,
    );
    rmSync(join(procRoot, "42424"), { recursive: true });
    writeProcStat(procRoot, "42425", "1", "201");
    await expect(
      debugCapsuleLauncherInternals.inspectLinuxScope(
        current.envelope,
        42_424,
        true,
        procRoot,
        tracker,
      ),
    ).resolves.toMatchObject({ qualified: true, descendants: 0 });
  });

  it("does not retain an observed zombie as a live capsule descendant", async () => {
    const current = fixture();
    const procRoot = temporary();
    writeProcStat(procRoot, "42424", "1", "100");
    writeProcStat(procRoot, "42425", "42424", "200");
    const tracker = debugCapsuleLauncherInternals.createLinuxScopeTracker();
    await debugCapsuleLauncherInternals.inspectLinuxScope(
      current.envelope,
      42_424,
      false,
      procRoot,
      tracker,
    );
    rmSync(join(procRoot, "42424"), { recursive: true });
    writeProcStat(procRoot, "42425", "1", "200", "Z");

    await expect(
      debugCapsuleLauncherInternals.inspectLinuxScope(
        current.envelope,
        42_424,
        true,
        procRoot,
        tracker,
      ),
    ).resolves.toMatchObject({ qualified: true, descendants: 0 });
  });

  it("kills only currently matching observed descendants after a wrapper exits", async () => {
    const current = fixture();
    const procRoot = temporary();
    writeProcStat(procRoot, "42424", "1", "100");
    writeProcStat(procRoot, "42425", "42424", "200");
    writeProcStat(procRoot, "42426", "42424", "300");
    const tracker = debugCapsuleLauncherInternals.createLinuxScopeTracker();
    await debugCapsuleLauncherInternals.inspectLinuxScope(
      current.envelope,
      42_424,
      false,
      procRoot,
      tracker,
    );
    rmSync(join(procRoot, "42424"), { recursive: true });
    writeProcStat(procRoot, "42425", "1", "200");
    writeProcStat(procRoot, "42426", "1", "301");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    debugCapsuleLauncherInternals.terminateObservedLinuxDescendants(tracker, procRoot);

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(42_425, "SIGKILL");
  });

  it("bounds the settle wait when a killed descendant remains visible", async () => {
    vi.useFakeTimers();
    try {
      const current = fixture();
      const child = fakeChild();
      const procRoot = temporary();
      writeProcStat(procRoot, "42424", "1", "100");
      writeProcStat(procRoot, "42425", "42424", "200");
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      const launcher = createProductionDebugCapsuleLauncher(
        dependencies({ procRoot, spawnProcess: spawnReturning(child.child) }),
      );
      const handle = await launcher(current.envelope, new AbortController().signal);
      let settled = false;
      const terminating = handle.terminateContainment("SIGKILL").then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await terminating;

      expect(settled).toBe(true);
      expect(kill).toHaveBeenCalledWith(-42_424, "SIGKILL");
      expect(kill).toHaveBeenCalledWith(42_425, "SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not dereference a disappeared observed PID while terminating matching identities", async () => {
    const current = fixture();
    const procRoot = temporary();
    writeProcStat(procRoot, "42424", "1", "100");
    writeProcStat(procRoot, "42425", "42424", "200");
    writeProcStat(procRoot, "42426", "42424", "300");
    const tracker = debugCapsuleLauncherInternals.createLinuxScopeTracker();
    await debugCapsuleLauncherInternals.inspectLinuxScope(
      current.envelope,
      42_424,
      false,
      procRoot,
      tracker,
    );
    rmSync(join(procRoot, "42425"), { recursive: true });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    expect(() => {
      debugCapsuleLauncherInternals.terminateObservedLinuxDescendants(tracker, procRoot);
    }).not.toThrow();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(42_426, "SIGKILL");
  });

  it("rejects root PID reuse and malformed process identities before exit", async () => {
    const current = fixture();
    const procRoot = temporary();
    writeProcStat(procRoot, "42424", "1", "100");
    const tracker = debugCapsuleLauncherInternals.createLinuxScopeTracker();
    await expect(
      debugCapsuleLauncherInternals.inspectLinuxScope(
        current.envelope,
        42_424,
        false,
        procRoot,
        tracker,
      ),
    ).resolves.toMatchObject({ qualified: true });
    await expect(
      debugCapsuleLauncherInternals.inspectLinuxScope(
        current.envelope,
        42_424,
        false,
        procRoot,
        tracker,
      ),
    ).resolves.toMatchObject({ qualified: true, descendants: 0 });
    writeProcStat(procRoot, "42424", "1", "101");
    await expect(
      debugCapsuleLauncherInternals.inspectLinuxScope(
        current.envelope,
        42_424,
        false,
        procRoot,
        tracker,
      ),
    ).resolves.toMatchObject({ qualified: false, descendants: -1 });

    writeFileSync(join(procRoot, "42424", "stat"), "malformed", "utf8");
    expect(debugCapsuleLauncherInternals.processIdentity(procRoot, "42424")).toBeUndefined();
  });

  it("retains exact qualification checks while using persistent scope evidence", async () => {
    const current = fixture();
    const procRoot = temporary();
    writeProcStat(procRoot, "42424", "1");
    await expect(
      debugCapsuleLauncherInternals.inspectLinuxScope(
        resign(current.envelope, { backend: "oci" }),
        42_424,
        false,
        procRoot,
      ),
    ).resolves.toMatchObject({ qualified: false, backend: "oci" });
    await expect(
      debugCapsuleLauncherInternals.inspectLinuxScope(
        resign(current.envelope, { capsuleCommand: `${current.command}-forged` }),
        42_424,
        false,
        procRoot,
      ),
    ).resolves.toMatchObject({ qualified: false });
    await expect(
      debugCapsuleLauncherInternals.inspectLinuxScope(
        envelopeWithArtifacts(current.envelope, []),
        42_424,
        false,
        procRoot,
      ),
    ).resolves.toMatchObject({ qualified: false });
  });

  linuxIt("observes the authoritative live Linux proc scope", async () => {
    const current = fixture();
    const launcher = createProductionDebugCapsuleLauncher(dependencies());
    const handle = await launcher(current.envelope, new AbortController().signal);
    await expect(handle.inspectScope()).resolves.toMatchObject({
      qualified: true,
      backend: "linuxNamespace",
      runtimeIdentityDigest: "c".repeat(64),
    });
    await handle.terminateContainment("SIGKILL");
    await vi.waitFor(() => {
      expect(handle.exited()).toBe(true);
    });
    await expect(handle.inspectScope()).resolves.toMatchObject({
      qualified: true,
      descendants: 0,
    });
  });
});
