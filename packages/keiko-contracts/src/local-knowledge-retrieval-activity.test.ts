import { describe, expect, it } from "vitest";

import type { KnowledgeCapsuleId, KnowledgeSourceId } from "./local-knowledge.js";
import {
  KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_SCHEMA_VERSION,
  isKnowledgePodRetrievalActivitySafeText,
  validateKnowledgePodRetrievalActivity,
  type KnowledgePodRetrievalActivity,
} from "./local-knowledge-retrieval-activity.js";

function happyActivity(): KnowledgePodRetrievalActivity {
  return {
    schemaVersion: KNOWLEDGE_POD_RETRIEVAL_ACTIVITY_SCHEMA_VERSION,
    summary: {
      searchedCount: 1,
      skippedCount: 1,
      degradedCount: 1,
      deniedCount: 1,
      unavailableCount: 1,
      notSelectedCount: 1,
      denseCandidateCount: 8,
      lexicalCandidateCount: 5,
      fusedCandidateCount: 10,
      referenceCount: 3,
      citationCount: 2,
    },
    privacy: {
      localFirst: true,
      rawContentExposed: false,
      rawQueryExposed: false,
      privatePathsExposed: false,
      directVectorScoreComparison: false,
    },
    pods: [
      {
        podId: "cap-searched" as KnowledgeCapsuleId,
        podKind: "pod",
        displayName: "Searched Pod",
        state: "searched",
        modes: ["local-only", "hybrid", "lexical", "vector", "reranked"],
        reasonCodes: ["selected-for-search", "searched"],
        sourceIds: ["src-1" as KnowledgeSourceId],
        counts: {
          sourceCount: 1,
          documentCount: 2,
          chunkCount: 4,
          vectorCount: 4,
          referenceCount: 3,
          citationCount: 2,
        },
      },
      {
        podId: "cap-skipped" as KnowledgeCapsuleId,
        podKind: "pod",
        displayName: "Skipped Pod",
        state: "skipped",
        modes: ["local-only"],
        reasonCodes: ["source-skipped"],
        sourceIds: [],
        counts: {
          sourceCount: 0,
          documentCount: 0,
          chunkCount: 0,
          vectorCount: 0,
          referenceCount: 0,
          citationCount: 0,
        },
      },
      {
        podId: "cap-degraded" as KnowledgeCapsuleId,
        podKind: "pod",
        displayName: "Degraded Pod",
        state: "degraded",
        modes: ["local-only", "lexical"],
        reasonCodes: ["embedding-failed"],
        sourceIds: ["src-2" as KnowledgeSourceId],
        counts: {
          sourceCount: 1,
          documentCount: 1,
          chunkCount: 2,
          vectorCount: 2,
          referenceCount: 0,
          citationCount: 0,
        },
      },
      {
        podId: "cap-denied" as KnowledgeCapsuleId,
        podKind: "pod",
        displayName: "Denied Pod",
        state: "denied",
        modes: ["local-only", "vector"],
        reasonCodes: ["answer-grounding-rejected"],
        sourceIds: ["src-3" as KnowledgeSourceId],
        counts: {
          sourceCount: 1,
          documentCount: 1,
          chunkCount: 2,
          vectorCount: 2,
          referenceCount: 0,
          citationCount: 0,
        },
      },
      {
        podId: "cap-unavailable" as KnowledgeCapsuleId,
        podKind: "pod",
        displayName: "Unavailable Pod",
        state: "unavailable",
        modes: ["local-only"],
        reasonCodes: ["no-vectors"],
        sourceIds: ["src-4" as KnowledgeSourceId],
        counts: {
          sourceCount: 1,
          documentCount: 0,
          chunkCount: 0,
          vectorCount: 0,
          referenceCount: 0,
          citationCount: 0,
        },
      },
      {
        podId: "cap-not-selected" as KnowledgeCapsuleId,
        podKind: "pod",
        displayName: "Not Selected Pod",
        state: "not-selected",
        modes: ["local-only", "vector"],
        reasonCodes: ["not-selected"],
        sourceIds: ["src-5" as KnowledgeSourceId],
        counts: {
          sourceCount: 1,
          documentCount: 2,
          chunkCount: 4,
          vectorCount: 4,
          referenceCount: 0,
          citationCount: 0,
        },
      },
    ],
  };
}

function invalidErrors(
  result: ReturnType<typeof validateKnowledgePodRetrievalActivity>,
): readonly string[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected invalid retrieval activity");
  return result.errors;
}

describe("validateKnowledgePodRetrievalActivity", () => {
  it("accepts every retrieval activity state and future participation posture token", () => {
    const result = validateKnowledgePodRetrievalActivity(happyActivity());
    expect(result.ok).toBe(true);
  });

  it("rejects unexpected raw-content fields", () => {
    const result = validateKnowledgePodRetrievalActivity({
      ...happyActivity(),
      rawQuery: "customer acquisition target",
    });
    expect(invalidErrors(result)).toContain("activity must not include rawQuery");
  });

  it("rejects malformed unknown states, modes, and reason codes", () => {
    const [pod] = happyActivity().pods;
    const result = validateKnowledgePodRetrievalActivity({
      ...happyActivity(),
      pods: [
        {
          ...pod,
          state: "streaming",
          modes: ["vector-score-mixed"],
          reasonCodes: ["provider-openai-timeout"],
        },
      ],
    });
    expect(invalidErrors(result)).toEqual(
      expect.arrayContaining([
        "pod.state is invalid",
        "pod.modes entries are invalid",
        "pod.reasonCodes entries are invalid",
      ]),
    );
  });

  it("rejects raw body and query fields by allowlist", () => {
    const [pod] = happyActivity().pods;
    const result = validateKnowledgePodRetrievalActivity({
      ...happyActivity(),
      pods: [
        {
          ...pod,
          rawBody: "synthetic customer narrative",
          queryText: "synthetic query text",
        },
      ],
    });
    expect(invalidErrors(result)).toContain("pod must not include rawBody");
  });

  it("rejects path, endpoint, token, and PII-like display strings", () => {
    for (const displayName of [
      "/Users/alice/private/customer.pdf",
      "https://gateway.example.test/v1",
      "Bearer secret-token-value",
      "alice@example.com",
      "555-11-2222",
    ]) {
      const [pod] = happyActivity().pods;
      const result = validateKnowledgePodRetrievalActivity({
        ...happyActivity(),
        pods: [{ ...pod, displayName }],
      });
      expect(invalidErrors(result)).toContain("pod.displayName must be evidence-safe");
    }
  });

  it("exposes the same safe-text predicate for activity producers", () => {
    expect(isKnowledgePodRetrievalActivitySafeText("Policy Pod")).toBe(true);
    expect(isKnowledgePodRetrievalActivitySafeText("https://example.test/path")).toBe(false);
    expect(isKnowledgePodRetrievalActivitySafeText("alice@example.com")).toBe(false);
  });

  it("requires privacy flags to stay fail-closed", () => {
    const result = validateKnowledgePodRetrievalActivity({
      ...happyActivity(),
      privacy: {
        ...happyActivity().privacy,
        rawQueryExposed: true,
      },
    });
    expect(invalidErrors(result)).toContain(
      "privacy must preserve the retrieval activity redaction posture",
    );
  });

  it("requires non-negative counts", () => {
    const result = validateKnowledgePodRetrievalActivity({
      ...happyActivity(),
      summary: {
        ...happyActivity().summary,
        referenceCount: -1,
      },
    });
    expect(invalidErrors(result)).toContain(
      "summary.referenceCount must be a non-negative integer",
    );
  });
});
