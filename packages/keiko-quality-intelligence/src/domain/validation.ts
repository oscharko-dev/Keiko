// Quality Intelligence validation (Epic #270, Issue #272).
//
// Pure schema/logic validators that emit `QualityIntelligenceValidationFinding`
// records. NO judge calls in this module — the model-assisted adversarial
// test-quality judge ships separately (Epic #736, keiko-server judgePort + the
// workflow judge stage) and augments these deterministic checks.
//
// v1 covers four deterministic checks per candidate:
//   1. schema-completeness — title/steps/expectedResults must be non-empty.
//   2. consecutive-step-repeat — an adjacent step must not canonically repeat the one before it
//      (a context-changing step between two identical actions is allowed by design).
//   3. expected-presence    — at least one expected result must be present.
//   4. trivial-contradiction — a precondition and an expected result share the
//      same negation-stripped core but have opposite negation parity (XOR):
//      exactly one of the two contains a negation word. Both positive or both
//      negated → consistent; one positive + one negated → contradiction.
//
// Structurally inspired by
// Test Intelligence reference (TI) packages/core-engine/src/
//   cross-field-invariant-engine.ts and acceptance-criteria.ts — but with
// the model-judge tier excluded and a Keiko-shaped finding output.

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";

import { normaliseCandidateText, normaliseText } from "./assertions.js";

const NEGATION_PATTERN = /\b(not|never|no longer|cannot|isn't|aren't|won't|doesn't|do not)\b/iu;

const collapseWhitespace = (value: string): string => value.replace(/\s+/gu, " ").trim();

// Use normaliseCandidateText (NFKC + bidi/zero-width strip + trim) so that two candidates
// differing only by injected bidi or zero-width spoofing chars produce the same equivalence key.
const canonicaliseLine = (value: string): string =>
  collapseWhitespace(normaliseCandidateText(value).toLowerCase());

const stripNegation = (value: string): string =>
  value.replace(NEGATION_PATTERN, " ").replace(/\s+/gu, " ").trim();

const deriveFindingIdString = (
  runId: QualityIntelligence.QualityIntelligenceRunId,
  candidateId: string,
  kind: QualityIntelligence.QualityIntelligenceValidationFindingKind,
  ordinal: number,
): string => {
  const payload = ["v1", String(runId), candidateId, kind, String(ordinal)].join("");
  return `qi-finding-${sha256Hex(payload).slice(0, 32)}`;
};

const buildLogicDefect = (
  runId: QualityIntelligence.QualityIntelligenceRunId,
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
  ordinal: number,
  severity: QualityIntelligence.QualityIntelligenceSeverity,
  summary: string,
): QualityIntelligence.QualityIntelligenceLogicDefectFinding => {
  const idString = deriveFindingIdString(runId, String(candidate.id), "logic-defect", ordinal);
  return Object.freeze({
    kind: "logic-defect",
    id: QualityIntelligence.asQualityIntelligenceValidationFindingId(idString),
    runId,
    candidateId: candidate.id,
    severity,
    summary,
    evidenceAtomIds: Object.freeze([...candidate.derivedFromAtomIds]),
  });
};

const buildSemanticDefect = (
  runId: QualityIntelligence.QualityIntelligenceRunId,
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
  ordinal: number,
  severity: QualityIntelligence.QualityIntelligenceSeverity,
  summary: string,
): QualityIntelligence.QualityIntelligenceSemanticDefectFinding => {
  const idString = deriveFindingIdString(runId, String(candidate.id), "semantic-defect", ordinal);
  return Object.freeze({
    kind: "semantic-defect",
    id: QualityIntelligence.asQualityIntelligenceValidationFindingId(idString),
    runId,
    candidateId: candidate.id,
    severity,
    summary,
    evidenceAtomIds: Object.freeze([...candidate.derivedFromAtomIds]),
  });
};

