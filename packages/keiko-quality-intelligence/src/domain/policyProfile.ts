// Quality Intelligence policy-profile constants (Epic #270, Issue #272).
//
// Pure data, deeply frozen. A policy profile carries the per-domain heuristic
// configuration that downstream callers (validators, test-design model,
// coverage relevance) blend with the source envelopes. v1 only encodes the
// fields the test-design model needs; richer governance policies land with
// #282.
//
// Inspired structurally by the per-domain heuristics under
// Test Intelligence reference (TI) packages/core-engine/src/intent-derivation.ts
// — porting the lexical hints, not any provider-specific tuning.

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

export interface PolicyProfile {
  /** Stable identifier, used by callers to attribute outputs. */
  readonly id: string;
  /** Display-only label. */
  readonly displayLabel: string;
  /**
   * Keywords that, when present in source envelopes or atoms, bias the derived
   * intent's priority toward the head of this list. Matching uses the shared
   * German keyword fold, so umlaut and ASCII transliteration variants compare equal.
   * Ordering implies severity: index 0 is the highest-priority bucket.
   */
  readonly priorityKeywords: readonly (readonly string[])[];
  /**
   * Keywords that signal a risk class. The first matching class (in the order
   * risk-classes are enumerated below) wins. Pure heuristic.
   */
  readonly riskKeywords: Readonly<
    Record<QualityIntelligence.QualityIntelligenceRiskClass, readonly string[]>
  >;
  /** Default risk class when no risk keyword matches. */
  readonly defaultRiskClass: QualityIntelligence.QualityIntelligenceRiskClass;
  /** Default priority when no priority keyword matches. */
  readonly defaultPriority: QualityIntelligence.QualityIntelligencePriority;
}

const freezeProfile = (profile: PolicyProfile): PolicyProfile => {
  for (const keywords of profile.priorityKeywords) {
    Object.freeze(keywords);
  }
  Object.freeze(profile.priorityKeywords);
  for (const value of Object.values(profile.riskKeywords)) {
    Object.freeze(value);
  }
  Object.freeze(profile.riskKeywords);
  return Object.freeze(profile);
};

/**
 * Default profile for banking workflows. Heightens safety/compliance terms.
 */
export const bankingDefault: PolicyProfile = freezeProfile({
  id: "banking-default",
  displayLabel: "Banking — default",
  priorityKeywords: [
    ["fraud", "aml", "kyc", "sanction", "betrug", "geldwäsche", "sanktion", "dsgvo", "bafin"],
    [
      "payment",
      "transfer",
      "settlement",
      "interest",
      "zahlung",
      "überweisung",
      "sepa",
      "konto",
      "limit",
      "kredit",
      "bonität",
      "sperrung",
      "vier-augen",
      "freigabe",
    ],
    ["statement", "balance", "ledger", "kontoauszug", "saldo", "buchung"],
    ["preference", "theme", "marketing"],
  ],
  riskKeywords: {
    safety: ["unauthorised", "lockout", "credential", "session", "sperrung", "pin", "tan"],
    compliance: [
      "aml",
      "kyc",
      "gdpr",
      "regulator",
      "sanction",
      "audit",
      "dsgvo",
      "bafin",
      "geldwäsche",
      "sanktion",
      "betrug",
      "vier-augen",
      "freigabe",
    ],
    regression: ["regression", "smoke", "release"],
    functional: [
      "enter",
      "submit",
      "confirm",
      "cancel",
      "zahlung",
      "überweisung",
      "iban",
      "bic",
      "konto",
      "limit",
      "kredit",
      "bonität",
    ],
    visual: ["layout", "spacing", "colour", "color", "icon"],
  },
  defaultRiskClass: "compliance",
  defaultPriority: "P2",
});

/**
 * Default profile for insurance workflows. Tracks policy/claim language.
 */
export const insuranceDefault: PolicyProfile = freezeProfile({
  id: "insurance-default",
  displayLabel: "Insurance — default",
  priorityKeywords: [
    ["fraud", "denial", "fatality", "betrug", "ablehnung"],
    [
      "claim",
      "policy",
      "premium",
      "underwriting",
      "schaden",
      "schadenfall",
      "police",
      "prämie",
      "deckung",
      "selbstbehalt",
      "versicherungsnehmer",
    ],
    ["quote", "renewal", "angebot", "verlängerung"],
    ["preference", "marketing", "newsletter"],
  ],
  riskKeywords: {
    safety: ["fatal", "injury", "exposure", "verletzung", "selbstbehalt"],
    compliance: [
      "regulator",
      "gdpr",
      "consent",
      "broker",
      "dsgvo",
      "bafin",
      "einwilligung",
      "makler",
    ],
    regression: ["regression", "smoke"],
    functional: [
      "submit",
      "renew",
      "approve",
      "decline",
      "schaden",
      "schadenfall",
      "police",
      "prämie",
      "deckung",
      "versicherungsnehmer",
    ],
    visual: ["layout", "spacing", "icon", "logo"],
  },
  defaultRiskClass: "functional",
  defaultPriority: "P2",
});

/**
 * Default profile for regression suites. Biases toward existing functional
 * paths over novel discovery.
 */
export const regressionDefault: PolicyProfile = freezeProfile({
  id: "regression-default",
  displayLabel: "Regression — default",
  priorityKeywords: [
    ["smoke", "critical-path", "release", "kritischer-pfad", "freigabe"],
    ["regression", "regressionstest"],
    ["edge-case", "randfall"],
    ["nice-to-have", "optional"],
  ],
  riskKeywords: {
    safety: ["crash", "data-loss", "datenverlust", "absturz"],
    compliance: ["audit", "log", "prüfprotokoll"],
    regression: ["regression", "smoke", "release", "stable", "stabil", "regressionstest"],
    functional: ["form", "click", "submit", "formular", "klick", "absenden"],
    visual: ["layout", "colour", "color", "spacing"],
  },
  defaultRiskClass: "regression",
  defaultPriority: "P2",
});

export const ALL_POLICY_PROFILES: readonly PolicyProfile[] = Object.freeze([
  bankingDefault,
  insuranceDefault,
  regressionDefault,
]);
