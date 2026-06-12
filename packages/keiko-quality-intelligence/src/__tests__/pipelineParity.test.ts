// End-to-end deterministic parity tests for the full pure QI pipeline.
//
// AC#3 parity: runs the complete chain
//   deriveIntent → designTestCaseCandidates → deduplicateCandidates
//     → validateCandidates → buildCoverageMap
// over ALL three synthetic fixtures (banking, insurance, regression) and
// asserts per-domain golden invariants with exact stable values where they
// are structural constants of the pure pipeline (not model-derived text).
//
// The insurance fixture was previously NEVER loaded by any test — this file
// resurrects it as a first-class participant.

import { describe, expect, it } from "vitest";

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import {
  buildAtomCoverageStatuses,
  buildCoverageMap,
  runCoveragePercentage,
} from "../domain/coverageRelevance.js";
import { deduplicateCandidates } from "../domain/deduplication.js";
import { deriveIntent } from "../domain/intentDerivation.js";
import {
  bankingDefault,
  insuranceDefault,
  type PolicyProfile,
  regressionDefault,
} from "../domain/policyProfile.js";
import { designTestCaseCandidates } from "../domain/testDesignModel.js";
import { validateCandidates } from "../domain/validation.js";
import { loadFixture } from "./_fixtureLoader.js";

// ─── Shared pipeline runner ───────────────────────────────────────────────────

interface PipelineResult {
  readonly candidateCount: number;
  readonly dedupedCount: number;
  readonly findingCount: number;
  readonly coveragePercentage: number;
  readonly themes: readonly string[];
  readonly riskHints: readonly string[];
  readonly priorityHint: QualityIntelligence.QualityIntelligencePriority | "unknown";
  readonly requirementCandidateCount: number;
  readonly candidatesJson: string;
  readonly dedupedJson: string;
}

const runPipeline = (fixtureName: string, profile: PolicyProfile): PipelineResult => {
  const fixture = loadFixture(fixtureName);
  const intent = deriveIntent(fixture.envelopes, profile);

  const candidates = designTestCaseCandidates({
    runId: fixture.runId,
    intent,
    atoms: fixture.atoms,
    profile,
  });
  const deduped = deduplicateCandidates(candidates);

  const findings = validateCandidates(fixture.runId, deduped);

  const map = buildCoverageMap({
    runId: fixture.runId,
    atoms: fixture.atoms,
    candidates: deduped,
  });
  const statuses = buildAtomCoverageStatuses(fixture.atoms, map);
  const coveragePercentage = runCoveragePercentage(statuses);

  return {
    candidateCount: candidates.length,
    dedupedCount: deduped.length,
    findingCount: findings.length,
    coveragePercentage,
    themes: intent.themes,
    riskHints: intent.riskHints,
    priorityHint: intent.priorityHint,
    requirementCandidateCount: intent.requirementCandidates.length,
    candidatesJson: JSON.stringify(candidates),
    dedupedJson: JSON.stringify(deduped),
  };
};

// ─── Cross-domain determinism: run pipeline twice → byte-identical output ────

describe("pipelineParity — cross-domain determinism", () => {
  it("banking pipeline produces byte-identical output on two independent runs", () => {
    // Kills: any non-determinism in ID derivation, sorting, or JSON serialisation.
    const runA = runPipeline("bankingRequirement.synthetic.json", bankingDefault);
    const runB = runPipeline("bankingRequirement.synthetic.json", bankingDefault);
    expect(runA.candidatesJson).toBe(runB.candidatesJson);
    expect(runA.dedupedJson).toBe(runB.dedupedJson);
  });

  it("insurance pipeline produces byte-identical output on two independent runs", () => {
    const runA = runPipeline("insuranceRequirement.synthetic.json", insuranceDefault);
    const runB = runPipeline("insuranceRequirement.synthetic.json", insuranceDefault);
    expect(runA.candidatesJson).toBe(runB.candidatesJson);
    expect(runA.dedupedJson).toBe(runB.dedupedJson);
  });

  it("regression pipeline produces byte-identical output on two independent runs", () => {
    const runA = runPipeline("regressionRequirement.synthetic.json", regressionDefault);
    const runB = runPipeline("regressionRequirement.synthetic.json", regressionDefault);
    expect(runA.candidatesJson).toBe(runB.candidatesJson);
    expect(runA.dedupedJson).toBe(runB.dedupedJson);
  });
});

