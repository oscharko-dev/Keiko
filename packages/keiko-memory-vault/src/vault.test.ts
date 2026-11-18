import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryId,
  MemoryRecord,
  MemoryReviewerId,
  ProjectId,
  UserId,
  WorkflowDefinitionId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import {
  createMemoryVault,
  memoryBodySuppressionHash,
  MEMORY_DB_FILENAME,
  MemoryStorageError,
  MemoryStoragePreconditionError,
  MemoryStorageValidationError,
  type MemoryContentCipher,
  type MemoryEmbeddingInput,
  type MemoryEvent,
  type MemoryVaultStore,
} from "./index.js";
import type { MemoryVaultLogEvent, MemoryVaultLogSink } from "./vault-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

// Deterministic injected key so the vault tests never touch the OS keychain or write a keyfile,
// and so encrypted-at-rest reads are reproducible across the suite (ADR-0035).
const TEST_VAULT_KEY = Buffer.alloc(32, 7);

const cleanups: string[] = [];

afterEach(() => {
  for (const path of cleanups.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function freshDir(): string {
  // Realpath the tmpdir to avoid tripping the (correct) walk-every-ancestor symlink guard on
  // macOS, where /var (and /tmp) are legitimate system-level symlinks. On Linux this is a no-op.
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-mem-vault-"));
  cleanups.push(dir);
  return dir;
}

function openVault(
  dir: string,
  events: MemoryEvent[] = [],
  nowSeq: { value: number } = { value: 1_700_000_000_000 },
  idCounter: { value: number } = { value: 0 },
): MemoryVaultStore {
  return createMemoryVault({
    memoryDir: dir,
    env: { KEIKO_MEMORY_DIR: dir },
    vaultKey: TEST_VAULT_KEY,
    now: () => nowSeq.value,
    newTombstoneId: () => {
      idCounter.value += 1;
      return `t-${String(idCounter.value)}`;
    },
    onMemoryEvent: (e) => events.push(e),
  });
}

function listAllMemories(
  vault: MemoryVaultStore,
  options?: Parameters<MemoryVaultStore["listMemoriesAcrossScopes"]>[1],
): readonly MemoryRecord[] {
  return vault.listMemoriesAcrossScopes(vault.listMemoryScopes(), options);
}

function makeMemory(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id">): MemoryRecord {
  const t = 1_700_000_000_000;
  return {
    schemaVersion: "1",
    scope: { kind: "user", userId: "u-1" as UserId },
    type: "preference",
    body: "prefers dark mode",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: t,
      confidence: 0.9,
      sensitivity: "confidential",
    },
    validity: { validFrom: t },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: t,
    updatedAt: t,
    ...overrides,
  };
}

describe("restart persistence (AC: 5 memories of 3 types in 2 scopes survive close+reopen)", () => {
  it("round-trips through close()+reopen with the same memoryDir", () => {
    const dir = freshDir();
    const v1 = openVault(dir);
    v1.insertMemory(makeMemory({ id: "m1" as MemoryId, type: "preference" }));
    v1.insertMemory(makeMemory({ id: "m2" as MemoryId, type: "semantic-fact" }));
    v1.insertMemory(
      makeMemory({
        id: "m3" as MemoryId,
        type: "procedural",
        scope: { kind: "workspace", workspaceId: "w-1" as WorkspaceId },
      }),
    );
    v1.insertMemory(
      makeMemory({
        id: "m4" as MemoryId,
        type: "preference",
        scope: { kind: "workspace", workspaceId: "w-1" as WorkspaceId },
      }),
    );
    v1.insertMemory(
      makeMemory({
        id: "m5" as MemoryId,
        type: "semantic-fact",
        scope: { kind: "workspace", workspaceId: "w-1" as WorkspaceId },
      }),
    );
    v1.close();

    const v2 = openVault(dir);
    const userScope = { kind: "user" as const, userId: "u-1" as UserId };
    const wsScope = { kind: "workspace" as const, workspaceId: "w-1" as WorkspaceId };
    expect(
      v2
        .listMemoriesByScope(userScope)
        .map((m) => m.id)
        .sort(),
    ).toEqual(["m1", "m2"]);
    expect(
      v2
        .listMemoriesByScope(wsScope)
        .map((m) => m.id)
        .sort(),
    ).toEqual(["m3", "m4", "m5"]);
    v2.close();
  });
});

describe("corrupt-DB quarantine rotates sidecars", () => {
  it("renames keiko-memory.db plus -wal/-shm to *.corrupt.<iso> and re-opens fresh", () => {
    const dir = freshDir();
    const dbPath = join(dir, "keiko-memory.db");
    writeFileSync(dbPath, "garbage that is not a sqlite header");
    writeFileSync(`${dbPath}-wal`, "wal-garbage");
    writeFileSync(`${dbPath}-shm`, "shm-garbage");
    const vault = openVault(dir);
    vault.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    expect(vault.getMemory("m1" as MemoryId)?.id).toBe("m1");
    vault.close();
    const entries = readdirSync(dir);
    expect(entries.some((e) => e.startsWith("keiko-memory.db.corrupt."))).toBe(true);
    expect(entries.some((e) => e.startsWith("keiko-memory.db-wal.corrupt."))).toBe(true);
    expect(entries.some((e) => e.startsWith("keiko-memory.db-shm.corrupt."))).toBe(true);
  });
});

describe("sidecar permissions", () => {
  it("hardens WAL sidecars created by later writes on POSIX", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const dir = freshDir();
    const vault = openVault(dir);
    const dbPath = join(dir, "keiko-memory.db");

    vault.insertMemory(makeMemory({ id: "mem-sidecar-mode" as MemoryId }));

    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);
    expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600);
    vault.close();
  });
});

