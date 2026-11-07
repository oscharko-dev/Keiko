import { JIRA_REQUIREMENT_IDS_MAX } from "@oscharko-dev/keiko-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  criteriaSectionOf,
  demoteHeadings,
  describeItem,
  entryCriteria,
  FREE_SECTION,
  oneLine,
  sectionKey,
} from "./jiraDraftBatchDescription.js";

// The two model requests of a draft batch and the checks of their answers. The model writes only
// text: summaries, section texts and the grouping of requirement references. Keiko owns every
// identifier, every requirement reference of an issue, the description layout and the page size,
// so an answer can be wrong in wording but never silently drop or invent a requirement.

export interface DraftBatchRequirement {
  /** The model-facing reference `<documentScope>:<id>`. */
  readonly ref: string;
  readonly title: string;
  readonly section: string;
  /** Statement and acceptance criteria, already under the Chat content policy and clipped. */
  readonly text: string;
  /**
   * The acceptance criteria verbatim, under the Chat content policy and not clipped. The source
   * trace of a drafted issue requires each of them as a block of its description, so Keiko writes
   * them itself; the model is never asked to copy them.
   */
  readonly criteria?: readonly string[] | undefined;
}

/** One issue Keiko plans: its draft ref, a summary hint and the requirements it covers. */
export interface DraftBatchEntry {
  readonly ref: string;
  readonly hint: string;
  readonly requirements: readonly DraftBatchRequirement[];
}

export interface DraftBatchInstructions {
  /** How the person wants requirements grouped; absent for one issue per requirement. */
  readonly grouping?: string | undefined;
  /** Wording wishes from the conversation, such as language or tone. */
  readonly guidance?: string | undefined;
  /** The issue template's create rules as compact JSON. */
  readonly rules: string;
  readonly requiredSections: readonly string[];
  readonly requiredFields: readonly string[];
}

export interface DraftBatchMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

/** What the model wrote for one planned issue. */
export interface WrittenDraftItem {
  readonly summary: string;
  readonly sections: ReadonlyMap<string, string>;
  readonly fields: Readonly<Record<string, string>>;
}

export type ParsedPage =
  | { readonly ok: true; readonly items: ReadonlyMap<string, WrittenDraftItem> }
  | { readonly ok: false; readonly problems: readonly string[] };

const SUMMARY_CHARS_MAX = 255;
const SECTION_CHARS_MAX = 8000;
const PROBLEMS_LISTED_MAX = 12;

const OUTLINE_SYSTEM =
  'You group requirements into Jira issues. Answer with one JSON object only: {"groups":[{"summary":"...","requirements":["<reference>"]}]}. ' +
  `Put every listed requirement reference into exactly one group, at most ${String(JIRA_REQUIREMENT_IDS_MAX)} references per group, and copy references exactly as listed. ` +
  "Each summary names what the issue delivers and follows the summary rules. Write in the language of the requirements unless the instructions name another.";

const FILL_SYSTEM =
  'You write Jira issue drafts from requirements. Answer with one JSON object only: {"items":[{"key":"<key>","summary":"...","sections":{"<section>":"..."},"fields":{"<field>":"..."}}]}. ' +
  "Write exactly one item for every listed key and copy each key exactly. In sections, give every required section a substantive text in Markdown without headings. " +
  "In fields, give only the listed required fields as plain text. State only what the listed requirements support. Write in the language of the requirements unless the instructions name another.";

function instructionLines(instructions: DraftBatchInstructions): string {
  const lines = [`Template rules: ${instructions.rules}`];
  if (instructions.guidance !== undefined) lines.push(`Instructions: ${instructions.guidance}`);
  return lines.join("\n");
}

/** One requirement in the grouping request: reference, section and title on a single line. */
export function outlineLine(item: DraftBatchRequirement): string {
  return `${item.ref} | ${oneLine(item.section)} | ${oneLine(item.title)}`;
}

/** Lists requirements by reference and title only, so hundreds fit one grouping request. */
export function outlineMessages(
  requirements: readonly DraftBatchRequirement[],
  instructions: DraftBatchInstructions,
): readonly DraftBatchMessage[] {
  const listed = requirements.map(outlineLine);
  const grouping = instructions.grouping ?? "Group related requirements into coherent issues.";
  return [
    { role: "system", content: OUTLINE_SYSTEM },
    {
      role: "user",
      content: `Grouping: ${grouping}\n${instructionLines(instructions)}\n\nRequirements:\n${listed.join("\n")}`,
    },
  ];
}