// ─── Deduplication idempotence: dedupe(dedupe(x)) === dedupe(x) ───────────────

describe("pipelineParity — deduplication idempotence", () => {
  it("banking: second dedup pass over already-deduped candidates is a no-op", () => {
    // Kills: mutant that fails to mark a survivor as seen and re-collapses on second pass.
    const fixture = loadFixture("bankingRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, bankingDefault);
    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const deduped = deduplicateCandidates(candidates);
    const dedupedAgain = deduplicateCandidates(deduped);
    expect(JSON.stringify(dedupedAgain)).toBe(JSON.stringify(deduped));
  });

  it("insurance: second dedup pass over already-deduped candidates is a no-op", () => {
    const fixture = loadFixture("insuranceRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, insuranceDefault);
    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const deduped = deduplicateCandidates(candidates);
    const dedupedAgain = deduplicateCandidates(deduped);
    expect(JSON.stringify(dedupedAgain)).toBe(JSON.stringify(deduped));
  });

  it("regression: second dedup pass over already-deduped candidates is a no-op", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, regressionDefault);
    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const deduped = deduplicateCandidates(candidates);
    const dedupedAgain = deduplicateCandidates(deduped);
    expect(JSON.stringify(dedupedAgain)).toBe(JSON.stringify(deduped));
  });

  it("dedup over freshly-generated unique candidates preserves all (no false collapses)", () => {
    // Each atom produces a structurally distinct candidate (different atomId in steps/
    // expectedResults hash). The pipeline must not collapse distinct candidates.
    // Kills: mutant that over-normalises or drops the expectedResults hash from the signature.
    const bankingResult = runPipeline("bankingRequirement.synthetic.json", bankingDefault);
    // 2 atoms in banking fixture → 2 candidates → dedupe must keep both.
    expect(bankingResult.dedupedCount).toBe(bankingResult.candidateCount);

    const insuranceResult = runPipeline("insuranceRequirement.synthetic.json", insuranceDefault);
    // 2 atoms in insurance fixture → 2 candidates → dedupe must keep both.
    expect(insuranceResult.dedupedCount).toBe(insuranceResult.candidateCount);

    const regressionResult = runPipeline("regressionRequirement.synthetic.json", regressionDefault);
    // 2 atoms in regression fixture → 2 candidates → dedupe must keep both.
    expect(regressionResult.dedupedCount).toBe(regressionResult.candidateCount);
  });
});

// ─── Banking domain: golden invariants ───────────────────────────────────────

