import { createHash, createHmac, hkdfSync } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type OpenFileHandle = Awaited<ReturnType<typeof import("node:fs/promises").open>>;

const fsHooks = vi.hoisted(() => ({
  afterOpen: undefined as ((path: string, handle: OpenFileHandle) => void) | undefined,
  afterRename: undefined as ((oldPath: string, newPath: string) => void) | undefined,
  beforeRemove: undefined as ((path: string) => void) | undefined,
  beforeRename: undefined as
    ((oldPath: string, newPath: string) => void | Promise<void>) | undefined,
  beforeReaddir: undefined as ((path: string) => void) | undefined,
  beforeMkdir: undefined as ((path: string) => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdir: async (
      path: Parameters<typeof original.mkdir>[0],
      options: { readonly recursive: true; readonly mode?: number },
    ): Promise<string | undefined> => {
      fsHooks.beforeMkdir?.(String(path));
      return await original.mkdir(path, options);
    },
    open: async (
      path: Parameters<typeof original.open>[0],
      flags: Parameters<typeof original.open>[1],
      mode?: Parameters<typeof original.open>[2],
    ): Promise<Awaited<ReturnType<typeof original.open>>> => {
      const handle =
        mode === undefined
          ? await original.open(path, flags)
          : await original.open(path, flags, mode);
      fsHooks.afterOpen?.(String(path), handle);
      return handle;
    },
    rename: async (
      oldPath: Parameters<typeof original.rename>[0],
      newPath: Parameters<typeof original.rename>[1],
    ): Promise<void> => {
      if (String(oldPath).endsWith(".json") && String(newPath).endsWith(".tmp")) {
        fsHooks.beforeRemove?.(String(oldPath));
      }
      await fsHooks.beforeRename?.(String(oldPath), String(newPath));
      await original.rename(oldPath, newPath);
      fsHooks.afterRename?.(String(oldPath), String(newPath));
    },
    rm: async (
      path: Parameters<typeof original.rm>[0],
      options?: Parameters<typeof original.rm>[1],
    ): Promise<void> => {
      fsHooks.beforeRemove?.(String(path));
      await original.rm(path, options);
    },
    readdir: async (
      path: Parameters<typeof original.readdir>[0],
      options: { readonly withFileTypes: true },
    ): Promise<import("node:fs").Dirent[]> => {
      fsHooks.beforeReaddir?.(String(path));
      return await original.readdir(path, options);
    },
  };
});

import {
  WORKSPACE_INDEX_SNAPSHOT_VERSION,
  createFileWorkspaceIndexStore,
  type WorkspaceIndexSnapshot,
} from "./workspaceIndex.js";

const KEY = Buffer.alloc(32, 41);
const ROTATED_KEY = Buffer.alloc(32, 43);
const MARKER_SEGMENT = "workspace-index-runtime-id";

function storageGenerationId(key: Buffer): string {
  const info = "keiko-workspace-index:key-generation:v2";
  const generationKey = Buffer.from(
    hkdfSync("sha256", key, "keiko-workspace-index:file-locator-salt:v2", info, 32),
  );
  return createHmac("sha256", generationKey).update(info).digest("hex");
}

function snapshot(scopePath: string): WorkspaceIndexSnapshot {
  return {
    version: WORKSPACE_INDEX_SNAPSHOT_VERSION,
    relativePaths: [],
    policyMode: "workspace-root-default",
    applyGitignore: true,
    omitLowValueWorkspaceFiles: true,
    maxBytesPerFileScanned: 1024,
    maxFilesScanned: 100,
    discovery: {
      files: [{ scopePath, sizeBytes: 1 }],
      directories: [],
      filesDiscovered: 1,
      ignoredByDiscovery: 0,
      deniedByDiscovery: 0,
      depthPrunedByDiscovery: 0,
      truncated: false,
    },
    records: [{ scopePath, sizeBytes: 1, kind: "text" }],
  };
}

function snapshotFiles(runtimeDir: string): readonly string[] {
  return readdirSync(runtimeDir).filter((name) =>
    /^workspace-index-v2-[0-9a-f]{64}-[0-9a-f]{64}\.json$/u.test(name),
  );
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function armParentSwap(
  runtimeDir: string,
  replacementDir: string,
  displacedDir: string,
  markerOpenTarget = 1,
): void {
  let markerOpenCount = 0;
  fsHooks.afterOpen = (path): void => {
    if (!path.endsWith(MARKER_SEGMENT)) return;
    markerOpenCount += 1;
    if (markerOpenCount !== markerOpenTarget) return;
    fsHooks.afterOpen = undefined;
    renameSync(runtimeDir, displacedDir);
    renameSync(replacementDir, runtimeDir);
  };
}

afterEach(() => {
  fsHooks.afterOpen = undefined;
  fsHooks.afterRename = undefined;
  fsHooks.beforeRemove = undefined;
  fsHooks.beforeRename = undefined;
  fsHooks.beforeReaddir = undefined;
  fsHooks.beforeMkdir = undefined;
});

describe("file workspace index runtime-directory identity", () => {
  it("does not expose a public digest of the candidate storage scope in its locator", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "keiko-index-keyed-locator-"));
    try {
      const candidateScope = JSON.stringify({
        workspaceRoot: "/candidate/customer-workspace",
        relativePaths: ["src/private"],
      });
      const storageKey = `keiko-workspace-index:${createHash("sha256").update(candidateScope).digest("hex")}`;
      const publicLocator = createHash("sha256").update(storageKey).digest("hex");
      const store = createFileWorkspaceIndexStore({ runtimeDir, encryptionKey: KEY });

      await store.saveSnapshot(storageKey, snapshot("src/private.ts"));

      expect(snapshotFiles(runtimeDir)).toHaveLength(1);
      expect(snapshotFiles(runtimeDir)[0]).not.toContain(`-${publicLocator}.json`);
    } finally {
      rmSync(runtimeDir, { force: true, recursive: true });
    }
  });

  it("authenticates same-size same-mtime ciphertext replacements before cache reuse", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "keiko-index-cache-auth-"));
    const failures: string[] = [];
    try {
      const storageKey = "same-metadata-corruption";
      const store = createFileWorkspaceIndexStore({
        runtimeDir,
        encryptionKey: KEY,
        onLoadFailure: (failure): void => void failures.push(failure.reason),
      });
      await store.saveSnapshot(storageKey, snapshot("src/expected.ts"));
      const [fileName] = snapshotFiles(runtimeDir);
      if (fileName === undefined) throw new Error("expected encrypted snapshot");
      const path = join(runtimeDir, fileName);
      const fixedTimeSeconds = 1_700_000_000;
      utimesSync(path, fixedTimeSeconds, fixedTimeSeconds);
      await expect(store.loadSnapshot(storageKey)).resolves.toBeDefined();

      const raw = readFileSync(path, "utf8");
      const replacement = `${path}.replacement`;
      const corrupted = `${raw.slice(0, -1)}${raw.endsWith("A") ? "B" : "A"}`;
      writeFileSync(replacement, corrupted, { encoding: "utf8", mode: 0o600 });
      renameSync(replacement, path);
      utimesSync(path, fixedTimeSeconds, fixedTimeSeconds);

      await expect(store.loadSnapshot(storageKey)).resolves.toBeUndefined();
      expect(failures).toEqual(["authentication-or-corruption"]);
    } finally {
      rmSync(runtimeDir, { force: true, recursive: true });
    }
  });

  it("isolates a rotated key generation from stale writers and their pruning", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "keiko-index-key-generation-"));
    const newGenerationFailures: string[] = [];
    try {
      const storageKey = "shared-scope";
      const staleStore = createFileWorkspaceIndexStore({
        runtimeDir,
        encryptionKey: KEY,
        maxSnapshots: 1,
      });
      await staleStore.saveSnapshot(storageKey, snapshot("src/old.ts"));

      const rotatedStore = createFileWorkspaceIndexStore({
        runtimeDir,
        encryptionKey: ROTATED_KEY,
        maxSnapshots: 1,
        onLoadFailure: (failure): void => void newGenerationFailures.push(failure.reason),
      });
      await rotatedStore.saveSnapshot(storageKey, snapshot("src/new.ts"));
      expect((await rotatedStore.loadSnapshot(storageKey))?.discovery.files[0]?.scopePath).toBe(
        "src/new.ts",
      );

      await staleStore.saveSnapshot(storageKey, snapshot("src/stale-late.ts"));

      expect((await rotatedStore.loadSnapshot(storageKey))?.discovery.files[0]?.scopePath).toBe(
        "src/new.ts",
      );
      expect((await staleStore.loadSnapshot(storageKey))?.discovery.files[0]?.scopePath).toBe(
        "src/stale-late.ts",
      );
      expect(newGenerationFailures).toEqual([]);
      expect(snapshotFiles(runtimeDir)).toHaveLength(2);
    } finally {
      rmSync(runtimeDir, { force: true, recursive: true });
    }
  });

  it("globally bounds active generations and fences a retired generation", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "keiko-index-global-generation-cap-"));
    let originalGenerationActive = true;
    try {
      const originalOptions = {
        runtimeDir,
        encryptionKey: KEY,
        maxSnapshots: 1,
        isGenerationActive: (): boolean => originalGenerationActive,
      };
      const originalStore = createFileWorkspaceIndexStore(originalOptions);
      await originalStore.saveSnapshot("shared-scope", snapshot("src/old.ts"));

      originalGenerationActive = false;
      const rotatedOptions = {
        runtimeDir,
        encryptionKey: ROTATED_KEY,
        maxSnapshots: 1,
        isGenerationActive: (): boolean => true,
      };
      const rotatedStore = createFileWorkspaceIndexStore(rotatedOptions);
      await rotatedStore.saveSnapshot("shared-scope", snapshot("src/new.ts"));

      expect(snapshotFiles(runtimeDir)).toHaveLength(1);
      await expect(originalStore.loadSnapshot("shared-scope")).resolves.toBeUndefined();
      await expect(
        originalStore.saveSnapshot("shared-scope", snapshot("src/stale-late.ts")),
      ).rejects.toThrow("generation is no longer active");
      await expect(rotatedStore.loadSnapshot("shared-scope")).resolves.toMatchObject({
        discovery: { files: [{ scopePath: "src/new.ts" }] },
      });
      expect(snapshotFiles(runtimeDir)).toHaveLength(1);
    } finally {
      rmSync(runtimeDir, { force: true, recursive: true });
    }
  });

  it("removes legacy public-locator snapshots when an active generation commits", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "keiko-index-legacy-locator-cleanup-"));
    try {
      const legacyName = `workspace-index-${"a".repeat(64)}-${"b".repeat(64)}.json`;
      writeFileSync(join(runtimeDir, legacyName), "legacy", { encoding: "utf8", mode: 0o600 });
      const store = createFileWorkspaceIndexStore({
        runtimeDir,
        encryptionKey: KEY,
        isGenerationActive: (): boolean => true,
      });

      await store.saveSnapshot("fresh-scope", snapshot("src/fresh.ts"));

      expect(readdirSync(runtimeDir)).not.toContain(legacyName);
      expect(snapshotFiles(runtimeDir)).toHaveLength(1);
    } finally {
      rmSync(runtimeDir, { force: true, recursive: true });
    }
  });

  it("removes an in-flight commit when its generation retires during rename", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "keiko-index-inflight-generation-fence-"));
    const commitEntered = deferred();
    const releaseCommit = deferred();
    let generationActive = true;
    try {
      const store = createFileWorkspaceIndexStore({
        runtimeDir,
        encryptionKey: KEY,
        isGenerationActive: (): boolean => generationActive,
      });
      fsHooks.beforeRename = async (oldPath, newPath): Promise<void> => {
        if (!oldPath.endsWith(".tmp") || !newPath.endsWith(".json")) return;
        fsHooks.beforeRename = undefined;
        commitEntered.resolve();
        await releaseCommit.promise;
      };

      const save = store.saveSnapshot("in-flight", snapshot("src/stale.ts"));
      await commitEntered.promise;
      generationActive = false;
      releaseCommit.resolve();

      await expect(save).rejects.toThrow("generation is no longer active");
      expect(snapshotFiles(runtimeDir)).toEqual([]);
      expect(readdirSync(runtimeDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      releaseCommit.resolve();
      fsHooks.beforeRename = undefined;
      rmSync(runtimeDir, { force: true, recursive: true });
    }
  });

  it("serializes stores that reach the same runtime directory through parent aliases", async () => {
    const parent = await mkdtemp(join(tmpdir(), "keiko-index-alias-serialization-"));
    const runtimeDir = join(parent, "runtime");
    const aliasParent = join(parent, "alias-parent");
    mkdirSync(runtimeDir, { mode: 0o700 });
    symlinkSync(parent, aliasParent, "dir");
    const firstCommitEntered = deferred();
    const releaseFirstCommit = deferred();
    let commitCount = 0;
    let operationCount = 0;
    try {
      const directStore = createFileWorkspaceIndexStore({ runtimeDir, encryptionKey: KEY });
      const aliasStore = createFileWorkspaceIndexStore({
        runtimeDir: join(aliasParent, "runtime"),
        encryptionKey: KEY,
      });
      fsHooks.beforeMkdir = (): void => {
        operationCount += 1;
      };
      fsHooks.beforeRename = async (oldPath, newPath): Promise<void> => {
        if (!oldPath.endsWith(".tmp") || !newPath.endsWith(".json")) return;
        commitCount += 1;
        if (commitCount !== 1) return;
        firstCommitEntered.resolve();
        await releaseFirstCommit.promise;
      };

      const firstSave = directStore.saveSnapshot("first", snapshot("src/first.ts"));
      await firstCommitEntered.promise;
      const secondSave = aliasStore.saveSnapshot("second", snapshot("src/second.ts"));
      await Promise.resolve();

      expect(operationCount).toBe(1);
      releaseFirstCommit.resolve();
      await Promise.all([firstSave, secondSave]);
      expect(operationCount).toBe(2);
      expect(commitCount).toBe(2);
    } finally {
      releaseFirstCommit.resolve();
      fsHooks.beforeMkdir = undefined;
      fsHooks.beforeRename = undefined;
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("rejects a valid encrypted snapshot when the parent is swapped after its marker is opened", async () => {
    const parent = await mkdtemp(join(tmpdir(), "keiko-index-parent-race-"));
    const runtimeDir = await mkdtemp(join(parent, "runtime-"));
    const replacementDir = await mkdtemp(join(parent, "replacement-"));
    const displacedDir = join(parent, "displaced-runtime");
    try {
      const storageKey = "same-scope";
      const expected = snapshot("src/expected.ts");
      const poison = snapshot("src/poison.ts");
      const expectedStore = createFileWorkspaceIndexStore({
        runtimeDir,
        encryptionKey: KEY,
      });
      const replacementStore = createFileWorkspaceIndexStore({
        runtimeDir: replacementDir,
        encryptionKey: KEY,
      });
      await expectedStore.saveSnapshot(storageKey, expected);
      await replacementStore.saveSnapshot(storageKey, poison);
      // Establish the original marker/identity without populating the target snapshot cache.
      await expectedStore.saveSnapshot("identity-prime", expected);

      armParentSwap(runtimeDir, replacementDir, displacedDir);

      await expect(expectedStore.loadSnapshot(storageKey)).resolves.toBeUndefined();
    } finally {
      fsHooks.afterOpen = undefined;
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("does not reuse a parsed snapshot cache entry after the parent identity drifts", async () => {
    const parent = await mkdtemp(join(tmpdir(), "keiko-index-cache-race-"));
    const runtimeDir = await mkdtemp(join(parent, "runtime-"));
    const replacementDir = await mkdtemp(join(parent, "replacement-"));
    const displacedDir = join(parent, "displaced-runtime");
    try {
      const storageKey = "cached-scope";
      const expectedStore = createFileWorkspaceIndexStore({
        runtimeDir,
        encryptionKey: KEY,
      });
      await expectedStore.saveSnapshot(storageKey, snapshot("src/cached.ts"));
      await expect(expectedStore.loadSnapshot(storageKey)).resolves.toBeDefined();
      const [fileName] = snapshotFiles(runtimeDir);
      if (fileName === undefined) throw new Error("expected cached snapshot file");
      const sourcePath = join(runtimeDir, fileName);
      const replacementPath = join(replacementDir, fileName);
      copyFileSync(sourcePath, replacementPath);
      const sourceStat = statSync(sourcePath);
      utimesSync(replacementPath, sourceStat.atime, sourceStat.mtime);

      armParentSwap(runtimeDir, replacementDir, displacedDir);

      await expect(expectedStore.loadSnapshot(storageKey)).resolves.toBeUndefined();
    } finally {
      fsHooks.afterOpen = undefined;
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("does not commit a snapshot after the parent is swapped during the write guard", async () => {
    const parent = await mkdtemp(join(tmpdir(), "keiko-index-write-race-"));
    const runtimeDir = await mkdtemp(join(parent, "runtime-"));
    const replacementDir = await mkdtemp(join(parent, "replacement-"));
    const displacedDir = join(parent, "displaced-runtime");
    try {
      const store = createFileWorkspaceIndexStore({ runtimeDir, encryptionKey: KEY });
      await store.saveSnapshot("identity-prime", snapshot("src/prime.ts"));
      armParentSwap(runtimeDir, replacementDir, displacedDir, 2);

      await expect(
        store.saveSnapshot("attacked-scope", snapshot("src/private.ts")),
      ).rejects.toThrow("workspace index temp snapshot cleanup failed");

      expect(snapshotFiles(runtimeDir)).toEqual([]);
      const orphanedTemp = readdirSync(displacedDir).find((name) => name.endsWith(".tmp"));
      if (orphanedTemp === undefined) throw new Error("expected zeroed displaced temp file");
      expect(statSync(join(displacedDir, orphanedTemp)).size).toBe(0);
    } finally {
      fsHooks.afterOpen = undefined;
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it("rejects a temp-path replacement instead of reporting a corrupted snapshot as saved", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "keiko-index-temp-swap-"));
    try {
      const store = createFileWorkspaceIndexStore({ runtimeDir, encryptionKey: KEY });
      let displacedTempPath: string | undefined;
      fsHooks.beforeRename = (oldPath): void => {
        if (!oldPath.endsWith(".tmp")) return;
        fsHooks.beforeRename = undefined;
        displacedTempPath = `${oldPath}.owned`;
        renameSync(oldPath, displacedTempPath);
        writeFileSync(oldPath, "foreign replacement", { encoding: "utf8", mode: 0o600 });
      };

      await expect(store.saveSnapshot("temp-swap", snapshot("src/private.ts"))).rejects.toThrow(
        "workspace index committed snapshot identity changed",
      );

      expect(displacedTempPath).toBeDefined();
      expect(snapshotFiles(runtimeDir)).toHaveLength(1);
      await expect(store.loadSnapshot("temp-swap")).resolves.toBeUndefined();
    } finally {
      fsHooks.beforeRename = undefined;
      rmSync(runtimeDir, { force: true, recursive: true });
    }
  });

  it("rejects a final-path replacement in the post-rename commit window", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "keiko-index-final-swap-"));
    const replacement = "foreign final replacement";
    try {
      const store = createFileWorkspaceIndexStore({ runtimeDir, encryptionKey: KEY });
      fsHooks.afterRename = (oldPath, newPath): void => {
        if (!oldPath.endsWith(".tmp") || !newPath.endsWith(".json")) return;
        fsHooks.afterRename = undefined;
        renameSync(newPath, `${newPath}.owned`);
        writeFileSync(newPath, replacement, { encoding: "utf8", mode: 0o600 });
      };

      await expect(store.saveSnapshot("final-swap", snapshot("src/private.ts"))).rejects.toThrow(
        "workspace index committed snapshot identity changed",
      );

      const retainedForeign = readdirSync(runtimeDir).some((name) => {
        const path = join(runtimeDir, name);
        return statSync(path).isFile() && readFileSync(path, "utf8") === replacement;
      });
      expect(retainedForeign).toBe(true);
    } finally {
      fsHooks.afterRename = undefined;
      rmSync(runtimeDir, { force: true, recursive: true });
    }
  });

  it("fails closed and reports a content-free save failure when verification close rejects", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "keiko-index-close-failure-"));
    const privateScopePath = "src/private/customer-record.ts";
    const failures: { readonly reason: string }[] = [];
    try {
      const store = createFileWorkspaceIndexStore({
        runtimeDir,
        encryptionKey: KEY,
        onSaveFailure: (failure): void => {
          failures.push(failure);
        },
      });
      fsHooks.afterOpen = (path, handle): void => {
        if (!path.endsWith(".json")) return;
        fsHooks.afterOpen = undefined;
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementationOnce(async (): Promise<void> => {
          await close();
          throw new Error("synthetic snapshot verification close failure");
        });
      };

      await expect(store.saveSnapshot("close-failure", snapshot(privateScopePath))).rejects.toThrow(
        "synthetic snapshot verification close failure",
      );

      expect(failures).toEqual([{ reason: "write-or-cleanup-failure" }]);
      expect(JSON.stringify(failures)).not.toContain(privateScopePath);
      expect(readdirSync(runtimeDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      fsHooks.afterOpen = undefined;
      rmSync(runtimeDir, { force: true, recursive: true });
    }
  });

  it("does not delete a snapshot path that was replaced after prune selection", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "keiko-index-prune-swap-"));
    const replacement = "foreign replacement retained";
    try {
      const store = createFileWorkspaceIndexStore({
        runtimeDir,
        encryptionKey: KEY,
        maxSnapshots: 1,
      });
      await store.saveSnapshot("old", snapshot("src/old.ts"));
      const [oldFileName] = snapshotFiles(runtimeDir);
      if (oldFileName === undefined) throw new Error("expected old encrypted snapshot");
      const oldPath = join(runtimeDir, oldFileName);
      utimesSync(oldPath, 1, 1);
      let intercepted = false;
      fsHooks.beforeRemove = (path): void => {
        if (!path.endsWith(".json")) return;
        fsHooks.beforeRemove = undefined;
        intercepted = true;
        renameSync(path, `${path}.owned`);
        writeFileSync(path, replacement, { encoding: "utf8", mode: 0o600 });
      };

      await expect(store.saveSnapshot("new", snapshot("src/new.ts"))).rejects.toThrow(
        "workspace index prune candidate identity changed",
      );

      expect(intercepted).toBe(true);
      const retainedForeign = readdirSync(runtimeDir).some((name) => {
        const path = join(runtimeDir, name);
        return statSync(path).isFile() && readFileSync(path, "utf8") === replacement;
      });
      expect(retainedForeign).toBe(true);
    } finally {
      fsHooks.beforeRemove = undefined;
      rmSync(runtimeDir, { force: true, recursive: true });
    }
  });

  it("does not prune snapshot-shaped files after the parent changes during enumeration", async () => {
    const parent = await mkdtemp(join(tmpdir(), "keiko-index-prune-race-"));
    const runtimeDir = await mkdtemp(join(parent, "runtime-"));
    const replacementDir = await mkdtemp(join(parent, "replacement-"));
    const displacedDir = join(parent, "displaced-runtime");
    const generationId = storageGenerationId(KEY);
    const decoys = [
      `workspace-index-v2-${generationId}-${"a".repeat(64)}.json`,
      `workspace-index-v2-${generationId}-${"b".repeat(64)}.json`,
    ];
    try {
      for (const decoy of decoys) {
        writeFileSync(join(replacementDir, decoy), "foreign", "utf8");
      }
      const store = createFileWorkspaceIndexStore({
        runtimeDir,
        encryptionKey: KEY,
        maxSnapshots: 1,
      });
      fsHooks.beforeReaddir = (): void => {
        fsHooks.beforeReaddir = undefined;
        renameSync(runtimeDir, displacedDir);
        renameSync(replacementDir, runtimeDir);
      };

      await store.saveSnapshot("prune-race", snapshot("src/private.ts"));

      expect(readdirSync(runtimeDir).filter((name) => decoys.includes(name))).toEqual(decoys);
    } finally {
      fsHooks.afterOpen = undefined;
      fsHooks.beforeReaddir = undefined;
      rmSync(parent, { force: true, recursive: true });
    }
  });
});
