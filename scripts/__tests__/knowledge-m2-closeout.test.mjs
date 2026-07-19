import { describe, expect, it, vi } from "vitest";

import {
  PROOF_IDS,
  evaluateAnnProof,
  evaluateBookkeepingProof,
  evaluateEvalProof,
  evaluateFacadeProof,
  evaluateProofSet,
  evaluateRepositoryPodProof,
  evaluateWireProof,
  evidenceRedactionFailures,
  renderKnowledgeM2Evidence,
  rerankerImportProofFromEntries,
  runKnowledgeM2CloseoutGate,
  sha256,
  stableStringify,
} from "../lib/knowledge-m2-closeout.mjs";

const FACADE = "packages/keiko-server/src/grounded-rerank-facade.ts";

function annInput(overrides = {}) {
  return {
    vectorRows: 20_001,
    exactScanCap: 20_000,
    activeStatus: "available",
    recalls: [1, 1, 1],
    annMedianLatency: "<=100ms",
    annP95Latency: "<=250ms",
    exactMedianLatency: "<=25ms",
    exactP95Latency: "<=50ms",
    encryptedStatus: "fallback-encrypted-store",
    loadFailureReason: "sqlite-vec-extension-load-failed",
    disabledStatus: "disabled",
    partitionViolations: 0,
    ...overrides,
  };
}

function facadeInput(overrides = {}) {
  return {
    importers: [FACADE],
    configuredBypassCallers: [],
    missingDiagnosticFields: [],
    importerHash: "a".repeat(64),
    ...overrides,
  };
}

function evalInput(overrides = {}) {
  return {
    firstHash: "b".repeat(64),
    secondHash: "b".repeat(64),
    fixtureCount: 29,
    regressionProbeCount: 16,
    regressionProbesLive: true,
    tautologyDetected: true,
    groundedGateOk: true,
    faithfulnessGateOk: true,
    ...overrides,
  };
}

function wireInput(overrides = {}) {
  return {
    wireHash: "c".repeat(64),
    expectedWireHash: "c".repeat(64),
    neutralPurpose: "chat-grounding",
    editorRejectedNeutralPurpose: true,
    ...overrides,
  };
}

function podInput(overrides = {}) {
  return {
    scorecardOk: true,
    providerName: "configured-repo-semantic-search",
    askTimeDocumentEmbeddingCount: 0,
    caseCount: 10,
    fingerprintCount: 10,
    indexedPathCount: 10,
    alignedVectorCount: 10,
    retrievalModeHash: "d".repeat(64),
    editorProviderStatus: "lexical-only",
    ...overrides,
  };
}

function bookkeepingInput(overrides = {}) {
  return {
    items: [
      { id: "hs6-window-closure", status: "ready" },
      { id: "matrix-a-substrate-delta", status: "ready" },
    ],
    ...overrides,
  };
}

function passingResults() {
  return [
    evaluateAnnProof(annInput()),
    evaluateFacadeProof(facadeInput()),
    evaluateEvalProof(evalInput()),
    evaluateWireProof(wireInput()),
    evaluateRepositoryPodProof(podInput()),
    evaluateBookkeepingProof(bookkeepingInput()),
  ];
}

describe("Knowledge M2 closeout proof evaluators", () => {
  it("accepts the complete composed proof", () => {
    const results = passingResults();
    expect(results.every((result) => result.ok)).toBe(true);
    expect(evaluateProofSet(results)).toEqual({ ok: true, failedProofs: [] });
  });

  it("fails every ANN negative control closed", () => {
    const failures = [
      { vectorRows: 20_000 },
      { activeStatus: "disabled" },
      { recalls: [1, 0.9] },
      { encryptedStatus: "available" },
      { loadFailureReason: "unexpected" },
      { disabledStatus: "available" },
      { partitionViolations: 1 },
    ];
    expect(failures.every((override) => !evaluateAnnProof(annInput(override)).ok)).toBe(true);
  });

  it("detects a second facade-bypassing importer", () => {
    const entries = [
      {
        path: FACADE,
        source: 'import { requestLiteLLMRerank } from "@oscharko-dev/keiko-model-gateway";',
      },
      {
        path: "packages/keiko-server/src/bypass.ts",
        source: 'import { requestLiteLLMRerank } from "@oscharko-dev/keiko-model-gateway";',
      },
    ];
    const scanned = rerankerImportProofFromEntries(entries);
    expect(evaluateFacadeProof({ ...facadeInput(), ...scanned }).ok).toBe(false);
    expect(evaluateFacadeProof(facadeInput({ configuredBypassCallers: ["bypass.ts"] })).ok).toBe(
      false,
    );
    expect(evaluateFacadeProof(facadeInput({ missingDiagnosticFields: ["status"] })).ok).toBe(
      false,
    );
  });

  it("fails every evaluation-harness negative control closed", () => {
    const failures = [
      { secondHash: "changed" },
      { regressionProbesLive: false },
      { tautologyDetected: false },
      { groundedGateOk: false },
      { faithfulnessGateOk: false },
    ];
    expect(failures.every((override) => !evaluateEvalProof(evalInput(override)).ok)).toBe(true);
  });

  it("fails on a single-byte wire mutation or editor purpose widening", () => {
    expect(evaluateWireProof(wireInput({ wireHash: "d".repeat(64) })).ok).toBe(false);
    expect(evaluateWireProof(wireInput({ editorRejectedNeutralPurpose: false })).ok).toBe(false);
  });

  it("fails every repository-pod negative control closed", () => {
    const failures = [
      { scorecardOk: false },
      { providerName: "bypass" },
      { askTimeDocumentEmbeddingCount: 1 },
      { fingerprintCount: 9 },
      { indexedPathCount: 9 },
      { alignedVectorCount: 9 },
      { editorProviderStatus: "unknown" },
    ];
    expect(failures.every((override) => !evaluateRepositoryPodProof(podInput(override)).ok)).toBe(
      true,
    );
  });

  it("fails on an incomplete bookkeeping checklist", () => {
    const items = [{ id: "hs6-window-closure", status: "ready" }];
    expect(evaluateBookkeepingProof(bookkeepingInput({ items })).ok).toBe(false);
  });

  it("proves conjunction over all 64 proof-outcome combinations", () => {
    for (let mask = 0; mask < 64; mask += 1) {
      const results = PROOF_IDS.map((id, index) => ({
        id,
        ok: (mask & (1 << index)) !== 0,
        failures: [],
        metrics: {},
      }));
      const verdict = evaluateProofSet(results);
      expect(verdict.ok, `mask=${String(mask)}`).toBe(mask === 63);
      expect(verdict.failedProofs).toEqual(
        results.filter((result) => !result.ok).map((result) => result.id),
      );
    }
  });
});