describe("pipelineParity — banking golden invariants", () => {
  it("derives exactly 2 candidates from 2 atoms (one per atom)", () => {
    // Kills: off-by-one in stableSortAtoms or the candidate-building loop.
    const result = runPipeline("bankingRequirement.synthetic.json", bankingDefault);
    expect(result.candidateCount).toBe(2);
    expect(result.dedupedCount).toBe(2);
  });

  it("well-formed banking candidates produce zero validation findings", () => {
    // Kills: mutant that short-circuits validation entirely.
    const result = runPipeline("bankingRequirement.synthetic.json", bankingDefault);
    expect(result.findingCount).toBe(0);
  });

  it("banking coverage is 100% (every atom has a dedicated derived candidate)", () => {
    // Kills: mutant that zeroes out confidence or inverts the coverage threshold.
    const result = runPipeline("bankingRequirement.synthetic.json", bankingDefault);
    expect(result.coveragePercentage).toBe(100);
  });

  it("banking intent detects KYC theme and AML risk hint", () => {
    // Stable tokens in the fixture labels — both banking-profile keywords.
    // Kills: mutant that strips theme extraction or riskKeyword matching.
    const result = runPipeline("bankingRequirement.synthetic.json", bankingDefault);
    expect(result.themes).toContain("kyc");
    expect(result.riskHints).toContain("aml");
    expect(result.riskHints).toContain("kyc");
  });

  it("banking priority is P0 (AML/KYC hit the top-priority bucket)", () => {
    // The bankingDefault profile places ["fraud","aml","kyc","sanction"] in bucket 0 → P0.
    // Kills: mutant that changes P0 to any other priority.
    const result = runPipeline("bankingRequirement.synthetic.json", bankingDefault);
    expect(result.priorityHint).toBe("P0");
  });

  it("banking intent extracts exactly 2 requirement candidate phrases", () => {
    // Both labels contain modal verbs ("must"/"shall") → both qualify.
    // Kills: off-by-one in requirementCandidates collection.
    const result = runPipeline("bankingRequirement.synthetic.json", bankingDefault);
    expect(result.requirementCandidateCount).toBe(2);
  });
});

// ─── Insurance domain: golden invariants (previously dead fixture) ────────────

describe("pipelineParity — insurance golden invariants (resurrected fixture)", () => {
  it("derives exactly 2 candidates from 2 atoms", () => {
    // Kills: off-by-one in atom-iteration loop; also proves the fixture IS loaded.
    const result = runPipeline("insuranceRequirement.synthetic.json", insuranceDefault);
    expect(result.candidateCount).toBe(2);
    expect(result.dedupedCount).toBe(2);
  });

  it("well-formed insurance candidates produce zero validation findings", () => {
    const result = runPipeline("insuranceRequirement.synthetic.json", insuranceDefault);
    expect(result.findingCount).toBe(0);
  });

  it("insurance coverage is 100%", () => {
    const result = runPipeline("insuranceRequirement.synthetic.json", insuranceDefault);
    expect(result.coveragePercentage).toBe(100);
  });

  it("insurance coverage percentage is within [0, 100]", () => {
    // Boundary guard — kills any mutant that makes the percentage escape its valid range.
    const result = runPipeline("insuranceRequirement.synthetic.json", insuranceDefault);
    expect(result.coveragePercentage).toBeGreaterThanOrEqual(0);
    expect(result.coveragePercentage).toBeLessThanOrEqual(100);
  });

  it("insurance intent detects at least one insurance-domain theme from the fixture labels", () => {
    // The fixture labels mention "policy", "premium", "claim", "renewal" — all must
    // appear as extracted themes (they are ≥3-char tokens from the label text).
    // Stable tokens: "policy" and "claim" are in both labels and all versions of the fixture.
    // Kills: mutant that strips theme extraction or truncates the label processing.
    const result = runPipeline("insuranceRequirement.synthetic.json", insuranceDefault);
    expect(result.themes).toContain("policy");
    expect(result.themes).toContain("claim");
    // "renewal" appears in the second label: "within the renewal window".
    expect(result.themes).toContain("renewal");
  });

  it("insurance intent detects the renewal risk hint from the insuranceDefault profile", () => {
    // insuranceDefault.priorityKeywords[1] includes "renewal"; riskKeywords.functional
    // includes "renew". The fixture label "Underwriter shall renew..." contains "renew".
    // Kills: mutant that drops riskKeyword scanning.
    const result = runPipeline("insuranceRequirement.synthetic.json", insuranceDefault);
    expect(result.riskHints).toContain("renew");
  });

  it("insurance priority is P1 (renewal/claim hit the second priority bucket)", () => {
    // insuranceDefault.priorityKeywords[1] = ["claim","policy","premium","underwriting"].
    // "claim" appears in label → P1.
    // Kills: mutant that ignores the priorityKeyword matching.
    const result = runPipeline("insuranceRequirement.synthetic.json", insuranceDefault);
    expect(result.priorityHint).toBe("P1");
  });

  it("insurance intent extracts exactly 2 requirement candidate phrases", () => {
    // Both labels have modal verbs ("shall"/"must") → both qualify as requirement candidates.
    const result = runPipeline("insuranceRequirement.synthetic.json", insuranceDefault);
    expect(result.requirementCandidateCount).toBe(2);
  });
});

