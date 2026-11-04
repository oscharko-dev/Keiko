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
//     rows, and statements: a sentence with an obligation phrase and no identifier. A requirement
//     listed over several rows of a table is one unit; a table whose header names other things
//     (`Code | Bedeutung`) defines none, and its identifier rows are counted as rejected.
//   * A block ends at the next identifier, a heading or section boundary and, in flat text, at a
//     blank line unless the next line is a key line (priority, criteria, metadata), the block has no
//     body yet, the next paragraph leads into a key line, or an unfinished sentence goes on: a PDF
//     page break is a blank line anywhere in a block. Wrapped lines of a paragraph are merged before
//     sentences are read. A rule line ends a block with a body in every kind of text.
//   * A record line joins fields with a middle dot or a pipe, or runs them together: every field is
//     read for itself, a field no vocabulary names is presentation, and the sentence behind a value
//     that cannot run on (an identifier, a known priority) is the statement.
//   * Flat text has no recorded headings, so a short line without a closing mark is a chapter heading
//     and not this block's body: directly ahead of the next unit after a finished line, or behind the
//     block's closing field (priority, metadata, a criteria list) whatever follows it.
//   * When an identifier is defined several times (table of contents, then the section), the
//     definition with a statement or criteria wins; a listing without them (a table of contents, an
//     overview table) never displaces it and adds only the priority the definition does not state.
//     Two bodies with different content, or two different priorities, are reported as conflicting,
//     never resolved silently.
//   * A statement without an identifier gets `DRV-<8 letters>`: the SHA-256 of the document identity
//     and its normalized wording (a second identical sentence of the same document is told apart by
//     occurrence). It survives edits elsewhere and renumbering, and changes with the wording.
//   * The content digest covers identifier, title, priority, statement and criteria in normalized
//     form only: neither location, nor format, nor the version of this detector.

import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { sha256Hex } from "@oscharko-dev/keiko-security";

import {
  continueProjectedRow,
  continuesProjectedTable,
  extendedRow,
  isPlainProjection,
  isPointerRecord,
  isSameRequirement,
  isSeparatorRow,
  openProjectedRow,
  parseContinuationRow,
  parseTableHeader,
  parseTableRow,
  projectedCells,
  readingOfProjectedTable,
  startsWithIdentifier,
  tableCells,
  type ProjectedCells,
  type ProjectedRow,
  type RowAddition,
  type TableReading,
  type TableRow,
} from "./requirementTable.js";
import {
  ID_START,
  ID_VALUE_FIELD,
  LIST_MARKER,
  MARKDOWN_HEADING,
  bare,
  collapse,
  idPrefix,
  isThematicBreak,
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
  /** Lines after the first that continue a title the text hard-wrapped; they are not body. */
  readonly titleLines?: number;
  readonly row?: RowFields;
  /** The last line of a row: a multi-line cell and further rows of the same requirement. */
  readonly rowLastLine?: number;
}
interface RowFields {
  readonly priority?: string;
  readonly statement: string;
  readonly criteria: readonly string[];
}

const SEPARATOR = /^\s*(?:[:–—]|-(?=\s)|[.)](?=\s|$))/u;
const SLIDE_LABEL = /^(?:Slide|Folie|Seite|Page)\s+\d+\s*[:.\-–—]\s*/iu;
const CRITERION_NUMBER = /^AC[\s-]?\d+\s*[:.)-]\s*/iu;
const RESULT_LINE = /^\s*=\s/u;
const MERGED_ITEMS = /(?<=[.!?])(?=\p{Lu})/u;
/** A field label: one or two words, then a colon. Text is collapsed, so spaces come singly. */
const FIELD_HEAD_SOURCE = String.raw`\p{Lu}[\p{L}\p{N}_/-]*(?: [\p{L}\p{N}_/-]+)? ?:(?: |$)`;
const FIELD_HEAD = new RegExp(`^${FIELD_HEAD_SOURCE}`, "u");
/** Presentation text joins the fields of a record on one line with a middle dot or a pipe. */
const FIELD_JOINT = new RegExp(` [·|] (?=${FIELD_HEAD_SOURCE})`, "u");
const VALUE_END = / [·|](?: |$)/u;
/** A metadata value that ends like this goes on in the next line. */
const VALUE_GOES_ON = /[,·|/–—-]$/u;
const SENTENCE_START = /^\p{Lu}\p{Ll}/u;
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=\p{Lu})/u;
const TITLE_FALLBACK_CHARS = 80;
const STATEMENT_MIN_CHARS = 12;
const STATEMENT_MAX_CHARS = 4000;
const CLOSING_MARK = /[.!?:;]$/u;
const LOWER_CASE_START = /^\p{Ll}/u;
const HEADING_START = /^[\p{Lu}\d]/u;
const HEADING_MAX_CHARS = 80;
const NUMBERED_ITEM = /^\s*\d+[.)]\s+/u;

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

