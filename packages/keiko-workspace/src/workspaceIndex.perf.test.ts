// GEN-PERF-CHAT-003 regression: the file-backed workspace snapshot must be memoized per
// snapshot-file path, keyed by the file's mtime+size fingerprint, so repeated grounded
// asks over an UNCHANGED workspace do not re-read + re-JSON.parse + re-normalize the same
// snapshot on every request.
//
// Mechanism proof (not wall-clock): we count node:fs/promises `open` calls — the only call
// site that performs the full snapshot READ. Two consecutive loads of an unchanged snapshot must
// open the file at most ONCE (cold read); the warm load is served from the parsed-snapshot
// cache after a cheap lstat. Writing new content (new mtime) must invalidate the cache and
// force a fresh read, proving conservative correctness-first invalidation.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// Wrap node:fs/promises so we can count the `open` calls that read a SNAPSHOT file. ESM
// module namespaces are not configurable, so vi.spyOn cannot patch `open` directly — we
// mock the module with a factory that delegates to the real implementation and tallies
// snapshot reads into a shared counter. We match only the hashed snapshot filename
// (workspace-index-<64 hex>.json) so the per-load runtime-dir MARKER file open
// (workspace-index-runtime-id) is not miscounted as a snapshot read.
const SNAPSHOT_FILE_RE = /workspace-index-[0-9a-f]{64}\.json$/u;
const snapshotOpenCalls = { count: 0 };
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

import {
  buildWorkspaceIndexSnapshot,
  createFileWorkspaceIndexStore,
  type WorkspaceIndexSnapshot,
} from "./workspaceIndex.js";

const runtimeDirs: string[] = [];

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

// Snapshot reads go through `open(path, O_RDONLY|O_NOFOLLOW)`; the freshness lstat does NOT
// open. `snapshotOpenCalls.count` (bumped by the module mock) tallies snapshot-file reads.
function markSnapshotReads(): { readonly opens: () => number } {
  const base = snapshotOpenCalls.count;
  return { opens: (): number => snapshotOpenCalls.count - base };
}

describe("file workspace index snapshot memoization (GEN-PERF-CHAT-003)", () => {
  it("reads + parses an unchanged snapshot once across repeated loads", async () => {
    const runtimeDir = tempRuntimeDir();
    const store = createFileWorkspaceIndexStore({ runtimeDir });
    const key = "perf-key";
    await store.saveSnapshot(key, sampleSnapshot());

    // Prime the cache with a first (cold) load, then measure subsequent loads.
    const first = await store.loadSnapshot(key);
    expect(first?.records).toHaveLength(1);

    const { opens } = markSnapshotReads();
    const second = await store.loadSnapshot(key);
    const third = await store.loadSnapshot(key);

    expect(second?.records).toHaveLength(1);
    expect(third?.records).toHaveLength(1);
    // The warm loads never re-open (read) the file — served from the parsed-snapshot cache.
    expect(opens()).toBe(0);
  });

  it("re-reads after the snapshot file changes (mtime+size invalidation)", async () => {
    const runtimeDir = tempRuntimeDir();
    const store = createFileWorkspaceIndexStore({ runtimeDir });
    const key = "perf-key-inv";
    await store.saveSnapshot(key, sampleSnapshot());
    await store.loadSnapshot(key); // prime cache

    // Rewrite the snapshot (atomic rename → new mtime). Add a second record so the parsed
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

    const { opens } = markSnapshotReads();
    const reloaded = await store.loadSnapshot(key);

    // Fingerprint diverged → cache miss → exactly one fresh read, and the NEW content wins.
    expect(opens()).toBe(1);
    expect(reloaded?.records).toHaveLength(2);
  });
});
