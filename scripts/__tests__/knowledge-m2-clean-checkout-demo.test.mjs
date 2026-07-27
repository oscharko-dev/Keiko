import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ABSTENTION_QUERY,
  ACCEPTANCE_CRITERIA,
  CLEAN_CHECKOUT_EXECUTION_MODES,
  DEMO_INDEXED_PATHS,
  MULTI_FILE_QUERY,
  evaluateAcceptanceCriteria,
  evidenceRedactionFailures,
  renderAcceptanceReport,
  resolveProvisionedUsearchPath,
  runCleanCheckoutDemo,
  validateEvidenceContract,
} from "../lib/clean-checkout-demo.mjs";
import { startCleanCheckoutMockServer } from "../lib/clean-checkout-demo-mock-server.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const EMBEDDING_DIMENSIONS = 48;

// This suite is deliberately hermetic and therefore NOT acceptance-eligible. It exercises the
// production retrieval/citation runner with an explicitly injected generator while the CLI-only
// acceptance mode requires a configured provider and refuses all injected answer adapters.
const provisionedUsearchPath = resolveProvisionedUsearchPath({ repoRoot: REPO_ROOT });

const hermeticAnswerGenerator = {
  generate: async ({ pack }) =>
    pack.citations
      .map(
        (citation, index) =>
          `${citation.safeDisplayName} participates in the indexed retrieval path [${String(index + 1)}].`,
      )
      .join(" "),
};

