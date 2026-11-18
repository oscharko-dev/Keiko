// The one physical-line contract shared by source classification, line selection, excerpts, the
// Coding repository projection and the workspace index (#4439). A physical line ends at "\n" or
// "\r\n"; the terminator never belongs to the line, so a file with Windows line endings yields the
// same lines, excerpts and ranges as its LF equivalent. A lone "\r" is not a terminator: it stays
// line content, exactly as Git and every existing line-numbering path count it, so line numbers
// never diverge between lanes.

const PHYSICAL_LINE_BREAK = /\r?\n/u;

export interface PhysicalLineSpan {
  /** Offset of the line's first code unit in the original text. */
  readonly start: number;
  /** Offset just past the line's last code unit, excluding its terminator. */
  readonly end: number;
}

export function splitPhysicalLines(text: string): string[] {
  return text.split(PHYSICAL_LINE_BREAK);
}

// Rewrites every "\r\n" terminator to "\n"; equivalent to splitPhysicalLines(text).join("\n").
export function normalizePhysicalLineBreaks(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

// Original-text coordinates of every physical line, so a caller that slices the raw source keeps
// exact offsets while excluding the terminator bytes.
export function physicalLineSpans(text: string): PhysicalLineSpan[] {
  const spans: PhysicalLineSpan[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) {
      spans.push({ start, end: text.length });
      return spans;
    }
    const end = newline > start && text[newline - 1] === "\r" ? newline - 1 : newline;
    spans.push({ start, end });
    start = newline + 1;
  }
}