describe("onMemoryEvent fires post-commit and never on rollback", () => {
  it("emits memory:inserted after a successful insert", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const v = openVault(dir, events);
    v.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("memory:inserted");
    v.close();
  });

  it("does NOT emit memory:inserted when the insert fails (FK / duplicate id)", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const v = openVault(dir, events);
    v.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    events.length = 0;
    expect(() => {
      v.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    }).toThrow();
    expect(events).toEqual([]);
    v.close();
  });

  it("emits a transactional body-free pre-image with each committed update", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const v = openVault(dir, events);
    const memory = makeMemory({
      id: "m-update-preimage" as MemoryId,
      status: "proposed",
      pinned: true,
    });
    v.insertMemory(memory);
    events.length = 0;

    v.updateMemory(memory.id, { status: "accepted", pinned: false }, memory.updatedAt + 1);

    expect(events).toEqual([
      expect.objectContaining({
        kind: "memory:updated",
        previous: { id: memory.id, status: "proposed", pinned: true },
      }),
    ]);
    v.close();
  });

  it("AC18: does NOT emit on validation failure (no SQL touched, no event fired)", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const v = openVault(dir, events);
    // Empty body fails the contract validator (isSafeText rejects empty strings).
    const invalid = makeMemory({ id: "m-bad" as MemoryId, body: "" });
    expect(() => {
      v.insertMemory(invalid);
    }).toThrow();
    expect(events).toEqual([]);
    // The DB must be untouched too: a follow-up successful insert must succeed and the only
    // event must be the new insert, not a backlog of the failed one.
    v.insertMemory(makeMemory({ id: "m-good" as MemoryId }));
    expect(events.map((e) => e.kind)).toEqual(["memory:inserted"]);
    expect(v.getMemory("m-bad" as MemoryId)).toBeUndefined();
    v.close();
  });

  it("emits memory:deleted + memory:tombstoned in order on soft delete", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const v = openVault(dir, events);
    v.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    events.length = 0;
    v.deleteMemory("m1" as MemoryId, {
      tombstone: true,
      forgetterSurface: "test",
      reason: "test",
      nowMs: 1_700_000_001_000,
    });
    expect(events.map((e) => e.kind)).toEqual(["memory:deleted", "memory:tombstoned"]);
    v.close();
  });

  it("does NOT emit a tombstone event on hard delete (tombstone:false)", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const v = openVault(dir, events);
    v.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    events.length = 0;
    v.deleteMemory("m1" as MemoryId, {
      tombstone: false,
      forgetterSurface: "test",
      nowMs: 1_700_000_001_000,
    });
    expect(events.map((e) => e.kind)).toEqual(["memory:deleted"]);
    v.close();
  });

  it("emits delete and tombstone events after an atomic batch delete", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const v = openVault(dir, events);
    v.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    v.insertMemory(makeMemory({ id: "m2" as MemoryId }));
    events.length = 0;

    const results = v.deleteMemories([
      {
        id: "m1" as MemoryId,
        options: {
          tombstone: true,
          forgetterSurface: "test",
          reason: "test",
          nowMs: 1_700_000_001_000,
        },
      },
      {
        id: "m2" as MemoryId,
        options: {
          tombstone: true,
          forgetterSurface: "test",
          reason: "test",
          nowMs: 1_700_000_001_000,
        },
      },
    ]);

    expect(results.map((result) => result.memoryId)).toEqual(["m1", "m2"]);
    expect(events.map((e) => e.kind)).toEqual([
      "memory:deleted",
      "memory:tombstoned",
      "memory:deleted",
      "memory:tombstoned",
    ]);
    v.close();
  });

  it("rolls back a soft delete when the pre-commit delete hook rejects the audit", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const v = createMemoryVault({
      memoryDir: dir,
      env: { KEIKO_MEMORY_DIR: dir },
      vaultKey: TEST_VAULT_KEY,
      onMemoryEvent: (e) => events.push(e),
      onDeleteEventsBeforeCommit: () => {
        throw new Error("audit unavailable");
      },
    });
    v.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    events.length = 0;

    expect(() => {
      v.deleteMemory("m1" as MemoryId, {
        tombstone: true,
        forgetterSurface: "test",
        reason: "test",
        nowMs: 1_700_000_001_000,
      });
    }).toThrow("audit unavailable");

    expect(v.getMemory("m1" as MemoryId)).toBeDefined();
    expect(v.listTombstonesByScope({ kind: "user", userId: "u-1" as UserId })).toEqual([]);
    expect(events).toEqual([]);
    v.close();
  });

  // Regression pin (audit KEIKO-0221): the FK ON DELETE CASCADE guarantee on memory_edges,
  // memory_embeddings, and memory_access is already pinned at the SQL-module level in
  // embeddings.test.ts:208 and edges.test.ts:138 by directly issuing DELETE FROM memories WHERE ...
  // Those tests bypass the public vault.deleteMemory() API, so a future orchestration-layer change
  // could silently reintroduce orphaned rows without any existing test failing. This test drives
  // the whole insert-plus-links-plus-delete-plus-re-query cycle through the public MemoryVaultStore
  // API for both tombstone modes.
  it("public-API deleteMemory (tombstone:true) leaves no orphaned edge/embedding/access row", () => {
    const dir = freshDir();
    const v = openVault(dir);
    v.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    v.insertMemory(makeMemory({ id: "m2" as MemoryId }));
    v.insertEdge({
      id: "e1" as MemoryEdgeId,
      schemaVersion: "1",
      fromMemoryId: "m1" as MemoryId,
      toMemoryId: "m2" as MemoryId,
      kind: "related",
      createdAt: 1_700_000_000_500,
    });
    v.upsertEmbedding("m1" as MemoryId, {
      provider: "p",
      modelId: "m",
      metric: "cosine",
      vector: new Float32Array([1, 0]),
    });
    v.recordAccess(["m1" as MemoryId], 1_700_000_000_800);
    expect(v.getEmbedding("m1" as MemoryId)).toBeDefined();
    expect(v.listOutgoingEdges("m1" as MemoryId)).toHaveLength(1);
    expect(v.listIncomingEdges("m2" as MemoryId)).toHaveLength(1);
    expect(v.getAccessStats(["m1" as MemoryId]).get("m1" as MemoryId)).toBeDefined();

    v.deleteMemory("m1" as MemoryId, {
      tombstone: true,
      forgetterSurface: "test",
      reason: "test",
      nowMs: 1_700_000_001_000,
    });

    expect(v.getEmbedding("m1" as MemoryId)).toBeUndefined();
    expect(v.listOutgoingEdges("m1" as MemoryId)).toEqual([]);
    expect(v.listIncomingEdges("m2" as MemoryId)).toEqual([]);
    expect(v.getAccessStats(["m1" as MemoryId]).get("m1" as MemoryId)).toBeUndefined();
    v.close();
  });

  it("public-API deleteMemory (tombstone:false) leaves no orphaned edge/embedding/access row", () => {
    const dir = freshDir();
    const v = openVault(dir);
    v.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    v.insertMemory(makeMemory({ id: "m2" as MemoryId }));
    v.insertEdge({
      id: "e1" as MemoryEdgeId,
      schemaVersion: "1",
      fromMemoryId: "m1" as MemoryId,
      toMemoryId: "m2" as MemoryId,
      kind: "related",
      createdAt: 1_700_000_000_500,
    });
    v.upsertEmbedding("m1" as MemoryId, {
      provider: "p",
      modelId: "m",
      metric: "cosine",
      vector: new Float32Array([1, 0]),
    });
    v.recordAccess(["m1" as MemoryId], 1_700_000_000_800);

    v.deleteMemory("m1" as MemoryId, {
      tombstone: false,
      forgetterSurface: "test",
      nowMs: 1_700_000_001_000,
    });

    expect(v.getEmbedding("m1" as MemoryId)).toBeUndefined();
    expect(v.listOutgoingEdges("m1" as MemoryId)).toEqual([]);
    expect(v.listIncomingEdges("m2" as MemoryId)).toEqual([]);
    expect(v.getAccessStats(["m1" as MemoryId]).get("m1" as MemoryId)).toBeUndefined();
    v.close();
  });
});

describe("validator gate fires BEFORE any SQL touches", () => {
  it("rejects an insert with a structurally invalid record and leaves the DB untouched", () => {
    const dir = freshDir();
    const v = openVault(dir);
    v.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    const sentinel: unknown = makeMemory({ id: "m2" as MemoryId, body: "" });
    expect(() => {
      v.insertMemory(sentinel as MemoryRecord);
    }).toThrow(MemoryStorageValidationError);
    expect(v.getMemory("m2" as MemoryId)).toBeUndefined();
    expect(v.getMemory("m1" as MemoryId)?.id).toBe("m1");
    v.close();
  });

  it("MemoryStorageValidationError exposes the failure list on .failures", () => {
    const dir = freshDir();
    const v = openVault(dir);
    try {
      v.insertMemory(makeMemory({ id: "m1" as MemoryId, body: "" }));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryStorageValidationError);
      const e = err as MemoryStorageValidationError;
      expect(e.failures.length).toBeGreaterThan(0);
      expect(e.failures[0]?.message).toMatch(/body/);
    }
    v.close();
  });

  it("ignores runtime-smuggled immutable patch keys during updateMemory", () => {
    const dir = freshDir();
    const v = openVault(dir);
    v.insertMemory(makeMemory({ id: "m1" as MemoryId, body: "before" }));
    v.insertMemory(makeMemory({ id: "m2" as MemoryId, body: "target" }));
    const patch = {
      id: "m2",
      scope: { kind: "workspace", workspaceId: "w-2" as WorkspaceId },
      createdAt: 1,
      schemaVersion: "999",
      body: "after",
    };
    const updated = v.updateMemory("m1" as MemoryId, patch, 1_700_000_000_077);
    expect(updated.id).toBe("m1");
    expect(updated.scope).toEqual({ kind: "user", userId: "u-1" as UserId });
    expect(updated.createdAt).toBe(1_700_000_000_000);
    expect(updated.schemaVersion).toBe("1");
    expect(updated.body).toBe("after");
    expect(v.getMemory("m1" as MemoryId)?.body).toBe("after");
    expect(v.getMemory("m2" as MemoryId)?.body).toBe("target");
    v.close();
  });

  it("rolls back updateMemories when any update fails validation", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const v = openVault(dir, events);
    v.insertMemory(makeMemory({ id: "m1" as MemoryId, body: "before" }));
    v.insertMemory(makeMemory({ id: "m2" as MemoryId, body: "target" }));
    events.length = 0;

    expect(() => {
      v.updateMemories([
        { id: "m1" as MemoryId, patch: { body: "after" }, nowMs: 1_700_000_000_100 },
        { id: "m2" as MemoryId, patch: { body: "" }, nowMs: 1_700_000_000_100 },
      ]);
    }).toThrow(MemoryStorageValidationError);

    expect(v.getMemory("m1" as MemoryId)?.body).toBe("before");
    expect(v.getMemory("m2" as MemoryId)?.body).toBe("target");
    expect(events).toEqual([]);
    v.close();
  });

  it("rejects insertEdge with a missing-endpoint record before SQL (FK still defends below)", () => {
    const dir = freshDir();
    const v = openVault(dir);
    const badEdge: MemoryEdge = {
      id: "e1" as MemoryEdgeId,
      schemaVersion: "1",
      fromMemoryId: "missing" as MemoryId,
      toMemoryId: "alsomissing" as MemoryId,
      kind: "supersedes",
      createdAt: 1,
    };
    // Validator accepts this structurally (ids are well-formed); FK fires at SQL.
    expect(() => {
      v.insertEdge(badEdge);
    }).toThrow();
    v.close();
  });
});