/**
 * The sections the model writes for one issue. The template's acceptance-criteria section is
 * Keiko's when the issue's requirements carry criteria: it holds them verbatim, never a paraphrase.
 */
function modelSections(
  entry: DraftBatchEntry,
  instructions: DraftBatchInstructions,
): readonly string[] {
  const owned = entryCriteria(entry).length > 0 ? criteriaSectionOf(instructions) : undefined;
  return owned === undefined
    ? instructions.requiredSections
    : instructions.requiredSections.filter((name) => name !== owned);
}

/** Sections every issue of a page leaves to Keiko, so the shared instruction omits them. */
function pageSections(
  page: readonly DraftBatchEntry[],
  instructions: DraftBatchInstructions,
): readonly string[] {
  const owned = criteriaSectionOf(instructions);
  return owned !== undefined && page.some((entry) => entryCriteria(entry).length > 0)
    ? instructions.requiredSections.filter((name) => name !== owned)
    : instructions.requiredSections;
}

/** One planned issue as the fill prompt lists it; titles and hints stay on one line. */
export function entryBlock(
  entry: DraftBatchEntry,
  instructions: DraftBatchInstructions,
  shared: readonly string[],
): string {
  const extra = modelSections(entry, instructions).filter((name) => !shared.includes(name));
  const requirements = entry.requirements.map(
    (item) => `- ${item.ref}: ${oneLine(item.title)}\n  ${item.text.replaceAll("\n", "\n  ")}`,
  );
  const also = extra.length === 0 ? "" : `Also write the sections ${JSON.stringify(extra)}.\n`;
  return `### ${entry.ref}\nSummary hint: ${oneLine(entry.hint)}\n${also}Requirements:\n${requirements.join("\n")}`;
}

/** The characters of one issue's block in a page prompt, for sizing a page by the input window. */
export function entryPromptChars(
  entry: DraftBatchEntry,
  instructions: DraftBatchInstructions,
): number {
  return entryBlock(entry, instructions, pageSections([entry], instructions)).length + 2;
}

/** The characters of a fill prompt that do not depend on the page's issues. */
export function fillOverheadChars(instructions: DraftBatchInstructions): number {
  return fillMessages([], instructions).reduce((sum, message) => sum + message.content.length, 0);
}

/** One page of planned issues with their requirements; a correction repeats the same page. */
export function fillMessages(
  page: readonly DraftBatchEntry[],
  instructions: DraftBatchInstructions,
  correction?: string,
): readonly DraftBatchMessage[] {
  const shared = pageSections(page, instructions);
  const required = [
    instructions.requiredSections.length === 0
      ? `Required sections: none; write the issue text into sections.${FREE_SECTION}.`
      : `Required sections: ${JSON.stringify(shared)}`,
    `Required fields: ${JSON.stringify(instructions.requiredFields)}`,
  ].join("\n");
  const keys = page.map((entry) => entry.ref).join(", ");
  const messages: DraftBatchMessage[] = [
    { role: "system", content: FILL_SYSTEM },
    {
      role: "user",
      content: `${instructionLines(instructions)}\n${required}\nKeys: ${keys}\n\n${page.map((entry) => entryBlock(entry, instructions, shared)).join("\n\n")}`,
    },
  ];
  if (correction !== undefined)
    messages.push({
      role: "user",
      content: `Your previous answer for these keys was refused: ${correction} Write all keys again, corrected.`,
    });
  return messages;
}

const FENCED_BLOCK = /```[a-zA-Z]*\s*([\s\S]*?)```/gu;
const CANDIDATE_STARTS_MAX = 24;

/** The balanced top-level `{...}` spans of a text, tolerating braces inside JSON strings. */
function balancedObjects(text: string): readonly string[] {
  const found: string[] = [];
  let from = 0;
  for (let tries = 0; tries < CANDIDATE_STARTS_MAX; tries += 1) {
    const start = text.indexOf("{", from);
    if (start < 0) break;
    const end = closingBrace(text, start);
    if (end < 0) {
      from = start + 1;
      continue;
    }
    found.push(text.slice(start, end + 1));
    from = end + 1;
  }
  return found;
}

