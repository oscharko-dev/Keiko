import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UpdatePortableStagingSummary } from "@oscharko-dev/keiko-contracts";
import {
  createPortableHandoffTreeAttestor,
  hashPortableHandoffTree,
  PORTABLE_HANDOFF_TREE_HASH_SCHEMA,
  PortableHandoffBuilderError,
  preparePortableHandoffPlan,
} from "./update-portable-handoff-builder.js";
import {
  refreshPortableRegistration,
  type PortableActivationLayout,
} from "./update-portable-activation-files.js";
import { readPortableHandoffPlan } from "./update-portable-handoff-plan.js";
import type { WindowsGenerationBinding } from "./update-portable-windows-generation.js";

const roots: string[] = [];
const OLD_VERSION = "1.2.2";
const NEW_VERSION = "1.2.3";

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

type WindowsActivationLayout = PortableActivationLayout & {
  readonly windowsGeneration: WindowsGenerationBinding;
};

async function writeInstall(root: string, version: string): Promise<WindowsActivationLayout> {
  const pendingGeneration = join(root, ".portable", "generation-fixture");
  mkdirSync(join(pendingGeneration, "app"), { recursive: true });
  mkdirSync(join(root, ".portable"), { recursive: true });
  mkdirSync(join(pendingGeneration, "runtime", "native"), { recursive: true });
  writeFileSync(join(root, "Keiko.exe"), `launcher-${version}`);
  writeFileSync(
    join(pendingGeneration, "runtime", "native", "keiko-runtime-supervisor.exe"),
    `supervisor-${version}`,
  );
  writeFileSync(
    join(pendingGeneration, "app", "package.json"),
    JSON.stringify({ name: "@oscharko-dev/keiko", version }),
  );
  const treeSha256 = await hashPortableHandoffTree(pendingGeneration, {
    deadline: Date.now() + 5_000,
  });
  const resourceRoot = `.portable/generations/${treeSha256}`;
  const generationRoot = join(root, ...resourceRoot.split("/"));
  mkdirSync(dirname(generationRoot), { recursive: true });
  renameSync(pendingGeneration, generationRoot);
  const windowsGeneration = {
    schemaVersion: 1,
    resourceRoot,
    treeHashSchema: "KHT1",
    treeSha256,
    launcherPath: "Keiko.exe",
    launcherSha256: createHash("sha256").update(`launcher-${version}`).digest("hex"),
  } as const;
  writeFileSync(
    join(root, ".portable", "setup-manifest.json"),
    JSON.stringify({
      schemaVersion: 2,
      platformTarget: "windows-x64",
      packageName: "@oscharko-dev/keiko",
      packageVersion: version,
      stable: true,
      bootstrapUpdateEligible: false,
      primaryLauncher: "Keiko.exe",
      runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
      windowsGeneration,
    }),
  );
  return {
    installRoot: root,
    resourceRoot: generationRoot,
    appRoot: join(generationRoot, "app"),
    packageJsonPath: join(generationRoot, "app", "package.json"),
    setupManifestPath: join(root, ".portable", "setup-manifest.json"),
    launcherPath: join(root, "Keiko.exe"),
    runtimeSupervisorPath: join(
      generationRoot,
      "runtime",
      "native",
      "keiko-runtime-supervisor.exe",
    ),
    windowsGeneration,
  };
}

function stage(): UpdatePortableStagingSummary {
  return {
    stageId: "stage-1",
    status: "staged",
    target: "windows-x64",
    packageVersion: NEW_VERSION,
    assetName: "keiko-windows-x64.zip",
    assetId: 1,
    releaseId: 2,
    sizeBytes: 3,
    sha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
  };
}

