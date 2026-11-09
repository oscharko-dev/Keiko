/**
 * The shared reader of description structure for Jira issue templates (#4177, ADR-0128 D4).
 * Template bodies and explicitly tagged Markdown use the default mode: ATX, setext and Jira wiki
 * headings. Projected native Data Center descriptions use jira-wiki mode, where only hN. headings
 * count; numbered lists and setext-looking prose are content, never section headings.
 *
 * Both modes retain the same line/title bounds and section hierarchy. Markdown fences belong only
 * to Markdown; native wiki blocks use matching {code} or {noformat} macros. A deeper
 * heading belongs to the enclosing section; the next heading of the same or a shallower level
 * ends it. Nothing backtracks: every line is classified in time linear in its bounded length.
 */
import { markdownBlocksToJiraWiki, readsAsMarkdownOnly } from "./jira-markdown-wiki.js";

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
type Fence = { readonly char: string; readonly length: number } | "code" | "noformat" | undefined;

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
function wikiMacroOpening(text: string): "code" | "noformat" | undefined {
  const macro = ["{code", "{noformat"].find(
    (marker) =>
      text.startsWith(marker) &&
      (text.charAt(marker.length) === "}" || text.charAt(marker.length) === ":"),
  );
  if (macro === undefined) return undefined;
  const afterMarker = text.slice(text.indexOf("}") + 1);
  if (afterMarker.includes(macro)) return undefined;
  return macro === "{code" ? "code" : "noformat";
}

function fenceOpening(line: string, syntax: "markdown" | "jira-wiki"): Fence {
  const text = line.trimStart();
  if (
    syntax === "markdown" &&
    leadingSpaces(line) <= 3 &&
    (text.startsWith("```") || text.startsWith("~~~"))
  ) {
    const char = text.charAt(0);
    let length = 0;
    while (text.charAt(length) === char) length += 1;
    // A backtick fence's info string holds no backtick: "```x```" is inline code, not a fence.
    if (char === "`" && text.includes("`", length)) return undefined;
    return { char, length };
  }
  return wikiMacroOpening(text);
}

