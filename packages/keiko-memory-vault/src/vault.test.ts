import { afterEach, describe, expect, it } from "vitest";
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
  type MemoryEvent,
  type MemoryVaultStore,
} from "./index.js";
import type { MemoryVaultLogEvent, MemoryVaultLogSink } from "./vault-log.js";

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

describe("list filters", () => {
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
    expect(opened[0]?.extra).toEqual({ keySource: "env" });
    expect(typeof opened[0]?.durationMs).toBe("number");
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
    expect(opened[0]?.extra).toBeUndefined();
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
  });
});
