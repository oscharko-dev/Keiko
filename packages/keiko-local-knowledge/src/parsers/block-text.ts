// The block contract of normalized text, shared by the document parsers (#4235).
//
// In normalized text a blank line ends a block. Only the items of one list and the rows of one table
// stay on adjacent lines, so a single line break means "this goes on" and never "something else
// starts here". The chunker's paragraph boundary, retrieval excerpts and the requirement inventory
// all read that same promise; a parser that joins two paragraphs with one line break, or leaves a
// blank line inside a table row, hands them a structure the document does not have.

export const BLOCK_BREAK = "\n\n";
export const ROW_BREAK = "\n";

/** The list items of a document; adjacent ones stay together. */
export const LIST_GROUP = "list";

export interface TextBlock {
  readonly text: string;
  /** Adjacent blocks of one group (a list, a table) keep a single line break between them. */
  readonly group?: string;
}

export function breakBetween(left: string | undefined, right: string | undefined): string {
  return left !== undefined && left === right ? ROW_BREAK : BLOCK_BREAK;
}

export interface BlockLayout {
  /** Where each block starts in the joined text. */
  readonly starts: readonly number[];
  /** The length of the joined text. */
  readonly end: number;
}

export function layoutOfBlocks(blocks: readonly TextBlock[]): BlockLayout {
  const starts: number[] = [];
  let cursor = 0;
  blocks.forEach((block, index) => {
    if (index > 0) cursor += breakBetween(blocks[index - 1]?.group, block.group).length;
    starts.push(cursor);
    cursor += block.text.length;
  });
  return { starts, end: cursor };
}

export function joinBlocks(blocks: readonly TextBlock[]): string {
  const parts: string[] = [];
  blocks.forEach((block, index) => {
    if (index > 0) parts.push(breakBetween(blocks[index - 1]?.group, block.group));
    parts.push(block.text);
  });
  return parts.join("");
}

/**
 * The lines of a table cell or any other single value that must stay one row: every line is kept,
 * and no blank line can end the row early. Line endings are unified on the way.
 */
export function joinedLines(value: string): string {
  return value
    .split(/\r\n?|\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(ROW_BREAK);
}