describe("atomic graph mutations", () => {
  it("applies bound updates and edges atomically, then emits only committed events", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const vault = openVault(dir, events);
    const proposed = makeMemory({ id: "m-proposed" as MemoryId, status: "proposed" });
    const accepted = makeMemory({ id: "m-accepted" as MemoryId });
    vault.insertMemory(proposed);
    vault.insertMemory(accepted);
    events.length = 0;

    const edge: MemoryEdge = {
      id: "e-superseded" as MemoryEdgeId,
      schemaVersion: "1",
      fromMemoryId: proposed.id,
      toMemoryId: accepted.id,
      kind: "supersedes",
      createdAt: proposed.updatedAt + 1,
    };
    const result = vault.applyGraphMutation({
      preconditions: [
        {
          id: proposed.id,
          expectedStatus: proposed.status,
          expectedUpdatedAt: proposed.updatedAt,
        },
      ],
      updates: [
        {
          id: proposed.id,
          patch: { status: "superseded" },
          nowMs: proposed.updatedAt + 1,
          expectedStatus: proposed.status,
          expectedUpdatedAt: proposed.updatedAt,
        },
      ],
      edges: [edge],
    });

    expect(result.memories).toMatchObject([{ id: proposed.id, status: "superseded" }]);
    expect(result.edges).toEqual([edge]);
    expect(vault.getMemory(proposed.id)?.status).toBe("superseded");
    expect(vault.listOutgoingEdges(proposed.id)).toEqual([edge]);
    expect(events.map((event) => event.kind)).toEqual(["memory:updated", "edge:inserted"]);
    vault.close();
  });

  it("inserts a replacing memory in the one transaction or not at all (#4212)", () => {
    const dir = freshDir();
    const vault = openVault(dir, []);
    const older = vault.insertMemory(makeMemory({ id: "m-older" as MemoryId, status: "accepted" }));
    const newer = makeMemory({ id: "m-newer" as MemoryId, status: "accepted" });
    const replace = (expectedUpdatedAt: number): void => {
      vault.applyGraphMutation({
        preconditions: [{ id: older.id, expectedStatus: older.status, expectedUpdatedAt }],
        inserts: [newer],
        updates: [
          {
            id: older.id,
            patch: { status: "superseded" },
            nowMs: older.updatedAt + 1,
            expectedStatus: older.status,
            expectedUpdatedAt,
          },
        ],
        edges: [
          {
            id: "e-replaces" as MemoryEdgeId,
            schemaVersion: "1",
            fromMemoryId: older.id,
            toMemoryId: newer.id,
            kind: "supersedes",
            createdAt: older.updatedAt + 1,
          },
        ],
      });
    };

    expect(() => {
      replace(older.updatedAt - 1);
    }).toThrow();
    expect(vault.getMemory(newer.id)).toBeUndefined();
    expect(vault.getMemory(older.id)?.status).toBe("accepted");

    replace(older.updatedAt);
    expect(vault.getMemory(newer.id)?.status).toBe("accepted");
    expect(vault.getMemory(older.id)?.status).toBe("superseded");
    expect(vault.listOutgoingEdges(older.id).map((edge) => edge.kind)).toEqual(["supersedes"]);
    vault.close();
  });

  it("remembers an answer's use without counting it as a reinforcement (#4212)", () => {
    const dir = freshDir();
    const vault = openVault(dir, []);
    const memory = vault.insertMemory(makeMemory({ id: "m-used" as MemoryId, status: "accepted" }));

    vault.recordUse([memory.id], 1_700_000_000_500, "chat-a");
    expect(vault.getAccessStats([memory.id]).get(memory.id)).toMatchObject({
      accessCount: 0,
      lastUsedAt: 1_700_000_000_500,
    });

    vault.recordAccess([memory.id], 1_700_000_000_600, "chat-b");
    vault.recordUse([memory.id], 1_700_000_000_700, "chat-c");
    expect(vault.getAccessStats([memory.id]).get(memory.id)).toMatchObject({
      accessCount: 1,
      lastAccessedAt: 1_700_000_000_600,
      lastUsedAt: 1_700_000_000_700,
    });
    // Each chat keeps its own touch: the later chats erase nothing of chat-a's.
    expect(vault.getConversationTouches("chat-a").get(memory.id)).toEqual({
      usedAt: 1_700_000_000_500,
    });
    expect(vault.getConversationTouches("chat-b").get(memory.id)).toEqual({
      confirmedAt: 1_700_000_000_600,
    });
    expect(vault.getConversationTouches("chat-c").get(memory.id)).toEqual({
      usedAt: 1_700_000_000_700,
    });
    vault.close();
  });

  it("touches nobody for a memory that no longer exists (#4212)", () => {
    const dir = freshDir();
    const vault = openVault(dir, []);
    const kept = vault.insertMemory(makeMemory({ id: "m-kept" as MemoryId, status: "accepted" }));
    const gone = "m-gone" as MemoryId;

    expect(() => {
      vault.recordAccess([gone, kept.id], 1_700_000_000_500, "chat-a");
      vault.recordUse([gone], 1_700_000_000_600, "chat-a");
      vault.recordOutcome([gone], 1, 1_700_000_000_700);
    }).not.toThrow();
    expect([...vault.getAccessStats().keys()]).toEqual([kept.id]);
    expect([...vault.getConversationTouches("chat-a").keys()]).toEqual([kept.id]);
    expect(vault.getAccessStats([kept.id]).get(kept.id)?.accessCount).toBe(1);
    vault.close();
  });

  it("rejects a stale graph status precondition before mutation", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const vault = openVault(dir, events);
    const memory = makeMemory({ id: "m-status" as MemoryId });
    vault.insertMemory(memory);
    events.length = 0;

    expectPreconditionFailure(
      () =>
        vault.applyGraphMutation({
          preconditions: [
            { id: memory.id, expectedStatus: "proposed", expectedUpdatedAt: memory.updatedAt },
          ],
          updates: [{ id: memory.id, patch: { body: "changed" }, nowMs: memory.updatedAt + 1 }],
          edges: [],
        }),
      "status",
    );

    expect(vault.getMemory(memory.id)?.body).toBe(memory.body);
    expect(events).toEqual([]);
    vault.close();
  });

  it("rejects a stale graph version precondition before mutation", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const vault = openVault(dir, events);
    const memory = makeMemory({ id: "m-version" as MemoryId });
    vault.insertMemory(memory);
    events.length = 0;

    expectPreconditionFailure(
      () =>
        vault.applyGraphMutation({
          preconditions: [
            {
              id: memory.id,
              expectedStatus: memory.status,
              expectedUpdatedAt: memory.updatedAt + 1,
            },
          ],
          updates: [{ id: memory.id, patch: { body: "changed" }, nowMs: memory.updatedAt + 1 }],
          edges: [],
        }),
      "updatedAt",
    );

    expect(vault.getMemory(memory.id)?.body).toBe(memory.body);
    expect(events).toEqual([]);
    vault.close();
  });

  it("rolls back earlier updates when a later update has a stale status", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const vault = openVault(dir, events);
    const first = makeMemory({ id: "m-first" as MemoryId, body: "first before" });
    const stale = makeMemory({ id: "m-stale-status" as MemoryId, body: "stale before" });
    vault.insertMemory(first);
    vault.insertMemory(stale);
    events.length = 0;

    expectPreconditionFailure(
      () =>
        vault.applyGraphMutation({
          updates: [
            { id: first.id, patch: { body: "first after" }, nowMs: first.updatedAt + 1 },
            {
              id: stale.id,
              patch: { body: "stale after" },
              nowMs: stale.updatedAt + 1,
              expectedStatus: "proposed",
            },
          ],
          edges: [],
        }),
      "status",
    );

    expect(vault.getMemory(first.id)?.body).toBe(first.body);
    expect(vault.getMemory(stale.id)?.body).toBe(stale.body);
    expect(events).toEqual([]);
    vault.close();
  });

  it("rejects an update whose expected version is stale", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const vault = openVault(dir, events);
    const memory = makeMemory({ id: "m-stale-version" as MemoryId });
    vault.insertMemory(memory);
    events.length = 0;

    expectPreconditionFailure(
      () =>
        vault.applyGraphMutation({
          updates: [
            {
              id: memory.id,
              patch: { body: "changed" },
              nowMs: memory.updatedAt + 1,
              expectedUpdatedAt: memory.updatedAt + 1,
            },
          ],
          edges: [],
        }),
      "updatedAt",
    );

    expect(vault.getMemory(memory.id)?.body).toBe(memory.body);
    expect(events).toEqual([]);
    vault.close();
  });
});

