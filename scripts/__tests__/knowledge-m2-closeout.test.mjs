import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { resolveProvisionedUsearchPath } from "../lib/clean-checkout-demo.mjs";
import {
  HS6_SINGLE_WRITER_FILE_COUNT,
  EXPECTED_EVALUATION_SCORECARD_HASH,
  PROOF_IDS,
  REQUIRED_RERANKER_DIAGNOSTIC_FIELDS,
  breakEvenNarrative,
  categorizeLatencyWinner,
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
  renderLatencyCharacterization,
  rerankerImportProofFromEntries,
  runBookkeepingProof,
  runKnowledgeM2CloseoutGate,
  sha256,
  stableStringify,
} from "../lib/knowledge-m2-closeout.mjs";

const FACADE = "packages/keiko-server/src/grounded-rerank-facade.ts";

const CLOSEOUT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The real-proof gate routes its per-proof diagnostics into the injected `log`, which this suite
// discards — so an unprovisioned checkout used to fail as a bare "expected false to be true" with no
// hint that the ann-active proof wants a native runtime. The sibling clean-checkout demo names its
// remedy explicitly (knowledge-m2-clean-checkout-demo.test.mjs), and CI provisions the runtime as
// a setup step (ci.yml). This renders the same information into the assertion message.
//
// Deliberately a MESSAGE, not a skip: a missing runtime must still fail loudly, exactly as the
// sibling suite argues, so it can never mask a real ANN regression on a host that should have one.
function proofFailureDetail(outcome) {
  const failed = outcome.results.filter((result) => !result.ok);
  if (failed.length === 0) {
    return "gate reported not-ok while every proof passed";
  }
  const detail = failed.map((result) => `${result.id}: ${result.failures.join("; ")}`).join(" | ");
  if (resolveProvisionedUsearchPath({ repoRoot: CLOSEOUT_REPO_ROOT }) !== undefined) {
    return detail;
  }
  return `${detail} — the USearch runtime is not provisioned; run \`npm run provision:usearch\` first`;
}

