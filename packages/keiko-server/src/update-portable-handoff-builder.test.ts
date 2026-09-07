import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { refreshPortableRegistration } from "./update-portable-activation-files.js";
import { readPortableHandoffPlan } from "./update-portable-handoff-plan.js";

const roots: string[] = [];
const OLD_VERSION = "1.2.2";
const NEW_VERSION = "1.2.3";

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function writeInstall(root: string, version: string): void {
  mkdirSync(join(root, "app"), { recursive: true });
  mkdirSync(join(root, ".portable"), { recursive: true });
  mkdirSync(join(root, "runtime", "native"), { recursive: true });
  writeFileSync(join(root, "Keiko.exe"), `launcher-${version}`);
  writeFileSync(
    join(root, "runtime", "native", "keiko-runtime-supervisor.exe"),
    `supervisor-${version}`,
  );
  writeFileSync(
    join(root, "app", "package.json"),
    JSON.stringify({ name: "@oscharko-dev/keiko", version }),
  );
  writeFileSync(
    join(root, ".portable", "setup-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      platformTarget: "windows-x64",
      packageName: "@oscharko-dev/keiko",
      packageVersion: version,
      stable: true,
      bootstrapUpdateEligible: false,
      primaryLauncher: "Keiko.exe",
      runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
    }),
  );
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
    writeInstall(managedRoot, OLD_VERSION);
    writeInstall(candidateRoot, NEW_VERSION);
    refreshPortableRegistration({
      stateDir,
      layout: {
        installRoot: managedRoot,
        appRoot: join(managedRoot, "app"),
        packageJsonPath: join(managedRoot, "app", "package.json"),
        setupManifestPath: join(managedRoot, ".portable", "setup-manifest.json"),
        launcherPath: join(managedRoot, "Keiko.exe"),
      },
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
        runtimeFacts: { packageRoot: join(managedRoot, "app"), portableStateDir: stateDir },
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
    expect(prepared.plan.digests.previousRegistrationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      readFileSync(
        join(stateDir, "updates", "handoff", prepared.activationId, "registration.next"),
        "utf8",
      ),
    ).toContain(NEW_VERSION);
    const attest = createPortableHandoffTreeAttestor({ managedRoot });
    await expect(attest(prepared.plan.digests.currentTreeSha256)).resolves.toBe(true);
    writeFileSync(join(managedRoot, "app", "package.json"), "changed");
    await expect(attest(prepared.plan.digests.currentTreeSha256)).resolves.toBe(false);
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
