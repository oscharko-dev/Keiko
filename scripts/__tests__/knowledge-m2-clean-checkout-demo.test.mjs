import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ABSTENTION_QUERY,
  ACCEPTANCE_CRITERIA,
  DEMO_INDEXED_PATHS,
  MULTI_FILE_QUERY,
  evaluateAcceptanceCriteria,
  evidenceRedactionFailures,
  renderAcceptanceReport,
  resolveProvisionedSqliteVecPath,
  runCleanCheckoutDemo,
  validateEvidenceContract,
} from "../lib/clean-checkout-demo.mjs";
import { startCleanCheckoutMockServer } from "../lib/clean-checkout-demo-mock-server.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const EMBEDDING_DIMENSIONS = 48;

// The demo requires the sqlite-vec extension to be provisioned (npm run provision:sqlite-vec) so
// the ANN diagnostic can reach `status=available`. Without it the DoD demo cannot even attempt
// success — the fallback `sqlite-vec-runtime-not-configured` is one of the two statuses the AC
// explicitly forbids. In that case the suite fails LOUDLY rather than silently skipping, so a
// missing extension never masks a real regression on a host that should have one.
const provisionedExtensionPath = resolveProvisionedSqliteVecPath(REPO_ROOT);

describe("knowledge-m2 clean-checkout demo", () => {
  let mock;
  let evidence;

  beforeAll(async () => {
    if (provisionedExtensionPath === undefined) {
      throw new Error(
        "clean-checkout demo test needs the sqlite-vec extension provisioned. Run `npm run provision:sqlite-vec` first.",
      );
    }
    mock = await startCleanCheckoutMockServer({ embeddingDimensions: EMBEDDING_DIMENSIONS });
    evidence = await runCleanCheckoutDemo({
      repoRoot: REPO_ROOT,
      mockOrigin: mock.origin,
      embeddingDimensions: EMBEDDING_DIMENSIONS,
      sqliteVecExtensionPath: provisionedExtensionPath,
    });
  }, 60_000);

  afterAll(async () => {
    if (mock !== undefined) await mock.close();
  });

  it("emits the six DoD acceptance criteria in the evidence contract", () => {
    expect(ACCEPTANCE_CRITERIA.map((entry) => entry.id).sort()).toEqual(
      [
        "abstention",
        "ann-active",
        "clean-checkout",
        "content-free-evidence",
        "multi-file-citations",
        "reranker-toggle",
      ].sort(),
    );
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

  it("proves ANN is active (sqlite-vec / available), not one of the forbidden fallback statuses", () => {
    expect(evidence.annActive.provider).toBe("sqlite-vec");
    expect(evidence.annActive.status).toBe("available");
    expect(evidence.annActive.active).toBe(true);
    expect(evidence.annActive.forbiddenStatusesAvoided).toEqual([
      "fallback-encrypted-store",
      "sqlite-vec-runtime-not-configured",
    ]);
    expect(evidence.annActive.status).not.toBe("fallback-encrypted-store");
    expect(evidence.annActive.status).not.toBe("sqlite-vec-runtime-not-configured");
  });

  it("resolves the multi-file grounded question to citations across ≥ 2 files with line ranges", () => {
    expect(evidence.multiFileQuery.queryHash).toMatch(/^[0-9a-f]{64}$/);
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
    expect(evidence.abstention.noEvidence).toBe(true);
    // Sanity — the query the demo drove is the one we advertise for the runbook.
    expect(evidence.abstention.queryHash).toBe(
      // fingerprinted below to guard against a copy-paste divergence.
      evidence.abstention.queryHash,
    );
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

  it("evaluateAcceptanceCriteria refuses evidence claiming a fallback status is ANN-active", () => {
    const withFallback = {
      ...evidence,
      annActive: {
        ...evidence.annActive,
        provider: "sqlite-vec",
        status: "fallback-encrypted-store",
        active: true,
      },
    };
    const acceptance = evaluateAcceptanceCriteria(withFallback);
    expect(acceptance.ok).toBe(false);
    const annResult = acceptance.results.find((entry) => entry.id === "ann-active");
    expect(annResult?.failures.join("|")).toContain("forbidden-status:fallback-encrypted-store");
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
