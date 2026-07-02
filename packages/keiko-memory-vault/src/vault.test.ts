import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  MemoryStorageError,
  MemoryStorageValidationError,
  type MemoryEvent,
  type MemoryVaultStore,
} from "./index.js";

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
  const dir = mkdtempSync(join(tmpdir(), "keiko-mem-vault-"));
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
  it("hardens WAL sidecars created by later writes on POSIX", () => {
    if (process.platform === "win32") return;
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
    raw
      .prepare("UPDATE memory_tombstones SET body_hash = ? WHERE id = ?")
      .run(legacyHash, "t-1");
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
