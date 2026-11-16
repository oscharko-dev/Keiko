import { CLIENT_CITATION_HIGHLIGHT_BOX_MAX } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";

// Finds a cited passage in a PDF page's text layer and frames it. The page text (pdf.js text
// items) and the stored document text are extracted differently: line breaks, hyphenation,
// ligatures and spacing differ. Both sides are therefore compared on their letters and digits only,
// and the passage is located by short anchors from its start and from its end, so a passage that
// begins on the previous page or ends on the next one still frames the part on this page.

/** A pdf.js text item, structurally: its string, glyph-space transform and advance. */
export interface PdfTextItemLike {
  readonly str: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
}

/** The pdf.js page viewport used for the canvas the boxes sit on. */
export interface PdfViewportLike {
  readonly width: number;
  readonly height: number;
  convertToViewportPoint(x: number, y: number): number[];
}

/** A framed region as fractions of the page viewport, so it is independent of the shown size. */
export interface HighlightBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

// The report contract's bound: a page shows at most as many frames as its outcome may count.
export const HIGHLIGHT_BOX_MAX = CLIENT_CITATION_HIGHLIGHT_BOX_MAX;

const ANCHOR_CHARS = 24;
const ANCHOR_STEP = 6;
const MIN_PASSAGE_CHARS = 12;
const BOX_PADDING_PX = 3;
const KEPT_CHARACTER = /[\p{L}\p{N}]/u;

interface KeyedText {
  readonly key: string;
  readonly owners: readonly number[];
}

export function isPdfTextItem(value: unknown): value is PdfTextItemLike {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.str === "string" &&
    Array.isArray(item.transform) &&
    typeof item.width === "number" &&
    typeof item.height === "number"
  );
}

function keyedCharacters(text: string): string[] {
  const kept: string[] = [];
  for (const character of text.normalize("NFKC").toLowerCase()) {
    if (KEPT_CHARACTER.test(character)) kept.push(character);
  }
  return kept;
}

function keyedPage(items: readonly PdfTextItemLike[]): KeyedText {
  const characters: string[] = [];
  const owners: number[] = [];
  items.forEach((item, index) => {
    for (const character of keyedCharacters(item.str)) {
      characters.push(character);
      owners.push(index);
    }
  });
  return { key: characters.join(""), owners };
}

function firstAnchor(page: string, passage: string, length: number): number | undefined {
  for (let offset = 0; offset + length <= passage.length; offset += ANCHOR_STEP) {
    const found = page.indexOf(passage.slice(offset, offset + length));
    if (found >= 0) return found;
  }
  return undefined;
}

function lastAnchorEnd(
  page: string,
  passage: string,
  length: number,
  from: number,
): number | undefined {
  for (let offset = passage.length - length; offset >= 0; offset -= ANCHOR_STEP) {
    const found = page.indexOf(passage.slice(offset, offset + length), from);
    if (found >= 0) return found + length;
  }
  return undefined;
}

/**
 * The indices of the text items that carry the passage on this page, in page order, or undefined
 * when the passage cannot be found there with confidence.
 */
export function locatePassageItems(
  items: readonly PdfTextItemLike[],
  passage: string,
): readonly number[] | undefined {
  const wanted = keyedCharacters(passage).join("");
  if (wanted.length < MIN_PASSAGE_CHARS) return undefined;
  const page = keyedPage(items);
  const length = Math.min(ANCHOR_CHARS, wanted.length);
  const start = firstAnchor(page.key, wanted, length);
  if (start === undefined) return undefined;
  const end = lastAnchorEnd(page.key, wanted, length, start);
  // A span much longer than the passage joined two unrelated occurrences.
  if (end === undefined || end - start > wanted.length * 1.2 + ANCHOR_CHARS) return undefined;
  return [...new Set(page.owners.slice(start, end))];
}

interface PixelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function coordinate(values: readonly number[], index: number): number {
  return values[index] ?? 0;
}

function itemRect(item: PdfTextItemLike, viewport: PdfViewportLike): PixelRect | undefined {
  const { transform } = item;
  const x = coordinate(transform, 4);
  const y = coordinate(transform, 5);
  const height =
    item.height > 0 ? item.height : Math.hypot(coordinate(transform, 2), coordinate(transform, 3));
  if (item.str.trim().length === 0 || item.width <= 0 || height <= 0) return undefined;
  const first = viewport.convertToViewportPoint(x, y);
  const second = viewport.convertToViewportPoint(x + item.width, y + height);
  const [x1, y1, x2, y2] = [
    coordinate(first, 0),
    coordinate(first, 1),
    coordinate(second, 0),
    coordinate(second, 1),
  ];
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    right: Math.max(x1, x2),
    bottom: Math.max(y1, y2),
  };
}

function medianLineHeight(rects: readonly PixelRect[]): number {
  const heights = rects
    .map((rect) => rect.bottom - rect.top)
    .sort((first, second) => first - second);
  return Math.max(1, heights[Math.floor(heights.length / 2)] ?? 1);
}

// One frame per region the passage covers: lines and table rows that follow each other closely
// belong to one region; a jump (the next column, a page footer) starts another.
function mergeIntoBlocks(rects: readonly PixelRect[]): PixelRect[] {
  const allowedGap = medianLineHeight(rects) * 2.5;
  const blocks: PixelRect[] = [];
  for (const rect of rects) {
    const block = blocks.at(-1);
    if (block === undefined || rect.top - block.bottom > allowedGap) {
      blocks.push({ ...rect });
      continue;
    }
    block.left = Math.min(block.left, rect.left);
    block.right = Math.max(block.right, rect.right);
    block.bottom = Math.max(block.bottom, rect.bottom);
  }
  return blocks;
}

function asFractions(block: PixelRect, viewport: PdfViewportLike): HighlightBox {
  const left = Math.max(0, block.left - BOX_PADDING_PX);
  const top = Math.max(0, block.top - BOX_PADDING_PX);
  const right = Math.min(viewport.width, block.right + BOX_PADDING_PX);
  const bottom = Math.min(viewport.height, block.bottom + BOX_PADDING_PX);
  return {
    left: left / viewport.width,
    top: top / viewport.height,
    width: (right - left) / viewport.width,
    height: (bottom - top) / viewport.height,
  };
}

/** The framed regions of the given text items: one box per block of continuing lines. */
export function highlightBoxes(
  items: readonly PdfTextItemLike[],
  indices: readonly number[],
  viewport: PdfViewportLike,
): readonly HighlightBox[] {
  if (viewport.width <= 0 || viewport.height <= 0) return [];
  const rects = indices
    .map((index) => items[index])
    .flatMap((item) => {
      const rect = item === undefined ? undefined : itemRect(item, viewport);
      return rect === undefined ? [] : [rect];
    })
    .sort((first, second) => first.top - second.top || first.left - second.left);
  return mergeIntoBlocks(rects)
    .slice(0, HIGHLIGHT_BOX_MAX)
    .map((block) => asFractions(block, viewport));
}
