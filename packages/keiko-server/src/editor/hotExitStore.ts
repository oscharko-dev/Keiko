import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  createLocalSecretVault,
  resolveLocalVaultKey,
  type LocalSecretVault,
  type LocalVaultKeychainAccess,
} from "@oscharko-dev/keiko-security/secret-vault";
import { SecretboxError } from "@oscharko-dev/keiko-security/errors";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import type {
  EditorDocumentVersion,
  EditorHotExitSnapshotV1,
  EditorHotExitWriteStoredResponse,
} from "@oscharko-dev/keiko-contracts";
import { EDITOR_HOT_EXIT_TTL_MS } from "@oscharko-dev/keiko-contracts/runtime/editor-hot-exit";
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
  // Server receipt clock (Date.now() at the moment write() accepted this entry), persisted
  // alongside the snapshot so the TTL basis survives a restart -- see ttlBasisFor. Optional and
  // backward-compatible: a record persisted before this field existed simply omits it, and reads
  // fall back to the legacy client-`updatedAt` TTL basis for that record only (r8).
  readonly serverReceivedAt?: number;
  readonly paneId: string;
  readonly windowId: string;
}

export type EditorHotExitWriteResult = EditorHotExitWriteStoredResponse;

export interface EditorHotExitStore {
  readonly snapshotRefFor: (workspaceRoot: string, relativePath: string) => string;
  readonly write: (
    snapshot: EditorHotExitSnapshotV1,
    snapshotRef: string,
  ) => EditorHotExitWriteResult;
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
  // Test/DI seam for the server's own receipt clock (mirrors how read() already takes an optional
  // `nowMs`): write() samples this for EVERY receipt timestamp it records (the entry's own
  // serverReceivedAt and the `nowMs` it hands to prune()), instead of calling Date.now() directly.
  // Production callers omit this; the default preserves the pre-existing Date.now() behaviour.
  // Tests can inject a fixed function to drive deterministic receipt timestamps instead of
  // deriving fixtures from the real wall clock and separately hoping write()'s own Date.now()
  // sample lands close enough to match -- two independent real-clock reads that are never
  // actually synchronized (AGENTS.md hermetic-tests rule).
  readonly receiptClock?: (() => number) | undefined;
  // Optional activity-log seam (ADR-0019); the deps.ts composition root supplies
  // `processServerLogSink()`.
  readonly securityLogSink?: SecurityLogSink | undefined;
}

interface StoredItem {
  readonly ref: string;
  readonly snapshot: EditorHotExitStoredSnapshot;
}

// Non-secret eviction metadata cached in-process so prune() does not have to decrypt every stored
// snapshot on the 400ms keystroke-flush hot path. Only size + timestamp (both non-secret and already
// surfaced in write results) are cached; snapshot content stays AES-GCM sealed at rest and is never
// materialized here.
//
// `updatedAt` here is the TTL-basis timestamp, and it is deliberately NOT the persisted snapshot's
// contract `updatedAt` (which is client-supplied and untrusted for clock purposes). write() stamps
// it with the server's own receipt clock (Date.now() by default, or the injected receiptClock
// test/DI seam -- see CreateEditorHotExitStoreOptions.receiptClock) at the moment the entry is
// accepted, so a
// client clock that is arbitrarily far behind (or ahead of) the server can never make write()'s own
// prune, a later write's prune, or read()'s TTL check treat a just-persisted entry as expired. A
// side effect is that prune's oldest-first eviction ordering becomes server-arrival order rather
// than client-claimed order -- strictly more robust against a hostile or skewed client. On cold
// start (a fresh process, e.g. after a Keiko restart), entries seeded from disk (see getMetaIndex
// below) use the server-receipt timestamp persisted alongside the snapshot itself
// (EditorHotExitStoredSnapshot.serverReceivedAt, r8) rather than the client-supplied updatedAt, so
// the trusted TTL basis survives the restart. Only a record written before that field existed
// falls back to the legacy client updatedAt.
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
    sink: options.securityLogSink,
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
    (record.serverReceivedAt === undefined || isNonNegativeNumber(record.serverReceivedAt)) &&
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

// TTL expiry is always evaluated against a TTL-basis timestamp, never the persisted snapshot's
// own (client-supplied) `updatedAt` -- see the HotExitMeta.updatedAt comment for why.
function expired(ttlBasisUpdatedAt: number, nowMs: number): boolean {
  return ttlBasisUpdatedAt + EDITOR_HOT_EXIT_TTL_MS < nowMs;
}

// Resolves the TTL-basis timestamp for a ref being read, in order of trust: the warm index's
// server-receipt clock (this process already saw a write() for this ref); else the persisted
// server-receipt timestamp (a prior process's write() -- survives a restart, r8); else the
// persisted (client-supplied, untrusted) updatedAt as the last-resort legacy fallback for a
// record that predates the serverReceivedAt field.
function ttlBasisFor(
  meta: HotExitMeta | undefined,
  persistedServerReceivedAt: number | undefined,
  legacyFallbackUpdatedAt: number,
): number {
  return meta?.updatedAt ?? persistedServerReceivedAt ?? legacyFallbackUpdatedAt;
}

