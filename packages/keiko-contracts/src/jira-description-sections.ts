/**
 * The shared reader of description structure for Jira issue templates (#4177, ADR-0128 D4).
 * Template bodies and explicitly tagged Markdown use the default mode: ATX, setext and Jira wiki
 * headings. Projected native Data Center descriptions use jira-wiki mode, where only hN. headings
 * count; numbered lists and setext-looking prose are content, never section headings.
 *
 * Both modes retain the same line/title bounds, code fences and section hierarchy. A deeper
 * heading belongs to the enclosing section; the next heading of the same or a shallower level
 * ends it. Nothing backtracks: every line is classified in time linear in its bounded length.
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
  readonly syntax: "atx" | "setext" | "wiki";
}
interface HeadingSpan extends Heading {
  readonly startLine: number;
  readonly endLine: number;
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
  return title.length === 0 ? undefined : { level, title, syntax: "atx" };
}

/** `h2. Title` of Jira wiki markup. */
function wikiHeading(line: string): Heading | undefined {
  const text = line.trimStart();
  const level = Number(text.charAt(1));
  const spacer = text.charAt(3);
  const shaped = text.startsWith("h") && level >= 1 && level <= 6 && text.charAt(2) === ".";
  if (!shaped || (spacer !== " " && spacer !== "\t")) return undefined;
  const title = text.slice(3).trim();
  return title.length === 0 ? undefined : { level, title, syntax: "wiki" };
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

// A wiki macro that closes on its own opening line (`{code}x = 1{code}`) is one line of text, not a
// block: opening a fence for it would hide every heading after it.
function wikiMacroOpening(text: string): boolean {
  const macro = ["{code", "{noformat"].find((marker) => text.startsWith(marker));
  if (macro === undefined) return false;
  const afterMarker = text.slice(text.indexOf("}") + 1);
  return !afterMarker.includes(macro);
}

function fenceOpening(line: string): Fence {
  const text = line.trimStart();
  if (leadingSpaces(line) <= 3 && (text.startsWith("```") || text.startsWith("~~~"))) {
    const char = text.charAt(0);
    let length = 0;
    while (text.charAt(length) === char) length += 1;
    // A backtick fence's info string holds no backtick: "```x```" is inline code, not a fence.
    if (char === "`" && text.includes("`", length)) return undefined;
    return { char, length };
  }
  return wikiMacroOpening(text) ? "wiki" : undefined;
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
  public readonly headings: HeadingSpan[] = [];
  private readonly open: number[] = [];
  private fence: Fence = undefined;
  private lineIndex = 0;
  /** A plain line is held until the next line shows whether it is a setext title. */
  private pending: string | undefined;

  public constructor(private readonly syntax: "markdown" | "jira-wiki" = "markdown") {}

  public read(lines: readonly string[]): void {
    for (const [index, line] of lines.entries()) {
      this.lineIndex = index;
      this.line(line);
    }
    this.flush();
  }

  private line(line: string): void {
    if (this.fence !== undefined) {
      if (fenceCloses(this.fence, line)) this.fence = undefined;
      this.content(line);
      return;
    }
    const underline =
      this.syntax === "jira-wiki" || this.pending === undefined ? undefined : setextLevel(line);
    if (underline !== undefined && this.pending !== undefined) {
      const title = this.pending.trim();
      this.pending = undefined;
      this.heading({ level: underline, title, syntax: "setext" }, this.lineIndex - 1);
      return;
    }
    this.flush();
    this.classify(line);
  }

  private classify(line: string): void {
    if (line.length <= JIRA_HEADING_LINE_CHARS_MAX) {
      const heading =
        this.syntax === "jira-wiki" ? wikiHeading(line) : (atxHeading(line) ?? wikiHeading(line));
      if (heading !== undefined) {
        this.heading(heading);
        return;
      }
    }
    const opening = fenceOpening(line);
    if (opening !== undefined) {
      this.fence = opening;
      this.content(line);
      return;
    }
    const settable =
      this.syntax === "markdown" &&
      line.length <= JIRA_HEADING_LINE_CHARS_MAX &&
      leadingSpaces(line) <= 3;
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

  private heading(heading: Heading, startLine = this.lineIndex): void {
    if (heading.title.length > JIRA_HEADING_TITLE_CHARS_MAX) {
      this.content(heading.title);
      return;
    }
    this.headings.push({ ...heading, startLine, endLine: this.lineIndex + 1 });
    // The heading line is text of every section it sits inside, and ends the ones it is not in.
    for (const index of this.open) {
      const section = this.sections[index];
      if (section !== undefined && section.level < heading.level) section.hasContent = true;
    }
    while (this.open.length > 0 && this.levelOf(this.open.at(-1)) >= heading.level) this.open.pop();
    this.open.push(this.sections.length);
    this.sections.push({ level: heading.level, title: heading.title, hasContent: false });
  }

  private levelOf(index: number | undefined): number {
    return index === undefined ? 0 : (this.sections[index]?.level ?? 0);
  }
}

/**
 * Headings and section content in the declared syntax. Template bodies and explicit Markdown use
 * the default reader; submitted or stored native Data Center descriptions require jira-wiki.
 */
export function readJiraDescriptionSections(
  text: string,
  syntax: "markdown" | "jira-wiki" = "markdown",
): readonly JiraDescriptionSection[] {
  const reader = new SectionReader(syntax);
  reader.read(text.slice(0, DESCRIPTION_CHARS_MAX).replace(/\r\n?/gu, "\n").split("\n"));
  return reader.sections;
}

export interface JiraDescriptionHeadingSerialization {
  readonly text: string;
  readonly convertedHeadingCount: number;
}

const MARKDOWN_DESCRIPTION_CHARS_MAX = 32768;
/** Native strings remain native Jira wiki text; Markdown requires explicit input provenance. */
export const JIRA_DESCRIPTION_INPUT_SCHEMA = {
  oneOf: [
    { type: "string", maxLength: MARKDOWN_DESCRIPTION_CHARS_MAX },
    {
      type: "object",
      additionalProperties: false,
      required: ["format", "text"],
      properties: {
        format: { type: "string", enum: ["markdown"] },
        text: { type: "string", maxLength: MARKDOWN_DESCRIPTION_CHARS_MAX },
      },
    },
  ],
} as const;

/**
 * Exact data properties only: a model value never supplies inherited members or accessors.
 * Unexpected reflection failures propagate to the caller's diagnostic boundary.
 */
export function readJiraMarkdownDescription(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return markdownDescriptionObject(value);
}
function markdownDescriptionObject(value: object): string | undefined {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.every((key) => key === "format" || key === "text"))
    return undefined;
  return markdownDescriptionData(value);
}
function markdownDescriptionData(value: object): string | undefined {
  const format = Object.getOwnPropertyDescriptor(value, "format");
  const text = Object.getOwnPropertyDescriptor(value, "text");
  if (
    [format, text].some(
      (descriptor) =>
        descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined,
    )
  )
    return undefined;
  const formatValue: unknown = format?.value;
  const textValue: unknown = text?.value;
  return formatValue === "markdown" &&
    typeof textValue === "string" &&
    textValue.length <= MARKDOWN_DESCRIPTION_CHARS_MAX
    ? textValue
    : undefined;
}

/** The canonical text projection shared by template checks and the human approval. */
export function projectJiraDescriptionInput(
  value: unknown,
): JiraDescriptionHeadingSerialization | undefined {
  if (typeof value === "string") return { text: value, convertedHeadingCount: 0 };
  const markdown = readJiraMarkdownDescription(value);
  return markdown === undefined ? undefined : serializeJiraDescriptionHeadings(markdown);
}

function writableSetextTitle(line: string): boolean {
  const content = line.trimStart();
  const indent = line.slice(0, line.length - content.length);
  if (indent.includes("\t") || indent.length > 3 || content.startsWith(">")) return false;
  return !/^(?:[-+*]+|\d{1,9}[.)])(?:[ \t]+|$)/u.test(content) && !/^_{3,}$/u.test(content);
}

