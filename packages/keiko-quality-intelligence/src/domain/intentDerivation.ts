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

import {
  containsNormalisedKeyword,
  isMeaningfulText,
  normaliseGermanKeywordText,
  normaliseText,
} from "./assertions.js";
import type { PolicyProfile } from "./policyProfile.js";
import { regressionDefault } from "./policyProfile.js";

export interface IntentSummary {
  /** Distinct themes (high-level subject buckets) the envelopes touch. */
  readonly themes: readonly string[];
  /** Candidate requirement phrases extracted from evidence text, falling back to display labels. */
  readonly requirementCandidates: readonly string[];
  /** Lower-cased risk-shaped keywords spotted across evidence text, falling back to display labels. */
  readonly riskHints: readonly string[];
  /** Derived priority bucket, biased by the policy profile. */
  readonly priorityHint: QualityIntelligence.QualityIntelligencePriority | "unknown";
  /** Whether intent came from content-bearing evidence text, label-only fallback, or no text. */
  readonly sourceMode: "body" | "label-only" | "empty";
  /** Stable diagnostic markers for callers/audits; never contains source content. */
  readonly diagnostics: readonly string[];
}

export interface DeriveIntentOptions {
  /**
   * Content-bearing canonical evidence text. When present, requirement/risk/priority derivation uses
   * this body text instead of relying only on browser-safe `displayLabel` values.
   */
  readonly evidenceTexts?: readonly string[] | undefined;
}

const REQUIREMENT_VERB_PATTERNS: readonly RegExp[] = [
  /\b(must|shall|should|cannot|may not|may|will)\b/iu,
  /\b(verify|ensure|confirm|reject|prevent|allow|deny)\b/iu,
  /\b(muss|muessen|soll|sollen|sollte|darf(?:\s+nicht)?|duerfen(?:\s+nicht)?|ist\s+zu|hat\s+zu|haben\s+zu)\b/iu,
  /\b(verifizieren|sicherstellen|bestaetigen|ablehnen|verhindern|erlauben|verweigern)\b/iu,
];

const THEME_SEPARATOR = /[\s–—:;|/,.()[\]{}]+/u;
const TRACEABILITY_ID_PATTERN = /^[A-Za-z]{2,}-\d+[A-Za-z0-9-]*$/u;
const UPPERCASE_SIGNAL_PATTERN = /^[A-ZÄÖÜ0-9]{2,}$/u;

const DOMAIN_THEME_TOKENS: ReadonlyMap<string, string> = new Map([
  ["ac", "AC"],
  ["aml", "AML"],
  ["bafin", "BaFin"],
  ["bic", "BIC"],
  ["dsgvo", "DSGVO"],
  ["eu", "EU"],
  ["iban", "IBAN"],
  ["it", "IT"],
  ["kyc", "KYC"],
  ["p0", "P0"],
  ["pin", "PIN"],
  ["sepa", "SEPA"],
  ["tan", "TAN"],
]);

const THEME_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "before",
  "by",
  "der",
  "des",
  "die",
  "das",
  "dem",
  "den",
  "do",
  "does",
  "ein",
  "eine",
  "einem",
  "einen",
  "einer",
  "for",
  "fuer",
  "hat",
  "haben",
  "in",
  "is",
  "ist",
  "kein",
  "keine",
  "mit",
  "muss",
  "muessen",
  "must",
  "nicht",
  "of",
  "oder",
  "on",
  "shall",
  "should",
  "soll",
  "sollen",
  "the",
  "to",
  "und",
  "werden",
  "wird",
  "zu",
]);

const canonicalThemeToken = (token: string): string | null => {
  const normalised = normaliseText(token);
  const folded = normaliseGermanKeywordText(normalised);
  if (folded.length === 0 || THEME_STOPWORDS.has(folded)) {
    return null;
  }
  const domainToken = DOMAIN_THEME_TOKENS.get(folded);
  if (domainToken !== undefined) {
    return domainToken;
  }
  if (normalised.length < 3 && !TRACEABILITY_ID_PATTERN.test(normalised)) {
    return null;
  }
  if (TRACEABILITY_ID_PATTERN.test(normalised) || UPPERCASE_SIGNAL_PATTERN.test(normalised)) {
    return normalised;
  }
  return normalised.toLowerCase();
};

