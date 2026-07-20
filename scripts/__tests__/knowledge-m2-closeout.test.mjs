import { describe, expect, it, vi } from "vitest";

import {
  HS6_SINGLE_WRITER_FILE_COUNT,
  PROOF_IDS,
  REQUIRED_RERANKER_DIAGNOSTIC_FIELDS,
  evaluateAnnProof,
  evaluateBookkeepingProof,
  evaluateEvalProof,
  evaluateFacadeProof,
  evaluateProofSet,
  evaluateRepositoryPodProof,
  evaluateWireProof,
  evidenceRedactionFailures,
  evidenceSettlementFailure,
  missingRerankerDiagnosticFields,
  parseWaveBookkeepingItems,
  readWaveBookkeepingItems,
  renderKnowledgeM2Evidence,
  rerankerImportProofFromEntries,
  runBookkeepingProof,
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
    encryptedAnnStatus: "available",
    encryptedTempStore: "memory",
    encryptedUnpinnedStatus: "fallback-encrypted-store",
    loadFailureReason: "sqlite-vec-extension-load-failed",
    disabledStatus: "disabled",
    partitionViolations: 0,
    // Issue #2631 additions. These must be present for `evaluateAnnProof` to accept the input:
    // latency row-count anchors, ANN latency-fixture recall floor, and the injected-degenerate
    // regression proof (recalls low across every query, decoy count carried alongside for the
    // evidence table). Millisecond values are informational — used by the characterization document.
    latencyVectorDimensions: 384,
    latencyLargeRows: 50_000,
    latencyLargeAnnMedianMs: 180,
    latencyLargeExactMedianMs: 65,
    latencyLargeMinRecall: 1,
    latencySmallRows: 500,
    latencySmallAnnMedianMs: 2.5,
    latencySmallExactMedianMs: 0.4,
    productionExactScanCap: 20_000,
    degenerateInjectionRecalls: [0, 0, 0],
    degenerateInjectionDecoyCount: 10,
    ...overrides,
  };
}

