// Quality Intelligence intent derivation (Epic #270, Issue #272).
//
// Derives a structured `IntentSummary` from a list of source envelopes using
// deterministic lexical heuristics only — no embeddings, no model calls.
//
// Structurally inspired by
// Test Intelligence reference (TI) packages/core-engine/src/intent-derivation.ts
// (deriveBusinessTestIntentIr), but rewritten to consume the Keiko contracts
// surface. The TI reference performs the same role (turn structured input
// into a list of business intents) but reaches into UI-specific node trees;
// our Keiko port stays envelope-shaped and policy-driven.

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import { isMeaningfulText, normaliseText } from "./assertions.js";
import type { PolicyProfile } from "./policyProfile.js";
import { regressionDefault } from "./policyProfile.js";

export interface IntentSummary {
  /** Distinct themes (high-level subject buckets) the envelopes touch. */
  readonly themes: readonly string[];
  /** Candidate requirement phrases extracted from envelope display labels. */
  readonly requirementCandidates: readonly string[];
  /** Lower-cased risk-shaped keywords spotted across envelope display labels. */
  readonly riskHints: readonly string[];
  /** Derived priority bucket, biased by the policy profile. */
  readonly priorityHint: QualityIntelligence.QualityIntelligencePriority | "unknown";
}

const REQUIREMENT_VERB_PATTERNS: readonly RegExp[] = [
  /\b(must|shall|should|cannot|may not|may|will)\b/iu,
  /\b(verify|ensure|confirm|reject|prevent|allow|deny)\b/iu,
];

const THEME_SEPARATOR = /[\s–—:;|/,.()[\]{}]+/u;

const extractThemes = (label: string): readonly string[] => {
  const normalised = normaliseText(label);
  if (normalised.length === 0) {
    return [];
  }
  const tokens = normalised.split(THEME_SEPARATOR);
  const themes = new Set<string>();
  for (const token of tokens) {
    const lowered = token.toLowerCase();
    if (lowered.length < 3) {
      continue;
    }
    themes.add(lowered);
  }
  return Array.from(themes).sort();
};

const lookLikeRequirementPhrase = (text: string): boolean => {
  for (const pattern of REQUIREMENT_VERB_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
};

const detectRiskHints = (text: string, profile: PolicyProfile): readonly string[] => {
  const lowered = text.toLowerCase();
  const hits = new Set<string>();
  for (const keywords of Object.values(profile.riskKeywords)) {
    for (const keyword of keywords) {
      if (lowered.includes(keyword)) {
        hits.add(keyword);
      }
    }
  }
  return Array.from(hits).sort();
};

const derivePriority = (
  text: string,
  profile: PolicyProfile,
): QualityIntelligence.QualityIntelligencePriority | "unknown" => {
  if (text.length === 0) {
    return "unknown";
  }
  const lowered = text.toLowerCase();
  const priorityBuckets: readonly QualityIntelligence.QualityIntelligencePriority[] = [
    "P0",
    "P1",
    "P2",
    "P3",
  ];
  for (let bucketIndex = 0; bucketIndex < profile.priorityKeywords.length; bucketIndex += 1) {
    const keywords = profile.priorityKeywords[bucketIndex] ?? [];
    for (const keyword of keywords) {
      if (lowered.includes(keyword)) {
        const mapped = priorityBuckets[bucketIndex];
        if (mapped !== undefined) {
          return mapped;
        }
      }
    }
  }
  return profile.defaultPriority;
};

const compareLowercase = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Derive a deterministic `IntentSummary` from the supplied envelopes. Returns
 * an empty summary when the input list is empty.
 *
 * @param envelopes Source envelopes (browser-safe display labels only).
 * @param profile Policy profile. Defaults to `regressionDefault`.
 */
export const deriveIntent = (
  envelopes: readonly QualityIntelligence.QualityIntelligenceSourceEnvelope[],
  profile: PolicyProfile = regressionDefault,
): IntentSummary => {
  if (envelopes.length === 0) {
    return Object.freeze({
      themes: Object.freeze([] as readonly string[]),
      requirementCandidates: Object.freeze([] as readonly string[]),
      riskHints: Object.freeze([] as readonly string[]),
      priorityHint: "unknown" as const,
    });
  }

  const themes = new Set<string>();
  const requirements = new Set<string>();
  const risks = new Set<string>();
  let aggregateLowered = "";

  for (const envelope of envelopes) {
    const normalised = normaliseText(envelope.displayLabel);
    if (!isMeaningfulText(normalised)) {
      continue;
    }
    for (const theme of extractThemes(normalised)) {
      themes.add(theme);
    }
    if (lookLikeRequirementPhrase(normalised)) {
      requirements.add(normalised);
    }
    for (const hint of detectRiskHints(normalised, profile)) {
      risks.add(hint);
    }
    aggregateLowered =
      aggregateLowered.length === 0
        ? normalised.toLowerCase()
        : `${aggregateLowered}\n${normalised.toLowerCase()}`;
  }

  const priorityHint = derivePriority(aggregateLowered, profile);

  return Object.freeze({
    themes: Object.freeze(Array.from(themes).sort(compareLowercase)),
    requirementCandidates: Object.freeze(Array.from(requirements).sort(compareLowercase)),
    riskHints: Object.freeze(Array.from(risks).sort(compareLowercase)),
    priorityHint,
  });
};