interface RowDraft {
  row: TableRow;
  readonly table: number;
  readonly line: number;
  lastLine: number;
}

interface TableScan {
  readonly drafts: RowDraft[];
  /** Every line of a projected row and of a defining pipe row: no text of its own. */
  readonly lines: Set<number>;
  /** Identifier rows of tables whose header names other things. */
  readonly foreign: Set<number>;
  /** Number of the table in progress; rows of two tables are never one requirement. */
  table: number;
}

function rowCandidate(draft: RowDraft): Candidate {
  const { row } = draft;
  return {
    kind: "row",
    id: row.id,
    title: row.title,
    line: draft.line,
    rowLastLine: draft.lastLine,
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

interface RowSpan {
  readonly line: number;
  readonly lastLine: number;
}

/** A row of the same requirement extends the row above it; any other row starts a unit. */
function addRow(scan: TableScan, row: TableRow, span: RowSpan): void {
  const last = scan.drafts.at(-1);
  if (last?.table === scan.table && isSameRequirement(last.row, row)) {
    last.row = extendedRow(last.row, row);
    last.lastLine = span.lastLine;
    return;
  }
  scan.drafts.push({ row, table: scan.table, ...span });
}

function addToLastRow(scan: TableScan, addition: RowAddition, lastLine: number): boolean {
  const last = scan.drafts.at(-1);
  if (last?.table !== scan.table) return false;
  last.row = extendedRow(last.row, addition);
  last.lastLine = lastLine;
  return true;
}

/** Reads a row of a table that defines requirements; true when it became part of one. */
function readRow(
  context: Context,
  scan: TableScan,
  { cells, roles }: ProjectedCells,
  span: RowSpan,
): boolean {
  const row = parseTableRow(cells, roles, context.vocabulary);
  if (row !== undefined) {
    if (!isDefinedRow(row, context.vocabulary)) return false;
    addRow(scan, row, span);
    return true;
  }
  const addition = roles === undefined ? undefined : parseContinuationRow(cells, roles);
  return addition !== undefined && addToLastRow(scan, addition, span.lastLine);
}

interface PipeTable {
  readonly reading: TableReading;
  readonly columns: number;
  /** A blank line since the last row: a page break, or the end of the table. */
  readonly gap: boolean;
}

/** The table a pipe line that names no columns opens: its first cell tells a row from a header. */
function openPipeTable(scan: TableScan, cells: readonly string[]): PipeTable {
  scan.table += 1;
  return {
    reading: { kind: startsWithIdentifier(cells) ? "positional" : "foreign" },
    columns: cells.length,
    gap: false,
  };
}

function readPipeRow(
  context: Context,
  scan: TableScan,
  { reading }: PipeTable,
  cells: readonly string[],
  index: number,
): void {
  if (reading.kind === "foreign") {
    if (startsWithIdentifier(cells)) scan.foreign.add(index);
    return;
  }
  const roles = reading.kind === "roles" ? reading.roles : undefined;
  if (readRow(context, scan, { cells, roles }, { line: index, lastLine: index })) {
    scan.lines.add(index);
  }
}

function readPipeLine(
  context: Context,
  scan: TableScan,
  table: PipeTable | undefined,
  cells: readonly string[],
  index: number,
): PipeTable {
  const header = startsWithIdentifier(cells)
    ? undefined
    : parseTableHeader(cells, context.vocabulary);
  if (header !== undefined) {
    scan.table += 1;
    return { reading: { kind: "roles", roles: header }, columns: cells.length, gap: false };
  }
  const goesOn = table !== undefined && (!table.gap || table.columns === cells.length);
  const current = goesOn ? { ...table, gap: false } : openPipeTable(scan, cells);
  if (!isSeparatorRow(cells)) readPipeRow(context, scan, current, cells, index);
  return current;
}

function pipeTableCandidates(context: Context, scan: TableScan): void {
  let table: PipeTable | undefined;
  context.lines.forEach((line, index) => {
    const cells = tableCells(line.text);
    if (cells !== undefined) table = readPipeLine(context, scan, table, cells, index);
    else if (table !== undefined)
      table = collapse(line.text).length === 0 ? { ...table, gap: true } : undefined;
  });
}

interface OpenRow {
  readonly row: ProjectedRow;
  readonly line: number;
  lastLine: number;
}

function readProjectedTable(context: Context, scan: TableScan, rows: readonly OpenRow[]): void {
  if (rows.length === 0) return;
  scan.table += 1;
  const reading = readingOfProjectedTable(
    rows.map((open) => open.row),
    context.vocabulary,
  );
  for (const { row, line, lastLine } of rows) {
    for (let index = line; index <= lastLine; index += 1) scan.lines.add(index);
    if (reading.kind === "foreign") {
      if (startsWithIdentifier(row.cells)) scan.foreign.add(line);
    } else {
      readRow(context, scan, projectedCells(row, reading), { line, lastLine });
    }
  }
}

type RowLineEffect = "goes-on" | "ends-row" | "ends-table";

/** What a line that opens no row does to the row above it; a line of its cell extends that cell. */
function endsProjectedRow(raw: string): boolean {
  return isPointerRecord(raw) || isPlainProjection(raw);
}

function afterRowLine(open: OpenRow, line: Line, index: number, context: Context): RowLineEffect {
  // The parsers keep a row whole: a blank line is never inside a cell, it ends the table.
  if (collapse(line.text).length === 0) return "ends-table";
  if (endsProjectedRow(line.text)) return "ends-row";
  continueProjectedRow(open.row, line.text, context.vocabulary);
  open.lastLine = index;
  return "goes-on";
}

/** Rows of a table extraction (`Sheet!2: ID=FR-1 | Titel=Foo`), with their multi-line cells. */
function projectedTableCandidates(context: Context, scan: TableScan): void {
  let rows: OpenRow[] = [];
  let open: OpenRow | undefined;
  const closeTable = (): void => {
    readProjectedTable(context, scan, rows);
    rows = [];
    open = undefined;
  };
  context.lines.forEach((line, index) => {
    const started = openProjectedRow(line.text, context.vocabulary);
    const last = rows.at(-1)?.row;
    const changesTable =
      started !== undefined && last !== undefined && !continuesProjectedTable(last, started);
    if (changesTable || startsSection(context.starts, line)) closeTable();
    if (started !== undefined) {
      open = { row: started, line: index, lastLine: index };
      rows.push(open);
      return;
    }
    const effect = open === undefined ? "goes-on" : afterRowLine(open, line, index, context);
    if (effect === "ends-table") closeTable();
    else if (effect === "ends-row") open = undefined;
  });
  closeTable();
}

function scanTables(context: Context): TableScan {
  const scan: TableScan = { drafts: [], lines: new Set(), foreign: new Set(), table: 0 };
  pipeTableCandidates(context, scan);
  projectedTableCandidates(context, scan);
  return scan;
}

const TITLE_CONTINUATION_LINES_MAX = 3;
const TITLE_MAX_CHARS = 240;

/** Whether the line is plain wrapped text: no marker, heading, section start, key or table row. */
function isPlainContinuation(
  context: Context,
  index: number,
  tableLines: ReadonlySet<number>,
): boolean {
  const line = context.lines[index];
  if (line === undefined || tableLines.has(index)) return false;
  const text = bare(line.text);
  return (
    LOWER_CASE_START.test(text) &&
    !LIST_MARKER.test(line.text) &&
    !MARKDOWN_HEADING.test(line.text) &&
    !startsSection(context.starts, line) &&
    !isKeyLine(text, context.vocabulary)
  );
}

/**
 * A title the text hard-wrapped: plain text has no layout, so the evidence is the text itself. A title
 * without a closing mark whose next line (no blank line between) goes on in lower case is one title
 * around a line break, not a title and a body that happens to start in lower case.
 */
function wrappedTitle(
  context: Context,
  index: number,
  title: string,
  tableLines: ReadonlySet<number>,
): { readonly title: string; readonly titleLines: number } | undefined {
  let joined = title;
  let extra = 0;
  while (
    extra < TITLE_CONTINUATION_LINES_MAX &&
    joined.length > 0 &&
    joined.length < TITLE_MAX_CHARS &&
    !CLOSING_MARK.test(joined) &&
    isPlainContinuation(context, index + extra + 1, tableLines)
  ) {
    joined = collapse(`${joined} ${bare(lineAt(context.lines, index + extra + 1).text)}`);
    extra += 1;
  }
  return extra === 0 ? undefined : { title: joined, titleLines: extra };
}

function lineCandidates(context: Context, tableLines: ReadonlySet<number>): readonly Candidate[] {
  const found: Candidate[] = [];
  context.lines.forEach((line, index) => {
    if (tableLines.has(index)) return;
    const heading = MARKDOWN_HEADING.test(line.text) || startsSection(context.starts, line);
    const definition = classifyText(bare(line.text), heading, context.vocabulary);
    if (definition === undefined) return;
    const wrapped = heading
      ? undefined
      : wrappedTitle(context, index, definition.title, tableLines);
    found.push({ ...definition, ...wrapped, line: index, headingLine: true });
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

function findCandidates(context: Context, tables: TableScan): readonly Candidate[] {
  const rows = tables.drafts.map((draft) => rowCandidate(draft));
  const tableLines = new Set([...tables.lines, ...tables.foreign]);
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
    vocabulary.metaKey.test(text) ||
    vocabulary.statementKey.test(text)
  );
}

function advanceScanSegment(scan: Scan, text: string, vocabulary: CompiledVocabulary): void {
  if (vocabulary.criteriaKey.test(text)) scan.inCriteria = true;
  else if (vocabulary.statementKey.test(text)) {
    scan.inCriteria = false;
    scan.hasBody = true;
  } else if (vocabulary.priorityKey.test(text) || vocabulary.metaKey.test(text))
    scan.inCriteria = false;
  else if (!scan.inCriteria) scan.hasBody = true;
}

/** The scan reads a line the way the interpreter does, so a field inline in a line counts. */
function advanceScan(scan: Scan, text: string, vocabulary: CompiledVocabulary): void {
  for (const segment of segmentsOf(text, vocabulary)) {
    advanceScanSegment(scan, segment, vocabulary);
  }
}

function nextNonBlank(lines: readonly Line[], from: number, limit: number): number {
  for (let index = from; index <= limit; index += 1)
    if (bare(lineAt(lines, index).text).length > 0) return index;
  return -1;
}

/** The paragraph at `from` runs straight into a key line, which has no unit of its own to join. */
function leadsIntoKeyLine(context: Context, from: number, limit: number): boolean {
  for (let index = from; index <= limit; index += 1) {
    const text = bare(lineAt(context.lines, index).text);
    if (text.length === 0) return false;
    if (isKeyLine(text, context.vocabulary)) return true;
  }
  return false;
}

/** A line without a closing mark, then one starting in lower case: one sentence around a break. */
function sentenceGoesOn(context: Context, blank: number, next: number): boolean {
  const before = bare(lineAt(context.lines, blank - 1).text);
  return (
    before.length > 0 &&
    !CLOSING_MARK.test(before) &&
    LOWER_CASE_START.test(bare(lineAt(context.lines, next).text))
  );
}

/** In flat text a blank line ends the block unless the block evidently goes on behind it. */
function continuesAfterBlank(context: Context, scan: Scan, blank: number, limit: number): boolean {
  const next = nextNonBlank(context.lines, blank + 1, limit);
  if (next < 0) return false;
  const raw = lineAt(context.lines, next).text;
  if (isKeyLine(bare(raw), context.vocabulary) || !scan.hasBody) return true;
  if (scan.inCriteria && LIST_MARKER.test(raw)) return true;
  return sentenceGoesOn(context, blank, next) || leadsIntoKeyLine(context, next, limit);
}

function isHeadingShaped(raw: string, before: string, context: Context): boolean {
  const text = bare(raw);
  if (text.length > HEADING_MAX_CHARS || CLOSING_MARK.test(text)) return false;
  if (!HEADING_START.test(text) || isKeyLine(text, context.vocabulary)) return false;
  return NUMBERED_ITEM.test(raw) ? !NUMBERED_ITEM.test(before) : !LIST_MARKER.test(raw);
}

/** What precedes a chapter heading is finished: a closed sentence, a list item or a key value. */
function isFinishedLine(raw: string, vocabulary: CompiledVocabulary): boolean {
  const text = bare(raw);
  if (vocabulary.criteriaKey.test(text)) return false;
  return CLOSING_MARK.test(text) || LIST_MARKER.test(raw) || isKeyLine(text, vocabulary);
}

/** Behind the closing field of a block a heading opens a chapter of its own, whatever follows it. */
function startsChapter(context: Context, scan: Scan, line: string, last: number): boolean {
  if (!scan.hasBody) return false;
  const before = lineAt(context.lines, last).text;
  const closed = scan.inCriteria
    ? LIST_MARKER.test(before)
    : isKeyLine(bare(before), context.vocabulary);
  return closed && isHeadingShaped(line, before, context);
}

/** The chapter headings flat text leaves between this block's body and the next unit. */
function withoutTrailingHeadings(context: Context, candidate: Candidate, last: number): number {
  let end = last;
  while (end > candidate.line + 1) {
    const before = lineAt(context.lines, end - 1).text;
    const line = lineAt(context.lines, end).text;
    if (!isFinishedLine(before, context.vocabulary)) break;
    if (!isHeadingShaped(line, before, context)) break;
    end -= 1;
  }
  return end;
}

function endsStructuredBlock(line: Line, starts: readonly number[]): boolean {
  return MARKDOWN_HEADING.test(line.text) || startsSection(starts, line);
}

function leavesBlock(context: Context, candidate: Candidate, line: Line): boolean {
  const sectionEnd = candidate.section?.characterEnd;
  return sectionEnd === undefined
    ? endsStructuredBlock(line, context.starts)
    : line.start >= sectionEnd;
}

function endsFlatBlock(
  context: Context,
  scan: Scan,
  positions: { readonly index: number; readonly last: number; readonly limit: number },
): boolean {
  const { index, last, limit } = positions;
  const raw = lineAt(context.lines, index).text;
  return bare(raw).length === 0
    ? !continuesAfterBlank(context, scan, index, limit)
    : startsChapter(context, scan, raw, last);
}

/** The last line of the unit's head: its first line plus the lines a wrapped title runs over. */
function headLastLine(candidate: Candidate): number {
  return candidate.line + (candidate.titleLines ?? 0);
}

function isStructured(candidate: Candidate): boolean {
  return candidate.section?.characterEnd !== undefined || candidate.kind === "heading";
}

function lastBodyLine(context: Context, candidate: Candidate, limit: number): number {
  const structured = isStructured(candidate);
  const scan: Scan = { hasBody: false, inCriteria: false };
  const head = headLastLine(candidate);
  let last = head;
  for (let index = head + 1; index <= limit; index += 1) {
    const line = lineAt(context.lines, index);
    const rule = isThematicBreak(line.text);
    // Directly under the head a rule underlines the heading; behind a body it ends the block.
    if (leavesBlock(context, candidate, line) || (rule && last > head)) break;
    if (rule) continue;
    if (!structured && endsFlatBlock(context, scan, { index, last, limit })) break;
    const text = bare(line.text);
    if (text.length > 0) {
      advanceScan(scan, text, context.vocabulary);
      last = index;
    }
  }
  return structured ? last : withoutTrailingHeadings(context, candidate, last);
}

function lastLineOf(context: Context, candidate: Candidate, limit: number): number {
  return candidate.kind === "row"
    ? (candidate.rowLastLine ?? candidate.line)
    : lastBodyLine(context, candidate, limit);
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
      first: headLastLine(candidate) + (candidate.headingLine ? 1 : 0),
      last,
      start,
      end: lineAt(context.lines, last).end,
    };
  });
}

// ─── Interpretation ──────────────────────────────────────────────────────────

interface Interpreted {
  readonly priority?: string;
  /** The statement as presented, clipped to {@link STATEMENT_MAX_CHARS}. */
  readonly statement: string;
  /** The complete statement the digest covers; absent when {@link Interpreted.statement} is it. */
  readonly fullStatement?: string;
  readonly criteria: readonly string[];
}

/** The presented statement, and the complete one only where clipping lost something. */
function statementOf(full: string): Pick<Interpreted, "statement" | "fullStatement"> {
  return full.length <= STATEMENT_MAX_CHARS
    ? { statement: full }
    : { statement: full.slice(0, STATEMENT_MAX_CHARS), fullStatement: full };
}

type Mode = "text" | "criteria" | "note" | "label";
interface BodyState {
  readonly statement: string[];
  readonly criteria: string[];
  priority: string | undefined;
  mode: Mode;
  /** A marked criterion without a closing mark: the next unmarked line is its wrapped remainder. */
  criterionOpen: boolean;
  /** A metadata value that ended open: the next line still belongs to it. */
  labelOpen: boolean;
}

function stripCriterionNumber(value: string): string {
  return collapse(value.replace(CRITERION_NUMBER, ""));
}

/** The fields of a record line; a line that is no record, with a key it names, is one piece. */
function recordPieces(text: string, vocabulary: CompiledVocabulary): readonly string[] {
  if (!FIELD_HEAD.test(text)) return [text];
  const pieces = text.split(FIELD_JOINT);
  return pieces.length > 1 && pieces.some((piece) => isKeyLine(piece, vocabulary))
    ? pieces
    : [text];
}

/** A statement key counts inside a line only behind another field; a statement may name the word. */
function inlineFields(piece: string, vocabulary: CompiledVocabulary): readonly string[] {
  const opensWithField = vocabulary.priorityKey.test(piece) || vocabulary.metaKey.test(piece);
  const statement = opensWithField ? vocabulary.inlineStatementKey.exec(piece) : null;
  if (statement === null) return piece.split(vocabulary.inlineKey);
  return [
    ...piece.slice(0, statement.index).split(vocabulary.inlineKey),
    ...piece.slice(statement.index).split(vocabulary.inlineKey),
  ];
}

/** `Jira: KRED-29 Der Kunde ...`, `Priorität: Hoch Der Kunde ...`: a value that cannot run on. */
function withSentenceApart(field: string, vocabulary: CompiledVocabulary): readonly string[] {
  const lead = (vocabulary.metaKey.test(field) ? ID_VALUE_FIELD : vocabulary.priorityLead).exec(
    field,
  );
  if (lead === null) return [field];
  const rest = collapse(field.slice(lead[0].length));
  return SENTENCE_START.test(rest) ? [lead[0], rest] : [field];
}

/** One extractor line, split where it carries several fields. */
function segmentsOf(raw: string, vocabulary: CompiledVocabulary): readonly string[] {
  const pieces = recordPieces(bare(raw), vocabulary);
  const fields = pieces
    .flatMap((piece) => inlineFields(piece, vocabulary))
    .map((value) => collapse(value))
    .filter((field) => field.length > 0);
  // In a record, a field no vocabulary names is presentation like its neighbours.
  const named =
    pieces.length > 1
      ? fields.filter((field) => !FIELD_HEAD.test(field) || isKeyLine(field, vocabulary))
      : fields;
  return named.flatMap((field) => withSentenceApart(field, vocabulary));
}

function keyValue(segment: string, key: RegExp): string | undefined {
  const match = key.exec(segment);
  return match === null ? undefined : segment.slice(match[0].length);
}

/** A statement label is presentation: only the text after it is content. */
function readStatementLabel(state: BodyState, value: string): void {
  state.mode = "text";
  const statement = collapse(value);
  if (statement.length > 0) state.statement.push(statement);
}

function readCriteria(state: BodyState, criteria: string): void {
  state.mode = "criteria";
  state.criterionOpen = false;
  for (const item of criteria.split(MERGED_ITEMS)) {
    const criterion = stripCriterionNumber(item);
    if (criterion.length > 0) state.criteria.push(criterion);
  }
}

/**
 * One extractor line of a criteria list. A PDF reports a wrapped list item as several lines, so an
 * unmarked line continues a marked item that has not closed. A list without markers has no such
 * evidence and keeps one criterion per line.
 */
function readCriterionLine(state: BodyState, segment: string, marked: boolean): void {
  const text = stripCriterionNumber(segment);
  const last = state.criteria.length - 1;
  if (state.criterionOpen && !marked && last >= 0) {
    state.criteria[last] = collapse(`${state.criteria[last] ?? ""} ${text}`);
  } else {
    state.criteria.push(text);
  }
  state.criterionOpen = (marked || state.criterionOpen) && !CLOSING_MARK.test(text);
}

function readKeyField(state: BodyState, segment: string, vocabulary: CompiledVocabulary): boolean {
  const priority = keyValue(segment, vocabulary.priorityKey);
  const criteria = keyValue(segment, vocabulary.criteriaKey);
  const label = keyValue(segment, vocabulary.statementKey);
  if (priority !== undefined) {
    state.priority = collapse(trimTrailingMarks(priority.split(VALUE_END)[0] ?? ""));
    state.mode = "text";
  } else if (criteria !== undefined) readCriteria(state, criteria);
  else if (label !== undefined) readStatementLabel(state, label);
  else if (vocabulary.noteKey.test(segment)) state.mode = "note";
  else if (vocabulary.metaKey.test(segment)) {
    state.mode = "label";
    state.labelOpen = VALUE_GOES_ON.test(segment);
  } else return false;
  return true;
}

/** Behind a metadata value text is content again, unless the line evidently carries the value on. */
function readBehindLabel(state: BodyState, segment: string): void {
  if (state.labelOpen || LOWER_CASE_START.test(segment)) {
    state.labelOpen = VALUE_GOES_ON.test(segment);
    return;
  }
  state.mode = "text";
  state.statement.push(segment);
}

function readSegment(
  state: BodyState,
  segment: string,
  vocabulary: CompiledVocabulary,
  marked: boolean,
): void {
  if (readKeyField(state, segment, vocabulary)) return;
  if (state.mode === "label") readBehindLabel(state, segment);
  else if (state.mode === "criteria") readCriterionLine(state, segment, marked);
  else if (state.mode === "text") state.statement.push(segment);
}

function interpretBody(bodyLines: readonly Line[], vocabulary: CompiledVocabulary): Interpreted {
  const state: BodyState = {
    statement: [],
    criteria: [],
    priority: undefined,
    mode: "text",
    criterionOpen: false,
    labelOpen: false,
  };
  for (const line of bodyLines) {
    if (isThematicBreak(line.text)) continue;
    const marked = LIST_MARKER.test(line.text);
    for (const segment of segmentsOf(line.text, vocabulary))
      readSegment(state, segment, vocabulary, marked);
  }
  return {
    ...(state.priority === undefined || state.priority.length === 0
      ? {}
      : { priority: state.priority }),
    ...statementOf(state.statement.join(" ")),
    criteria: state.criteria.filter((criterion) => criterion.length > 0),
  };
}

function interpretRow(row: RowFields): Interpreted {
  return {
    ...(row.priority === undefined || row.priority.length === 0 ? {} : { priority: row.priority }),
    ...statementOf(row.statement),
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
      statement: interpreted.fullStatement ?? interpreted.statement,
      criteria: interpreted.criteria,
    }),
  });
}

