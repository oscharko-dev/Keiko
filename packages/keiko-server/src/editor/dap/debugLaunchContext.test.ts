import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import type { CommandTask, CommandTaskCatalog } from "@oscharko-dev/keiko-contracts";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DebugCapsuleLayer2Input, DebugSpawnEnvelope } from "./debugCapsulePlan.js";
import type { ApprovedDebugArtifact } from "./debugLaunchPlan.js";
import {
  createProductionDebugLaunchContextResolver,
  createProductionDebugTargetRevalidator,
  debugLaunchContextTestBoundary,
  qualifyProductionDebugBackend,
  type DebugLaunchContextResolverDeps,
  type DebugProvisionedArtifact,
} from "./debugLaunchContext.js";

const roots: string[] = [];

function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function executable(root: string, name: string, content = "#!/bin/sh\nexit 0\n"): string {
  const path = join(root, name);
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function provisioned(path: string, capsulePath: string): DebugProvisionedArtifact {
  return { hostPath: path, approvedRoot: join(path, ".."), capsulePath };
}

function fixture(): {
  readonly deps: DebugLaunchContextResolverDeps;
  readonly input: DebugCapsuleLayer2Input;
  readonly workspace: string;
  readonly runtimeRoot: string;
} {
  const workspace = temporary("kdc-w-");
  writeFileSync(join(workspace, "app.js"), "alpha", "utf8");
  writeFileSync(join(workspace, "package.json"), "{}", "utf8");
  const approved = temporary("kdc-a-");
  const runtimeRoot = temporary("kdc-r-");
  chmodSync(runtimeRoot, 0o700);
  const runtime = mkdtempSync(join(runtimeRoot, "s-"));
  chmodSync(runtime, 0o700);
  mkdirSync(join(runtime, "home"), { mode: 0o700 });
  mkdirSync(join(runtime, "tmp"), { mode: 0o700 });
  const adapter = executable(approved, "adapter");
  const npmUserConfig = join(approved, "npm-user-config");
  const npmGlobalConfig = join(approved, "npm-global-config");
  writeFileSync(npmUserConfig, "", "utf8");
  writeFileSync(npmGlobalConfig, "", "utf8");
  const backend = executable(
    approved,
    "bwrap",
    `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  [ -z "\${KEIKO_HOSTILE_CONTEXT+x}" ] || exit 60
  printf 'BUBBLEWRAP  12.34.56\\n'
  exit 0
fi
[ -z "\${KEIKO_HOSTILE_CONTEXT+x}" ] || exit 61
if [ -d /lib64 ]; then
  [ "$#" -eq 35 ] || exit 41
  [ "\${24}" = "--dir" ] && [ "\${25}" = "/lib64" ] || exit 53
  [ "\${26}" = "--ro-bind" ] && [ "\${27}" = "/lib64" ] && [ "\${28}" = "/lib64" ] || exit 54
else
  [ "$#" -eq 30 ] || exit 41
fi
[ "$1" = "--unshare-net" ] || exit 42
[ "$2" = "--unshare-pid" ] || exit 43
[ "$3" = "--die-with-parent" ] || exit 44
[ "$4" = "--new-session" ] || exit 45
[ "$5" = "--dir" ] && [ "$6" = "/run" ] || exit 46
[ "$7" = "--dir" ] && [ "$8" = "/run/keiko-debug" ] || exit 47
[ "\${16}" = "--ro-bind" ] && [ "\${17}" = "/bin/sh" ] && [ "\${18}" = "/bin/sh" ] || exit 52
runtime=""
previous=""
for argument in "$@"; do
  if [ "$argument" = "/run/keiko-debug" ] && [ -d "$previous" ]; then runtime="$previous"; fi
  previous="$argument"
done
[ -n "$runtime" ] || exit 48
printf qualified > "$runtime/.qualification-probe"
`,
  );
  const closure = join(approved, "closure");
  mkdirSync(join(closure, "nested"), { recursive: true });
  writeFileSync(join(closure, "zeta.so"), "zeta", "utf8");
  writeFileSync(join(closure, "äther.so"), "aether", "utf8");
  writeFileSync(join(closure, "library.so"), "library", "utf8");
  writeFileSync(join(closure, "nested", "loader"), "loader", "utf8");
  const environment = Object.freeze({
    HOME: "/run/keiko-debug/home",
    USERPROFILE: "/run/keiko-debug/home",
    PATH: "/opt/keiko-runtime",
    TMPDIR: "/run/keiko-debug/tmp",
    TEMP: "/run/keiko-debug/tmp",
    TMP: "/run/keiko-debug/tmp",
  });
  const backendArtifact = provisioned(backend, "/opt/keiko-backend/bwrap");
  const backendQualification = qualifyProductionDebugBackend({
    backend: backendArtifact,
    platform: "linux",
  });
  return {
    workspace,
    runtimeRoot,
    deps: {
      workspaceRoot: workspace,
      workspaceTrusted: true,
      projectId: "project_a",
      fs: nodeWorkspaceFs,
      discover: () => ({ schemaVersion: "1", projectId: "project_a", tasks: [] }),
      adapterApprovedRoot: approved,
      node: provisioned(executable(approved, "node"), "/opt/keiko-runtime/node"),
      npm: provisioned(executable(approved, "npm"), "/opt/keiko-runtime/npm/bin/npm-cli.js"),
      shell: provisioned(executable(approved, "shell"), "/opt/keiko-runtime/shell"),
      npmUserConfig: provisioned(npmUserConfig, "/opt/keiko-debug/npm-user-config"),
      npmGlobalConfig: provisioned(npmGlobalConfig, "/opt/keiko-debug/npm-global-config"),
      backend: backendArtifact,
      backendQualification,
      runtimeClosure: [provisioned(closure, "/opt/keiko-runtime/lib")],
      platform: "linux",
      layer1Allowed: () => true,
    },
    input: {
      candidate: { kind: "file", fileId: "app.js" },
      binding: {
        workspacePartitionKey: "project_a",
        activationRevision: 4,
        targetKind: "file",
      },
      adapter: {
        providerId: "node",
        executable: adapter,
        args: ["--server", "/run/keiko-debug/dap.sock"],
        env: environment,
        home: join(runtime, "home"),
        temp: runtime,
        runtimeRoot,
      },
    },
  };
}

function expectedArtifact(artifact: DebugProvisionedArtifact): ApprovedDebugArtifact {
  const realPath = realpathSync(artifact.hostPath);
  const stat = lstatSync(realPath);
  return {
    hostPath: artifact.hostPath,
    realPath,
    approvedRoot: realpathSync(artifact.approvedRoot),
    capsulePath: artifact.capsulePath,
    identityDigest: createHash("sha256").update(readFileSync(realPath)).digest("hex"),
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mode: stat.mode,
    ownerUid: stat.uid,
  };
}

function backendIdentityDrifts(artifact: ApprovedDebugArtifact): readonly ApprovedDebugArtifact[] {
  return [
    { ...artifact, realPath: `${artifact.realPath}.drift` },
    { ...artifact, approvedRoot: `${artifact.approvedRoot}.drift` },
    { ...artifact, capsulePath: `${artifact.capsulePath}.drift` },
    { ...artifact, identityDigest: "b".repeat(64) },
    { ...artifact, device: artifact.device + 1 },
    { ...artifact, inode: artifact.inode + 1 },
    { ...artifact, size: artifact.size + 1 },
    { ...artifact, mode: artifact.mode + 1 },
    { ...artifact, ownerUid: artifact.ownerUid + 1 },
  ];
}

function catalogTask(name: string): CommandTask {
  return {
    id: `npm-script:${name}`,
    kind: "run",
    label: `npm run ${name}`,
    executable: "npm",
    args: ["run", name],
    source: "package-json-script",
    trustState: "trusted",
    trustReason: "repository-authored-script",
  };
}

async function unixSocket(path: string): Promise<() => Promise<void>> {
  const server = createServer();
  server.listen(path);
  await once(server, "listening");
  return async (): Promise<void> => {
    server.close();
    await once(server, "close");
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production debug launch context resolution", () => {
  it("mounts the x64 dynamic-loader root only when the host provides it", () => {
    const present = debugLaunchContextTestBoundary.qualificationSystemLibraryArguments(
      (path) => path === "/lib64",
    );
    const absent = debugLaunchContextTestBoundary.qualificationSystemLibraryArguments(() => false);

    expect(present).toStrictEqual(["--dir", "/lib64", "--ro-bind", "/lib64", "/lib64"]);
    expect(absent).toStrictEqual([]);
  });

  it("binds fixed capsule paths when the production module is loaded fresh", async () => {
    const current = fixture();
    vi.resetModules();
    const freshModule = await import("./debugLaunchContext.js");
    const context = await freshModule.createProductionDebugLaunchContextResolver(current.deps)(
      current.input,
    );
    expect({
      hostSocketPath: context.hostSocketPath,
      capsuleRuntimeDirectory: context.capsuleRuntimeDirectory,
      capsuleSocketPath: context.capsuleSocketPath,
      npmUserConfig: context.npmUserConfig.capsulePath,
      npmGlobalConfig: context.npmGlobalConfig.capsulePath,
    }).toStrictEqual({
      hostSocketPath: join(realpathSync(current.input.adapter.temp), "dap.sock"),
      capsuleRuntimeDirectory: "/run/keiko-debug",
      capsuleSocketPath: "/run/keiko-debug/dap.sock",
      npmUserConfig: "/opt/keiko-debug/npm-user-config",
      npmGlobalConfig: "/opt/keiko-debug/npm-global-config",
    });
  });

  it("observes real identities, probes the exact backend, and expands runtime trees", async () => {
    const current = fixture();
    const context = await createProductionDebugLaunchContextResolver(current.deps)(current.input);
    const runtime = realpathSync(current.input.adapter.temp);
    const runtimeStat = lstatSync(runtime);
    const workspace = realpathSync(current.workspace);
    const workspaceStat = lstatSync(workspace);
    expect(context).toMatchObject({
      workspaceRoot: current.workspace,
      canonicalWorkspaceRoot: workspace,
      workspaceTrusted: true,
      projectId: "project_a",
      platform: "linux",
      availability: {
        bubblewrap: true,
        unshare: false,
        seatbelt: false,
        docker: false,
        podman: false,
      },
      hostRuntimeDirectory: runtime,
      runtimeRoot: realpathSync(current.runtimeRoot),
      hostSocketPath: join(runtime, "dap.sock"),
      capsuleRuntimeDirectory: "/run/keiko-debug",
      capsuleSocketPath: "/run/keiko-debug/dap.sock",
      workspaceIdentity: {
        realPath: workspace,
        identityDigest: createHash("sha256")
          .update(
            JSON.stringify([
              workspace,
              workspaceStat.dev,
              workspaceStat.ino,
              workspaceStat.mode,
              workspaceStat.uid,
            ]),
          )
          .digest("hex"),
        device: workspaceStat.dev,
        inode: workspaceStat.ino,
        mode: workspaceStat.mode,
        ownerUid: workspaceStat.uid,
      },
      runtimeMount: {
        hostRealPath: runtime,
        mode: "0700",
        owner: "currentUser",
        symlink: false,
        identityDigest: createHash("sha256")
          .update(
            JSON.stringify([
              runtime,
              runtimeStat.dev,
              runtimeStat.ino,
              runtimeStat.mode,
              runtimeStat.uid,
            ]),
          )
          .digest("hex"),
        device: runtimeStat.dev,
        inode: runtimeStat.ino,
        modeBits: runtimeStat.mode,
        ownerUid: runtimeStat.uid,
      },
    });
    expect(context.backendExecutable).toStrictEqual(expectedArtifact(current.deps.backend));
    expect(context.adapter).toStrictEqual(
      expectedArtifact(provisioned(current.input.adapter.executable, "/opt/keiko-debug/adapter")),
    );
    expect(context.node).toStrictEqual(expectedArtifact(current.deps.node));
    expect(context.npm).toStrictEqual(expectedArtifact(current.deps.npm));
    expect(context.shell).toStrictEqual(expectedArtifact(current.deps.shell));
    expect(context.runtimeClosure.map((artifact) => artifact.capsulePath)).toStrictEqual([
      "/opt/keiko-runtime/lib/äther.so",
      "/opt/keiko-runtime/lib/library.so",
      "/opt/keiko-runtime/lib/nested/loader",
      "/opt/keiko-runtime/lib/zeta.so",
    ]);
    const closureRoot = current.deps.runtimeClosure[0];
    if (closureRoot === undefined) throw new Error("missing fixture closure");
    expect(context.runtimeClosure).toStrictEqual([
      expectedArtifact({
        hostPath: join(realpathSync(closureRoot.hostPath), "äther.so"),
        approvedRoot: closureRoot.approvedRoot,
        capsulePath: "/opt/keiko-runtime/lib/äther.so",
      }),
      expectedArtifact({
        hostPath: join(realpathSync(closureRoot.hostPath), "library.so"),
        approvedRoot: closureRoot.approvedRoot,
        capsulePath: "/opt/keiko-runtime/lib/library.so",
      }),
      expectedArtifact({
        hostPath: join(realpathSync(closureRoot.hostPath), "nested", "loader"),
        approvedRoot: closureRoot.approvedRoot,
        capsulePath: "/opt/keiko-runtime/lib/nested/loader",
      }),
      expectedArtifact({
        hostPath: join(realpathSync(closureRoot.hostPath), "zeta.so"),
        approvedRoot: closureRoot.approvedRoot,
        capsulePath: "/opt/keiko-runtime/lib/zeta.so",
      }),
    ]);
    const second = await createProductionDebugLaunchContextResolver(current.deps)(current.input);
    expect(second.runtimeClosure).toStrictEqual(context.runtimeClosure);
    expect(context.runtimeClosure.every((artifact) => artifact.identityDigest.length === 64)).toBe(
      true,
    );
    expect(context.environment).toStrictEqual(current.input.adapter.env);
    expect(context.npmUserConfig).toMatchObject({
      capsulePath: "/opt/keiko-debug/npm-user-config",
      size: 0,
    });
    expect(context.npmGlobalConfig).toMatchObject({
      capsulePath: "/opt/keiko-debug/npm-global-config",
      size: 0,
    });
    expect(context.npmUserConfig.identityDigest).toBe(context.npmGlobalConfig.identityDigest);
    expect(context.npmUserConfig.realPath).not.toBe(context.npmGlobalConfig.realPath);
    expect(context.npmUserConfig).toStrictEqual(expectedArtifact(current.deps.npmUserConfig));
    expect(context.npmGlobalConfig).toStrictEqual(expectedArtifact(current.deps.npmGlobalConfig));
    expect(context.fs).toBe(current.deps.fs);
    expect(context.discover).toBe(current.deps.discover);
    expect(context.layer1Allowed).toBe(current.deps.layer1Allowed);
    expect(context.containerImage).toBeUndefined();
    expect(JSON.stringify(context.environment)).not.toContain(current.input.adapter.temp);
  });

  it("does not inherit hostile host environment during either backend probe", async () => {
    const current = fixture();
    const previous = process.env.KEIKO_HOSTILE_CONTEXT;
    process.env.KEIKO_HOSTILE_CONTEXT = "must-not-cross";
    try {
      const context = await createProductionDebugLaunchContextResolver(current.deps)(current.input);
      expect(context.availability.bubblewrap).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.KEIKO_HOSTILE_CONTEXT;
      else process.env.KEIKO_HOSTILE_CONTEXT = previous;
    }
  });

  it("rejects workspace/runtime overlap and a runtime directory that is not a strict child", async () => {
    const overlap = fixture();
    await expect(
      createProductionDebugLaunchContextResolver({
        ...overlap.deps,
      })({
        ...overlap.input,
        adapter: { ...overlap.input.adapter, runtimeRoot: overlap.workspace },
      }),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");

    const equal = fixture();
    await expect(
      createProductionDebugLaunchContextResolver(equal.deps)({
        ...equal.input,
        adapter: { ...equal.input.adapter, temp: equal.runtimeRoot },
      }),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");
  });

  it("rejects a runtime root that contains the workspace even when its session is disjoint", async () => {
    const current = fixture();
    const sharedRoot = temporary("kdc-containing-root-");
    chmodSync(sharedRoot, 0o700);
    const workspace = join(sharedRoot, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "app.js"), "alpha", "utf8");
    writeFileSync(join(workspace, "package.json"), "{}", "utf8");
    const runtime = join(sharedRoot, "session");
    mkdirSync(join(runtime, "home"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtime, "tmp"), { mode: 0o700 });
    chmodSync(runtime, 0o700);
    await expect(
      createProductionDebugLaunchContextResolver({ ...current.deps, workspaceRoot: workspace })({
        ...current.input,
        adapter: {
          ...current.input.adapter,
          runtimeRoot: sharedRoot,
          temp: runtime,
          home: join(runtime, "home"),
        },
      }),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");
  });

  it("rejects an unqualified or symlinked runtime root", async () => {
    const wrongMode = fixture();
    chmodSync(wrongMode.runtimeRoot, 0o755);
    await expect(
      createProductionDebugLaunchContextResolver(wrongMode.deps)(wrongMode.input),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");

    const linked = fixture();
    const link = join(temporary("kdc-l-"), "runtime-root");
    symlinkSync(linked.runtimeRoot, link, "dir");
    await expect(
      createProductionDebugLaunchContextResolver(linked.deps)({
        ...linked.input,
        adapter: { ...linked.input.adapter, runtimeRoot: link },
      }),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");
  });

  it("rejects a non-directory runtime root and an unqualified session directory", async () => {
    const rootFile = fixture();
    const file = join(temporary("kdc-root-file-"), "runtime");
    writeFileSync(file, "not-a-directory", "utf8");
    await expect(
      createProductionDebugLaunchContextResolver(rootFile.deps)({
        ...rootFile.input,
        adapter: { ...rootFile.input.adapter, runtimeRoot: file },
      }),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");

    const wrongSessionMode = fixture();
    chmodSync(wrongSessionMode.input.adapter.temp, 0o755);
    await expect(
      createProductionDebugLaunchContextResolver(wrongSessionMode.deps)(wrongSessionMode.input),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");

    const sessionFile = fixture();
    rmSync(sessionFile.input.adapter.temp, { recursive: true });
    writeFileSync(sessionFile.input.adapter.temp, "not-a-directory", "utf8");
    chmodSync(sessionFile.input.adapter.temp, 0o700);
    await expect(
      createProductionDebugLaunchContextResolver(sessionFile.deps)(sessionFile.input),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");
  });

  it("rejects runtime ownership drift at allocation and final mount inspection", async () => {
    const allocation = fixture();
    const actualUid = process.getuid?.();
    if (actualUid === undefined) throw new Error("POSIX test requires getuid");
    vi.spyOn(process, "getuid")
      .mockReturnValueOnce(actualUid + 1)
      .mockReturnValue(actualUid);
    await expect(
      createProductionDebugLaunchContextResolver(allocation.deps)(allocation.input),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");
    vi.restoreAllMocks();

    const finalInspection = fixture();
    vi.spyOn(process, "getuid")
      .mockReturnValueOnce(actualUid)
      .mockReturnValueOnce(actualUid + 1);
    await expect(
      createProductionDebugLaunchContextResolver(finalInspection.deps)(finalInspection.input),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");
  });

  it("fails closed when the platform cannot prove the current POSIX uid", async () => {
    const current = fixture();
    const platformProcess = Object.create(process) as NodeJS.Process;
    Object.defineProperty(platformProcess, "getuid", { value: undefined });
    vi.stubGlobal("process", platformProcess);
    await expect(
      createProductionDebugLaunchContextResolver(current.deps)(current.input),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");
  });

  it("rejects wrong, symlinked, or unqualified private HOME and TMP layouts", async () => {
    const wrongHome = fixture();
    const otherHome = temporary("kdc-home-");
    chmodSync(otherHome, 0o700);
    await expect(
      createProductionDebugLaunchContextResolver(wrongHome.deps)({
        ...wrongHome.input,
        adapter: { ...wrongHome.input.adapter, home: otherHome },
      }),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");

    const linkedHome = fixture();
    const homeLink = join(temporary("kdc-home-link-"), "home");
    symlinkSync(linkedHome.input.adapter.home, homeLink, "dir");
    await expect(
      createProductionDebugLaunchContextResolver(linkedHome.deps)({
        ...linkedHome.input,
        adapter: { ...linkedHome.input.adapter, home: homeLink },
      }),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");

    const wrongTemp = fixture();
    chmodSync(join(wrongTemp.input.adapter.temp, "tmp"), 0o755);
    await expect(
      createProductionDebugLaunchContextResolver(wrongTemp.deps)(wrongTemp.input),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");

    const linkedTemp = fixture();
    const tempTarget = temporary("kdc-temp-target-");
    chmodSync(tempTarget, 0o700);
    rmSync(join(linkedTemp.input.adapter.temp, "tmp"), { recursive: true });
    symlinkSync(tempTarget, join(linkedTemp.input.adapter.temp, "tmp"), "dir");
    await expect(
      createProductionDebugLaunchContextResolver(linkedTemp.deps)(linkedTemp.input),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");

    const unqualifiedHome = fixture();
    chmodSync(unqualifiedHome.input.adapter.home, 0o755);
    await expect(
      createProductionDebugLaunchContextResolver(unqualifiedHome.deps)(unqualifiedHome.input),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");

    const homeFile = fixture();
    rmSync(homeFile.input.adapter.home, { recursive: true });
    writeFileSync(homeFile.input.adapter.home, "not-a-directory", "utf8");
    chmodSync(homeFile.input.adapter.home, 0o700);
    await expect(
      createProductionDebugLaunchContextResolver(homeFile.deps)(homeFile.input),
    ).rejects.toThrow("INVALID_DEBUG_RUNTIME");
  });

  it("rejects a symlink in a recursively provisioned runtime closure", async () => {
    const current = fixture();
    const hostileRoot = temporary("kdc-h-");
    const target = executable(hostileRoot, "target");
    const closure = join(hostileRoot, "closure");
    mkdirSync(closure);
    symlinkSync(target, join(closure, "link"));
    await expect(
      createProductionDebugLaunchContextResolver({
        ...current.deps,
        runtimeClosure: [provisioned(closure, "/opt/keiko-runtime/lib")],
      })(current.input),
    ).rejects.toThrow("INVALID_DEBUG_ARTIFACT");
  });

  it("rejects a provisioned artifact that escapes its approved root through a symlink", async () => {
    const current = fixture();
    const hostile = executable(temporary("kdc-x-"), "node");
    const linkedNode = join(temporary("kdc-link-"), "node");
    symlinkSync(hostile, linkedNode, "file");
    await expect(
      createProductionDebugLaunchContextResolver({
        ...current.deps,
        node: provisioned(linkedNode, "/opt/keiko-runtime/node"),
      })(current.input),
    ).rejects.toThrow("INVALID_DEBUG_ARTIFACT");
  });

  it("rejects direct artifact escapes, approved-root equality, and non-files", async () => {
    const escaped = fixture();
    const hostile = executable(temporary("kdc-outside-"), "node");
    await expect(
      createProductionDebugLaunchContextResolver({
        ...escaped.deps,
        node: { ...escaped.deps.node, hostPath: hostile },
      })(escaped.input),
    ).rejects.toThrow("INVALID_DEBUG_ARTIFACT");

    const equal = fixture();
    await expect(
      createProductionDebugLaunchContextResolver({
        ...equal.deps,
        node: { ...equal.deps.node, approvedRoot: equal.deps.node.hostPath },
      })(equal.input),
    ).rejects.toThrow("INVALID_DEBUG_ARTIFACT");

    const directory = fixture();
    await expect(
      createProductionDebugLaunchContextResolver({
        ...directory.deps,
        node: provisioned(temporary("kdc-dir-"), "/opt/keiko-runtime/node"),
      })(directory.input),
    ).rejects.toThrow("INVALID_DEBUG_ARTIFACT");
  });

  it("rejects a symlinked runtime-closure root", async () => {
    const current = fixture();
    const approvedRoot = temporary("kdc-closure-root-");
    const closure = join(approvedRoot, "closure");
    mkdirSync(closure);
    writeFileSync(join(closure, "library.so"), "library", "utf8");
    const link = join(approvedRoot, "closure-link");
    symlinkSync(closure, link, "dir");
    await expect(
      createProductionDebugLaunchContextResolver({
        ...current.deps,
        runtimeClosure: [{ hostPath: link, approvedRoot, capsulePath: "/opt/keiko-runtime/lib" }],
      })(current.input),
    ).rejects.toThrow("INVALID_DEBUG_ARTIFACT");
  });

  it("rejects a non-file, non-directory runtime artifact", async () => {
    const current = fixture();
    const root = temporary("kdc-socket-");
    const socket = join(root, "runtime.sock");
    const close = await unixSocket(socket);
    try {
      await expect(
        createProductionDebugLaunchContextResolver({
          ...current.deps,
          runtimeClosure: [provisioned(socket, "/opt/keiko-runtime/runtime.sock")],
        })(current.input),
      ).rejects.toThrow("INVALID_DEBUG_ARTIFACT");
    } finally {
      await close();
    }
  });

  it("rejects non-empty or incorrectly mounted npm configuration artifacts", async () => {
    const nonEmpty = fixture();
    writeFileSync(nonEmpty.deps.npmUserConfig.hostPath, "script-shell=/hostile", "utf8");
    await expect(
      createProductionDebugLaunchContextResolver(nonEmpty.deps)(nonEmpty.input),
    ).rejects.toThrow("INVALID_DEBUG_ARTIFACT");

    const wrongMount = fixture();
    await expect(
      createProductionDebugLaunchContextResolver({
        ...wrongMount.deps,
        npmGlobalConfig: {
          ...wrongMount.deps.npmGlobalConfig,
          capsulePath: "/run/keiko-debug/npm-global-config",
        },
      })(wrongMount.input),
    ).rejects.toThrow("INVALID_DEBUG_ARTIFACT");
  });

  it("rejects a fake bwrap that merely exits zero", () => {
    const fake = executable(temporary("kdc-f-"), "bwrap", "#!/bin/sh\nexit 0\n");
    expect(() =>
      qualifyProductionDebugBackend({
        backend: provisioned(fake, "/opt/keiko-backend/bwrap"),
        platform: "linux",
      }),
    ).toThrow("INVALID_DEBUG_BACKEND");
  });

  // This test performs 6 real spawnSync subprocess invocations plus repeated mkdtemp/chmod/rm
  // cycles (fixture() x6, qualifyProductionDebugBackend x5). That is legitimately slower than the
  // vitest.config.ts default (15s) under CI/concurrent-suite load even though it is not otherwise
  // flaky (~1.8s in isolation) — an explicit ceiling avoids a spurious timeout, matching the same
  // pattern used for other subprocess-heavy tests in this repo (e.g. egress.test.ts, evaluate.test.ts).
  it("rejects bwrap on a non-Linux platform and malformed version evidence", () => {
    const nonLinux = fixture();
    expect(() =>
      qualifyProductionDebugBackend({ backend: nonLinux.deps.backend, platform: "darwin" }),
    ).toThrow("INVALID_DEBUG_BACKEND");

    for (const version of [
      "bubblewrap 1",
      "bubblewrap 1.",
      "not-bubblewrap 12.34",
      "prefix bubblewrap 12.34",
      "bubblewrap 12.34 trailing",
    ]) {
      const current = fixture();
      const source = readFileSync(current.deps.backend.hostPath, "utf8").replace(
        "BUBBLEWRAP  12.34.56",
        version,
      );
      const fake = executable(temporary("kdc-version-"), "bwrap", source);
      expect(() =>
        qualifyProductionDebugBackend({
          backend: provisioned(fake, "/opt/keiko-backend/bwrap"),
          platform: "linux",
        }),
      ).toThrow("INVALID_DEBUG_BACKEND");
    }
  }, 30_000);

  it("rejects backend execution errors, non-zero probes, and missing probe markers", () => {
    const missingInterpreter = executable(
      temporary("kdc-error-"),
      "bwrap",
      "#!/missing/interpreter\n",
    );
    expect(() =>
      qualifyProductionDebugBackend({
        backend: provisioned(missingInterpreter, "/opt/keiko-backend/bwrap"),
        platform: "linux",
      }),
    ).toThrow("INVALID_DEBUG_BACKEND");

    const rejectedVersion = executable(
      temporary("kdc-version-status-"),
      "bwrap",
      "#!/bin/sh\nprintf 'bubblewrap 12.34\\n'\nexit 1\n",
    );
    expect(() =>
      qualifyProductionDebugBackend({
        backend: provisioned(rejectedVersion, "/opt/keiko-backend/bwrap"),
        platform: "linux",
      }),
    ).toThrow("INVALID_DEBUG_BACKEND");

    const selfDeleting = executable(
      temporary("kdc-self-delete-"),
      "bwrap",
      "#!/bin/sh\nprintf 'bubblewrap 12.34\\n'\nrm \"$0\"\n",
    );
    expect(() =>
      qualifyProductionDebugBackend({
        backend: provisioned(selfDeleting, "/opt/keiko-backend/bwrap"),
        platform: "linux",
      }),
    ).toThrow("INVALID_DEBUG_BACKEND");

    const failingProbe = executable(
      temporary("kdc-nonzero-"),
      "bwrap",
      `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'bubblewrap 12.34\\n'; exit 0; fi
runtime=""
previous=""
for argument in "$@"; do
  if [ "$argument" = "/run/keiko-debug" ] && [ -d "$previous" ]; then runtime="$previous"; fi
  previous="$argument"
done
printf qualified > "$runtime/.qualification-probe"
exit 1
`,
    );
    expect(() =>
      qualifyProductionDebugBackend({
        backend: provisioned(failingProbe, "/opt/keiko-backend/bwrap"),
        platform: "linux",
      }),
    ).toThrow("INVALID_DEBUG_BACKEND");

    const stale = fixture();
    writeFileSync(join(stale.input.adapter.temp, ".qualification-probe"), "stale", "utf8");
    const markerless = executable(
      temporary("kdc-markerless-"),
      "bwrap",
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf \'bubblewrap 12.34\\n\'; fi\nexit 0\n',
    );
    expect(() =>
      qualifyProductionDebugBackend({
        backend: provisioned(markerless, "/opt/keiko-backend/bwrap"),
        platform: "linux",
      }),
    ).toThrow("INVALID_DEBUG_BACKEND");
    expect(readFileSync(join(stale.input.adapter.temp, ".qualification-probe"), "utf8")).toBe(
      "stale",
    );
  });

  it("rejects an unsupported backend instead of caching unavailable evidence", () => {
    const current = fixture();
    const backend = executable(
      temporary("kdc-custom-backend-"),
      "custom-sandbox",
      "#!/bin/sh\nprintf 'custom sandbox 1.0\\n'\n",
    );
    expect(() =>
      qualifyProductionDebugBackend({
        backend: provisioned(backend, "/opt/keiko-backend/custom-sandbox"),
        platform: "linux",
      }),
    ).toThrow("INVALID_DEBUG_BACKEND");
    expect(current.deps.backendQualification.availability.bubblewrap).toBe(true);
  });

  it("preserves the qualified platform and fixed container identity", async () => {
    const current = fixture();
    const context = await createProductionDebugLaunchContextResolver({
      ...current.deps,
      containerImage: "keiko/debug@sha256:fixed",
    })(current.input);

    expect(context.platform).toBe("linux");
    expect(context.containerImage).toBe("keiko/debug@sha256:fixed");
    expect(context.availability).toBe(current.deps.backendQualification.availability);
  });

  it("qualifies with empty env in a private disposable runtime", () => {
    const current = fixture();
    const trace = join(temporary("kdc-qualification-trace-"), "trace");
    const backend = executable(
      temporary("kdc-private-qualification-"),
      "bwrap",
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  [ -z "\${KEIKO_HOSTILE_CONTEXT+x}" ] || exit 60
  printf 'version:clean\\n' >> "${trace}"
  printf 'bubblewrap 12.34\\n'
  exit 0
fi
[ -z "\${KEIKO_HOSTILE_CONTEXT+x}" ] || exit 61
runtime=""
previous=""
for argument in "$@"; do
  if [ "$argument" = "/run/keiko-debug" ] && [ -d "$previous" ]; then runtime="$previous"; fi
  previous="$argument"
done
mode="$(/usr/bin/stat -c %a "$runtime" 2>/dev/null || /usr/bin/stat -f %Lp "$runtime")"
printf 'probe:clean:%s:%s\\n' "$mode" "$runtime" >> "${trace}"
printf qualified > "$runtime/.qualification-probe"
`,
    );
    const previous = process.env.KEIKO_HOSTILE_CONTEXT;
    process.env.KEIKO_HOSTILE_CONTEXT = "must-not-cross";
    let qualification: ReturnType<typeof qualifyProductionDebugBackend>;
    try {
      qualification = qualifyProductionDebugBackend({
        backend: provisioned(backend, "/opt/keiko-backend/bwrap"),
        platform: "linux",
      });
    } finally {
      if (previous === undefined) delete process.env.KEIKO_HOSTILE_CONTEXT;
      else process.env.KEIKO_HOSTILE_CONTEXT = previous;
    }
    const [version, probe] = readFileSync(trace, "utf8").trim().split("\n");
    expect(version).toBe("version:clean");
    expect(probe).toMatch(/^probe:clean:700:/u);
    expect(qualification.availability.bubblewrap).toBe(true);
    expect(Object.isFrozen(qualification)).toBe(true);
    expect(Object.isFrozen(qualification.availability)).toBe(true);
    expect(Object.isFrozen(qualification.backendExecutable)).toBe(true);
    const qualificationRuntime = probe?.replace(/^probe:clean:700:/u, "");
    expect(qualificationRuntime).not.toBe(realpathSync(current.input.adapter.temp));
    expect(existsSync(qualificationRuntime ?? "")).toBe(false);
  });

  it("fails closed and cleans the private qualification runtime on owner drift", () => {
    const current = fixture();
    const actualUid = process.getuid?.();
    if (actualUid === undefined) throw new Error("POSIX test requires getuid");
    vi.spyOn(process, "getuid").mockReturnValue(actualUid + 1);

    expect(() =>
      qualifyProductionDebugBackend({
        backend: current.deps.backend,
        platform: "linux",
      }),
    ).toThrow("INVALID_DEBUG_RUNTIME");
  });

  it("rejects every qualified backend identity, platform, and availability drift", async () => {
    const current = fixture();
    const qualification = current.deps.backendQualification;
    for (const backendExecutable of backendIdentityDrifts(qualification.backendExecutable)) {
      await expect(
        createProductionDebugLaunchContextResolver({
          ...current.deps,
          backendQualification: { ...qualification, backendExecutable },
        })(current.input),
      ).rejects.toThrow("INVALID_DEBUG_BACKEND");
    }
    for (const backendQualification of [
      { ...qualification, platform: "darwin" as const },
      { ...qualification, availability: { ...qualification.availability, bubblewrap: false } },
    ]) {
      await expect(
        createProductionDebugLaunchContextResolver({ ...current.deps, backendQualification })(
          current.input,
        ),
      ).rejects.toThrow("INVALID_DEBUG_BACKEND");
    }
  });

  it("revalidates opaque targets and detects same-size content replacement", async () => {
    const current = fixture();
    const path = join(current.workspace, "app.js");
    const before = statSync(path);
    const deps = {
      discover: current.deps.discover,
      fs: current.deps.fs,
      workspaceRoot: current.workspace,
      projectId: current.deps.projectId,
      workspaceTrusted: true,
    };
    const { deriveFileDebugTarget } = await import("./debugLaunchCatalog.js");
    const target = deriveFileDebugTarget("app.js", deps);
    const context = await createProductionDebugLaunchContextResolver(current.deps)(current.input);
    const envelope = {
      targetReference: { kind: "file", fileId: "app.js" },
      targetIdentityDigest: target.targetIdentityDigest,
      workspaceIdentity: context.workspaceIdentity,
    } as unknown as DebugSpawnEnvelope;
    const revalidate = createProductionDebugTargetRevalidator(deps);
    expect(revalidate(envelope)).toBe(true);
    writeFileSync(path, "omega", "utf8");
    utimesSync(path, before.atime, before.mtime);
    expect(revalidate(envelope)).toBe(false);
  });

  it("binds target revalidation to every field of the mounted workspace identity", async () => {
    const current = fixture();
    const deps = {
      discover: current.deps.discover,
      fs: current.deps.fs,
      workspaceRoot: current.workspace,
      projectId: current.deps.projectId,
      workspaceTrusted: true,
    };
    const { deriveFileDebugTarget } = await import("./debugLaunchCatalog.js");
    const target = deriveFileDebugTarget("app.js", deps);
    const context = await createProductionDebugLaunchContextResolver(current.deps)(current.input);
    const envelope = {
      targetReference: { kind: "file", fileId: "app.js" },
      targetIdentityDigest: target.targetIdentityDigest,
      workspaceIdentity: context.workspaceIdentity,
    } as unknown as DebugSpawnEnvelope;
    const revalidate = createProductionDebugTargetRevalidator(deps);
    expect(revalidate(envelope)).toBe(true);

    for (const workspaceIdentity of [
      { ...context.workspaceIdentity, realPath: `${context.workspaceIdentity.realPath}-other` },
      { ...context.workspaceIdentity, device: context.workspaceIdentity.device + 1 },
      { ...context.workspaceIdentity, inode: context.workspaceIdentity.inode + 1 },
      { ...context.workspaceIdentity, mode: context.workspaceIdentity.mode ^ 0o100 },
      { ...context.workspaceIdentity, ownerUid: context.workspaceIdentity.ownerUid + 1 },
      { ...context.workspaceIdentity, identityDigest: "f".repeat(64) },
    ]) {
      expect(revalidate({ ...envelope, workspaceIdentity })).toBe(false);
    }
  });

  it("rejects a replacement workspace before deriving the launch target", async () => {
    const current = fixture();
    const readFileUtf8 = vi.fn(current.deps.fs.readFileUtf8);
    const deps = {
      discover: current.deps.discover,
      fs: { ...current.deps.fs, readFileUtf8 },
      workspaceRoot: current.workspace,
      projectId: current.deps.projectId,
      workspaceTrusted: true,
    };
    const { deriveFileDebugTarget } = await import("./debugLaunchCatalog.js");
    const target = deriveFileDebugTarget("app.js", deps);
    const context = await createProductionDebugLaunchContextResolver(current.deps)(current.input);
    const envelope = {
      targetReference: { kind: "file", fileId: "app.js" },
      targetIdentityDigest: target.targetIdentityDigest,
      workspaceIdentity: context.workspaceIdentity,
    } as unknown as DebugSpawnEnvelope;
    const revalidate = createProductionDebugTargetRevalidator(deps);
    readFileUtf8.mockClear();
    const mountedWorkspace = `${current.workspace}-mounted`;
    renameSync(current.workspace, mountedWorkspace);
    mkdirSync(current.workspace);
    writeFileSync(join(current.workspace, "app.js"), "alpha", "utf8");

    expect(revalidate(envelope)).toBe(false);
    expect(readFileUtf8).not.toHaveBeenCalled();
  });

  it("revalidates catalog targets and fails closed for invalid live references", async () => {
    const current = fixture();
    let scriptName = "start";
    const discover = (): CommandTaskCatalog => ({
      schemaVersion: "1",
      projectId: "project_a",
      tasks: [catalogTask(scriptName)],
    });
    const deps = {
      discover,
      fs: current.deps.fs,
      workspaceRoot: current.workspace,
      projectId: current.deps.projectId,
      workspaceTrusted: true,
    };
    const { deriveCatalogDebugTarget } = await import("./debugLaunchCatalog.js");
    const target = deriveCatalogDebugTarget("npm-script:start", deps);
    const envelope = {
      targetReference: { kind: "catalog", targetId: "npm-script:start" },
      targetIdentityDigest: target.targetIdentityDigest,
      workspaceIdentity: (
        await createProductionDebugLaunchContextResolver(current.deps)(current.input)
      ).workspaceIdentity,
    } as unknown as DebugSpawnEnvelope;
    const revalidate = createProductionDebugTargetRevalidator(deps);
    expect(revalidate(envelope)).toBe(true);
    scriptName = "changed";
    expect(revalidate(envelope)).toBe(false);
    expect(
      revalidate({
        ...envelope,
        targetReference: { kind: "file", fileId: "missing.js" },
      }),
    ).toBe(false);
  });

  it("rejects a workspace identity that is not a directory", async () => {
    const current = fixture();
    const workspaceFile = join(temporary("kdc-workspace-file-"), "workspace");
    writeFileSync(workspaceFile, "not-a-directory", "utf8");
    await expect(
      createProductionDebugLaunchContextResolver({
        ...current.deps,
        workspaceRoot: workspaceFile,
      })(current.input),
    ).rejects.toThrow("INVALID_DEBUG_WORKSPACE");
  });
});
