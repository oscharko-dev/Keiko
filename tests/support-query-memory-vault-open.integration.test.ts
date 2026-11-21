import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryId, MemoryRecord, UserId } from "@oscharko-dev/keiko-contracts/memory";
import { createFileServerLogSink, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { createMemoryVault, MEMORY_DB_FILENAME } from "../packages/keiko-memory-vault/src/index.js";
import {
  DEFAULT_SUPPORT_QUERY_LIMITS,
  runSupportQuery,
  type SupportQueryResult,
} from "../packages/keiko-activity-log/src/reader/support-query.js";
import {
  ActivityLogScanner,
  ensureSegmentManifests,
  listActivityLogStoreFiles,
} from "../packages/keiko-activity-log/src/reader/support-segment-scan.js";

const VAULT_KEY = Buffer.alloc(32, 5);
const OPENED = "memory-vault.store.opened";

function query(stateDir: string): SupportQueryResult {
  const files = listActivityLogStoreFiles(stateDir);
  const scanner = new ActivityLogScanner(stateDir);
  const pass = ensureSegmentManifests(stateDir, files, scanner, {
    trigger: "query",
    persist: false,
    rebuild: false,
  });
  return runSupportQuery({
    files,
    scanner,
    manifests: pass.manifests,
    manifestStats: pass.stats,
    selection: {
      kind: "closure",
      queryClass: "incident",
      roots: [],
      windows: [{ fromMs: 0, toMs: Date.now() + 1000 }],
      requiredClasses: { kind: "observed-failures" },
      unresolved: false,
    },
    limits: { ...DEFAULT_SUPPORT_QUERY_LIMITS, maxContextEvents: 0 },
  });
}

function memory(id: string, body: string): MemoryRecord {
  const at = 1_700_000_000_000;
  return {
    id: id as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "u-1" as UserId },
    type: "semantic-fact",
    body,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: at,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: at },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: at,
    updatedAt: at,
  };
}

describe("support selection of the memory vault open line (#4223)", () => {
  let root: string;
  let stateDir: string;
  let memoryDir: string;
  let sink: ServerLogSink;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-support-vault-open-"));
    stateDir = join(root, "state");
    memoryDir = join(root, "memory");
    const seed = createMemoryVault({
      memoryDir,
      env: { KEIKO_MEMORY_DIR: memoryDir },
      vaultKey: VAULT_KEY,
    });
    seed.insertMemory(memory("a", "prefers dark mode"));
    seed.insertMemory(memory("b", "works in Leeds"));
    seed.close();
    sink = createFileServerLogSink(stateDir, { level: "debug" });
  });

  afterEach(() => {
    sink.close?.();
    rmSync(root, { recursive: true, force: true });
  });

  function reopenAndSelect(prepare: (db: DatabaseSync) => void): boolean {
    const raw = new DatabaseSync(join(memoryDir, MEMORY_DB_FILENAME));
    prepare(raw);
    raw.close();
    createMemoryVault({
      memoryDir,
      env: { KEIKO_MEMORY_DIR: memoryDir },
      vaultKey: VAULT_KEY,
      logSink: sink,
    }).close();
    sink.flush?.();
    return query(stateDir).events.some((entry) => entry.parsed.view.op === OPENED);
  }

  it("retains an open that met a body it could not read, under zero optional context", () => {
    expect(
      reopenAndSelect((db) => {
        db.exec("UPDATE memories SET body_hash = NULL");
        db.exec("UPDATE memories SET body = 'kv1.not-valid' WHERE id = 'a'");
      }),
    ).toBe(true);
  });

  it("keeps an open that filled every fingerprint optional", () => {
    expect(
      reopenAndSelect((db) => {
        db.exec("UPDATE memories SET body_hash = NULL");
      }),
    ).toBe(false);
  });
});