function payloadFor(
  snapshot: EditorHotExitSnapshotV1,
  serverReceivedAt: number,
): EditorHotExitStoredSnapshot {
  return {
    schemaVersion: HOT_EXIT_PAYLOAD_SCHEMA_VERSION,
    content: snapshot.content,
    baseVersion: snapshot.baseVersion,
    contentHash: snapshot.contentHash,
    savedContentHash: snapshot.savedContentHash,
    contentSizeBytes: contentSizeBytes(snapshot.content),
    updatedAt: snapshot.updatedAt,
    serverReceivedAt,
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
  const receiptClock = options.receiptClock ?? Date.now;

  const getVault = (): LocalSecretVault => {
    vault ??= options.vault ?? hotExitVault(options);
    return vault;
  };

  const getMetaIndex = (activeVault: LocalSecretVault): Map<string, HotExitMeta> => {
    if (metaIndex === undefined) {
      metaIndex = new Map<string, HotExitMeta>();
      // Cold-start build: decrypt each stored snapshot exactly once to seed non-secret metadata.
      // Corrupt/undecodable snapshots are dropped by readStoredSnapshot and simply omitted here.
      // Prefer the persisted server-receipt clock (r8) over the client-supplied updatedAt so a
      // restart's cold-start build carries the same trusted TTL basis a warm write would have.
      for (const item of listHotExitItems(activeVault)) {
        metaIndex.set(item.ref, {
          contentSizeBytes: item.snapshot.contentSizeBytes,
          updatedAt: item.snapshot.serverReceivedAt ?? item.snapshot.updatedAt,
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
      // The incoming ref is exempt from this TTL-expiry loop: its meta.updatedAt is the server's
      // own receipt clock (see write(), r6), so it can never independently expire against the
      // same nowMs anyway -- this skip exists so it stays out of `retained` (and thus out of the
      // oldest-first budget-eviction sort below) and is instead subject to byte-budget accounting
      // via `incomingSize`, exactly as before.
      if (ref === incomingRef) continue;
      if (meta.updatedAt + EDITOR_HOT_EXIT_TTL_MS < nowMs) {
        activeVault.delete(ref);
        index.delete(ref);
      } else {
        retained.push({ ref, meta });
      }
    }
    const incomingSize = index.get(incomingRef)?.contentSizeBytes ?? 0;
    let total = incomingSize + retained.reduce((sum, item) => sum + item.meta.contentSizeBytes, 0);
    if (total <= MAX_TOTAL_BYTES) return;
    retained.sort((left, right) => left.meta.updatedAt - right.meta.updatedAt);
    for (const item of retained) {
      if (total <= MAX_TOTAL_BYTES) break;
      activeVault.delete(item.ref);
      index.delete(item.ref);
      total -= item.meta.contentSizeBytes;
    }
  };

  return {
    snapshotRefFor,
    write(snapshot, ref): EditorHotExitWriteResult {
      const activeVault = getVault();
      const index = getMetaIndex(activeVault);
      // Use the server's own receipt clock -- never the untrusted client-supplied
      // snapshot.updatedAt -- both as the TTL basis recorded for this entry and as "now" for
      // deciding whether OTHER entries in the shared store have expired (matching read()'s
      // Date.now() default). A single anomalous client timestamp (far-future OR far-behind) can
      // then neither evict every other cached snapshot process-wide nor make this entry look
      // already expired to the very next read() or prune() (r6; see HotExitMeta.updatedAt).
      // Persisted into the stored payload itself (serverReceivedAt) so this same trusted basis
      // survives a process restart, not just this process's in-memory index (r8).
      // Sampled once via the injected/default receiptClock seam (never Date.now() directly) so
      // every receipt timestamp this call produces -- the persisted serverReceivedAt AND the
      // `nowMs` handed to prune() below -- comes from the exact same source a test can pin.
      const receivedAt = receiptClock();
      const payload = payloadFor(snapshot, receivedAt);
      // Record the incoming entry's non-secret metadata BEFORE prune so the budget math sees it.
      index.set(ref, {
        contentSizeBytes: payload.contentSizeBytes,
        updatedAt: receivedAt,
      });
      prune(activeVault, receivedAt, ref);
      // prune may have evicted the incoming ref if it alone exceeds the budget; only persist and keep
      // the metadata entry when it survived pruning.
      if (index.has(ref)) {
        activeVault.set(ref, JSON.stringify(payload));
      }
      return {
        snapshotRef: ref,
        contentSizeBytes: payload.contentSizeBytes,
        serverReceivedAt: receivedAt,
      };
    },
    read(snapshotRef, nowMs = Date.now()): EditorHotExitStoredSnapshot | null {
      if (!isSnapshotRef(snapshotRef)) return null;
      const activeVault = getVault();
      const snapshot = readStoredSnapshot(activeVault, snapshotRef);
      if (snapshot === null) {
        metaIndex?.delete(snapshotRef);
        return null;
      }
      // TTL basis: prefer the (already-warm) index's server-receipt timestamp -- set by a write()
      // earlier in this process, per r6. Deliberately uses the optional index rather than forcing
      // a cold-start build here, so a read() that happens to be the first call in a fresh process
      // still costs exactly one decrypt (of this ref only), matching the pre-existing hot-path
      // budget. A ref never touched by write() in this process (true cold read, e.g. the first
      // read after a restart) falls back to the persisted server-receipt timestamp written
      // alongside the snapshot, which survives the restart even though the in-memory index does
      // not (r8); only a record persisted before that field existed falls all the way back to the
      // legacy, client-supplied updatedAt.
      const ttlBasisUpdatedAt = ttlBasisFor(
        metaIndex?.get(snapshotRef),
        snapshot.serverReceivedAt,
        snapshot.updatedAt,
      );
      if (expired(ttlBasisUpdatedAt, nowMs)) {
        activeVault.delete(snapshotRef);
        metaIndex?.delete(snapshotRef);
        return null;
      }
      // Keep the metadata index consistent with what was actually observed on disk, preserving
      // the resolved TTL basis rather than overwriting it with the client-supplied updatedAt.
      metaIndex?.set(snapshotRef, {
        contentSizeBytes: snapshot.contentSizeBytes,
        updatedAt: ttlBasisUpdatedAt,
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
