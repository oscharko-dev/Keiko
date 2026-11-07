// Current capsule `updatedAt` stamps for the chat-message index-lifecycle projection.
//
// `GET /api/chats/messages` is polled every second or two while a buffered turn runs, and each
// answer that carries an index lifecycle must be compared with the capsule's current `updatedAt`.
// Opening the encrypted Local Knowledge store for that (migration check, content-encryption
// reconciliation, key resolution) on every poll is work no poll needs: the stamps only change when
// the store file changes. The stamps are therefore remembered per store file together with a
// change token taken from the database, write-ahead-log and shared-memory files. The store is
// opened when the token moved, when a requested capsule has not been read yet, or when the memo is
// older than `CAPSULE_STAMP_MEMO_MAX_AGE_MS`; the age bound also covers a write the token cannot
// show (same size and timestamp). The token is taken BEFORE the open and again after the close: a
// read is remembered only when both agree, so a write that landed during the read is never
// mistaken for the state that was read.

import { statSync } from "node:fs";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { getCapsule, type KnowledgeStore } from "@oscharko-dev/keiko-local-knowledge";
import type { CapsuleUpdatedAtLookup } from "./local-knowledge-index-lifecycle.js";

/** Why a lookup was answered the way it was; a closed word for the Activity Log. */
export type CapsuleStampMemoOutcome = "hit" | "reread-token" | "reread-age" | "reread-missing";

/** The longest a remembered stamp is trusted without looking at the store again. */
export const CAPSULE_STAMP_MEMO_MAX_AGE_MS = 10_000;

interface CapsuleStampMemo {
  readonly token: string;
  readonly at: number;
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
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map(fileToken).join("|");
}

export interface CapsuleStampSource {
  readonly dbPath: string;
  /** Opens the store; called only when the remembered stamps cannot answer. */
  readonly open: () => { readonly store: KnowledgeStore; readonly close: () => void };
  readonly now?: (() => number) | undefined;
}

export interface CapsuleStampLookup {
  readonly lookup: CapsuleUpdatedAtLookup;
  readonly outcome: CapsuleStampMemoOutcome;
}

function memoOutcome(
  remembered: CapsuleStampMemo | undefined,
  token: string,
  now: number,
  capsuleIds: readonly KnowledgeCapsuleId[],
): CapsuleStampMemoOutcome {
  if (remembered === undefined || !capsuleIds.every((id) => remembered.stamps.has(String(id))))
    return "reread-missing";
  if (remembered.token !== token) return "reread-token";
  return now - remembered.at >= CAPSULE_STAMP_MEMO_MAX_AGE_MS ? "reread-age" : "hit";
}

/** Earlier stamps stay valid only for a memo that is unchanged, young, and merely incomplete. */
function reusableStamps(
  remembered: CapsuleStampMemo | undefined,
  outcome: CapsuleStampMemoOutcome,
  token: string,
  now: number,
): ReadonlyMap<string, number | undefined> | undefined {
  if (remembered === undefined || outcome !== "reread-missing") return undefined;
  return remembered.token === token && now - remembered.at < CAPSULE_STAMP_MEMO_MAX_AGE_MS
    ? remembered.stamps
    : undefined;
}

/**
 * Returns a lookup over the requested capsule ids. The store is opened at most once per call and
 * not at all while the store file is unchanged, every requested id was already read and the memo is
 * younger than its age bound.
 */
export function currentCapsuleStampLookup(
  source: CapsuleStampSource,
  capsuleIds: readonly KnowledgeCapsuleId[],
): CapsuleStampLookup {
  const now = (source.now ?? Date.now)();
  const before = storeChangeToken(source.dbPath);
  const remembered = memos.get(source.dbPath);
  const outcome = memoOutcome(remembered, before, now, capsuleIds);
  if (remembered !== undefined && outcome === "hit") {
    return { outcome, lookup: (id): number | undefined => remembered.stamps.get(String(id)) };
  }
  const stamps = new Map<string, number | undefined>(
    reusableStamps(remembered, outcome, before, now),
  );
  const env = source.open();
  try {
    for (const id of capsuleIds) stamps.set(String(id), getCapsule(env.store, id)?.updatedAt);
  } finally {
    env.close();
  }
  if (storeChangeToken(source.dbPath) === before) {
    memos.set(source.dbPath, { token: before, at: now, stamps });
  } else {
    memos.delete(source.dbPath);
  }
  return { outcome, lookup: (id): number | undefined => stamps.get(String(id)) };
}

export function resetCapsuleStampMemoForTest(): void {
  memos.clear();
}
