// capsule-set-lifecycle.ts — CapsuleSets are LOGICAL compositions: they hold capsule IDs
// only, never vectors/chunks/documents (Foundry-IQ "no global pool" invariant).
//
// The #265 schema declares `capsule_set_members(set_id, capsule_id, ordinal, composed_at)`
// but does NOT declare a top-level `capsule_sets` table; #265 explicitly defers the set's
// metadata storage to consumers because the contract layer only knows the membership
// relation. We persist the metadata (display name, description, tags) as a single row in
// the existing `schema_meta` key-value table under key `capsule_set:<id>`, with the JSON
// payload `{displayName, description?, tags, composedAt}`. Members live in their declared
// table. Deleting a capsule cascades to the membership row via the FK from #265; this
// module does not need to chase it.

import {
  isSafeDisplaySummary,
  type CapsuleSet,
  type CapsuleSetId,
  type KnowledgeCapsuleId,
} from "@oscharko-dev/keiko-contracts";

import { KnowledgeNotFoundError, KnowledgeStoreError } from "./errors.js";
import type { KnowledgeStore } from "./store.js";

export interface CreateCapsuleSetInput {
  readonly id: CapsuleSetId;
  readonly displayName: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly capsuleIds: readonly KnowledgeCapsuleId[];
}

interface SetMetaPayload {
  readonly displayName: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly composedAt: number;
}

interface MetaRow {
  readonly value: string;
}

interface MemberRow {
  readonly capsule_id: string;
  readonly ordinal: number;
}

const META_PREFIX = "capsule_set:";

function metaKey(id: CapsuleSetId): string {
  return `${META_PREFIX}${String(id)}`;
}

function assertSafeDisplayField(field: string, value: string): void {
  if (value.trim().length === 0 || !isSafeDisplaySummary(value)) {
    throw new KnowledgeStoreError(`${field} must be a browser-safe non-empty string`);
  }
}

function assertSafeOptionalDisplayField(field: string, value: string | undefined): void {
  if (value !== undefined && !isSafeDisplaySummary(value)) {
    throw new KnowledgeStoreError(`${field} must be browser-safe when set`);
  }
}

function parseMeta(value: string, id: CapsuleSetId): SetMetaPayload {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new KnowledgeStoreError(`Corrupt schema_meta payload for ${String(id)}.`);
  }
  const obj = parsed as Record<string, unknown>;
  const displayName = obj.displayName;
  const description = obj.description;
  const tags = obj.tags;
  const composedAt = obj.composedAt;
  if (typeof displayName !== "string") {
    throw new KnowledgeStoreError(`schema_meta payload missing displayName for ${String(id)}.`);
  }
  if (typeof composedAt !== "number") {
    throw new KnowledgeStoreError(`schema_meta payload missing composedAt for ${String(id)}.`);
  }
  return {
    displayName,
    description: typeof description === "string" ? description : null,
    tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [],
    composedAt,
  };
}

function readMembers(store: KnowledgeStore, setId: CapsuleSetId): readonly KnowledgeCapsuleId[] {
  const rows = store._internal.db
    .prepare(
      "SELECT capsule_id, ordinal FROM capsule_set_members WHERE set_id = :s ORDER BY ordinal ASC",
    )
    .all({ s: setId });
  return rows.map((row) => (row as unknown as MemberRow).capsule_id as KnowledgeCapsuleId);
}

function metaToCapsuleSet(
  id: CapsuleSetId,
  payload: SetMetaPayload,
  capsuleIds: readonly KnowledgeCapsuleId[],
): CapsuleSet {
  const base: CapsuleSet = {
    id,
    displayName: payload.displayName,
    tags: payload.tags,
    capsuleIds,
    composedAt: payload.composedAt,
  };
  return payload.description === null ? base : { ...base, description: payload.description };
}

