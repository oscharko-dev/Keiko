import type {
  DraftBatchEntry,
  DraftBatchInstructions,
  WrittenDraftItem,
} from "./jiraDraftBatchPrompt.js";

// The Markdown description of one drafted issue. The model writes the sections; Keiko owns the
// layout, the acceptance criteria (verbatim, one line each) and the size: a description never
// exceeds what the staging contract accepts, and the criteria are never the part that is cut.

/** The one section an issue type without template sections is written into. */
export const FREE_SECTION = "description";

/**
 * The staged Markdown description limit is 32768 characters (the draft contract); Keiko stays
 * below it so the criteria list, headings and separators never meet the edge.
 */
export const DESCRIPTION_CHARS_MAX = 32_000;

/** Template section names that clearly mean "the acceptance criteria". */
const STRONG_CRITERIA_NAME = /akzeptanz|abnahme|acceptance|definition\s+of\s+done|\bdod\b/u;
/** A weaker hint, used only when no section carries a strong one. */
const WEAK_CRITERIA_NAME = /kriterien|kriterium/u;

export function sectionKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Collapses every run of whitespace, newlines included, to one space. */
export function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** The template section Keiko fills with the acceptance criteria, by the words the name contains. */
export function criteriaSectionOf(instructions: DraftBatchInstructions): string | undefined {
  const names = instructions.requiredSections;
  return (
    names.find((name) => STRONG_CRITERIA_NAME.test(name.toLowerCase())) ??
    names.find((name) => WEAK_CRITERIA_NAME.test(name.toLowerCase()))
  );
}

/** Each criterion as one line; one that is empty after redaction is not a criterion. */
export function entryCriteria(entry: DraftBatchEntry): readonly string[] {
  const lines = entry.requirements.flatMap((item) => (item.criteria ?? []).map(oneLine));
  return [...new Set(lines.filter((line) => line.length > 0))];
}

function bulletList(criteria: readonly string[]): string {
  return criteria.map((criterion) => `- ${criterion}`).join("\n");
}

const GERMAN_WORDS: ReadonlySet<string> = new Set([
  "der",
  "die",
  "das",
  "den",
  "dem",
  "und",
  "ist",
  "sind",
  "wird",
  "werden",
  "muss",
  "kann",
  "soll",
  "wenn",
  "dass",
  "bei",
  "auf",
  "nicht",
  "mit",
  "für",
  "von",
  "zu",
  "ein",
  "eine",
]);
const ENGLISH_WORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "is",
  "are",
  "shall",
  "must",
  "will",
  "not",
  "with",
  "for",
  "of",
  "a",
  "to",
  "be",
  "when",
]);
const SHORT_TEXT_WORDS = 25;

function languageOfRequirements(entry: DraftBatchEntry): "de" | "en" | undefined {
  const text = entry.requirements.map((item) => `${item.title} ${item.text}`).join(" ");
  const words = text.toLowerCase().split(/[^\p{L}]+/u);
  const umlauts = text.match(/[äöüßÄÖÜ]/gu)?.length ?? 0;
  const german = words.filter((word) => GERMAN_WORDS.has(word)).length + umlauts;
  const english = words.filter((word) => ENGLISH_WORDS.has(word)).length;
  const least = words.length < SHORT_TEXT_WORDS ? 1 : 3;
  if (german >= least && german >= 2 * english) return "de";
  return english >= least && english >= 2 * german ? "en" : undefined;
}

function languageOfGuidance(guidance: string | undefined): "de" | "en" | undefined {
  if (guidance === undefined) return undefined;
  const text = guidance.toLowerCase();
  const german = /\b(deutsch|german|auf deutsch|in german)\b/u.test(text);
  const english = /\b(englisch|english|auf englisch|in english)\b/u.test(text);
  if (german === english) return undefined;
  return german ? "de" : "en";
}

/**
 * The heading of the appended criteria block: the template's own criteria section when it has one,
 * else the language of the requirement texts, else the language the person asked for, else English.
 */
function criteriaHeading(entry: DraftBatchEntry, instructions: DraftBatchInstructions): string {
  const own = criteriaSectionOf(instructions);
  if (own !== undefined) return own;
  const language = languageOfRequirements(entry) ?? languageOfGuidance(instructions.guidance);
  return language === "de" ? "Akzeptanzkriterien" : "Acceptance criteria";
}

interface Block {
  readonly heading?: string;
  readonly body: string;
  /** Fixed blocks (the verbatim criteria) are never shortened. */
  readonly fixed: boolean;
}

function renderBlock(block: Block): string {
  return block.heading === undefined ? block.body : `## ${block.heading}\n\n${block.body}`;
}

function render(blocks: readonly Block[]): string {
  return blocks
    .filter((block) => block.heading !== undefined || block.body !== "")
    .map(renderBlock)
    .join("\n\n");
}

function sectionBody(item: WrittenDraftItem, name: string): string | undefined {
  return [...item.sections].find(([key]) => sectionKey(key) === sectionKey(name))?.[1];
}

