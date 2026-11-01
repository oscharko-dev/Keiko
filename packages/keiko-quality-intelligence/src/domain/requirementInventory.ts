// Deterministic requirement inventory of one document (#4179, Epic #4173).
//
// The requirement units a document states are detected from its plain text and the section
// boundaries the parser recorded, without a model: identifier, title, priority, acceptance criteria,
// source span and a content digest. It is a detector, not an oracle: the result counts what was
// detected and says what it could not read, and it never claims to be complete.
//
// Detection rules (pinned by tests):
//   * An identifier is `PREFIX-NUMBER` over upper-case segments joined by `-` or `_` (`R-12`,
//     `REQ-FUNC-001`, `REQ_003`, `FR-12.3`). Reserved prefixes (standards, technologies, criterion
//     numbering) never define a requirement. A heading identifier counts when a body follows or its
//     prefix names a second identifier; a bare `ID title` line needs that second identifier; a
//     separated (`ID: title`), bracketed or table-row identifier always counts.
//   * Units come from blocks (an identifier line or recorded section heading plus its body), table
//     rows, and statements: a sentence with an obligation phrase and no identifier.
//   * A block ends at the next identifier, a heading or section boundary and, in flat text, at a
//     blank line unless the next line is a key line (priority, criteria, metadata) or the block has no
//     body yet. Wrapped lines of a paragraph are merged before sentences are read.
//   * When an identifier is defined several times (table of contents, then the section), the
//     definition with a body, priority or criteria wins; an empty listing never displaces it. Two
//     bodies with different content are reported as conflicting, never resolved silently.
//   * A statement without an identifier gets `DRV-<8 letters>`: the SHA-256 of the document identity
//     and its normalized wording (a second identical sentence of the same document is told apart by
//     occurrence). It survives edits elsewhere and renumbering, and changes with the wording.
//   * The content digest covers identifier, title, priority, statement and criteria in normalized
//     form only: neither location, nor format, nor the version of this detector.

import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { sha256Hex } from "@oscharko-dev/keiko-security";

import {
  continueProjectedRow,
  openProjectedRow,
  parseProjectedRow,
  tableCells,
  parseTableHeader,
  parseTableRow,
  type ColumnRoles,
  type ProjectedRow,
  type TableRow,
} from "./requirementTable.js";
import {
  ID_START,
  LIST_MARKER,
  MARKDOWN_HEADING,
  bare,
  collapse,
  idPrefix,
  lineAt,
  splitLines,
  trimTrailingMarks,
  type Line,
} from "./requirementText.js";
import {
  compileRequirementVocabulary,
  foldTerm,
  type CompiledVocabulary,
  type RequirementVocabulary,
} from "./requirementVocabulary.js";

export const REQUIREMENT_INVENTORY_ENTRIES_MAX = 500;
export const REQUIREMENT_DIGEST_SHORT_LENGTH = 12;
export const REQUIREMENT_DOCUMENT_SCOPE_LENGTH = 8;

export interface RequirementInventorySection {
  readonly sectionPath: readonly string[];
  readonly characterStart: number;
  readonly characterEnd: number;
}

export interface RequirementInventoryInput {
  /** The document's normalized text; offsets in the result address this exact string. */
  readonly text: string;
  /** Stable identity of the document (not of its version); salts derived identifiers. */
  readonly documentKey: string;
  /** Section boundaries as the parser recorded them (headings, slides); optional. */
  readonly sections?: readonly RequirementInventorySection[];
  readonly maxEntries?: number;
  /** Extra vocabulary terms (priorities, keys, obligation phrases, reserved prefixes). */
  readonly vocabulary?: Partial<RequirementVocabulary>;
}

export interface RequirementCriterion {
  /** `<requirement id>/AC<n>`, stable while the criterion keeps its position. */
  readonly id: string;
  readonly text: string;
}

export type RequirementIdOrigin = "explicit" | "derived";
export type RequirementUnitKind = "block" | "table-row" | "statement";

export interface RequirementInventoryEntry {
  readonly id: string;
  readonly idOrigin: RequirementIdOrigin;
  readonly unitKind: RequirementUnitKind;
  readonly documentKey: string;
  /** Short hash of the document identity; scopes labels and references across documents. */
  readonly documentScope: string;
  readonly title: string;
  readonly priority?: string;
  readonly statement: string;
  readonly acceptanceCriteria: readonly RequirementCriterion[];
  /** The deepest section that contains the unit; empty for a document without sections. */
  readonly sectionPath: readonly string[];
  readonly characterStart: number;
  readonly characterEnd: number;
  /** SHA-256 hex of the unit's normalized content. */
  readonly digest: string;
}

