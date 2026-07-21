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
  schemaVersion: "1",
  cleanCheckout: {
    workspaceRootExists: true,
    keikoStatePresentAtStart: false,
    buildArtifactsPresentAtStart: false,
    indexedPathsRequested: 3,
    indexedPathsResolved: 3,
    fingerprintCount: 3,
  },
  annActive: {
    provider: "sqlite-vec",
    status: "available",
    forbiddenStatusesAvoided: ["fallback-encrypted-store", "sqlite-vec-runtime-not-configured"],
    active: true,
  },
  multiFileQuery: {
    queryHash: "0".repeat(64),
    referenceCount: 3,
    citationCount: 3,
    distinctFileCount: 2,
    spansMultipleFiles: true,
    citationFiles: ["a.ts", "b.ts"],
    citationLinesResolved: true,
    fileLineHash: "1".repeat(64),
  },
  abstention: { queryHash: "2".repeat(64), references: 0, noEvidence: true, abstained: true },
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

describe("evaluateAcceptanceCriteria — ann-active failures", () => {
  it("flags an unexpected provider that is not sqlite-vec", () => {
    const evidence = overlay({
      annActive: { provider: "brute-force", status: "available", active: true },
    });
    expect(failuresFor("ann-active", evidence)).toContain("unexpected-provider:brute-force");
  });

  it("flags a forbidden status even when `active: true` is claimed", () => {
    const evidence = overlay({
      annActive: {
        provider: "sqlite-vec",
        status: "sqlite-vec-runtime-not-configured",
        active: true,
      },
    });
    expect(failuresFor("ann-active", evidence)).toContain(
      "forbidden-status:sqlite-vec-runtime-not-configured",
    );
  });

  it("flags when the annActive record is missing entirely", () => {
    const evidence = overlay({ annActive: undefined });
    expect(failuresFor("ann-active", evidence)).toContain("missing:annActive");
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
