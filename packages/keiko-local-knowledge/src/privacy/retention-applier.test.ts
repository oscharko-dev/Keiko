// Tests for applyRetentionToCapsule — the bounded DELETE that prunes capsule rows older
// than the policy window. The cascade isolation test is load-bearing: removing the
// `WHERE capsule_id = :capsule_id` clause from the retention SQL must turn it red so a
// future refactor cannot silently broaden the scope to other capsules.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";

import { createCapsule } from "../capsule-lifecycle.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { freshStore, sampleCapsuleInput, sampleSourceInput } from "../_support.js";
import type { KnowledgeStore } from "../store.js";

import { applyRetentionToCapsule } from "./retention-applier.js";

const DAY_MS = 86_400_000;

interface SeedDocOptions {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: string;
  readonly parsedUnitId: string;
  readonly chunkId: string;
  readonly vectorId: string;
  readonly lastExtractedAt: number;
  readonly vectorCreatedAt: number;
}

function seedDocWithVector(store: KnowledgeStore, opts: SeedDocOptions): void {
  const db = store._internal.db;
  db.prepare(
    "INSERT INTO documents (id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name) VALUES (:id, :c, :s, :p, :sz, :m, :h, :pid, :pv, :le, :st, :sdn)",
  ).run({
    id: opts.documentId,
    c: opts.capsuleId,
    s: opts.sourceId,
    p: `/srv/docs/${opts.documentId}.txt`,
    sz: 100,
    m: "text/plain",
    h: "sha256-abc",
    pid: "text",
    pv: "1.0",
    le: opts.lastExtractedAt,
    st: "ready",
    sdn: `${opts.documentId}.txt`,
  });
  db.prepare(
    "INSERT INTO document_texts (capsule_id, document_id, normalized_text) VALUES (:c, :d, :t)",
  ).run({ c: opts.capsuleId, d: opts.documentId, t: `normalized ${opts.documentId}` });
  db.prepare(
    "INSERT INTO parsed_units (id, capsule_id, document_id, kind) VALUES (:id, :c, :d, :k)",
  ).run({ id: opts.parsedUnitId, c: opts.capsuleId, d: opts.documentId, k: "text" });
  db.prepare(
    "INSERT INTO chunks (id, capsule_id, source_id, document_id, parsed_unit_id, order_index, token_count, safe_excerpt_hash) VALUES (:id, :c, :s, :d, :pu, 0, 100, 'hash')",
  ).run({
    id: opts.chunkId,
    c: opts.capsuleId,
    s: opts.sourceId,
    d: opts.documentId,
    pu: opts.parsedUnitId,
  });
  db.prepare(
    "INSERT INTO vectors (id, capsule_id, source_id, document_id, chunk_id, embedding, embedding_model_provider, embedding_model_id, vector_dimensions, vector_metric, storage_reference, created_at) VALUES (:id, :c, :s, :d, :ch, :e, :ep, :em, :vd, :vm, :sr, :ca)",
  ).run({
    id: opts.vectorId,
    c: opts.capsuleId,
    s: opts.sourceId,
    d: opts.documentId,
    ch: opts.chunkId,
    e: Buffer.from([0, 1, 2, 3]),
    ep: "openai",
    em: "text-embedding-3-small",
    vd: 1536,
    vm: "cosine",
    sr: opts.documentId,
    ca: opts.vectorCreatedAt,
  });
}

function vectorIdsForCapsule(store: KnowledgeStore, capsuleId: KnowledgeCapsuleId): string[] {
  const rows = store._internal.db
    .prepare("SELECT id FROM vectors WHERE capsule_id = :c ORDER BY id ASC")
    .all({ c: capsuleId }) as unknown as readonly { readonly id: string }[];
  return rows.map((r) => r.id);
}

function parsedUnitIdsForCapsule(store: KnowledgeStore, capsuleId: KnowledgeCapsuleId): string[] {
  const rows = store._internal.db
    .prepare("SELECT id FROM parsed_units WHERE capsule_id = :c ORDER BY id ASC")
    .all({ c: capsuleId }) as unknown as readonly { readonly id: string }[];
  return rows.map((r) => r.id);
}

function documentTextIdsForCapsule(store: KnowledgeStore, capsuleId: KnowledgeCapsuleId): string[] {
  const rows = store._internal.db
    .prepare(
      "SELECT document_id FROM document_texts WHERE capsule_id = :c ORDER BY document_id ASC",
    )
    .all({ c: capsuleId }) as unknown as readonly { readonly document_id: string }[];
  return rows.map((r) => r.document_id);
}

