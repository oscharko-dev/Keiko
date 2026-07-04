import {
  EDITOR_HOT_EXIT_SCHEMA_VERSION,
  EDITOR_HOT_EXIT_TTL_MS,
  type EditorHotExitSnapshotV1,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteEditorHotExitSnapshot,
  readEditorHotExitSnapshot,
  writeEditorHotExitSnapshot,
} from "./editorHotExitStore";
import {
  deleteEditorHotExitContent,
  readEditorHotExitContent,
  writeEditorHotExitContent,
} from "../../../../../lib/api";

const hotExitApi = vi.hoisted(() => {
  const encoder = new TextEncoder();
  let seq = 0;
  const records = new Map<string, unknown>();
  return {
    records,
    reset(): void {
      seq = 0;
      records.clear();
    },
    write: vi.fn((snapshot: EditorHotExitSnapshotV1) => {
      seq += 1;
      const snapshotRef = `hot-exit-ref-${String(seq)}`;
      records.set(snapshotRef, {
        schemaVersion: 1,
        content: snapshot.content,
        baseVersion: snapshot.baseVersion,
        contentHash: snapshot.contentHash,
        savedContentHash: snapshot.savedContentHash,
        contentSizeBytes: encoder.encode(snapshot.content).length,
        updatedAt: snapshot.updatedAt,
        paneId: snapshot.paneId,
        windowId: snapshot.windowId,
      });
      return Promise.resolve({
        snapshotRef,
        contentSizeBytes: encoder.encode(snapshot.content).length,
      });
    }),
    read: vi.fn((input: { readonly snapshotRef: string }) =>
      Promise.resolve(
        records.has(input.snapshotRef)
          ? { found: true, snapshot: records.get(input.snapshotRef) }
          : { found: false },
      ),
    ),
    delete: vi.fn((input: { readonly snapshotRef: string }) => {
      records.delete(input.snapshotRef);
      return Promise.resolve();
    }),
  };
});

vi.mock("../../../../../lib/api", () => ({
  writeEditorHotExitContent: hotExitApi.write,
  readEditorHotExitContent: hotExitApi.read,
  deleteEditorHotExitContent: hotExitApi.delete,
}));

type RequestHandler = ((event?: Event) => void) | null;
type FakeOpenRequest = FakeIdbRequest<FakeDatabase> & {
  onupgradeneeded: RequestHandler;
};

let fakeGetAllCount = 0;

class FakeIdbRequest<T = unknown> {
  result!: T;
  error: Error | null = null;
  onsuccess: RequestHandler = null;
  onerror: RequestHandler = null;
}

class FakeObjectStore {
  constructor(
    private readonly records: Map<string, unknown>,
    private readonly tx: FakeTransaction,
  ) {}

  get(key: string): IDBRequest<unknown> {
    return this.resolve(this.records.get(key));
  }

  getAll(): IDBRequest<unknown[]> {
    fakeGetAllCount += 1;
    return this.resolve([...this.records.values()]);
  }

  put(value: unknown, key: string): IDBRequest<IDBValidKey> {
    this.records.set(key, value);
    return this.resolve<IDBValidKey>(key);
  }

  delete(key: string): IDBRequest<undefined> {
    this.records.delete(key);
    return this.resolve(undefined);
  }

  private resolve<T>(value: T): IDBRequest<T> {
    const request = new FakeIdbRequest<T>();
    queueMicrotask(() => {
      request.result = value;
      request.onsuccess?.();
      this.tx.completeSoon();
    });
    return request as IDBRequest<T>;
  }
}

class FakeTransaction {
  oncomplete: RequestHandler = null;
  onerror: RequestHandler = null;
  onabort: RequestHandler = null;
  error: Error | null = null;

  constructor(private readonly records: Map<string, unknown>) {}

  objectStore(): FakeObjectStore {
    return new FakeObjectStore(this.records, this);
  }

  completeSoon(): void {
    setTimeout(() => {
      this.oncomplete?.();
    }, 0);
  }
}

