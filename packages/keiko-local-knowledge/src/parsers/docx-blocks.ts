// Projection of the docx block model to the lines the parser indexes. A body paragraph becomes one
// entry (a heading when its style or outline level says so, a list item with its real marker when
// it is numbered), a table becomes its `Table row` lines, and a note appears where it is
// referenced, so a footnote stays in the section whose text cites it.

import { bulletMarker, type ListMarker, type NumberingTracker } from "./docx-numbering.js";
import {
  resolveHeadingLevel,
  resolveStyleNumbering,
  styleLabel,
  type StyleCatalog,
} from "./docx-styles.js";
import { normalizeLine, projectTable } from "./docx-tables.js";
import type { NoteRef, RawBlock, RawParagraph, RawTable } from "./docx-xml.js";

export interface Paragraph {
  readonly text: string;
  readonly headingLevel?: number;
}

export interface ProjectionContext {
  readonly styles: StyleCatalog | undefined;
  readonly numbering: NumberingTracker;
  readonly footnotes: ReadonlyMap<string, readonly RawBlock[]>;
  readonly endnotes: ReadonlyMap<string, readonly RawBlock[]>;
  /** Notes already placed, keyed `footnote:<id>` / `endnote:<id>`. */
  readonly placed: Set<string>;
}

const INDENT = "  ";
const LIST_STYLE_PATTERN = /^list\s*(?:bullet|number)/iu;

// No-break and narrow no-break spaces keep a number and its unit together on screen; in indexed
// text they would stop "10 EUR" from matching a query typed with an ordinary space.
const NO_BREAK_SPACES = /[\u00a0\u2007\u202f]/gu;

function lineOf(text: string): string {
  return text
    .replaceAll(NO_BREAK_SPACES, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

// ─── List markers ────────────────────────────────────────────────────────────

/** A list that cannot be resolved is still a list item: a bullet, never an invented number. */
function unresolvedListMarker(
  paragraph: RawParagraph,
  context: ProjectionContext,
): ListMarker | undefined {
  const named =
    paragraph.styleId !== undefined &&
    LIST_STYLE_PATTERN.test(styleLabel(context.styles, paragraph.styleId));
  return paragraph.hasNumPr || named ? bulletMarker(paragraph.ilvl ?? 0) : undefined;
}

/** The list a paragraph belongs to: its own `w:numPr`, else the one its style applies. */
function listMarkerOf(paragraph: RawParagraph, context: ProjectionContext): ListMarker | undefined {
  if (paragraph.numId === "0") return undefined;
  const fromStyle = resolveStyleNumbering(context.styles, paragraph.styleId);
  const numId = paragraph.numId ?? fromStyle?.numId;
  if (numId === undefined) return unresolvedListMarker(paragraph, context);
  if (numId === "0") return undefined;
  const ilvl = paragraph.ilvl ?? fromStyle?.ilvl;
  return context.numbering.mark(numId, ilvl, paragraph.styleId);
}

function withMarker(text: string, marker: ListMarker | undefined): string {
  if (marker === undefined || marker.kind === "none") return text;
  const lead = marker.kind === "bullet" ? "-" : marker.text;
  return `${INDENT.repeat(marker.level)}${lead} ${text}`;
}

// ─── Paragraphs ──────────────────────────────────────────────────────────────

function paragraphEntry(paragraph: RawParagraph, context: ProjectionContext): Paragraph[] {
  // Every list paragraph advances its counter, including a heading and an empty one, as in Word.
  const marker = listMarkerOf(paragraph, context);
  const text = lineOf(paragraph.text);
  if (text.length === 0) return [];
  const headingLevel = paragraph.inBox
    ? undefined
    : resolveHeadingLevel(context.styles, paragraph.styleId, paragraph.outlineLvl);
  if (headingLevel !== undefined) return [{ text: normalizeLine(text), headingLevel }];
  return [{ text: withMarker(text, marker) }];
}

// ─── Notes ───────────────────────────────────────────────────────────────────

function noteLabel(ref: NoteRef): string {
  return `${ref.kind === "footnote" ? "Footnote" : "Endnote"} ${ref.id}`;
}

function blockTexts(blocks: readonly RawBlock[]): readonly string[] {
  return blocks.flatMap((block) =>
    block.kind === "p" ? [normalizeLine(block.paragraph.text)] : projectTable(block.table),
  );
}

function noteEntry(ref: NoteRef, context: ProjectionContext): Paragraph[] {
  const key = `${ref.kind}:${ref.id}`;
  const source = ref.kind === "footnote" ? context.footnotes : context.endnotes;
  const blocks = source.get(key);
  if (blocks === undefined || context.placed.has(key)) return [];
  context.placed.add(key);
  const text = blockTexts(blocks)
    .filter((part) => part.length > 0)
    .join(" ");
  return text.length === 0 ? [] : [{ text: `${noteLabel(ref)}: ${text}` }];
}

function tableNoteRefs(table: RawTable): readonly NoteRef[] {
  return table.rows.flatMap((row) =>
    row.cells.flatMap((cell) =>
      cell.blocks.flatMap((block) =>
        block.kind === "p" ? block.paragraph.noteRefs : tableNoteRefs(block.table),
      ),
    ),
  );
}

/** Notes that no body paragraph references, in part order, so none of them disappears silently. */
export function unreferencedNotes(context: ProjectionContext): Paragraph[] {
  const out: Paragraph[] = [];
  for (const [kind, notes] of [
    ["footnote", context.footnotes],
    ["endnote", context.endnotes],
  ] as const) {
    for (const key of notes.keys()) {
      const id = key.slice(kind.length + 1);
      out.push(...noteEntry({ kind, id }, context));
    }
  }
  return out;
}

// ─── Body ────────────────────────────────────────────────────────────────────

/** Projects the top-level blocks of the document body in order. */
export function projectBody(
  blocks: readonly RawBlock[],
  context: ProjectionContext,
): readonly Paragraph[] {
  const out: Paragraph[] = [];
  for (const block of blocks) {
    if (block.kind === "p") {
      out.push(...paragraphEntry(block.paragraph, context));
      for (const ref of block.paragraph.noteRefs) out.push(...noteEntry(ref, context));
      continue;
    }
    for (const line of projectTable(block.table)) out.push({ text: line });
    for (const ref of tableNoteRefs(block.table)) out.push(...noteEntry(ref, context));
  }
  return out;
}
