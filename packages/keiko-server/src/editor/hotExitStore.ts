import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  createLocalSecretVault,
  resolveLocalVaultKey,
  type LocalSecretVault,
  type LocalVaultKeychainAccess,
} from "@oscharko-dev/keiko-security/secret-vault";
import { SecretboxError } from "@oscharko-dev/keiko-security/errors";
import {
  EDITOR_HOT_EXIT_TTL_MS,
  type EditorDocumentVersion,
  type EditorHotExitSnapshotV1,
} from "@oscharko-dev/keiko-contracts";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

const HOT_EXIT_SUBDIR = "editor-hot-exit";
const HOT_EXIT_STORE_FILE = "snapshots.vault";
const HOT_EXIT_KEYFILE = "editor-hot-exit-vault.key";
const HOT_EXIT_KEY_ENV = "KEIKO_EDITOR_HOT_EXIT_KEY";
const HOT_EXIT_KEYCHAIN_SERVICE = "keiko-editor-hot-exit-vault";
const HOT_EXIT_REF_PREFIX = "hot-exit:";
const HOT_EXIT_PAYLOAD_SCHEMA_VERSION = 1;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export interface EditorHotExitStoredSnapshot {
  readonly schemaVersion: typeof HOT_EXIT_PAYLOAD_SCHEMA_VERSION;
  readonly content: string;
  readonly baseVersion: EditorDocumentVersion | null;
  readonly contentHash: string;
  readonly savedContentHash: string | null;
  readonly contentSizeBytes: number;
  readonly updatedAt: number;
  readonly paneId: string;
  readonly windowId: string;
}

export interface EditorHotExitWriteResult {
  readonly snapshotRef: string;
  readonly contentSizeBytes: number;
}

export interface EditorHotExitStore {
  readonly snapshotRefFor: (workspaceRoot: string, relativePath: string) => string;
  readonly write: (snapshot: EditorHotExitSnapshotV1) => EditorHotExitWriteResult;
  readonly read: (snapshotRef: string, nowMs?: number) => EditorHotExitStoredSnapshot | null;
  readonly delete: (snapshotRef: string) => void;
}

export interface CreateEditorHotExitStoreOptions {
  readonly stateDir: string;
  readonly env: EnvSource;
  readonly keychainAccess?: LocalVaultKeychainAccess | undefined;
  // Test/DI seam: supply a pre-built vault (or an instrumented wrapper) instead of resolving the
  // on-disk vault key. Production callers omit this; the vault is memoized on first use as usual.
  readonly vault?: LocalSecretVault | undefined;
}

interface StoredItem {
  readonly ref: string;
  readonly snapshot: EditorHotExitStoredSnapshot;
}

// Non-secret eviction metadata cached in-process so prune() does not have to decrypt every stored
// snapshot on the 400ms keystroke-flush hot path. Only size + timestamp (both non-secret and already
// surfaced in write results) are cached; snapshot content stays AES-GCM sealed at rest and is never
// materialized here.
interface HotExitMeta {
  readonly contentSizeBytes: number;
  readonly updatedAt: number;
}

function contentSizeBytes(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function snapshotRefFor(workspaceRoot: string, relativePath: string): string {
  const locatorHash = createHash("sha256")
    .update(workspaceRoot)
    .update("\0")
    .update(relativePath)
    .digest("hex");
  return `${HOT_EXIT_REF_PREFIX}${locatorHash}`;
}

function isSnapshotRef(value: string): boolean {
  return new RegExp(`^${HOT_EXIT_REF_PREFIX}[a-f0-9]{64}$`, "u").test(value);
}

function hotExitVault(options: CreateEditorHotExitStoreOptions): LocalSecretVault {
  const vaultDir = join(options.stateDir, HOT_EXIT_SUBDIR);
  const { key } = resolveLocalVaultKey({
    env: options.env,
    vaultDir,
    envVarName: HOT_EXIT_KEY_ENV,
    keychainService: HOT_EXIT_KEYCHAIN_SERVICE,
    keyfileName: HOT_EXIT_KEYFILE,
    ...(options.keychainAccess !== undefined ? { keychainAccess: options.keychainAccess } : {}),
  });
  return createLocalSecretVault({ key, storePath: join(vaultDir, HOT_EXIT_STORE_FILE) });
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// eslint-disable-next-line complexity -- runtime schema guard deliberately checks every persisted snapshot field.
function isStoredSnapshot(value: unknown): value is EditorHotExitStoredSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === HOT_EXIT_PAYLOAD_SCHEMA_VERSION &&
    typeof record.content === "string" &&
    (record.baseVersion === null || typeof record.baseVersion === "object") &&
    typeof record.contentHash === "string" &&
    (record.savedContentHash === null || typeof record.savedContentHash === "string") &&
    isNonNegativeNumber(record.contentSizeBytes) &&
    isNonNegativeNumber(record.updatedAt) &&
    typeof record.paneId === "string" &&
    record.paneId.length > 0 &&
    typeof record.windowId === "string" &&
    record.windowId.length > 0
  );
}

