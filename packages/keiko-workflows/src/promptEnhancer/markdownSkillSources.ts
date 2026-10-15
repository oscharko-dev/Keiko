const MAX_SOURCE_REFERENCES = 24;
const MAX_REFERENCE_LABEL_CHARACTERS = 120;

function closesFence(line: string, delimiter: string, fence: string): boolean {
  return delimiter.startsWith(fence) && /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/u.test(line);
}

function sourceSectionStarts(lines: readonly string[]): readonly number[] {
  const headings: number[] = [];
  let fence: string | undefined;
  for (const [index, line] of lines.entries()) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (delimiter !== undefined) {
      if (fence === undefined) fence = delimiter;
      else if (closesFence(line, delimiter, fence)) fence = undefined;
      continue;
    }
    if (fence === undefined && /^ {0,3}#{1,6}[ \t]+\S/u.test(line)) headings.push(index);
  }
  if (headings.length > 0) return headings[0] === 0 ? headings : [0, ...headings];
  return lines.flatMap((line, index) =>
    index === 0 || (line.trim().length > 0 && lines[index - 1]?.trim().length === 0) ? [index] : [],
  );
}

function sourceLabel(lines: readonly string[], start: number, end: number): string {
  const first = lines.slice(start, end).find((line) => line.trim().length > 0) ?? "Source";
  const label = first.trim().replace(/^#{1,6}[ \t]+/u, "");
  const characters = Array.from(label);
  return characters.length <= MAX_REFERENCE_LABEL_CHARACTERS
    ? label
    : `${characters.slice(0, MAX_REFERENCE_LABEL_CHARACTERS).join("")}…`;
}

/** Adjacent sections coalesce when needed; the ranges still cover the complete admitted source. */
export function markdownSkillSourceReferences(source: string): readonly string[] {
  const lines = source.split("\n");
  const starts = sourceSectionStarts(lines);
  const stride = Math.max(1, Math.ceil(starts.length / MAX_SOURCE_REFERENCES));
  const references: string[] = [];
  for (let index = 0; index < starts.length; index += stride) {
    const start = starts[index];
    if (start === undefined) continue;
    const end = starts[index + stride] ?? lines.length;
    references.push(
      `- Source lines ${String(start + 1)}-${String(end)}: ${sourceLabel(lines, start, end)}`,
    );
  }
  return references;
}

/** Validate provenance without rewriting the model's output or certifying its interpretation. */
export function markdownSkillSourceReferencesMatch(content: string, source: string): boolean {
  const sections = content.split(/^## /mu).slice(1);
  const references = sections.filter((section) => /^source references[ \t]*\r?\n/iu.test(section));
  if (references.length !== 1) return false;
  const actual = references[0]
    ?.split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
  const expected = markdownSkillSourceReferences(source);
  return (
    actual?.length === expected.length && actual.every((line, index) => line === expected[index])
  );
}
