import {
  EDITOR_HOT_EXIT_SCHEMA_VERSION,
  EDITOR_HOT_EXIT_TTL_MS,
  editorHotExitSnapshotExpired,
  isEditorHotExitSnapshotV1,
  type EditorHotExitSnapshotV1,
} from "@oscharko-dev/keiko-contracts";

const DB_NAME = "keiko-editor-hot-exit";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

function key(root: string, path: string): string {
  return `${root}\u0000${path}`;
}

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

async function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
  }).catch(() => null);
}

function snapshotBytes(snapshot: EditorHotExitSnapshotV1): number {
  return new TextEncoder().encode(JSON.stringify(snapshot)).length;
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

async function allSnapshots(db: IDBDatabase): Promise<EditorHotExitSnapshotV1[]> {
  const tx = db.transaction(STORE_NAME, "readonly");
  const raw = await requestToPromise<unknown[]>(tx.objectStore(STORE_NAME).getAll());
  await txDone(tx);
  return raw.filter(isEditorHotExitSnapshotV1);
}

async function prune(
  db: IDBDatabase,
  now: number,
  incoming: EditorHotExitSnapshotV1 | null = null,
): Promise<void> {
  const snapshots = await allSnapshots(db);
  const expired = snapshots.filter((snapshot) => editorHotExitSnapshotExpired(snapshot, now));
  if (expired.length > 0) {
    const tx = db.transaction(STORE_NAME, "readwrite");
    for (const snapshot of expired)
      tx.objectStore(STORE_NAME).delete(key(snapshot.workspaceRoot, snapshot.relativePath));
    await txDone(tx);
  }
  // The caller writes `incoming` immediately after this prune resolves. Its same-key predecessor
  // (if any) is about to be overwritten, so it must not be double-counted, and the new snapshot's
  // own bytes must be reserved against the quota — otherwise the post-write total can exceed the
  // cap by up to one full snapshot.
  const incomingKey = incoming === null ? null : key(incoming.workspaceRoot, incoming.relativePath);
  const fresh = snapshots
    .filter((snapshot) => !editorHotExitSnapshotExpired(snapshot, now))
    .filter((snapshot) => key(snapshot.workspaceRoot, snapshot.relativePath) !== incomingKey)
    .sort((left, right) => left.updatedAt - right.updatedAt);
  let total =
    (incoming === null ? 0 : snapshotBytes(incoming)) +
    fresh.reduce((sum, snapshot) => sum + snapshotBytes(snapshot), 0);
  if (total <= MAX_TOTAL_BYTES) return;
  const tx = db.transaction(STORE_NAME, "readwrite");
  for (const snapshot of fresh) {
    if (total <= MAX_TOTAL_BYTES) break;
    tx.objectStore(STORE_NAME).delete(key(snapshot.workspaceRoot, snapshot.relativePath));
    total -= snapshotBytes(snapshot);
  }
  await txDone(tx);
}

export async function readEditorHotExitSnapshot(
  workspaceRoot: string,
  relativePath: string,
  now = Date.now(),
): Promise<EditorHotExitSnapshotV1 | null> {
  const db = await openDb();
  if (db === null) return null;
  try {
    const tx = db.transaction(STORE_NAME, "readonly");
    const raw = await requestToPromise<unknown>(
      tx.objectStore(STORE_NAME).get(key(workspaceRoot, relativePath)),
    );
    await txDone(tx);
    if (!isEditorHotExitSnapshotV1(raw) || editorHotExitSnapshotExpired(raw, now)) return null;
    return raw;
  } finally {
    db.close();
  }
}

export async function writeEditorHotExitSnapshot(snapshot: EditorHotExitSnapshotV1): Promise<void> {
  if (snapshot.schemaVersion !== EDITOR_HOT_EXIT_SCHEMA_VERSION) return;
  return serializeMutation(async () => {
    const db = await openDb();
    if (db === null) return;
    try {
      await prune(db, snapshot.updatedAt, snapshot);
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(snapshot, key(snapshot.workspaceRoot, snapshot.relativePath));
      await txDone(tx);
    } finally {
      db.close();
    }
  });
}

export async function deleteEditorHotExitSnapshot(
  workspaceRoot: string,
  relativePath: string,
): Promise<void> {
  return serializeMutation(async () => {
    const db = await openDb();
    if (db === null) return;
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key(workspaceRoot, relativePath));
      await txDone(tx);
    } finally {
      db.close();
    }
  });
}

export { EDITOR_HOT_EXIT_TTL_MS };