const compareLowercase = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareLexical = (left: string, right: string): number => {
  const leftKey = normaliseGermanKeywordText(left);
  const rightKey = normaliseGermanKeywordText(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : compareLowercase(left, right);
};

const extractThemes = (label: string): readonly string[] => {
  const normalised = normaliseText(label);
  if (normalised.length === 0) {
    return [];
  }
  const tokens = normalised.split(THEME_SEPARATOR);
  const themes = new Set<string>();
  for (const token of tokens) {
    const theme = canonicalThemeToken(token);
    if (theme !== null) {
      themes.add(theme);
    }
  }
  return Array.from(themes).sort(compareLexical);
};

const lookLikeRequirementPhrase = (text: string): boolean => {
  const folded = normaliseGermanKeywordText(text);
  for (const pattern of REQUIREMENT_VERB_PATTERNS) {
    if (pattern.test(folded)) {
      return true;
    }
  }
  return false;
};

const detectRiskHints = (text: string, profile: PolicyProfile): readonly string[] => {
  const hits = new Set<string>();
  for (const keywords of Object.values(profile.riskKeywords)) {
    for (const keyword of keywords) {
      if (containsNormalisedKeyword(text, keyword)) {
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
      if (containsNormalisedKeyword(lowered, keyword)) {
        const mapped = priorityBuckets[bucketIndex];
        if (mapped !== undefined) {
          return mapped;
        }
      }
    }
  }
  return profile.defaultPriority;
};

const meaningfulNormalisedTexts = (texts: readonly string[]): readonly string[] =>
  Object.freeze(texts.map((text) => normaliseText(text)).filter((text) => isMeaningfulText(text)));

interface IntentTextSource {
  readonly sourceTexts: readonly string[];
  readonly sourceMode: IntentSummary["sourceMode"];
  readonly diagnostics: readonly string[];
}

const INTENT_DIAGNOSTICS: Readonly<Record<IntentSummary["sourceMode"], readonly string[]>> =
  Object.freeze({
    body: Object.freeze(["intent:body-text"]),
    "label-only": Object.freeze(["intent:label-only-fallback"]),
    empty: Object.freeze(["intent:no-meaningful-text"]),
  });

function intentTextSource(
  envelopes: readonly QualityIntelligence.QualityIntelligenceSourceEnvelope[],
  evidenceTexts: readonly string[],
): IntentTextSource {
  const bodyTexts = meaningfulNormalisedTexts(evidenceTexts);
  const labelTexts = meaningfulNormalisedTexts(envelopes.map((envelope) => envelope.displayLabel));

  if (bodyTexts.length > 0 && labelTexts.length > 0) {
    return Object.freeze({
      sourceTexts: Object.freeze([...labelTexts, ...bodyTexts]),
      sourceMode: "body",
      diagnostics: INTENT_DIAGNOSTICS.body,
    });
  }

  if (bodyTexts.length > 0) {
    return Object.freeze({
      sourceTexts: bodyTexts,
      sourceMode: "body",
      diagnostics: INTENT_DIAGNOSTICS.body,
    });
  }

  if (labelTexts.length > 0) {
    return Object.freeze({
      sourceTexts: labelTexts,
      sourceMode: "label-only",
      diagnostics: INTENT_DIAGNOSTICS["label-only"],
    });
  }

  return Object.freeze({
    sourceTexts: Object.freeze([] as readonly string[]),
    sourceMode: "empty",
    diagnostics: INTENT_DIAGNOSTICS.empty,
  });
}

function emptyIntentSummary(source: IntentTextSource): IntentSummary {
  return Object.freeze({
    themes: Object.freeze([] as readonly string[]),
    requirementCandidates: Object.freeze([] as readonly string[]),
    riskHints: Object.freeze([] as readonly string[]),
    priorityHint: "unknown" as const,
    sourceMode: source.sourceMode,
    diagnostics: source.diagnostics,
  });
}

/**
 * Derive a deterministic `IntentSummary` from the supplied envelopes. Returns
 * an empty summary when the input list is empty.
 *
 * @param envelopes Source envelopes. Display labels are a fallback only.
 * @param profile Policy profile. Defaults to `regressionDefault`.
 * @param options Optional content-bearing evidence text for requirement-quality intent derivation.
 */
export const deriveIntent = (
  envelopes: readonly QualityIntelligence.QualityIntelligenceSourceEnvelope[],
  profile: PolicyProfile = regressionDefault,
  options: DeriveIntentOptions = {},
): IntentSummary => {
  const source = intentTextSource(envelopes, options.evidenceTexts ?? []);
  if (source.sourceTexts.length === 0) return emptyIntentSummary(source);

  const themes = new Set<string>();
  const requirements = new Set<string>();
  const risks = new Set<string>();
  let aggregateLowered = "";

  for (const normalised of source.sourceTexts) {
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
    sourceMode: source.sourceMode,
    diagnostics: source.diagnostics,
  });
};
