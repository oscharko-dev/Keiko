// Quality Intelligence validation (Epic #270, Issue #272).
//
// Pure schema/logic validators that emit `QualityIntelligenceValidationFinding`
// records. NO judge calls — model-assisted validators (logic-judge,
// faithfulness-judge, semantic-judge) live in #279.
//
// v1 covers four deterministic checks per candidate:
//   1. schema-completeness — title/steps/expectedResults must be non-empty.
//   2. step-acyclicity     — no canonical-line repeats in the step sequence.
//   3. expected-presence    — at least one expected result must be present.
//   4. trivial-contradiction — a precondition that is also negated in an
//      expected result is a logic defect (e.g. precondition "user is logged
//      in" and expected "user is not logged in").
//
// Structurally inspired by
// Test Intelligence reference (TI) packages/core-engine/src/
//   cross-field-invariant-engine.ts and acceptance-criteria.ts — but with
// the model-judge tier excluded and a Keiko-shaped finding output.

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";

import { normaliseText } from "./assertions.js";

const NEGATION_PATTERN = /\b(not|never|no longer|cannot|isn't|aren't|won't|doesn't|do not)\b/iu;

const collapseWhitespace = (value: string): string => value.replace(/\s+/gu, " ").trim();

const canonicaliseLine = (value: string): string =>
  collapseWhitespace(normaliseText(value).toLowerCase());

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

const checkStepAcyclicity = (
  runId: QualityIntelligence.QualityIntelligenceRunId,
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
): readonly QualityIntelligence.QualityIntelligenceValidationFinding[] => {
  const seen = new Set<string>();
  for (const step of candidate.steps) {
    const canonical = canonicaliseLine(step);
    if (canonical.length === 0) {
      continue;
    }
    if (seen.has(canonical)) {
      return [
        buildLogicDefect(
          runId,
          candidate,
          3,
          "medium",
          "Candidate step sequence contains a canonical-line repeat.",
        ),
      ];
    }
    seen.add(canonical);
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
  const preStripped = candidate.preconditions.map((line) => stripNegation(canonicaliseLine(line)));
  for (const result of candidate.expectedResults) {
    const resultCanonical = canonicaliseLine(result);
    if (!NEGATION_PATTERN.test(resultCanonical)) {
      continue;
    }
    const stripped = stripNegation(resultCanonical);
    if (stripped.length === 0) {
      continue;
    }
    for (const pre of preStripped) {
      if (pre.length === 0) {
        continue;
      }
      if (pre === stripped) {
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
    for (const finding of checkStepAcyclicity(runId, candidate)) {
      out.push(finding);
    }
    for (const finding of checkTrivialContradictions(runId, candidate)) {
      out.push(finding);
    }
  }
  return Object.freeze(out);
};
