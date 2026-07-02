import {
  EDITOR_HOT_EXIT_INDEX_SCHEMA_VERSION,
  EDITOR_HOT_EXIT_SCHEMA_VERSION,
  EDITOR_HOT_EXIT_TTL_MS,
  isEditorHotExitIndexRecordV2,
  type EditorHotExitIndexRecordV2,
  type EditorHotExitSnapshotV1,
} from "@oscharko-dev/keiko-contracts";
import {
  deleteEditorHotExitContent,
  readEditorHotExitContent,
  writeEditorHotExitContent,
} from "../../../../../lib/api";

const DB_NAME = "keiko-editor-hot-exit";
const DB_VERSION = 2;
const STORE_NAME = "snapshots";
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const PRUNE_MIN_INTERVAL_MS = 30_000;
const PRUNE_BYTE_BUDGET = 1 * 1024 * 1024;
const SNAPSHOT_ENCODER = new TextEncoder();

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
  });
}

let cachedIndexedDb: IDBFactory | undefined;
let cachedDb: IDBDatabase | null = null;
let cachedDbPromise: Promise<IDBDatabase | null> | null = null;
let lastPruneAt = 0;
let bytesSinceLastPrune = 0;
let forceNextPrune = false;

function resetCachedDb(): void {
  const db = cachedDb;
  cachedDb = null;
  cachedDbPromise = null;
  cachedIndexedDb = undefined;
  lastPruneAt = 0;
  bytesSinceLastPrune = 0;
  forceNextPrune = false;
  try {
    db?.close();
  } catch {
    // closing a stale or already-closed IDB connection is best-effort cleanup
  }
}

async function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    resetCachedDb();
    return null;
  }
  if (cachedIndexedDb !== indexedDB) {
    resetCachedDb();
    cachedIndexedDb = indexedDB;
  }
  if (cachedDb !== null) return cachedDb;
  if (cachedDbPromise !== null) return cachedDbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE_NAME)) db.deleteObjectStore(STORE_NAME);
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        if (cachedDb === db) resetCachedDb();
      };
      cachedDb = db;
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
  }).catch(() => null);
  cachedDbPromise = opening;
  const db = await opening;
  if (db === null && cachedDbPromise === opening) cachedDbPromise = null;
  return db;
}

