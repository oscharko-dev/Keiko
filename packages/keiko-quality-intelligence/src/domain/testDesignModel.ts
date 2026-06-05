// Quality Intelligence test-design model (Epic #270, Issue #272).
//
// Converts an `IntentSummary` plus the evidence atoms it was derived from
// into a deterministic list of draft `QualityIntelligenceTestCaseCandidate`
// records. NO model calls; NO randomness; ID derivation is content-hash +
// position based, so the same input always produces the same candidate IDs.
//
// Structurally inspired by
// Test Intelligence reference (TI) packages/core-engine/src/intent-derivation.ts
// (the IR → candidate translation phase). The TI reference produces richer
// UI-oriented candidates with screen/route metadata; our Keiko port stays
// envelope/atom-shaped and policy-driven.

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";

import { isKnownPriority, normaliseText } from "./assertions.js";
import type { IntentSummary } from "./intentDerivation.js";
import type { PolicyProfile } from "./policyProfile.js";
import { regressionDefault } from "./policyProfile.js";

export interface DesignTestCaseCandidatesInput {
  readonly runId: QualityIntelligence.QualityIntelligenceRunId;
  readonly intent: IntentSummary;
  readonly atoms: readonly QualityIntelligence.QualityIntelligenceEvidenceAtom[];
  readonly profile?: PolicyProfile;
}

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const stableSortAtoms = (
  atoms: readonly QualityIntelligence.QualityIntelligenceEvidenceAtom[],
): readonly QualityIntelligence.QualityIntelligenceEvidenceAtom[] => {
  return [...atoms].sort((left, right) =>
    compareString(left.canonicalHashSha256Hex, right.canonicalHashSha256Hex),
  );
};

const deriveRiskClass = (
  atom: QualityIntelligence.QualityIntelligenceEvidenceAtom,
  profile: PolicyProfile,
): QualityIntelligence.QualityIntelligenceRiskClass => {
  if (atom.kind === "design-fragment") {
    return "visual";
  }
  if (atom.kind === "requirement") {
    return profile.defaultRiskClass === "visual" ? "functional" : profile.defaultRiskClass;
  }
  return profile.defaultRiskClass;
};

const derivePriority = (
  intent: IntentSummary,
  profile: PolicyProfile,
): QualityIntelligence.QualityIntelligencePriority => {
  if (intent.priorityHint !== "unknown" && isKnownPriority(intent.priorityHint)) {
    return intent.priorityHint;
  }
  return profile.defaultPriority;
};

const buildTitle = (
  atom: QualityIntelligence.QualityIntelligenceEvidenceAtom,
  intent: IntentSummary,
  index: number,
): string => {
  const themes = intent.themes.slice(0, 2).join(" / ");
  const indexLabel = `#${String(index + 1).padStart(3, "0")}`;
  const subject = themes.length > 0 ? themes : atom.kind;
  return `${indexLabel} ${subject} — ${atom.kind}`;
};

const buildPreconditions = (intent: IntentSummary): readonly string[] => {
  if (intent.requirementCandidates.length === 0) {
    return Object.freeze([] as readonly string[]);
  }
  return Object.freeze(intent.requirementCandidates.slice(0, 3));
};

const buildSteps = (
  atom: QualityIntelligence.QualityIntelligenceEvidenceAtom,
  intent: IntentSummary,
): readonly string[] => {
  const steps: string[] = [];
  const theme = intent.themes[0];
  if (theme !== undefined) {
    steps.push(`Open the ${theme} flow.`);
  } else {
    steps.push("Open the target flow.");
  }
  steps.push(`Reference atom ${atom.id} (kind: ${atom.kind}).`);
  steps.push("Apply the deterministic checks listed in the expected results.");
  return Object.freeze(steps);
};

const buildExpectedResults = (
  atom: QualityIntelligence.QualityIntelligenceEvidenceAtom,
  intent: IntentSummary,
): readonly string[] => {
  const results: string[] = [];
  if (intent.requirementCandidates.length > 0) {
    results.push(`The flow satisfies: ${intent.requirementCandidates[0] ?? ""}`);
  } else {
    results.push("The flow completes without an error.");
  }
  results.push(`Evidence atom ${atom.canonicalHashSha256Hex.slice(0, 12)} remains canonical.`);
  return Object.freeze(results);
};

const buildTags = (
  intent: IntentSummary,
  riskClass: QualityIntelligence.QualityIntelligenceRiskClass,
): readonly string[] => {
  const tags = new Set<string>();
  for (const theme of intent.themes) {
    tags.add(`theme:${theme}`);
  }
  for (const risk of intent.riskHints) {
    tags.add(`risk-hint:${risk}`);
  }
  tags.add(`risk-class:${riskClass}`);
  return Object.freeze(Array.from(tags).sort(compareString));
};

const deriveCandidateIdString = (
  runId: QualityIntelligence.QualityIntelligenceRunId,
  atom: QualityIntelligence.QualityIntelligenceEvidenceAtom,
  index: number,
): string => {
  const payload = ["v1", String(runId), atom.canonicalHashSha256Hex, String(index)].join("");
  const digest = sha256Hex(payload).slice(0, 32);
  return `qi-candidate-${digest}`;
};

/**
 * Produce deterministic draft candidates from the intent summary + atoms.
 * Returns the empty array when the atom list is empty. Atoms are first
 * sorted by canonical hash so input ordering does not affect IDs.
 *
 * Candidate IDs are derived as
 * `qi-candidate-<32-hex-of-sha256(v1<runId><atomHash><index>)>`
 * — collision-resistant and round-trip-stable.
 */
export const designTestCaseCandidates = (
  input: DesignTestCaseCandidatesInput,
): readonly QualityIntelligence.QualityIntelligenceTestCaseCandidate[] => {
  const { runId, intent, atoms } = input;
  const profile = input.profile ?? regressionDefault;
  if (atoms.length === 0) {
    return Object.freeze([] as readonly QualityIntelligence.QualityIntelligenceTestCaseCandidate[]);
  }

  const sorted = stableSortAtoms(atoms);
  const priority = derivePriority(intent, profile);

  const candidates: QualityIntelligence.QualityIntelligenceTestCaseCandidate[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const atom = sorted[index];
    if (atom === undefined) {
      continue;
    }
    const idString = deriveCandidateIdString(runId, atom, index);
    const id = QualityIntelligence.asQualityIntelligenceTestCaseId(idString);
    const riskClass = deriveRiskClass(atom, profile);
    const title = normaliseText(buildTitle(atom, intent, index));
    const candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate = {
      id,
      runId,
      derivedFromAtomIds: Object.freeze([atom.id]),
      title,
      preconditions: buildPreconditions(intent),
      steps: buildSteps(atom, intent),
      expectedResults: buildExpectedResults(atom, intent),
      priority,
      riskClass,
      tags: buildTags(intent, riskClass),
      status: "proposed",
    };
    candidates.push(Object.freeze(candidate));
  }
  return Object.freeze(candidates);
};