function facadeInput(overrides = {}) {
  return {
    importers: [FACADE],
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

// Minimal stand-in for docs/qa/knowledge-m2-wave.md: the parser must read the real `- [x]` / `- [ ]`
// state out of the HS-6 single-writer block and the M2.8 wave-closeout row, and nothing else.
function waveFixture({ hs6States = "x".repeat(11), closeoutState = "x" } = {}) {
  const hs6Lines = [...hs6States].map(
    (state, index) => `- [${state}] \`packages/keiko-contracts/src/file-${String(index)}.ts\``,
  );
  return [
    "# Knowledge M2 wave activation and HS-6 coordination",
    "",
    "## Activation record",
    "",
    "- [x] Phase A entry gate assigned to M2.1 / Issue #2565.",
    `- [${closeoutState}] M2.8 owns wave closeout evidence.`,
    "",
    "## HS-6 single-writer files",
    "",
    ...hs6Lines,
    "",
    "## M2.1 verification record",
    "",
    "- [ ] `npm run check:adr-index`",
    "",
  ].join("\n");
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
      // ADR-0153 D1 negative controls, one per direction of the boundary: ANN refused on a pinned
      // encrypted store (Outcome 3 silently unmet), the pin not actually in force, and ANN reaching
      // an encrypted store that never got the pin.
      { encryptedAnnStatus: "fallback-encrypted-store" },
      { encryptedTempStore: "file" },
      { encryptedUnpinnedStatus: "available" },
      { loadFailureReason: "unexpected" },
      { disabledStatus: "available" },
      { partitionViolations: 1 },
      // Issue #2631 negative controls, one per direction of each new assertion. The latency-fixture
      // row counts anchor the "recorded latency comparison" so a future change cannot silently
      // shrink the comparison to a vacuous one; the latency-fixture recall floor prevents a stealth
      // quality regression in the realistic-dim fixture; and the injected-degenerate assertion
      // fires when the degenerate injection is silently reverted to the healthy path (any recall
      // reaching the floor) or dropped entirely.
      { latencyLargeRows: 25_000 },
      { latencySmallRows: 250 },
      { latencyLargeMinRecall: 0.94 },
      { degenerateInjectionRecalls: [0, 1, 0] },
      { degenerateInjectionRecalls: [] },
      { degenerateInjectionRecalls: undefined },
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
    expect(scanned.importers).toEqual([FACADE, "packages/keiko-server/src/bypass.ts"].sort());
    expect(evaluateFacadeProof({ ...facadeInput(), ...scanned }).ok).toBe(false);
    expect(evaluateFacadeProof(facadeInput({ missingDiagnosticFields: ["status"] })).ok).toBe(
      false,
    );
  });

  it("counts only real transport importers, never a prose mention", () => {
    const entries = [
      {
        path: FACADE,
        source: 'import { requestLiteLLMRerank } from "@oscharko-dev/keiko-model-gateway";',
      },
      {
        path: "packages/keiko-server/src/deps.ts",
        source: "// Production leaves this undefined and uses requestLiteLLMRerank with config.",
      },
    ];
    const scanned = rerankerImportProofFromEntries(entries);
    expect(Object.keys(scanned)).toEqual(["importers"]);
    expect(scanned.importers).toEqual([FACADE]);
    expect(evaluateFacadeProof({ ...facadeInput(), ...scanned }).ok).toBe(true);
  });

  it("scopes the diagnostics-completeness scan to the named interface body", () => {
    const contract = [
      "export interface UnrelatedDiagnostics {",
      "  readonly status: string;",
      "  readonly latencyMs?: number | undefined;",
      "}",
      "",
      "export interface GroundedRerankerDiagnostics {",
      "  readonly mode?: string | undefined;",
      "  readonly candidateCount: number;",
      "  readonly documentCount: number;",
      "  readonly keptCount: number;",
      "  readonly failureKind?: string | undefined;",
      "  readonly latencyMs?: number | undefined;",
      "}",
      "",
    ].join("\n");
    expect(missingRerankerDiagnosticFields(contract)).toEqual(["status"]);
  });

  it("requires the failure-kind diagnostic and fails closed on a missing interface", () => {
    expect(REQUIRED_RERANKER_DIAGNOSTIC_FIELDS).toContain("failureKind");
    expect(missingRerankerDiagnosticFields("export interface Other {}")).toEqual([
      ...REQUIRED_RERANKER_DIAGNOSTIC_FIELDS,
    ]);
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
    ];
    expect(failures.every((override) => !evaluateRepositoryPodProof(podInput(override)).ok)).toBe(
      true,
    );
  });

  // The editor repo-search provider runs on the keystroke-sensitive path where embedding-cost
  // providers are excluded by design, so its status is characterization, not a verdict input.
  it("keeps the editor provider status out of the repository-pod verdict", () => {
    expect(evaluateRepositoryPodProof(podInput({ editorProviderStatus: "pod-backed" })).ok).toBe(
      true,
    );
    expect(evaluateRepositoryPodProof(podInput({ editorProviderStatus: "lexical-only" })).ok).toBe(
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

describe("Knowledge M2 wave bookkeeping parser", () => {
  it("reads a fully settled wave record as ready", () => {
    expect(parseWaveBookkeepingItems(waveFixture())).toEqual([
      { id: "hs6-window-closure", status: "ready" },
      { id: "matrix-a-substrate-delta", status: "ready" },
    ]);
  });

  it("fails closed while any HS-6 single-writer box is unchecked", () => {
    const items = parseWaveBookkeepingItems(waveFixture({ hs6States: "xxxxxxxxxx " }));
    expect(items).toContainEqual({ id: "hs6-window-closure", status: "pending" });
    expect(evaluateBookkeepingProof({ items }).ok).toBe(false);
  });

  it("fails closed while the M2.8 wave-closeout row is unchecked", () => {
    const items = parseWaveBookkeepingItems(waveFixture({ closeoutState: " " }));
    expect(items).toContainEqual({ id: "matrix-a-substrate-delta", status: "pending" });
    expect(evaluateBookkeepingProof({ items }).ok).toBe(false);
  });

  it("fails closed when the HS-6 block is emptied instead of settled", () => {
    const items = parseWaveBookkeepingItems(waveFixture({ hs6States: "" }));
    expect(items).toContainEqual({ id: "hs6-window-closure", status: "pending" });
    expect(HS6_SINGLE_WRITER_FILE_COUNT).toBe(11);
  });

  it("ignores checkbox state outside the two required blocks", () => {
    const withUncheckedVerification = waveFixture();
    expect(withUncheckedVerification).toContain("- [ ] `npm run check:adr-index`");
    expect(
      parseWaveBookkeepingItems(withUncheckedVerification).every((item) => item.status === "ready"),
    ).toBe(true);
  });

  it("reads the committed wave record and certifies the shipped wave", () => {
    expect(readWaveBookkeepingItems()).toEqual([
      { id: "hs6-window-closure", status: "ready" },
      { id: "matrix-a-substrate-delta", status: "ready" },
    ]);
    expect(runBookkeepingProof().ok).toBe(true);
  });
});

describe("Knowledge M2 evidence", () => {
  it("is hashable and structurally body-free", () => {
    const evidence = renderKnowledgeM2Evidence(passingResults());
    expect(sha256(evidence)).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidenceRedactionFailures(evidence)).toEqual([]);
    expect(evidenceRedactionFailures(`${evidence}\nhttps://forbidden.invalid`)).toContain(
      "endpoint",
    );
    expect(evidenceRedactionFailures(`${evidence}\nsecret`)).toContain("credential-label");
    expect(evidenceRedactionFailures(`${evidence}\nexcerpt`)).toContain("body-material");
  });

  // Wall-clock latency buckets are a characterization number, not a deterministic fact: at a bucket
  // boundary the same tree renders a different document. The published record keeps its determinism
  // claim; the buckets stay on stdout only.
  it("keeps wall-clock latency buckets out of the published document", () => {
    const evidence = renderKnowledgeM2Evidence(passingResults());
    expect(evidence).not.toMatch(/\|\s*(?:median|p95) latency bucket\s*\|/u);
    expect(evidence).not.toContain("<=100ms");
    expect(evidence).not.toContain("<=25ms");
    expect(evidence).toContain("deterministic");
  });

  it("reports the ready item count, not the total item count", () => {
    const items = [
      { id: "hs6-window-closure", status: "ready" },
      { id: "matrix-a-substrate-delta", status: "pending" },
    ];
    const results = passingResults().map((result) =>
      result.id === "program-bookkeeping" ? { ...result, metrics: { items } } : result,
    );
    expect(renderKnowledgeM2Evidence(results)).toMatch(/ready item count\s*\|\s*1 \|/u);
  });

  it("labels the editor provider status as informational", () => {
    expect(renderKnowledgeM2Evidence(passingResults())).toContain(
      "editor provider status (informational)",
    );
  });

  it("sorts object keys for deterministic scorecard hashing", () => {
    expect(stableStringify({ b: 2, a: [{ d: 4, c: 3 }] })).toBe('{"a":[{"c":3,"d":4}],"b":2}');
  });
});

describe("evidenceSettlementFailure", () => {
  it("fails closed when the committed artifact drifted from the rendered evidence", () => {
    expect(
      evidenceSettlementFailure("rendered", {
        write: false,
        readCommitted: () => "stale",
        writeCommitted: () => undefined,
      }),
    ).toBe("evidence-drift");
  });

  it("fails closed when the committed artifact is missing", () => {
    expect(
      evidenceSettlementFailure("rendered", {
        write: false,
        readCommitted: () => undefined,
        writeCommitted: () => undefined,
      }),
    ).toBe("evidence-missing");
  });

  it("accepts a matching committed artifact without writing it", () => {
    const writeCommitted = vi.fn();
    expect(
      evidenceSettlementFailure("rendered", {
        write: false,
        readCommitted: () => "rendered",
        writeCommitted,
      }),
    ).toBeUndefined();
    expect(writeCommitted).not.toHaveBeenCalled();
  });

  it("regenerates the artifact only under the explicit write flag", () => {
    const writeCommitted = vi.fn();
    expect(
      evidenceSettlementFailure("rendered", {
        write: true,
        readCommitted: () => "stale",
        writeCommitted,
      }),
    ).toBeUndefined();
    expect(writeCommitted).toHaveBeenCalledWith("rendered");
  });
});

describe("runKnowledgeM2CloseoutGate", () => {
  // Drives the six REAL proofs: a 20 001-row ANN corpus plus the retrieval, grounded-retrieval, and
  // faithfulness gates. That work does not fit the 15s repository default.
  it("executes all six real proof functions through the exported gate", async () => {
    const settleEvidence = vi.fn();
    const outcome = await runKnowledgeM2CloseoutGate({
      log: () => undefined,
      fail: vi.fn(),
      settleEvidence,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.results.map((result) => result.id)).toEqual(PROOF_IDS);
    expect(settleEvidence).toHaveBeenCalledOnce();
  }, 300_000);

  it("settles evidence only after every injected proof passes", async () => {
    const results = passingResults();
    const settleEvidence = vi.fn();
    const outcome = await runKnowledgeM2CloseoutGate({
      log: () => undefined,
      fail: vi.fn(),
      proofRunners: results.map((result) => () => Promise.resolve(result)),
      settleEvidence,
    });
    expect(outcome.ok).toBe(true);
    expect(settleEvidence).toHaveBeenCalledOnce();
  });

  it("enumerates every failed proof and does not settle evidence", async () => {
    const results = passingResults().map((result, index) =>
      index % 2 === 0 ? { ...result, ok: false, failures: ["synthetic"] } : result,
    );
    const fail = vi.fn();
    const settleEvidence = vi.fn();
    const outcome = await runKnowledgeM2CloseoutGate({
      log: () => undefined,
      fail,
      proofRunners: results.map((result) => () => Promise.resolve(result)),
      settleEvidence,
    });
    expect(outcome.ok).toBe(false);
    expect(fail).toHaveBeenCalledWith("ann-active, eval-harness, repository-pod");
    expect(settleEvidence).not.toHaveBeenCalled();
  });

  it("fails closed on a not-ready bookkeeping item read from the wave record", async () => {
    const pending = evaluateBookkeepingProof({
      items: parseWaveBookkeepingItems(waveFixture({ closeoutState: " " })),
    });
    const fail = vi.fn();
    const settleEvidence = vi.fn();
    const outcome = await runKnowledgeM2CloseoutGate({
      log: () => undefined,
      fail,
      proofRunners: [() => Promise.resolve(pending)],
      settleEvidence,
    });
    expect(outcome.ok).toBe(false);
    expect(fail).toHaveBeenCalledWith("program-bookkeeping");
    expect(settleEvidence).not.toHaveBeenCalled();
  });

  it("fails closed when the committed evidence artifact drifted", async () => {
    const results = passingResults();
    const fail = vi.fn();
    const outcome = await runKnowledgeM2CloseoutGate({
      log: () => undefined,
      fail,
      proofRunners: results.map((result) => () => Promise.resolve(result)),
      settleEvidence: () => "evidence-drift",
    });
    expect(outcome.ok).toBe(false);
    expect(fail).toHaveBeenCalledWith("evidence-drift");
  });

  it("fails closed on proof execution and evidence redaction errors", async () => {
    const executionFail = vi.fn();
    const execution = await runKnowledgeM2CloseoutGate({
      log: () => undefined,
      fail: executionFail,
      proofRunners: [() => Promise.reject(new Error("synthetic"))],
      settleEvidence: vi.fn(),
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
      settleEvidence: vi.fn(),
    });
    expect(redaction.ok).toBe(false);
    expect(redactionFail).toHaveBeenCalledWith("credential-label");
  });
});
