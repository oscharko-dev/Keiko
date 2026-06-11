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
import { createCapsuleSet, getCapsuleSet } from "../capsule-set-lifecycle.js";
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
  readonly chunkTokenCounts: ReadonlyMap<string, number>;
  // Aggregated topic boosts across all chunks + queries in the fixture, ready to hand to
  // the scripted adapter.
  readonly topicBoosts: Readonly<Record<string, number>>;
  // Pinned identity for the run. Every capsule in a fixture currently shares one identity.
  readonly identity: EmbeddingModelIdentity;
}

function chunkParsedUnitId(documentId: string, parsedUnitId: string): string {
  return `unit-${documentId}-${parsedUnitId}`;
}

function sameEmbeddingIdentity(
  left: EmbeddingModelIdentity,
  right: EmbeddingModelIdentity,
): boolean {
  return (
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    left.modelRevision === right.modelRevision &&
    left.vectorDimensions === right.vectorDimensions &&
    left.vectorMetric === right.vectorMetric
  );
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

function composeParsedUnit(
  documentId: string,
  unit: EvalDocumentSpec["parsedUnits"][number],
): ParsedUnit {
  return { ...unit.unit, documentId: documentId as ParsedUnit["documentId"] };
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
    mediaType: doc.mediaType ?? "text/plain",
    contentHash: "a".repeat(64),
    parserId: doc.parserId ?? "text",
    parserVersion: doc.parserVersion ?? "1",
    lastExtractedAt: 1_700_000_000_000,
    status: "extracted",
    safeDisplayName: doc.safeDisplayName,
  });
  for (const parsedUnit of doc.parsedUnits) {
    insertParsedUnitRow(
      store._internal.db,
      capsule.id,
      chunkParsedUnitId(String(doc.id), parsedUnit.id),
      composeParsedUnit(String(doc.id), parsedUnit),
    );
  }
}

function resolveChunkUnit(
  doc: EvalDocumentSpec,
  chunk: EvalDocumentSpec["chunks"][number],
): EvalDocumentSpec["parsedUnits"][number] {
  if (doc.parsedUnits.length === 0) {
    throw new Error(`eval document ${String(doc.id)} must declare at least one parsed unit`);
  }
  if (chunk.parsedUnitId === undefined) {
    const first = doc.parsedUnits[0];
    if (first === undefined) throw new Error("unreachable");
    return first;
  }
  const resolved = doc.parsedUnits.find((unit) => unit.id === chunk.parsedUnitId);
  if (resolved === undefined) {
    throw new Error(
      `eval chunk ${String(chunk.id)} references unknown parsed unit ${chunk.parsedUnitId}`,
    );
  }
  return resolved;
}

function seedChunks(
  store: KnowledgeStore,
  capsule: EvalCapsuleSpec,
  source: EvalSourceSpec,
  doc: EvalDocumentSpec,
  chunkUnitKinds: Map<string, CitationRequirementKey>,
  chunkTokenCounts: Map<string, number>,
): void {
  let orderIndex = 0;
  for (const chunk of doc.chunks) {
    const parsedUnit = resolveChunkUnit(doc, chunk);
    const composedUnit = composeParsedUnit(String(doc.id), parsedUnit);
    insertChunkRow(store._internal.db, {
      id: chunk.id,
      capsuleId: capsule.id,
      sourceId: source.id,
      documentId: doc.id,
      parsedUnitId: chunkParsedUnitId(String(doc.id), parsedUnit.id),
      orderIndex,
      tokenCount: chunk.text.length,
      safeExcerptHash: "b".repeat(64),
      chunkingStrategyVersion: "issue-195-v1",
      // Synthetic span over the chunk's own text. Inert for the eval harness (it retrieves
      // pre-seeded vectors rather than re-slicing source text) but satisfies the v8 columns.
      characterStart: 0,
      characterEnd: chunk.text.length,
    });
    chunkUnitKinds.set(String(chunk.id), citationRequirementForUnit(composedUnit));
    chunkTokenCounts.set(String(chunk.id), chunk.text.length);
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
    const id = query.scope.capsuleSetId as CapsuleSetId;
    if (getCapsuleSet(store, id) !== undefined) continue;
    createCapsuleSet(store, {
      id,
      displayName: `Set ${query.scope.capsuleSetId}`,
      tags: [],
      capsuleIds: query.scope.capsuleIds,
    });
  }
}

function validateFixtureIdentity(fixture: RetrievalEvalFixture): EmbeddingModelIdentity {
  const first = fixture.capsules[0];
  if (first === undefined) {
    throw new Error("fixture must declare at least one capsule");
  }
  for (const capsule of fixture.capsules) {
    if (!sameEmbeddingIdentity(first.embeddingModelIdentity, capsule.embeddingModelIdentity)) {
      throw new Error(
        `fixture ${fixture.id} mixes embedding identities; eval runner requires one identity per run`,
      );
    }
  }
  return first.embeddingModelIdentity;
}

export function seedFixture(store: KnowledgeStore, fixture: RetrievalEvalFixture): SeededFixture {
  const chunkUnitKinds = new Map<string, CitationRequirementKey>();
  const chunkTokenCounts = new Map<string, number>();
  for (const capsule of fixture.capsules) {
    seedCapsule(store, capsule);
    for (const source of capsule.sources) {
      seedSource(store, capsule.id, source);
      for (const doc of source.documents) {
        seedDocument(store, capsule, source, doc);
        seedChunks(store, capsule, source, doc, chunkUnitKinds, chunkTokenCounts);
      }
    }
  }
  seedCapsuleSets(store, fixture);
  return {
    chunkUnitKinds,
    chunkTokenCounts,
    topicBoosts: collectTopicBoosts(fixture),
    identity: validateFixtureIdentity(fixture),
  };
}
