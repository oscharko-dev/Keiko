// Unit tests for the clean-checkout demo's evidence validators (Issue #2634). The E2E suite in
// `knowledge-m2-clean-checkout-demo.test.mjs` exercises the happy path and a handful of the most
// important refusals; this file drives every remaining validator failure branch directly so lcov
// records them and Sonar's new-code coverage floor is met without turning the E2E suite into a
// pile of contrived evidence dictionaries.

import { describe, expect, it } from "vitest";

import {
  evaluateAcceptanceCriteria,
  evidenceRedactionFailures,
  validateEvidenceContract,
} from "../lib/clean-checkout-demo.mjs";

const BASE = Object.freeze({
  demo: "knowledge-m2-clean-checkout",
  issue: "#2634",
  schemaVersion: "3",
  executionMode: "acceptance",
  acceptanceEligible: true,
  cleanCheckout: {
    workspaceRootExists: true,
    keikoStatePresentAtStart: false,
    buildArtifactsPresentAtStart: false,
    indexedPathsRequested: 3,
    indexedPathsResolved: 3,
    fingerprintCount: 3,
  },
  vectorIndex: {
    provider: "usearch",
    status: "available",
    searchMode: "exact",
    forbiddenStatusesAvoided: [
      "disabled",
      "fallback-unavailable",
      "fallback-encrypted-store",
      "fallback-unsupported-metric",
      "fallback-incompatible-identity",
      "fallback-index-too-large",
      "fallback-query-error",
    ],
    providerAvailable: true,
    hnswQualifiedBy: "npm run check:knowledge-m2-closeout",
  },
  multiFileQuery: {
    queryHash: "0".repeat(64),
    referenceCount: 3,
    attachedCitationCount: 3,
    citationCount: 3,
    generatedCharacters: 80,
    generationHash: "5".repeat(64),
    noEvidence: false,
    distinctFileCount: 2,
    spansMultipleFiles: true,
    citationFiles: ["a.ts", "b.ts"],
    citationLinesResolved: true,
    fileLineHash: "1".repeat(64),
  },
  abstention: {
    queryHash: "2".repeat(64),
    references: 0,
    citations: 0,
    generatedCharacters: 0,
    generationCalls: 0,
    noEvidence: true,
    abstained: true,
  },
  reranker: {
    enabled: {
      policyExternalReranking: "allow",
      diagnosticStatus: "applied",
      selectedOrderHash: "3".repeat(64),
      candidateCount: 3,
      documentCount: 3,
      keptCount: 3,
    },
    disabled: {
      policyExternalReranking: "deny",
      diagnosticStatus: "denied",
      diagnosticFailureKind: "policy-denied",
      selectedOrderHash: "4".repeat(64),
      candidateCount: 3,
      documentCount: 0,
      keptCount: 3,
    },
    answerPathDiffers: true,
  },
  toolchain: { node: "24.18.0", platform: "linux", arch: "x64" },
  elapsedMs: 42,
});

function overlay(patch) {
  const draft = structuredClone(BASE);
  for (const [key, value] of Object.entries(patch)) {
    draft[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...draft[key], ...value }
        : value;
  }
  return draft;
}

function failuresFor(id, evidence) {
  const acceptance = evaluateAcceptanceCriteria(evidence);
  const result = acceptance.results.find((entry) => entry.id === id);
  return result?.failures ?? [];
}

describe("evidenceRedactionFailures", () => {
  it("accepts the baseline evidence", () => {
    expect(evidenceRedactionFailures(BASE)).toEqual([]);
  });

  it("rejects an endpoint URL anywhere in the record", () => {
    const leaked = overlay({ multiFileQuery: { leaked: "https://provider.example.com/v1" } });
    expect(evidenceRedactionFailures(leaked)).toContain("endpoint");
  });

  it("rejects a credential label anywhere in the record", () => {
    const leaked = overlay({ multiFileQuery: { debugField: "api_key redacted" } });
    expect(evidenceRedactionFailures(leaked)).toContain("credential-label");
  });

  it("rejects body-material phrases anywhere in the record", () => {
    const leaked = overlay({
      multiFileQuery: { citationNote: "raw text of the response body" },
    });
    expect(evidenceRedactionFailures(leaked)).toContain("body-material");
  });
});

describe("evaluateAcceptanceCriteria — vector-index-active failures", () => {
  it("flags an unexpected provider that is not USearch", () => {
    const evidence = overlay({
      vectorIndex: { provider: "brute-force", status: "available", providerAvailable: true },
    });
    expect(failuresFor("vector-index-active", evidence)).toContain(
      "unexpected-provider:brute-force",
    );
  });

  it("flags a forbidden status even when availability is claimed", () => {
    const evidence = overlay({
      vectorIndex: {
        provider: "usearch",
        status: "fallback-unavailable",
        providerAvailable: true,
      },
    });
    expect(failuresFor("vector-index-active", evidence)).toContain(
      "forbidden-status:fallback-unavailable",
    );
  });

  it("rejects a claim that the small clean-demo corpus ran HNSW", () => {
    const evidence = overlay({ vectorIndex: { searchMode: "ann", providerAvailable: true } });
    expect(failuresFor("vector-index-active", evidence)).toContain(
      "unexpected-small-corpus-search-mode:ann",
    );
  });

  it("rejects evidence that omits a fail-closed status from its declared set", () => {
    const evidence = overlay({
      vectorIndex: { forbiddenStatusesAvoided: ["fallback-unavailable"] },
    });
    expect(failuresFor("vector-index-active", evidence)).toContain("forbidden-status-set-mismatch");
  });

  it("flags when the vectorIndex record is missing entirely", () => {
    const evidence = overlay({ vectorIndex: undefined });
    expect(failuresFor("vector-index-active", evidence)).toContain("missing:vectorIndex");
  });

  it("requires the real HNSW scale qualification reference", () => {
    const evidence = overlay({ vectorIndex: { hnswQualifiedBy: undefined } });
    expect(failuresFor("vector-index-active", evidence)).toContain(
      "missing-hnsw-qualification-reference",
    );
  });
});