/**
 * Data Center's wiki renderer reads `##` as a numbered list. Serialize only the headings the
 * canonical reader recognizes; all other text, including code/fences, quotes and footer, stays
 * byte-for-byte intact. Existing wiki headings already have their serialized form.
 */
export function serializeJiraDescriptionHeadings(
  text: string,
): JiraDescriptionHeadingSerialization {
  if (text.length > DESCRIPTION_CHARS_MAX) return { text, convertedHeadingCount: 0 };
  const parts = text.split(/(\r\n|\r|\n)/u);
  const lines = parts.filter((_part, index) => index % 2 === 0);
  const reader = new SectionReader();
  reader.read(lines);
  let convertedHeadingCount = 0;
  for (const heading of reader.headings) {
    const line = lines[heading.startLine] ?? "";
    if (heading.syntax === "wiki" || line.trimStart().startsWith(">")) continue;
    if (heading.syntax === "setext" && !writableSetextTitle(line)) continue;
    parts[heading.startLine * 2] = `h${String(heading.level)}. ${heading.title}`;
    if (heading.syntax === "setext") {
      parts[(heading.endLine - 1) * 2] = "";
      if ((heading.endLine - 1) * 2 + 1 < parts.length) parts[(heading.endLine - 1) * 2 + 1] = "";
    }
    convertedHeadingCount++;
  }
  return { text: parts.join(""), convertedHeadingCount };
}
