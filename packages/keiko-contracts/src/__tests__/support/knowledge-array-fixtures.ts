import {
  LOCAL_KNOWLEDGE_SCHEMA_VERSION,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
} from "../../local-knowledge.js";
import {
  KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION,
  type KnowledgePodSummary,
} from "../../local-knowledge-pods.js";
import { resolveKnowledgePodModelUsePolicy } from "../../local-knowledge-model-use-policy.js";

export function capsuleInput(): Record<string, unknown> {
  // Existing happyCapsule data shape from local-knowledge.test.ts:75; no ID cast.
  // Both lineage strings acquire only the parser's actual nominal separation.
  return {
    id: "cap-1",
    displayName: "Risk Controls Library",
    tags: ["compliance"],
    sourceIds: ["src-1"],
    retrievalEffort: "default",
    outputMode: "answers",
    answerGroundingPolicy: "require-citations",
    lifecycleState: "ready",
    embeddingModelIdentity: {
      provider: "keiko",
      modelId: "embed-1",
      vectorDimensions: 1536,
      vectorMetric: "cosine",
    },
    storageReference: "capsules/cap-1",
    createdAt: 1,
    updatedAt: 2,
  };
}

function summaryRetrieval(): KnowledgePodSummary["retrieval"] {
  return {
    lexicalIndex: true,
    vectorIndex: true,
    hybridGrounding: true,
    crossSpaceScoreMixing: false,
    embeddingProvider: "openai-compatible:3f65d1e8",
    embeddingModelId: "text-embedding-3-small",
    embeddingSpaceFingerprint: "space-v1",
    vectorDimensions: 1536,
    vectorMetric: "cosine",
  };
}

export function happySummary(): KnowledgePodSummary {
  return {
    schemaVersion: KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION,
    id: "cap-risk-controls" as KnowledgePodSummary["id"],
    kind: "pod",
    displayName: "Risk Controls Pod",
    description: "Policy and engineering guidance",
    tags: ["policy", "engineering"],
    readiness: "ready",
    lifecycleState: "ready",
    counts: {
      capsuleCount: 1,
      sourceCount: 2,
      documentCount: 12,
      chunkCount: 48,
      vectorCount: 48,
    },
    sourceKinds: ["folder", "repository"],
    retrieval: summaryRetrieval(),
    privacy: {
      localFirst: true,
      modelOpen: true,
      rawContentExposed: false,
      privatePathsExposed: false,
      evidenceMode: "counts-hashes-and-status",
      storageLocation: "local-runtime-state",
    },
    governance: {
      locationKind: "local",
      sealingPosture: "local-store-policy",
      policyPosture: "not-declared",
      managedServiceDependency: false,
    },
    modelUsePolicy: resolveKnowledgePodModelUsePolicy(undefined),
    compatibility: {
      backingKind: "knowledge-capsule",
      capsuleIds: ["cap-risk-controls" as KnowledgeCapsuleId],
      sourceIds: ["src-risk-controls" as KnowledgeSourceId],
      localKnowledgeSchemaVersion: LOCAL_KNOWLEDGE_SCHEMA_VERSION,
      migrationRequired: false,
      persistedStateRenamed: false,
    },
    updatedAt: 1_700_000_000_000,
    degradationReasons: [],
  };
}
