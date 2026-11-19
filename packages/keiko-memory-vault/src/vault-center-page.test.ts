// The Memory Center page, statements forgotten before they were stored and the accepted-set guard
// of a forced re-embedding, exercised at the vault's own boundary. The server suites cover the same
// paths through the built package, which does not count towards this package's coverage.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryRecord, ProjectId, UserId } from "@oscharko-dev/keiko-contracts/memory";
import { makeRecord, memId } from "./_support.js";
import {
  createMemoryVault,
  MEMORY_CENTER_PAGE_LIMIT,
  MemoryStorageError,
  MemoryStorageValidationError,
  type MemoryCenterPageOptions,
  type MemoryEmbeddingInput,
  type MemoryEvent,
  type MemoryVaultStore,
} from "./index.js";

const TEST_VAULT_KEY = Buffer.alloc(32, 7);
const T = 1_700_000_000_000;
const USER_SCOPE = { kind: "user", userId: "u-1" as UserId } as const;
const PROJECT_SCOPE = { kind: "project", projectId: "p-1" as ProjectId } as const;
const EMBEDDING: MemoryEmbeddingInput = {
  provider: "local",
  modelId: "embedding-model",
  metric: "cosine",
  vector: new Float32Array([1, 0, 0]),
};

const cleanups: string[] = [];

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface VaultFixture {
  readonly vault: MemoryVaultStore;
  readonly events: MemoryEvent[];
}

function openVault(
  options: { readonly onDeleteEventsBeforeCommit?: (events: readonly MemoryEvent[]) => void } = {},
): VaultFixture {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-mem-vault-page-"));
  cleanups.push(dir);
  const events: MemoryEvent[] = [];
  let tombstones = 0;
  const vault = createMemoryVault({
    memoryDir: dir,
    env: { KEIKO_MEMORY_DIR: dir },
    vaultKey: TEST_VAULT_KEY,
    now: () => T,
    newTombstoneId: () => {
      tombstones += 1;
      return `t-${String(tombstones)}`;
    },
    onMemoryEvent: (event) => events.push(event),
    ...options,
  });
  return { vault, events };
}

function record(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return makeRecord({ id: memId(id), scope: USER_SCOPE, ...overrides });
}

function writtenAt(ms: number): Pick<MemoryRecord, "createdAt" | "updatedAt"> {
  return { createdAt: ms, updatedAt: ms };
}

function pageIds(vault: MemoryVaultStore, options: MemoryCenterPageOptions): readonly string[] {
  return vault.listMemoryCenterPage(options).memories.map((memory) => memory.id);
}

describe("Memory Center page", () => {
  it("orders by creation, then update, then id, and decrypts only the requested page", () => {
    const { vault } = openVault();
    vault.insertMemory(record("older", { createdAt: T - 30, updatedAt: T - 30 }));
    vault.insertMemory(record("tie-b", { createdAt: T - 20, updatedAt: T - 20 }));
    vault.insertMemory(record("tie-a", { createdAt: T - 20, updatedAt: T - 20 }));
    vault.insertMemory(record("touched", { createdAt: T - 20, updatedAt: T - 5 }));
    vault.insertMemory(record("newest", { createdAt: T - 10, updatedAt: T - 10 }));

    const all = vault.listMemoryCenterPage({ limit: MEMORY_CENTER_PAGE_LIMIT, offset: 0 });
    expect(all.total).toBe(5);
    expect(all.memories.map((memory) => memory.id)).toEqual([
      "newest",
      "touched",
      "tie-a",
      "tie-b",
      "older",
    ]);
    expect(all.memories[0]?.body).toBe("prefers dark mode");

    const middle = vault.listMemoryCenterPage({ limit: 2, offset: 1 });
    expect(middle.total).toBe(5);
    expect(middle.memories.map((memory) => memory.id)).toEqual(["touched", "tie-a"]);

    const beyond = vault.listMemoryCenterPage({ limit: 2, offset: 9 });
    expect(beyond).toEqual({ memories: [], total: 5 });
  });

  it("applies type, status, sensitivity and scope-kind filters before paging", () => {
    const { vault } = openVault();
    vault.insertMemory(record("preference"));
    vault.insertMemory(record("decision", { type: "decision", ...writtenAt(T + 1) }));
    vault.insertMemory(record("proposed", { status: "proposed", ...writtenAt(T + 2) }));
    const open = record("public", writtenAt(T + 3));
    vault.insertMemory({ ...open, provenance: { ...open.provenance, sensitivity: "public" } });
    vault.insertMemory(record("project", { scope: PROJECT_SCOPE, ...writtenAt(T + 4) }));

    const whole = { limit: 50, offset: 0 } as const;
    expect(pageIds(vault, { ...whole, type: ["decision"] })).toEqual(["decision"]);
    expect(pageIds(vault, { ...whole, status: ["proposed"] })).toEqual(["proposed"]);
    expect(pageIds(vault, { ...whole, sensitivity: ["public"] })).toEqual(["public"]);
    expect(pageIds(vault, { ...whole, scopeKinds: ["project"] })).toEqual(["project"]);
    // An empty scope-kind list is no filter, like an absent one.
    expect(vault.listMemoryCenterPage({ ...whole, scopeKinds: [] }).total).toBe(5);
    expect(
      vault.listMemoryCenterPage({ ...whole, scopeKinds: ["user"], status: ["accepted"] }).total,
    ).toBe(3);
  });

  it.each([
    ["a page size of zero", { limit: 0, offset: 0 }],
    ["a page size above the limit", { limit: MEMORY_CENTER_PAGE_LIMIT + 1, offset: 0 }],
    ["a fractional page size", { limit: 1.5, offset: 0 }],
    ["a negative offset", { limit: 1, offset: -1 }],
    ["a fractional offset", { limit: 1, offset: 0.5 }],
    ["an unknown status", { limit: 1, offset: 0, status: ["retired"] }],
    ["an unknown type", { limit: 1, offset: 0, type: ["rumour"] }],
    ["an unknown sensitivity", { limit: 1, offset: 0, sensitivity: ["secret"] }],
    ["an unknown scope kind", { limit: 1, offset: 0, scopeKinds: ["team"] }],
    ["a filter that is no list", { limit: 1, offset: 0, status: "accepted" }],
    ["a filter with a non-string entry", { limit: 1, offset: 0, type: [7] }],
  ])("refuses %s before reading any content", (_name, options) => {
    const { vault } = openVault();
    vault.insertMemory(record("present"));
    expect(() => vault.listMemoryCenterPage(options as unknown as MemoryCenterPageOptions)).toThrow(
      MemoryStorageValidationError,
    );
  });
});