// ─── Regression domain: golden invariants ────────────────────────────────────

describe("pipelineParity — regression golden invariants", () => {
  it("derives exactly 2 candidates from 2 atoms", () => {
    const result = runPipeline("regressionRequirement.synthetic.json", regressionDefault);
    expect(result.candidateCount).toBe(2);
    expect(result.dedupedCount).toBe(2);
  });

  it("well-formed regression candidates produce zero validation findings", () => {
    const result = runPipeline("regressionRequirement.synthetic.json", regressionDefault);
    expect(result.findingCount).toBe(0);
  });

  it("regression coverage is 100%", () => {
    const result = runPipeline("regressionRequirement.synthetic.json", regressionDefault);
    expect(result.coveragePercentage).toBe(100);
  });

  it("regression intent detects smoke/regression/release risk hints", () => {
    // Fixture labels: "Smoke release path..." and "Regression suite shall verify..."
    // regressionDefault.riskKeywords.regression = ["regression","smoke","release","stable"].
    // Kills: mutant that drops riskKeyword scanning in deriveIntent.
    const result = runPipeline("regressionRequirement.synthetic.json", regressionDefault);
    expect(result.riskHints).toContain("smoke");
    expect(result.riskHints).toContain("regression");
    expect(result.riskHints).toContain("release");
  });

  it("regression priority is P0 (smoke/release hit the top priority bucket)", () => {
    // regressionDefault.priorityKeywords[0] = ["smoke","critical-path","release"].
    // "smoke" and "release" appear in the fixture → P0.
    const result = runPipeline("regressionRequirement.synthetic.json", regressionDefault);
    expect(result.priorityHint).toBe("P0");
  });

  it("regression intent extracts exactly 2 requirement candidate phrases", () => {
    const result = runPipeline("regressionRequirement.synthetic.json", regressionDefault);
    expect(result.requirementCandidateCount).toBe(2);
  });
});

// ─── Structural contract: assertCoverageMapInvariant passes for all fixtures ──

describe("pipelineParity — coverage map invariant holds for all fixtures", () => {
  it("banking: assertCoverageMapInvariant does not throw", () => {
    const fixture = loadFixture("bankingRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, bankingDefault);
    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const deduped = deduplicateCandidates(candidates);
    const map = buildCoverageMap({
      runId: fixture.runId,
      atoms: fixture.atoms,
      candidates: deduped,
    });
    expect(() => {
      QualityIntelligence.assertCoverageMapInvariant(map);
    }).not.toThrow();
  });

  it("insurance: assertCoverageMapInvariant does not throw", () => {
    const fixture = loadFixture("insuranceRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, insuranceDefault);
    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const deduped = deduplicateCandidates(candidates);
    const map = buildCoverageMap({
      runId: fixture.runId,
      atoms: fixture.atoms,
      candidates: deduped,
    });
    expect(() => {
      QualityIntelligence.assertCoverageMapInvariant(map);
    }).not.toThrow();
  });

  it("regression: assertCoverageMapInvariant does not throw", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, regressionDefault);
    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const deduped = deduplicateCandidates(candidates);
    const map = buildCoverageMap({
      runId: fixture.runId,
      atoms: fixture.atoms,
      candidates: deduped,
    });
    expect(() => {
      QualityIntelligence.assertCoverageMapInvariant(map);
    }).not.toThrow();
  });
});
