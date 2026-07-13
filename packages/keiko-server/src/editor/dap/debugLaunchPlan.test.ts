import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planStrictDebugCapsule, type StrictDebugCapsulePlan } from "@oscharko-dev/keiko-sandbox";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DebugCapsulePlanError,
  deriveCanonicalDebugProvisioningDigest,
  type DebugCapsuleLayer2Input,
  type DebugCapsuleLayer2Validator,
} from "./debugCapsulePlan.js";
import {
  assertDebugTargetCandidate,
  assertDebugLaunchEnvironment,
  createDebugLaunchLayer2Validator,
  debugOwnTargetData,
  debugPathsOverlap,
  deriveDebugProvisioningDigest,
  deriveStrictDebugCapsuleInput,
  isDebugRuntimeLocationValid,
  isDebugRuntimeStatValid,
  parseDebugCatalogTarget,
  parseDebugFileTarget,
  parseOpaqueDebugTarget,
  type ApprovedDebugArtifact,
  type DebugLaunchPlanDeps,
  type DebugLaunchRuntimeContext,
  validateDebugLaunchContext,
} from "./debugLaunchPlan.js";

describe("opaque debug target parser security boundary", () => {
  it("accepts only plain or null-prototype records", () => {
    expect(() => {
      assertDebugTargetCandidate({});
    }).not.toThrow();
    expect(() => {
      assertDebugTargetCandidate(Object.create(null));
    }).not.toThrow();
    for (const candidate of [undefined, null, [], "file", Object.create({ kind: "file" })]) {
      expect(() => {
        assertDebugTargetCandidate(candidate);
      }).toThrow(DebugCapsulePlanError);
    }
  });

  it("reads only own data descriptors without invoking accessors", () => {
    const record = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(record, "data", { enumerable: true, value: "value" });
    const getter = vi.fn(() => "value");
    Object.defineProperty(record, "accessor", { enumerable: true, get: getter });
    expect(debugOwnTargetData(record, "data")).toBe("value");
    expect(() => debugOwnTargetData(record, "missing")).toThrow(DebugCapsulePlanError);
    expect(() => debugOwnTargetData(record, "accessor")).toThrow(DebugCapsulePlanError);
    expect(getter).not.toHaveBeenCalled();
  });

  it("parses catalog fields only with the exact kind, keys, and value type", () => {
    const valid = { kind: "catalog", targetId: "npm-script:start" };
    expect(parseDebugCatalogTarget(valid, ["kind", "targetId"], "catalog")).toStrictEqual(valid);
    expect(parseDebugCatalogTarget(valid, ["kind", "targetId"], "file")).toBeUndefined();
    expect(parseDebugCatalogTarget(valid, ["kind", "targetId", "x"], "catalog")).toBeUndefined();
    expect(
      parseDebugCatalogTarget({ kind: "catalog", targetId: 7 }, ["kind", "targetId"], "catalog"),
    ).toBeUndefined();
  });

  it("parses file fields only with the exact kind, keys, and value type", () => {
    const valid = { kind: "file", fileId: "app.js" };
    expect(parseDebugFileTarget(valid, ["fileId", "kind"], "file")).toStrictEqual(valid);
    expect(parseDebugFileTarget(valid, ["fileId", "kind"], "catalog")).toBeUndefined();
    expect(parseDebugFileTarget(valid, ["fileId", "kind", "x"], "file")).toBeUndefined();
    expect(
      parseDebugFileTarget({ kind: "file", fileId: 7 }, ["fileId", "kind"], "file"),
    ).toBeUndefined();
  });

  it("accepts exact targets and rejects inherited, accessor, unknown, kind, and type drift", () => {
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(nullPrototype, {
      kind: { enumerable: true, value: "file" },
      fileId: { enumerable: true, value: "app.js" },
    });
    expect(parseOpaqueDebugTarget({ kind: "catalog", targetId: "npm-script:start" })).toStrictEqual(
      {
        kind: "catalog",
        targetId: "npm-script:start",
      },
    );
    expect(parseOpaqueDebugTarget(nullPrototype)).toStrictEqual({ kind: "file", fileId: "app.js" });

    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "kind", { enumerable: true, get: () => "file" });
    Object.defineProperty(accessor, "fileId", { enumerable: true, value: "app.js" });
    for (const candidate of [
      Object.create({ kind: "file", fileId: "app.js" }),
      accessor,
      { kind: "file", fileId: "app.js", unknown: true },
      { kind: "other", fileId: "app.js" },
      { kind: "file", fileId: 7 },
      { kind: "catalog", targetId: 7 },
    ]) {
      expect(() => parseOpaqueDebugTarget(candidate)).toThrow(DebugCapsulePlanError);
    }
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function artifact(hostPath: string, capsulePath: string): ApprovedDebugArtifact {
  const stat = lstatSync(hostPath);
  return {
    hostPath,
    realPath: hostPath,
    approvedRoot: dirname(hostPath),
    capsulePath,
    identityDigest: createHash("sha256").update(readFileSync(hostPath)).digest("hex"),
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mode: stat.mode,
    ownerUid: stat.uid,
  };
}

function fixture(): {
  readonly context: DebugLaunchRuntimeContext;
  readonly input: DebugCapsuleLayer2Input;
} {
  const workspaceRoot = temporary("keiko-debug-workspace-");
  writeFileSync(join(workspaceRoot, "app.js"), "export {};", "utf8");
  writeFileSync(
    join(workspaceRoot, "package.json"),
    JSON.stringify({ scripts: { start: "node app.js" } }),
    "utf8",
  );
  const approved = temporary("keiko-debug-approved-");
  const paths = Object.fromEntries(
    ["adapter", "node", "npm", "shell", "bwrap", "npmUserConfig", "npmGlobalConfig"].map((name) => [
      name,
      join(approved, name),
    ]),
  ) as Record<
    "adapter" | "node" | "npm" | "shell" | "bwrap" | "npmUserConfig" | "npmGlobalConfig",
    string
  >;
  for (const path of Object.values(paths)) writeFileSync(path, `binary:${path}`, "utf8");
  writeFileSync(paths.npmUserConfig, "", "utf8");
  writeFileSync(paths.npmGlobalConfig, "", "utf8");
  const runtimeRoot = temporary("kdr-");
  const runtime = realpathSync(mkdtempSync(join(runtimeRoot, "s-")));
  chmodSync(runtime, 0o700);
  const hostHome = join(runtime, "home");
  mkdirSync(hostHome, { mode: 0o700 });
  const runtimeStat = lstatSync(runtime);
  const context: DebugLaunchRuntimeContext = {
    workspaceRoot,
    canonicalWorkspaceRoot: workspaceRoot,
    workspaceIdentity: ((): DebugLaunchRuntimeContext["workspaceIdentity"] => {
      const stat = lstatSync(workspaceRoot);
      return {
        realPath: workspaceRoot,
        identityDigest: createHash("sha256")
          .update(JSON.stringify([workspaceRoot, stat.dev, stat.ino, stat.mode, stat.uid]))
          .digest("hex"),
        device: stat.dev,
        inode: stat.ino,
        mode: stat.mode,
        ownerUid: stat.uid,
      };
    })(),
    workspaceTrusted: true,
    projectId: "partition_a",
    fs: nodeWorkspaceFs,
    discover: () => ({
      schemaVersion: "1",
      projectId: "partition_a",
      tasks: [
        {
          id: "npm-script:start",
          kind: "run",
          label: "npm run start",
          executable: "npm",
          args: ["run", "start"],
          source: "package-json-script",
          trustState: "trusted",
          trustReason: "repository-authored-script",
        },
      ],
    }),
    platform: "linux",
    availability: {
      bubblewrap: true,
      unshare: false,
      seatbelt: false,
      docker: false,
      podman: false,
    },
    hostRuntimeDirectory: runtime,
    runtimeRoot,
    hostSocketPath: join(runtime, "dap.sock"),
    capsuleRuntimeDirectory: "/run/keiko-debug",
    capsuleSocketPath: "/run/keiko-debug/dap.sock",
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
    adapter: artifact(paths.adapter, "/opt/keiko-debug/adapter"),
    node: artifact(paths.node, "/opt/keiko-runtime/node"),
    npm: artifact(paths.npm, "/opt/keiko-runtime/npm"),
    shell: artifact(paths.shell, "/opt/keiko-runtime/shell"),
    npmUserConfig: artifact(paths.npmUserConfig, "/opt/keiko-debug/npm-user-config"),
    npmGlobalConfig: artifact(paths.npmGlobalConfig, "/opt/keiko-debug/npm-global-config"),
    backendExecutable: artifact(paths.bwrap, "/opt/keiko-backend/bwrap"),
    runtimeClosure: [],
    environment: {
      HOME: "/run/keiko-debug/home",
      USERPROFILE: "/run/keiko-debug/home",
      PATH: "/opt/keiko-runtime",
      TMPDIR: "/run/keiko-debug/tmp",
      TEMP: "/run/keiko-debug/tmp",
      TMP: "/run/keiko-debug/tmp",
    },
    layer1Allowed: () => true,
    containerImage: `registry.example/keiko-debug@sha256:${"f".repeat(64)}`,
  };
  return {
    context,
    input: {
      candidate: { kind: "file", fileId: "app.js" },
      binding: {
        workspacePartitionKey: "partition_a",
        activationRevision: 7,
        targetKind: "file",
      },
      adapter: {
        providerId: "node",
        executable: paths.adapter,
        args: ["--server", "/run/keiko-debug/dap.sock"],
        env: context.environment,
        home: hostHome,
        temp: runtime,
        runtimeRoot,
      },
    },
  };
}

function validator(
  context: DebugLaunchRuntimeContext,
  epoch = 4,
  now = 100,
  planCapsule?: DebugLaunchPlanDeps["planCapsule"],
): DebugCapsuleLayer2Validator {
  return createDebugLaunchLayer2Validator({
    resolveContext: () => Promise.resolve(context),
    epoch: () => epoch,
    now: () => now,
    planCapsule,
  });
}

async function expectDenied(
  context: DebugLaunchRuntimeContext,
  input: DebugCapsuleLayer2Input,
): Promise<void> {
  await expect(validator(context).validateAndRederive(input)).rejects.toMatchObject({
    code: "INVALID_CAPSULE_PLAN",
  });
}

function backendArtifact(
  context: DebugLaunchRuntimeContext,
  name: "docker" | "podman",
): ApprovedDebugArtifact {
  const hostPath = join(context.backendExecutable.approvedRoot, name);
  writeFileSync(hostPath, `binary:${name}`, "utf8");
  return artifact(hostPath, `/opt/keiko-backend/${name}`);
}

function inspectedRuntime(hostPath: string): DebugLaunchRuntimeContext["runtimeMount"] {
  const realPath = realpathSync(hostPath);
  const stat = lstatSync(hostPath);
  return {
    hostRealPath: realPath,
    mode: "0700",
    owner: "currentUser",
    symlink: false,
    identityDigest: createHash("sha256")
      .update(JSON.stringify([realPath, stat.dev, stat.ino, stat.mode, stat.uid]))
      .digest("hex"),
    device: stat.dev,
    inode: stat.ino,
    modeBits: stat.mode,
    ownerUid: stat.uid,
  };
}

function expectContextDenied(
  context: DebugLaunchRuntimeContext,
  input: DebugCapsuleLayer2Input,
): void {
  expect(() => {
    validateDebugLaunchContext(input, context);
  }).toThrow(expect.objectContaining({ code: "INVALID_CAPSULE_PLAN" }));
}

async function assertCoreDenials(
  context: DebugLaunchRuntimeContext,
  input: DebugCapsuleLayer2Input,
): Promise<void> {
  for (const candidate of [
    null,
    [],
    "file",
    {},
    { kind: "file" },
    { kind: "file", fileId: "app.js", argv: [] },
    { kind: "catalog", targetId: 7 },
    Object.create({ kind: "file", fileId: "app.js" }) as object,
  ]) {
    await expect(
      validator(context).validateAndRederive({ ...input, candidate }),
    ).rejects.toMatchObject({ code: "INVALID_CAPSULE_PLAN" });
  }
  const contexts: DebugLaunchRuntimeContext[] = [
    { ...context, workspaceTrusted: false },
    { ...context, canonicalWorkspaceRoot: "/wrong" },
    {
      ...context,
      platform: "win32",
      availability: {
        bubblewrap: false,
        unshare: false,
        seatbelt: false,
        docker: true,
        podman: false,
      },
    },
    { ...context, adapter: { ...context.adapter, hostPath: "relative" } },
    { ...context, adapter: { ...context.adapter, realPath: "/wrong" } },
    { ...context, adapter: { ...context.adapter, capsulePath: "/wrong" } },
    { ...context, adapter: { ...context.adapter, approvedRoot: "/wrong" } },
    { ...context, adapter: { ...context.adapter, identityDigest: "A".repeat(64) } },
    { ...context, hostSocketPath: `${context.hostRuntimeDirectory}/bad` },
    { ...context, hostSocketPath: `${context.hostRuntimeDirectory}/${"x".repeat(101)}.sock` },
    { ...context, capsuleSocketPath: `/run/keiko-debug/${"x".repeat(101)}.sock` },
    { ...context, capsuleSocketPath: "/wrong/dap.sock" },
    { ...context, runtimeMount: { ...context.runtimeMount, hostRealPath: "/wrong" } },
    { ...context, runtimeMount: { ...context.runtimeMount, owner: "other" as never } },
    { ...context, runtimeMount: { ...context.runtimeMount, mode: "0755" as never } },
    { ...context, runtimeMount: { ...context.runtimeMount, symlink: true as never } },
    { ...context, environment: { PATH: "/opt/keiko-runtime" } },
    { ...context, environment: { ...context.environment, NODE_OPTIONS: "x" } },
  ];
  for (const drift of contexts) {
    await expect(validator(drift).validateAndRederive(input)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
  }
  const relativeArtifact = {
    ...context.adapter,
    hostPath: "relative",
    realPath: "relative",
    approvedRoot: "/",
  };
  await expect(
    validator({ ...context, adapter: relativeArtifact }).validateAndRederive({
      ...input,
      adapter: { ...input.adapter, executable: "relative" },
    }),
  ).rejects.toMatchObject({ code: "INVALID_CAPSULE_PLAN" });
  const mismatchedRealPath = {
    ...context.adapter,
    approvedRoot: "/",
    realPath: "/wrong",
  };
  await expect(
    validator({ ...context, adapter: mismatchedRealPath }).validateAndRederive(input),
  ).rejects.toMatchObject({ code: "INVALID_CAPSULE_PLAN" });
  for (const capsuleSocketPath of ["/wrong/dap.sock", `/run/keiko-debug/${"x".repeat(101)}.sock`]) {
    await expect(
      validator({ ...context, capsuleSocketPath }).validateAndRederive({
        ...input,
        adapter: { ...input.adapter, args: ["--server", capsuleSocketPath] },
      }),
    ).rejects.toMatchObject({ code: "INVALID_CAPSULE_PLAN" });
  }
  for (const drift of [
    { ...input, adapter: { ...input.adapter, args: [] } },
    { ...input, adapter: { ...input.adapter, args: ["--wrong", context.capsuleSocketPath] } },
    { ...input, adapter: { ...input.adapter, args: ["--server", "/wrong"] } },
    {
      ...input,
      adapter: { ...input.adapter, args: ["--server", context.capsuleSocketPath, "extra"] },
    },
  ]) {
    await expect(validator(context).validateAndRederive(drift)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
  }
}

describe("stateless debug launch Layer-2 planning", () => {
  it("uses one closed content-free plan error", async () => {
    const current = fixture();
    await assertCoreDenials(current.context, current.input);
    const hostPrefix = `${current.context.hostRuntimeDirectory}/`;
    const capsulePrefix = `${current.context.capsuleRuntimeDirectory}/`;
    const boundaryContext = {
      ...current.context,
      hostSocketPath: `${hostPrefix}${"h".repeat(100 - Buffer.byteLength(hostPrefix) - 5)}.sock`,
      capsuleSocketPath: `${capsulePrefix}${"c".repeat(100 - Buffer.byteLength(capsulePrefix) - 5)}.sock`,
    };
    const boundaryInput = {
      ...current.input,
      adapter: {
        ...current.input.adapter,
        args: ["--server", boundaryContext.capsuleSocketPath],
      },
    };
    await expect(
      validator(boundaryContext).validateAndRederive(boundaryInput),
    ).resolves.toMatchObject({
      endpoint: {
        hostSocketPath: boundaryContext.hostSocketPath,
        capsuleSocketPath: boundaryContext.capsuleSocketPath,
      },
    });
    await expect(
      validator(current.context, Number.NaN).validateAndRederive(current.input),
    ).rejects.toMatchObject({
      name: "DebugCapsulePlanError",
      message: "INVALID_CAPSULE_PLAN",
      code: "INVALID_CAPSULE_PLAN",
    });
  });
  it("derives backend/runtime identity and one closed file launch from current trusted state", async () => {
    const { context, input } = fixture();
    const plan = await validator(context).validateAndRederive(input);
    expect(plan).toMatchObject({
      backend: "linuxNamespace",
      epoch: 4,
      expiresAtMs: 30_100,
      endpoint: {
        hostRuntimeDirectory: context.hostRuntimeDirectory,
        capsuleRuntimeDirectory: "/run/keiko-debug",
      },
      capsule: { descendantScope: "qualifiedCapsuleInit", initMechanism: "bubblewrapPid1Reaper" },
      launchRequest: {
        command: "launch",
        arguments: {
          request: "launch",
          runtimeExecutable: "/opt/keiko-runtime/node",
          program: "/keiko-execution-root/app.js",
          args: [],
          cwd: "/keiko-execution-root",
          console: "internalConsole",
        },
      },
    });
    expect(plan.runtimeIdentityDigest).toMatch(/^[a-f0-9]{64}$/u);
    const mounts = [
      context.adapter,
      context.node,
      context.npm,
      context.shell,
      context.npmUserConfig,
      context.npmGlobalConfig,
    ].map((artifact) => ({
      hostPath: artifact.realPath,
      capsulePath: artifact.capsulePath,
      identityDigest: artifact.identityDigest,
    }));
    const expectedRuntimeDigest = createHash("sha256")
      .update(JSON.stringify([context.runtimeMount.identityDigest, mounts]))
      .digest("hex");
    expect(plan.runtimeIdentityDigest).toBe(expectedRuntimeDigest);
    expect(plan.provisioningDigest).toBe(deriveDebugProvisioningDigest(context));
    expect(plan.spawnEnvelope.provisioningDigest).toBe(plan.provisioningDigest);
    expect(plan.launchIdentityDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(plan.launchRequest)).not.toMatch(
      /(?:tcp|inspect|port|127\.0\.0\.1|0\.0\.0\.0)/iu,
    );
    expect(plan.planId).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.capsule.args).toEqual(
      expect.arrayContaining([
        "--unshare-net",
        "--unshare-pid",
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/opt/keiko-debug/adapter",
        "/opt/keiko-debug/npm-user-config",
        "/opt/keiko-debug/npm-global-config",
      ]),
    );
    expect(plan.spawnEnvelope.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capsulePath: "/opt/keiko-debug/npm-user-config", size: 0 }),
        expect.objectContaining({ capsulePath: "/opt/keiko-debug/npm-global-config", size: 0 }),
      ]),
    );
  });

  it("derives the exact catalog tuple and observes live manifest identity drift", async () => {
    const { context, input } = fixture();
    const catalogInput = {
      ...input,
      candidate: { kind: "catalog", targetId: "npm-script:start" },
      binding: { ...input.binding, targetKind: "catalog" as const },
    };
    const plan = await validator(context).validateAndRederive(catalogInput);
    expect(plan.launchRequest).toStrictEqual({
      command: "launch",
      arguments: {
        request: "launch",
        runtimeExecutable: "/opt/keiko-runtime/npm",
        runtimeArgs: [
          "--ignore-scripts",
          "--script-shell=/opt/keiko-runtime/shell",
          "--userconfig=/opt/keiko-debug/npm-user-config",
          "--globalconfig=/opt/keiko-debug/npm-global-config",
          "--location=global",
          "run",
          "start",
        ],
        cwd: "/keiko-execution-root",
        console: "internalConsole",
      },
    });
    let calls = 0;
    const drift = {
      ...context,
      discover: (): ReturnType<DebugLaunchRuntimeContext["discover"]> => {
        calls += 1;
        return {
          schemaVersion: "1" as const,
          projectId: "partition_a",
          tasks: [
            {
              id: "npm-script:start",
              kind: "run" as const,
              label: calls === 1 ? "npm run start" : "changed",
              executable: "npm",
              args: ["run", "start"],
              source: "package-json-script" as const,
              trustState: "trusted" as const,
              trustReason: "repository-authored-script" as const,
            },
          ],
        };
      },
    };
    await expect(validator(drift).validateAndRederive(catalogInput)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
  });

  it.each([
    { kind: "file", fileId: "app.js", backend: "oci" },
    { kind: "file", fileId: "app.js", runtimeIdentityDigest: "0".repeat(64) },
    { kind: "file", fileId: "app.js", argv: ["evil"] },
    Object.create({ kind: "file", fileId: "app.js" }) as object,
    null,
    [],
    "file",
    { kind: "file" },
    { kind: "catalog", targetId: 7 },
    { kind: "other", fileId: "app.js" },
  ])("rejects unknown, inherited, or execution-bearing candidate data", async (candidate) => {
    const { context, input } = fixture();
    await expect(
      validator(context).validateAndRederive({ ...input, candidate }),
    ).rejects.toMatchObject({ code: "INVALID_CAPSULE_PLAN", message: "INVALID_CAPSULE_PLAN" });
  });

  it("does not invoke hostile candidate getters", async () => {
    const { context, input } = fixture();
    const getter = vi.fn(() => "file");
    const candidate = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(candidate, "kind", { enumerable: true, get: getter });
    Object.defineProperty(candidate, "fileId", { enumerable: true, value: "app.js" });
    await expect(
      validator(context).validateAndRederive({ ...input, candidate }),
    ).rejects.toMatchObject({ code: "INVALID_CAPSULE_PLAN" });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      workspaceTrusted: false,
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      canonicalWorkspaceRoot: "/drift",
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      platform: "win32" as const,
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      runtimeMount: { ...context.runtimeMount, symlink: true as never },
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      hostSocketPath: `${context.hostRuntimeDirectory}/../escape.sock`,
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      environment: { ...context.environment, NODE_OPTIONS: "--require evil" },
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      layer1Allowed: (): boolean => false,
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      availability: {
        bubblewrap: false,
        unshare: false,
        seatbelt: false,
        docker: false,
        podman: false,
      },
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      adapter: { ...context.adapter, identityDigest: "G".repeat(64) },
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      adapter: { ...context.adapter, realPath: "/drift" },
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      adapter: { ...context.adapter, capsulePath: "/wrong" },
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      node: { ...context.node, approvedRoot: "/wrong" },
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      hostSocketPath: `${context.hostRuntimeDirectory}/bad`,
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      capsuleSocketPath: "/other/dap.sock",
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      runtimeMount: { ...context.runtimeMount, owner: "other" as never },
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      runtimeMount: { ...context.runtimeMount, mode: "0755" as never },
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      environment: { PATH: "/opt/keiko-runtime" },
    }),
    (context: DebugLaunchRuntimeContext): DebugLaunchRuntimeContext => ({
      ...context,
      environment: { ...context.environment, PATH: "/wrong" },
    }),
  ])(
    "fails closed for trust, identity, mount, endpoint, env, policy, or backend drift",
    async (mutate) => {
      const { context, input } = fixture();
      await expect(validator(mutate(context)).validateAndRederive(input)).rejects.toMatchObject({
        code: "INVALID_CAPSULE_PLAN",
      });
    },
  );

  it.each([
    [Number.NaN, 100],
    [-1, 100],
    [1, Number.MAX_SAFE_INTEGER],
  ])("rejects invalid epoch or expiry arithmetic", async (epoch, now) => {
    const { context, input } = fixture();
    await expect(validator(context, epoch, now).validateAndRederive(input)).rejects.toMatchObject({
      code: "INVALID_CAPSULE_PLAN",
    });
  });

  it("rejects target-kind and adapter endpoint drift", async () => {
    const { context, input } = fixture();
    for (const drift of [
      { ...input, binding: { ...input.binding, targetKind: "catalog" as const } },
      { ...input, adapter: { ...input.adapter, args: ["--server", "/wrong.sock"] } },
      { ...input, adapter: { ...input.adapter, executable: "/workspace/adapter" } },
    ]) {
      await expect(validator(context).validateAndRederive(drift)).rejects.toMatchObject({
        code: "INVALID_CAPSULE_PLAN",
      });
    }
  });

  it("accepts epoch zero and binds target/environment changes into launch identity", async () => {
    const first = fixture();
    const plan = await validator(first.context, 0).validateAndRederive(first.input);
    expect(plan.epoch).toBe(0);
    const changed = { ...first.context, environment: { ...first.context.environment, LANG: "C" } };
    const changedInput = {
      ...first.input,
      adapter: { ...first.input.adapter, env: changed.environment },
    };
    const changedPlan = await validator(changed, 0).validateAndRederive(changedInput);
    expect(changedPlan.launchIdentityDigest).not.toBe(plan.launchIdentityDigest);
  });

  it("binds every runtime-closure artifact field into validation and provisioning", async () => {
    const { context, input } = fixture();
    const closurePath = join(context.backendExecutable.approvedRoot, "runtime-library");
    writeFileSync(closurePath, "runtime-library", "utf8");
    const closure = artifact(closurePath, "/opt/keiko-runtime/runtime-library");
    const closedContext = { ...context, runtimeClosure: [closure] };
    const plan = await validator(closedContext).validateAndRederive(input);
    expect(plan.capsule.immutableMounts).toContainEqual({
      hostPath: closure.realPath,
      capsulePath: closure.capsulePath,
      identityDigest: closure.identityDigest,
    });
    expect(plan.spawnEnvelope.artifacts).toContainEqual({
      hostPath: closure.hostPath,
      realPath: closure.realPath,
      approvedRootRealPath: realpathSync(closure.approvedRoot),
      capsulePath: closure.capsulePath,
      identityDigest: closure.identityDigest,
      device: closure.device,
      inode: closure.inode,
      size: closure.size,
      mode: closure.mode,
      ownerUid: closure.ownerUid,
    });

    const drifts: readonly ApprovedDebugArtifact[] = [
      { ...closure, realPath: context.node.realPath },
      { ...closure, approvedRoot: context.workspaceRoot },
      { ...closure, identityDigest: "0".repeat(64) },
      { ...closure, device: closure.device + 1 },
      { ...closure, inode: closure.inode + 1 },
      { ...closure, size: closure.size + 1 },
      { ...closure, mode: closure.mode ^ 1 },
      { ...closure, ownerUid: closure.ownerUid + 1 },
    ];
    for (const drift of drifts) {
      await expectDenied({ ...context, runtimeClosure: [drift] }, input);
    }
    writeFileSync(closurePath, "runtime-library-drift", "utf8");
    await expectDenied(closedContext, input);
  });

  it("rejects each independent runtime and workspace identity drift", async () => {
    const { context, input } = fixture();
    const runtimeMounts: readonly DebugLaunchRuntimeContext["runtimeMount"][] = [
      { ...context.runtimeMount, hostRealPath: context.runtimeRoot },
      { ...context.runtimeMount, identityDigest: "0".repeat(64) },
      { ...context.runtimeMount, device: context.runtimeMount.device + 1 },
      { ...context.runtimeMount, inode: context.runtimeMount.inode + 1 },
      { ...context.runtimeMount, modeBits: context.runtimeMount.modeBits ^ 1 },
      { ...context.runtimeMount, ownerUid: context.runtimeMount.ownerUid + 1 },
    ];
    for (const runtimeMount of runtimeMounts) {
      await expectDenied({ ...context, runtimeMount }, input);
    }

    const identities: readonly DebugLaunchRuntimeContext["workspaceIdentity"][] = [
      { ...context.workspaceIdentity, realPath: context.runtimeRoot },
      { ...context.workspaceIdentity, identityDigest: "0".repeat(64) },
      { ...context.workspaceIdentity, device: context.workspaceIdentity.device + 1 },
      { ...context.workspaceIdentity, inode: context.workspaceIdentity.inode + 1 },
      { ...context.workspaceIdentity, mode: context.workspaceIdentity.mode ^ 1 },
      { ...context.workspaceIdentity, ownerUid: context.workspaceIdentity.ownerUid + 1 },
    ];
    for (const workspaceIdentity of identities) {
      await expectDenied({ ...context, workspaceIdentity }, input);
    }

    chmodSync(context.hostRuntimeDirectory, 0o755);
    await expectDenied(context, input);
  });

  it("proves each context boundary directly without downstream rejection", () => {
    const { context, input } = fixture();
    expect(() => {
      validateDebugLaunchContext(input, context);
    }).not.toThrow();

    expectContextDenied({ ...context, workspaceTrusted: false }, input);
    expectContextDenied(
      {
        ...context,
        fs: { ...context.fs, realPath: (): string => context.runtimeRoot },
      },
      input,
    );
    expectContextDenied(
      {
        ...context,
        workspaceIdentity: {
          ...context.workspaceIdentity,
          realPath: context.runtimeRoot,
          identityDigest: createHash("sha256")
            .update(
              JSON.stringify([
                context.runtimeRoot,
                context.workspaceIdentity.device,
                context.workspaceIdentity.inode,
                context.workspaceIdentity.mode,
                context.workspaceIdentity.ownerUid,
              ]),
            )
            .digest("hex"),
        },
      },
      input,
    );
    expectContextDenied({ ...context, platform: "win32" }, input);
    expectContextDenied({ ...context, capsuleRuntimeDirectory: "/run/other" }, input);

    const nestedRuntime = join(context.workspaceRoot, "nested-runtime");
    mkdirSync(nestedRuntime, { mode: 0o700 });
    const nestedContext = {
      ...context,
      runtimeRoot: context.workspaceRoot,
      hostRuntimeDirectory: nestedRuntime,
      hostSocketPath: join(nestedRuntime, "dap.sock"),
      runtimeMount: inspectedRuntime(nestedRuntime),
    };
    expectContextDenied(nestedContext, {
      ...input,
      adapter: {
        ...input.adapter,
        temp: nestedRuntime,
        home: join(nestedRuntime, "home"),
      },
    });

    const runtimeFile = join(context.runtimeRoot, "runtime-file");
    writeFileSync(runtimeFile, "not-a-directory", { mode: 0o700 });
    const fileContext = {
      ...context,
      hostRuntimeDirectory: runtimeFile,
      hostSocketPath: join(runtimeFile, "dap.sock"),
      runtimeMount: inspectedRuntime(runtimeFile),
    };
    expectContextDenied(fileContext, {
      ...input,
      adapter: { ...input.adapter, temp: runtimeFile },
    });

    const getuid = vi.spyOn(process, "getuid").mockReturnValue(context.runtimeMount.ownerUid + 1);
    expectContextDenied(context, input);
    getuid.mockRestore();
  });

  it("proves overlap, containment, stat, mode, and ownership predicates independently", () => {
    const { context } = fixture();
    const runtime = context.hostRuntimeDirectory;
    expect(debugPathsOverlap(context.runtimeRoot, runtime)).toBe(true);
    expect(debugPathsOverlap(runtime, context.runtimeRoot)).toBe(true);
    expect(debugPathsOverlap(runtime, context.workspaceRoot)).toBe(false);
    expect(isDebugRuntimeLocationValid(context, realpathSync(context.runtimeRoot), runtime)).toBe(
      true,
    );
    expect(
      isDebugRuntimeLocationValid(
        {
          ...context,
          runtimeMount: { ...context.runtimeMount, hostRealPath: context.runtimeRoot },
        },
        realpathSync(context.runtimeRoot),
        runtime,
      ),
    ).toBe(false);
    expect(isDebugRuntimeLocationValid(context, context.workspaceRoot, runtime)).toBe(false);
    expect(
      isDebugRuntimeLocationValid(
        { ...context, workspaceRoot: context.runtimeRoot },
        realpathSync(context.runtimeRoot),
        runtime,
      ),
    ).toBe(false);
    expect(
      isDebugRuntimeLocationValid(
        { ...context, canonicalWorkspaceRoot: context.runtimeRoot },
        realpathSync(context.runtimeRoot),
        runtime,
      ),
    ).toBe(false);

    const runtimeStat = lstatSync(runtime);
    expect(isDebugRuntimeStatValid(runtimeStat)).toBe(true);
    const wrongUid = vi.spyOn(process, "getuid").mockReturnValue(runtimeStat.uid + 1);
    expect(isDebugRuntimeStatValid(runtimeStat)).toBe(false);
    wrongUid.mockRestore();
    const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    if (getuidDescriptor === undefined) throw new Error("Expected process.getuid descriptor");
    Object.defineProperty(process, "getuid", { ...getuidDescriptor, value: undefined });
    try {
      expect(isDebugRuntimeStatValid(runtimeStat)).toBe(false);
    } finally {
      Object.defineProperty(process, "getuid", getuidDescriptor);
    }
    chmodSync(runtime, 0o755);
    expect(isDebugRuntimeStatValid(lstatSync(runtime))).toBe(false);
    const runtimeFile = join(context.runtimeRoot, "runtime-stat-file");
    writeFileSync(runtimeFile, "file", { mode: 0o700 });
    expect(isDebugRuntimeStatValid(lstatSync(runtimeFile))).toBe(false);
  });

  it("proves npm config and adapter-record checks independently", () => {
    const { context, input } = fixture();
    expectContextDenied(
      { ...context, npmUserConfig: { ...context.npmUserConfig, size: 1 } },
      input,
    );
    expectContextDenied(
      { ...context, npmGlobalConfig: { ...context.npmGlobalConfig, size: 1 } },
      input,
    );

    const nonEmptyUser = fixture();
    writeFileSync(nonEmptyUser.context.npmUserConfig.hostPath, "user-config", "utf8");
    expectContextDenied(
      {
        ...nonEmptyUser.context,
        npmUserConfig: artifact(
          nonEmptyUser.context.npmUserConfig.hostPath,
          nonEmptyUser.context.npmUserConfig.capsulePath,
        ),
      },
      nonEmptyUser.input,
    );
    const nonEmptyGlobal = fixture();
    writeFileSync(nonEmptyGlobal.context.npmGlobalConfig.hostPath, "global-config", "utf8");
    expectContextDenied(
      {
        ...nonEmptyGlobal.context,
        npmGlobalConfig: artifact(
          nonEmptyGlobal.context.npmGlobalConfig.hostPath,
          nonEmptyGlobal.context.npmGlobalConfig.capsulePath,
        ),
      },
      nonEmptyGlobal.input,
    );
    expectContextDenied(
      {
        ...context,
        npmGlobalConfig: {
          ...context.npmGlobalConfig,
          hostPath: context.npmUserConfig.hostPath,
          realPath: context.npmUserConfig.realPath,
          approvedRoot: context.npmUserConfig.approvedRoot,
          identityDigest: context.npmUserConfig.identityDigest,
          device: context.npmUserConfig.device,
          inode: context.npmUserConfig.inode,
          size: context.npmUserConfig.size,
          mode: context.npmUserConfig.mode,
          ownerUid: context.npmUserConfig.ownerUid,
        },
      },
      input,
    );

    const withoutTmp = Object.fromEntries(
      Object.entries(input.adapter.env).filter(([key]) => key !== "TMP"),
    );
    const prefixOnly = { HOME: input.adapter.env.HOME ?? "" };
    const sameLengthDifferentKey = { ...withoutTmp, TMO: input.adapter.env.TMP ?? "" };
    const undefinedDifferentKey = {
      ...withoutTmp,
      TMO: undefined,
    } as unknown as Readonly<Record<string, string>>;
    for (const env of [
      withoutTmp,
      prefixOnly,
      sameLengthDifferentKey,
      undefinedDifferentKey,
      { ...input.adapter.env, TMP: "/wrong" },
    ]) {
      expectContextDenied(context, { ...input, adapter: { ...input.adapter, env } });
    }
    const reordered = Object.fromEntries(Object.entries(input.adapter.env).reverse());
    expect(() => {
      validateDebugLaunchContext(
        { ...input, adapter: { ...input.adapter, env: reordered } },
        context,
      );
    }).not.toThrow();
  });

  it("proves the closed environment boundary directly", () => {
    const { context } = fixture();
    expect(() => {
      assertDebugLaunchEnvironment(context);
    }).not.toThrow();
    const denials: readonly Readonly<Record<string, string>>[] = [
      { ...context.environment, UNSAFE: "value" },
      Object.fromEntries(
        Object.entries(context.environment).filter(
          ([key]) => key !== "HOME" && key !== "USERPROFILE",
        ),
      ),
      Object.fromEntries(
        Object.entries(context.environment).filter(
          ([key]) => key !== "TMPDIR" && key !== "TEMP" && key !== "TMP",
        ),
      ),
      { ...context.environment, PATH: "/wrong" },
      { ...context.environment, USERPROFILE: "/wrong" },
      { ...context.environment, TEMP: "/wrong" },
      { ...context.environment, TMP: "/wrong" },
    ];
    for (const environment of denials) {
      expect(() => {
        assertDebugLaunchEnvironment({ ...context, environment });
      }).toThrow(expect.objectContaining({ code: "INVALID_CAPSULE_PLAN" }));
    }
  });

  it("rejects every independent adapter and environment binding drift", async () => {
    const { context, input } = fixture();
    for (const drift of [
      { ...input, adapter: { ...input.adapter, providerId: "" } },
      { ...input, adapter: { ...input.adapter, temp: context.runtimeRoot } },
      { ...input, adapter: { ...input.adapter, env: { ...input.adapter.env, LANG: "C" } } },
    ]) {
      await expectDenied(context, drift);
    }
    const environments: readonly Readonly<Record<string, string>>[] = [
      { ...context.environment, PATH: "/wrong" },
      { ...context.environment, HOME: "/wrong" },
      { ...context.environment, TMPDIR: "/wrong" },
      { ...context.environment, USERPROFILE: "/wrong" },
      { ...context.environment, TEMP: "/wrong" },
      { ...context.environment, TMP: "/wrong" },
      { ...context.environment, LC_ALL: "C" },
      { ...context.environment, LC_CTYPE: "C" },
      { ...context.environment, LANG: "C" },
      { ...context.environment, UNSAFE: "value" },
    ];
    for (const environment of environments) {
      const boundInput = { ...input, adapter: { ...input.adapter, env: environment } };
      const allowed = ["LC_ALL", "LC_CTYPE", "LANG"].some((key) => environment[key] === "C");
      if (allowed) {
        await expect(
          validator({ ...context, environment }).validateAndRederive(boundInput),
        ).resolves.toBeDefined();
      } else {
        await expectDenied({ ...context, environment }, boundInput);
      }
    }
  });

  it("emits the complete immutable spawn envelope without dropping closed fields", async () => {
    const { context, input } = fixture();
    const plan = await validator(context).validateAndRederive(input);
    expect(plan.spawnEnvelope).toStrictEqual({
      schemaVersion: "1",
      providerId: input.adapter.providerId,
      backend: plan.capsule.backend,
      provisioningDigest: plan.provisioningDigest,
      runtimeIdentityDigest: plan.runtimeIdentityDigest,
      runtimeDirectoryIdentity: {
        realPath: context.runtimeMount.hostRealPath,
        identityDigest: context.runtimeMount.identityDigest,
        device: context.runtimeMount.device,
        inode: context.runtimeMount.inode,
        mode: context.runtimeMount.modeBits,
        ownerUid: context.runtimeMount.ownerUid,
      },
      capsuleCommand: context.backendExecutable.realPath,
      capsuleArgs: plan.capsule.args,
      adapterExecutable: context.adapter.capsulePath,
      adapterArgs: input.adapter.args,
      environment: context.environment,
      home: input.adapter.home,
      temp: input.adapter.temp,
      cwd: "/keiko-execution-root",
      endpoint: plan.endpoint,
      artifacts: [
        context.backendExecutable,
        context.adapter,
        context.node,
        context.npm,
        context.shell,
        context.npmUserConfig,
        context.npmGlobalConfig,
      ].map((value) => ({
        hostPath: value.hostPath,
        realPath: value.realPath,
        approvedRootRealPath: realpathSync(value.approvedRoot),
        capsulePath: value.capsulePath,
        identityDigest: value.identityDigest,
        device: value.device,
        inode: value.inode,
        size: value.size,
        mode: value.mode,
        ownerUid: value.ownerUid,
      })),
      workspaceIdentity: context.workspaceIdentity,
      targetIdentityDigest: plan.spawnEnvelope.targetIdentityDigest,
      targetReference: input.candidate,
      activationRevision: input.binding.activationRevision,
      epoch: plan.epoch,
      expiresAtMs: plan.expiresAtMs,
      planId: plan.spawnEnvelope.identityDigest,
      identityDigest: plan.spawnEnvelope.planId,
    });
    expect(plan.spawnEnvelope.capsuleArgs).not.toHaveLength(0);
    expect(plan.spawnEnvelope.adapterArgs).toStrictEqual(["--server", context.capsuleSocketPath]);
  });

  it("derives provisioning from every observed artifact without circular expectations", () => {
    const { context } = fixture();
    const closurePath = join(context.backendExecutable.approvedRoot, "closure-for-digest");
    writeFileSync(closurePath, "closure", "utf8");
    const closedContext = {
      ...context,
      runtimeClosure: [artifact(closurePath, "/opt/keiko-runtime/closure-for-digest")],
    };
    const artifacts = [
      closedContext.adapter,
      closedContext.node,
      closedContext.npm,
      closedContext.shell,
      closedContext.backendExecutable,
      closedContext.npmUserConfig,
      closedContext.npmGlobalConfig,
      ...closedContext.runtimeClosure,
    ].map((value) => ({
      hostPath: value.hostPath,
      realPath: value.realPath,
      approvedRootRealPath: realpathSync(value.approvedRoot),
      capsulePath: value.capsulePath,
      identityDigest: value.identityDigest,
      device: value.device,
      inode: value.inode,
      size: value.size,
      mode: value.mode,
      ownerUid: value.ownerUid,
    }));
    expect(deriveDebugProvisioningDigest(closedContext)).toBe(
      deriveCanonicalDebugProvisioningDigest(artifacts),
    );
  });

  it("derives an exact planner input for every supported backend name", () => {
    const { context, input } = fixture();
    const runtimeDigest = "a".repeat(64);
    const bubblewrapInput = deriveStrictDebugCapsuleInput(input, context, runtimeDigest);
    expect(bubblewrapInput.backendExecutables).toStrictEqual({
      bubblewrap: context.backendExecutable.realPath,
    });
    expect(bubblewrapInput.backendExecutableIdentityDigests).toStrictEqual({
      bubblewrap: context.backendExecutable.identityDigest,
    });
    expect(bubblewrapInput.adapterArgs).toStrictEqual(input.adapter.args);

    for (const backend of ["docker", "podman"] as const) {
      const executable = backendArtifact(context, backend);
      const derived = deriveStrictDebugCapsuleInput(
        input,
        { ...context, backendExecutable: executable },
        runtimeDigest,
      );
      expect(derived.backendExecutables).toStrictEqual({
        [backend]: executable.realPath,
      });
      expect(derived.backendExecutableIdentityDigests).toStrictEqual({
        [backend]: executable.identityDigest,
      });
      expect(derived.adapterArgs).toStrictEqual(input.adapter.args);
    }
  });

  it.each(["docker", "podman"] as const)(
    "derives an exact OCI capsule for the approved %s backend",
    async (backend) => {
      const { context, input } = fixture();
      const executable = backendArtifact(context, backend);
      const availability = {
        bubblewrap: false,
        unshare: false,
        seatbelt: false,
        docker: backend === "docker",
        podman: backend === "podman",
      };
      const plan = await validator({
        ...context,
        availability,
        backendExecutable: executable,
      }).validateAndRederive(input);
      expect(plan).toMatchObject({
        backend: "oci",
        capsule: {
          backend: "oci",
          command: executable.realPath,
          backendExecutableIdentityDigest: executable.identityDigest,
          initMechanism: "ociInit",
        },
        spawnEnvelope: {
          backend: "oci",
          capsuleCommand: executable.realPath,
        },
      });
      expect(plan.capsule.args).toContain("--pull=never");
      expect(plan.capsule.args).toContain(context.containerImage);
    },
  );

  it("re-attests the backend at the final boundary and rejects forged planner output", async () => {
    const changed = fixture();
    const changingContext = {
      ...changed.context,
      layer1Allowed: (): boolean => {
        writeFileSync(changed.context.backendExecutable.hostPath, "changed", "utf8");
        return true;
      },
    };
    await expectDenied(changingContext, changed.input);

    const forgedCommand = fixture();
    const wrongCommand = (
      capsuleInput: Parameters<typeof planStrictDebugCapsule>[0],
    ): StrictDebugCapsulePlan => ({
      ...planStrictDebugCapsule(capsuleInput),
      command: "/approved/forged",
    });
    await expect(
      validator(forgedCommand.context, 4, 100, wrongCommand).validateAndRederive(
        forgedCommand.input,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CAPSULE_PLAN" });

    const forgedDigest = fixture();
    const wrongDigest = (
      capsuleInput: Parameters<typeof planStrictDebugCapsule>[0],
    ): StrictDebugCapsulePlan => ({
      ...planStrictDebugCapsule(capsuleInput),
      backendExecutableIdentityDigest: "0".repeat(64),
    });
    await expect(
      validator(forgedDigest.context, 4, 100, wrongDigest).validateAndRederive(forgedDigest.input),
    ).rejects.toMatchObject({ code: "INVALID_CAPSULE_PLAN" });
  });

  it("runs every independent Layer-2 denial in one mutation-complete test", async () => {
    const current = fixture();
    const candidates: unknown[] = [
      null,
      [],
      "file",
      {},
      { kind: "file" },
      { kind: "file", fileId: "app.js", argv: [] },
      { kind: "catalog", targetId: 7 },
      Object.create({ kind: "file", fileId: "app.js" }) as object,
    ];
    for (const candidate of candidates) {
      await expect(
        validator(current.context).validateAndRederive({ ...current.input, candidate }),
      ).rejects.toMatchObject({ code: "INVALID_CAPSULE_PLAN" });
    }
    const contexts: DebugLaunchRuntimeContext[] = [
      { ...current.context, workspaceTrusted: false },
      { ...current.context, canonicalWorkspaceRoot: "/wrong" },
      { ...current.context, platform: "win32" },
      { ...current.context, adapter: { ...current.context.adapter, realPath: "/wrong" } },
      { ...current.context, adapter: { ...current.context.adapter, capsulePath: "/wrong" } },
      {
        ...current.context,
        adapter: { ...current.context.adapter, identityDigest: "A".repeat(64) },
      },
      { ...current.context, node: { ...current.context.node, approvedRoot: "/wrong" } },
      { ...current.context, npmUserConfig: { ...current.context.npmUserConfig, size: 1 } },
      {
        ...current.context,
        npmGlobalConfig: {
          ...current.context.npmGlobalConfig,
          realPath: current.context.npmUserConfig.realPath,
          hostPath: current.context.npmUserConfig.hostPath,
        },
      },
      { ...current.context, hostSocketPath: `${current.context.hostRuntimeDirectory}/bad` },
      { ...current.context, capsuleSocketPath: "/wrong/dap.sock" },
      {
        ...current.context,
        runtimeMount: { ...current.context.runtimeMount, owner: "other" as never },
      },
      {
        ...current.context,
        runtimeMount: { ...current.context.runtimeMount, mode: "0755" as never },
      },
      {
        ...current.context,
        runtimeMount: { ...current.context.runtimeMount, symlink: true as never },
      },
      { ...current.context, environment: { PATH: "/opt/keiko-runtime" } },
      { ...current.context, environment: { ...current.context.environment, PATH: "/wrong" } },
      { ...current.context, environment: { ...current.context.environment, NODE_OPTIONS: "x" } },
      {
        ...current.context,
        environment: { ...current.context.environment, NPM_CONFIG_USERCONFIG: "x" },
      },
      {
        ...current.context,
        environment: { ...current.context.environment, npm_config_userconfig: "x" },
      },
      {
        ...current.context,
        environment: { ...current.context.environment, npm_config_script_shell: "x" },
      },
      { ...current.context, layer1Allowed: (): boolean => false },
      {
        ...current.context,
        availability: {
          bubblewrap: false,
          unshare: false,
          seatbelt: false,
          docker: false,
          podman: false,
        },
      },
    ];
    for (const context of contexts) {
      await expect(validator(context).validateAndRederive(current.input)).rejects.toMatchObject({
        code: "INVALID_CAPSULE_PLAN",
      });
    }
    const inputs = [
      { ...current.input, binding: { ...current.input.binding, targetKind: "catalog" as const } },
      { ...current.input, adapter: { ...current.input.adapter, executable: "/wrong" } },
      { ...current.input, adapter: { ...current.input.adapter, args: [] } },
      {
        ...current.input,
        adapter: { ...current.input.adapter, args: ["--wrong", current.context.capsuleSocketPath] },
      },
      { ...current.input, adapter: { ...current.input.adapter, args: ["--server", "/wrong"] } },
    ];
    for (const input of inputs) {
      await expect(validator(current.context).validateAndRederive(input)).rejects.toMatchObject({
        code: "INVALID_CAPSULE_PLAN",
      });
    }
  });
});
