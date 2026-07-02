// Quality Intelligence validation (Epic #270, Issue #272).
//
// Pure schema/logic validators that emit `QualityIntelligenceValidationFinding`
// records. NO judge calls in this module — the model-assisted adversarial
// test-quality judge ships separately (Epic #736, keiko-server judgePort + the
// workflow judge stage) and augments these deterministic checks.
//
// v1 covers deterministic checks per candidate:
//   1. schema-completeness — title/steps/expectedResults must be non-empty.
//   2. consecutive-step-repeat — an adjacent step must not canonically repeat the one before it
//      (a context-changing step between two identical actions is allowed by design).
//   3. expected-presence    — at least one expected result must be present.
//   4. trivial-contradiction — a precondition and an expected result share the
//      same negation-stripped core but have opposite negation parity (XOR):
//      exactly one of the two contains a negation word. Both positive or both
//      negated → consistent; one positive + one negated → contradiction.
//   5. generic-expected-result — expected results must not be placeholder-quality prose.
//   6. numeric-boundary-depth — numeric thresholds should show boundary-near test signals.
//   7. cross-field-depth — coupled field/rule requirements should not be tested as happy-path only.
//
// Structurally inspired by
// Test Intelligence reference (TI) packages/core-engine/src/
//   cross-field-invariant-engine.ts and acceptance-criteria.ts — but with
// the model-judge tier excluded and a Keiko-shaped finding output.

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";

import {
  normaliseCandidateText,
  normaliseGermanComparisonText,
  normaliseText,
} from "./assertions.js";

const NEGATION_PATTERN =
  /\b(not|never|no longer|cannot|isn't|aren't|won't|doesn't|do not|nicht|kein(?:e|en|em|er|es)?|niemals|nie|ohne)\b/iu;
const GENERIC_EXPECTED_RESULT_PATTERN =
  /\b(all requirements satisfied|behaviou?r matches the cited evidence|expected result|erwartetes ergebnis|funktioniert korrekt|verhalten entspricht(?: der)? evidenz|wie erwartet)\b/iu;
const NUMERIC_THRESHOLD_PATTERN =
  /\b\d+(?:[.\s]\d{3})*(?:[.,]\d+)?\s*(?:eur|euro|€|%|prozent|ms|millisekunden|sekunden|sek|minuten|min|stunden|h)\b/giu;
const ANY_NUMBER_PATTERN = /\b\d+(?:[.\s]\d{3})*(?:[.,]\d+)?\b/gu;
const ANY_NUMBER_TEST_PATTERN = /\b\d+(?:[.\s]\d{3})*(?:[.,]\d+)?\b/u;
const BOUNDARY_SIGNAL_PATTERN =
  /\b(grenzwert|grenzwertanalyse|boundary|unterhalb|oberhalb|knapp|genau|gleich|kleiner|groesser|größer|ab|bis|limit|schwelle|ueber|über)\b/iu;
const CROSS_FIELD_REQUIREMENT_PATTERN =
  /\b(betrag|limit|tageslimit|rolle|status|kundentyp|konto|waehrung|währung|freigabe|produkt)\b.+\b(und|oder|wenn|falls|abhaengig|abhängig)\b/iu;
const CROSS_FIELD_TEST_SIGNAL_PATTERN =
  /\b(entscheidungstabelle|decision table|kombination|matrix|negativ|fehler|ablehnen|nicht|ohne|ungueltig|ungültig|unauthori[sz]ed)\b/iu;
const TRIVIAL_CONTRADICTION_MAX_LINES = 128;

export type ValidateCandidateAtomTextSource =
  ReadonlyMap<string, string> | Readonly<Record<string, string>> | readonly AtomTextEntry[];

interface AtomTextEntry {
  readonly atomId: string;
  readonly text: string;
}

export interface ValidateCandidatesOptions {
  /** Optional canonical requirement text keyed by evidence atom id for content-depth checks. */
  readonly atomTextById?: ValidateCandidateAtomTextSource | undefined;
}

const collapseWhitespace = (value: string): string => value.replace(/\s+/gu, " ").trim();