function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (inString) {
      if (char === "\\") at += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

function parsedObject(candidate: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    // A candidate that is not JSON is skipped; an answer without one is reported as a problem.
    return undefined;
  }
}

/**
 * The JSON object in an answer: a fenced block first, then every balanced object of the text; the
 * first one that parses and carries the expected key wins, so prose with braces or a second object
 * around the answer does not hide it.
 */
export function answerObject(
  text: string,
  expectedKey?: string,
): Record<string, unknown> | undefined {
  const fenced = [...text.matchAll(FENCED_BLOCK)].map((match) => match[1] ?? "");
  for (const source of [...fenced, text]) {
    for (const candidate of balancedObjects(source)) {
      const object = parsedObject(candidate);
      if (object !== undefined && (expectedKey === undefined || expectedKey in object))
        return object;
    }
  }
  return undefined;
}

function scalarText(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : undefined;
}

function listItems(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return (value as readonly unknown[])
    .map(scalarText)
    .map((item) => oneLine(item ?? "").replace(/^[-*\u2022]\s+/u, ""))
    .filter((item) => item.length > 0);
}

function clipped(text: string | undefined, max: number): string | undefined {
  return text === undefined || text.length === 0 ? undefined : text.slice(0, max);
}

/** One line of at most `max` characters, however the model spread it over lines. */
function summaryText(value: unknown): string | undefined {
  const list = listItems(value);
  return clipped(
    oneLine(list === undefined ? (scalarText(value) ?? "") : list.join(" ")),
    SUMMARY_CHARS_MAX,
  );
}

/** Section text: a list becomes bullets, and Keiko's `##` stays the only heading level. */
function sectionText(value: unknown): string | undefined {
  const list = listItems(value);
  const text = list === undefined ? scalarText(value) : list.map((item) => `- ${item}`).join("\n");
  return clipped(text === undefined ? undefined : demoteHeadings(text).trim(), SECTION_CHARS_MAX);
}

/** A field value as plain text: a list is joined by commas. */
function fieldText(value: unknown): string | undefined {
  const list = listItems(value);
  return clipped(list === undefined ? scalarText(value) : list.join(", "), SECTION_CHARS_MAX);
}

function writtenSections(value: unknown): ReadonlyMap<string, string> {
  const sections = new Map<string, string>();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return sections;
  for (const [name, body] of Object.entries(value as Record<string, unknown>)) {
    const text = sectionText(body);
    if (name.trim().length > 0 && text !== undefined) sections.set(name.trim(), text);
  }
  return sections;
}

function writtenFields(value: unknown, allowed: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fields;
  const record = value as Record<string, unknown>;
  for (const name of allowed) {
    const text = fieldText(record[name]);
    if (text !== undefined) fields[name] = text;
  }
  return fields;
}

function itemProblems(
  key: string,
  item: WrittenDraftItem,
  instructions: DraftBatchInstructions,
  sections: readonly string[],
): readonly string[] {
  const present = new Set([...item.sections.keys()].map(sectionKey));
  const wanted = instructions.requiredSections.length === 0 ? [FREE_SECTION] : sections;
  const missing = wanted.filter((name) => !present.has(sectionKey(name)));
  const fields = instructions.requiredFields.filter((name) => item.fields[name] === undefined);
  return [
    ...(missing.length === 0 ? [] : [`${key} lacks sections ${JSON.stringify(missing)}.`]),
    ...(fields.length === 0 ? [] : [`${key} lacks fields ${JSON.stringify(fields)}.`]),
  ];
}

function writtenItem(
  value: unknown,
  instructions: DraftBatchInstructions,
): WrittenDraftItem | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const summary = summaryText(record.summary);
  if (summary === undefined) return undefined;
  return {
    summary,
    sections: writtenSections(record.sections),
    fields: writtenFields(record.fields, instructions.requiredFields),
  };
}

function listedItems(answer: Record<string, unknown> | undefined): readonly unknown[] | undefined {
  const items = answer?.items;
  return Array.isArray(items) ? (items as readonly unknown[]) : undefined;
}