function expectPreconditionFailure(
  action: () => unknown,
  field: MemoryStoragePreconditionError["field"],
): void {
  try {
    action();
    expect.fail("Expected a memory storage precondition failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryStoragePreconditionError);
    expect((error as MemoryStoragePreconditionError).field).toBe(field);
  }
}

describe("close() releases the file lock", () => {
  it("lets a second factory open the same DB after the first closes", () => {
    const dir = freshDir();
    const v1 = openVault(dir);
    v1.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    v1.close();
    const v2 = openVault(dir);
    expect(v2.getMemory("m1" as MemoryId)?.id).toBe("m1");
    v2.close();
  });

  // #4068: a composition that owns the vault closes it on every dispose, and a process may dispose
  // twice (signal handler plus its own finally block). The second close is a no-op, while the
  // vault itself stays closed: no operation runs against a released handle.
  it("is idempotent and leaves the vault closed", () => {
    const vault = openVault(freshDir());
    vault.close();
    expect(() => {
      vault.close();
    }).not.toThrow();
    expect(() => vault.listMemoryScopes()).toThrow();
  });
});

describe("deterministic now/newTombstoneId", () => {
  it("honours the explicit clock for tombstone timestamps and ids", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const v = openVault(dir, events, { value: 1_700_000_000_000 });
    v.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    v.deleteMemory("m1" as MemoryId, {
      tombstone: true,
      forgetterSurface: "test",
      reviewerId: "reviewer-1" as MemoryReviewerId,
      nowMs: 1_700_000_001_000,
    });
    const userScope = { kind: "user" as const, userId: "u-1" as UserId };
    const tombstones = v.listTombstonesByScope(userScope);
    expect(tombstones).toHaveLength(1);
    const [tombstone] = tombstones;
    if (tombstone === undefined) throw new Error("expected tombstone");
    expect(tombstone).toMatchObject({
      id: "t-1",
      memoryId: "m1",
      scopeKind: "user",
      scopeCoordinate: "u-1",
      type: "preference",
      forgottenAt: 1_700_000_001_000,
      forgetterSurface: "test",
      reviewerId: "reviewer-1",
      originalStatus: "accepted",
    });
    expect(tombstone.bodyHash).toMatch(/^hmac-sha256:v2:[0-9a-f]{64}$/u);
    expect(tombstone.bodyHash).not.toBe(memoryBodySuppressionHash("prefers dark mode"));
    v.close();
  });

  it("uses a vault-local tombstone body hash so identical bodies differ across vaults", () => {
    const firstDir = freshDir();
    const secondDir = freshDir();
    const first = openVault(firstDir);
    const second = openVault(secondDir);
    first.insertMemory(makeMemory({ id: "m1" as MemoryId, body: "prefers dark mode" }));
    second.insertMemory(makeMemory({ id: "m2" as MemoryId, body: "prefers dark mode" }));
    const options = {
      tombstone: true,
      forgetterSurface: "test",
      nowMs: 1_700_000_001_000,
    };
    first.deleteMemory("m1" as MemoryId, options);
    second.deleteMemory("m2" as MemoryId, options);
    const userScope = { kind: "user" as const, userId: "u-1" as UserId };
    const firstHash = first.listTombstonesByScope(userScope)[0]?.bodyHash;
    const secondHash = second.listTombstonesByScope(userScope)[0]?.bodyHash;
    expect(firstHash).toMatch(/^hmac-sha256:v2:[0-9a-f]{64}$/u);
    expect(secondHash).toMatch(/^hmac-sha256:v2:[0-9a-f]{64}$/u);
    expect(firstHash).not.toBe(secondHash);
    expect(first.hasForgetTombstoneForBody(userScope, "Prefers... DARK mode")).toBe(true);
    first.close();
    second.close();
  });

  it("migrates a matching legacy deterministic tombstone hash to the vault-local HMAC", () => {
    const dir = freshDir();
    const v = openVault(dir);
    v.insertMemory(makeMemory({ id: "m1" as MemoryId, body: "prefers dark mode" }));
    v.deleteMemory("m1" as MemoryId, {
      tombstone: true,
      forgetterSurface: "test",
      nowMs: 1_700_000_001_000,
    });
    v.close();

    const legacyHash = memoryBodySuppressionHash("prefers dark mode");
    const raw = new DatabaseSync(join(dir, "keiko-memory.db"));
    raw.prepare("UPDATE memory_tombstones SET body_hash = ? WHERE id = ?").run(legacyHash, "t-1");
    raw.close();

    const reopened = openVault(dir);
    const userScope = { kind: "user" as const, userId: "u-1" as UserId };
    expect(reopened.hasForgetTombstoneForBody(userScope, "Prefers... DARK mode")).toBe(true);
    const [tombstone] = reopened.listTombstonesByScope(userScope);
    expect(tombstone?.bodyHash).toMatch(/^hmac-sha256:v2:[0-9a-f]{64}$/u);
    expect(tombstone?.bodyHash).not.toBe(legacyHash);
    reopened.close();
  });
});

describe("namespace isolation regression", () => {
  it("(kind:user, coord:u-1) and (kind:workspace, coord:u-1) never cross-show", () => {
    const dir = freshDir();
    const v = openVault(dir);
    v.insertMemory(
      makeMemory({ id: "mu" as MemoryId, scope: { kind: "user", userId: "u-1" as UserId } }),
    );
    v.insertMemory(
      makeMemory({
        id: "mw" as MemoryId,
        scope: { kind: "workspace", workspaceId: "u-1" as WorkspaceId },
      }),
    );
    const u = v.listMemoriesByScope({ kind: "user", userId: "u-1" as UserId }).map((m) => m.id);
    const w = v
      .listMemoriesByScope({ kind: "workspace", workspaceId: "u-1" as WorkspaceId })
      .map((m) => m.id);
    expect(u).toEqual(["mu"]);
    expect(w).toEqual(["mw"]);
    v.close();
  });
});

