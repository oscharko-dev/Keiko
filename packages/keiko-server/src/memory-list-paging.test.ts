import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemoryUserId,
} from "@oscharko-dev/keiko-contracts";
import {
  createMemoryContentCipher,
  createMemoryVault,
  MemoryStorageError,
  MemoryStorageValidationError,
  type MemoryVaultStore,
} from "@oscharko-dev/keiko-memory-vault";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { handleListMemories } from "./memory-handlers.js";
import type { RouteContext } from "./routes.js";
import { createInMemoryUiStore } from "./store/index.js";

const BODY_PREFIX = "Synthetic list body ";
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeFixture(): {
  readonly vault: MemoryVaultStore;
  readonly writer: MemoryVaultStore;
  readonly opened: { bodies: number; failBody: boolean };
} {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-memory-list-page-"));
  const key = Buffer.alloc(32, 19);
  const real = createMemoryContentCipher(key);
  const opened = { bodies: 0, failBody: false };
  const vault = createMemoryVault({
    memoryDir: dir,
    vaultKey: key,
    cipher: {
      ...real,
      openString: (value) => {
        const plaintext = real.openString(value);
        if (plaintext.startsWith(BODY_PREFIX)) {
          opened.bodies += 1;
          if (opened.failBody)
            throw new MemoryStorageError("internal", "Synthetic body read failure");
        }
        return plaintext;
      },
    },
  });
  const writer = createMemoryVault({ memoryDir: dir, vaultKey: key });
  cleanups.push(() => {
    writer.close();
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { vault, writer, opened };
}

function record(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: id as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "synthetic-user" as MemoryUserId },
    type: "preference",
    body: `${BODY_PREFIX}${id}`,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: 100,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: 100 },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function list(
  vault: MemoryVaultStore,
  query: string,
  redactor: UiHandlerDeps["redactor"] = buildRedactor({}),
): { readonly memories: MemoryRecord[]; readonly total: number } {
  const deps: UiHandlerDeps = {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor,
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    memoryVault: vault,
  };
  const ctx: RouteContext = {
    correlationId: undefined,
    req: Readable.from([]) as unknown as IncomingMessage,
    res: { socket: new Socket() } as unknown as RouteContext["res"],
    params: {},
    url: new URL(`http://127.0.0.1/api/memory?${query}`),
  };
  const result = handleListMemories(ctx, deps);
  expect(result.status).toBe(200);
  return result.body as { readonly memories: MemoryRecord[]; readonly total: number };
}

function interleave<T>(sqlPrefix: string, read: () => T, write: () => void): T {
  const prepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")
    ?.value as DatabaseSync["prepare"];
  let ran = false;
  let restoreRead = (): void => undefined;
  const fault = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ): ReturnType<typeof prepare> {
    const statement = prepare.call(this, sql);
    if (!ran && sql.trimStart().startsWith(sqlPrefix)) {
      const all = statement.all.bind(statement);
      const selection = vi.spyOn(statement, "all").mockImplementationOnce((...params) => {
        const rows = all(...params);
        ran = true;
        write();
        return rows;
      });
      restoreRead = (): void => {
        selection.mockRestore();
      };
    }
    return statement;
  });
  try {
    const result = read();
    expect(ran).toBe(true);
    return result;
  } finally {
    restoreRead();
    fault.mockRestore();
  }
}

