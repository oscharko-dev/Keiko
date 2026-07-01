// Deterministic Requirement Quality analysis (WP2, 2026-07-01).
//
// High-precision, model-free checks for ISO/IEC/IEEE 29148/EARS-ish requirement defects. This is
// deliberately narrower than a full requirement NLP pipeline: every emitted finding must be
// explainable, traceable to a concrete evidence atom, and redaction-safe.

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";

import { normaliseCandidateText } from "./assertions.js";
import { buildRequirementExcerpt } from "./requirementExcerpt.js";

export interface RequirementQualityAtomInput {
  readonly atom: QualityIntelligence.QualityIntelligenceEvidenceAtom;
  readonly canonicalText: string;
}

export interface AnalyzeRequirementQualityInput {
  readonly runId: QualityIntelligence.QualityIntelligenceRunId;
  readonly atoms: readonly RequirementQualityAtomInput[];
}

interface RequirementQualitySignal {
  readonly category: QualityIntelligence.QualityIntelligenceRequirementQualityCategory;
  readonly severity: QualityIntelligence.QualityIntelligenceSeverity;
  readonly confidence: number;
  readonly reason: string;
}

const AMBIGUITY_PATTERN =
  /\b(schnell|angemessen|zeitnah|regelma(?:e|ä)ssig|regelmäßig|mo(?:e|ö)glichst|benutzerfreundlich|performant)\b/iu;
const OPEN_PLACEHOLDER_PATTERN = /\b(tbd|todo|n\/a|offen|noch zu kl(?:ae|ä)ren)\b/iu;
const WEAK_MODALITY_PATTERN = /\b(sollte|kann|k(?:oe|ö)nnte|mo(?:e|ö)glichst)\b/iu;
const REQUIREMENT_MODAL_CLAUSE_PATTERN =
  /\b(muss|müssen|soll|sollen|darf nicht|dürfen nicht|hat zu|haben zu)\b/giu;
const COUPLED_DUTY_PATTERN =
  /\b(muss|müssen|soll|sollen|hat zu|haben zu)\b.+\bund\b.+\b(eingeben|best(?:ae|ä)tigen|pr(?:ue|ü)fen|freigeben|ablehnen|sperren|erzwingen|berechnen|speichern|melden)\b/iu;
const RESPONSE_OR_AVAILABILITY_PATTERN =
  /\b(antwortzeit|reaktionszeit|bearbeitungszeit|verarbeitungszeit|innerhalb|hochverf(?:ue|ü)gbar|hoch verf(?:ue|ü)gbar|verf(?:ue|ü)gbar(?:keit)?)\b/iu;
const NUMBER_WITH_MEASURABLE_UNIT_PATTERN =
  /\b\d+(?:[.,]\d+)?\s*(?:ms|millisekunden|sekunden|sek|s|minuten|min|stunden|h|%|prozent|eur|euro|€)\b/iu;
const AVAILABILITY_TARGET_PATTERN = /\b(?:sla|rto|rpo|\d+(?:[.,]\d+)?\s*(?:%|prozent))\b/iu;

function collapsedText(value: string): string {
  return normaliseCandidateText(value).replace(/\s+/gu, " ").trim();
}

function deriveFindingIdString(
  runId: QualityIntelligence.QualityIntelligenceRunId,
  atomId: QualityIntelligence.QualityIntelligenceEvidenceAtomId,
  category: QualityIntelligence.QualityIntelligenceRequirementQualityCategory,
  ordinal: number,
): string {
  const payload = ["v1-rq", String(runId), String(atomId), category, String(ordinal)].join("");
  return `qi-finding-${sha256Hex(payload).slice(0, 32)}`;
}

function atomLabel(
  atomId: QualityIntelligence.QualityIntelligenceEvidenceAtomId,
  text: string,
): string {
  const excerpt = buildRequirementExcerpt(text);
  if (excerpt === undefined) return `Atom ${String(atomId)}`;
  return `Atom ${String(atomId)} ("${excerpt}")`;
}