function parseStoredSnapshot(raw: string | undefined): EditorHotExitStoredSnapshot | null {
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readStoredSnapshot(
  vault: LocalSecretVault,
  ref: string,
): EditorHotExitStoredSnapshot | null {
  let raw: string | undefined;
  try {
    raw = vault.get(ref);
  } catch (error) {
    if (error instanceof SecretboxError) {
      vault.delete(ref);
      return null;
    }
    throw error;
  }
  const snapshot = parseStoredSnapshot(raw);
  if (raw !== undefined && snapshot === null) {
    vault.delete(ref);
  }
  return snapshot;
}

function expired(snapshot: EditorHotExitStoredSnapshot, nowMs: number): boolean {
  return snapshot.updatedAt + EDITOR_HOT_EXIT_TTL_MS < nowMs;
}

function payloadFor(snapshot: EditorHotExitSnapshotV1): EditorHotExitStoredSnapshot {
  return {
    schemaVersion: HOT_EXIT_PAYLOAD_SCHEMA_VERSION,
    content: snapshot.content,
    baseVersion: snapshot.baseVersion,
    contentHash: snapshot.contentHash,
    savedContentHash: snapshot.savedContentHash,
    contentSizeBytes: contentSizeBytes(snapshot.content),
    updatedAt: snapshot.updatedAt,
    paneId: snapshot.paneId,
    windowId: snapshot.windowId,
  };
}

function listHotExitItems(vault: LocalSecretVault): readonly StoredItem[] {
  const out: StoredItem[] = [];
  for (const ref of vault.list()) {
    if (!isSnapshotRef(ref)) continue;
    const snapshot = readStoredSnapshot(vault, ref);
    if (snapshot !== null) out.push({ ref, snapshot });
  }
  return out;
}

// eslint-disable-next-line max-lines-per-function -- factory closes over the private vault + metaIndex state that getVault/getMetaIndex/prune and the returned write/read/list/delete methods must all share; extracting them would either leak that mutable state or force it through parameters, so the closure is kept whole.
export function createEditorHotExitStore(
  options: CreateEditorHotExitStoreOptions,
): EditorHotExitStore {
  let vault: LocalSecretVault | undefined;
  // Lazily built once on cold start (one decrypt pass), then maintained purely on write/delete so no
  // subsequent prune decrypts anything. Keyed by ref -> {contentSizeBytes, updatedAt}.
  let metaIndex: Map<string, HotExitMeta> | undefined;

  const getVault = (): LocalSecretVault => {
    vault ??= options.vault ?? hotExitVault(options);
    return vault;
  };

  const getMetaIndex = (activeVault: LocalSecretVault): Map<string, HotExitMeta> => {
    if (metaIndex === undefined) {
      metaIndex = new Map<string, HotExitMeta>();
      // Cold-start build: decrypt each stored snapshot exactly once to seed non-secret metadata.
      // Corrupt/undecodable snapshots are dropped by readStoredSnapshot and simply omitted here.
      for (const item of listHotExitItems(activeVault)) {
        metaIndex.set(item.ref, {
          contentSizeBytes: item.snapshot.contentSizeBytes,
          updatedAt: item.snapshot.updatedAt,
        });
      }
    }
    return metaIndex;
  };

  // Evict expired entries and (if still over budget) the oldest retained entries, all from the
  // in-memory metadata index — never decrypting snapshot content on the write hot path.
  const prune = (activeVault: LocalSecretVault, nowMs: number, incomingRef: string): void => {
    const index = getMetaIndex(activeVault);
    const retained: { ref: string; meta: HotExitMeta }[] = [];
    for (const [ref, meta] of index) {
      if (meta.updatedAt + EDITOR_HOT_EXIT_TTL_MS < nowMs) {
        activeVault.delete(ref);
        index.delete(ref);
      } else if (ref !== incomingRef) {
        retained.push({ ref, meta });
      }
    }
    const incomingSize = index.get(incomingRef)?.contentSizeBytes ?? 0;
    let total = incomingSize + retained.reduce((sum, item) => sum + item.meta.contentSizeBytes, 0);
    if (total <= MAX_TOTAL_BYTES) return;
    for (const item of retained.sort((left, right) => left.meta.updatedAt - right.meta.updatedAt)) {
      if (total <= MAX_TOTAL_BYTES) break;
      activeVault.delete(item.ref);
      index.delete(item.ref);
      total -= item.meta.contentSizeBytes;
    }
  };

  return {
    snapshotRefFor,
    write(snapshot): EditorHotExitWriteResult {
      const ref = snapshotRefFor(snapshot.workspaceRoot, snapshot.relativePath);
      const payload = payloadFor(snapshot);
      const activeVault = getVault();
      const index = getMetaIndex(activeVault);
      // Record the incoming entry's non-secret metadata BEFORE prune so the budget math sees it.
      index.set(ref, {
        contentSizeBytes: payload.contentSizeBytes,
        updatedAt: payload.updatedAt,
      });
      prune(activeVault, snapshot.updatedAt, ref);
      // prune may have evicted the incoming ref if it alone exceeds the budget; only persist and keep
      // the metadata entry when it survived pruning.
      if (index.has(ref)) {
        activeVault.set(ref, JSON.stringify(payload));
      }
      return { snapshotRef: ref, contentSizeBytes: payload.contentSizeBytes };
    },
    read(snapshotRef, nowMs = Date.now()): EditorHotExitStoredSnapshot | null {
      if (!isSnapshotRef(snapshotRef)) return null;
      const activeVault = getVault();
      const snapshot = readStoredSnapshot(activeVault, snapshotRef);
      if (snapshot === null) {
        metaIndex?.delete(snapshotRef);
        return null;
      }
      if (expired(snapshot, nowMs)) {
        activeVault.delete(snapshotRef);
        metaIndex?.delete(snapshotRef);
        return null;
      }
      // Keep the metadata index consistent with what was actually observed on disk.
      metaIndex?.set(snapshotRef, {
        contentSizeBytes: snapshot.contentSizeBytes,
        updatedAt: snapshot.updatedAt,
      });
      return snapshot;
    },
    delete(snapshotRef): void {
      if (!isSnapshotRef(snapshotRef)) return;
      getVault().delete(snapshotRef);
      metaIndex?.delete(snapshotRef);
    },
  };
}
