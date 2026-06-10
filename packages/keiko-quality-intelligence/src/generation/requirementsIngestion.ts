// Quality Intelligence — requirements-text ingestion (Epic #270, Issue #278).
//
// Pure conversion of a free-text requirement blob into atomic `requirement` evidence atoms paired
// with their canonical text. The contract atom carries ONLY a hash (Issue #277 — atoms never carry
// raw content on the wire); the paired `canonicalText` stays server-side and feeds the model
// prompt. NO IO, NO randomness — atom IDs are content-hash derived so the same blob yields the
// same atoms.

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";

import { normaliseText } from "../domain/assertions.js";

type AtomId = QualityIntelligence.QualityIntelligenceEvidenceAtomId;
type EnvelopeId = QualityIntelligence.QualityIntelligenceSourceEnvelopeId;
type RequirementAtom = QualityIntelligence.QualityIntelligenceRequirementAtom;

/** A content-bearing ingestion result. The `atom` is wire-safe (hash only); `canonicalText` is the
 * server-side payload fed to the model. They are produced together so provenance stays exact. */
export interface IngestedRequirementAtom {
  readonly atom: RequirementAtom;
  readonly canonicalText: string;
}

export interface SplitRequirementsOptions {
  readonly envelopeId: EnvelopeId;
  readonly maxAtoms?: number;
}

const DEFAULT_MAX_ATOMS = 200;
const MIN_ATOM_CHARS = 6;
const LEADING_MARKER = /^\s*(?:[-*•·]|\d+[.)]|[a-z][.)])\s+/iu;
const HAS_LETTER = /\p{L}/u;

// Strip a single leading list marker ("- ", "1. ", "a) ", "• ") so the canonical requirement text
// is the statement itself, not its bullet glyph.
const stripMarker = (line: string): string => line.replace(LEADING_MARKER, "");

const isMeaningful = (text: string): boolean =>
  text.length >= MIN_ATOM_CHARS && HAS_LETTER.test(text);

// Primary split: by line. Fallback split: when the blob is a single line, break on sentence
// boundaries so a pasted paragraph still yields multiple atoms.
const splitIntoStatements = (raw: string): readonly string[] => {
  const lines = raw.split(/\r?\n/u);
  const byLine = lines.map((line) => normaliseText(stripMarker(line))).filter(isMeaningful);
  // Multiple physical lines → trust the (filtered) line split: short / letter-free lines are
  // dropped and never folded back in. A single-line paragraph falls through to sentence splitting.
  if (lines.length > 1) return byLine;
  const single = normaliseText(stripMarker(raw));
  if (!isMeaningful(single)) return [];
  const sentences = single
    .split(/(?<=[.!?])\s+(?=\p{Lu})/u)
    .map((s) => normaliseText(s))
    .filter(isMeaningful);
  return sentences.length > 0 ? sentences : [single];
};

const deriveAtomId = (envelopeId: EnvelopeId, text: string): AtomId => {
  const digest = sha256Hex(`qi-atom-v2|${String(envelopeId)}|${text}`).slice(0, 32);
  return QualityIntelligence.asQualityIntelligenceEvidenceAtomId(`qi-atom-${digest}`);
};

/**
 * Split a requirements blob into ordered `IngestedRequirementAtom`s. Returns an empty array for
 * blank input. Deduplicates identical canonical statements while preserving first-seen order, and
 * caps the result at `maxAtoms` (default 200) so an oversized paste cannot explode the run.
 */
export const splitRequirementsIntoAtoms = (
  text: string,
  options: SplitRequirementsOptions,
): readonly IngestedRequirementAtom[] => {
  const maxAtoms = Math.max(1, Math.trunc(options.maxAtoms ?? DEFAULT_MAX_ATOMS));
  const statements = splitIntoStatements(typeof text === "string" ? text : "");
  const seen = new Set<string>();
  const out: IngestedRequirementAtom[] = [];
  for (const statement of statements) {
    if (out.length >= maxAtoms) break;
    if (seen.has(statement)) continue;
    seen.add(statement);
    out.push(
      Object.freeze<IngestedRequirementAtom>({
        atom: Object.freeze<RequirementAtom>({
          kind: "requirement",
          id: deriveAtomId(options.envelopeId, statement),
          sourceEnvelopeId: options.envelopeId,
          canonicalHashSha256Hex: sha256Hex(statement),
          redactionStatus: "not-required",
          lifecycleStatus: "draft",
        }),
        canonicalText: statement,
      }),
    );
  }
  return Object.freeze(out);
};