class FakeDatabase {
  readonly stores = new Map<string, Map<string, unknown>>();
  readonly objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name),
  };

  createObjectStore(name: string): void {
    this.stores.set(name, new Map<string, unknown>());
  }

  deleteObjectStore(name: string): void {
    this.stores.delete(name);
  }

  transaction(name: string): FakeTransaction {
    let records = this.stores.get(name);
    if (records === undefined) {
      records = new Map<string, unknown>();
      this.stores.set(name, records);
    }
    return new FakeTransaction(records);
  }

  close(): void {}
}

class FakeIndexedDb {
  private readonly databases = new Map<string, FakeDatabase>();
  private readonly versions = new Map<string, number>();
  openCount = 0;

  open(name: string, version?: number): IDBOpenDBRequest {
    this.openCount += 1;
    const request = new FakeIdbRequest<FakeDatabase>() as FakeOpenRequest;
    queueMicrotask(() => {
      let db = this.databases.get(name);
      const fresh = db === undefined;
      if (db === undefined) {
        db = new FakeDatabase();
        this.databases.set(name, db);
      }
      const currentVersion = this.versions.get(name) ?? 0;
      const requestedVersion = version ?? currentVersion;
      const upgrade = fresh || requestedVersion > currentVersion;
      this.versions.set(name, requestedVersion);
      request.result = db;
      if (upgrade) request.onupgradeneeded?.(new Event("upgradeneeded"));
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  }

  records(name: string, store: string): Map<string, unknown> {
    return this.databases.get(name)?.stores.get(store) ?? new Map();
  }

  seed(name: string, version: number, store: string, records: Map<string, unknown>): void {
    const db = new FakeDatabase();
    db.createObjectStore(store);
    const target = db.stores.get(store);
    for (const [key, value] of records) target?.set(key, value);
    this.databases.set(name, db);
    this.versions.set(name, version);
  }
}

class OpenErrorIndexedDb {
  open(): IDBOpenDBRequest {
    const request = new FakeIdbRequest<FakeDatabase>() as FakeOpenRequest;
    queueMicrotask(() => {
      request.error = null;
      request.onerror?.();
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

class RequestErrorObjectStore {
  get(): IDBRequest<unknown> {
    const request = new FakeIdbRequest<unknown>();
    queueMicrotask(() => {
      request.error = null;
      request.onerror?.();
    });
    return request as IDBRequest<unknown>;
  }

  getAll(): IDBRequest<unknown[]> {
    const request = new FakeIdbRequest<unknown[]>();
    queueMicrotask(() => {
      request.error = new Error("request failed");
      request.onerror?.();
    });
    return request as IDBRequest<unknown[]>;
  }
}

class RequestErrorTransaction {
  oncomplete: RequestHandler = null;
  onerror: RequestHandler = null;
  onabort: RequestHandler = null;
  error: Error | null = null;

  objectStore(): RequestErrorObjectStore {
    return new RequestErrorObjectStore();
  }
}

class RequestErrorDatabase {
  readonly objectStoreNames = {
    contains: (): boolean => true,
  };

  transaction(): RequestErrorTransaction {
    return new RequestErrorTransaction();
  }

  close(): void {}
}

class AbortObjectStore {
  constructor(private readonly tx: AbortTransaction) {}

  getAll(): IDBRequest<unknown[]> {
    const request = new FakeIdbRequest<unknown[]>();
    queueMicrotask(() => {
      request.result = [];
      request.onsuccess?.();
      setTimeout(() => {
        this.tx.onabort?.();
      }, 0);
    });
    return request as IDBRequest<unknown[]>;
  }
}

class AbortTransaction {
  oncomplete: RequestHandler = null;
  onerror: RequestHandler = null;
  onabort: RequestHandler = null;
  error: Error | null = null;

  objectStore(): AbortObjectStore {
    return new AbortObjectStore(this);
  }
}

class AbortDatabase {
  readonly objectStoreNames = {
    contains: (): boolean => true,
  };

  transaction(): AbortTransaction {
    return new AbortTransaction();
  }

  close(): void {}
}

class StaticIndexedDb {
  constructor(private readonly db: unknown) {}

  open(): IDBOpenDBRequest {
    const request = new FakeIdbRequest<unknown>();
    queueMicrotask(() => {
      request.result = this.db;
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

function installIndexedDb(indexedDb: unknown = new FakeIndexedDb()): void {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: indexedDb,
  });
}

function removeIndexedDb(): void {
  Reflect.deleteProperty(globalThis, "indexedDB");
}

function snapshot(overrides: Partial<EditorHotExitSnapshotV1> = {}): EditorHotExitSnapshotV1 {
  return {
    schemaVersion: EDITOR_HOT_EXIT_SCHEMA_VERSION,
    workspaceRoot: "/repo",
    relativePath: "src/app.ts",
    content: "const value = 2;\n",
    baseVersion: { sizeBytes: 16, modifiedAt: 1, contentHash: "a".repeat(64) },
    contentHash: "b".repeat(64),
    savedContentHash: "a".repeat(64),
    updatedAt: 1_000,
    paneId: "pane-1",
    windowId: "editor-1",
    ...overrides,
  };
}

async function expectRejectedMessage(promise: Promise<unknown>, message: string): Promise<void> {
  await promise.then(
    () => {
      throw new Error(`Expected promise to reject with ${message}`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(message);
    },
  );
}

beforeEach(() => {
  fakeGetAllCount = 0;
  hotExitApi.reset();
  vi.mocked(writeEditorHotExitContent).mockClear();
  vi.mocked(readEditorHotExitContent).mockClear();
  vi.mocked(deleteEditorHotExitContent).mockClear();
  installIndexedDb();
});

afterEach(() => {
  removeIndexedDb();
});

describe("editorHotExitStore", () => {
  it("stores, reads, and deletes a hot-exit snapshot by workspace root and path", async () => {
    const stored = snapshot();

    await writeEditorHotExitSnapshot(stored);

    await expect(readEditorHotExitSnapshot("/repo", "src/app.ts", 1_001)).resolves.toEqual(stored);
    await expect(readEditorHotExitSnapshot("/repo", "src/other.ts", 1_001)).resolves.toBeNull();

    await deleteEditorHotExitSnapshot("/repo", "src/app.ts");
    await expect(readEditorHotExitSnapshot("/repo", "src/app.ts", 1_001)).resolves.toBeNull();
  });

  it("stores only metadata in IndexedDB, never raw roots, paths, or buffer content", async () => {
    const indexedDb = new FakeIndexedDb();
    installIndexedDb(indexedDb);
    const stored = snapshot({
      workspaceRoot: "/Users/alice/private/project",
      relativePath: "secrets/.env",
      content: "API_KEY=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
    });

    await writeEditorHotExitSnapshot(stored);

    expect(writeEditorHotExitContent).toHaveBeenCalledWith(stored);
    const records = indexedDb.records("keiko-editor-hot-exit", "snapshots");
    expect(records.size).toBe(1);
    const [rawKey] = [...records.keys()];
    expect(rawKey).toMatch(/^[a-f0-9]{64}$/u);
    const serialized = JSON.stringify([...records.entries()]);
    expect(serialized).not.toContain("/Users/alice/private/project");
    expect(serialized).not.toContain("secrets/.env");
    expect(serialized).not.toContain("API_KEY");
    expect(serialized).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(serialized).toContain("hot-exit-ref-1");
  });

  it("clears the IndexedDB recovery index when the server suppresses secret-shaped content", async () => {
    const indexedDb = new FakeIndexedDb();
    installIndexedDb(indexedDb);
    const clean = snapshot({ relativePath: "src/app.ts", content: "const value = 1;\n" });
    await writeEditorHotExitSnapshot(clean);
    expect(indexedDb.records("keiko-editor-hot-exit", "snapshots").size).toBe(1);

    vi.mocked(writeEditorHotExitContent).mockResolvedValueOnce({
      snapshotRef: "hot-exit-ref-suppressed",
      contentSizeBytes: 0,
      suppressed: true,
    });
    await writeEditorHotExitSnapshot(
      snapshot({
        relativePath: "src/app.ts",
        content: "API_KEY=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        updatedAt: 2_000,
      }),
    );

    expect(indexedDb.records("keiko-editor-hot-exit", "snapshots").size).toBe(0);
    await expect(readEditorHotExitSnapshot("/repo", "src/app.ts", 2_001)).resolves.toBeNull();
  });

  it("purges legacy v1 plaintext IndexedDB records during the v2 upgrade", async () => {
    const indexedDb = new FakeIndexedDb();
    indexedDb.seed(
      "keiko-editor-hot-exit",
      1,
      "snapshots",
      new Map([["/repo\u0000src/app.ts", snapshot({ content: "legacy plaintext secret" })]]),
    );
    installIndexedDb(indexedDb);

    await expect(readEditorHotExitSnapshot("/repo", "src/app.ts", 1_001)).resolves.toBeNull();

    const serialized = JSON.stringify([
      ...indexedDb.records("keiko-editor-hot-exit", "snapshots").entries(),
    ]);
    expect(serialized).not.toContain("/repo");
    expect(serialized).not.toContain("src/app.ts");
    expect(serialized).not.toContain("legacy plaintext secret");
  });

  it("reuses one IndexedDB connection across hot-exit operations", async () => {
    const indexedDb = new FakeIndexedDb();
    installIndexedDb(indexedDb);
    const stored = snapshot();

    await writeEditorHotExitSnapshot(stored);
    await expect(readEditorHotExitSnapshot("/repo", "src/app.ts", 1_001)).resolves.toEqual(stored);
    await deleteEditorHotExitSnapshot("/repo", "src/app.ts");

    expect(indexedDb.openCount).toBe(1);
  });

  it("does not full-scan the snapshot store for every small debounced write", async () => {
    await writeEditorHotExitSnapshot(snapshot({ relativePath: "src/one.ts", updatedAt: 10_000 }));
    await writeEditorHotExitSnapshot(snapshot({ relativePath: "src/two.ts", updatedAt: 10_100 }));

    expect(fakeGetAllCount).toBe(1);
  });

  it("ignores unsupported schema versions and unavailable IndexedDB", async () => {
    await writeEditorHotExitSnapshot({
      ...snapshot(),
      schemaVersion: "unsupported",
    } as unknown as EditorHotExitSnapshotV1);
    await expect(readEditorHotExitSnapshot("/repo", "src/app.ts", 1_001)).resolves.toBeNull();

    removeIndexedDb();
    await expect(writeEditorHotExitSnapshot(snapshot())).resolves.toBeUndefined();
    await expect(readEditorHotExitSnapshot("/repo", "src/app.ts")).resolves.toBeNull();
    await expect(deleteEditorHotExitSnapshot("/repo", "src/app.ts")).resolves.toBeUndefined();
  });

  it("degrades quietly when IndexedDB cannot be opened", async () => {
    installIndexedDb(new OpenErrorIndexedDb());

    await expect(readEditorHotExitSnapshot("/repo", "src/app.ts")).resolves.toBeNull();
    await expect(writeEditorHotExitSnapshot(snapshot())).resolves.toBeUndefined();
    await expect(deleteEditorHotExitSnapshot("/repo", "src/app.ts")).resolves.toBeUndefined();
  });

  it("surfaces IndexedDB request and transaction failures to callers", async () => {
    installIndexedDb(new StaticIndexedDb(new RequestErrorDatabase()));

    await expectRejectedMessage(
      readEditorHotExitSnapshot("/repo", "src/app.ts"),
      "IndexedDB request failed.",
    );
    await expectRejectedMessage(writeEditorHotExitSnapshot(snapshot()), "request failed");

    installIndexedDb(new StaticIndexedDb(new AbortDatabase()));
    await expectRejectedMessage(
      writeEditorHotExitSnapshot(snapshot()),
      "IndexedDB transaction aborted.",
    );
  });

  it("prunes expired snapshots before writing fresh recovery data", async () => {
    const expired = snapshot({
      relativePath: "src/old.ts",
      updatedAt: 1_000,
    });
    const freshNow = 1_000 + EDITOR_HOT_EXIT_TTL_MS + 10;
    const fresh = snapshot({
      relativePath: "src/new.ts",
      updatedAt: freshNow,
      content: "const next = 1;\n",
      contentHash: "c".repeat(64),
    });

    await writeEditorHotExitSnapshot(expired);
    await writeEditorHotExitSnapshot(fresh);

    await expect(readEditorHotExitSnapshot("/repo", "src/old.ts", freshNow)).resolves.toBeNull();
    await expect(readEditorHotExitSnapshot("/repo", "src/new.ts", freshNow)).resolves.toEqual(
      fresh,
    );
  });

  it("evicts the oldest fresh snapshots when total hot-exit storage exceeds the quota", async () => {
    const older = snapshot({
      relativePath: "src/older.ts",
      content: "const older = true;\n",
      updatedAt: 1_999,
    });
    const oversized = snapshot({
      relativePath: "src/large.ts",
      content: "x".repeat(8 * 1024 * 1024),
      updatedAt: 2_000,
    });
    const fresh = snapshot({
      relativePath: "src/fresh.ts",
      content: "const fresh = true;\n",
      updatedAt: 2_001,
    });

    await writeEditorHotExitSnapshot(older);
    await writeEditorHotExitSnapshot(oversized);
    await writeEditorHotExitSnapshot(fresh);

    await expect(readEditorHotExitSnapshot("/repo", "src/older.ts", 2_002)).resolves.toBeNull();
    await expect(readEditorHotExitSnapshot("/repo", "src/large.ts", 2_002)).resolves.toBeNull();
    await expect(readEditorHotExitSnapshot("/repo", "src/fresh.ts", 2_002)).resolves.toEqual(fresh);
  });

  it("counts the incoming snapshot against the quota so a fresh write cannot exceed the cap", async () => {
    // ~5 MiB each: either fits alone under the 8 MiB cap, but the two together exceed it. A prune
    // that ignored the snapshot being written would leave both in the store at ~10 MiB.
    const half = "y".repeat(5 * 1024 * 1024);
    const first = snapshot({ relativePath: "src/first.ts", content: half, updatedAt: 3_000 });
    const second = snapshot({ relativePath: "src/second.ts", content: half, updatedAt: 3_001 });

    await writeEditorHotExitSnapshot(first);
    await writeEditorHotExitSnapshot(second);

    await expect(readEditorHotExitSnapshot("/repo", "src/first.ts", 3_002)).resolves.toBeNull();
    await expect(readEditorHotExitSnapshot("/repo", "src/second.ts", 3_002)).resolves.toEqual(
      second,
    );
  });

  it("excludes the overwritten predecessor's bytes so an unrelated snapshot is not over-evicted", async () => {
    // other (2 MiB) + target (5 MiB) = 7 MiB, under the cap. Overwriting target with another 5 MiB
    // snapshot must NOT evict the unrelated `other`: only the replacement's bytes are charged. Without
    // the predecessor exclusion the stale 5 MiB target would be double-counted (12 MiB), and the
    // oldest-first eviction would wrongly drop `other` before it freed enough room.
    const twoMiB = "y".repeat(2 * 1024 * 1024);
    const fiveMiB = "z".repeat(5 * 1024 * 1024);
    const other = snapshot({ relativePath: "src/other.ts", content: twoMiB, updatedAt: 5_000 });
    const target = snapshot({ relativePath: "src/target.ts", content: fiveMiB, updatedAt: 5_001 });
    await writeEditorHotExitSnapshot(other);
    await writeEditorHotExitSnapshot(target);
    const replacement = snapshot({
      relativePath: "src/target.ts",
      content: fiveMiB,
      updatedAt: 5_002,
    });
    await writeEditorHotExitSnapshot(replacement);

    await expect(readEditorHotExitSnapshot("/repo", "src/other.ts", 5_003)).resolves.toEqual(other);
    await expect(readEditorHotExitSnapshot("/repo", "src/target.ts", 5_003)).resolves.toEqual(
      replacement,
    );
  });
});