describe("evaluateAcceptanceCriteria — multi-file citation failures", () => {
  it("flags a single-file result when distinctFileCount === 1", () => {
    const evidence = overlay({
      multiFileQuery: { distinctFileCount: 1, spansMultipleFiles: false },
    });
    const failures = failuresFor("multi-file-citations", evidence);
    expect(failures).toContain("single-file-only:1");
    expect(failures).toContain("does-not-span-multiple-files");
  });

  it("flags line-range non-resolution", () => {
    const evidence = overlay({ multiFileQuery: { citationLinesResolved: false } });
    expect(failuresFor("multi-file-citations", evidence)).toContain("lines-unresolved");
  });

  it("flags when citationCount is zero", () => {
    const evidence = overlay({ multiFileQuery: { citationCount: 0 } });
    expect(failuresFor("multi-file-citations", evidence)).toContain("no-citations");
  });

  it("rejects retrieval-only evidence with no generated text or attached citations", () => {
    const evidence = overlay({
      multiFileQuery: {
        generatedCharacters: 0,
        generationHash: "not-a-hash",
        attachedCitationCount: 0,
      },
    });
    const failures = failuresFor("multi-file-citations", evidence);
    expect(failures).toContain("no-generated-text");
    expect(failures).toContain("invalid-generation-hash");
    expect(failures).toContain("no-attached-citations");
  });
});

describe("evaluateAcceptanceCriteria — reranker toggle failures", () => {
  it("flags an enabled policy that is not `allow`", () => {
    const evidence = overlay({
      reranker: {
        ...BASE.reranker,
        enabled: { ...BASE.reranker.enabled, policyExternalReranking: "deny" },
      },
    });
    expect(failuresFor("reranker-toggle", evidence)).toContain("enabled-policy-not-allow");
  });

  it("flags a disabled policy that is not `deny`", () => {
    const evidence = overlay({
      reranker: {
        ...BASE.reranker,
        disabled: { ...BASE.reranker.disabled, policyExternalReranking: "allow" },
      },
    });
    expect(failuresFor("reranker-toggle", evidence)).toContain("disabled-policy-not-deny");
  });

  it("flags when reranker is missing entirely", () => {
    const evidence = overlay({ reranker: undefined });
    expect(failuresFor("reranker-toggle", evidence)).toContain("missing:reranker");
  });
});

describe("evaluateAcceptanceCriteria — abstention failures", () => {
  it("flags when abstention is missing entirely", () => {
    const evidence = overlay({ abstention: undefined });
    expect(failuresFor("abstention", evidence)).toContain("missing:abstention");
  });

  it("rejects a claimed abstention that called generation or emitted text", () => {
    const evidence = overlay({
      abstention: { generationCalls: 1, generatedCharacters: 12, abstained: true },
    });
    const failures = failuresFor("abstention", evidence);
    expect(failures).toContain("generation-calls:1");
    expect(failures).toContain("generated-characters:12");
  });
});

describe("evaluateAcceptanceCriteria — clean-checkout failures", () => {
  it("flags a missing cleanCheckout record", () => {
    const evidence = overlay({ cleanCheckout: undefined });
    expect(failuresFor("clean-checkout", evidence)).toContain("missing:cleanCheckout");
  });

  it("flags a missing workspace root", () => {
    const evidence = overlay({ cleanCheckout: { workspaceRootExists: false } });
    expect(failuresFor("clean-checkout", evidence)).toContain("workspace-root-missing");
  });
});

describe("validateEvidenceContract", () => {
  it("returns ['not-an-object'] for null / non-object input", () => {
    expect(validateEvidenceContract(null)).toEqual(["not-an-object"]);
    expect(validateEvidenceContract("string")).toEqual(["not-an-object"]);
  });

  it("flags a mismatched demo id", () => {
    const failures = validateEvidenceContract(overlay({ demo: "something-else" }));
    expect(failures.some((entry) => entry.startsWith("demo-id:"))).toBe(true);
  });

  it("flags a mismatched issue reference", () => {
    const failures = validateEvidenceContract(overlay({ issue: "#9999" }));
    expect(failures.some((entry) => entry.startsWith("issue-ref:"))).toBe(true);
  });

  it("flags a mismatched schema version", () => {
    const failures = validateEvidenceContract(overlay({ schemaVersion: "42" }));
    expect(failures.some((entry) => entry.startsWith("schema-version:"))).toBe(true);
  });

  it("flags an unknown execution mode or inconsistent acceptance eligibility", () => {
    expect(
      validateEvidenceContract(overlay({ executionMode: "mock", acceptanceEligible: false })),
    ).toContain("execution-mode:mock");
    expect(
      validateEvidenceContract(
        overlay({ executionMode: "hermetic-test", acceptanceEligible: true }),
      ),
    ).toContain("acceptance-eligibility");
  });

  it("flags a non-numeric elapsedMs", () => {
    const failures = validateEvidenceContract(overlay({ elapsedMs: "fast" }));
    expect(failures).toContain("elapsed-ms");
  });

  it("flags a negative elapsedMs", () => {
    const failures = validateEvidenceContract(overlay({ elapsedMs: -1 }));
    expect(failures).toContain("elapsed-ms");
  });

  it("returns an empty failure list on the baseline evidence", () => {
    expect(validateEvidenceContract(BASE)).toEqual([]);
  });
});
