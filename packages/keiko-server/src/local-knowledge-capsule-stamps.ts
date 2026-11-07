// Current capsule `updatedAt` stamps for the chat-message index-lifecycle projection.
//
// `GET /api/chats/messages` is polled every second or two while a buffered turn runs, and each
// answer that carries an index lifecycle must be compared with the capsule's current `updatedAt`.
// Opening the encrypted Local Knowledge store for that (migration check, content-encryption
// reconciliation, key resolution) on every poll is work no poll needs: the stamps only change when
// the store file changes. The stamps are therefore remembered per store file together with a
// change token taken from the database and write-ahead-log files, and the store is opened only when
// that token moved or a requested capsule has not been read yet. A moved token always re-reads, so
// a capsule update stays visible on the very next poll.

import { statSync } from "node:fs";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { getCapsule, type KnowledgeStore } from "@oscharko-dev/keiko-local-knowledge";
import type { CapsuleUpdatedAtLookup } from "./local-knowledge-index-lifecycle.js";

interface CapsuleStampMemo {
  readonly token: string;
  readonly stamps: Map<string, number | undefined>;
}

const memos = new Map<string, CapsuleStampMemo>();

function fileToken(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeNs)}`;
  } catch {
    return "absent";
  }
}

function storeChangeToken(dbPath: string): string {
  return [dbPath, `${dbPath}-wal`].map(fileToken).join("|");
}

export interface CapsuleStampSource {
  readonly dbPath: string;
  /** Opens the store; called only when the remembered stamps cannot answer. */
  readonly open: () => { readonly store: KnowledgeStore; readonly close: () => void };
}

/**
 * Returns a lookup over the requested capsule ids. The store is opened at most once per call and
 * not at all while the store file is unchanged and every requested id was already read.
 */
export function currentCapsuleStampLookup(
  source: CapsuleStampSource,
  capsuleIds: readonly KnowledgeCapsuleId[],
): CapsuleUpdatedAtLookup {
  const token = storeChangeToken(source.dbPath);
  const remembered = memos.get(source.dbPath);
  const fresh = remembered?.token === token ? remembered : undefined;
  if (fresh !== undefined && capsuleIds.every((id) => fresh.stamps.has(String(id)))) {
    return (id): number | undefined => fresh.stamps.get(String(id));
  }
  const env = source.open();
  const stamps = new Map<string, number | undefined>(fresh?.stamps);
  try {
    for (const id of capsuleIds) stamps.set(String(id), getCapsule(env.store, id)?.updatedAt);
  } finally {
    env.close();
  }
  // Taken after the close: opening may migrate or reseal the file, and closing checkpoints the log.
  memos.set(source.dbPath, { token: storeChangeToken(source.dbPath), stamps });
  return (id): number | undefined => stamps.get(String(id));
}

export function resetCapsuleStampMemoForTest(): void {
  memos.clear();
}
