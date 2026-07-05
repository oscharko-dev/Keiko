import { describe, expect, it } from "vitest";

import {
  sealedLocalPodModelUsePolicy,
  standardPodModelUsePolicy,
  validateKnowledgePodSummary,
  type CapsuleSetId,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";

import {
  DEFAULT_EMBEDDING,
  freshStore,
  sampleCapsuleInput,
  sampleSourceInput,
} from "./_support.js";
import { createCapsule } from "./capsule-lifecycle.js";
import { createCapsuleSet } from "./capsule-set-lifecycle.js";
import { KnowledgeStoreError } from "./errors.js";
import {
  buildKnowledgePodSetSummary,
  buildKnowledgePodSummary,
  listKnowledgePodSummaries,
} from "./knowledge-pods.js";
import { addSourceToCapsule } from "./source-lifecycle.js";
import type { KnowledgeStore } from "./store.js";

const LEGACY_EMBEDDING = {
  provider: "openai",
  modelId: "text-embedding-3-small",
  vectorDimensions: 1536,
  vectorMetric: "cosine",
} as const;

function seedIndexedDocument(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
  suffix: string,
): void {
  const documentId = `doc-${suffix}`;
  const parsedUnitId = `pu-${suffix}`;
  const chunkId = `ch-${suffix}`;
  store._internal.db
    .prepare(
      "INSERT INTO documents (id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name) VALUES (:id, :c, :s, '/Users/alice/private/customer.pdf', 1, 'text/markdown', :h, 'parser', '1', 1, 'ready', 'customer.pdf')",
    )
    .run({ id: documentId, c: capsuleId, s: sourceId, h: `hash-${suffix}` });
  store._internal.db
    .prepare(
      "INSERT INTO parsed_units (id, capsule_id, document_id, kind) VALUES (:id, :c, :d, 'paragraph')",
    )
    .run({ id: parsedUnitId, c: capsuleId, d: documentId });
  store._internal.db
    .prepare(
      "INSERT INTO chunks (id, capsule_id, source_id, document_id, parsed_unit_id, order_index, token_count, safe_excerpt_hash) VALUES (:id, :c, :s, :d, :p, 0, 10, :h)",
    )
    .run({
      id: chunkId,
      c: capsuleId,
      s: sourceId,
      d: documentId,
      p: parsedUnitId,
      h: `chunk-${suffix}`,
    });
  store._internal.db
    .prepare(
      "INSERT INTO vectors (id, capsule_id, source_id, document_id, chunk_id, embedding, embedding_model_provider, embedding_model_id, vector_dimensions, vector_metric, storage_reference, created_at) VALUES (:id, :c, :s, :d, :ch, :emb, 'openai', 'text-embedding-3-small', 1536, 'cosine', :r, 1)",
    )
    .run({
      id: `vec-${suffix}`,
      c: capsuleId,
      s: sourceId,
      d: documentId,
      ch: chunkId,
      emb: new Uint8Array([1, 2, 3]),
      r: `vector-${suffix}`,
    });
}

describe("Knowledge Pod compatibility projection", () => {
  it("projects a capsule into a body-free pod summary over existing Local Knowledge state", () => {
    const env = freshStore();
    try {
      const capsuleId = "cap-risk" as KnowledgeCapsuleId;
      const sourceId = "src-risk" as KnowledgeSourceId;
      const capsule = createCapsule(
        env.store,
        sampleCapsuleInput({
          id: capsuleId,
          displayName: "Risk Controls",
          lifecycleState: "ready",
          embeddingModelIdentity: LEGACY_EMBEDDING,
        }),
      );
      addSourceToCapsule(env.store, capsuleId, sampleSourceInput(sourceId));
      seedIndexedDocument(env.store, capsuleId, sourceId, "risk");

      const summary = buildKnowledgePodSummary(env.store, capsule);

      expect(summary).toMatchObject({
        kind: "pod",
        displayName: "Risk Controls",
        readiness: "degraded",
        counts: {
          capsuleCount: 1,
          sourceCount: 1,
          documentCount: 1,
          chunkCount: 1,
          vectorCount: 1,
        },
        sourceKinds: ["folder"],
        retrieval: {
          lexicalIndex: true,
          vectorIndex: true,
          hybridGrounding: true,
          crossSpaceScoreMixing: false,
          embeddingProvider: "openai",
          embeddingCompatibilityStatus: "unknown",
          embeddingCompatibilityReason: "legacy-unverified-profile",
          reindexRecommended: true,
          queryEmbeddingAllowed: false,
        },
        privacy: {
          localFirst: true,
          rawContentExposed: false,
          privatePathsExposed: false,
        },
        governance: {
          locationKind: "local",
          sealingPosture: "sealed-pod-policy",
          policyPosture: "not-declared",
          managedServiceDependency: false,
        },
        modelUsePolicy: {
          source: "legacy-default",
          mode: "sealed-local",
          operations: {
            externalEmbeddings: "deny",
            localEmbeddings: "allow",
            externalReranking: "deny",
            localReranking: "allow",
            answerSynthesis: "deny",
            rawContentRelease: "deny",
            evidencePersistence: "allow",
          },
        },
        compatibility: {
          backingKind: "knowledge-capsule",
          capsuleIds: [capsuleId],
          sourceIds: [sourceId],
          migrationRequired: false,
          persistedStateRenamed: false,
        },
      });
      expect(validateKnowledgePodSummary(summary).ok).toBe(true);
      expect(JSON.stringify(summary)).not.toContain("/Users/alice");
    } finally {
      env.cleanup();
    }
  });

  it("projects capsule sets without copying vectors or renaming persisted state", () => {
    const env = freshStore();
    try {
      const aId = "cap-a" as KnowledgeCapsuleId;
      const bId = "cap-b" as KnowledgeCapsuleId;
      const aSourceId = "src-a" as KnowledgeSourceId;
      const bSourceId = "src-b" as KnowledgeSourceId;
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: aId,
          lifecycleState: "ready",
          embeddingModelIdentity: LEGACY_EMBEDDING,
        }),
      );
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: bId,
          lifecycleState: "ready",
          embeddingModelIdentity: LEGACY_EMBEDDING,
          storageReference: "engineering/capsule-b",
        }),
      );
      addSourceToCapsule(env.store, aId, sampleSourceInput(aSourceId));
      addSourceToCapsule(env.store, bId, sampleSourceInput(bSourceId));
      seedIndexedDocument(env.store, aId, aSourceId, "a");
      seedIndexedDocument(env.store, bId, bSourceId, "b");
      const set = createCapsuleSet(env.store, {
        id: "set-risk" as CapsuleSetId,
        displayName: "Risk Set",
        tags: ["governed"],
        capsuleIds: [aId, bId],
      });

      const summary = buildKnowledgePodSetSummary(env.store, set);

      expect(summary).toMatchObject({
        kind: "pod-set",
        displayName: "Risk Set",
        readiness: "degraded",
        counts: {
          capsuleCount: 2,
          sourceCount: 2,
          documentCount: 2,
          chunkCount: 2,
          vectorCount: 2,
        },
        sourceKinds: ["folder"],
        retrieval: {
          lexicalIndex: true,
          vectorIndex: true,
          crossSpaceScoreMixing: false,
          embeddingCompatibilityStatus: "unknown",
          embeddingCompatibilityReason: "legacy-unverified-profile",
          reindexRecommended: true,
          queryEmbeddingAllowed: false,
        },
        governance: {
          locationKind: "local",
          sealingPosture: "sealed-pod-policy",
          policyPosture: "not-declared",
          managedServiceDependency: false,
        },
        modelUsePolicy: {
          source: "legacy-default",
          mode: "sealed-local",
        },
        compatibility: {
          backingKind: "capsule-set",
          capsuleIds: [aId, bId],
          sourceIds: [aSourceId, bSourceId],
          migrationRequired: false,
          persistedStateRenamed: false,
        },
      });
      expect(validateKnowledgePodSummary(summary).ok).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("projects explicit standard model-use policy without sealed posture", () => {
    const env = freshStore();
    try {
      const capsule = createCapsule(
        env.store,
        sampleCapsuleInput({
          id: "cap-standard-policy" as KnowledgeCapsuleId,
          modelUsePolicy: standardPodModelUsePolicy(),
        }),
      );

      const summary = buildKnowledgePodSummary(env.store, capsule);

      expect(summary).toMatchObject({
        governance: {
          sealingPosture: "local-store-policy",
          policyPosture: "policy-pack",
          managedServiceDependency: false,
        },
        modelUsePolicy: {
          source: "explicit",
          mode: "standard",
          operations: {
            externalEmbeddings: "allow",
            externalReranking: "allow",
            answerSynthesis: "allow",
            rawContentRelease: "allow",
          },
        },
      });
      expect(validateKnowledgePodSummary(summary).ok).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("projects all-standard pod-set model-use policy as standard", () => {
    const env = freshStore();
    try {
      const aId = "cap-standard-set-a" as KnowledgeCapsuleId;
      const bId = "cap-standard-set-b" as KnowledgeCapsuleId;
      createCapsule(
        env.store,
        sampleCapsuleInput({ id: aId, modelUsePolicy: standardPodModelUsePolicy() }),
      );
      createCapsule(
        env.store,
        sampleCapsuleInput({ id: bId, modelUsePolicy: standardPodModelUsePolicy() }),
      );
      const set = createCapsuleSet(env.store, {
        id: "set-standard-policy" as CapsuleSetId,
        displayName: "Standard Policy Set",
        tags: [],
        capsuleIds: [aId, bId],
      });

      const summary = buildKnowledgePodSetSummary(env.store, set);

      expect(summary.modelUsePolicy).toMatchObject({
        source: "explicit",
        mode: "standard",
        operations: {
          externalEmbeddings: "allow",
          externalReranking: "allow",
          answerSynthesis: "allow",
          rawContentRelease: "allow",
        },
      });
      expect(validateKnowledgePodSummary(summary).ok).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("projects pod-set member readiness as closed counts and reason codes", () => {
    const env = freshStore();
    try {
      const readyId = "cap-readiness-ready" as KnowledgeCapsuleId;
      const sealedId = "cap-readiness-sealed" as KnowledgeCapsuleId;
      const indexingId = "cap-readiness-indexing" as KnowledgeCapsuleId;
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: readyId,
          lifecycleState: "ready",
          modelUsePolicy: standardPodModelUsePolicy(),
        }),
      );
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: sealedId,
          lifecycleState: "ready",
          modelUsePolicy: sealedLocalPodModelUsePolicy(),
        }),
      );
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: indexingId,
          lifecycleState: "indexing",
          modelUsePolicy: standardPodModelUsePolicy(),
        }),
      );
      const set = createCapsuleSet(env.store, {
        id: "set-readiness" as CapsuleSetId,
        displayName: "Readiness Set",
        tags: [],
        capsuleIds: [readyId, sealedId, indexingId],
      });

      const summary = buildKnowledgePodSetSummary(env.store, set);

      expect(summary.setReadiness).toMatchObject({
        readyCount: 0,
        draftCount: 0,
        degradedCount: 2,
        unavailableCount: 0,
        deniedCount: 1,
        indexingCount: 1,
        staleCount: 0,
        errorCount: 0,
        missingCount: 0,
      });
      expect(summary.setReadiness?.reasonCodes).toEqual(
        expect.arrayContaining(["member-indexing", "policy-denied", "no-sources"]),
      );
      expect(validateKnowledgePodSummary(summary).ok).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("keeps missing pod-set members visible as degraded redacted counts", () => {
    const env = freshStore();
    try {
      const presentId = "cap-present-member" as KnowledgeCapsuleId;
      const missingId = "cap-missing-member" as KnowledgeCapsuleId;
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: presentId,
          lifecycleState: "ready",
          modelUsePolicy: standardPodModelUsePolicy(),
        }),
      );

      const summary = buildKnowledgePodSetSummary(env.store, {
        id: "set-missing-member" as CapsuleSetId,
        displayName: "Missing Member Set",
        tags: [],
        capsuleIds: [presentId, missingId],
        composedAt: 1,
      });

      expect(summary).toMatchObject({
        readiness: "degraded",
        counts: {
          capsuleCount: 2,
        },
        setReadiness: {
          degradedCount: 1,
          missingCount: 1,
        },
      });
      expect(summary.setReadiness?.reasonCodes).toEqual(
        expect.arrayContaining(["missing-member", "no-sources"]),
      );
      expect(validateKnowledgePodSummary(summary).ok).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("keeps draft pods with no sources explicit and evidence-safe", () => {
    const env = freshStore();
    try {
      const capsule = createCapsule(
        env.store,
        sampleCapsuleInput({ id: "cap-empty" as KnowledgeCapsuleId }),
      );

      const summary = buildKnowledgePodSummary(env.store, capsule);

      expect(summary).toMatchObject({
        kind: "pod",
        readiness: "draft",
        counts: {
          capsuleCount: 1,
          sourceCount: 0,
          documentCount: 0,
          chunkCount: 0,
          vectorCount: 0,
        },
        degradationReasons: ["No sources are attached.", "The pod has not been indexed yet."],
      });
      expect(validateKnowledgePodSummary(summary).ok).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("redacts path-shaped and secret-shaped display metadata before producing summaries", () => {
    const env = freshStore();
    try {
      const capsule = createCapsule(
        env.store,
        sampleCapsuleInput({
          id: "cap-private" as KnowledgeCapsuleId,
          displayName: String.raw`\\server\share\customer.pdf`,
          description: "See ~/private/customer.pdf",
          tags: ["safe", "/tmp/customer.pdf", "ghp_123456789012345"],
          embeddingModelIdentity: {
            ...DEFAULT_EMBEDDING,
            provider: "gateway.internal/v1?api_key=secret-value",
            modelId: "/private/var/customer-model",
            embeddingSpaceFingerprint: "wss://example.test/embed?access_token=secret-value",
          },
        }),
      );

      const summary = buildKnowledgePodSummary(env.store, capsule);
      const wire = JSON.stringify(summary);

      expect(summary.displayName).toBe("Knowledge Pod");
      expect(summary).not.toHaveProperty("description");
      expect(summary.tags).toStrictEqual(["safe"]);
      expect(summary.retrieval).not.toHaveProperty("embeddingProvider");
      expect(summary.retrieval).not.toHaveProperty("embeddingModelId");
      expect(summary.retrieval).not.toHaveProperty("embeddingSpaceFingerprint");
      expect(summary.retrieval).not.toHaveProperty("embeddingProfileKey");
      expect(validateKnowledgePodSummary(summary).ok).toBe(true);
      expect(wire).not.toContain("\\\\server");
      expect(wire).not.toContain("~/");
      expect(wire).not.toContain("/tmp");
      expect(wire).not.toContain("/private/var");
      expect(wire).not.toContain("Bearer");
      expect(wire).not.toContain("api_key");
      expect(wire).not.toContain("access_token");
      expect(wire).not.toContain("ghp_");
    } finally {
      env.cleanup();
    }
  });

  it("lists pods and pod sets together for additive BFF responses", () => {
    const env = freshStore();
    try {
      const capsuleId = "cap-listed" as KnowledgeCapsuleId;
      createCapsule(env.store, sampleCapsuleInput({ id: capsuleId }));
      createCapsuleSet(env.store, {
        id: "set-listed" as CapsuleSetId,
        displayName: "Listed Set",
        tags: [],
        capsuleIds: [capsuleId],
      });

      expect(listKnowledgePodSummaries(env.store).map((summary) => summary.kind)).toStrictEqual([
        "pod",
        "pod-set",
      ]);
    } finally {
      env.cleanup();
    }
  });

  it("fails closed when a capsule summary would carry corrupt lifecycle state", () => {
    const env = freshStore();
    try {
      const capsuleId = "cap-corrupt-state" as KnowledgeCapsuleId;
      createCapsule(env.store, sampleCapsuleInput({ id: capsuleId, lifecycleState: "ready" }));
      env.store._internal.db
        .prepare("UPDATE capsules SET lifecycle_state = 'published' WHERE id = :id")
        .run({ id: capsuleId });

      expect(() => listKnowledgePodSummaries(env.store)).toThrow(KnowledgeStoreError);
    } finally {
      env.cleanup();
    }
  });

  it("fails closed when a pod-set member summary would carry corrupt state", () => {
    const env = freshStore();
    try {
      const capsuleId = "cap-corrupt-member" as KnowledgeCapsuleId;
      createCapsule(env.store, sampleCapsuleInput({ id: capsuleId, lifecycleState: "ready" }));
      const set = createCapsuleSet(env.store, {
        id: "set-corrupt-member" as CapsuleSetId,
        displayName: "Corrupt Member Set",
        tags: [],
        capsuleIds: [capsuleId],
      });
      env.store._internal.db
        .prepare("UPDATE capsules SET vector_metric = 'manhattan' WHERE id = :id")
        .run({ id: capsuleId });

      expect(() => buildKnowledgePodSetSummary(env.store, set)).toThrow(KnowledgeStoreError);
    } finally {
      env.cleanup();
    }
  });
});