describe("portable handoff production plan builder", () => {
  it("binds validated current/candidate trees, native artifacts, registration and process identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-builder-"));
    roots.push(root);
    const managedRoot = join(root, "Programs", "Keiko");
    const candidateRoot = join(dirname(managedRoot), ".keiko-portable-updates", "stage-1", "Keiko");
    const stateDir = join(root, "state");
    const currentLayout = await writeInstall(managedRoot, OLD_VERSION);
    const candidateLayout = await writeInstall(candidateRoot, NEW_VERSION);
    refreshPortableRegistration({
      stateDir,
      layout: currentLayout,
      target: "windows-x64",
      env: { LOCALAPPDATA: root },
      home: root,
      now: 1_699_999_000_000,
    });
    const prepared = await preparePortableHandoffPlan(
      {
        env: { LOCALAPPDATA: root },
        stateDir,
        currentVersion: OLD_VERSION,
        currentProcess: () => ({
          pid: 42,
          launchId: "1".repeat(32),
          host: "127.0.0.1",
          port: 1983,
          version: OLD_VERSION,
        }),
        newLaunchId: () => "2".repeat(32),
        restoreLaunchId: () => "3".repeat(32),
        now: () => 1_700_000_000_000,
        home: () => root,
      },
      {
        sessionId: "session-1",
        targetVersion: NEW_VERSION,
        stage: stage(),
        runtimeFacts: { packageRoot: currentLayout.appRoot, portableStateDir: stateDir },
      },
      7,
    );

    expect(readPortableHandoffPlan(stateDir, prepared.activationId)).toStrictEqual(prepared.plan);
    expect(prepared.plan.oldProcess).toMatchObject({ pid: 42, port: 1983, version: OLD_VERSION });
    expect(prepared.plan.digests.currentTreeSha256).not.toBe(
      prepared.plan.digests.candidateTreeSha256,
    );
    expect(prepared.plan.digests.preparedRegistrationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared.plan.previousRegistrationState).toBe("present");
    expect(prepared.plan.schemaVersion).toBe(3);
    if (prepared.plan.target !== "windows-x64") throw new Error("Windows plan expected");
    expect(prepared.plan.cutoverKind).toBe("windows-generation-v1");
    expect(prepared.plan.currentGenerationTreeSha256).toBe(
      currentLayout.windowsGeneration.treeSha256,
    );
    expect(prepared.plan.candidateGenerationTreeSha256).toBe(
      candidateLayout.windowsGeneration.treeSha256,
    );
    expect(prepared.plan.currentSetupManifestSha256).toBe(
      createHash("sha256").update(readFileSync(currentLayout.setupManifestPath)).digest("hex"),
    );
    expect(prepared.plan.candidateSetupManifestSha256).toBe(
      createHash("sha256").update(readFileSync(candidateLayout.setupManifestPath)).digest("hex"),
    );
    expect(prepared.plan.digests.previousRegistrationSha256).toMatch(/^[a-f0-9]{64}$/u);
    const nextRegistration = JSON.parse(
      readFileSync(
        join(stateDir, "updates", "handoff", prepared.activationId, "registration.next"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(nextRegistration).toMatchObject({
      schemaVersion: 2,
      packageVersion: NEW_VERSION,
      windowsGeneration: candidateLayout.windowsGeneration,
    });
    const attest = createPortableHandoffTreeAttestor({ managedRoot });
    await expect(attest(prepared.plan.digests.currentTreeSha256)).resolves.toBe(true);
    writeFileSync(currentLayout.packageJsonPath, "changed");
    await expect(attest(prepared.plan.digests.currentTreeSha256)).resolves.toBe(false);
  });

  it("rejects a generation changed after its setup binding was published", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-builder-stale-generation-"));
    roots.push(root);
    const managedRoot = join(root, "Programs", "Keiko");
    const candidateRoot = join(dirname(managedRoot), ".keiko-portable-updates", "stage-1", "Keiko");
    const stateDir = join(root, "state");
    const currentLayout = await writeInstall(managedRoot, OLD_VERSION);
    const candidateLayout = await writeInstall(candidateRoot, NEW_VERSION);
    refreshPortableRegistration({
      stateDir,
      layout: currentLayout,
      target: "windows-x64",
      env: { LOCALAPPDATA: root },
      home: root,
      now: 1_699_999_000_000,
    });
    writeFileSync(join(candidateLayout.resourceRoot, "changed-after-binding.txt"), "changed");

    await expect(
      preparePortableHandoffPlan(
        {
          env: { LOCALAPPDATA: root },
          stateDir,
          currentVersion: OLD_VERSION,
          currentProcess: () => ({
            pid: 42,
            launchId: "1".repeat(32),
            host: "127.0.0.1",
            port: 1983,
            version: OLD_VERSION,
          }),
          newLaunchId: () => "2".repeat(32),
          restoreLaunchId: () => "3".repeat(32),
          home: () => root,
        },
        {
          sessionId: "session-1",
          targetVersion: NEW_VERSION,
          stage: stage(),
          runtimeFacts: { packageRoot: currentLayout.appRoot, portableStateDir: stateDir },
        },
        7,
      ),
    ).rejects.toThrow(/generation digest mismatch/u);
  });

  it("rejects an occupied candidate generation destination before capsule mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-builder-occupied-generation-"));
    roots.push(root);
    const managedRoot = join(root, "Programs", "Keiko");
    const candidateRoot = join(dirname(managedRoot), ".keiko-portable-updates", "stage-1", "Keiko");
    const stateDir = join(root, "state");
    const currentLayout = await writeInstall(managedRoot, OLD_VERSION);
    const candidateLayout = await writeInstall(candidateRoot, NEW_VERSION);
    refreshPortableRegistration({
      stateDir,
      layout: currentLayout,
      target: "windows-x64",
      env: { LOCALAPPDATA: root },
      home: root,
      now: 1_699_999_000_000,
    });
    mkdirSync(
      join(managedRoot, ".portable", "generations", candidateLayout.windowsGeneration.treeSha256),
      { recursive: true },
    );

    const input = {
      sessionId: "session-1",
      targetVersion: NEW_VERSION,
      stage: stage(),
      runtimeFacts: { packageRoot: currentLayout.appRoot, portableStateDir: stateDir },
    };
    await expect(
      preparePortableHandoffPlan(
        {
          env: { LOCALAPPDATA: root },
          stateDir,
          currentVersion: OLD_VERSION,
          currentProcess: () => ({
            pid: 42,
            launchId: "1".repeat(32),
            host: "127.0.0.1",
            port: 1983,
            version: OLD_VERSION,
          }),
          newLaunchId: () => "2".repeat(32),
          restoreLaunchId: () => "3".repeat(32),
          home: () => root,
        },
        input,
        7,
      ),
    ).rejects.toThrow(/destination is occupied/u);
    expect(readFileSync(join(stateDir, "portable-install-state.json"), "utf8")).toContain(
      OLD_VERSION,
    );
  });

  it("uses the exact KHT1 byte grammar with ordinal UTF-8 paths and forward separators", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-tree-"));
    roots.push(root);
    mkdirSync(join(root, "z"));
    writeFileSync(join(root, "B.txt"), "upper");
    writeFileSync(join(root, "z", "a.txt"), "nested");
    const entry = (name: string, content: string): Buffer => {
      const nameBytes = Buffer.from(name, "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32LE(nameBytes.byteLength);
      return Buffer.concat([length, nameBytes, createHash("sha256").update(content).digest()]);
    };
    const count = Buffer.alloc(4);
    count.writeUInt32LE(2);
    const expected = createHash("sha256")
      .update(
        Buffer.concat([
          Buffer.from("KHT1", "ascii"),
          count,
          entry("B.txt", "upper"),
          entry("z/a.txt", "nested"),
        ]),
      )
      .digest("hex");

    await expect(hashPortableHandoffTree(root, { deadline: Date.now() + 5_000 })).resolves.toBe(
      expected,
    );
    expect(PORTABLE_HANDOFF_TREE_HASH_SCHEMA).toBe("KHT1");
  });

  it("fails closed when the shared handoff operation budget is expired", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-tree-"));
    roots.push(root);
    writeFileSync(join(root, "file.txt"), "content");

    await expect(
      hashPortableHandoffTree(root, { deadline: 10, now: () => 11 }),
    ).rejects.toBeInstanceOf(PortableHandoffBuilderError);
    await expect(hashPortableHandoffTree(root, { deadline: 10, now: () => 11 })).rejects.toThrow(
      /timed out/u,
    );
  });

  it("honors cancellation before reading the tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-tree-"));
    roots.push(root);
    writeFileSync(join(root, "file.txt"), "content");
    const controller = new AbortController();
    controller.abort();

    await expect(
      hashPortableHandoffTree(root, {
        signal: controller.signal,
        deadline: Date.now() + 5_000,
      }),
    ).rejects.toThrow(/cancelled/u);
  });

  it("rejects an already-hashed file rewritten while a later file is scanned", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-tree-"));
    roots.push(root);
    const firstPath = join(root, "a.txt");
    writeFileSync(firstPath, "old");
    writeFileSync(join(root, "z.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
    let rewritten = false;

    await expect(
      hashPortableHandoffTree(root, {
        deadline: Date.now() + 5_000,
        yieldControl: () => {
          if (rewritten) return Promise.resolve();
          rewritten = true;
          writeFileSync(firstPath, "new");
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/changed during attestation/u);
    expect(rewritten).toBe(true);
  });

  it("rejects a parent directory rebound with the same names and bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-handoff-tree-"));
    roots.push(root);
    const parent = join(root, "a");
    mkdirSync(parent);
    writeFileSync(join(parent, "file.txt"), "same");
    writeFileSync(join(root, "z.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
    let rebound = false;

    await expect(
      hashPortableHandoffTree(root, {
        deadline: Date.now() + 5_000,
        yieldControl: () => {
          if (rebound) return Promise.resolve();
          rebound = true;
          rmSync(parent, { recursive: true });
          mkdirSync(parent);
          writeFileSync(join(parent, "file.txt"), "same");
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/changed during attestation/u);
    expect(rebound).toBe(true);
  });
});
