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
import { resolveKnowledgePodModelUsePolicy } from "./local-knowledge-model-use-policy.js";

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

  it("accepts closed pod-set readiness counts and reason codes", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      kind: "pod-set",
      compatibility: {
        ...happySummary().compatibility,
        backingKind: "capsule-set",
      },
      counts: {
        ...happySummary().counts,
        capsuleCount: 3,
      },
      setReadiness: {
        readyCount: 1,
        draftCount: 0,
        degradedCount: 1,
        unavailableCount: 0,
        deniedCount: 1,
        indexingCount: 1,
        staleCount: 0,
        errorCount: 0,
        missingCount: 0,
        reasonCodes: ["member-indexing", "member-degraded", "policy-denied"],
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects malformed pod-set readiness metadata", () => {
    const invalidCode = validateKnowledgePodSummary({
      ...happySummary(),
      kind: "pod-set",
      compatibility: { ...happySummary().compatibility, backingKind: "capsule-set" },
      setReadiness: {
        readyCount: 1,
        draftCount: 0,
        degradedCount: 0,
        unavailableCount: 0,
        deniedCount: 0,
        indexingCount: 0,
        staleCount: 0,
        errorCount: 0,
        missingCount: 0,
        reasonCodes: ["raw-provider-error"],
      },
    });
    const nonSet = validateKnowledgePodSummary({
      ...happySummary(),
      setReadiness: {
        readyCount: 1,
        draftCount: 0,
        degradedCount: 0,
        unavailableCount: 0,
        deniedCount: 0,
        indexingCount: 0,
        staleCount: 0,
        errorCount: 0,
        missingCount: 0,
        reasonCodes: [],
      },
    });
    const mismatch = validateKnowledgePodSummary({
      ...happySummary(),
      kind: "pod-set",
      compatibility: { ...happySummary().compatibility, backingKind: "capsule-set" },
      setReadiness: {
        readyCount: 0,
        draftCount: 0,
        degradedCount: 0,
        unavailableCount: 0,
        deniedCount: 0,
        indexingCount: 0,
        staleCount: 0,
        errorCount: 0,
        missingCount: 0,
        reasonCodes: [],
      },
    });

    expect(invalidErrors(invalidCode)).toContain(
      "setReadiness.reasonCodes entries must be known reason codes",
    );
    expect(invalidErrors(nonSet)).toContain("setReadiness is only valid for pod-set summaries");
    expect(invalidErrors(mismatch)).toContain(
      "setReadiness member counts must match counts.capsuleCount",
    );
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

  it("rejects absolute, home-relative, UNC, and temporary path variants", () => {
    for (const displayName of [
      "~/customer/private.pdf",
      String.raw`\\server\share\customer.pdf`,
      String.raw`C:\Users\alice\customer\private.pdf`,
      "C:/Users/alice/customer/private.pdf",
      "/tmp/customer/private.pdf",
      "/private/var/folders/customer/private.pdf",
      "file:///Users/alice/customer/private.pdf",
    ]) {
      const result = validateKnowledgePodSummary({ ...happySummary(), displayName });
      expect(invalidErrors(result)).toContain(
        "summary.displayName must be an evidence-safe string",
      );
    }
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

  it("rejects endpoint-like values in retrieval metadata", () => {
    for (const embeddingProvider of [
      "https://example.test/embed",
      "//gateway.example.test/embed",
      "gateway.internal/v1",
      "localhost:11434/v1",
      "127.0.0.1:11434/v1",
      "[::1]:11434/v1",
      "[2001:db8::1]:443/v1",
      "https://example.test/embed?api_key=secret-value",
      "gateway.internal/v1?api_key=secret-value",
      "wss://gateway.example.test/embed?access_token=secret-value",
      "https://example.test/embed?client_secret=secret-value",
      "https://example.test/embed?refresh_token=secret-value",
      "https://example.test/embed?auth[x-access-token]=secret-value",
      "https://user:secret@example.test/embed",
      "user:secret@example.test/embed",
    ]) {
      const result = validateKnowledgePodSummary({
        ...happySummary(),
        retrieval: { ...happySummary().retrieval, embeddingProvider },
      });
      expect(invalidErrors(result)).toContain(
        "retrieval.embeddingProvider must be an evidence-safe string when set",
      );
    }
  });

  it("checks endpoint and token parameter text without regex backtracking", () => {
    const repeatedSafeText = `${"pod-reference ".repeat(200)}example`;
    const repeatedEndpoint = `${"http://".repeat(200)}example.test/path`;
    const repeatedSchemeEndpoint = `${"A".repeat(1_000)}://example.test/path`;
    const repeatedUserInfoEndpoint = `${"!".repeat(1_000)}@example.test/path`;
    const encodedTokenEndpoint = "gateway.internal/v1?%61ccess_token=secret-value";
    const encodedSecretEndpoint = "gateway.internal/v1?%63lient_secret=secret-value";
    const fragmentTokenText = "pod metadata #access_token=secret-value";

    expect(isKnowledgePodEvidenceSafeText(repeatedSafeText)).toBe(true);
    expect(isKnowledgePodEvidenceSafeText(repeatedEndpoint)).toBe(false);
    expect(isKnowledgePodEvidenceSafeText(repeatedSchemeEndpoint)).toBe(false);
    expect(isKnowledgePodEvidenceSafeText(repeatedUserInfoEndpoint)).toBe(false);
    expect(isKnowledgePodEvidenceSafeText(encodedTokenEndpoint)).toBe(false);
    expect(isKnowledgePodEvidenceSafeText(encodedSecretEndpoint)).toBe(false);
    expect(isKnowledgePodEvidenceSafeText(fragmentTokenText)).toBe(false);
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

  it("rejects invalid model-use policy summary metadata", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      modelUsePolicy: {
        source: "remote-policy-plane",
        mode: "sealed-local",
        operations: {
          ...happySummary().modelUsePolicy.operations,
          externalEmbeddings: "inherit",
        },
      },
    });

    expect(invalidErrors(result)).toEqual(
      expect.arrayContaining([
        "modelUsePolicy.source is invalid",
        "modelUsePolicy.operations.externalEmbeddings is invalid",
      ]),
    );
  });

  it("rejects invalid lifecycle and retrieval enum metadata", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      lifecycleState: "published",
      retrieval: {
        ...happySummary().retrieval,
        vectorDimensions: 0,
        vectorMetric: "jaccard",
      },
    });

    expect(invalidErrors(result)).toEqual(
      expect.arrayContaining([
        "summary.lifecycleState is invalid",
        "retrieval.vectorDimensions must be a positive integer when set",
        "retrieval.vectorMetric is invalid when set",
      ]),
    );
  });

  it("rejects negative timestamps", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      updatedAt: -1,
    });

    expect(invalidErrors(result)).toContain(
      "summary.updatedAt must be a finite non-negative number",
    );
  });

  it("rejects non-primitive retrieval metadata values", () => {
    const result = validateKnowledgePodSummary({
      ...happySummary(),
      retrieval: {
        ...happySummary().retrieval,
        vectorDimensions: { leak: "/tmp/x" },
        vectorMetric: { leak: "/tmp/x" },
      },
    });

    expect(invalidErrors(result)).toEqual(
      expect.arrayContaining([
        "retrieval.vectorDimensions must be a positive integer when set",
        "retrieval.vectorMetric is invalid when set",
      ]),
    );
  });
});