function annInput(overrides = {}) {
  return {
    vectorRows: 20_001,
    exactScanCap: 20_000,
    activeStatus: "available",
    provider: "usearch",
    searchMode: "ann",
    examinedCandidateCount: 138,
    estimatedIndexBytes: 48 * 1024 * 1024,
    recalls: [1, 1, 1],
    annMedianLatency: "<=100ms",
    annP95Latency: "<=250ms",
    exactMedianLatency: "<=25ms",
    exactP95Latency: "<=50ms",
    encryptedAnnStatus: "available",
    sqliteExtensionDenied: true,
    persistenceApiReferences: 0,
    loadFailureReason: "runtime-unavailable",
    disabledStatus: "disabled",
    partitionViolations: 0,
    // Issue #2631 additions. These must be present for `evaluateAnnProof` to accept the input:
    // latency row-count anchors, ANN latency-fixture recall floor, and the injected-degenerate
    // regression proof (recalls low across every query, decoy count carried alongside for the
    // evidence table). Millisecond values are informational — used by the characterization document.
    latencyVectorDimensions: 384,
    latencyLargeRows: 50_000,
    latencyLargeAnnMedianMs: 3,
    latencyLargeExactMedianMs: 65,
    latencyLargeMinRecall: 1,
    latencyLargeBuildMs: 1_250,
    latencyLargeRssDeltaBytes: 128 * 1024 * 1024,
    latencyLargeSearchMode: "ann",
    latencyLargeExaminedCandidateCount: 138,
    latencyLargeEstimatedIndexBytes: 160 * 1024 * 1024,
    latencySmallRows: 500,
    latencySmallServiceMedianMs: 2.5,
    latencySmallExactMedianMs: 0.4,
    latencySmallSearchMode: "exact",
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
    actualScorecardHash: EXPECTED_EVALUATION_SCORECARD_HASH,
    expectedScorecardHash: EXPECTED_EVALUATION_SCORECARD_HASH,
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
      { provider: "brute-force" },
      { searchMode: "exact" },
      { examinedCandidateCount: 20_001 },
      { estimatedIndexBytes: 256 * 1024 * 1024 + 1 },
      { recalls: [1, 0.9] },
      { recalls: [1, Number.NaN] },
      { encryptedAnnStatus: "fallback-encrypted-store" },
      { sqliteExtensionDenied: false },
      { persistenceApiReferences: 1 },
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
      { latencyLargeMinRecall: Number.NaN },
      { latencyLargeAnnMedianMs: 66 },
      { latencyLargeBuildMs: 0 },
      { latencyLargeRssDeltaBytes: 512 * 1024 * 1024 + 1 },
      { latencyLargeSearchMode: "exact" },
      { latencySmallSearchMode: "ann" },
      { latencyLargeExaminedCandidateCount: 50_000 },
      { latencyLargeEstimatedIndexBytes: 256 * 1024 * 1024 + 1 },
      { degenerateInjectionRecalls: [0, 1, 0] },
      { degenerateInjectionRecalls: [0, Number.NaN, 0] },
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
      { actualScorecardHash: "changed" },
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

// Issue #2631: pure helpers for the latency characterization document. Kept together so every
// branch of `categorizeLatencyWinner` and `breakEvenNarrative` is exercised in one place.
describe("Knowledge M2 latency characterization helpers", () => {
  it("categorises ANN vs brute-force by a ratio band", () => {
    // Ratio above 1.2 → brute force wins (ANN slower); below 0.8 → ANN wins (brute force slower);
    // in between → tied. The exactMs === 0 branch defaults to POSITIVE_INFINITY, which is > 1.2.
    expect(categorizeLatencyWinner(200, 50)).toBe("brute-force");
    expect(categorizeLatencyWinner(50, 200)).toBe("ann");
    expect(categorizeLatencyWinner(100, 100)).toBe("tied");
    expect(categorizeLatencyWinner(10, 0)).toBe("brute-force");
  });

  it("narrates the measured crossover at the exact-scan cap", () => {
    const narrative = breakEvenNarrative("brute-force", "ann", 500, 50_000, 20_000);
    expect(narrative).toContain("500");
    expect(narrative).toContain("50000");
    expect(narrative).toContain("DEFAULT_MAX_EXACT_VECTOR_SCAN_ROWS = 20000");
    expect(narrative).toContain("scoped-vector-search.ts");
    expect(narrative).toContain("genuine within-run measurement");
    expect(narrative).not.toContain("operational sense");
  });

  it("renders the characterization document with row counts, ms, recall, and winners", () => {
    const results = passingResults();
    const rendered = renderLatencyCharacterization(results);
    expect(rendered).toContain("# Knowledge M2 ANN latency characterization");
    // Row counts land in the table verbatim; milliseconds are rounded to three decimals.
    expect(rendered).toContain("| 500");
    expect(rendered).toContain("| 50000");
    expect(rendered).toContain("3.000"); // large ANN median (from annInput default)
    expect(rendered).toContain("65.000"); // large exact median
    expect(rendered).toContain("2.500"); // small ANN median
    expect(rendered).toContain("0.400"); // small exact median
    expect(rendered).toMatch(/384-dim/u);
    expect(rendered).toMatch(/Small\s+\|\s+500\s+\|\s+exact/u);
    expect(rendered).toMatch(/Large\s+\|\s+50000\s+\|\s+ann/u);
    // The break-even narrative is spliced in.
    expect(rendered).toContain("DEFAULT_MAX_EXACT_VECTOR_SCAN_ROWS = 20000");
  });

  it("returns undefined when the ANN proof did not measure latency", () => {
    const results = passingResults().map((result) =>
      result.id === "ann-active" ? { ...result, metrics: {} } : result,
    );
    expect(renderLatencyCharacterization(results)).toBeUndefined();
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
    expect(outcome.ok, proofFailureDetail(outcome)).toBe(true);
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