function acceptanceConfigForRejection(origin) {
  return {
    providers: [
      {
        modelId: "acceptance-embed",
        baseUrl: `${origin}/v1`,
        apiKey: "",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 1,
      },
    ],
    capabilities: [
      {
        id: "acceptance-embed",
        kind: "embedding",
        contextWindow: 8_191,
        maxOutputTokens: 0,
        toolCalling: false,
        structuredOutput: false,
        streaming: false,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: false,
        costClass: "low",
        latencyClass: "fast",
        throughputHint: "Negative-control configuration.",
        preferredUseCases: ["negative-control"],
        knownLimitations: [],
      },
    ],
    reranker: {
      modelId: "rerank",
      baseUrl: `${origin}/v1`,
      apiKey: "",
      timeoutMs: 30_000,
    },
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

describe("knowledge-m2 clean-checkout demo", () => {
  let mock;
  let evidence;
  let priorAllowDirtyHost;

  beforeAll(async () => {
    if (provisionedUsearchPath === undefined) {
      throw new Error(
        "clean-checkout demo test needs the USearch runtime provisioned. Run `npm run provision:usearch` first.",
      );
    }
    // A developer running the vitest suite on their own checkout almost always has `.keiko` state
    // and a `dist/` build tree — legitimate for dev work but not the DoD's "fresh clone" scenario
    // the strict caller-hygiene enforcement in `failuresCleanCheckout` targets. Set the escape
    // hatch to record-only for the duration of this suite so the test verifies the DEMO's own
    // hygiene (indexed paths, fingerprints), while the strict clean-clone enforcement is verified
    // separately by the negative-control test at the bottom.
    priorAllowDirtyHost = process.env.KEIKO_CLEAN_CHECKOUT_DEMO_ALLOW_DIRTY_HOST;
    process.env.KEIKO_CLEAN_CHECKOUT_DEMO_ALLOW_DIRTY_HOST = "1";
    mock = await startCleanCheckoutMockServer({ embeddingDimensions: EMBEDDING_DIMENSIONS });
    evidence = await runCleanCheckoutDemo({
      repoRoot: REPO_ROOT,
      executionMode: CLEAN_CHECKOUT_EXECUTION_MODES.hermeticTest,
      mockOrigin: mock.origin,
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      testAnswerGenerator: hermeticAnswerGenerator,
      usearchBinaryPath: provisionedUsearchPath,
    });
  }, 60_000);

  afterAll(async () => {
    if (mock !== undefined) await mock.close();
    if (priorAllowDirtyHost === undefined) {
      delete process.env.KEIKO_CLEAN_CHECKOUT_DEMO_ALLOW_DIRTY_HOST;
    } else {
      process.env.KEIKO_CLEAN_CHECKOUT_DEMO_ALLOW_DIRTY_HOST = priorAllowDirtyHost;
    }
  });

  it("emits the six DoD acceptance criteria in the evidence contract", () => {
    expect(ACCEPTANCE_CRITERIA.map((entry) => entry.id).sort()).toEqual(
      [
        "abstention",
        "vector-index-active",
        "clean-checkout",
        "content-free-evidence",
        "multi-file-citations",
        "reranker-toggle",
      ].sort(),
    );
  });

  it("refuses an injected answer adapter in acceptance mode before provider I/O", async () => {
    await expect(
      runCleanCheckoutDemo({
        repoRoot: REPO_ROOT,
        executionMode: CLEAN_CHECKOUT_EXECUTION_MODES.acceptance,
        gatewayConfig: acceptanceConfigForRejection(mock.origin),
        embeddingModelId: "acceptance-embed",
        embeddingDimensions: EMBEDDING_DIMENSIONS,
        testAnswerGenerator: hermeticAnswerGenerator,
        usearchBinaryPath: provisionedUsearchPath,
      }),
    ).rejects.toThrow("acceptance mode refuses an injected answer adapter");
  });

  it("requires an explicitly injected adapter in hermetic-test mode", async () => {
    await expect(
      runCleanCheckoutDemo({
        repoRoot: REPO_ROOT,
        executionMode: CLEAN_CHECKOUT_EXECUTION_MODES.hermeticTest,
        mockOrigin: mock.origin,
        embeddingDimensions: EMBEDDING_DIMENSIONS,
        usearchBinaryPath: provisionedUsearchPath,
      }),
    ).rejects.toThrow("hermetic-test mode requires an injected answer adapter");
  });

  it("indexes the intended real files from the checkout tree", () => {
    for (const relativePath of DEMO_INDEXED_PATHS) {
      expect(existsSync(resolve(REPO_ROOT, relativePath))).toBe(true);
    }
    expect(evidence.cleanCheckout.indexedPathsResolved).toBeGreaterThan(0);
    expect(evidence.cleanCheckout.fingerprintCount).toBeGreaterThanOrEqual(
      DEMO_INDEXED_PATHS.length,
    );
  });

  it("proves the verified USearch provider is available with the honest exact crossover", () => {
    expect(evidence.vectorIndex.provider).toBe("usearch");
    expect(evidence.vectorIndex.status).toBe("available");
    expect(evidence.vectorIndex.searchMode).toBe("exact");
    expect(evidence.vectorIndex.providerAvailable).toBe(true);
    expect(evidence.vectorIndex.hnswQualifiedBy).toBe("npm run check:knowledge-m2-closeout");
    expect(evidence.vectorIndex.forbiddenStatusesAvoided).toEqual([
      "disabled",
      "fallback-unavailable",
      "fallback-encrypted-store",
      "fallback-unsupported-metric",
      "fallback-incompatible-identity",
      "fallback-index-too-large",
      "fallback-query-error",
    ]);
    expect(evidence.vectorIndex.status.startsWith("fallback-")).toBe(false);
  });

  it("runs the answer/citation flow across ≥ 2 files with line ranges", () => {
    expect(evidence.multiFileQuery.queryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.multiFileQuery.generatedCharacters).toBeGreaterThan(0);
    expect(evidence.multiFileQuery.generationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.multiFileQuery.noEvidence).toBe(false);
    expect(evidence.multiFileQuery.attachedCitationCount).toBeGreaterThan(0);
    expect(evidence.multiFileQuery.citationCount).toBeGreaterThan(0);
    expect(evidence.multiFileQuery.spansMultipleFiles).toBe(true);
    expect(evidence.multiFileQuery.distinctFileCount).toBeGreaterThanOrEqual(2);
    expect(evidence.multiFileQuery.citationLinesResolved).toBe(true);
    // Every returned citation file must be one of the paths the demo asked to index — a citation
    // outside the tracked set would mean retrieval leaked past the pod's scope, which is a bug.
    for (const path of evidence.multiFileQuery.citationFiles) {
      expect(DEMO_INDEXED_PATHS).toContain(path);
    }
  });

  it("abstains on the evidence-free question rather than fabricating an answer", () => {
    expect(evidence.abstention.abstained).toBe(true);
    expect(evidence.abstention.references).toBe(0);
    expect(evidence.abstention.citations).toBe(0);
    expect(evidence.abstention.generatedCharacters).toBe(0);
    expect(evidence.abstention.generationCalls).toBe(0);
    expect(evidence.abstention.noEvidence).toBe(true);
    // Independently-computed hash — catches a copy/paste divergence between the constant the
    // runner hashes and the constant the runbook advertises. The prior `.toBe(itself)` was a
    // no-op tautology.
    expect(evidence.abstention.queryHash).toBe(sha256Hex(ABSTENTION_QUERY));
    expect(evidence.multiFileQuery.queryHash).toBe(sha256Hex(MULTI_FILE_QUERY));
    expect(ABSTENTION_QUERY.length).toBeGreaterThan(0);
    expect(MULTI_FILE_QUERY).not.toBe(ABSTENTION_QUERY);
  });

  it("exercises the reranker facade in enabled and disabled states and shows the paths differ", () => {
    expect(evidence.reranker.enabled.policyExternalReranking).toBe("allow");
    expect(evidence.reranker.disabled.policyExternalReranking).toBe("deny");
    expect(evidence.reranker.answerPathDiffers).toBe(true);
    expect(evidence.reranker.enabled.selectedOrderHash).not.toBe(
      evidence.reranker.disabled.selectedOrderHash,
    );
    // The disabled path returns via the facade's policy branch, which stamps `status="denied"`
    // and `failureKind="policy-denied"`. If a future refactor moves the disabled branch to
    // different diagnostic tokens, this assertion turns red and the AC's "differs where policy
    // says" claim must be re-checked.
    expect(evidence.reranker.disabled.diagnosticStatus).toBe("denied");
    expect(evidence.reranker.disabled.diagnosticFailureKind).toBe("policy-denied");
  });

  it("emits content-free evidence and passes the full evidence contract", () => {
    expect(evidence.executionMode).toBe("hermetic-test");
    expect(evidence.acceptanceEligible).toBe(false);
    expect(evidenceRedactionFailures(evidence)).toEqual([]);
    expect(validateEvidenceContract(evidence)).toEqual([]);
    const acceptance = evaluateAcceptanceCriteria(evidence);
    expect(acceptance.ok).toBe(true);
    for (const line of renderAcceptanceReport(evidence)) {
      expect(line.startsWith("PASS ")).toBe(true);
    }
  });

  // Negative controls: the evidence validators must REJECT contrived violations. If a future edit
  // weakens redaction or acceptance so that an obviously-broken evidence object is accepted, these
  // fail — the contract itself is under test, not just this session's happy path.
  it("evidenceRedactionFailures rejects an evidence object carrying an endpoint URL", () => {
    const leaked = { ...evidence, note: "https://provider.example.com/v1/embeddings" };
    expect(evidenceRedactionFailures(leaked)).toContain("endpoint");
  });

  it("evaluateAcceptanceCriteria refuses evidence claiming a fallback provider is available", () => {
    const withFallback = {
      ...evidence,
      vectorIndex: {
        ...evidence.vectorIndex,
        provider: "usearch",
        status: "fallback-encrypted-store",
        providerAvailable: true,
      },
    };
    const acceptance = evaluateAcceptanceCriteria(withFallback);
    expect(acceptance.ok).toBe(false);
    const vectorResult = acceptance.results.find((entry) => entry.id === "vector-index-active");
    expect(vectorResult?.failures.join("|")).toContain("forbidden-status:fallback-encrypted-store");
  });

  it("evaluateAcceptanceCriteria refuses evidence claiming abstention while emitting references", () => {
    const withFabrication = {
      ...evidence,
      abstention: { ...evidence.abstention, abstained: true, references: 3, noEvidence: true },
    };
    const acceptance = evaluateAcceptanceCriteria(withFabrication);
    const abstention = acceptance.results.find((entry) => entry.id === "abstention");
    expect(abstention?.ok).toBe(false);
    expect(abstention?.failures.join("|")).toContain("references-emitted:3");
  });

  it("evaluateAcceptanceCriteria refuses evidence recording partial indexing on the clean-checkout bullet", () => {
    const withPartialIndex = {
      ...evidence,
      cleanCheckout: {
        ...evidence.cleanCheckout,
        indexedPathsRequested: DEMO_INDEXED_PATHS.length,
        indexedPathsResolved: DEMO_INDEXED_PATHS.length - 1,
      },
    };
    const acceptance = evaluateAcceptanceCriteria(withPartialIndex);
    const cleanCheckout = acceptance.results.find((entry) => entry.id === "clean-checkout");
    expect(cleanCheckout?.ok).toBe(false);
    expect(cleanCheckout?.failures.join("|")).toContain("partial-indexing:");
  });

  it("evaluateAcceptanceCriteria refuses evidence recording a dirty host under strict enforcement", () => {
    // The strict path — no allow-dirty-host escape hatch — must reject an evidence object that
    // records `.keiko` or `dist` present at run start. This is the enforcement the DoD signature
    // depends on, so a run inside the container-based runbook (which has neither) still passes.
    const priorAllow = process.env.KEIKO_CLEAN_CHECKOUT_DEMO_ALLOW_DIRTY_HOST;
    delete process.env.KEIKO_CLEAN_CHECKOUT_DEMO_ALLOW_DIRTY_HOST;
    try {
      const dirtyHost = {
        ...evidence,
        cleanCheckout: {
          ...evidence.cleanCheckout,
          keikoStatePresentAtStart: true,
          buildArtifactsPresentAtStart: true,
        },
      };
      const acceptance = evaluateAcceptanceCriteria(dirtyHost);
      const cleanCheckout = acceptance.results.find((entry) => entry.id === "clean-checkout");
      expect(cleanCheckout?.ok).toBe(false);
      expect(cleanCheckout?.failures).toContain("keiko-state-present-at-start");
      expect(cleanCheckout?.failures).toContain("build-artifacts-present-at-start");
    } finally {
      if (priorAllow === undefined) {
        delete process.env.KEIKO_CLEAN_CHECKOUT_DEMO_ALLOW_DIRTY_HOST;
      } else {
        process.env.KEIKO_CLEAN_CHECKOUT_DEMO_ALLOW_DIRTY_HOST = priorAllow;
      }
    }
    // And the escape hatch, once set, must record without enforcing — the record-only mode the
    // suite's `beforeAll` relies on.
    process.env.KEIKO_CLEAN_CHECKOUT_DEMO_ALLOW_DIRTY_HOST = "1";
    try {
      const dirtyHost = {
        ...evidence,
        cleanCheckout: {
          ...evidence.cleanCheckout,
          keikoStatePresentAtStart: true,
          buildArtifactsPresentAtStart: true,
        },
      };
      const acceptance = evaluateAcceptanceCriteria(dirtyHost);
      const cleanCheckout = acceptance.results.find((entry) => entry.id === "clean-checkout");
      expect(cleanCheckout?.ok).toBe(true);
    } finally {
      if (priorAllow === undefined) {
        delete process.env.KEIKO_CLEAN_CHECKOUT_DEMO_ALLOW_DIRTY_HOST;
      } else {
        process.env.KEIKO_CLEAN_CHECKOUT_DEMO_ALLOW_DIRTY_HOST = priorAllow;
      }
    }
  });

  it("evaluateAcceptanceCriteria refuses evidence claiming reranker paths differ while hashes agree", () => {
    const agreeingHashes = {
      ...evidence,
      reranker: {
        ...evidence.reranker,
        answerPathDiffers: true,
        enabled: { ...evidence.reranker.enabled, selectedOrderHash: "deadbeef" },
        disabled: { ...evidence.reranker.disabled, selectedOrderHash: "deadbeef" },
      },
    };
    const acceptance = evaluateAcceptanceCriteria(agreeingHashes);
    const reranker = acceptance.results.find((entry) => entry.id === "reranker-toggle");
    expect(reranker?.ok).toBe(false);
    expect(reranker?.failures.join("|")).toContain("order-hashes-identical");
  });
});
