/**
 * The one reader of description structure for Jira issue templates (#4177, ADR-0128 D4). The
 * template parser takes its required sections from it and the checker judges an issue's
 * description with it, so a template and the text it governs are read by the same rules:
 *
 * - ATX headings (`## Title`), setext headings (a line underlined by three or more `=` or `-`)
 *   and Jira wiki headings (`h2. Title`) are headings; indented-code lines and lines over
 *   `JIRA_HEADING_LINE_CHARS_MAX` characters never are;
 * - fenced code (``` and ~~~ fences, `{code}` and `{noformat}` blocks) holds no headings;
 * - a deeper heading belongs to the enclosing section, so a section made only of subsections has
 *   content, and a section ends at the next heading of the same or a shallower level.
 *
 * Nothing here backtracks: every line is classified in time linear in its (bounded) length.
 */
export const JIRA_HEADING_LINE_CHARS_MAX = 512;
export const JIRA_HEADING_TITLE_CHARS_MAX = 200;
const DESCRIPTION_CHARS_MAX = 1 << 20;
const PLACEHOLDERS: ReadonlySet<string> = new Set(["tbd", "tba", "todo", "...", "…", "-"]);

export interface JiraDescriptionSection {
  /** 1 to 6, as written. */
  readonly level: number;
  /** The heading text as written, trimmed. */
  readonly title: string;
  /** The section, its subsections included, holds a line that is not blank or a placeholder. */
  readonly hasContent: boolean;
}

interface Heading {
  readonly level: number;
  readonly title: string;
}
type Fence = { readonly char: string; readonly length: number } | "wiki" | undefined;

function leadingSpaces(line: string): number {
  let count = 0;
  while (count < line.length && line.codePointAt(count) === 32) count += 1;
  return count;
}

/** The closing run of an ATX heading counts only after a blank (or as the whole text). */
function withoutClosingHashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.codePointAt(end - 1) === 35) end -= 1;
  if (end === text.length) return text;
  const before = text.charAt(end - 1);
  return end === 0 || before === " " || before === "\t" ? text.slice(0, end).trim() : text;
}

/** `# Title`, `## Title ##`: one to six hashes, then a blank, then text. */
function atxHeading(line: string): Heading | undefined {
  const start = leadingSpaces(line);
  if (start > 3) return undefined;
  let level = 0;
  while (line.codePointAt(start + level) === 35) level += 1;
  const after = line.charAt(start + level);
  if (level < 1 || level > 6 || (after !== " " && after !== "\t")) return undefined;
  const title = withoutClosingHashes(line.slice(start + level).trim());
  return title.length === 0 ? undefined : { level, title };
}

/** `h2. Title` of Jira wiki markup. */
function wikiHeading(line: string): Heading | undefined {
  const text = line.trimStart();
  const level = Number(text.charAt(1));
  const spacer = text.charAt(3);
  const shaped = text.startsWith("h") && level >= 1 && level <= 6 && text.charAt(2) === ".";
  if (!shaped || (spacer !== " " && spacer !== "\t")) return undefined;
  const title = text.slice(3).trim();
  return title.length === 0 ? undefined : { level, title };
}

/** The level a setext underline gives the line above it: `=` is 1, `-` is 2. */
function setextLevel(line: string): number | undefined {
  const text = line.trim();
  if (text.length < 3 || leadingSpaces(line) > 3) return undefined;
  const char = text.charAt(0);
  if (char !== "=" && char !== "-") return undefined;
  for (const other of text) if (other !== char) return undefined;
  return char === "=" ? 1 : 2;
}

function fenceOpening(line: string): Fence {
  const text = line.trimStart();
  if (leadingSpaces(line) <= 3 && (text.startsWith("```") || text.startsWith("~~~"))) {
    const char = text.charAt(0);
    let length = 0;
    while (text.charAt(length) === char) length += 1;
    return { char, length };
  }
  return text.startsWith("{code") || text.startsWith("{noformat") ? "wiki" : undefined;
}

function fenceCloses(fence: Exclude<Fence, undefined>, line: string): boolean {
  const text = line.trim();
  if (fence === "wiki") return text.startsWith("{code") || text.startsWith("{noformat");
  if (text.length < fence.length) return false;
  for (const char of text) if (char !== fence.char) return false;
  return true;
}

function substantive(line: string): boolean {
  const text = line.trim();
  if (text.length === 0) return false;
  return !(PLACEHOLDERS.has(text.toLowerCase()) || /^<[^<>]*>$/u.test(text));
}

class SectionReader {
  public readonly sections: { level: number; title: string; hasContent: boolean }[] = [];
  private readonly open: number[] = [];
  private fence: Fence = undefined;
  /** A plain line is held until the next line shows whether it is a setext title. */
  private pending: string | undefined;

  public read(lines: readonly string[]): void {
    for (const line of lines) this.line(line);
    this.flush();
  }

  private line(line: string): void {
    if (this.fence !== undefined) {
      if (fenceCloses(this.fence, line)) this.fence = undefined;
      this.content(line);
      return;
    }
    const underline = this.pending === undefined ? undefined : setextLevel(line);
    if (underline !== undefined && this.pending !== undefined) {
      const title = this.pending.trim();
      this.pending = undefined;
      this.heading({ level: underline, title });
      return;
    }
    this.flush();
    this.classify(line);
  }

  private classify(line: string): void {
    const heading =
      line.length > JIRA_HEADING_LINE_CHARS_MAX
        ? undefined
        : (atxHeading(line) ?? wikiHeading(line));
    if (heading !== undefined) {
      this.heading(heading);
      return;
    }
    const opening = fenceOpening(line);
    if (opening !== undefined) {
      this.fence = opening;
      this.content(line);
      return;
    }
    const settable = line.length <= JIRA_HEADING_LINE_CHARS_MAX && leadingSpaces(line) <= 3;
    if (settable && substantive(line)) this.pending = line;
    else this.content(line);
  }

  private flush(): void {
    const line = this.pending;
    this.pending = undefined;
    if (line !== undefined) this.content(line);
  }

  private content(line: string): void {
    if (!substantive(line)) return;
    for (const index of this.open) {
      const section = this.sections[index];
      if (section !== undefined) section.hasContent = true;
    }
  }

  private heading(heading: Heading): void {
    if (heading.title.length > JIRA_HEADING_TITLE_CHARS_MAX) {
      this.content(heading.title);
      return;
    }
    // The heading line is text of every section it sits inside, and ends the ones it is not in.
    for (const index of this.open) {
      const section = this.sections[index];
      if (section !== undefined && section.level < heading.level) section.hasContent = true;
    }
    while (this.open.length > 0 && this.levelOf(this.open.at(-1)) >= heading.level) this.open.pop();
    this.open.push(this.sections.length);
    this.sections.push({ ...heading, hasContent: false });
  }

  private levelOf(index: number | undefined): number {
    return index === undefined ? 0 : (this.sections[index]?.level ?? 0);
  }
}

/** Every heading of a description or template body, in order, with whether its section has content. */
export function readJiraDescriptionSections(text: string): readonly JiraDescriptionSection[] {
  const reader = new SectionReader();
  reader.read(text.slice(0, DESCRIPTION_CHARS_MAX).replace(/\r\n?/gu, "\n").split("\n"));
  return reader.sections;
}