function toFinding(
  runId: QualityIntelligence.QualityIntelligenceRunId,
  atom: QualityIntelligence.QualityIntelligenceEvidenceAtom,
  text: string,
  signal: RequirementQualitySignal,
  ordinal: number,
): QualityIntelligence.QualityIntelligenceRequirementQualityFinding {
  return Object.freeze({
    kind: "requirement-quality",
    id: QualityIntelligence.asQualityIntelligenceValidationFindingId(
      deriveFindingIdString(runId, atom.id, signal.category, ordinal),
    ),
    runId,
    severity: signal.severity,
    summary: `${atomLabel(atom.id, text)} verletzt Requirement-Quality (${signal.category}): ${signal.reason}.`,
    evidenceAtomIds: Object.freeze([atom.id]),
    category: signal.category,
    confidence: signal.confidence,
  });
}

function hasNonVerifiablePerformanceOrAvailability(text: string): boolean {
  if (!RESPONSE_OR_AVAILABILITY_PATTERN.test(text)) return false;
  if (NUMBER_WITH_MEASURABLE_UNIT_PATTERN.test(text)) return false;
  if (AVAILABILITY_TARGET_PATTERN.test(text)) return false;
  return true;
}

function hasCompoundRequirement(text: string): boolean {
  const modalMatches = Array.from(text.matchAll(REQUIREMENT_MODAL_CLAUSE_PATTERN));
  if (modalMatches.length >= 2) return true;
  return COUPLED_DUTY_PATTERN.test(text);
}

function signalsForText(text: string): readonly RequirementQualitySignal[] {
  const signals: RequirementQualitySignal[] = [];

  if (OPEN_PLACEHOLDER_PATTERN.test(text)) {
    signals.push({
      category: "open-placeholder",
      severity: "high",
      confidence: 0.98,
      reason: "offener Platzhalter/TBD ist kein pruefbares Requirement",
    });
  }

  if (AMBIGUITY_PATTERN.test(text)) {
    signals.push({
      category: "ambiguity",
      severity: "medium",
      confidence: 0.86,
      reason: "vage Formulierung ohne messbare Akzeptanzschwelle",
    });
  }

  if (hasNonVerifiablePerformanceOrAvailability(text)) {
    signals.push({
      category: "non-verifiable",
      severity: "medium",
      confidence: 0.84,
      reason: "Zeit-/Verfuegbarkeitsaussage ohne konkrete Zahl, Einheit oder Zielwert",
    });
  }

  if (hasCompoundRequirement(text)) {
    signals.push({
      category: "compound-requirement",
      severity: "medium",
      confidence: 0.82,
      reason:
        "mehrere gekoppelte Pflichten sollten in getrennte, atomare Requirements zerlegt werden",
    });
  }

  if (WEAK_MODALITY_PATTERN.test(text)) {
    signals.push({
      category: "weak-modality",
      severity: "medium",
      confidence: 0.8,
      reason: "schwache Modalitaet ist fuer verbindliche Requirements uneindeutig",
    });
  }

  return Object.freeze(signals);
}

export function analyzeRequirementQuality(
  input: AnalyzeRequirementQualityInput,
): readonly QualityIntelligence.QualityIntelligenceRequirementQualityFinding[] {
  const findings: QualityIntelligence.QualityIntelligenceRequirementQualityFinding[] = [];
  for (const entry of input.atoms) {
    const text = collapsedText(entry.canonicalText);
    if (text.length === 0) continue;
    const signals = signalsForText(text);
    for (let ordinal = 0; ordinal < signals.length; ordinal += 1) {
      const signal = signals[ordinal];
      if (signal === undefined) continue;
      findings.push(toFinding(input.runId, entry.atom, text, signal, ordinal));
    }
  }
  return Object.freeze(findings);
}
