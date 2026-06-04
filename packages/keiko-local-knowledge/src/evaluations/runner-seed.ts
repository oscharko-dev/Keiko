// Fixture seeding helpers for the eval runner (Epic #189, Issue #268). Extracted from
// `runner.ts` so each file stays under the 400-LOC budget. Materialises a fixture's
// capsules / sources / documents / parsed-units / chunks rows into a fresh store; the
// runner then embeds the chunks separately through `embedChunkBatch`.
//
// Topic boosts are aggregated here too: every chunk and every query that declares a
// `topic` contributes a boost of 1.0 to the map handed to the scripted adapter. Boosts of
// 1.0 produce the pure topic vector for marked inputs — strong enough that the
// ground-truth chunk always dominates the cosine ranking for its query.

import type {
  CapsuleSetId,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  ParsedUnit,
} from "@oscharko-dev/keiko-contracts";

import { createCapsule } from "../capsule-lifecycle.js";
import { createCapsuleSet } from "../capsule-set-lifecycle.js";
import { insertChunkRow } from "../chunking/chunker-persist.js";
import { insertDocumentRow, insertParsedUnitRow } from "../discovery/persist.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import type { KnowledgeStore } from "../store.js";

import { citationRequirementForUnit, type CitationRequirementKey } from "./dimensions.js";
import type {
  EvalCapsuleSpec,
  EvalDocumentSpec,
  EvalSourceSpec,
  RetrievalEvalFixture,
} from "./types.js";

export interface SeededFixture {
  readonly chunkUnitKinds: ReadonlyMap<string, CitationRequirementKey>;
  // Aggregated topic boosts across all chunks + queries in the fixture, ready to hand to
  // the scripted adapter.
  readonly topicBoosts: Readonly<Record<string, number>>;
  // Pinned identity for the run. Every capsule in a fixture currently shares one identity
  // (see fixtures.test.ts invariant). If a future fixture pins different identities per
  // capsule the embedding step will need a per-capsule adapter — out of scope until that
  // fixture lands.
  readonly identity: EmbeddingModelIdentity;
}

export function chunkParsedUnitId(documentId: string): string {
  return `unit-${documentId}`;
}

function seedCapsule(store: KnowledgeStore, capsule: EvalCapsuleSpec): void {
  createCapsule(store, {
    id: capsule.id,
    displayName: capsule.displayName,
    tags: [],
    retrievalEffort: "default",
    outputMode: "answers",
    answerGroundingPolicy: capsule.answerGroundingPolicy,
    embeddingModelIdentity: capsule.embeddingModelIdentity,
    lifecycleState: "draft",
    storageReference: `eval/${String(capsule.id)}`,
  });
}

function seedSource(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  source: EvalSourceSpec,
): void {
  addSourceToCapsule(store, capsuleId, {
    id: source.id,
    displayName: `Source ${String(source.id)}`,
    tags: [],
    scope: { kind: "folder", rootPath: "/srv/docs", recursive: true },
  });
}

function seedDocument(
  store: KnowledgeStore,
  capsule: EvalCapsuleSpec,
  source: EvalSourceSpec,
  doc: EvalDocumentSpec,
): void {
  insertDocumentRow(store._internal.db, {
    id: doc.id,
    capsuleId: capsule.id,
    sourceId: String(source.id),
    documentPath: `docs/${doc.safeDisplayName}`,
    sizeBytes: 1024,
    mediaType: "text/plain",
    contentHash: "a".repeat(64),
    parserId: "text",
    parserVersion: "1",
    lastExtractedAt: 1_700_000_000_000,
    status: "extracted",
    safeDisplayName: doc.safeDisplayName,
  });
  const unitId = chunkParsedUnitId(String(doc.id));
  const unit: ParsedUnit = { ...doc.parsedUnit.unit, documentId: doc.id };
  insertParsedUnitRow(store._internal.db, capsule.id, unitId, unit);
}

function seedChunks(
  store: KnowledgeStore,
  capsule: EvalCapsuleSpec,
  source: EvalSourceSpec,
  doc: EvalDocumentSpec,
  chunkUnitKinds: Map<string, CitationRequirementKey>,
): void {
  const unitId = chunkParsedUnitId(String(doc.id));
  const unit: ParsedUnit = { ...doc.parsedUnit.unit, documentId: doc.id };
  const requirement = citationRequirementForUnit(unit);
  let orderIndex = 0;
  for (const chunk of doc.chunks) {
    insertChunkRow(store._internal.db, {
      id: chunk.id,
      capsuleId: capsule.id,
      sourceId: source.id,
      documentId: doc.id,
      parsedUnitId: unitId,
      orderIndex,
      tokenCount: chunk.text.length,
      // 64-hex placeholder — schema requires a non-empty hash; eval never validates
      // content equivalence.
      safeExcerptHash: "b".repeat(64),
    });
    chunkUnitKinds.set(String(chunk.id), requirement);
    orderIndex += 1;
  }
}

function collectTopicBoosts(fixture: RetrievalEvalFixture): Record<string, number> {
  const boosts: Record<string, number> = {};
  for (const capsule of fixture.capsules) {
    for (const source of capsule.sources) {
      for (const doc of source.documents) {
        for (const chunk of doc.chunks) {
          if (chunk.topic !== undefined) boosts[chunk.topic] = 1.0;
        }
      }
    }
  }
  for (const query of fixture.queries) {
    if (query.topic !== undefined) boosts[query.topic] = 1.0;
  }
  return boosts;
}

function seedCapsuleSets(store: KnowledgeStore, fixture: RetrievalEvalFixture): void {
  for (const query of fixture.queries) {
    if (query.scope.kind !== "capsule-set") continue;
    // Create-if-absent: the same set id may appear on multiple queries.
    try {
      createCapsuleSet(store, {
        id: query.scope.capsuleSetId as CapsuleSetId,
        displayName: `Set ${query.scope.capsuleSetId}`,
        tags: [],
        capsuleIds: query.scope.capsuleIds,
      });
    } catch {
      // Already created on a previous query — ignore.
    }
  }
}

export function seedFixture(store: KnowledgeStore, fixture: RetrievalEvalFixture): SeededFixture {
  const chunkUnitKinds = new Map<string, CitationRequirementKey>();
  for (const capsule of fixture.capsules) {
    seedCapsule(store, capsule);
    for (const source of capsule.sources) {
      seedSource(store, capsule.id, source);
      for (const doc of source.documents) {
        seedDocument(store, capsule, source, doc);
        seedChunks(store, capsule, source, doc, chunkUnitKinds);
      }
    }
  }
  seedCapsuleSets(store, fixture);
  const first = fixture.capsules[0];
  if (first === undefined) {
    throw new Error("fixture must declare at least one capsule");
  }
  return {
    chunkUnitKinds,
    topicBoosts: collectTopicBoosts(fixture),
    identity: first.embeddingModelIdentity,
  };
}