describe("statements forgotten before they were stored", () => {
  it("records one tombstone per statement that suppresses the same words later", () => {
    const { vault, events } = openVault();
    const tombstones = vault.recordForgottenStatements([
      {
        scope: USER_SCOPE,
        body: "I prefer tabs.",
        forgetterSurface: "chat",
        reason: "asked in chat",
        nowMs: T,
      },
      {
        scope: PROJECT_SCOPE,
        body: "The release is on Friday.",
        forgetterSurface: "chat",
        nowMs: T,
        bodyEmbedding: EMBEDDING,
      },
    ]);

    expect(tombstones).toHaveLength(2);
    // One shared memory id: the statements never became a memory of their own.
    expect(new Set(tombstones.map((tombstone) => tombstone.memoryId)).size).toBe(1);
    expect(tombstones[0]).toMatchObject({
      scopeKind: "user",
      type: "semantic-fact",
      forgottenAt: T,
      forgetterSurface: "chat",
      // Free text never reaches the ledger: an unknown reason is recorded as the closed code.
      reason: "user-request",
    });
    expect(tombstones[1]?.reason).toBeUndefined();
    // The body is kept only as a keyed hash, different per statement.
    expect(tombstones[0]?.bodyHash).toMatch(/^hmac-sha256:v2:[0-9a-f]{64}$/u);
    expect(tombstones[1]?.bodyHash).not.toBe(tombstones[0]?.bodyHash);
    expect(JSON.stringify(tombstones)).not.toContain("I prefer tabs.");
    expect(vault.hasForgetTombstoneForBody(USER_SCOPE, "i prefer TABS")).toBe(true);
    expect(vault.hasForgetTombstoneForBody(PROJECT_SCOPE, "I prefer tabs.")).toBe(false);
    expect(vault.listTombstonesByScope(PROJECT_SCOPE)).toHaveLength(1);
    expect(events.filter((event) => event.kind === "memory:tombstoned")).toHaveLength(2);
  });

  it("writes nothing when the audit ledger refuses the forget", () => {
    const { vault, events } = openVault({
      onDeleteEventsBeforeCommit: () => {
        throw new Error("audit ledger unavailable");
      },
    });
    expect(() =>
      vault.recordForgottenStatements([
        { scope: USER_SCOPE, body: "I prefer tabs.", forgetterSurface: "chat", nowMs: T },
      ]),
    ).toThrow("audit ledger unavailable");
    expect(vault.hasForgetTombstoneForBody(USER_SCOPE, "I prefer tabs.")).toBe(false);
    expect(vault.listTombstonesByScope(USER_SCOPE)).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("forced re-embedding against the accepted set", () => {
  function seeded(): MemoryVaultStore {
    const { vault } = openVault();
    vault.insertMemory(record("first"));
    vault.insertMemory(record("second", writtenAt(T + 1)));
    return vault;
  }

  function replaceWithExpectedAccepted(vault: MemoryVaultStore, accepted: readonly string[]): void {
    vault.replaceAllEmbeddings(
      [{ memoryId: memId("first"), input: EMBEDDING }],
      undefined,
      undefined,
      new Set(accepted.map((id) => memId(id))),
    );
  }

  it("swaps the vectors when the accepted set is the one that was staged", () => {
    const vault = seeded();
    replaceWithExpectedAccepted(vault, ["first", "second"]);
    expect(vault.listEmbeddedMemoryIds()).toEqual(["first"]);
  });

  it("aborts when a memory was accepted after staging", () => {
    const vault = seeded();
    expect(() => {
      replaceWithExpectedAccepted(vault, ["first"]);
    }).toThrow(MemoryStorageError);
    expect(vault.listEmbeddedMemoryIds()).toEqual([]);
  });

  it("aborts when a staged memory is no longer accepted", () => {
    const vault = seeded();
    expect(() => {
      replaceWithExpectedAccepted(vault, ["first", "second", "gone"]);
    }).toThrow("Accepted memory set changed during --force staging; rerun.");
    expect(vault.listEmbeddedMemoryIds()).toEqual([]);
  });
});
