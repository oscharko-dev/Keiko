import { describe, expect, it } from "vitest";

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import {
  computeCandidateEquivalenceSignature,
  deduplicateCandidates,
} from "../domain/deduplication.js";

const baseCandidate = (
  overrides: Partial<QualityIntelligence.QualityIntelligenceTestCaseCandidate>,
): QualityIntelligence.QualityIntelligenceTestCaseCandidate => ({
  id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-aaaaaaaaaaaa"),
  runId: QualityIntelligence.asQualityIntelligenceRunId("qi-run-dedupe-0001"),
  derivedFromAtomIds: [
    QualityIntelligence.asQualityIntelligenceEvidenceAtomId("qi-atom-dedupe-001"),
  ],
  title: "Verify the login flow",
  preconditions: ["The user account exists"],
  steps: ["Open login page", "Enter credentials", "Submit form"],
  expectedResults: ["The user lands on the dashboard"],
  priority: "P1",
  riskClass: "functional",
  tags: ["theme:login"],
  status: "proposed",
  ...overrides,
});

describe("deduplicateCandidates", () => {
  it("returns the empty array on empty input", () => {
    expect(deduplicateCandidates([])).toEqual([]);
  });

  it("collapses two candidates whose canonical projection is identical", () => {
    const left = baseCandidate({
      id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-aaaaaaaaaaaa"),
    });
    const right = baseCandidate({
      id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-bbbbbbbbbbbb"),
      title: "  Verify the LOGIN flow  ", // whitespace + case-insensitive duplicate
    });
    const result = deduplicateCandidates([left, right]);
    expect(result.length).toBe(1);
    expect(result[0]?.id).toBe(left.id); // lexicographically smallest survives
  });

  it("preserves two candidates whose steps differ semantically", () => {
    const left = baseCandidate({});
    const right = baseCandidate({
      id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-bbbbbbbbbbbb"),
      steps: ["Open login page", "Enter different credentials", "Submit form"],
    });
    const result = deduplicateCandidates([left, right]);
    expect(result.length).toBe(2);
  });

  it("produces the same equivalence signature for whitespace-equivalent candidates", () => {
    const left = baseCandidate({});
    const right = baseCandidate({
      title: "\tverify the login flow\n",
    });
    expect(computeCandidateEquivalenceSignature(left)).toBe(
      computeCandidateEquivalenceSignature(right),
    );
  });

  it("produces different signatures for differing priority", () => {
    const left = baseCandidate({ priority: "P1" });
    const right = baseCandidate({ priority: "P3" });
    expect(computeCandidateEquivalenceSignature(left)).not.toBe(
      computeCandidateEquivalenceSignature(right),
    );
  });

  // ─── Order-independence: smaller id is second in input ────────────────────

  it("keeps the lexicographically SMALLER id even when it appears SECOND in input", () => {
    // Kills: mutant `compareCandidateById(...) < 0` → `false` (keep-first-seen).
    // With the mutant, the first-seen "bbbb" id would survive; the correct code
    // replaces the incumbent when the incoming candidate has a smaller id.
    const firstSeen = baseCandidate({
      id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-bbbbbbbbbbbb"),
    });
    const laterSeen = baseCandidate({
      id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-aaaaaaaaaaaa"),
    });
    // Both have identical canonical projections (same title, steps, results, priority, riskClass).
    expect(computeCandidateEquivalenceSignature(firstSeen)).toBe(
      computeCandidateEquivalenceSignature(laterSeen),
    );
    const result = deduplicateCandidates([firstSeen, laterSeen]);
    expect(result).toHaveLength(1);
    // The smaller id "aaaa..." must win regardless of input order.
    expect(result[0]?.id).toBe(
      QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-aaaaaaaaaaaa"),
    );
  });

  // ─── riskClass distinguishes the equivalence signature ────────────────────

  it("produces DIFFERENT signatures when riskClass differs and keeps BOTH candidates", () => {
    // Kills: mutant that omits riskClass from the signature projection.
    // "functional" and "security" (via "safety") differ in the canonical JSON →
    // different sha256 → different equivalence class → both survive dedup.
    const functional = baseCandidate({ riskClass: "functional" });
    const safety = baseCandidate({
      id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-cccccccccccc"),
      riskClass: "safety",
    });
    expect(computeCandidateEquivalenceSignature(functional)).not.toBe(
      computeCandidateEquivalenceSignature(safety),
    );
    const result = deduplicateCandidates([functional, safety]);
    expect(result).toHaveLength(2);
  });

  // ─── expectedResults distinguishes the equivalence signature ──────────────

  it("produces DIFFERENT signatures when expectedResults differ and keeps BOTH candidates", () => {
    // Kills: mutant that omits expectedResults from the signature projection.
    const left = baseCandidate({
      expectedResults: ["The user lands on the dashboard"],
    });
    const right = baseCandidate({
      id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-dddddddddddd"),
      expectedResults: ["The user sees an error message"],
    });
    expect(computeCandidateEquivalenceSignature(left)).not.toBe(
      computeCandidateEquivalenceSignature(right),
    );
    const result = deduplicateCandidates([left, right]);
    expect(result).toHaveLength(2);
  });

  // ─── preconditions distinguishes the equivalence signature ────────────────

  it("produces DIFFERENT signatures when preconditions differ and keeps BOTH candidates", () => {
    // Kills: mutant that omits preconditions from the signature projection.
    // Two candidates identical in title/steps/expectedResults/priority/riskClass
    // but with DIFFERENT preconditions are semantically distinct test cases
    // ("user logged in" vs "user is admin") and must NOT be collapsed.
    const loggedIn = baseCandidate({
      preconditions: ["The user is logged in"],
    });
    const admin = baseCandidate({
      id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-eeeeeeeeeeee"),
      preconditions: ["The user is an admin"],
    });
    expect(computeCandidateEquivalenceSignature(loggedIn)).not.toBe(
      computeCandidateEquivalenceSignature(admin),
    );
    const result = deduplicateCandidates([loggedIn, admin]);
    expect(result).toHaveLength(2);
  });

  // ─── bidi / zero-width spoofing resistance ────────────────────────────────

  it("produces the SAME equivalence signature for candidates differing only by an injected bidi char (U+200E LRM)", () => {
    // A bidi left-to-right mark injected into the title must not create a distinct dedup bucket
    // (Trojan-source hardening: normaliseCandidateText strips U+200B–U+200F before hashing).
    const clean = baseCandidate({ title: "Verify the login flow" });
    const withBidi = baseCandidate({
      id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-gggggggggggg"),
      title: "Verify‎ the login flow", // U+200E LEFT-TO-RIGHT MARK injected
    });
    expect(computeCandidateEquivalenceSignature(clean)).toBe(
      computeCandidateEquivalenceSignature(withBidi),
    );
    const result = deduplicateCandidates([clean, withBidi]);
    expect(result).toHaveLength(1);
  });

  it("produces the SAME equivalence signature for candidates differing only by a zero-width space (U+200B)", () => {
    // Zero-width space must also be stripped before signature computation.
    const clean = baseCandidate({ title: "Verify the login flow" });
    const withZwsp = baseCandidate({
      id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-hhhhhhhhhhhh"),
      title: "Verify​ the login flow", // U+200B ZERO WIDTH SPACE injected
    });
    expect(computeCandidateEquivalenceSignature(clean)).toBe(
      computeCandidateEquivalenceSignature(withZwsp),
    );
  });

  it("collapses two candidates with EQUAL preconditions (regression: empty → same signature)", () => {
    // Regression guard: candidates with identical (here: empty) preconditions
    // must still dedup to one — equal preconditions must not break dedup.
    const left = baseCandidate({ preconditions: [] });
    const right = baseCandidate({
      id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-ffffffffffff"),
      preconditions: [],
    });
    expect(computeCandidateEquivalenceSignature(left)).toBe(
      computeCandidateEquivalenceSignature(right),
    );
    const result = deduplicateCandidates([left, right]);
    expect(result).toHaveLength(1);
  });
});
