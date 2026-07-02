import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  createLocalSecretVault,
  resolveLocalVaultKey,
  type LocalSecretVault,
  type LocalVaultKeychainAccess,
} from "@oscharko-dev/keiko-security/secret-vault";
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
}

interface StoredItem {
  readonly ref: string;
  readonly snapshot: EditorHotExitStoredSnapshot;
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
    const snapshot = parseStoredSnapshot(vault.get(ref));
    if (snapshot !== null) out.push({ ref, snapshot });
  }
  return out;
}

function prune(vault: LocalSecretVault, nowMs: number, incoming: StoredItem): void {
  const retained: StoredItem[] = [];
  for (const item of listHotExitItems(vault)) {
    if (expired(item.snapshot, nowMs)) {
      vault.delete(item.ref);
    } else if (item.ref !== incoming.ref) {
      retained.push(item);
    }
  }
  let total =
    incoming.snapshot.contentSizeBytes +
    retained.reduce((sum, item) => sum + item.snapshot.contentSizeBytes, 0);
  if (total <= MAX_TOTAL_BYTES) return;
  for (const item of retained.sort(
    (left, right) => left.snapshot.updatedAt - right.snapshot.updatedAt,
  )) {
    if (total <= MAX_TOTAL_BYTES) break;
    vault.delete(item.ref);
    total -= item.snapshot.contentSizeBytes;
  }
}

export function createEditorHotExitStore(
  options: CreateEditorHotExitStoreOptions,
): EditorHotExitStore {
  let vault: LocalSecretVault | undefined;
  const getVault = (): LocalSecretVault => {
    vault ??= hotExitVault(options);
    return vault;
  };
  return {
    snapshotRefFor,
    write(snapshot): EditorHotExitWriteResult {
      const ref = snapshotRefFor(snapshot.workspaceRoot, snapshot.relativePath);
      const payload = payloadFor(snapshot);
      const activeVault = getVault();
      prune(activeVault, snapshot.updatedAt, { ref, snapshot: payload });
      activeVault.set(ref, JSON.stringify(payload));
      return { snapshotRef: ref, contentSizeBytes: payload.contentSizeBytes };
    },
    read(snapshotRef, nowMs = Date.now()): EditorHotExitStoredSnapshot | null {
      if (!isSnapshotRef(snapshotRef)) return null;
      const activeVault = getVault();
      const snapshot = parseStoredSnapshot(activeVault.get(snapshotRef));
      if (snapshot === null) return null;
      if (expired(snapshot, nowMs)) {
        activeVault.delete(snapshotRef);
        return null;
      }
      return snapshot;
    },
    delete(snapshotRef): void {
      if (!isSnapshotRef(snapshotRef)) return;
      getVault().delete(snapshotRef);
    },
  };
}
