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

export interface SplitRequirementsResult {
  readonly atoms: readonly IngestedRequirementAtom[];
  /** Meaningful canonical statements after block/sentence splitting, before dedupe. */
  readonly statementCount: number;
  /** Unique canonical statements before the maxAtoms cap is applied. */
  readonly uniqueStatementCount: number;
  /** Unique statements omitted because of maxAtoms. */
  readonly droppedAtomCount: number;
  readonly maxAtoms: number;
  readonly truncated: boolean;
}

const DEFAULT_MAX_ATOMS = 200;
const MIN_ATOM_CHARS = 6;
const LEADING_MARKER = /^\s*(?:[-*•·]|\d+[.)]|[a-z][.)])\s+/iu;
const HAS_LETTER = /\p{L}/u;
const SHORT_DOMAIN_TOKEN = /\b(?:IBAN|BIC|PIN|TAN|SEPA|KYC|AML|PSD2|SCA|MFA)\b/iu;
const DOMAIN_REQUIREMENT_ID = /\b[A-ZÄÖÜ]{2,12}-\d{1,8}\b/u;
const MARKDOWN_HEADING = /^\s{0,3}#{1,6}\s+\S/u;
const MARKDOWN_TABLE_ROW = /^\s*\|.+\|\s*$/u;
const GHERKIN_LINE =
  /^\s*(?:Feature|Funktionalität|Scenario(?: Outline)?|Szenario(?:grundriss)?|Szenariogrundriss|Given|When|Then|And|But|Angenommen|Gegeben|Wenn|Dann|Und|Aber|Examples|Beispiele)\b/iu;
const inlineEnumerationMarker = (): RegExp => /(?:^|\s)([a-z])[).]\s+/giu;
const ABBREVIATION_PATTERNS: readonly RegExp[] = [
  /\bz\.\s*B\./giu,
  /\bd\.\s*h\./giu,
  /\bu\.\s*a\./giu,
  /\bu\.\s*U\./gu,
  /\bggf\./giu,
  /\bbzw\./giu,
  /\bca\./giu,
  /\binkl\./giu,
  /\bevtl\./giu,
  /\bNr\./gu,
  /\bAbs\./gu,
  /\bArt\./gu,
];
const NUMBER_WITH_INTERNAL_DOTS_OR_COMMAS = /\b\d+(?:[.,]\d+)+\b/gu;

// Strip a single leading list marker ("- ", "1. ", "a) ", "• ") so the canonical requirement text
// is the statement itself, not its bullet glyph.
const stripMarker = (line: string): string => line.replace(LEADING_MARKER, "");

const isMeaningful = (text: string): boolean =>
  (text.length >= MIN_ATOM_CHARS && HAS_LETTER.test(text)) ||
  SHORT_DOMAIN_TOKEN.test(text) ||
  DOMAIN_REQUIREMENT_ID.test(text);

const normaliseStatement = (value: string): string => normaliseText(value);

const normaliseLineStatement = (line: string): string => normaliseStatement(stripMarker(line));

const nonBlankLines = (lines: readonly string[]): readonly string[] =>
  lines.map((line) => line.trim()).filter((line) => line.length > 0);

const normaliseBlock = (lines: readonly string[]): string =>
  normaliseStatement(nonBlankLines(lines).join("\n"));

const isMarkdownTableRow = (line: string): boolean => MARKDOWN_TABLE_ROW.test(line);

const isGherkinLine = (line: string): boolean => GHERKIN_LINE.test(line);

const collectBlock = (
  lines: readonly string[],
  start: number,
  shouldContinue: (line: string, offset: number) => boolean,
): { readonly block: string; readonly next: number } => {
  const block: string[] = [];
  let i = start;
  while (i < lines.length && shouldContinue(lines[i] ?? "", i - start)) {
    block.push(lines[i] ?? "");
    i += 1;
  }
  return { block: normaliseBlock(block), next: i };
};

const collectTable = (
  lines: readonly string[],
  start: number,
): { readonly block: string; readonly next: number } =>
  collectBlock(lines, start, (line) => isMarkdownTableRow(line));

const collectGherkinBlock = (
  lines: readonly string[],
  start: number,
): { readonly block: string; readonly next: number } =>
  collectBlock(lines, start, (line, offset) => {
    if (offset === 0) return true;
    if (line.trim().length === 0) return true;
    return isGherkinLine(line) || isMarkdownTableRow(line);
  });

const protectSentenceBoundaryFragments = (
  value: string,
): { readonly text: string; readonly placeholders: readonly string[] } => {
  const placeholders: string[] = [];
  let protectedText = value;
  const replaceWithPlaceholder = (match: string): string => {
    const placeholder = `__QI_REQ_PROTECTED_${String(placeholders.length)}__`;
    placeholders.push(match);
    return placeholder;
  };
  for (const pattern of ABBREVIATION_PATTERNS) {
    protectedText = protectedText.replace(pattern, replaceWithPlaceholder);
  }
  protectedText = protectedText.replace(
    NUMBER_WITH_INTERNAL_DOTS_OR_COMMAS,
    replaceWithPlaceholder,
  );
  return { text: protectedText, placeholders };
};

const restoreSentenceBoundaryFragments = (
  value: string,
  placeholders: readonly string[],
): string => {
  let restored = value;
  placeholders.forEach((placeholderValue, index) => {
    restored = restored.replaceAll(`__QI_REQ_PROTECTED_${String(index)}__`, placeholderValue);
  });
  return restored;
};