describe("Knowledge M2 evidence", () => {
  it("is byte-identical, hashable, and structurally body-free", () => {
    const first = renderKnowledgeM2Evidence(passingResults());
    const second = renderKnowledgeM2Evidence(passingResults());
    expect(first).toBe(second);
    expect(sha256(first)).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidenceRedactionFailures(first)).toEqual([]);
    expect(evidenceRedactionFailures(`${first}\nhttps://forbidden.invalid`)).toContain("endpoint");
    expect(evidenceRedactionFailures(`${first}\nsecret`)).toContain("credential-label");
    expect(evidenceRedactionFailures(`${first}\nexcerpt`)).toContain("body-material");
  });

  it("sorts object keys for deterministic scorecard hashing", () => {
    expect(stableStringify({ b: 2, a: [{ d: 4, c: 3 }] })).toBe('{"a":[{"c":3,"d":4}],"b":2}');
  });
});

describe("runKnowledgeM2CloseoutGate", () => {
  it("executes all six real proof functions through the exported gate", async () => {
    const written = vi.fn();
    const outcome = await runKnowledgeM2CloseoutGate({
      log: () => undefined,
      fail: vi.fn(),
      writeEvidence: written,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.results.map((result) => result.id)).toEqual(PROOF_IDS);
    expect(written).toHaveBeenCalledOnce();
  });

  it("writes evidence only after every injected proof passes", async () => {
    const results = passingResults();
    const written = vi.fn();
    const outcome = await runKnowledgeM2CloseoutGate({
      log: () => undefined,
      fail: vi.fn(),
      proofRunners: results.map((result) => () => Promise.resolve(result)),
      writeEvidence: written,
    });
    expect(outcome.ok).toBe(true);
    expect(written).toHaveBeenCalledOnce();
  });

  it("enumerates every failed proof and does not write evidence", async () => {
    const results = passingResults().map((result, index) =>
      index % 2 === 0 ? { ...result, ok: false, failures: ["synthetic"] } : result,
    );
    const fail = vi.fn();
    const written = vi.fn();
    const outcome = await runKnowledgeM2CloseoutGate({
      log: () => undefined,
      fail,
      proofRunners: results.map((result) => () => Promise.resolve(result)),
      writeEvidence: written,
    });
    expect(outcome.ok).toBe(false);
    expect(fail).toHaveBeenCalledWith("ann-active, eval-harness, repository-pod");
    expect(written).not.toHaveBeenCalled();
  });

  it("fails closed on proof execution and evidence redaction errors", async () => {
    const executionFail = vi.fn();
    const execution = await runKnowledgeM2CloseoutGate({
      log: () => undefined,
      fail: executionFail,
      proofRunners: [() => Promise.reject(new Error("synthetic"))],
      writeEvidence: vi.fn(),
    });
    expect(execution.ok).toBe(false);
    expect(executionFail).toHaveBeenCalledWith("ann-active");

    const results = passingResults();
    const pod = results.find((result) => result.id === "repository-pod");
    pod.metrics.providerName = "secret";
    const redactionFail = vi.fn();
    const redaction = await runKnowledgeM2CloseoutGate({
      log: () => undefined,
      fail: redactionFail,
      proofRunners: results.map((result) => () => Promise.resolve(result)),
      writeEvidence: vi.fn(),
    });
    expect(redaction.ok).toBe(false);
    expect(redactionFail).toHaveBeenCalledWith("credential-label");
  });
});