function extraBlocks(item: WrittenDraftItem, taken: (name: string) => boolean): readonly Block[] {
  return [...item.sections]
    .filter(([name]) => !taken(name))
    .map(([name, body]) => ({ heading: name, body, fixed: false }));
}

function freeBlocks(item: WrittenDraftItem): readonly Block[] {
  const free = sectionBody(item, FREE_SECTION);
  return [
    ...(free === undefined ? [] : [{ body: free, fixed: false } as const]),
    ...extraBlocks(item, (name) => sectionKey(name) === FREE_SECTION),
  ];
}

function templateBlocks(
  item: WrittenDraftItem,
  names: readonly string[],
  owned: { readonly name: string; readonly criteria: readonly string[] } | undefined,
): readonly Block[] {
  const required = new Set(names.map(sectionKey));
  const ordered = names.map((name): Block =>
    owned?.name === name
      ? { heading: name, body: bulletList(owned.criteria), fixed: true }
      : { heading: name, body: sectionBody(item, name) ?? "", fixed: false },
  );
  return [...ordered, ...extraBlocks(item, (name) => required.has(sectionKey(name)))];
}

function sectionBlocks(
  item: WrittenDraftItem,
  names: readonly string[],
  name: string | undefined,
  criteria: readonly string[],
): readonly Block[] {
  if (names.length === 0) return freeBlocks(item);
  return templateBlocks(item, names, name === undefined ? undefined : { name, criteria });
}

function blocksFor(
  item: WrittenDraftItem,
  entry: DraftBatchEntry,
  instructions: DraftBatchInstructions,
): readonly Block[] {
  const criteria = entryCriteria(entry);
  const name = criteria.length > 0 ? criteriaSectionOf(instructions) : undefined;
  const names = instructions.requiredSections;
  const sections = sectionBlocks(item, names, name, criteria);
  const appended: readonly Block[] =
    criteria.length > 0 && name === undefined
      ? [
          {
            heading: criteriaHeading(entry, instructions),
            body: bulletList(criteria),
            fixed: true,
          },
        ]
      : [];
  return [...sections, ...appended];
}

function clipBody(body: string, max: number): string {
  return body.length <= max ? body : body.slice(0, max).trimEnd();
}

/** Shortens the model's text, never the fixed criteria, until the description fits. */
function fitBlocks(blocks: readonly Block[]): string {
  const full = render(blocks);
  if (full.length <= DESCRIPTION_CHARS_MAX) return full;
  const emptied = blocks.map((block) => (block.fixed ? block : { ...block, body: "" }));
  const shortenable = blocks.filter((block) => !block.fixed).length;
  const allowance = Math.max(0, DESCRIPTION_CHARS_MAX - render(emptied).length);
  const cap = shortenable === 0 ? 0 : Math.floor(allowance / shortenable);
  return render(
    blocks.map((block) => (block.fixed ? block : { ...block, body: clipBody(block.body, cap) })),
  );
}

/** The Markdown description of one planned issue, within the staging limit. */
export function describeItem(
  item: WrittenDraftItem,
  entry: DraftBatchEntry,
  instructions: DraftBatchInstructions,
): string {
  return fitBlocks(blocksFor(item, entry, instructions));
}

const EMPTY_ITEM: WrittenDraftItem = { summary: "", sections: new Map(), fields: {} };

/** False when the verbatim criteria and the template headings alone exceed the staging limit. */
export function criteriaFitDescription(
  entry: DraftBatchEntry,
  instructions: DraftBatchInstructions,
): boolean {
  return render(blocksFor(EMPTY_ITEM, entry, instructions)).length <= DESCRIPTION_CHARS_MAX;
}

// ─── Model text ──────────────────────────────────────────────────────────────

const LINE_BREAK_CHAR = /[\r\u2028\u2029]/u;
const HEADING_PREFIX = /^\s{0,3}#{1,6}\s+/u;
const FENCE_LINE = /^\s{0,3}(```|~~~)/u;

/** The text of an ATX heading line without its closing hashes, or undefined for any other line. */
function headingText(line: string): string | undefined {
  const prefix = HEADING_PREFIX.exec(line);
  if (prefix === null) return undefined;
  const rest = line.slice(prefix[0].length).trimEnd();
  let end = rest.length;
  while (end > 0 && rest[end - 1] === "#") end -= 1;
  const text = end === rest.length ? rest : rest.slice(0, end).trimEnd();
  return LINE_BREAK_CHAR.test(text) ? undefined : text;
}

/**
 * Keiko's own `##` headings are the only heading level of a description: a heading the model wrote
 * becomes a bold line, text inside a code fence is left alone.
 */
export function demoteHeadings(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (FENCE_LINE.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const heading = headingText(line);
      if (heading === undefined) return line;
      return heading === "" ? "" : `**${heading}**`;
    })
    .join("\n");
}