export interface RequirementInventory {
  readonly entries: readonly RequirementInventoryEntry[];
  /** Units detected before the entry bound was applied. */
  readonly totalCount: number;
  readonly truncated: boolean;
  /** Identifiers defined twice with different content; the first richest definition is kept. */
  readonly conflictingIds: readonly string[];
  /** Listings (a table of contents) displaced by a definition with a body. */
  readonly referenceOnlyCount: number;
  /** Identifier candidates dropped for lack of requirement context (e.g. a technical name). */
  readonly rejectedCandidateCount: number;
}

export function documentScopeOf(documentKey: string): string {
  return sha256Hex(`keiko-document|${documentKey}`).slice(0, REQUIREMENT_DOCUMENT_SCOPE_LENGTH);
}

// ─── Candidates ──────────────────────────────────────────────────────────────

type CandidateKind = "heading" | "strong" | "weak" | "row";
interface Definition {
  readonly kind: CandidateKind;
  readonly id: string;
  readonly title: string;
}
interface Candidate extends Definition {
  /** First line of the unit. */
  readonly line: number;
  /** Whether that line is the heading itself (and not already body text). */
  readonly headingLine: boolean;
  /** Set when the recorded section, not the line, defines the unit. */
  readonly section?: RequirementInventorySection;
  readonly row?: RowFields;
}
interface RowFields {
  readonly priority?: string;
  readonly statement: string;
  readonly criteria: readonly string[];
}

const SEPARATOR = /^\s*(?:[:–—]|-(?=\s)|[.)](?=\s|$))/u;
const SLIDE_LABEL = /^(?:Slide|Folie|Seite|Page)\s+\d+\s*[:.\-–—]\s*/iu;
const CRITERION_NUMBER = /^AC[\s-]?\d+\s*[:.)-]\s*/iu;
const MERGED_ITEMS = /(?<=[.!?])(?=\p{Lu})/u;
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=\p{Lu})/u;
const TITLE_FALLBACK_CHARS = 80;
const STATEMENT_MIN_CHARS = 12;
const STATEMENT_MAX_CHARS = 4000;

interface Context {
  readonly lines: readonly Line[];
  readonly sections: readonly RequirementInventorySection[];
  readonly starts: readonly number[];
  readonly vocabulary: CompiledVocabulary;
  readonly documentKey: string;
}

function sectionStarts(sections: readonly RequirementInventorySection[]): readonly number[] {
  return sections.map((section) => section.characterStart).sort((a, b) => a - b);
}

/** Whether a section begins inside the line; binary search over the sorted section starts. */
function startsSection(starts: readonly number[], line: Line): boolean {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((starts[mid] ?? 0) < line.start) low = mid + 1;
    else high = mid;
  }
  const first = starts[low];
  return first !== undefined && first <= line.end;
}