function chargedBytes(record: EditorHotExitIndexRecordV2): number {
  return record.contentSizeBytes;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function locatorHash(root: string, path: string): Promise<string | null> {
  if (globalThis.crypto?.subtle === undefined) return null;
  const bytes = SNAPSHOT_ENCODER.encode(`${root}\u0000${path}`);
  return hex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

function recordExpired(
  record: EditorHotExitIndexRecordV2,
  now: number,
  ttlMs = EDITOR_HOT_EXIT_TTL_MS,
): boolean {
  return record.updatedAt + ttlMs < now;
}

// All writes and deletes are funnelled through one promise chain so a delete dispatched after a
// write runs after it, never concurrently. This closes the discard/in-flight-write race: when an
// explicit Discard deletes a snapshot while the editor's dirty-write effect still has a write in
// flight for the same key, serialization guarantees the delete is the last word and the discarded
// buffer is not resurrected. Reads are not serialized — they never mutate.
let storeMutationQueue: Promise<unknown> = Promise.resolve();

function serializeMutation<T>(op: () => Promise<T>): Promise<T> {
  const run = storeMutationQueue.then(op, op);
  storeMutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function allRecords(db: IDBDatabase): Promise<EditorHotExitIndexRecordV2[]> {
  const tx = db.transaction(STORE_NAME, "readonly");
  const raw = await requestToPromise<unknown[]>(tx.objectStore(STORE_NAME).getAll());
  await txDone(tx);
  return raw.filter(isEditorHotExitIndexRecordV2);
}

async function prune(
  db: IDBDatabase,
  now: number,
  incoming: EditorHotExitIndexRecordV2 | null = null,
): Promise<void> {
  const records = await allRecords(db);
  const expired = records.filter((record) => recordExpired(record, now));
  if (expired.length > 0) {
    const tx = db.transaction(STORE_NAME, "readwrite");
    for (const record of expired) tx.objectStore(STORE_NAME).delete(record.locatorHash);
    await txDone(tx);
  }
  // The caller writes `incoming` immediately after this prune resolves. Its same-key predecessor
  // (if any) is about to be overwritten, so it must not be double-counted, and the new snapshot's
  // own bytes must be reserved against the quota — otherwise the post-write total can exceed the
  // cap by up to one full snapshot.
  const incomingKey = incoming?.locatorHash ?? null;
  const fresh = records
    .filter((record) => !recordExpired(record, now))
    .filter((record) => record.locatorHash !== incomingKey)
    .sort((left, right) => left.updatedAt - right.updatedAt);
  let total =
    (incoming === null ? 0 : chargedBytes(incoming)) +
    fresh.reduce((sum, record) => sum + chargedBytes(record), 0);
  if (total <= MAX_TOTAL_BYTES) return;
  const tx = db.transaction(STORE_NAME, "readwrite");
  for (const record of fresh) {
    if (total <= MAX_TOTAL_BYTES) break;
    tx.objectStore(STORE_NAME).delete(record.locatorHash);
    total -= chargedBytes(record);
  }
  await txDone(tx);
}

function shouldPrune(now: number, incomingBytes: number): boolean {
  return (
    forceNextPrune ||
    lastPruneAt === 0 ||
    now - lastPruneAt >= PRUNE_MIN_INTERVAL_MS ||
    bytesSinceLastPrune + incomingBytes >= PRUNE_BYTE_BUDGET ||
    incomingBytes >= PRUNE_BYTE_BUDGET
  );
}

async function pruneIfNeeded(db: IDBDatabase, record: EditorHotExitIndexRecordV2): Promise<void> {
  const incomingBytes = chargedBytes(record);
  if (!shouldPrune(record.updatedAt, incomingBytes)) {
    bytesSinceLastPrune += incomingBytes;
    return;
  }
  await prune(db, record.updatedAt, record);
  lastPruneAt = record.updatedAt;
  bytesSinceLastPrune = 0;
  forceNextPrune = incomingBytes >= MAX_TOTAL_BYTES;
}

export async function readEditorHotExitSnapshot(
  workspaceRoot: string,
  relativePath: string,
  now = Date.now(),
): Promise<EditorHotExitSnapshotV1 | null> {
  const hash = await locatorHash(workspaceRoot, relativePath);
  if (hash === null) return null;
  const db = await openDb();
  if (db === null) return null;
  const tx = db.transaction(STORE_NAME, "readonly");
  const raw = await requestToPromise<unknown>(tx.objectStore(STORE_NAME).get(hash));
  await txDone(tx);
  if (!isEditorHotExitIndexRecordV2(raw)) return null;
  if (recordExpired(raw, now)) {
    await deleteEditorHotExitSnapshot(workspaceRoot, relativePath);
    return null;
  }
  const response = await readEditorHotExitContent({
    workspaceRoot,
    relativePath,
    snapshotRef: raw.snapshotRef,
  });
  if (!response.found || response.snapshot === undefined) {
    await deleteEditorHotExitSnapshot(workspaceRoot, relativePath);
    return null;
  }
  return {
    schemaVersion: EDITOR_HOT_EXIT_SCHEMA_VERSION,
    workspaceRoot,
    relativePath,
    content: response.snapshot.content,
    baseVersion: response.snapshot.baseVersion,
    contentHash: response.snapshot.contentHash,
    savedContentHash: response.snapshot.savedContentHash,
    updatedAt: response.snapshot.updatedAt,
    paneId: response.snapshot.paneId,
    windowId: response.snapshot.windowId,
  };
}

export async function writeEditorHotExitSnapshot(snapshot: EditorHotExitSnapshotV1): Promise<void> {
  if (snapshot.schemaVersion !== EDITOR_HOT_EXIT_SCHEMA_VERSION) return;
  const hash = await locatorHash(snapshot.workspaceRoot, snapshot.relativePath);
  if (hash === null) return;
  return serializeMutation(async () => {
    const db = await openDb();
    if (db === null) return;
    const stored = await writeEditorHotExitContent(snapshot);
    if (stored.suppressed === true) {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(hash);
      await txDone(tx);
      forceNextPrune = true;
      return;
    }
    const record: EditorHotExitIndexRecordV2 = {
      schemaVersion: EDITOR_HOT_EXIT_INDEX_SCHEMA_VERSION,
      locatorHash: hash,
      snapshotRef: stored.snapshotRef,
      baseVersion: snapshot.baseVersion,
      contentHash: snapshot.contentHash,
      savedContentHash: snapshot.savedContentHash,
      contentSizeBytes: stored.contentSizeBytes,
      updatedAt: snapshot.updatedAt,
      paneId: snapshot.paneId,
      windowId: snapshot.windowId,
    };
    await pruneIfNeeded(db, record);
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record, hash);
    await txDone(tx);
  });
}

export async function deleteEditorHotExitSnapshot(
  workspaceRoot: string,
  relativePath: string,
): Promise<void> {
  const hash = await locatorHash(workspaceRoot, relativePath);
  if (hash === null) return;
  return serializeMutation(async () => {
    const db = await openDb();
    if (db === null) return;
    const readTx = db.transaction(STORE_NAME, "readonly");
    const raw = await requestToPromise<unknown>(readTx.objectStore(STORE_NAME).get(hash));
    await txDone(readTx);
    if (isEditorHotExitIndexRecordV2(raw)) {
      await deleteEditorHotExitContent({
        workspaceRoot,
        relativePath,
        snapshotRef: raw.snapshotRef,
      });
    }
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(hash);
    await txDone(tx);
  });
}

export { EDITOR_HOT_EXIT_TTL_MS };