// Use the shared German comparison fold so validation matches deduplication on bidi/zero-width
// spoofing and ß/ss equivalence without mutating value-bearing candidate text.
const canonicaliseLine = (value: string): string =>
  collapseWhitespace(normaliseGermanComparisonText(normaliseCandidateText(value)));

const stripNegation = (value: string): string =>
  value.replace(NEGATION_PATTERN, " ").replace(/\s+/gu, " ").trim();

interface NegationComparableLine {
  readonly core: string;
  readonly negated: boolean;
}

const toNegationComparableLine = (value: string): NegationComparableLine | undefined => {
  const canonical = canonicaliseLine(value);
  const core = stripNegation(canonical);
  if (core.length === 0) return undefined;
  return { core, negated: NEGATION_PATTERN.test(canonical) };
};

const toNegationComparableLines = (
  values: readonly string[],
): readonly NegationComparableLine[] => {
  const lines: NegationComparableLine[] = [];
  for (const value of values.slice(0, TRIVIAL_CONTRADICTION_MAX_LINES)) {
    const line = toNegationComparableLine(value);
    if (line !== undefined) lines.push(line);
  }
  return Object.freeze(lines);
};

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

const buildTestQualityFinding = (
  runId: QualityIntelligence.QualityIntelligenceRunId,
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
  ordinal: number,
  severity: QualityIntelligence.QualityIntelligenceSeverity,
  summary: string,
): QualityIntelligence.QualityIntelligenceTestQualityFinding => {
  const idString = deriveFindingIdString(runId, String(candidate.id), "test-quality", ordinal);
  return Object.freeze({
    kind: "test-quality",
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
  const preconditionNegationsByCore = new Map<string, Set<boolean>>();
  for (const pre of toNegationComparableLines(candidate.preconditions)) {
    const negations = preconditionNegationsByCore.get(pre.core) ?? new Set<boolean>();
    negations.add(pre.negated);
    preconditionNegationsByCore.set(pre.core, negations);
  }
  for (const result of toNegationComparableLines(candidate.expectedResults)) {
    const preNegations = preconditionNegationsByCore.get(result.core);
    // Contradiction iff cores match AND exactly one side carries a negation (XOR parity).
    if (preNegations?.has(!result.negated) === true) {
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
  return [];
};

function normaliseAtomTextSource(
  source: ValidateCandidateAtomTextSource | undefined,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (source === undefined) return map;
  if (isReadonlyStringMap(source)) {
    for (const [atomId, text] of source.entries()) map.set(atomId, text);
    return map;
  }
  if (isAtomTextEntryArray(source)) {
    for (const entry of source) map.set(entry.atomId, entry.text);
    return map;
  }
  for (const [atomId, text] of Object.entries(source)) {
    if (typeof text === "string") map.set(atomId, text);
  }
  return map;
}

function isReadonlyStringMap(
  source: ValidateCandidateAtomTextSource,
): source is ReadonlyMap<string, string> {
  return source instanceof Map;
}

function isAtomTextEntryArray(
  source: ValidateCandidateAtomTextSource,
): source is readonly AtomTextEntry[] {
  return Array.isArray(source);
}

function candidateBody(
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
): string {
  return canonicaliseLine(
    [
      candidate.title,
      ...candidate.preconditions,
      ...candidate.steps,
      ...candidate.expectedResults,
    ].join("\n"),
  );
}

function atomTextsForCandidate(
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
  atomTextById: ReadonlyMap<string, string>,
): readonly string[] {
  const texts: string[] = [];
  for (const atomId of candidate.derivedFromAtomIds) {
    const text = atomTextById.get(String(atomId));
    if (text !== undefined && normaliseText(text).length > 0) texts.push(text);
  }
  return Object.freeze(texts);
}

function normaliseNumberToken(token: string): string {
  return token.replace(/[.\s]/gu, "").replace(",", ".");
}

function numericThresholdTokens(requirementText: string): readonly string[] {
  const tokens = new Set<string>();
  for (const match of requirementText.matchAll(NUMERIC_THRESHOLD_PATTERN)) {
    const raw = match[0];
    for (const numberMatch of raw.matchAll(ANY_NUMBER_PATTERN)) {
      const value = numberMatch[0];
      tokens.add(value.toLowerCase());
      tokens.add(normaliseNumberToken(value).toLowerCase());
    }
  }
  return Object.freeze(Array.from(tokens).filter((token) => token.length > 0));
}

function candidateMentionsThreshold(
  candidateText: string,
  thresholdTokens: readonly string[],
): boolean {
  const compactCandidateText = normaliseNumberToken(candidateText);
  for (const token of thresholdTokens) {
    if (candidateText.includes(token) || compactCandidateText.includes(token)) return true;
  }
  return false;
}

function hasBoundaryDepth(candidateText: string, thresholdTokens: readonly string[]): boolean {
  if (thresholdTokens.length === 0) return true;
  if (candidateMentionsThreshold(candidateText, thresholdTokens)) return true;
  return BOUNDARY_SIGNAL_PATTERN.test(candidateText) && ANY_NUMBER_TEST_PATTERN.test(candidateText);
}

const checkGenericExpectedResults = (
  runId: QualityIntelligence.QualityIntelligenceRunId,
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
): readonly QualityIntelligence.QualityIntelligenceValidationFinding[] => {
  for (const expected of candidate.expectedResults) {
    const canonical = canonicaliseLine(expected);
    if (GENERIC_EXPECTED_RESULT_PATTERN.test(canonical)) {
      return [
        buildTestQualityFinding(
          runId,
          candidate,
          5,
          "medium",
          "Expected result is too generic to be independently verifiable.",
        ),
      ];
    }
  }
  return [];
};

const checkDeterministicTestDepth = (
  runId: QualityIntelligence.QualityIntelligenceRunId,
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
  atomTextById: ReadonlyMap<string, string>,
): readonly QualityIntelligence.QualityIntelligenceValidationFinding[] => {
  const requirementTexts = atomTextsForCandidate(candidate, atomTextById);
  if (requirementTexts.length === 0) return [];
  const text = candidateBody(candidate);
  const findings: QualityIntelligence.QualityIntelligenceValidationFinding[] = [];

  const thresholdTokens = requirementTexts.flatMap((requirementText) =>
    numericThresholdTokens(requirementText),
  );
  if (thresholdTokens.length > 0 && !hasBoundaryDepth(text, thresholdTokens)) {
    findings.push(
      buildTestQualityFinding(
        runId,
        candidate,
        6,
        "medium",
        "Numeric requirement threshold is cited without boundary-near test signals.",
      ),
    );
  }

  const hasCrossFieldRequirement = requirementTexts.some((requirementText) =>
    CROSS_FIELD_REQUIREMENT_PATTERN.test(canonicaliseLine(requirementText)),
  );
  if (hasCrossFieldRequirement && !CROSS_FIELD_TEST_SIGNAL_PATTERN.test(text)) {
    findings.push(
      buildTestQualityFinding(
        runId,
        candidate,
        7,
        "low",
        "Cross-field requirement is tested only as a happy path; add decision-table or negative coverage.",
      ),
    );
  }

  return Object.freeze(findings);
};

/**
 * Validate a list of candidates and return every emitted finding. Pure;
 * deterministic; no IO. Empty `candidates` returns the empty array.
 */
export const validateCandidates = (
  runId: QualityIntelligence.QualityIntelligenceRunId,
  candidates: readonly QualityIntelligence.QualityIntelligenceTestCaseCandidate[],
  options: ValidateCandidatesOptions = {},
): readonly QualityIntelligence.QualityIntelligenceValidationFinding[] => {
  if (candidates.length === 0) {
    return Object.freeze([] as readonly QualityIntelligence.QualityIntelligenceValidationFinding[]);
  }
  const atomTextById = normaliseAtomTextSource(options.atomTextById);
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
    for (const finding of checkGenericExpectedResults(runId, candidate)) {
      out.push(finding);
    }
    for (const finding of checkDeterministicTestDepth(runId, candidate, atomTextById)) {
      out.push(finding);
    }
  }
  return Object.freeze(out);
};
