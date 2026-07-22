// GEN-PERF-CHAT-003 regression: the file-backed workspace snapshot must be memoized per
// snapshot-file path and complete ciphertext digest, so repeated grounded asks over an
// UNCHANGED workspace do not re-authenticate + re-JSON.parse + re-normalize the same snapshot.
//
// Mechanism proof (not wall-clock): every load reads and hashes the ciphertext before cache reuse
// so metadata-preserving replacements cannot return stale data. We count both reads and
// authenticated decryptions to prove warm loads still skip the expensive parse pipeline.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// Wrap node:fs/promises so we can count the `open` calls that read a SNAPSHOT file. ESM
// module namespaces are not configurable, so vi.spyOn cannot patch `open` directly — we
// mock the module with a factory that delegates to the real implementation and tallies
// snapshot reads into a shared counter. We match only the generation-scoped snapshot filename
// (workspace-index-v2-<64 hex>-<64 hex>.json) so the per-load runtime-dir MARKER file open
// (workspace-index-runtime-id) is not miscounted as a snapshot read.
const SNAPSHOT_FILE_RE = /workspace-index-v2-[0-9a-f]{64}-[0-9a-f]{64}\.json$/u;
const snapshotOpenCalls = { count: 0 };
const snapshotAuthenticationCalls = { count: 0 };
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> => {
      const target = typeof args[0] === "string" ? args[0] : String(args[0]);
      if (SNAPSHOT_FILE_RE.test(target)) snapshotOpenCalls.count += 1;
      return actual.open(...args);
    },
  };
});
vi.mock("@oscharko-dev/keiko-security", async () => {
  const actual = await vi.importActual<typeof import("@oscharko-dev/keiko-security")>(
    "@oscharko-dev/keiko-security",
  );
  return {
    ...actual,
    openString: (
      ...args: Parameters<typeof actual.openString>
    ): ReturnType<typeof actual.openString> => {
      snapshotAuthenticationCalls.count += 1;
      return actual.openString(...args);
    },
  };
});

import {
  buildWorkspaceIndexSnapshot,
  createFileWorkspaceIndexStore as createEncryptedFileWorkspaceIndexStore,
  type FileWorkspaceIndexStoreOptions,
  type WorkspaceIndexStore,
  type WorkspaceIndexSnapshot,
} from "./workspaceIndex.js";

const runtimeDirs: string[] = [];
const FILE_INDEX_TEST_KEY = Buffer.alloc(32, 29);

function createFileWorkspaceIndexStore(
  options: Omit<FileWorkspaceIndexStoreOptions, "encryptionKey">,
): WorkspaceIndexStore {
  return createEncryptedFileWorkspaceIndexStore({
    ...options,
    encryptionKey: FILE_INDEX_TEST_KEY,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  while (runtimeDirs.length > 0) {
    const dir = runtimeDirs.pop();
    if (dir !== undefined) rmSync(dir, { force: true, recursive: true });
  }
});

function tempRuntimeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-ws-index-perf-"));
  runtimeDirs.push(dir);
  return dir;
}

function sampleSnapshot(): WorkspaceIndexSnapshot {
  return buildWorkspaceIndexSnapshot({
    scope: { relativePaths: [] },
    policy: {
      policyMode: "workspace-root-default",
      applyGitignore: true,
      omitLowValueWorkspaceFiles: true,
    },
    maxBytesPerFileScanned: 1024,
    maxFilesScanned: 100,
    discovery: {
      files: [{ scopePath: "src/a.ts", sizeBytes: 12 }],
      directories: [{ scopePath: "", fingerprint: "root" }],
      filesDiscovered: 1,
      ignoredByDiscovery: 0,
      deniedByDiscovery: 0,
      depthPrunedByDiscovery: 0,
      truncated: false,
    },
    records: [{ scopePath: "src/a.ts", sizeBytes: 12, kind: "binary" as const }],
  });
}

function markSnapshotWork(): {
  readonly authentications: () => number;
  readonly opens: () => number;
} {
  const authenticationBase = snapshotAuthenticationCalls.count;
  const openBase = snapshotOpenCalls.count;
  return {
    authentications: (): number => snapshotAuthenticationCalls.count - authenticationBase,
    opens: (): number => snapshotOpenCalls.count - openBase,
  };
}

describe("file workspace index snapshot memoization (GEN-PERF-CHAT-003)", () => {
  it("authenticates + parses unchanged ciphertext once across repeated loads", async () => {
    const runtimeDir = tempRuntimeDir();
    const store = createFileWorkspaceIndexStore({ runtimeDir });
    const key = "perf-key";
    await store.saveSnapshot(key, sampleSnapshot());

    // Prime the cache with a first (cold) load, then measure subsequent loads.
    const first = await store.loadSnapshot(key);
    expect(first?.records).toHaveLength(1);

    const { authentications, opens } = markSnapshotWork();
    const second = await store.loadSnapshot(key);
    const third = await store.loadSnapshot(key);

    expect(second?.records).toHaveLength(1);
    expect(third?.records).toHaveLength(1);
    expect(opens()).toBe(2);
    expect(authentications()).toBe(0);
  });

  it("re-authenticates after the snapshot ciphertext changes", async () => {
    const runtimeDir = tempRuntimeDir();
    const store = createFileWorkspaceIndexStore({ runtimeDir });
    const key = "perf-key-inv";
    await store.saveSnapshot(key, sampleSnapshot());
    await store.loadSnapshot(key); // prime cache

    // Rewrite the snapshot atomically. Add a second record so the parsed
    // result also differs, proving the fresh read is actually served (not the stale cache).
    const changed = buildWorkspaceIndexSnapshot({
      scope: { relativePaths: [] },
      policy: {
        policyMode: "workspace-root-default",
        applyGitignore: true,
        omitLowValueWorkspaceFiles: true,
      },
      maxBytesPerFileScanned: 1024,
      maxFilesScanned: 100,
      discovery: {
        files: [
          { scopePath: "src/a.ts", sizeBytes: 12 },
          { scopePath: "src/b.ts", sizeBytes: 20 },
        ],
        directories: [{ scopePath: "", fingerprint: "root" }],
        filesDiscovered: 2,
        ignoredByDiscovery: 0,
        deniedByDiscovery: 0,
        depthPrunedByDiscovery: 0,
        truncated: false,
      },
      records: [
        { scopePath: "src/a.ts", sizeBytes: 12, kind: "binary" as const },
        { scopePath: "src/b.ts", sizeBytes: 20, kind: "binary" as const },
      ],
    });
    await store.saveSnapshot(key, changed);

    const { authentications, opens } = markSnapshotWork();
    const reloaded = await store.loadSnapshot(key);

    // Ciphertext digest diverged, so the cache miss re-authenticates and serves the new content.
    expect(opens()).toBe(1);
    expect(authentications()).toBe(1);
    expect(reloaded?.records).toHaveLength(2);
  });
});
