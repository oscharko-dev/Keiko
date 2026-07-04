import { describe, expect, it } from "vitest";

import {
  LOCAL_KNOWLEDGE_SCHEMA_VERSION,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
} from "./local-knowledge.js";
import {
  KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION,
  isKnowledgePodEvidenceSafeText,
  validateKnowledgePodSummary,
  type KnowledgePodSummary,
} from "./local-knowledge-pods.js";

function happySummary(): KnowledgePodSummary {
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
    retrieval: {
      lexicalIndex: true,
      vectorIndex: true,
      hybridGrounding: true,
      crossSpaceScoreMixing: false,
      embeddingProvider: "openai-compatible:3f65d1e8",
      embeddingModelId: "text-embedding-3-small",
      embeddingSpaceFingerprint: "space-v1",
      vectorDimensions: 1536,
      vectorMetric: "cosine",
    },
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
      policyPosture: "none",
      managedServiceDependency: false,
    },
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

function invalidErrors(result: ReturnType<typeof validateKnowledgePodSummary>): readonly string[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected invalid Knowledge Pod summary");
  return result.errors;
}

describe("validateKnowledgePodSummary", () => {
  it("exposes the evidence-safe text predicate used by summary producers", () => {
    expect(isKnowledgePodEvidenceSafeText("Policy Pod")).toBe(true);
    expect(isKnowledgePodEvidenceSafeText("/Users/alice/customer/private.pdf")).toBe(false);
  });

  it("accepts a body-free Knowledge Pod summary over existing Local Knowledge state", () => {
    const result = validateKnowledgePodSummary(happySummary());
    expect(result.ok).toBe(true);
  });

  it("rejects unexpected raw-content fields", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      rawDocumentBody: "customer contract body",
    });
    expect(invalidErrors(result)).toContain("summary must not include rawDocumentBody");
  });

  it("rejects absolute private paths in display strings", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      displayName: "/Users/alice/customer/private.pdf",
    });
    expect(invalidErrors(result)).toContain("summary.displayName must be an evidence-safe string");
  });

  it("rejects secret-shaped strings in degradation reasons", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      degradationReasons: ["Gateway returned Bearer secret-token-value"],
    });
    expect(invalidErrors(result)).toContain(
      "summary.degradationReasons entries must be evidence-safe strings",
    );
  });

  it("rejects token-bearing endpoint values in retrieval metadata", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      retrieval: {
        ...happySummary().retrieval,
        embeddingProvider: "https://example.test/embed?api_key=secret-value",
      },
    });
    expect(invalidErrors(result)).toContain(
      "retrieval.embeddingProvider must be an evidence-safe string when set",
    );
  });

  it("checks repeated URL-like text for token query keys without regex backtracking", () => {
    const repeatedUrlText = `${"http://".repeat(200)}example.test/path`;
    const repeatedTokenEndpoint = `${repeatedUrlText}?access_token=secret-value`;

    expect(isKnowledgePodEvidenceSafeText(repeatedUrlText)).toBe(true);
    expect(isKnowledgePodEvidenceSafeText(repeatedTokenEndpoint)).toBe(false);
  });

  it("requires compatibility to keep persisted Local Knowledge state unmigrated", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      compatibility: {
        ...happySummary().compatibility,
        migrationRequired: true,
      },
    });
    expect(invalidErrors(result)).toContain(
      "compatibility must preserve Local Knowledge state compatibility",
    );
  });

  it("requires explicit local or future-governed pod posture metadata", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      governance: {
        locationKind: "hosted-cloud",
        sealingPosture: "local-store-policy",
        policyPosture: "none",
        managedServiceDependency: false,
      },
    });
    expect(invalidErrors(result)).toContain("governance.locationKind is invalid");
  });
});