// Inserts the schema_meta row and all member rows WITHOUT bracketing a BEGIN/COMMIT.
// Must be called from within an already-open transaction. Used by createCapsuleSet (which
// wraps it in its own transaction) and by runComposeTransaction (which needs to combine the
// set creation and audit writes in one atomic outer transaction).
export function createCapsuleSetWithinTxn(
  store: KnowledgeStore,
  input: CreateCapsuleSetInput,
  now: number,
): void {
  assertSafeDisplayField("displayName", input.displayName);
  assertSafeOptionalDisplayField("description", input.description);
  for (const tag of input.tags) {
    assertSafeDisplayField("tag", tag);
  }
  const db = store._internal.db;
  const payload: SetMetaPayload = {
    displayName: input.displayName,
    description: input.description ?? null,
    tags: input.tags,
    composedAt: now,
  };
  db.prepare("INSERT INTO schema_meta (key, value) VALUES (:k, :v)").run({
    k: metaKey(input.id),
    v: JSON.stringify(payload),
  });
  const insertMember = db.prepare(
    "INSERT INTO capsule_set_members (set_id, capsule_id, ordinal, composed_at) VALUES (:s, :c, :o, :now)",
  );
  input.capsuleIds.forEach((capsuleId, index) => {
    insertMember.run({ s: input.id, c: capsuleId, o: index, now });
  });
}

export function createCapsuleSet(store: KnowledgeStore, input: CreateCapsuleSetInput): CapsuleSet {
  const db = store._internal.db;
  const now = store._internal.now();
  db.exec("BEGIN");
  try {
    createCapsuleSetWithinTxn(store, input, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    const msg = error instanceof Error ? error.message : String(error);
    if (/UNIQUE|PRIMARY KEY/i.test(msg)) {
      throw new KnowledgeStoreError("capsule set already exists", { cause: error });
    }
    throw new KnowledgeStoreError("failed to create capsule set", { cause: error });
  }
  const fetched = getCapsuleSet(store, input.id);
  if (fetched === undefined) {
    throw new KnowledgeStoreError(
      `createCapsuleSet: insert succeeded but row not found for ${String(input.id)}`,
    );
  }
  return fetched;
}

export function getCapsuleSet(store: KnowledgeStore, id: CapsuleSetId): CapsuleSet | undefined {
  const row = store._internal.db
    .prepare("SELECT value FROM schema_meta WHERE key = :k")
    .get({ k: metaKey(id) });
  if (row === undefined) return undefined;
  const payload = parseMeta((row as unknown as MetaRow).value, id);
  const members = readMembers(store, id);
  return metaToCapsuleSet(id, payload, members);
}

interface KeyValueRow {
  readonly key: string;
  readonly value: string;
}

export function listCapsuleSets(store: KnowledgeStore): readonly CapsuleSet[] {
  // Fetch (key, value) in one query so we avoid a getCapsuleSet re-query per row (N+1).
  // Members still need a per-set query because capsule_set_members is a separate table.
  const rows = store._internal.db
    .prepare("SELECT key, value FROM schema_meta WHERE key LIKE :prefix")
    .all({ prefix: `${META_PREFIX}%` });
  const sets = rows
    .map((row) => {
      const { key, value } = row as unknown as KeyValueRow;
      const id = key.slice(META_PREFIX.length) as CapsuleSetId;
      const payload = parseMeta(value, id);
      const capsuleIds = readMembers(store, id);
      return metaToCapsuleSet(id, payload, capsuleIds);
    });
  return sets.slice().sort((a, b) => a.composedAt - b.composedAt);
}

export function deleteCapsuleSet(store: KnowledgeStore, id: CapsuleSetId): void {
  const db = store._internal.db;
  db.exec("BEGIN");
  try {
    const result = db.prepare("DELETE FROM schema_meta WHERE key = :k").run({ k: metaKey(id) });
    if (Number(result.changes) === 0) {
      db.exec("ROLLBACK");
      throw new KnowledgeNotFoundError(`Capsule set not found: ${String(id)}`);
    }
    db.prepare("DELETE FROM capsule_set_members WHERE set_id = :s").run({ s: id });
    db.exec("COMMIT");
  } catch (error) {
    if (!(error instanceof KnowledgeNotFoundError)) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
}