function fenceCloses(fence: Exclude<Fence, undefined>, line: string): boolean {
  const text = line.trim();
  if (typeof fence === "string") return text.startsWith(`{${fence}}`);
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
    const opening = fenceOpening(line, this.syntax);
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

interface DescriptionBlocks {
  readonly blocks: string[];
  paragraph: string[];
  fence: Fence;
  quoted: boolean;
  quoteParagraph: boolean;
}
function flushDescriptionBlock(state: DescriptionBlocks): void {
  if (state.paragraph.length > 0) state.blocks.push(state.paragraph.join("\n"));
  state.paragraph = [];
}
function descriptionCodeFence(line: string, syntax: "markdown" | "jira-wiki"): Fence {
  const opening = fenceOpening(line, syntax);
  if (opening !== undefined) return opening;
  const markers = [line.indexOf("{code"), line.indexOf("{noformat")].filter((index) => index >= 0);
  return markers.length === 0 ? undefined : wikiMacroOpening(line.slice(Math.min(...markers)));
}
function quotedDescriptionLine(state: DescriptionBlocks, text: string): boolean {
  const quotes = text.split("{quote}").length - 1;
  if (quotes > 0) {
    flushDescriptionBlock(state);
    if (quotes % 2 === 1) state.quoted = !state.quoted;
    return true;
  }
  if (state.quoted) return true;
  if (text.startsWith(">") || /^bq\.[ \t]/u.test(text)) {
    flushDescriptionBlock(state);
    state.quoteParagraph = true;
    return true;
  }
  return state.quoteParagraph;
}
function fencedDescriptionLine(
  state: DescriptionBlocks,
  line: string,
  syntax: "markdown" | "jira-wiki",
): boolean {
  if (state.fence !== undefined) {
    if (fenceCloses(state.fence, line)) state.fence = undefined;
    return true;
  }
  const opening = descriptionCodeFence(line, syntax);
  if (opening !== undefined || line.includes("{code") || line.includes("{noformat")) {
    flushDescriptionBlock(state);
    state.fence = opening;
    return true;
  }
  return false;
}
function indentedMarkdownContent(line: string, syntax: "markdown" | "jira-wiki"): boolean {
  return syntax === "markdown" && (line.startsWith("\t") || leadingSpaces(line) > 3);
}
function descriptionBulletContent(text: string): string | undefined {
  // Preserve the original single-line capture: Unicode line separators remain plain prose.
  if (text.includes("\u2028") || text.includes("\u2029")) return undefined;
  const prefix = /^(?:[*#]+[ \t]+|[-+][ \t]+|\d+[.)][ \t]+)/u.exec(text)?.[0];
  return prefix === undefined ? undefined : text.slice(prefix.length);
}
function descriptionContentLine(
  state: DescriptionBlocks,
  line: string,
  syntax: "markdown" | "jira-wiki",
): void {
  const text = line.trim();
  if (state.quoted) {
    quotedDescriptionLine(state, text);
    return;
  }
  if (fencedDescriptionLine(state, line, syntax)) return;
  if (text.length === 0) {
    flushDescriptionBlock(state);
    state.quoteParagraph = false;
    return;
  }
  if (quotedDescriptionLine(state, text)) return;
  if (indentedMarkdownContent(line, syntax)) {
    flushDescriptionBlock(state);
    return;
  }
  const bullet = descriptionBulletContent(text);
  if (bullet !== undefined) flushDescriptionBlock(state);
  state.paragraph.push(bullet ?? text);
}

/**
 * A description block without the trailing group of source labels Keiko writes for a model's `[n]`
 * evidence markers before review: ` (<document> · …; <document> · …)`. Every label must name one
 * of `documentNames` (alone or followed by ` · `); otherwise the block is returned unchanged, so a
 * qualifier such as ` (nur montags)` or a label of another document is never removed.
 */
export function withoutJiraSourceLabels(block: string, documentNames: readonly string[]): string {
  if (!block.endsWith(")")) return block;
  const named = (label: string): boolean =>
    documentNames.some(
      (name) => name.length > 0 && (label === name || label.startsWith(`${name} · `)),
    );
  for (let open = block.lastIndexOf(" ("); open > 0; open = block.lastIndexOf(" (", open - 1)) {
    const labels = block.slice(open + 2, -1).split("; ");
    if (labels.every((label) => named(label))) return block.slice(0, open);
  }
  return block;
}

/** Full active paragraphs/list items only; headings, quotes and code never prove source content. */
export function readJiraDescriptionBlocks(
  text: string,
  syntax: "markdown" | "jira-wiki" = "markdown",
): readonly string[] {
  const lines = text.slice(0, DESCRIPTION_CHARS_MAX).replace(/\r\n?/gu, "\n").split("\n");
  const reader = new SectionReader(syntax);
  reader.read(lines);
  const headings = new Map<number, HeadingSpan>();
  for (const heading of reader.headings)
    for (let index = heading.startLine; index < heading.endLine; index += 1)
      headings.set(index, heading);
  const state: DescriptionBlocks = {
    blocks: [],
    paragraph: [],
    fence: undefined,
    quoted: false,
    quoteParagraph: false,
  };
  for (const [index, line] of lines.entries()) {
    const heading = headings.get(index);
    if (heading !== undefined) {
      if (heading.syntax === "setext") state.paragraph = [];
      else flushDescriptionBlock(state);
    } else descriptionContentLine(state, line, syntax);
  }
  flushDescriptionBlock(state);
  return state.blocks;
}

export interface JiraDescriptionHeadingSerialization {
  readonly text: string;
  readonly convertedHeadingCount: number;
}

const MARKDOWN_DESCRIPTION_CHARS_MAX = 32768;
/**
 * Native Jira wiki strings stay unchanged. Markdown is explicit (`format: "markdown"`); a plain
 * string converts only when it uses constructs wiki markup never writes (`readsAsMarkdownOnly`).
 */
export const JIRA_DESCRIPTION_INPUT_SCHEMA = {
  description:
    'A string is native Jira wiki text: "h2. Title" is a heading, and a line starting with # or ## is a numbered list item, never a heading. A string is converted only when it uses Markdown-only syntax (**bold**, [text](url) or a code fence) and no wiki syntax. Send Markdown with # headings as {"format": "markdown", "text": "..."}; its headings, inline formatting, links, lists, tables and code blocks become Jira wiki markup.',
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
  if (typeof value === "string")
    return readsAsMarkdownOnly(value)
      ? serializeJiraMarkdownDescription(value)
      : { text: value, convertedHeadingCount: 0 };
  const markdown = readJiraMarkdownDescription(value);
  return markdown === undefined ? undefined : serializeJiraMarkdownDescription(markdown);
}

/**
 * Markdown as Data Center wiki markup: headings through the shared reader, then emphasis, links,
 * lists, quotes, tables and fences (#4173 AC2). An open fence keeps the heading-only result.
 */
export function serializeJiraMarkdownDescription(
  text: string,
): JiraDescriptionHeadingSerialization {
  const headings = serializeJiraDescriptionHeadings(text);
  if (text.length > DESCRIPTION_CHARS_MAX) return headings;
  const wiki = markdownBlocksToJiraWiki(headings.text);
  return wiki === undefined ? headings : { ...headings, text: wiki };
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