describe("embedding replacement bound to the current body", () => {
  const input: MemoryEmbeddingInput = {
    provider: "synthetic-provider",
    modelId: "synthetic-embedding",
    metric: "cosine",
    vector: Float32Array.from([1, 0, 0]),
  };

  it("allows metadata-only changes and emits the committed vector after its transaction", () => {
    const dir = freshDir();
    const observer = openVault(dir);
    const observed: MemoryEvent[] = [];
    const writer = createMemoryVault({
      memoryDir: dir,
      vaultKey: TEST_VAULT_KEY,
      onMemoryEvent: (event) => {
        if (event.kind === "embedding:upserted") {
          expect(observer.getEmbedding(event.memoryId)?.vector).toEqual(input.vector);
          observed.push(event);
        }
      },
    });
    try {
      const record = writer.insertMemory(makeMemory({ id: "bound-embedding" as MemoryId }));
      observer.updateMemory(record.id, { tags: ["metadata-change"] }, record.updatedAt);
      expect(writer.replaceEmbeddingForMemoryBody(record.id, record.body, input)).toBe(true);
      expect(observer.getMemory(record.id)?.tags).toEqual(["metadata-change"]);
      expect(observed).toHaveLength(1);
      expect(writer.replaceEmbeddingForMemoryBody(record.id, record.body, null)).toBe(true);
      expect(observer.getEmbedding(record.id)).toBeUndefined();
    } finally {
      writer.close();
      observer.close();
    }
  });

  it.each(["body-changed", "deleted"] as const)(
    "leaves a newer vector untouched when its expected body is %s",
    (change) => {
      const dir = freshDir();
      const events: MemoryEvent[] = [];
      const reader = openVault(dir, events);
      const writer = openVault(dir);
      try {
        const record = reader.insertMemory(makeMemory({ id: "stale-embedding" as MemoryId }));
        if (change === "body-changed") {
          writer.updateMemory(record.id, { body: "New synthetic body" }, record.updatedAt);
          writer.upsertEmbedding(record.id, input);
        } else {
          writer.deleteMemory(record.id, {
            tombstone: false,
            forgetterSurface: "memory-center",
            nowMs: record.updatedAt,
          });
        }
        const current = writer.getEmbedding(record.id);
        events.length = 0;
        expect(reader.replaceEmbeddingForMemoryBody(record.id, record.body, input)).toBe(false);
        expect(reader.replaceEmbeddingForMemoryBody(record.id, record.body, null)).toBe(false);
        expect(writer.getEmbedding(record.id)).toEqual(current);
        expect(events).toEqual([]);
      } finally {
        reader.close();
        writer.close();
      }
    },
  );

  it("rolls back a rejected vector and releases its write transaction for recovery", () => {
    const events: MemoryEvent[] = [];
    const vault = openVault(freshDir(), events);
    try {
      const record = vault.insertMemory(makeMemory({ id: "rejected-embedding" as MemoryId }));
      vault.upsertEmbedding(record.id, input);
      const before = vault.getEmbedding(record.id);
      events.length = 0;
      expect(() =>
        vault.replaceEmbeddingForMemoryBody(record.id, record.body, {
          ...input,
          vector: new Float32Array(),
        }),
      ).toThrow(MemoryStorageValidationError);
      expect(vault.getEmbedding(record.id)).toEqual(before);
      expect(events).toEqual([]);
      expect(vault.replaceEmbeddingForMemoryBody(record.id, record.body, null)).toBe(true);
      expect(vault.getEmbedding(record.id)).toBeUndefined();
      expect(events.map((event) => event.kind)).toEqual(["embedding:deleted"]);
    } finally {
      vault.close();
    }
  });

  it("holds the write lock between the body check and the vector replacement", () => {
    const dir = freshDir();
    const reader = openVault(dir);
    const writer = openVault(dir);
    const record = reader.insertMemory(makeMemory({ id: "atomic-body-embedding" as MemoryId }));
    const prepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")
      ?.value as DatabaseSync["prepare"];
    const writerConnections = new Set<DatabaseSync>();
    const capture = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ): ReturnType<typeof prepare> {
      writerConnections.add(this);
      return prepare.call(this, sql);
    });
    try {
      writer.getMemory(record.id);
    } finally {
      capture.mockRestore();
    }
    const writerDb = writerConnections.values().next().value;
    if (writerDb === undefined) throw new TypeError("Missing synthetic writer connection");
    writerDb.exec("PRAGMA busy_timeout = 0");
    let raced = false;
    let restoreRead = (): void => undefined;
    const race = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ): ReturnType<typeof prepare> {
      const statement = prepare.call(this, sql);
      if (!raced && this !== writerDb && sql === "SELECT * FROM memories WHERE id = ?") {
        const get = statement.get.bind(statement);
        const read = vi.spyOn(statement, "get").mockImplementationOnce((...params) => {
          const row = get(...params);
          raced = true;
          let blocked: unknown;
          try {
            writer.updateMemory(record.id, { body: "Competing synthetic body" }, record.updatedAt);
          } catch (error) {
            blocked = error;
          }
          expect(blocked).toMatchObject({ errcode: 5 });
          return row;
        });
        restoreRead = (): void => {
          read.mockRestore();
        };
      }
      return statement;
    });
    try {
      expect(reader.replaceEmbeddingForMemoryBody(record.id, record.body, input)).toBe(true);
      expect(raced).toBe(true);
      expect(writer.getMemory(record.id)?.body).toBe(record.body);
      expect(writer.getEmbedding(record.id)?.vector).toEqual(input.vector);
    } finally {
      restoreRead();
      race.mockRestore();
      writer.close();
      reader.close();
    }
  });
});