/** Index of the last line that starts at or before the offset. */
function lineIndexAt(lines: readonly Line[], offset: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if ((lines[mid]?.start ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

function classifyText(
  cleaned: string,
  heading: boolean,
  vocabulary: CompiledVocabulary,
): Definition | undefined {
  const match = ID_START.exec(cleaned);
  const id = match?.[1];
  if (match === null || id === undefined) return undefined;
  if (vocabulary.reservedPrefixes.has(idPrefix(id).toUpperCase())) return undefined;
  const rest = cleaned.slice(match[0].length);
  const separated = SEPARATOR.exec(rest);
  if (separated !== null)
    return { kind: "strong", id, title: collapse(rest.slice(separated[0].length)) };
  if (rest.length > 0 && !/^\s/u.test(rest)) return undefined;
  const title = collapse(rest);
  if (match[2] !== undefined) return { kind: "strong", id, title };
  return { kind: heading ? "heading" : "weak", id, title };
}

function rowCandidate(row: TableRow, line: number): Candidate {
  return {
    kind: "row",
    id: row.id,
    title: row.title,
    line,
    headingLine: true,
    row: {
      statement: row.statement,
      criteria: row.criteria,
      ...(row.priority === undefined ? {} : { priority: row.priority }),
    },
  };
}

function isDefinedRow(row: TableRow | undefined, vocabulary: CompiledVocabulary): row is TableRow {
  return row !== undefined && !vocabulary.reservedPrefixes.has(idPrefix(row.id).toUpperCase());
}

function tableCandidates(context: Context): readonly Candidate[] {
  const found: Candidate[] = [];
  let roles: ColumnRoles | undefined;
  context.lines.forEach((line, index) => {
    const cells = tableCells(line.text);
    if (cells === undefined) return;
    const header = parseTableHeader(cells, context.vocabulary);
    if (header !== undefined) roles = header;
    const row = header === undefined ? parseTableRow(cells, roles, context.vocabulary) : undefined;
    if (isDefinedRow(row, context.vocabulary)) found.push(rowCandidate(row, index));
  });
  return found;
}

/** Rows of a workbook extraction (`Sheet!2: ID=FR-1 | Titel=Foo`), with their multi-line cells. */
function projectedCandidates(context: Context): readonly Candidate[] {
  const found: Candidate[] = [];
  let open: { readonly row: ProjectedRow; readonly line: number } | undefined;
  const close = (): void => {
    const parsed = open === undefined ? undefined : parseProjectedRow(open.row, context.vocabulary);
    if (open !== undefined && isDefinedRow(parsed, context.vocabulary))
      found.push(rowCandidate(parsed, open.line));
    open = undefined;
  };
  context.lines.forEach((line, index) => {
    const started = openProjectedRow(line.text, context.vocabulary);
    if (started !== undefined || collapse(line.text).length === 0) close();
    if (started !== undefined) open = { row: started, line: index };
    else if (open !== undefined) continueProjectedRow(open.row, line.text, context.vocabulary);
  });
  close();
  return found;
}

function lineCandidates(context: Context, tableLines: ReadonlySet<number>): readonly Candidate[] {
  const found: Candidate[] = [];
  context.lines.forEach((line, index) => {
    if (tableLines.has(index)) return;
    const heading = MARKDOWN_HEADING.test(line.text) || startsSection(context.starts, line);
    const definition = classifyText(bare(line.text), heading, context.vocabulary);
    if (definition !== undefined) found.push({ ...definition, line: index, headingLine: true });
  });
  return found;
}

function headingText(section: RequirementInventorySection): string {
  return collapse((section.sectionPath.at(-1) ?? "").replace(SLIDE_LABEL, ""));
}

/** Whether a line candidate of the same identifier already defines a unit inside the section. */
function definedWithin(
  lines: readonly Line[],
  defined: readonly Candidate[],
  id: string,
  section: RequirementInventorySection,
): boolean {
  return defined.some((candidate) => {
    const start = lines[candidate.line]?.start ?? -1;
    return candidate.id === id && start >= section.characterStart && start < section.characterEnd;
  });
}

function sectionCandidate(
  context: Context,
  defined: readonly Candidate[],
  section: RequirementInventorySection,
): Candidate | undefined {
  const heading = headingText(section);
  const definition = classifyText(heading, true, context.vocabulary);
  if (definition === undefined) return undefined;
  const index = lineIndexAt(context.lines, section.characterStart);
  const line = context.lines[index];
  if (line === undefined || line.start >= section.characterEnd) return undefined;
  if (definedWithin(context.lines, defined, definition.id, section)) return undefined;
  const headingLine = collapse(line.text).toLowerCase().includes(heading.toLowerCase());
  return { ...definition, line: index, headingLine, section };
}

function findCandidates(context: Context): readonly Candidate[] {
  const rows = [...tableCandidates(context), ...projectedCandidates(context)];
  const tableLines = new Set(rows.map((row) => row.line));
  const fromLines = lineCandidates(context, tableLines);
  const fromSections = context.sections.flatMap(
    (section) => sectionCandidate(context, fromLines, section) ?? [],
  );
  const ordered = [...rows, ...fromLines, ...fromSections];
  ordered.sort((a, b) => a.line - b.line);
  const seen = new Set<number>();
  return ordered.filter((candidate) => !seen.has(candidate.line) && seen.add(candidate.line));
}

// ─── Blocks ──────────────────────────────────────────────────────────────────

interface Block {
  readonly candidate: Candidate;
  /** First body line, inclusive. */
  readonly first: number;
  /** Last line of the block, inclusive. */
  readonly last: number;
  readonly start: number;
  readonly end: number;
}

interface Scan {
  hasBody: boolean;
  inCriteria: boolean;
}

function isKeyLine(text: string, vocabulary: CompiledVocabulary): boolean {
  return (
    vocabulary.priorityKey.test(text) ||
    vocabulary.criteriaKey.test(text) ||
    vocabulary.metaKey.test(text)
  );
}

function advanceScan(scan: Scan, text: string, vocabulary: CompiledVocabulary): void {
  if (vocabulary.criteriaKey.test(text)) scan.inCriteria = true;
  else if (vocabulary.priorityKey.test(text) || vocabulary.metaKey.test(text))
    scan.inCriteria = false;
  else if (!scan.inCriteria) scan.hasBody = true;
}

function nextNonBlank(lines: readonly Line[], from: number, limit: number): number {
  for (let index = from; index <= limit; index += 1)
    if (bare(lineAt(lines, index).text).length > 0) return index;
  return -1;
}

/** In flat text a blank line ends the block unless a key line, list item or first body follows. */
function continuesAfterBlank(context: Context, scan: Scan, from: number, limit: number): boolean {
  const next = nextNonBlank(context.lines, from, limit);
  if (next < 0) return false;
  const raw = lineAt(context.lines, next).text;
  if (isKeyLine(bare(raw), context.vocabulary) || !scan.hasBody) return true;
  return scan.inCriteria && LIST_MARKER.test(raw);
}

function endsStructuredBlock(line: Line, starts: readonly number[]): boolean {
  return MARKDOWN_HEADING.test(line.text) || startsSection(starts, line);
}

function lastLineOf(context: Context, candidate: Candidate, limit: number): number {
  const sectionEnd = candidate.section?.characterEnd;
  const structured = sectionEnd !== undefined || candidate.kind === "heading";
  if (candidate.kind === "row") return candidate.line;
  const scan: Scan = { hasBody: false, inCriteria: false };
  let last = candidate.line;
  for (let index = candidate.line + 1; index <= limit; index += 1) {
    const line = lineAt(context.lines, index);
    if (
      sectionEnd === undefined
        ? endsStructuredBlock(line, context.starts)
        : line.start >= sectionEnd
    )
      break;
    const text = bare(line.text);
    if (text.length === 0) {
      if (!structured && !continuesAfterBlank(context, scan, index + 1, limit)) break;
      continue;
    }
    advanceScan(scan, text, context.vocabulary);
    last = index;
  }
  return last;
}

function buildBlocks(context: Context, candidates: readonly Candidate[]): readonly Block[] {
  return candidates.map((candidate, position) => {
    const limit = (candidates[position + 1]?.line ?? context.lines.length) - 1;
    const last = lastLineOf(context, candidate, limit);
    const head = lineAt(context.lines, candidate.line);
    const start = candidate.headingLine
      ? head.start
      : (candidate.section?.characterStart ?? head.start);
    return {
      candidate,
      first: candidate.line + (candidate.headingLine ? 1 : 0),
      last,
      start,
      end: lineAt(context.lines, last).end,
    };
  });
}

// ─── Interpretation ──────────────────────────────────────────────────────────

interface Interpreted {
  readonly priority?: string;
  readonly statement: string;
  readonly criteria: readonly string[];
}

type Mode = "text" | "criteria" | "meta";
interface BodyState {
  readonly statement: string[];
  readonly criteria: string[];
  priority: string | undefined;
  mode: Mode;
}

function stripCriterionNumber(value: string): string {
  return collapse(value.replace(CRITERION_NUMBER, ""));
}

/** One extractor line, split where it carries several fields. */
function segmentsOf(raw: string, vocabulary: CompiledVocabulary): readonly string[] {
  return bare(raw)
    .split(vocabulary.inlineKey)
    .map((value) => collapse(value))
    .filter((segment) => segment.length > 0);
}

function keyValue(segment: string, key: RegExp): string | undefined {
  const match = key.exec(segment);
  return match === null ? undefined : segment.slice(match[0].length);
}

function readSegment(state: BodyState, segment: string, vocabulary: CompiledVocabulary): void {
  const priority = keyValue(segment, vocabulary.priorityKey);
  const criteria = keyValue(segment, vocabulary.criteriaKey);
  if (priority !== undefined) {
    state.priority = collapse(trimTrailingMarks(priority));
    state.mode = "text";
  } else if (criteria !== undefined) {
    state.mode = "criteria";
    for (const item of criteria.split(MERGED_ITEMS)) {
      const criterion = stripCriterionNumber(item);
      if (criterion.length > 0) state.criteria.push(criterion);
    }
  } else if (vocabulary.metaKey.test(segment)) {
    state.mode = "meta";
  } else if (state.mode === "criteria") {
    state.criteria.push(stripCriterionNumber(segment));
  } else if (state.mode === "text") {
    state.statement.push(segment);
  }
}

function interpretBody(bodyLines: readonly Line[], vocabulary: CompiledVocabulary): Interpreted {
  const state: BodyState = { statement: [], criteria: [], priority: undefined, mode: "text" };
  for (const line of bodyLines)
    for (const segment of segmentsOf(line.text, vocabulary))
      readSegment(state, segment, vocabulary);
  return {
    ...(state.priority === undefined || state.priority.length === 0
      ? {}
      : { priority: state.priority }),
    statement: state.statement.join(" ").slice(0, STATEMENT_MAX_CHARS),
    criteria: state.criteria.filter((criterion) => criterion.length > 0),
  };
}

function interpretRow(row: RowFields): Interpreted {
  return {
    ...(row.priority === undefined || row.priority.length === 0 ? {} : { priority: row.priority }),
    statement: row.statement.slice(0, STATEMENT_MAX_CHARS),
    criteria: row.criteria.flatMap((cell) =>
      cell
        .split(MERGED_ITEMS)
        .map((value) => stripCriterionNumber(value))
        .filter((text) => text.length > 0),
    ),
  };
}

function shorten(value: string): string {
  return value.length <= TITLE_FALLBACK_CHARS
    ? value
    : `${value.slice(0, TITLE_FALLBACK_CHARS - 1).trimEnd()}…`;
}

/** A priority tag in the title (`Login (MUSS)`) becomes the priority when no key gave one. */
function withTitleTag(
  title: string,
  interpreted: Interpreted,
  vocabulary: CompiledVocabulary,
): { readonly title: string; readonly interpreted: Interpreted } {
  const tag = vocabulary.priorityTag.exec(title);
  if (tag === null) return { title, interpreted };
  const cleaned = collapse(title.replace(tag[0], " "));
  if (interpreted.priority !== undefined) return { title: cleaned, interpreted };
  return { title: cleaned, interpreted: { ...interpreted, priority: collapse(tag[1] ?? "") } };
}

/** The canonical content digest; the same unit has the same digest in every format and version. */
export function requirementContentDigest(parts: {
  readonly id: string;
  readonly title: string;
  readonly priority?: string | undefined;
  readonly statement: string;
  readonly criteria: readonly string[];
}): string {
  return sha256Hex(
    JSON.stringify([
      "requirement-content",
      parts.id,
      collapse(parts.title),
      collapse(parts.priority ?? ""),
      collapse(parts.statement),
      parts.criteria.map((value) => collapse(value)),
    ]),
  );
}

function sectionPathAt(
  sections: readonly RequirementInventorySection[],
  offset: number,
): readonly string[] {
  let best: RequirementInventorySection | undefined;
  for (const section of sections) {
    if (section.characterStart > offset || section.characterEnd <= offset) continue;
    if (best === undefined || section.characterStart >= best.characterStart) best = section;
  }
  return best?.sectionPath ?? [];
}

interface EntryParts {
  readonly id: string;
  readonly idOrigin: RequirementIdOrigin;
  readonly unitKind: RequirementUnitKind;
  readonly title: string;
  readonly interpreted: Interpreted;
  readonly sectionPath: readonly string[];
  readonly start: number;
  readonly end: number;
}

function toEntry(context: Context, parts: EntryParts): RequirementInventoryEntry {
  const { id, interpreted } = parts;
  const title = parts.title.length > 0 ? parts.title : shorten(interpreted.statement);
  return Object.freeze({
    id,
    idOrigin: parts.idOrigin,
    unitKind: parts.unitKind,
    documentKey: context.documentKey,
    documentScope: documentScopeOf(context.documentKey),
    title,
    ...(interpreted.priority === undefined ? {} : { priority: interpreted.priority }),
    statement: interpreted.statement,
    acceptanceCriteria: Object.freeze(
      interpreted.criteria.map((text, index) =>
        Object.freeze({ id: `${id}/AC${String(index + 1)}`, text }),
      ),
    ),
    sectionPath: parts.sectionPath,
    characterStart: parts.start,
    characterEnd: parts.end,
    digest: requirementContentDigest({
      id,
      title,
      priority: interpreted.priority,
      statement: interpreted.statement,
      criteria: interpreted.criteria,
    }),
  });
}

interface RawUnit {
  readonly candidate: Candidate;
  readonly entry: RequirementInventoryEntry;
  readonly hasBody: boolean;
  readonly block: Block;
}

function rawUnit(context: Context, block: Block): RawUnit {
  const { candidate } = block;
  const body =
    candidate.row === undefined
      ? interpretBody(context.lines.slice(block.first, block.last + 1), context.vocabulary)
      : interpretRow(candidate.row);
  const { title, interpreted } = withTitleTag(candidate.title, body, context.vocabulary);
  const entry = toEntry(context, {
    id: candidate.id,
    idOrigin: "explicit",
    unitKind: candidate.row === undefined ? "block" : "table-row",
    title,
    interpreted,
    sectionPath: sectionPathAt(context.sections, block.start),
    start: block.start,
    end: block.end,
  });
  const hasBody =
    interpreted.statement.length > 0 ||
    interpreted.criteria.length > 0 ||
    interpreted.priority !== undefined;
  return { candidate, entry, hasBody, block };
}

// ─── Acceptance and selection ────────────────────────────────────────────────

function prefixCorroboration(units: readonly RawUnit[]): ReadonlyMap<string, ReadonlySet<string>> {
  const byPrefix = new Map<string, Set<string>>();
  for (const unit of units) {
    const prefix = idPrefix(unit.candidate.id);
    byPrefix.set(prefix, (byPrefix.get(prefix) ?? new Set<string>()).add(unit.candidate.id));
  }
  return byPrefix;
}

/** A requirement context: a separated or table identifier, a body, or a second identifier. */
function accepted(unit: RawUnit, corroboration: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const { kind, id } = unit.candidate;
  if (kind === "strong" || kind === "row") return true;
  const corroborated = (corroboration.get(idPrefix(id))?.size ?? 0) >= 2;
  return kind === "heading" ? unit.hasBody || corroborated : corroborated;
}

function richness(unit: RawUnit): readonly number[] {
  const { entry } = unit;
  return [
    unit.hasBody ? 1 : 0,
    entry.acceptanceCriteria.length > 0 ? 1 : 0,
    entry.priority === undefined ? 0 : 1,
    entry.statement.length,
  ];
}

function richer(left: RawUnit, right: RawUnit): boolean {
  const a = richness(left);
  const b = richness(right);
  for (let index = 0; index < a.length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

interface Selection {
  readonly chosen: readonly RawUnit[];
  readonly conflicting: readonly string[];
  readonly referenceOnly: number;
}

function selectDefinitions(units: readonly RawUnit[]): Selection {
  const groups = new Map<string, RawUnit[]>();
  for (const unit of units) {
    const group = groups.get(unit.candidate.id) ?? [];
    group.push(unit);
    groups.set(unit.candidate.id, group);
  }
  const chosen: RawUnit[] = [];
  const conflicting: string[] = [];
  let referenceOnly = 0;
  for (const [id, group] of groups) {
    const best = group.reduce<RawUnit | undefined>(
      (current, unit) => (current === undefined || richer(unit, current) ? unit : current),
      undefined,
    );
    if (best === undefined) continue;
    chosen.push(best);
    const bodies = group.filter((unit) => unit.hasBody);
    if (bodies.some((unit) => unit.entry.digest !== best.entry.digest)) conflicting.push(id);
    referenceOnly += group.filter((unit) => !unit.hasBody && unit !== best).length;
  }
  conflicting.sort(compareStrings);
  return { chosen, conflicting, referenceOnly };
}

// ─── Statements without an identifier ────────────────────────────────────────

const LETTERS = "ABCDEFGHIJKLMNOP";

function normalizedWording(statement: string): string {
  return foldTerm(statement)
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * `DRV-` plus eight letters from the SHA-256 of the document identity and the statement's
 * normalized wording; `occurrence` tells identical sentences of one document apart.
 */
export function derivedRequirementId(
  documentKey: string,
  statement: string,
  occurrence = 0,
): string {
  const digest = sha256Hex(
    JSON.stringify([
      "requirement-derived-id",
      documentKey,
      normalizedWording(statement),
      occurrence,
    ]),
  );
  const letters = Array.from(
    { length: 8 },
    (_, index) => LETTERS[Number.parseInt(digest.charAt(index), 16)] ?? "A",
  );
  return `DRV-${letters.join("")}`;
}

interface Paragraph {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function startsParagraph(raw: string): boolean {
  return LIST_MARKER.test(raw);
}

/** Wrapped lines of one paragraph, merged; list items, headings and blank lines break it. */
function paragraphsOf(context: Context, covered: ReadonlySet<number>): readonly Paragraph[] {
  const found: Paragraph[] = [];
  let open: { parts: string[]; start: number; end: number } | undefined;
  const close = (): void => {
    if (open !== undefined)
      found.push({ text: collapse(open.parts.join(" ")), start: open.start, end: open.end });
    open = undefined;
  };
  context.lines.forEach((line, index) => {
    const text = bare(line.text);
    if (
      covered.has(index) ||
      text.length === 0 ||
      MARKDOWN_HEADING.test(line.text) ||
      tableCells(line.text) !== undefined
    ) {
      close();
      return;
    }
    if (startsParagraph(line.text) || startsSection(context.starts, line)) close();
    open ??= { parts: [], start: line.start, end: line.end };
    open.parts.push(text);
    open.end = line.end;
  });
  close();
  return found;
}

function statementUnits(context: Context, covered: ReadonlySet<number>): readonly RawUnit[] {
  const occurrences = new Map<string, number>();
  const units: RawUnit[] = [];
  for (const paragraph of paragraphsOf(context, covered)) {
    for (const sentence of paragraph.text.split(SENTENCE_BREAK)) {
      const statement = collapse(sentence);
      if (statement.length < STATEMENT_MIN_CHARS || !context.vocabulary.modal.test(statement))
        continue;
      const wording = normalizedWording(statement);
      const occurrence = occurrences.get(wording) ?? 0;
      occurrences.set(wording, occurrence + 1);
      const id = derivedRequirementId(context.documentKey, statement, occurrence);
      const candidate: Candidate = { kind: "strong", id, title: "", line: -1, headingLine: false };
      const entry = toEntry(context, {
        id,
        idOrigin: "derived",
        unitKind: "statement",
        title: "",
        interpreted: { statement: statement.slice(0, STATEMENT_MAX_CHARS), criteria: [] },
        sectionPath: sectionPathAt(context.sections, paragraph.start),
        start: paragraph.start,
        end: paragraph.end,
      });
      const block: Block = {
        candidate,
        first: 0,
        last: 0,
        start: paragraph.start,
        end: paragraph.end,
      };
      units.push({ candidate, entry, hasBody: true, block });
    }
  }
  return units;
}

function coveredLines(blocks: readonly Block[]): ReadonlySet<number> {
  const covered = new Set<number>();
  for (const block of blocks)
    for (let index = block.candidate.line; index <= block.last; index += 1) covered.add(index);
  return covered;
}

/**
 * Every requirement unit detected in one document, in document order. `totalCount` counts what was
 * detected; `truncated` says units beyond `maxEntries` were counted but not returned.
 */
export function deriveRequirementInventory(input: RequirementInventoryInput): RequirementInventory {
  const sections = input.sections ?? [];
  const context: Context = {
    lines: splitLines(input.text),
    sections,
    starts: sectionStarts(sections),
    vocabulary: compileRequirementVocabulary(input.vocabulary),
    documentKey: input.documentKey,
  };
  const blocks = buildBlocks(context, findCandidates(context));
  const units = blocks.map((block) => rawUnit(context, block));
  const corroboration = prefixCorroboration(units);
  const kept = units.filter((unit) => accepted(unit, corroboration));
  const rejected = new Set(units.filter((unit) => !kept.includes(unit)).map((unit) => unit.block));
  const selection = selectDefinitions(kept);
  const statements = statementUnits(
    context,
    coveredLines(blocks.filter((block) => !rejected.has(block))),
  );
  const all = [...selection.chosen, ...statements].map((unit) => unit.entry);
  all.sort((a, b) => a.characterStart - b.characterStart);
  const bound = Math.max(1, Math.trunc(input.maxEntries ?? REQUIREMENT_INVENTORY_ENTRIES_MAX));
  return Object.freeze({
    entries: Object.freeze(all.slice(0, bound)),
    totalCount: all.length,
    truncated: all.length > bound,
    conflictingIds: Object.freeze(selection.conflicting),
    referenceOnlyCount: selection.referenceOnly,
    rejectedCandidateCount: rejected.size,
  });
}