describe("applyRetentionToCapsule", () => {
  let env: { readonly store: KnowledgeStore; readonly cleanup: () => void };

  beforeEach(() => {
    env = freshStore();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("deletes vectors older than retainVectorsDays and retains newer ones", () => {
    const now = 30 * DAY_MS;
    const capsuleId = "cap-vec" as KnowledgeCapsuleId;
    createCapsule(env.store, sampleCapsuleInput({ id: capsuleId }));
    const source = sampleSourceInput("src-1");
    addSourceToCapsule(env.store, capsuleId, source);

    seedDocWithVector(env.store, {
      capsuleId,
      sourceId: source.id,
      documentId: "doc-old",
      parsedUnitId: "pu-old",
      chunkId: "ch-old",
      vectorId: "vec-old",
      lastExtractedAt: now - 14 * DAY_MS,
      vectorCreatedAt: now - 14 * DAY_MS,
    });
    seedDocWithVector(env.store, {
      capsuleId,
      sourceId: source.id,
      documentId: "doc-new",
      parsedUnitId: "pu-new",
      chunkId: "ch-new",
      vectorId: "vec-new",
      lastExtractedAt: now - 1 * DAY_MS,
      vectorCreatedAt: now - 1 * DAY_MS,
    });

    const result = applyRetentionToCapsule(env.store, capsuleId, { retainVectorsDays: 7 }, now);

    expect(result.deletedVectorCount).toBe(1);
    expect(result.deletedExtractedTextCount).toBe(0);
    expect(result.appliedAt).toBe(now);
    expect(vectorIdsForCapsule(env.store, capsuleId)).toEqual(["vec-new"]);
  });

  it("is a no-op when both retention fields are undefined", () => {
    const now = 10 * DAY_MS;
    const capsuleId = "cap-noop" as KnowledgeCapsuleId;
    createCapsule(env.store, sampleCapsuleInput({ id: capsuleId }));
    const source = sampleSourceInput("src-1");
    addSourceToCapsule(env.store, capsuleId, source);
    seedDocWithVector(env.store, {
      capsuleId,
      sourceId: source.id,
      documentId: "doc-1",
      parsedUnitId: "pu-1",
      chunkId: "ch-1",
      vectorId: "vec-1",
      lastExtractedAt: now - 365 * DAY_MS,
      vectorCreatedAt: now - 365 * DAY_MS,
    });

    const result = applyRetentionToCapsule(env.store, capsuleId, {}, now);

    expect(result.deletedVectorCount).toBe(0);
    expect(result.deletedExtractedTextCount).toBe(0);
    expect(vectorIdsForCapsule(env.store, capsuleId)).toEqual(["vec-1"]);
    expect(parsedUnitIdsForCapsule(env.store, capsuleId)).toEqual(["pu-1"]);
    expect(documentTextIdsForCapsule(env.store, capsuleId)).toEqual(["doc-1"]);
  });

  it("does not touch rows in other capsules (capsule_id scope clause is load-bearing)", () => {
    const now = 30 * DAY_MS;
    const targetId = "cap-target" as KnowledgeCapsuleId;
    const neighbourId = "cap-neighbour" as KnowledgeCapsuleId;
    createCapsule(env.store, sampleCapsuleInput({ id: targetId }));
    createCapsule(env.store, sampleCapsuleInput({ id: neighbourId, displayName: "Other" }));
    // capsule_sources.id is globally unique, so each capsule needs its own source id.
    const sourceTarget = sampleSourceInput("src-target");
    const sourceNeighbour = sampleSourceInput("src-neighbour");
    addSourceToCapsule(env.store, targetId, sourceTarget);
    addSourceToCapsule(env.store, neighbourId, sourceNeighbour);

    // Old rows in BOTH capsules. The retention call targets `targetId` only — the
    // neighbour's vector and parsed_unit must survive even though they are equally old.
    seedDocWithVector(env.store, {
      capsuleId: targetId,
      sourceId: sourceTarget.id,
      documentId: "doc-t",
      parsedUnitId: "pu-t",
      chunkId: "ch-t",
      vectorId: "vec-target",
      lastExtractedAt: now - 365 * DAY_MS,
      vectorCreatedAt: now - 365 * DAY_MS,
    });
    seedDocWithVector(env.store, {
      capsuleId: neighbourId,
      sourceId: sourceNeighbour.id,
      documentId: "doc-n",
      parsedUnitId: "pu-n",
      chunkId: "ch-n",
      vectorId: "vec-neighbour",
      lastExtractedAt: now - 365 * DAY_MS,
      vectorCreatedAt: now - 365 * DAY_MS,
    });

    applyRetentionToCapsule(
      env.store,
      targetId,
      { retainVectorsDays: 7, retainExtractedTextDays: 7 },
      now,
    );

    // Target capsule: pruned.
    expect(vectorIdsForCapsule(env.store, targetId)).toEqual([]);
    expect(parsedUnitIdsForCapsule(env.store, targetId)).toEqual([]);
    expect(documentTextIdsForCapsule(env.store, targetId)).toEqual([]);
    // Neighbour capsule: completely untouched.
    expect(vectorIdsForCapsule(env.store, neighbourId)).toEqual(["vec-neighbour"]);
    expect(parsedUnitIdsForCapsule(env.store, neighbourId)).toEqual(["pu-n"]);
    expect(documentTextIdsForCapsule(env.store, neighbourId)).toEqual(["doc-n"]);
  });

  it("deletes parsed_units whose parent document was last extracted before the cutoff", () => {
    const now = 30 * DAY_MS;
    const capsuleId = "cap-text" as KnowledgeCapsuleId;
    createCapsule(env.store, sampleCapsuleInput({ id: capsuleId }));
    const source = sampleSourceInput("src-1");
    addSourceToCapsule(env.store, capsuleId, source);

    seedDocWithVector(env.store, {
      capsuleId,
      sourceId: source.id,
      documentId: "doc-old",
      parsedUnitId: "pu-old",
      chunkId: "ch-old",
      vectorId: "vec-old",
      lastExtractedAt: now - 100 * DAY_MS,
      vectorCreatedAt: now - 1 * DAY_MS,
    });
    seedDocWithVector(env.store, {
      capsuleId,
      sourceId: source.id,
      documentId: "doc-new",
      parsedUnitId: "pu-new",
      chunkId: "ch-new",
      vectorId: "vec-new",
      lastExtractedAt: now - 1 * DAY_MS,
      vectorCreatedAt: now - 1 * DAY_MS,
    });

    const result = applyRetentionToCapsule(
      env.store,
      capsuleId,
      { retainExtractedTextDays: 30 },
      now,
    );

    expect(result.deletedExtractedTextCount).toBe(1);
    expect(parsedUnitIdsForCapsule(env.store, capsuleId)).toEqual(["pu-new"]);
    expect(documentTextIdsForCapsule(env.store, capsuleId)).toEqual(["doc-new"]);
  });
});