describe("Memory Center metadata paging", () => {
  it("decrypts just the requested page without changing total or order", () => {
    const { vault, opened } = makeFixture();
    for (let index = 0; index < 1_000; index += 1) {
      vault.insertMemory(record(`list-${String(index).padStart(4, "0")}`));
    }
    opened.bodies = 0;
    const result = list(vault, "offset=42&limit=1");
    expect(result.total).toBe(1_000);
    expect(result.memories.map(({ id }) => id)).toEqual(["list-0042"]);
    expect(opened.bodies).toBe(1);
  });

  it("still searches all matching body candidates when a query is supplied", () => {
    const { vault, opened } = makeFixture();
    for (let index = 0; index < 30; index += 1) {
      vault.insertMemory(record(`search-${String(index)}`));
    }
    opened.bodies = 0;
    const result = list(vault, "q=body%20search-29&limit=1");
    expect(result.memories.map(({ id }) => id)).toEqual(["search-29"]);
    expect(result.total).toBe(1);
    expect(opened.bodies).toBe(30);
  });

  it("retains localeCompare ties and both timestamp priorities", () => {
    const { vault } = makeFixture();
    for (const id of ["é", "e\u0301", "Å", "A\u030a", "A", "a", "Z", "😀"]) {
      vault.insertMemory(record(id));
    }
    vault.insertMemory(record("updated-first", { updatedAt: 300 }));
    vault.insertMemory(record("created-first", { createdAt: 200, updatedAt: 200 }));
    const legacy = list(vault, "q=Synthetic&limit=200");
    const paged = list(vault, "limit=200");
    expect(paged).toEqual(legacy);
    expect(paged.memories.slice(0, 2).map(({ id }) => id)).toEqual([
      "created-first",
      "updated-first",
    ]);
  });

  it("keeps the configured credential floor on the returned page", () => {
    const { vault } = makeFixture();
    const marker = "synthetic-redaction-marker-for-local-test";
    const stored = vault.insertMemory(record("redacted-page", { body: `${BODY_PREFIX}${marker}` }));
    const redactor = buildRedactor(
      {},
      {
        providers: [
          {
            modelId: "synthetic-model",
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: marker,
            timeoutMs: 100,
            maxRetries: 0,
            retryBaseDelayMs: 0,
          },
        ],
        circuitBreaker: { failureThreshold: 1, cooldownMs: 1, halfOpenProbes: 1 },
      },
    );
    const page = list(vault, "limit=1", redactor);
    expect(page.memories[0]?.body).not.toContain(marker);
    expect(page).toEqual(list(vault, "q=Synthetic&limit=1", redactor));
    expect(vault.getMemory(stored.id)?.body).toBe(stored.body);
  });

  it("returns a complete empty page without decrypting records", () => {
    const { vault, opened } = makeFixture();
    expect(list(vault, "limit=2")).toEqual({ memories: [], total: 0, limit: 2, offset: 0 });
    expect(opened.bodies).toBe(0);
  });

  it("releases its snapshot after a selected body cannot be opened", () => {
    const { vault, writer, opened } = makeFixture();
    vault.insertMemory(record("read-recovery"));
    opened.failBody = true;
    expect(() => vault.listMemoryCenterPage({ limit: 1, offset: 0 })).toThrow(MemoryStorageError);
    opened.failBody = false;
    writer.updateMemory("read-recovery" as MemoryId, { tags: ["updated"] }, 101);
    expect(list(vault, "limit=1").memories[0]?.tags).toEqual(["updated"]);
  });

  it.each(["scope", "metadata"] as const)("keeps a single snapshot after %s selection", (phase) => {
    const { vault, writer } = makeFixture();
    const first = vault.insertMemory(record("snapshot-first"));
    const second = vault.insertMemory(record("snapshot-second"));
    const result = interleave(
      phase === "scope" ? "SELECT DISTINCT scope_kind" : "SELECT id, schema_version",
      () => list(vault, "limit=2"),
      () => {
        writer.insertMemory(
          record("new-project", {
            scope: { kind: "project", projectId: "synthetic-project" } as MemoryScope,
          }),
        );
        writer.updateMemory(first.id, { body: `${BODY_PREFIX}updated` }, 101);
        writer.deleteMemory(second.id, {
          tombstone: true,
          forgetterSurface: "memory-center",
          nowMs: 101,
        });
      },
    );
    expect(result).toEqual({ memories: [first, second], total: 2, limit: 2, offset: 0 });
    const fresh = list(vault, "limit=2");
    expect(fresh.total).toBe(2);
    expect(fresh.memories.map(({ id }) => id)).toEqual(["snapshot-first", "new-project"]);
    expect(fresh.memories[0]?.body).toBe(`${BODY_PREFIX}updated`);
  });

  it.each([
    "scope=user",
    "scope=project,global",
    "status=proposed,archived",
    "sensitivity=restricted,confidential",
    "type=semantic-fact",
    "scope=workflow&status=accepted&sensitivity=public",
    "offset=500",
  ])("preserves all filters, totals and page ordering for %s", (filters) => {
    const { vault, opened } = makeFixture();
    const scopes = [
      { kind: "global" },
      { kind: "user", userId: "same-coordinate" },
      { kind: "project", projectId: "same-coordinate" },
      { kind: "workspace", workspaceId: "same-coordinate" },
      { kind: "workflow", workflowDefinitionId: "same-coordinate" },
    ] as readonly MemoryScope[];
    let index = 0;
    for (const scope of scopes) {
      for (const sensitivity of ["public", "restricted", "confidential"] as const) {
        for (const status of ["accepted", "proposed", "archived"] as const) {
          index += 1;
          vault.insertMemory(
            record(`filter-${String(index).padStart(3, "0")}`, {
              scope,
              status,
              type: index % 2 === 0 ? "semantic-fact" : "preference",
              provenance: { ...record("template").provenance, sensitivity },
            }),
          );
        }
      }
    }
    const legacy = list(vault, `q=Synthetic&limit=2&${filters}`);
    opened.bodies = 0;
    const page = list(vault, `limit=2&${filters}`);
    expect(page).toEqual(legacy);
    expect(opened.bodies).toBe(page.memories.length);
  });

  it.each([
    { limit: 0 },
    { limit: 201 },
    { offset: -1 },
    { offset: Number.NaN },
    { scopeKinds: ["unknown"] },
    { sensitivity: ["unknown"] },
    { status: ["unknown"] },
    { type: ["unknown"] },
  ])("rejects an unsupported page %j without opening content", (invalid) => {
    const { vault, opened } = makeFixture();
    vault.insertMemory(record("invalid-page-control"));
    opened.bodies = 0;
    expect(() => vault.listMemoryCenterPage({ limit: 1, offset: 0, ...invalid } as never)).toThrow(
      MemoryStorageValidationError,
    );
    expect(opened.bodies).toBe(0);
    expect(list(vault, "limit=1").total).toBe(1);
  });
});