const checkSchemaCompleteness = (
  runId: QualityIntelligence.QualityIntelligenceRunId,
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
): readonly QualityIntelligence.QualityIntelligenceValidationFinding[] => {
  const findings: QualityIntelligence.QualityIntelligenceValidationFinding[] = [];
  if (normaliseText(candidate.title).length === 0) {
    findings.push(
      buildLogicDefect(runId, candidate, 0, "high", "Candidate title is empty after NFKC trim."),
    );
  }
  if (candidate.steps.length === 0) {
    findings.push(
      buildLogicDefect(runId, candidate, 1, "high", "Candidate has no executable steps."),
    );
  }
  return findings;
};

const checkExpectedResultsPresence = (
  runId: QualityIntelligence.QualityIntelligenceRunId,
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
): readonly QualityIntelligence.QualityIntelligenceValidationFinding[] => {
  if (candidate.expectedResults.length === 0) {
    return [
      buildLogicDefect(runId, candidate, 2, "high", "Candidate has no expected results recorded."),
    ];
  }
  return [];
};

const checkConsecutiveStepRepeat = (
  runId: QualityIntelligence.QualityIntelligenceRunId,
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
): readonly QualityIntelligence.QualityIntelligenceValidationFinding[] => {
  let previousCanonical = "";
  for (const step of candidate.steps) {
    const canonical = canonicaliseLine(step);
    if (canonical.length === 0) {
      continue;
    }
    if (canonical === previousCanonical) {
      return [
        buildLogicDefect(
          runId,
          candidate,
          3,
          "medium",
          "Candidate step sequence contains a consecutive canonical-line repeat.",
        ),
      ];
    }
    previousCanonical = canonical;
  }
  return [];
};

const checkTrivialContradictions = (
  runId: QualityIntelligence.QualityIntelligenceRunId,
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
): readonly QualityIntelligence.QualityIntelligenceValidationFinding[] => {
  if (candidate.preconditions.length === 0 || candidate.expectedResults.length === 0) {
    return [];
  }
  for (const result of candidate.expectedResults) {
    const resultCanonical = canonicaliseLine(result);
    const resultCore = stripNegation(resultCanonical);
    if (resultCore.length === 0) {
      continue;
    }
    const negatedResult = NEGATION_PATTERN.test(resultCanonical);
    for (const pre of candidate.preconditions) {
      const preCanonical = canonicaliseLine(pre);
      const preCore = stripNegation(preCanonical);
      if (preCore.length === 0) {
        continue;
      }
      const negatedPre = NEGATION_PATTERN.test(preCanonical);
      // Contradiction iff cores match AND exactly one side carries a negation (XOR parity).
      if (preCore === resultCore && negatedPre !== negatedResult) {
        return [
          buildSemanticDefect(
            runId,
            candidate,
            4,
            "medium",
            "Expected result trivially contradicts a precondition (post-negation match).",
          ),
        ];
      }
    }
  }
  return [];
};

/**
 * Validate a list of candidates and return every emitted finding. Pure;
 * deterministic; no IO. Empty `candidates` returns the empty array.
 */
export const validateCandidates = (
  runId: QualityIntelligence.QualityIntelligenceRunId,
  candidates: readonly QualityIntelligence.QualityIntelligenceTestCaseCandidate[],
): readonly QualityIntelligence.QualityIntelligenceValidationFinding[] => {
  if (candidates.length === 0) {
    return Object.freeze([] as readonly QualityIntelligence.QualityIntelligenceValidationFinding[]);
  }
  const out: QualityIntelligence.QualityIntelligenceValidationFinding[] = [];
  for (const candidate of candidates) {
    for (const finding of checkSchemaCompleteness(runId, candidate)) {
      out.push(finding);
    }
    for (const finding of checkExpectedResultsPresence(runId, candidate)) {
      out.push(finding);
    }
    for (const finding of checkConsecutiveStepRepeat(runId, candidate)) {
      out.push(finding);
    }
    for (const finding of checkTrivialContradictions(runId, candidate)) {
      out.push(finding);
    }
  }
  return Object.freeze(out);
};
