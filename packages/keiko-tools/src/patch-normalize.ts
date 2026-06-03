// Best-effort normalization for common LLM unified-diff shorthand. This module rewrites hunk headers
// from the hunk body markers (" ", "+", "-") and repairs blank context lines that models often emit
// as an empty line instead of a single-space diff line. It does not invent paths; the normal
// validate/apply path still performs path containment, deny-list checks, and conflict checks.

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

function isBodyLine(line: string): boolean {
  const marker = line.charAt(0);
  return marker === " " || marker === "+" || marker === "-";
}

function isFileHeaderPair(lines: readonly string[], index: number): boolean {
  return lines[index]?.startsWith("--- ") === true && lines[index + 1]?.startsWith("+++ ") === true;
}

function hunkEnd(lines: readonly string[], start: number): number {
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.startsWith("@@") || isFileHeaderPair(lines, index)) {
      break;
    }
    index += 1;
  }
  return index;
}

function countOldLines(lines: readonly string[]): number {
  return lines.filter((line) => line.startsWith(" ") || line.startsWith("-")).length;
}

function countNewLines(lines: readonly string[]): number {
  return lines.filter((line) => line.startsWith(" ") || line.startsWith("+")).length;
}

function parseStarts(
  line: string,
): { oldStart: number; newStart: number; suffix: string } | undefined {
  const match = HUNK_HEADER.exec(line);
  if (match === null) {
    return line.trim() === "@@" ? { oldStart: 0, newStart: 1, suffix: "" } : undefined;
  }
  return {
    oldStart: Number(match[1]),
    newStart: Number(match[2]),
    suffix: match[3] ?? "",
  };
}

function formatRange(start: number, count: number): string {
  return `${String(start)},${String(count)}`;
}

function normalizeHunkHeader(header: string, body: readonly string[]): string {
  const starts = parseStarts(header);
  if (starts === undefined) {
    return header;
  }
  const { oldStart, newStart, suffix } = starts;
  return `@@ -${formatRange(oldStart, countOldLines(body))} +${formatRange(
    newStart,
    countNewLines(body),
  )} @@${suffix}`;
}

function hasBodyLineBefore(lines: readonly string[], index: number): boolean {
  return lines.slice(0, index).some(isBodyLine);
}

function hasBodyLineAfter(lines: readonly string[], index: number): boolean {
  return lines.slice(index + 1).some(isBodyLine);
}

function normalizeBlankContextLines(lines: readonly string[]): readonly string[] {
  return lines.map((line, index) =>
    line === "" && hasBodyLineBefore(lines, index) && hasBodyLineAfter(lines, index) ? " " : line,
  );
}

export function normalizeUnifiedDiffHunks(diff: string): string {
  const lines = diff.split("\n");
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.startsWith("@@")) {
      out.push(line);
      index += 1;
      continue;
    }
    const end = hunkEnd(lines, index + 1);
    const normalizedLines = normalizeBlankContextLines(lines.slice(index + 1, end));
    const body = normalizedLines.filter(isBodyLine);
    out.push(normalizeHunkHeader(line, body), ...normalizedLines);
    index = end;
  }
  return out.join("\n");
}
