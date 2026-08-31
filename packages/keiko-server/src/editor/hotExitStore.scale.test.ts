// GEN-PERF-PERSISTENCE-002 + GEN-PERF-BENCHMARK-010: prune() on the 400ms keystroke-flush write hot
// path must NOT decrypt (vault.get) every stored snapshot. We inject an instrumented LocalSecretVault
// backed by a real encrypted on-disk vault and count get() calls (each is one full-file read + one
// AES-GCM decrypt) as the direct proxy for "decrypt every snapshot". Content stays AES-GCM sealed
// (asserted in hotExitStore.test.ts); the injected vault delegates to the real sealing vault.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalSecretVault,
  type LocalSecretVault,
} from "@oscharko-dev/keiko-security/secret-vault";
import type { EditorHotExitSnapshotV1 } from "@oscharko-dev/keiko-contracts";
import { EDITOR_HOT_EXIT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-hot-exit";
import { createEditorHotExitStore } from "./hotExitStore.js";

const REAL_TMPDIR = realpathSync(tmpdir());
const VAULT_KEY = Buffer.alloc(32, 0x71);
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStateDir(): string {
  const dir = mkdtempSync(join(REAL_TMPDIR, "keiko-hot-exit-scale-"));
  tmpDirs.push(dir);
  return dir;
}

interface CountingVault {
  readonly vault: LocalSecretVault;
  getCount: () => number;
  reset: () => void;
}

function countingVault(stateDir: string): CountingVault {
  const storePath = join(stateDir, "editor-hot-exit", "snapshots.vault");
  const inner = createLocalSecretVault({ key: VAULT_KEY, storePath });
  let gets = 0;
  const vault: LocalSecretVault = {
    get: (reference) => {
      gets += 1;
      return inner.get(reference);
    },
    set: (reference, secret) => {
      inner.set(reference, secret);
    },
    setMany: (batch: ReadonlyMap<string, string>): void => {
      inner.setMany(batch);
    },
    replaceAll: (next) => {
      inner.replaceAll(next);
    },
    delete: (reference) => {
      inner.delete(reference);
    },
    has: (reference) => inner.has(reference),
    list: () => inner.list(),
  };
  return {
    vault,
    getCount: () => gets,
    reset: (): void => {
      gets = 0;
    },
  };
}

function snapshot(index: number, updatedAt: number): EditorHotExitSnapshotV1 {
  return {
    schemaVersion: EDITOR_HOT_EXIT_SCHEMA_VERSION,
    workspaceRoot: "/repo",
    relativePath: `src/file-${String(index)}.ts`,
    content: `const value${String(index)} = ${String(index)};\n`,
    baseVersion: { sizeBytes: 16, modifiedAt: 1, contentHash: "a".repeat(64) },
    contentHash: "b".repeat(64),
    savedContentHash: "a".repeat(64),
    updatedAt,
    paneId: "pane-1",
    windowId: "editor-1",
  };
}

describe("editor hot-exit store write hot path (GEN-PERF-PERSISTENCE-002)", () => {
  it("does not re-decrypt every stored snapshot on each warm write", () => {
    const stateDir = tempStateDir();
    const instrumented = countingVault(stateDir);
    const store = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: VAULT_KEY.toString("base64") },
      vault: instrumented.vault,
    });

    // updatedAt values stay near the real clock: write() prunes against Date.now() (KEIKO-0367),
    // so a synthetic epoch-relative timestamp would already read as TTL-expired and be reaped by
    // its own write, defeating this test's setup.
    const base = Date.now();
    const N = 50;
    for (let i = 0; i < N; i += 1) {
      const item = snapshot(i, base + i);
      store.write(item, store.snapshotRefFor(item.workspaceRoot, item.relativePath));
    }

    // Warm the store: metadata index is now seeded. Measure decrypts for one additional write.
    instrumented.reset();
    const warm = snapshot(0, base + N);
    store.write(warm, store.snapshotRefFor(warm.workspaceRoot, warm.relativePath));

    // A warm write must not decrypt the other stored snapshots. Pre-fix, prune() called vault.get
    // for every stored ref => >= N decrypts. Fixed code decrypts none on the write path.
    expect(instrumented.getCount()).toBeLessThan(5);
  });

  it("prune performs O(1) decrypts even with eviction engaged near the byte cap (N=50)", () => {
    const stateDir = tempStateDir();
    const instrumented = countingVault(stateDir);
    const store = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: VAULT_KEY.toString("base64") },
      vault: instrumented.vault,
    });

    // Large payloads so total approaches MAX_TOTAL_BYTES (8 MiB) and prune eviction engages.
    // updatedAt values stay near the real clock for the same reason as the previous test.
    const base = Date.now();
    const big = "x".repeat(120 * 1024);
    for (let i = 0; i < 50; i += 1) {
      const item = { ...snapshot(i, base + i), content: `${big}${String(i)}` };
      store.write(item, store.snapshotRefFor(item.workspaceRoot, item.relativePath));
    }

    instrumented.reset();
    const evictor = { ...snapshot(999, base + 1_000), content: `${big}999` };
    store.write(evictor, store.snapshotRefFor(evictor.workspaceRoot, evictor.relativePath));

    // O(1) decrypts regardless of N. A pre-fix O(N) prune decrypts every stored ref (>= 50);
    // the fixed code stays under a small constant with 3-5x headroom.
    expect(instrumented.getCount()).toBeLessThan(5);
  });

  it("cold-start warms the metadata index with exactly one decrypt pass", () => {
    const stateDir = tempStateDir();
    // Seed via a first store instance, then open a fresh store over the same encrypted vault.
    const seed = countingVault(stateDir);
    const seedStore = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: VAULT_KEY.toString("base64") },
      vault: seed.vault,
    });
    // updatedAt values stay near the real clock: write() prunes against Date.now() (KEIKO-0367),
    // so a synthetic epoch-relative timestamp would already read as TTL-expired and be reaped by
    // its own write, leaving nothing for the cold store below to find on disk.
    const base = Date.now();
    const N = 20;
    for (let i = 0; i < N; i += 1) {
      const item = snapshot(i, base + i);
      seedStore.write(item, seedStore.snapshotRefFor(item.workspaceRoot, item.relativePath));
    }

    const cold = countingVault(stateDir);
    const coldStore = createEditorHotExitStore({
      stateDir,
      env: { KEIKO_EDITOR_HOT_EXIT_KEY: VAULT_KEY.toString("base64") },
      vault: cold.vault,
    });

    // First write on a cold store triggers the one-time metadata build (N decrypts) plus the write.
    const coldFirst = snapshot(0, base + N);
    coldStore.write(
      coldFirst,
      coldStore.snapshotRefFor(coldFirst.workspaceRoot, coldFirst.relativePath),
    );
    const afterCold = cold.getCount();

    // Second write must reuse the warm index: no further bulk decrypt.
    cold.reset();
    const coldSecond = snapshot(1, base + N + 1);
    coldStore.write(
      coldSecond,
      coldStore.snapshotRefFor(coldSecond.workspaceRoot, coldSecond.relativePath),
    );

    expect(afterCold).toBeGreaterThanOrEqual(N); // cold build decrypts existing entries once
    expect(cold.getCount()).toBeLessThan(5); // warm write decrypts nothing bulk
  });
});