function listedKey(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { key } = raw as { key?: unknown };
  return typeof key === "string" ? key : undefined;
}

function readItems(
  listed: readonly unknown[],
  wanted: ReadonlyMap<string, DraftBatchEntry>,
  instructions: DraftBatchInstructions,
): { items: Map<string, WrittenDraftItem>; problems: string[] } {
  const items = new Map<string, WrittenDraftItem>();
  const problems: string[] = [];
  for (const raw of listed) {
    const key = listedKey(raw);
    const entry = key === undefined ? undefined : wanted.get(key);
    if (key === undefined || entry === undefined || items.has(key)) continue;
    const item = writtenItem(raw, instructions);
    if (item === undefined) continue;
    items.set(key, item);
    problems.push(...itemProblems(key, item, instructions, modelSections(entry, instructions)));
  }
  return { items, problems };
}

/** The written item of every planned key, or what to correct; keys outside the page are ignored. */
export function parsePage(
  text: string,
  page: readonly DraftBatchEntry[],
  instructions: DraftBatchInstructions,
): ParsedPage {
  const listed = listedItems(answerObject(text, "items"));
  if (listed === undefined)
    return { ok: false, problems: ['Answer with one JSON object {"items":[...]}.'] };
  const { items, problems } = readItems(
    listed,
    new Map(page.map((entry) => [entry.ref, entry])),
    instructions,
  );
  const missing = page.filter((entry) => !items.has(entry.ref)).map((entry) => entry.ref);
  if (missing.length > 0) problems.push(`Missing keys or summaries: ${missing.join(", ")}.`);
  return problems.length === 0
    ? { ok: true, items }
    : { ok: false, problems: problems.slice(0, PROBLEMS_LISTED_MAX) };
}

/**
 * The requirement groups of an outline answer; unknown and repeated references are dropped. A
 * group keeps at most as many references as one issue may trace; the rest stay unassigned, so the
 * batch plans them again instead of staging an issue Jira's draft contract refuses.
 */
export function parseOutline(
  text: string,
  requirements: readonly DraftBatchRequirement[],
): readonly { readonly summary: string; readonly refs: readonly string[] }[] {
  const groups = answerObject(text, "groups")?.groups;
  if (!Array.isArray(groups)) return [];
  const known = new Set(requirements.map((item) => item.ref));
  const assigned = new Set<string>();
  const parsed: { summary: string; refs: string[] }[] = [];
  for (const group of groups as readonly unknown[]) {
    const record = (typeof group === "object" && group !== null ? group : {}) as Record<
      string,
      unknown
    >;
    const summary = summaryText(record.summary);
    const listed = Array.isArray(record.requirements) ? (record.requirements as unknown[]) : [];
    const refs = [
      ...new Set(
        listed.filter(
          (ref): ref is string => typeof ref === "string" && known.has(ref) && !assigned.has(ref),
        ),
      ),
    ].slice(0, JIRA_REQUIREMENT_IDS_MAX);
    refs.forEach((ref) => assigned.add(ref));
    if (summary !== undefined && refs.length > 0) parsed.push({ summary, refs });
  }
  return parsed;
}

export interface DraftItemPlacement {
  readonly projectId: string;
  readonly issueTypeId: string;
  readonly requiredLabels: readonly string[];
  readonly parent?: CatalogJsonObject | undefined;
}

/** The staged jira.draft item of one planned issue; Keiko sets every reference itself. */
export function draftItem(
  entry: DraftBatchEntry,
  item: WrittenDraftItem,
  instructions: DraftBatchInstructions,
  placement: DraftItemPlacement,
): CatalogJsonObject {
  const fields: CatalogJsonObject = {
    ...item.fields,
    summary: item.summary,
    description: {
      format: "markdown",
      text: describeItem(item, entry, instructions),
    },
    ...(placement.requiredLabels.length === 0 ? {} : { labels: [...placement.requiredLabels] }),
  };
  return {
    ref: entry.ref,
    projectId: placement.projectId,
    issueTypeId: placement.issueTypeId,
    fields,
    requirementIds: entry.requirements.map((requirement) => requirement.ref),
    ...(placement.parent === undefined ? {} : { parent: placement.parent }),
  };
}