const splitSentences = (value: string): readonly string[] => {
  const protectedText = protectSentenceBoundaryFragments(value);
  return protectedText.text
    .split(/(?<=[.!?])\s+(?=\p{Lu})/u)
    .map((s) => normaliseStatement(restoreSentenceBoundaryFragments(s, protectedText.placeholders)))
    .filter(isMeaningful);
};

const splitInlineEnumerations = (value: string): readonly string[] | undefined => {
  const matches = [...value.matchAll(inlineEnumerationMarker())];
  if (matches.length < 2) return undefined;
  const out: string[] = [];
  matches.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? value.length;
    const statement = normaliseStatement(value.slice(start, end));
    if (isMeaningful(statement)) out.push(statement);
  });
  return out.length >= 2 ? out : undefined;
};

const addStatement = (out: string[], statement: string): void => {
  if (isMeaningful(statement)) out.push(statement);
};

const addLineStatements = (out: string[], line: string): void => {
  const enumerated = splitInlineEnumerations(normaliseStatement(line));
  if (enumerated !== undefined) {
    out.push(...enumerated);
    return;
  }
  const single = normaliseLineStatement(line);
  if (!isMeaningful(single)) return;
  const sentences = splitSentences(single);
  if (sentences.length > 1) {
    out.push(...sentences);
    return;
  }
  addStatement(out, single);
};

interface MarkdownHeadingContext {
  readonly level: number;
  readonly text: string;
}

const parseMarkdownHeading = (line: string): MarkdownHeadingContext | undefined => {
  if (!MARKDOWN_HEADING.test(line)) return undefined;
  const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/u.exec(line);
  const marker = match?.[1];
  if (marker === undefined) return undefined;
  const heading = normaliseStatement(line.trim().replace(/\s+#+\s*$/u, ""));
  return { level: marker.length, text: heading };
};

const updateHeadingContext = (
  context: readonly MarkdownHeadingContext[],
  heading: MarkdownHeadingContext,
): readonly MarkdownHeadingContext[] => [
  ...context.filter((item) => item.level < heading.level),
  heading,
];

const withHeadingContext = (
  context: readonly MarkdownHeadingContext[],
  statement: string,
): string =>
  context.length === 0
    ? statement
    : normaliseStatement([...context.map((item) => item.text), statement].join("\n"));

const addContextualStatement = (
  out: string[],
  context: readonly MarkdownHeadingContext[],
  statement: string,
): void => {
  addStatement(out, withHeadingContext(context, statement));
};

const addContextualLineStatements = (
  out: string[],
  context: readonly MarkdownHeadingContext[],
  line: string,
): void => {
  const lineStatements: string[] = [];
  addLineStatements(lineStatements, line);
  for (const statement of lineStatements) {
    addContextualStatement(out, context, statement);
  }
};

// Primary split: preserve explicitly structured blocks (headings, tables, Gherkin) and otherwise
// split each regular line on sentence / inline-enumeration boundaries. Markdown headings are carried
// as context for the following atoms instead of collapsing a whole section into one coarse atom, so
// traceability keeps requirement IDs/titles while drift re-checks can still isolate one edited line.
// Single-line input uses the same logic, so pasted paragraphs and line-wrapped requirements behave
// consistently.
const splitIntoStatements = (raw: string): readonly string[] => {
  const lines = raw.split(/\r?\n/u);
  if (lines.length > 1) {
    const out: string[] = [];
    let headingContext: readonly MarkdownHeadingContext[] = [];
    for (let i = 0; i < lines.length;) {
      const line = lines[i] ?? "";
      if (line.trim().length === 0) {
        i += 1;
        continue;
      }
      const heading = parseMarkdownHeading(line);
      if (heading !== undefined) {
        headingContext = updateHeadingContext(headingContext, heading);
        i += 1;
        continue;
      }
      if (isMarkdownTableRow(line)) {
        const table = collectTable(lines, i);
        addContextualStatement(out, headingContext, table.block);
        i = table.next;
        continue;
      }
      if (isGherkinLine(line)) {
        const gherkin = collectGherkinBlock(lines, i);
        addContextualStatement(out, headingContext, gherkin.block);
        i = gherkin.next;
        continue;
      }
      addContextualLineStatements(out, headingContext, line);
      i += 1;
    }
    return out;
  }
  const out: string[] = [];
  addLineStatements(out, raw);
  return out;
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
export const splitRequirementsIntoAtomsWithStats = (
  text: string,
  options: SplitRequirementsOptions,
): SplitRequirementsResult => {
  const maxAtoms = Math.max(1, Math.trunc(options.maxAtoms ?? DEFAULT_MAX_ATOMS));
  const statements = splitIntoStatements(typeof text === "string" ? text : "");
  const seen = new Set<string>();
  const uniqueStatements: string[] = [];
  for (const statement of statements) {
    if (seen.has(statement)) continue;
    seen.add(statement);
    uniqueStatements.push(statement);
  }
  const out: IngestedRequirementAtom[] = [];
  for (const statement of uniqueStatements.slice(0, maxAtoms)) {
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
  const atoms = Object.freeze(out);
  const droppedAtomCount = Math.max(0, uniqueStatements.length - atoms.length);
  return Object.freeze({
    atoms,
    statementCount: statements.length,
    uniqueStatementCount: uniqueStatements.length,
    droppedAtomCount,
    maxAtoms,
    truncated: droppedAtomCount > 0,
  });
};

export const splitRequirementsIntoAtoms = (
  text: string,
  options: SplitRequirementsOptions,
): readonly IngestedRequirementAtom[] => splitRequirementsIntoAtomsWithStats(text, options).atoms;