interface RawUnit {
  readonly candidate: Candidate;
  readonly entry: RequirementInventoryEntry;
  readonly hasBody: boolean;
  readonly block: Block;
  readonly parts: EntryParts;
}

function rawUnit(context: Context, block: Block): RawUnit {
  const { candidate } = block;
  const body =
    candidate.row === undefined
      ? interpretBody(context.lines.slice(block.first, block.last + 1), context.vocabulary)
      : interpretRow(candidate.row);
  const { title, interpreted } = withTitleTag(candidate.title, body, context.vocabulary);
  const parts: EntryParts = {
    id: candidate.id,
    idOrigin: "explicit",
    unitKind: candidate.row === undefined ? "block" : "table-row",
    title,
    interpreted,
    sectionPath: sectionPathAt(context.sections, block.start),
    start: block.start,
    end: block.end,
  };
  const entry = toEntry(context, parts);
  const hasBody =
    interpreted.statement.length > 0 ||
    interpreted.criteria.length > 0 ||
    interpreted.priority !== undefined;
  return { candidate, entry, hasBody, block, parts };
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

/** What only a requirement says of itself: a priority, criteria or an obligation. */
function statesRequirement({ entry }: RawUnit, vocabulary: CompiledVocabulary): boolean {
  return (
    entry.priority !== undefined ||
    entry.acceptanceCriteria.length > 0 ||
    vocabulary.modal.test(entry.title) ||
    vocabulary.modal.test(entry.statement)
  );
}

/** A requirement context: a separated or table identifier, a body, or a second identifier. */
function accepted(
  unit: RawUnit,
  corroboration: ReadonlyMap<string, ReadonlySet<string>>,
  vocabulary: CompiledVocabulary,
): boolean {
  const { kind, id } = unit.candidate;
  if (kind === "strong" || kind === "row") return true;
  if ((corroboration.get(idPrefix(id))?.size ?? 0) >= 2) return true;
  return kind === "heading" ? unit.hasBody : statesRequirement(unit, vocabulary);
}

/** Statement or criteria: what makes a definition of more than a listing. */
function hasContent({ entry }: RawUnit): boolean {
  return entry.statement.length > 0 || entry.acceptanceCriteria.length > 0;
}

function richness(unit: RawUnit): readonly number[] {
  const { entry } = unit;
  return [
    hasContent(unit) ? 1 : 0,
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

function disagree(left: RawUnit, right: RawUnit): boolean {
  if (hasContent(left) && hasContent(right) && left.entry.digest !== right.entry.digest)
    return true;
  const [a, b] = [left.entry.priority, right.entry.priority];
  return a !== undefined && b !== undefined && foldTerm(a) !== foldTerm(b);
}

/** The definition, with the priority only a listing of the same identifier states. */
function withListedPriority(context: Context, best: RawUnit, group: readonly RawUnit[]): RawUnit {
  const listed = group.find((unit) => unit.entry.priority !== undefined)?.entry.priority;
  if (best.entry.priority !== undefined || listed === undefined) return best;
  const parts = { ...best.parts, interpreted: { ...best.parts.interpreted, priority: listed } };
  return { ...best, parts, entry: toEntry(context, parts) };
}

function selectDefinitions(context: Context, units: readonly RawUnit[]): Selection {
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
    chosen.push(withListedPriority(context, best, group));
    const others = group.filter((unit) => unit !== best);
    if (others.some((unit) => disagree(unit, best))) conflicting.push(id);
    referenceOnly += others.filter((unit) => !hasContent(unit)).length;
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

/** A list item, or the result line a calculation closes with. */
function startsParagraph(raw: string): boolean {
  return LIST_MARKER.test(raw) || RESULT_LINE.test(raw);
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
      isThematicBreak(line.text) ||
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

/**
 * Whether a sentence that opens with an obligation phrase is a conditional with its own subject:
 * the opening clause names a subject and a predicate (at least two words) and the main clause after
 * the comma states the obligation. A checklist fragment (`Muss dem Epic zugeordnet sein`) has no
 * such main clause.
 */
function conditionalObligation(vocabulary: CompiledVocabulary, statement: string): boolean {
  const match = vocabulary.conditionalLead.exec(statement);
  const clause = match?.[1];
  const main = match?.[2];
  if (clause === undefined || main === undefined) return false;
  return clause.trim().split(/\s+/u).length >= 2 && vocabulary.modal.test(main);
}

/** A sentence that states an obligation of a named subject (ISO/IEC/IEEE 29148 form). */
function obligationStatement(vocabulary: CompiledVocabulary, statement: string): boolean {
  if (statement.length < STATEMENT_MIN_CHARS || !vocabulary.modal.test(statement)) return false;
  if (RESULT_LINE.test(statement)) return false;
  return (
    !vocabulary.subjectlessModal.test(statement) || conditionalObligation(vocabulary, statement)
  );
}

function statementUnits(context: Context, covered: ReadonlySet<number>): readonly RawUnit[] {
  const occurrences = new Map<string, number>();
  const units: RawUnit[] = [];
  for (const paragraph of paragraphsOf(context, covered)) {
    for (const sentence of paragraph.text.split(SENTENCE_BREAK)) {
      const statement = collapse(sentence);
      if (!obligationStatement(context.vocabulary, statement)) continue;
      const wording = normalizedWording(statement);
      const occurrence = occurrences.get(wording) ?? 0;
      occurrences.set(wording, occurrence + 1);
      const id = derivedRequirementId(context.documentKey, statement, occurrence);
      const candidate: Candidate = { kind: "strong", id, title: "", line: -1, headingLine: false };
      const parts: EntryParts = {
        id,
        idOrigin: "derived",
        unitKind: "statement",
        title: "",
        interpreted: { ...statementOf(statement), criteria: [] },
        sectionPath: sectionPathAt(context.sections, paragraph.start),
        start: paragraph.start,
        end: paragraph.end,
      };
      const entry = toEntry(context, parts);
      const block: Block = {
        candidate,
        first: 0,
        last: 0,
        start: paragraph.start,
        end: paragraph.end,
      };
      units.push({ candidate, entry, hasBody: true, block, parts });
    }
  }
  return units;
}

function coveredLines(blocks: readonly Block[], tables: TableScan): ReadonlySet<number> {
  const covered = new Set<number>(tables.lines);
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
  const tables = scanTables(context);
  const blocks = buildBlocks(context, findCandidates(context, tables));
  const units = blocks.map((block) => rawUnit(context, block));
  const corroboration = prefixCorroboration(units);
  const kept = units.filter((unit) => accepted(unit, corroboration, context.vocabulary));
  const rejected = new Set(units.filter((unit) => !kept.includes(unit)).map((unit) => unit.block));
  const selection = selectDefinitions(context, kept);
  const statements = statementUnits(
    context,
    coveredLines(
      blocks.filter((block) => !rejected.has(block)),
      tables,
    ),
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
    rejectedCandidateCount: rejected.size + tables.foreign.size,
  });
}