describe("list filters", () => {
  it("releases a review snapshot after a storage failure", () => {
    const vault = openVault(freshDir());
    const record = makeMemory({ id: "snapshot-recovery" as MemoryId, status: "proposed" });
    const prepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")
      ?.value as DatabaseSync["prepare"];
    try {
      vault.insertMemory(record);
      const fault = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
        this: DatabaseSync,
        sql: string,
      ): ReturnType<typeof prepare> {
        if (sql.startsWith("SELECT * FROM memories WHERE")) {
          throw new MemoryStorageError("internal", "Synthetic read failure");
        }
        return prepare.call(this, sql);
      });
      try {
        expect(() => vault.listMemoryReviewQueue()).toThrow(MemoryStorageError);
      } finally {
        fault.mockRestore();
      }
      expect(
        vault.updateMemory(record.id, { tags: ["after-failure"] }, record.updatedAt + 1).tags,
      ).toEqual(["after-failure"]);
      expect(vault.listMemoryReviewQueue().map(({ id }) => id)).toEqual([record.id]);
    } finally {
      vault.close();
    }
  });

  it("keeps both review status alternatives within the requested scope and sensitivity", () => {
    const vault = openVault(freshDir());
    try {
      const sample = makeMemory({
        id: "stale" as MemoryId,
        status: "accepted",
        staleReason: "changed-source",
      });
      const provenance = { ...sample.provenance, sensitivity: "public" as const };
      const stale = { ...sample, provenance };
      vault.insertMemory(stale);
      vault.insertMemory({
        ...stale,
        id: "confidential" as MemoryId,
        provenance: { ...stale.provenance, sensitivity: "confidential" },
      });
      vault.insertMemory({ ...stale, id: "foreign" as MemoryId, scope: { kind: "global" } });
      vault.insertMemory(
        makeMemory({ id: "ordinary" as MemoryId, status: "proposed", provenance }),
      );
      vault.insertMemory(
        makeMemory({ id: "accepted-current" as MemoryId, status: "accepted", provenance }),
      );
      const matches = vault.listMemoriesAcrossScopes([stale.scope], {
        status: ["proposed"],
        includeStaleStatuses: ["accepted"],
        sensitivity: ["public"],
      });
      expect(matches.map((record) => record.id).sort()).toEqual(["ordinary", "stale"]);
      const staleOnly = vault.listMemoriesAcrossScopes([stale.scope], {
        includeStaleStatuses: ["accepted"],
        sensitivity: ["public"],
      });
      expect(staleOnly.map((record) => record.id)).toEqual(["stale"]);
    } finally {
      vault.close();
    }
  });

  it("filters by type, status, pinned, and excludes expired by default", () => {
    const dir = freshDir();
    const v = openVault(dir);
    v.insertMemory(makeMemory({ id: "m1" as MemoryId, type: "preference", pinned: true }));
    v.insertMemory(makeMemory({ id: "m2" as MemoryId, type: "semantic-fact", pinned: false }));
    v.insertMemory(
      makeMemory({
        id: "m3" as MemoryId,
        type: "semantic-fact",
        validity: { validFrom: 0, validUntil: 1 },
      }),
    );
    const userScope = { kind: "user" as const, userId: "u-1" as UserId };
    expect(v.listMemoriesByScope(userScope, { pinned: true }).map((m) => m.id)).toEqual(["m1"]);
    expect(
      v
        .listMemoriesByScope(userScope, { type: ["semantic-fact"] })
        .map((m) => m.id)
        .sort(),
    ).toEqual(["m2"]);
    expect(
      v
        .listMemoriesByScope(userScope, { type: ["semantic-fact"], includeExpired: true })
        .map((m) => m.id)
        .sort(),
    ).toEqual(["m2", "m3"]);
    v.close();
  });

  it("lists scope metadata with the same filters without returning memory content", () => {
    const dir = freshDir();
    const v = openVault(dir);
    v.insertMemory(
      makeMemory({
        id: "m1" as MemoryId,
        type: "semantic-fact",
        body: "sensitive remembered body",
        tags: ["private-tag"],
        pinned: true,
      }),
    );
    v.insertMemory(
      makeMemory({
        id: "m2" as MemoryId,
        type: "semantic-fact",
        status: "archived",
        body: "archived body",
      }),
    );
    const userScope = { kind: "user" as const, userId: "u-1" as UserId };
    const metadata = v.listMemoryMetadataByScope(userScope, {
      type: ["semantic-fact"],
      status: ["accepted"],
    });
    expect(metadata).toEqual([
      {
        id: "m1",
        schemaVersion: "1",
        scope: userScope,
        type: "semantic-fact",
        status: "accepted",
        sensitivity: "confidential",
        pinned: true,
        confidence: 0.9,
        validity: { validFrom: 1_700_000_000_000 },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
    ]);
    expect(JSON.stringify(metadata)).not.toContain("sensitive remembered body");
    expect(JSON.stringify(metadata)).not.toContain("private-tag");
    v.close();
  });

  it("names the unreadable row id when a corrupt memory row breaks scoped listing", () => {
    const dir = freshDir();
    const v = openVault(dir);
    const userScope = { kind: "user" as const, userId: "u-1" as UserId };
    v.insertMemory(makeMemory({ id: "ok-row" as MemoryId, body: "healthy body" }));
    v.insertMemory(makeMemory({ id: "bad-row" as MemoryId, body: "private body marker" }));
    v.close();

    const db = new DatabaseSync(join(dir, MEMORY_DB_FILENAME));
    try {
      db.prepare("UPDATE memories SET body = ? WHERE id = ?").run("kv1.not-valid", "bad-row");
    } finally {
      db.close();
    }

    const reopened = openVault(dir);
    try {
      expect(() => reopened.listMemoriesByScope(userScope)).toThrow(/bad-row is unreadable/u);
      try {
        reopened.listMemoriesByScope(userScope);
      } catch (error) {
        expect(error).toBeInstanceOf(MemoryStorageError);
        expect(String(error)).not.toContain("private body marker");
        expect(String(error)).not.toContain("kv1.not-valid");
      }
    } finally {
      reopened.close();
    }
  });

  it("lists metadata for every supported scope kind", () => {
    const dir = freshDir();
    const v = openVault(dir);
    const userScope = { kind: "user" as const, userId: "u-1" as UserId };
    const workspaceScope = {
      kind: "workspace" as const,
      workspaceId: "w-1" as WorkspaceId,
    };
    const projectScope = { kind: "project" as const, projectId: "p-1" as ProjectId };
    const workflowScope = {
      kind: "workflow" as const,
      workflowDefinitionId: "wf-1" as WorkflowDefinitionId,
    };
    const globalScope = { kind: "global" as const };
    v.insertMemory(makeMemory({ id: "m-user" as MemoryId, scope: userScope }));
    v.insertMemory(makeMemory({ id: "m-workspace" as MemoryId, scope: workspaceScope }));
    v.insertMemory(makeMemory({ id: "m-project" as MemoryId, scope: projectScope }));
    v.insertMemory(makeMemory({ id: "m-workflow" as MemoryId, scope: workflowScope }));
    v.insertMemory(makeMemory({ id: "m-global" as MemoryId, scope: globalScope }));

    expect(v.listMemoryMetadataByScope(userScope)[0]?.scope).toEqual(userScope);
    expect(v.listMemoryMetadataByScope(workspaceScope)[0]?.scope).toEqual(workspaceScope);
    expect(v.listMemoryMetadataByScope(projectScope)[0]?.scope).toEqual(projectScope);
    expect(v.listMemoryMetadataByScope(workflowScope)[0]?.scope).toEqual(workflowScope);
    expect(v.listMemoryMetadataByScope(globalScope)[0]?.scope).toEqual(globalScope);
    v.close();
  });

  it("lists records only from explicitly supplied scopes", () => {
    const dir = freshDir();
    const v = openVault(dir);
    const userScope = { kind: "user" as const, userId: "u-1" as UserId };
    const workspaceScope = {
      kind: "workspace" as const,
      workspaceId: "w-1" as WorkspaceId,
    };
    v.insertMemory(makeMemory({ id: "m-user" as MemoryId, scope: userScope }));
    v.insertMemory(makeMemory({ id: "m-workspace" as MemoryId, scope: workspaceScope }));

    expect(v.listMemoryScopes()).toEqual([userScope, workspaceScope]);
    expect(
      v.listMemoriesAcrossScopes([userScope], { includeExpired: true }).map((memory) => memory.id),
    ).toEqual(["m-user"]);
    expect(v.listMemoriesAcrossScopes([], { includeExpired: true })).toEqual([]);
    v.close();
  });

  it("lists more than 1,000 stored scopes with exact pairs and database pagination", () => {
    const vault = openVault(freshDir());
    const projectScopes = Array.from({ length: 1_250 }, (_, index) => ({
      kind: "project" as const,
      projectId: `scope-${String(index)}` as ProjectId,
    }));
    const user = { kind: "user" as const, userId: "scope-0" as UserId };
    const workspace = { kind: "workspace" as const, workspaceId: "workspace-only" as WorkspaceId };
    const global = { kind: "global" as const };
    const crossKindWorkspace = {
      kind: "workspace" as const,
      workspaceId: "scope-0" as WorkspaceId,
    };
    const crossKindUser = { kind: "user" as const, userId: "workspace-only" as UserId };
    try {
      for (const [index, scope] of projectScopes.entries()) {
        vault.insertMemory(
          makeMemory({ id: `project-${String(index)}` as MemoryId, scope, createdAt: index }),
        );
      }
      for (const [id, scope, createdAt] of [
        ["global", global, 2_000],
        ["workspace", workspace, 2_001],
        ["user", user, 2_002],
        ["other-workspace", crossKindWorkspace, 2_003],
        ["other-user", crossKindUser, 2_004],
      ] as const) {
        vault.insertMemory(makeMemory({ id: id as MemoryId, scope, createdAt }));
      }
      expect(vault.listMemoryScopes()).toHaveLength(1_255);
      const requested = [
        ...projectScopes,
        user,
        workspace,
        global,
        user,
        ...projectScopes.slice(0, 1),
      ];
      const listed = vault.listMemoriesAcrossScopes(requested, { includeExpired: true });
      expect(listed).toHaveLength(1_253);
      expect(new Set(listed.map(({ id }) => id)).size).toBe(1_253);
      expect(listed.slice(0, 4).map(({ id }) => id)).toEqual([
        "user",
        "workspace",
        "global",
        "project-1249",
      ]);
      expect(listed.map(({ id }) => id)).not.toContain("other-workspace");
      expect(listed.map(({ id }) => id)).not.toContain("other-user");
      expect(
        vault
          .listMemoriesAcrossScopes(requested, {
            includeExpired: true,
            limit: 4,
            offset: 1_249,
            orderDir: "asc",
          })
          .map(({ id }) => id),
      ).toEqual(["project-1249", "global", "workspace", "user"]);
    } finally {
      vault.close();
    }
  });

  it("uses the existing ordered index when only one distinct scope is requested", () => {
    const dir = freshDir();
    const vault = openVault(dir);
    const db = new DatabaseSync(join(dir, MEMORY_DB_FILENAME));
    const scope = { kind: "user" as const, userId: "u-1" as UserId };
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      vault.insertMemory(makeMemory({ id: "m1" as MemoryId, scope }));
      expect(
        vault
          .listMemoriesAcrossScopes([scope, scope], { includeExpired: true, limit: 1 })
          .map(({ id }) => id),
      ).toEqual(["m1"]);
      const sql = prepare.mock.calls.find(([text]) =>
        text.startsWith("SELECT * FROM memories WHERE"),
      )?.[0];
      expect(sql).toBeDefined();
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql ?? ""}`).all("user", "u-1", 1);
      expect(plan.map((step) => step.detail)).toEqual([
        expect.stringMatching(
          /SEARCH memories USING INDEX idx_memories_scope_created .*scope_kind=\? AND scope_coordinate=\?/u,
        ),
      ]);
    } finally {
      prepare.mockRestore();
      db.close();
      vault.close();
    }
  });

  it("matches existing SQLite text bindings for unusual scope coordinates", () => {
    const vault = openVault(freshDir());
    const scope = { kind: "user" as const, userId: 'quoted"\u0000🧭\ud800' as UserId };
    try {
      vault.insertMemory(makeMemory({ id: "encoded-coordinate" as MemoryId, scope }));
      expect(
        vault
          .listMemoriesAcrossScopes([scope, { kind: "global" }], { includeExpired: true })
          .map(({ id }) => id),
      ).toEqual(["encoded-coordinate"]);
    } finally {
      vault.close();
    }
  });

  it("supports root listing order, limit, and offset options", () => {
    const dir = freshDir();
    const v = openVault(dir);
    v.insertMemory(makeMemory({ id: "m1" as MemoryId, createdAt: 100, updatedAt: 100 }));
    v.insertMemory(makeMemory({ id: "m2" as MemoryId, createdAt: 200, updatedAt: 200 }));
    v.insertMemory(makeMemory({ id: "m3" as MemoryId, createdAt: 300, updatedAt: 300 }));

    expect(
      listAllMemories(v, {
        includeExpired: true,
        limit: 1,
        offset: 1,
        orderBy: "updatedAt",
        orderDir: "asc",
      }).map((memory) => memory.id),
    ).toEqual(["m2"]);
    v.close();
  });

  it("rejects offset without limit instead of silently discarding the offset (KEIKO-0792)", () => {
    const dir = freshDir();
    const v = openVault(dir);
    const userScope = { kind: "user" as const, userId: "u-1" as UserId };
    v.insertMemory(makeMemory({ id: "m1" as MemoryId, createdAt: 100, updatedAt: 100 }));
    v.insertMemory(makeMemory({ id: "m2" as MemoryId, createdAt: 200, updatedAt: 200 }));
    v.insertMemory(makeMemory({ id: "m3" as MemoryId, createdAt: 300, updatedAt: 300 }));

    expect(() => v.listMemoriesByScope(userScope, { offset: 1 })).toThrow(
      MemoryStorageValidationError,
    );
    expect(() => v.listMemoriesAcrossScopes([userScope], { offset: 1 })).toThrow(
      MemoryStorageValidationError,
    );
    expect(() => v.listMemoryMetadataByScope(userScope, { offset: 1 })).toThrow(
      MemoryStorageValidationError,
    );
    v.close();
  });
});

describe("update + delete error paths", () => {
  it("throws not-found on update of a missing id", () => {
    const dir = freshDir();
    const v = openVault(dir);
    expect(() => {
      v.updateMemory("nope" as MemoryId, { body: "x" }, 1);
    }).toThrow(MemoryStorageError);
    v.close();
  });

  it("throws not-found on delete of a missing id", () => {
    const dir = freshDir();
    const v = openVault(dir);
    expect(() => {
      v.deleteMemory("nope" as MemoryId, {
        tombstone: false,
        forgetterSurface: "test",
        nowMs: 1,
      });
    }).toThrow(MemoryStorageError);
    v.close();
  });

  it("rolls back deleteMemories when a later tombstone insert fails", () => {
    const dir = freshDir();
    const events: MemoryEvent[] = [];
    const v = createMemoryVault({
      memoryDir: dir,
      env: { KEIKO_MEMORY_DIR: dir },
      vaultKey: TEST_VAULT_KEY,
      newTombstoneId: () => "duplicate-tombstone",
      onMemoryEvent: (e) => events.push(e),
    });
    v.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    v.insertMemory(makeMemory({ id: "m2" as MemoryId }));
    events.length = 0;

    expect(() => {
      v.deleteMemories([
        {
          id: "m1" as MemoryId,
          options: {
            tombstone: true,
            forgetterSurface: "test",
            reason: "test",
            nowMs: 1,
          },
        },
        {
          id: "m2" as MemoryId,
          options: {
            tombstone: true,
            forgetterSurface: "test",
            reason: "test",
            nowMs: 1,
          },
        },
      ]);
    }).toThrow();

    expect(v.getMemory("m1" as MemoryId)).toBeDefined();
    expect(v.getMemory("m2" as MemoryId)).toBeDefined();
    expect(v.listTombstonesByScope({ kind: "user", userId: "u-1" as UserId })).toEqual([]);
    expect(events).toEqual([]);
    v.close();
  });

  // Regression pin (audit KEIKO-0442): a batch containing a duplicate id must succeed and delete
  // each distinct id exactly once, not roll back the entire batch with a not-found error triggered
  // by the second occurrence's already-deleted row.
  it("dedupes duplicate ids within a single deleteMemories batch (last-wins)", () => {
    const dir = freshDir();
    const v = openVault(dir);
    v.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    v.insertMemory(makeMemory({ id: "m2" as MemoryId }));

    const results = v.deleteMemories([
      {
        id: "m1" as MemoryId,
        options: { tombstone: false, forgetterSurface: "test", nowMs: 1_700_000_001_000 },
      },
      {
        id: "m2" as MemoryId,
        options: { tombstone: false, forgetterSurface: "test", nowMs: 1_700_000_001_000 },
      },
      {
        id: "m1" as MemoryId,
        options: { tombstone: false, forgetterSurface: "test", nowMs: 1_700_000_002_000 },
      },
    ]);

    expect(results.map((r) => r.memoryId)).toEqual(["m1", "m2"]);
    expect(v.getMemory("m1" as MemoryId)).toBeUndefined();
    expect(v.getMemory("m2" as MemoryId)).toBeUndefined();
    v.close();
  });

  it("throws not-found on upsertEmbedding for a missing memory", () => {
    const dir = freshDir();
    const v = openVault(dir);
    expect(() => {
      v.upsertEmbedding("nope" as MemoryId, {
        provider: "p",
        modelId: "m",
        metric: "cosine",
        vector: new Float32Array([1, 2, 3]),
      });
    }).toThrow(MemoryStorageError);
    v.close();
  });

  it("bulk-reads embeddings through the vault port", () => {
    const dir = freshDir();
    const v = openVault(dir);
    v.insertMemory(makeMemory({ id: "m1" as MemoryId }));
    v.insertMemory(makeMemory({ id: "m2" as MemoryId }));
    v.upsertEmbedding("m1" as MemoryId, {
      provider: "p",
      modelId: "m",
      metric: "cosine",
      vector: new Float32Array([1, 0]),
    });
    const rows = v.getEmbeddings(["m1" as MemoryId, "m2" as MemoryId, "missing" as MemoryId]);
    expect([...rows.keys()]).toEqual(["m1" as MemoryId]);
    expect(Array.from(rows.get("m1" as MemoryId)?.vector ?? [])).toEqual([1, 0]);
    v.close();
  });
});

describe("boundary redaction is applied at insert + update", () => {
  it("scrubs body via the factory redactString before persisting", () => {
    const dir = freshDir();
    const vault = createMemoryVault({
      memoryDir: dir,
      env: { KEIKO_MEMORY_DIR: dir },
      vaultKey: TEST_VAULT_KEY,
      now: () => 1,
      newTombstoneId: () => "t-1",
      redactString: (s) => s.replace(/secret-\w+/g, "[REDACTED]"),
    });
    vault.insertMemory(makeMemory({ id: "m1" as MemoryId, body: "value secret-abc123 trailing" }));
    const back = vault.getMemory("m1" as MemoryId);
    expect(back?.body).toBe("value [REDACTED] trailing");
    vault.close();
  });
});

describe("project scope round-trips through list", () => {
  it("returns project-scoped rows for the right coordinate", () => {
    const dir = freshDir();
    const v = openVault(dir);
    v.insertMemory(
      makeMemory({
        id: "mp" as MemoryId,
        scope: { kind: "project", projectId: "p-1" as ProjectId },
      }),
    );
    expect(
      v.listMemoriesByScope({ kind: "project", projectId: "p-1" as ProjectId }).map((m) => m.id),
    ).toEqual(["mp"]);
    v.close();
  });
});

// PR-review follow-up (Codex threads 3769711634 + 3769903807 + 3770110875 + 3770211415):
// exhaustive coverage for the --force reembed atomic swap's precondition checks. Each pin
// exercises one drift mode (insert / update / delete / memory-body mutation) against the
// concurrent-write detection inside replaceAllEmbeddings.
describe("replaceAllEmbeddings concurrent-write detection", () => {
  const EMBEDDING = {
    provider: "openai",
    modelId: "text-embedding-3-large",
    metric: "cosine" as const,
    vector: Float32Array.from({ length: 8 }, (_, i) => (i + 1) / 8),
  };

  it("rejects when a concurrent INSERT lands between snapshot and swap", () => {
    const dir = freshDir();
    const v = openVault(dir);
    const a = v.insertMemory(makeMemory({ id: "a" as MemoryId }));
    v.upsertEmbedding(a.id, EMBEDDING);
    const snapshot = v.snapshotEmbeddedMemoryIds();
    // Simulate concurrent writer inserting a new embedded row after the CLI snapshotted.
    const late = v.insertMemory(makeMemory({ id: "late" as MemoryId }));
    v.upsertEmbedding(late.id, EMBEDDING);
    expect(() => {
      v.replaceAllEmbeddings([{ memoryId: a.id, input: EMBEDDING }], snapshot);
    }).toThrow(MemoryStorageError);
    // Both rows still exist — the swap rolled back before the delete.
    expect(v.getEmbedding(a.id)).toBeDefined();
    expect(v.getEmbedding(late.id)).toBeDefined();
    v.close();
  });

  it("rejects when a concurrent UPDATE bumps an embedding's created_at", () => {
    const dir = freshDir();
    const nowSeq = { value: 1_700_000_000_000 };
    const v = openVault(dir, [], nowSeq);
    const a = v.insertMemory(makeMemory({ id: "a" as MemoryId }));
    v.upsertEmbedding(a.id, EMBEDDING);
    const snapshot = v.snapshotEmbeddedMemoryIds();
    // Advance the clock and re-upsert so the row gains a new created_at that will not match
    // the snapshot value the CLI captured.
    nowSeq.value += 1_000;
    v.upsertEmbedding(a.id, EMBEDDING);
    expect(() => {
      v.replaceAllEmbeddings([{ memoryId: a.id, input: EMBEDDING }], snapshot);
    }).toThrow(MemoryStorageError);
    v.close();
  });

  it("rejects when a concurrent DELETE removes a snapshotted embedding row", () => {
    const dir = freshDir();
    const v = openVault(dir);
    const a = v.insertMemory(makeMemory({ id: "a" as MemoryId }));
    const b = v.insertMemory(makeMemory({ id: "b" as MemoryId }));
    v.upsertEmbedding(a.id, EMBEDDING);
    v.upsertEmbedding(b.id, EMBEDDING);
    const snapshot = v.snapshotEmbeddedMemoryIds();
    // Concurrent delete on b's embedding; the snapshot still contains b but the current
    // table doesn't. The swap must refuse rather than recreate b's stale vector.
    v.deleteEmbedding(b.id);
    expect(() => {
      v.replaceAllEmbeddings(
        [
          { memoryId: a.id, input: EMBEDDING },
          { memoryId: b.id, input: EMBEDDING },
        ],
        snapshot,
      );
    }).toThrow(MemoryStorageError);
    v.close();
  });

  it("rejects when a memory's body was edited between staging and swap", () => {
    const dir = freshDir();
    const nowSeq = { value: 1_700_000_000_000 };
    const v = openVault(dir, [], nowSeq);
    const a = v.insertMemory(makeMemory({ id: "a" as MemoryId, body: "old body" }));
    v.upsertEmbedding(a.id, EMBEDDING);
    const snapshot = v.snapshotEmbeddedMemoryIds();
    const memoryVersions = new Map<MemoryId, number>([[a.id, a.updatedAt]]);
    // Concurrent body edit stamps a fresh memories.updated_at, which the swap-time check
    // detects even though the embedding row itself is unchanged.
    nowSeq.value += 1_000;
    v.updateMemory(a.id, { body: "new body" }, nowSeq.value);
    expect(() => {
      v.replaceAllEmbeddings([{ memoryId: a.id, input: EMBEDDING }], snapshot, memoryVersions);
    }).toThrow(MemoryStorageError);
    v.close();
  });

  it("validates every pair through gateEmbeddingInput before touching the vector space", () => {
    const dir = freshDir();
    const v = openVault(dir);
    const a = v.insertMemory(makeMemory({ id: "a" as MemoryId }));
    v.upsertEmbedding(a.id, EMBEDDING);
    // Vector with 0 dims is rejected by gateEmbeddingInput; the bulk swap must apply the
    // same gate rather than silently persisting a malformed row.
    const bad = { ...EMBEDDING, vector: new Float32Array(0) };
    expect(() => {
      v.replaceAllEmbeddings([{ memoryId: a.id, input: bad }]);
    }).toThrow(MemoryStorageValidationError);
    // Prior vector space untouched.
    expect(Array.from(v.getEmbedding(a.id)?.vector ?? [])).toEqual(Array.from(EMBEDDING.vector));
    v.close();
  });
});

// w4a-memory-vault-fingerprint (epic #3233 §8, g18): `resolveVaultKey` returns `{ key, source }`
// but createMemoryVault used to destructure only `{ key }`, discarding `source` entirely — the
// key-resolution tier an operator needs to tell "opened via KEIKO_MEMORY_KEY" from "fell through
// to the weaker keyfile tier" was computed and then thrown away.
describe("activity-log seam: memory-vault.store.opened retains the key-resolution tier", () => {
  function recordingSink(): { sink: MemoryVaultLogSink; events: MemoryVaultLogEvent[] } {
    const events: MemoryVaultLogEvent[] = [];
    return {
      sink: {
        write: (event): void => {
          events.push(event);
        },
      },
      events,
    };
  }

  // RED (before fix): createMemoryVault had no `logSink` option and `resolveCipher` returned only
  // the cipher, so this event did not exist at all.
  it('emits exactly one event carrying keySource:"env" when KEIKO_MEMORY_KEY resolves the key', () => {
    const dir = freshDir();
    const { sink, events } = recordingSink();
    const key = randomBytes(32);

    const v = createMemoryVault({
      memoryDir: dir,
      env: { KEIKO_MEMORY_DIR: dir, KEIKO_MEMORY_KEY: key.toString("base64") },
      logSink: sink,
    });

    const opened = events.filter((event) => event.op === "memory-vault.store.opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ category: "memory", op: "memory-vault.store.opened" });
    expect(opened[0]?.extra).toEqual({
      completeness: "complete",
      keySource: "env",
      loss: "none",
    });
    expect(typeof opened[0]?.durationMs).toBe("number");
    const persisted = expectActivityLogProof(
      "memory-vault.store.opened.key-source",
      formatActivityLogProofLine(opened[0] ?? {}),
    );
    expect(persisted).toMatchObject({ keySource: "env" });
    v.close();
  });

  // A test-injected vaultKey/cipher never touches resolveVaultKey at all, so there is no tier to
  // report — the event still fires (the vault still opened), but without a keySource field.
  it("omits keySource from the event when a vaultKey/cipher test seam bypassed key resolution", () => {
    const dir = freshDir();
    const { sink, events } = recordingSink();

    const v = createMemoryVault({
      memoryDir: dir,
      env: { KEIKO_MEMORY_DIR: dir },
      vaultKey: Buffer.alloc(32, 7),
      logSink: sink,
    });

    const opened = events.filter((event) => event.op === "memory-vault.store.opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.extra).toEqual({ completeness: "complete", loss: "none" });
    v.close();
  });

  it("never throws when no logSink is supplied (fully backward-compatible)", () => {
    const dir = freshDir();
    expect(() => {
      const v = createMemoryVault({
        memoryDir: dir,
        env: { KEIKO_MEMORY_DIR: dir },
        vaultKey: Buffer.alloc(32, 7),
      });
      v.close();
    }).not.toThrow();
  });

  // Finding: store-open ordering. `createMemoryVault` used to emit `memory-vault.store.opened`
  // right after `openMemoryDatabase`, BEFORE `resolveBodySuppressionKey` ran. A cipher that fails
  // on its very first `sealString` call (the fresh-vault path, which mints and persists a new
  // body-suppression HMAC key) makes `createMemoryVault` throw, but the previous ordering had
  // already reported the open as successful by then. RED (before fix): this test's second
  // assertion fails because `opened` has length 1, not 0.
  it("emits no store-opened event when initialization fails after the store is opened", () => {
    const dir = freshDir();
    const { sink, events } = recordingSink();
    const throwingCipher: MemoryContentCipher = {
      sealString: (): string => {
        throw new Error("cipher unavailable");
      },
      openString: (envelope: string): string => envelope,
      sealBytes: (buf: Buffer): Buffer => buf,
      openBytes: (envelope: Buffer): Buffer => envelope,
      isSealed: (): boolean => false,
    };

    expect(() => {
      createMemoryVault({
        memoryDir: dir,
        env: { KEIKO_MEMORY_DIR: dir },
        cipher: throwingCipher,
        logSink: sink,
      });
    }).toThrow();

    const opened = events.filter((event) => event.op === "memory-vault.store.opened");
    expect(opened).toHaveLength(0);
    // #4068: the failed vault released its handle. Windows refuses to remove an open database.
    expect(() => {
      rmSync(dir, { recursive: true, force: true });
    }).not.toThrow();
  });
});
