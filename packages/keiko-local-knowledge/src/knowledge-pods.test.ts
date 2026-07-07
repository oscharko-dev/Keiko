import { describe, expect, it } from "vitest";

import {
  sealedLocalPodModelUsePolicy,
  standardPodModelUsePolicy,
  validateKnowledgePodSummary,
  htmlManualSourceFingerprintTag,
  htmlManualSourceKindTag,
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

// Two hardened embedding spaces that agree on every identity field except the space fingerprint.
// `provider`/`modelId`/`vectorDimensions`/`vectorMetric` match `seedIndexedDocument`'s vector rows
// so the seed is consistent; the divergent fingerprint is what makes the pair incompatible.
const HARDENED_EMBEDDING_A = {
  provider: "openai",
  modelId: "text-embedding-3-small",
  vectorDimensions: 1536,
  vectorMetric: "cosine",
  normalization: "l2",
  instructionVersion: "keiko-embedding-input-v1",
  embeddingSpaceFingerprint: "keiko-embedding-space-fingerprint-v1:aaaaaaaaaaaaaaaaaaaaaaaa",
} as const;

const HARDENED_EMBEDDING_B = {
  ...HARDENED_EMBEDDING_A,
  embeddingSpaceFingerprint: "keiko-embedding-space-fingerprint-v1:bbbbbbbbbbbbbbbbbbbbbbbb",
} as const;

// A genuinely different embedding space (different provider, not merely a fingerprint drift), so
// the set-level decision must resolve to "incompatible" rather than the softer "unknown".
const HARDENED_EMBEDDING_C = {
  ...HARDENED_EMBEDDING_A,
  provider: "azure-openai",
  embeddingSpaceFingerprint: "keiko-embedding-space-fingerprint-v1:cccccccccccccccccccccccc",
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
          embeddingCompatibilityStatus: "unavailable",
          embeddingCompatibilityReason: "policy-denied",
          reindexRecommended: false,
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

  it("projects HTML manual source metadata without widening the retrieval scope kind", () => {
    const env = freshStore();
    try {
      const capsuleId = "cap-manual-summary" as KnowledgeCapsuleId;
      const sourceId = "src-manual-summary" as KnowledgeSourceId;
      const capsule = createCapsule(
        env.store,
        sampleCapsuleInput({
          id: capsuleId,
          displayName: "Device Handbook",
          lifecycleState: "ready",
          modelUsePolicy: standardPodModelUsePolicy(),
        }),
      );
      addSourceToCapsule(env.store, capsuleId, {
        ...sampleSourceInput(sourceId),
        tags: [
          htmlManualSourceKindTag("html-manual-http"),
          htmlManualSourceFingerprintTag("fp-device-handbook"),
        ],
        scope: {
          kind: "files",
          rootPath: "/keiko-html-manual/cap-manual-summary",
          files: ["index.html"],
        },
      });
      seedIndexedDocument(env.store, capsuleId, sourceId, "manual-summary");

      const summary = buildKnowledgePodSummary(env.store, capsule);

      expect(summary.sourceKinds).toStrictEqual(["html-manual-http"]);
      expect(summary.manualSourceFingerprint).toBe("fp-device-handbook");
      expect(summary.compatibility.sourceIds).toStrictEqual([sourceId]);
      expect(validateKnowledgePodSummary(summary).ok).toBe(true);
      expect(JSON.stringify(summary)).not.toContain("keiko-html-manual");
    } finally {
      env.cleanup();
    }
  });

  it("keeps a legacy standard-policy profile unknown with explicit local reindex guidance", () => {
    const env = freshStore();
    try {
      const capsuleId = "cap-legacy-standard" as KnowledgeCapsuleId;
      const sourceId = "src-legacy-standard" as KnowledgeSourceId;
      const capsule = createCapsule(
        env.store,
        sampleCapsuleInput({
          id: capsuleId,
          lifecycleState: "ready",
          embeddingModelIdentity: LEGACY_EMBEDDING,
          modelUsePolicy: standardPodModelUsePolicy(),
        }),
      );
      addSourceToCapsule(env.store, capsuleId, sampleSourceInput(sourceId));
      seedIndexedDocument(env.store, capsuleId, sourceId, "legacy-standard");

      const summary = buildKnowledgePodSummary(env.store, capsule);

      expect(summary.retrieval).toMatchObject({
        embeddingCompatibilityStatus: "unknown",
        embeddingCompatibilityReason: "legacy-unverified-profile",
        reindexRecommended: true,
        queryEmbeddingAllowed: false,
      });
      expect(summary.degradationReasons).toEqual(
        expect.arrayContaining([
          "Embedding profile compatibility is unverified; full re-embed is recommended.",
        ]),
      );
      expect(validateKnowledgePodSummary(summary).ok).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("marks a hardened sealed-policy pod unavailable instead of query eligible", () => {
    const env = freshStore();
    try {
      const capsuleId = "cap-hardened-sealed" as KnowledgeCapsuleId;
      const sourceId = "src-hardened-sealed" as KnowledgeSourceId;
      const capsule = createCapsule(
        env.store,
        sampleCapsuleInput({
          id: capsuleId,
          lifecycleState: "ready",
          embeddingModelIdentity: HARDENED_EMBEDDING_A,
          modelUsePolicy: sealedLocalPodModelUsePolicy(),
        }),
      );
      addSourceToCapsule(env.store, capsuleId, sampleSourceInput(sourceId));
      seedIndexedDocument(env.store, capsuleId, sourceId, "hardened-sealed");

      const summary = buildKnowledgePodSummary(env.store, capsule);

      expect(summary).toMatchObject({
        readiness: "degraded",
        retrieval: {
          embeddingCompatibilityStatus: "unavailable",
          embeddingCompatibilityReason: "policy-denied",
          reindexRecommended: false,
          queryEmbeddingAllowed: false,
        },
      });
      expect(summary.degradationReasons).toEqual(
        expect.arrayContaining([
          "Embedding profile cannot run semantic retrieval under the current policy.",
        ]),
      );
      expect(validateKnowledgePodSummary(summary).ok).toBe(true);
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
          embeddingCompatibilityStatus: "unavailable",
          embeddingCompatibilityReason: "policy-denied",
          reindexRecommended: false,
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

  it("surfaces incompatible embedding spaces across pod-set members instead of silently mixing them", () => {
    const env = freshStore();
    try {
      const aId = "cap-space-a" as KnowledgeCapsuleId;
      const bId = "cap-space-b" as KnowledgeCapsuleId;
      const aSourceId = "src-space-a" as KnowledgeSourceId;
      const bSourceId = "src-space-b" as KnowledgeSourceId;
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: aId,
          lifecycleState: "ready",
          embeddingModelIdentity: HARDENED_EMBEDDING_A,
          modelUsePolicy: standardPodModelUsePolicy(),
        }),
      );
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: bId,
          lifecycleState: "ready",
          embeddingModelIdentity: HARDENED_EMBEDDING_B,
          modelUsePolicy: standardPodModelUsePolicy(),
          storageReference: "engineering/space-b",
        }),
      );
      addSourceToCapsule(env.store, aId, sampleSourceInput(aSourceId));
      addSourceToCapsule(env.store, bId, sampleSourceInput(bSourceId));
      seedIndexedDocument(env.store, aId, aSourceId, "space-a");
      seedIndexedDocument(env.store, bId, bSourceId, "space-b");
      const set = createCapsuleSet(env.store, {
        id: "set-cross-space" as CapsuleSetId,
        displayName: "Cross Space Set",
        tags: [],
        capsuleIds: [aId, bId],
      });

      const summary = buildKnowledgePodSetSummary(env.store, set);

      // The two members are each internally consistent (self-`same`), so the incompatibility is a
      // cross-member property the set-level decision must surface — never a silent fall-through to
      // a compatible/query-eligible state.
      expect(summary.retrieval).toMatchObject({
        crossSpaceScoreMixing: false,
        embeddingCompatibilityStatus: "unknown",
        embeddingCompatibilityReason: "fingerprint-mismatch",
        reindexRecommended: true,
        queryEmbeddingAllowed: false,
      });
      expect(summary.setReadiness?.reasonCodes).toEqual(
        expect.arrayContaining(["embedding-unknown"]),
      );
      expect(summary.degradationReasons).toEqual(
        expect.arrayContaining([
          "Embedding profile compatibility is unverified; full re-embed is recommended.",
        ]),
      );
      expect(validateKnowledgePodSummary(summary).ok).toBe(true);
      // The raw space fingerprints are the discriminator, but they must never reach the wire.
      expect(JSON.stringify(summary)).not.toContain("keiko-embedding-space-fingerprint-v1:");
    } finally {
      env.cleanup();
    }
  });

  it("marks a genuine cross-member provider mismatch incompatible instead of downgrading to unknown", () => {
    // Unlike the fingerprint-only pair above, these members disagree on `provider` itself, so
    // `compareEmbeddingProfiles` must resolve to "incompatible", not the softer "unknown" reserved
    // for legacy/fingerprint-only drift. This guards `setEmbeddingDecision`'s pairwise comparison
    // loop against a future refactor that collapses every cross-member mismatch to one status.
    const env = freshStore();
    try {
      const aId = "cap-provider-a" as KnowledgeCapsuleId;
      const bId = "cap-provider-b" as KnowledgeCapsuleId;
      const aSourceId = "src-provider-a" as KnowledgeSourceId;
      const bSourceId = "src-provider-b" as KnowledgeSourceId;
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: aId,
          lifecycleState: "ready",
          embeddingModelIdentity: HARDENED_EMBEDDING_A,
          modelUsePolicy: standardPodModelUsePolicy(),
        }),
      );
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: bId,
          lifecycleState: "ready",
          embeddingModelIdentity: HARDENED_EMBEDDING_C,
          modelUsePolicy: standardPodModelUsePolicy(),
          storageReference: "engineering/provider-b",
        }),
      );
      addSourceToCapsule(env.store, aId, sampleSourceInput(aSourceId));
      addSourceToCapsule(env.store, bId, sampleSourceInput(bSourceId));
      seedIndexedDocument(env.store, aId, aSourceId, "provider-a");
      seedIndexedDocument(env.store, bId, bSourceId, "provider-b");
      const set = createCapsuleSet(env.store, {
        id: "set-cross-provider" as CapsuleSetId,
        displayName: "Cross Provider Set",
        tags: [],
        capsuleIds: [aId, bId],
      });

      const summary = buildKnowledgePodSetSummary(env.store, set);

      expect(summary.retrieval).toMatchObject({
        crossSpaceScoreMixing: false,
        embeddingCompatibilityStatus: "incompatible",
        embeddingCompatibilityReason: "provider-mismatch",
        reindexRecommended: true,
        queryEmbeddingAllowed: false,
      });
      expect(summary.setReadiness?.reasonCodes).toEqual(
        expect.arrayContaining(["embedding-incompatible"]),
      );
      expect(summary.degradationReasons).toEqual(
        expect.arrayContaining([
          "Embedding profile is incompatible with the current semantic retrieval space.",
        ]),
      );
      expect(validateKnowledgePodSummary(summary).ok).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("does not mask a genuine cross-member embedding mismatch behind an unrelated legacy member's own status", () => {
    // AUDIT-E1818-001: setEmbeddingDecision() used to return the FIRST member whose own
    // self-compare status was not "same" (here, the legacy member's soft "unknown"/
    // legacy-unverified-profile status) without ever pairwise-comparing the other two, genuinely
    // incompatible, hardened members against each other. A real incompatibility must never be
    // under-reported as the softer status of an unrelated legacy member.
    const env = freshStore();
    try {
      const legacyId = "cap-mask-legacy" as KnowledgeCapsuleId;
      const aId = "cap-mask-hardened-a" as KnowledgeCapsuleId;
      const cId = "cap-mask-hardened-c" as KnowledgeCapsuleId;
      const legacySourceId = "src-mask-legacy" as KnowledgeSourceId;
      const aSourceId = "src-mask-hardened-a" as KnowledgeSourceId;
      const cSourceId = "src-mask-hardened-c" as KnowledgeSourceId;
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: legacyId,
          lifecycleState: "ready",
          embeddingModelIdentity: LEGACY_EMBEDDING,
          modelUsePolicy: standardPodModelUsePolicy(),
        }),
      );
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: aId,
          lifecycleState: "ready",
          embeddingModelIdentity: HARDENED_EMBEDDING_A,
          modelUsePolicy: standardPodModelUsePolicy(),
          storageReference: "engineering/mask-a",
        }),
      );
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: cId,
          lifecycleState: "ready",
          embeddingModelIdentity: HARDENED_EMBEDDING_C,
          modelUsePolicy: standardPodModelUsePolicy(),
          storageReference: "engineering/mask-c",
        }),
      );
      addSourceToCapsule(env.store, legacyId, sampleSourceInput(legacySourceId));
      addSourceToCapsule(env.store, aId, sampleSourceInput(aSourceId));
      addSourceToCapsule(env.store, cId, sampleSourceInput(cSourceId));
      seedIndexedDocument(env.store, legacyId, legacySourceId, "mask-legacy");
      seedIndexedDocument(env.store, aId, aSourceId, "mask-a");
      seedIndexedDocument(env.store, cId, cSourceId, "mask-c");
      const set = createCapsuleSet(env.store, {
        id: "set-mask-legacy" as CapsuleSetId,
        displayName: "Legacy Masking Set",
        tags: [],
        capsuleIds: [legacyId, aId, cId],
      });

      const summary = buildKnowledgePodSetSummary(env.store, set);

      expect(summary.retrieval.embeddingCompatibilityStatus).toBe("incompatible");
      expect(summary.setReadiness?.reasonCodes).toEqual(
        expect.arrayContaining(["embedding-incompatible"]),
      );
      expect(summary.setReadiness?.reasonCodes).not.toEqual(
        expect.arrayContaining(["embedding-unknown"]),
      );
      expect(summary.degradationReasons).toEqual(
        expect.arrayContaining([
          "Embedding profile is incompatible with the current semantic retrieval space.",
        ]),
      );
      expect(validateKnowledgePodSummary(summary).ok).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("does not mask a genuine cross-member embedding mismatch behind an unrelated policy-denied member's own status", () => {
    // Companion case for the "unavailable" branch: a policy-denied member's own self-compare
    // status ("unavailable") must not short-circuit past a genuine incompatibility between two
    // other, policy-allowed members.
    const env = freshStore();
    try {
      const deniedId = "cap-mask-denied" as KnowledgeCapsuleId;
      const aId = "cap-mask-denied-a" as KnowledgeCapsuleId;
      const cId = "cap-mask-denied-c" as KnowledgeCapsuleId;
      const deniedSourceId = "src-mask-denied" as KnowledgeSourceId;
      const aSourceId = "src-mask-denied-a" as KnowledgeSourceId;
      const cSourceId = "src-mask-denied-c" as KnowledgeSourceId;
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: deniedId,
          lifecycleState: "ready",
          embeddingModelIdentity: HARDENED_EMBEDDING_A,
          modelUsePolicy: sealedLocalPodModelUsePolicy(),
          storageReference: "engineering/mask-denied",
        }),
      );
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: aId,
          lifecycleState: "ready",
          embeddingModelIdentity: HARDENED_EMBEDDING_A,
          modelUsePolicy: standardPodModelUsePolicy(),
          storageReference: "engineering/mask-denied-a",
        }),
      );
      createCapsule(
        env.store,
        sampleCapsuleInput({
          id: cId,
          lifecycleState: "ready",
          embeddingModelIdentity: HARDENED_EMBEDDING_C,
          modelUsePolicy: standardPodModelUsePolicy(),
          storageReference: "engineering/mask-denied-c",
        }),
      );
      addSourceToCapsule(env.store, deniedId, sampleSourceInput(deniedSourceId));
      addSourceToCapsule(env.store, aId, sampleSourceInput(aSourceId));
      addSourceToCapsule(env.store, cId, sampleSourceInput(cSourceId));
      seedIndexedDocument(env.store, deniedId, deniedSourceId, "mask-denied");
      seedIndexedDocument(env.store, aId, aSourceId, "mask-denied-a");
      seedIndexedDocument(env.store, cId, cSourceId, "mask-denied-c");
      const set = createCapsuleSet(env.store, {
        id: "set-mask-denied" as CapsuleSetId,
        displayName: "Policy Denied Masking Set",
        tags: [],
        capsuleIds: [deniedId, aId, cId],
      });

      const summary = buildKnowledgePodSetSummary(env.store, set);

      expect(summary.retrieval).toMatchObject({
        embeddingCompatibilityStatus: "incompatible",
        embeddingCompatibilityReason: "provider-mismatch",
      });
      expect(summary.setReadiness?.reasonCodes).toEqual(
        expect.arrayContaining(["embedding-incompatible"]),
      );
      expect(summary.setReadiness?.reasonCodes).not.toEqual(
        expect.arrayContaining(["embedding-unavailable"]),
      );
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
        retrieval: {
          embeddingCompatibilityStatus: "same",
          reindexRecommended: false,
          queryEmbeddingAllowed: true,
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

  it("marks a pod-set unavailable when a member is mid-delete, not draft", () => {
    // AUDIT-E1815-001: capsuleReadiness() maps lifecycleState "deleting" to "unavailable", but
    // setReadiness() re-derives its own branches over the same enum and used to fall through to a
    // hardcoded "draft" for any lifecycle state it did not explicitly recognize, including
    // "deleting". Guard the two functions against drifting back out of sync.
    const env = freshStore();
    try {
      const readyId = "cap-deleting-ready" as KnowledgeCapsuleId;
      const deletingId = "cap-deleting-member" as KnowledgeCapsuleId;
      createCapsule(env.store, sampleCapsuleInput({ id: readyId, lifecycleState: "ready" }));
      createCapsule(env.store, sampleCapsuleInput({ id: deletingId, lifecycleState: "deleting" }));
      const set = createCapsuleSet(env.store, {
        id: "set-deleting-member" as CapsuleSetId,
        displayName: "Deleting Member Set",
        tags: [],
        capsuleIds: [readyId, deletingId],
      });

      const summary = buildKnowledgePodSetSummary(env.store, set);

      expect(summary.readiness).toBe("unavailable");
      expect(validateKnowledgePodSummary(summary).ok).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("locks in the draft fallback for a mixed ready+draft pod-set membership", () => {
    // AUDIT-E1815-002: setReadiness() falls through to "draft" whenever no member is
    // indexing/error/stale and not every member is ready. This composition (an existing ready pod
    // plus a freshly created default-lifecycle draft pod) was reachable but untested; lock in the
    // exact current behavior so a future refactor cannot silently change it without a failing test.
    const env = freshStore();
    try {
      const readyId = "cap-mixed-ready" as KnowledgeCapsuleId;
      const draftId = "cap-mixed-draft" as KnowledgeCapsuleId;
      createCapsule(env.store, sampleCapsuleInput({ id: readyId, lifecycleState: "ready" }));
      createCapsule(env.store, sampleCapsuleInput({ id: draftId }));
      const set = createCapsuleSet(env.store, {
        id: "set-mixed-ready-draft" as CapsuleSetId,
        displayName: "Mixed Ready Draft Set",
        tags: [],
        capsuleIds: [readyId, draftId],
      });

      const summary = buildKnowledgePodSetSummary(env.store, set);

      expect(summary.readiness).toBe("draft");
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

  it("scopes the projection to the requested pod kind", () => {
    const env = freshStore();
    try {
      const capsuleId = "cap-scoped" as KnowledgeCapsuleId;
      createCapsule(env.store, sampleCapsuleInput({ id: capsuleId, lifecycleState: "ready" }));
      createCapsuleSet(env.store, {
        id: "set-scoped" as CapsuleSetId,
        displayName: "Scoped Set",
        tags: [],
        capsuleIds: [capsuleId],
      });

      expect(
        listKnowledgePodSummaries(env.store, "pod").map((summary) => summary.kind),
      ).toStrictEqual(["pod"]);
      expect(
        listKnowledgePodSummaries(env.store, "pod-set").map((summary) => summary.kind),
      ).toStrictEqual(["pod-set"]);
    } finally {
      env.cleanup();
    }
  });

  it("does not fail the pod-set listing when an unrelated standalone capsule is corrupt", () => {
    const env = freshStore();
    try {
      // A healthy pod-set with a healthy member.
      const memberId = "cap-set-member" as KnowledgeCapsuleId;
      createCapsule(env.store, sampleCapsuleInput({ id: memberId, lifecycleState: "ready" }));
      createCapsuleSet(env.store, {
        id: "set-healthy" as CapsuleSetId,
        displayName: "Healthy Set",
        tags: [],
        capsuleIds: [memberId],
      });
      // An unrelated standalone capsule with corrupt state, not a member of any set.
      const strayId = "cap-unrelated-corrupt" as KnowledgeCapsuleId;
      createCapsule(env.store, sampleCapsuleInput({ id: strayId, lifecycleState: "ready" }));
      env.store._internal.db
        .prepare("UPDATE capsules SET vector_metric = 'manhattan' WHERE id = :id")
        .run({ id: strayId });

      // Requesting only pod-sets must not materialize the corrupt standalone capsule.
      const podSets = listKnowledgePodSummaries(env.store, "pod-set");
      expect(podSets.map((summary) => summary.kind)).toStrictEqual(["pod-set"]);
      expect(podSets[0]?.id).toBe("set-healthy");

      // The unscoped listing still fails closed on the corrupt standalone capsule.
      expect(() => listKnowledgePodSummaries(env.store)).toThrow(KnowledgeStoreError);
    } finally {
      env.cleanup();
    }
  });
});
