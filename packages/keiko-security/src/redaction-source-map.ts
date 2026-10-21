export const REDACTION_PLACEHOLDER = "[REDACTED]";

export interface SourceTextEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}
export interface SourceTextProjection {
  readonly text: string;
  rawOffset(offset: number): number;
}
interface OffsetChange {
  readonly boundary: number;
  readonly removed: number;
}

function mappedOffset(changes: readonly OffsetChange[], offset: number): number {
  let low = 0;
  let high = changes.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((changes[middle]?.boundary ?? Infinity) <= offset) low = middle + 1;
    else high = middle;
  }
  return offset + (changes[low - 1]?.removed ?? 0);
}

/** Ordered lexical edits retain a boundary map; deleted presentation is not executable source. */
export function projectSourceText(
  source: string,
  edits: readonly SourceTextEdit[],
): SourceTextProjection {
  const chunks: string[] = [];
  const changes: OffsetChange[] = [];
  let copied = 0;
  let removed = 0;
  for (const edit of edits) {
    chunks.push(source.slice(copied, edit.start), edit.replacement);
    removed += edit.end - edit.start - edit.replacement.length;
    changes.push({ boundary: edit.end - removed, removed });
    copied = edit.end;
  }
  chunks.push(source.slice(copied));
  return { text: chunks.join(""), rawOffset: (offset): number => mappedOffset(changes, offset) };
}
