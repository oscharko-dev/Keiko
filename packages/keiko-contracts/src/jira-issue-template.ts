/**
 * Customer-defined Jira issue templates (#4177, ADR-0128 D4).
 *
 * A template is a Markdown document with a small strict front matter. It is stored as an ordinary
 * private Markdown skill, so import, revisions, export and deletion reuse the skill library. The
 * front matter names the Jira project, issue type and workflow points the template governs; the
 * Markdown headings (`## Heading`) of its body are the description sections the issue must carry.
 * Parsing is deterministic and fails closed: any unknown key, malformed line or unsafe pattern
 * rejects the whole document. Errors carry closed codes, key names and line numbers, never text.
 */
import { readJiraDescriptionSections } from "./jira-description-sections.js";
import {
  JIRA_TEMPLATE_PATTERN_CHARS_MAX,
  jiraTemplatePatternIssue,
} from "./jira-template-pattern.js";
import { portableSha256Hex } from "./sha256-portable.js";

export {
  compileJiraTemplatePattern,
  jiraTemplatePatternIssue,
  type JiraTemplatePatternMatcher,
} from "./jira-template-pattern.js";

export const JIRA_ISSUE_TEMPLATE_MARKER = "jira-issue-template";
export const JIRA_ISSUE_TEMPLATE_VERSION = 1;

export const JIRA_ISSUE_TEMPLATE_LIMITS = Object.freeze({
  keyChars: 128,
  textChars: 120,
  labelChars: 255,
  patternChars: JIRA_TEMPLATE_PATTERN_CHARS_MAX,
  listItems: 50,
  activations: 20,
  sections: 50,
  summaryChars: 255,
  errors: 20,
});

export type JiraTemplateActivation =
  | { readonly kind: "create" }
  | { readonly kind: "edit" }
  /** No target: every transition. A target matches a transition name, id or target status name. */
  | { readonly kind: "transition"; readonly target?: string };

/**
 * A plain activation (`create` or `edit`, whichever the file says) makes a template govern creating
 * and editing the issues of its project and issue type; the word only chooses the era the file was
 * written for (#4354). A `transition:<target>` activation adds rules when an issue enters that
 * status and does not make a template govern creation or editing by itself.
 */
export function jiraTemplateGovernsWrites(template: {
  readonly activations: readonly JiraTemplateActivation[];
}): boolean {
  return template.activations.some((activation) => activation.kind !== "transition");
}

/**
 * The ids a template's typed names resolve to, written by the product (never typed by a person) when
 * the template is checked against a Jira: the issue type's id and the allowed parent types' ids. A
 * name is localized per user and an id is not, so a bound template governs by id in every profile
 * language (#4354). The digest says what the ids were resolved from: the Jira (its identity) and the
 * typed names. A binding is in force only while both are still what they were; an edited name, a
 * hand-written id or another Jira leaves it unconfirmed and the template is matched by name.
 */
/** What a binding resolved the template's typed names to. `none` marks a name that did not resolve. */
export interface JiraTemplateBindingIds {
  readonly issueTypeId: string;
  /** Native ids of the allowed parent types, one per typed parent type. */
  readonly parentIssueTypeIds?: readonly string[];
  /** Field ids, one per typed `requiredFields` entry. */
  readonly requiredFieldIds?: readonly string[];
  /** The id of the typed `parentField`. */
  readonly parentFieldId?: string;
  /** Status ids, one per `transition:<target>` activation that has a target. */
  readonly transitionStatusIds?: readonly string[];
}
export interface JiraTemplateBinding extends JiraTemplateBindingIds {
  /** Digest over the Jira's identity, the typed names and these ids; see `jiraTemplateBindingDigest`. */
  readonly digest: string;
}
/** The word a binding writes where a typed name did not resolve to an id: that entry is matched by name. */
export const JIRA_BINDING_UNRESOLVED = "none";
const BINDING_DIGEST = /^[a-f0-9]{32}$/u;
const NATIVE_ID_SHAPE = /^[1-9]\d{0,18}$/u;
const NATIVE_ID_MAX = 9223372036854775807n;
/** The longest a native Jira id is written: the 19 digits of a signed 64-bit integer. */
export const JIRA_NATIVE_ID_CHARS_MAX = 19;
/**
 * Jira's native ids (issue types, statuses, projects) are string int64 values, exact beyond
 * JavaScript's safe integer range. THE one rule: the options read, the save check, the binding
 * grammar and the server routes all ask here, so an id one of them offers is an id the others keep.
 */
export function isJiraNativeId(value: unknown): value is string {
  return typeof value === "string" && NATIVE_ID_SHAPE.test(value) && BigInt(value) <= NATIVE_ID_MAX;
}
const FIELD_ID = /^(?:[a-zA-Z][a-zA-Z0-9]{0,63}|customfield_\d{1,16})$/u;
const isTypeId = (value: string): boolean => isJiraNativeId(value);
const isStatusId = (value: string): boolean =>
  value === JIRA_BINDING_UNRESOLVED || isJiraNativeId(value);
const isFieldId = (value: string): boolean => FIELD_ID.test(value);

export interface JiraIssueTemplate {
  /** Upper-cased Jira project key. */
  readonly project: string;
  /** Issue type name (case-insensitive) or numeric issue type id: the label of a bound template. */
  readonly issueType: string;
  /** Present only for a template bound to the Jira it is read for (see `jiraTemplateForInstance`). */
  readonly binding?: JiraTemplateBinding;
  readonly activations: readonly JiraTemplateActivation[];
  readonly summary: {
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: string;
  };
  /** Field ids or names, resolved against the instance's field catalog. */
  readonly requiredFields: readonly string[];
  /** Description sections (Markdown H2 headings of the template body), in document order. */
  readonly requiredSections: readonly string[];
  readonly labels: {
    readonly required: readonly string[];
    readonly pattern?: string;
    readonly minCount?: number;
  };
  readonly parent: {
    readonly field?: string;
    readonly link?: string;
    /** Allowed native parent issue-type names or IDs; requires an explicit parent field. */
    readonly issueTypes?: readonly string[];
  };
}

export const JIRA_TEMPLATE_PARSE_ERROR_CODES = [
  "not-a-template",
  "front-matter-unterminated",
  "malformed-line",
  "unknown-key",
  "duplicate-key",
  "missing-key",
  "invalid-value",
  "limit-exceeded",
  "unsafe-pattern",
  "no-rules",
] as const;
export type JiraTemplateParseErrorCode = (typeof JIRA_TEMPLATE_PARSE_ERROR_CODES)[number];

export interface JiraTemplateParseError {
  readonly code: JiraTemplateParseErrorCode;
  readonly key?: string;
  readonly line?: number;
}

export type JiraIssueTemplateParseResult =
  | { readonly ok: true; readonly template: JiraIssueTemplate }
  | { readonly ok: false; readonly errors: readonly JiraTemplateParseError[] };

/** Closed rule vocabulary of a violation. The checker output is also the compliance evidence. */
export const JIRA_TEMPLATE_RULE_IDS = [
  "summary-too-short",
  "summary-too-long",
  "summary-pattern",
  "section-missing",
  "section-empty",
  "field-missing",
  "field-unavailable",
  "label-missing",
  "label-pattern",
  "label-count",
  "parent-missing",
  "parent-type-mismatch",
  "template-unreadable",
  /** No template of this project and issue type exists: a creation is refused, nothing is sent. */
  "template-missing",
  /** Templates of this project and issue type exist, but only for entering a status: none governs a creation. */
  "template-not-activated",
  /**
   * A template of this project that governs writes names an issue type this Jira does not know in the
   * acting user's view (a name in another profile language, or an id that no longer exists): it may
   * govern this write, so the write is refused instead of passing unchecked (#4354).
   */
  "template-binding-unresolved",
] as const;
export type JiraTemplateRuleId = (typeof JIRA_TEMPLATE_RULE_IDS)[number];

/**
 * What the template gate recorded about a decision it took on less than the full picture and let the
 * write go on with (#4354). Closed words for the Activity Log; never a rule shown to the person.
 */
export const JIRA_TEMPLATE_GATE_FACTS = [
  /** Jira's project read did not list the project's issue types (or listed more than the bound), so no template could be shown unresolved. */
  "type-list-unavailable",
  /** Jira's project statuses read gave no list, so no transition rule could be shown unresolved. */
  "status-list-unavailable",
] as const;
export type JiraTemplateGateFact = (typeof JIRA_TEMPLATE_GATE_FACTS)[number];

/** Body-free counts use only the checker's closed rule vocabulary, never its subjects or text. */
export function countJiraTemplateViolations(
  violations: readonly { readonly ruleId: JiraTemplateRuleId }[],
): Partial<Record<JiraTemplateRuleId, number>> {
  const counts: Partial<Record<JiraTemplateRuleId, number>> = {};
  for (const ruleId of JIRA_TEMPLATE_RULE_IDS) {
    const count = violations.filter((violation) => violation.ruleId === ruleId).length;
    if (count > 0) counts[ruleId] = count;
  }
  return counts;
}

export interface JiraTemplateViolation {
  readonly ruleId: JiraTemplateRuleId;
  /** The field, section, label or template element the rule names; bounded, never a body. */
  readonly subject: string;
  /** `PROJECT/Issue type` of the template that raised it. */
  readonly template: string;
}

/** What a template check yields for the model: bounded, closed ids plus short names. */
export const JIRA_TEMPLATE_VIOLATIONS_MAX = 25;

const KEYS = [
  "keiko",
  "version",
  "project",
  "issueType",
  "activateOn",
  "summaryMinLength",
  "summaryMaxLength",
  "summaryPattern",
  "requiredFields",
  "requiredLabels",
  "labelPattern",
  "minLabels",
  "parentField",
  "parentLink",
  "parentIssueTypes",
  "optionalSections",
  "issueTypeId",
  "parentIssueTypeIds",
  "requiredFieldIds",
  "parentFieldId",
  "transitionStatusIds",
  "jiraBinding",
] as const;
type TemplateKey = (typeof KEYS)[number];
const KEY_SET: ReadonlySet<string> = new Set(KEYS);

interface RawEntry {
  readonly key: string;
  /** Grown in place while a block list is scanned: copying it per item made a long list quadratic. */
  readonly values: string[];
  readonly list: boolean;
  /** `[a, b]` form; a block list (`key:` then `- item` lines) is open for further items. */
  readonly inline?: boolean;
  readonly line: number;
}
type FrontMatter =
  | { readonly kind: "none" }
  | { readonly kind: "open" }
  | { readonly kind: "found"; readonly lines: readonly string[]; readonly bodyStart: number };

function splitDocument(markdown: string): readonly string[] {
  return markdown.replace(/\r\n?/gu, "\n").split("\n");
}

function frontMatterOf(lines: readonly string[]): FrontMatter {
  if (lines[0]?.trimEnd() !== "---") return { kind: "none" };
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trimEnd() === "---") {
      return { kind: "found", lines: lines.slice(1, index), bodyStart: index + 1 };
    }
  }
  return { kind: "open" };
}

const MARKER_LINE = /^keiko\s*:\s*"?jira-issue-template"?\s*$/u;
const MARKER_LINE_CHARS_MAX = 200;

function isMarkerLine(line: string): boolean {
  const text = line.trim();
  return text.length <= MARKER_LINE_CHARS_MAX && MARKER_LINE.test(text);
}

/**
 * True when the document declares itself a Jira issue template (valid or not). This is the one
 * predicate: the library listing, enforcement and the upload check all decide by it, and the
 * storage prefilter is only ever a superset of it.
 */
export function isJiraIssueTemplateDocument(markdown: string): boolean {
  const front = frontMatterOf(splitDocument(markdown));
  if (front.kind === "none") return false;
  const lines = front.kind === "found" ? front.lines : splitDocument(markdown).slice(1);
  return lines.some(isMarkerLine);
}

/**
 * True when the document carries the template marker line outside fenced code, wherever it sits.
 * A document that does but is not `isJiraIssueTemplateDocument` (a leading blank line before the
 * front matter, a second block) was meant as a template and would silently enforce nothing.
 */
export function mentionsJiraIssueTemplateMarker(markdown: string): boolean {
  let fenced = false;
  for (const line of splitDocument(markdown)) {
    const text = line.trimStart();
    if (text.startsWith("```") || text.startsWith("~~~")) fenced = !fenced;
    else if (!fenced && isMarkerLine(line)) return true;
  }
  return false;
}

const QUOTED = /^"(?:[^"\\\p{Cc}]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"$/u;

function unquote(raw: string): string | undefined {
  const value = raw.trim();
  if (!value.startsWith('"')) return value.includes('"') ? undefined : value;
  // Only a well-formed JSON string literal reaches the decoder, so it cannot throw.
  return QUOTED.test(value) ? (JSON.parse(value) as string) : undefined;
}

const INLINE_ITEM = /(?:"(?:[^"\\]|\\.)*"|[^,"])+/gu;

function inlineItems(raw: string): readonly string[] | undefined {
  const inner = raw.trim().slice(1, -1);
  if (inner.trim().length === 0) return [];
  const items = inner.match(INLINE_ITEM) ?? [];
  // Rejoining must reproduce the text: an empty item or an unbalanced quote does not.
  if (items.join(",") !== inner) return undefined;
  const values = items.map((item) => unquote(item));
  return values.every((value): value is string => value !== undefined && value.length > 0)
    ? values
    : undefined;
}

interface Scan {
  readonly entries: RawEntry[];
  readonly errors: JiraTemplateParseError[];
}

function entryFor(key: string, raw: string, line: number): RawEntry | undefined {
  if (raw.startsWith("[")) {
    const items = raw.endsWith("]") ? inlineItems(raw) : undefined;
    return items === undefined
      ? undefined
      : { key, values: [...items], list: true, inline: true, line };
  }
  if (raw.length === 0) return { key, values: [], list: true, line };
  const value = unquote(raw);
  return value === undefined || value.length === 0
    ? undefined
    : { key, values: [value], list: false, line };
}

interface KeyedLine {
  readonly key: string;
  readonly value: string;
}
const KEY_NAME = /^[A-Za-z][A-Za-z0-9]*$/u;

/** `key: value`, with the value separated by a blank; no backtracking expression. */
function keyedLine(text: string): KeyedLine | undefined {
  const colon = text.indexOf(":");
  if (colon < 0) return undefined;
  const key = text.slice(0, colon).trimEnd();
  const rest = text.slice(colon + 1);
  if (!KEY_NAME.test(key) || (rest.length > 0 && !/^\s/u.test(rest))) return undefined;
  return { key, value: rest.trim() };
}

function addKeyedLine(scan: Scan, text: string, line: number): void {
  const match = keyedLine(text);
  if (match === undefined) {
    scan.errors.push({ code: "malformed-line", line });
    return;
  }
  const { key } = match;
  if (!KEY_SET.has(key)) {
    scan.errors.push({ code: "unknown-key", key, line });
  } else if (scan.entries.some((entry) => entry.key === key)) {
    scan.errors.push({ code: "duplicate-key", key, line });
  } else {
    const entry = entryFor(key, match.value, line);
    if (entry === undefined) scan.errors.push({ code: "invalid-value", key, line });
    else scan.entries.push(entry);
  }
}

function addBlockItem(scan: Scan, text: string, line: number): void {
  const last = scan.entries.at(-1);
  const value = unquote(text.slice(1));
  if (
    last === undefined ||
    !last.list ||
    last.inline === true ||
    value === undefined ||
    value.length === 0
  ) {
    scan.errors.push({ code: "malformed-line", line });
    return;
  }
  last.values.push(value);
}

function isBlockItem(text: string): boolean {
  return text.startsWith("-") && (text.length === 1 || /\s/u.test(text.charAt(1)));
}

function scanFrontMatter(lines: readonly string[]): Scan {
  const scan: Scan = { entries: [], errors: [] };
  lines.forEach((source, offset) => {
    const text = source.trim();
    if (text.length === 0 || text.startsWith("#")) return;
    if (isBlockItem(text)) {
      addBlockItem(scan, text, offset + 2);
    } else {
      addKeyedLine(scan, text, offset + 2);
    }
  });
  return scan;
}

function entryOf(entries: readonly RawEntry[], key: TemplateKey): RawEntry | undefined {
  return entries.find((entry) => entry.key === key);
}

/** The guided editor may hold an incomplete draft while the person selects its project and type. */
export interface JiraTemplateForm {
  readonly project: string;
  readonly issueType: string;
  readonly activateOn: readonly string[];
  readonly requiredFields: readonly string[];
}

function isEmptyFormSelection(line: string): boolean {
  const entry = keyedLine(line.trim());
  return (entry?.key === "project" || entry?.key === "issueType") && entry.value === '""';
}

/** Reads editable values using the template grammar, before the document is complete enough to save. */
export function readJiraTemplateForm(frontMatter: string): JiraTemplateForm | undefined {
  // The strict save parser rejects empty selections. In the form they are empty slots. The same
  // line splitting as the strict parser, so a bare carriage return ends a line here too.
  const lines = splitDocument(frontMatter).map((line) =>
    isEmptyFormSelection(line) ? line.trimEnd().slice(0, -2) + "[]" : line,
  );
  if (!lines.some(isMarkerLine)) return undefined;
  const { entries, errors } = scanFrontMatter(lines);
  if (errors.length > 0) return undefined;
  const values = (key: TemplateKey): readonly string[] => entryOf(entries, key)?.values ?? [];
  return {
    project: values("project")[0] ?? "",
    issueType: values("issueType")[0] ?? "",
    activateOn: values("activateOn"),
    requiredFields: values("requiredFields"),
  };
}

/** The lines a binding writes. A form edit that changes what a binding was resolved from removes all of them. */
const BINDING_KEYS: readonly TemplateKey[] = [
  "issueTypeId",
  "parentIssueTypeIds",
  "requiredFieldIds",
  "parentFieldId",
  "transitionStatusIds",
  "jiraBinding",
];

const TRANSITION_PREFIX = "transition:";

/** The typed targets of `transition:<target>` entries, in order; a bare `transition` has none. */
function formTransitionTargets(activateOn: readonly string[]): readonly string[] {
  return activateOn.flatMap((value) =>
    value.startsWith(TRANSITION_PREFIX) ? [value.slice(TRANSITION_PREFIX.length).trim()] : [],
  );
}

/** Whether the patch changes the project or the issue type the binding's ids were resolved for. */
function movesBindingTarget(
  current: JiraTemplateForm | undefined,
  patch: Partial<JiraTemplateForm>,
): boolean {
  return (
    current === undefined ||
    (patch.project !== undefined && patch.project !== current.project) ||
    (patch.issueType !== undefined && patch.issueType !== current.issueType)
  );
}

/** One id per entry of `next`: the id the entry had in `before`, else unresolved. */
function realignedIds(
  before: readonly string[],
  ids: readonly string[],
  next: readonly string[],
): readonly string[] {
  return next.map(
    (entry) => ids[before.findIndex((typed) => sameName(typed, entry))] ?? JIRA_BINDING_UNRESOLVED,
  );
}

function idListLine(key: string, ids: readonly string[]): string | undefined {
  return ids.length === 0 ? undefined : `${key}: ${JSON.stringify(ids)}`;
}

/**
 * The id lists of a binding the caller did not re-resolve, kept one for one with the edited rules: an
 * entry the edit leaves alone keeps its id, a new one is unresolved. The digest stays as written, so the
 * binding is unconfirmed until the next check binds afresh; it can never name another field or status.
 */
function realignedBindingLines(
  frontMatter: string,
  current: JiraTemplateForm,
  patch: Partial<JiraTemplateForm>,
): Map<string, string | undefined> {
  const updates = new Map<string, string | undefined>();
  const entries = scanFrontMatter(splitDocument(frontMatter)).entries;
  const fields = entryOf(entries, "requiredFieldIds")?.values;
  if (patch.requiredFields !== undefined && fields !== undefined) {
    const next = [...new Set(patch.requiredFields)];
    updates.set(
      "requiredFieldIds",
      idListLine("requiredFieldIds", realignedIds(current.requiredFields, fields, next)),
    );
  }
  const statuses = entryOf(entries, "transitionStatusIds")?.values;
  if (patch.activateOn !== undefined && statuses !== undefined) {
    const before = formTransitionTargets(current.activateOn);
    const next = formTransitionTargets(patch.activateOn);
    updates.set(
      "transitionStatusIds",
      idListLine("transitionStatusIds", realignedIds(before, statuses, next)),
    );
  }
  return updates;
}

function bindingUpdateLines(binding: JiraTemplateBinding): Map<string, string | undefined> {
  const written = new Map<string, string>(
    bindingText(binding).map((line) => [line.slice(0, line.indexOf(":")), line]),
  );
  return new Map(BINDING_KEYS.map((key) => [key, written.get(key)]));
}

function formUpdateLines(
  frontMatter: string,
  patch: Partial<JiraTemplateForm>,
  binding: JiraTemplateBinding | undefined,
): Map<string, string | undefined> {
  const updates = new Map<string, string | undefined>(
    Object.entries(patch).map(([key, value]) => [key, `${key}: ${JSON.stringify(value)}`]),
  );
  // The caller re-resolved the binding for the edited rules: its lines replace the old ones.
  if (binding !== undefined) {
    for (const [key, line] of bindingUpdateLines(binding)) updates.set(key, line);
    return updates;
  }
  const current = readJiraTemplateForm(frontMatter);
  // Ids resolved for another project or type are no one's binding; the next check binds afresh.
  if (current === undefined || movesBindingTarget(current, patch)) {
    for (const key of BINDING_KEYS) updates.set(key, undefined);
    return updates;
  }
  for (const [key, line] of realignedBindingLines(frontMatter, current, patch))
    updates.set(key, line);
  return updates;
}

/**
 * Update only fields edited in the form. Unrelated rules, comments, line endings and their order are
 * preserved. `binding` is the binding re-resolved for the edited rules (see
 * `rebindJiraTemplateAfterEdit`). Without it, an edit of the project or issue type removes the binding
 * lines, and an edit of the rules keeps them aligned with the rules (see `realignedBindingLines`).
 */
export function editJiraTemplateForm(
  frontMatter: string,
  patch: Partial<JiraTemplateForm>,
  binding?: JiraTemplateBinding,
): string {
  const updates = formUpdateLines(frontMatter, patch, binding);
  const state: RewriteState = { kept: [], replacingList: false };
  const { lines, tail } = splitTrailingEmpty(textLines(frontMatter));
  for (const entry of lines) rewriteLine(entry, updates, state);
  const ending = /\r\n|\n|\r/u.exec(frontMatter)?.[0] ?? "\n";
  for (const line of updates.values()) if (line !== undefined) state.kept.push({ line, ending });
  if (tail !== undefined) state.kept.push(tail);
  const { kept } = state;
  return kept
    .map((entry, index) => entry.line + (index === kept.length - 1 ? "" : entry.ending || ending))
    .join("");
}

/**
 * A front matter that ends with a line ending splits into a final empty entry: new lines go before
 * it, so they follow the last line directly instead of after a blank one.
 */
function splitTrailingEmpty(entries: readonly TextLine[]): {
  readonly lines: readonly TextLine[];
  readonly tail?: TextLine;
} {
  const last = entries.at(-1);
  if (entries.length < 2 || last?.line !== "" || last.ending !== "") return { lines: entries };
  return { lines: entries.slice(0, -1), tail: last };
}

interface RewriteState {
  readonly kept: TextLine[];
  /** A block list whose key is being replaced: its items go with it. */
  replacingList: boolean;
}

/** Keeps, replaces or removes one line, with the line ending it carried. */
function rewriteLine(
  entry: TextLine,
  updates: Map<string, string | undefined>,
  state: RewriteState,
): void {
  const text = entry.line.trim();
  const keyed = keyedLine(text);
  if (keyed === undefined) {
    if (!state.replacingList || !isBlockItem(text)) state.kept.push(entry);
    return;
  }
  const updating = updates.has(keyed.key);
  state.replacingList = updating && keyed.value === "";
  const replacement = updating ? updates.get(keyed.key) : entry.line;
  if (replacement === undefined) return;
  state.kept.push({ line: replacement, ending: entry.ending });
  // A replacement is written once; a removal stays in force for every repeated key line.
  if (updating) updates.delete(keyed.key);
}

function boundedText(value: string, max: number): boolean {
  return value.length <= max && !/\p{Cc}/u.test(value);
}

class Reader {
  public readonly errors: JiraTemplateParseError[] = [];
  public constructor(private readonly entries: readonly RawEntry[]) {}

  public scalar(key: TemplateKey, max: number): string | undefined {
    const entry = entryOf(this.entries, key);
    if (entry === undefined) return undefined;
    const value = entry.values[0];
    if (entry.list || value === undefined || !boundedText(value, max)) {
      this.errors.push({ code: "invalid-value", key, line: entry.line });
      return undefined;
    }
    return value;
  }

  public integer(key: TemplateKey, min: number, max: number): number | undefined {
    const entry = entryOf(this.entries, key);
    if (entry === undefined) return undefined;
    const value = entry.values[0];
    if (entry.list || value === undefined || !/^\d{1,4}$/u.test(value)) {
      this.errors.push({ code: "invalid-value", key, line: entry.line });
      return undefined;
    }
    const parsed = Number(value);
    if (parsed < min || parsed > max) {
      this.errors.push({ code: "invalid-value", key, line: entry.line });
      return undefined;
    }
    return parsed;
  }

  public list(
    key: TemplateKey,
    max: number,
    itemChars: number,
    positional = false,
  ): readonly string[] {
    const entry = entryOf(this.entries, key);
    if (entry === undefined) return [];
    if (!entry.list) {
      this.errors.push({ code: "invalid-value", key, line: entry.line });
      return [];
    }
    if (entry.values.length > max) {
      this.errors.push({ code: "limit-exceeded", key, line: entry.line });
      return [];
    }
    if (!entry.values.every((value) => boundedText(value, itemChars))) {
      this.errors.push({ code: "invalid-value", key, line: entry.line });
      return [];
    }
    // A binding id list is positional: one id per typed name, so equal ids must stay in place.
    return positional ? [...entry.values] : [...new Set(entry.values)];
  }

  public pattern(key: TemplateKey): string | undefined {
    const value = this.scalar(key, JIRA_ISSUE_TEMPLATE_LIMITS.patternChars);
    if (value === undefined) return undefined;
    if (jiraTemplatePatternIssue(value) !== undefined) {
      this.errors.push({
        code: "unsafe-pattern",
        key,
        line: entryOf(this.entries, key)?.line ?? 0,
      });
      return undefined;
    }
    return value;
  }
}

function parseActivation(value: string): JiraTemplateActivation | undefined {
  if (value === "create" || value === "edit" || value === "transition") return { kind: value };
  if (!value.startsWith("transition:")) return undefined;
  const target = value.slice("transition:".length).trim();
  return target.length > 0 && boundedText(target, JIRA_ISSUE_TEMPLATE_LIMITS.textChars)
    ? { kind: "transition", target }
    : undefined;
}

function readActivations(reader: Reader): readonly JiraTemplateActivation[] {
  const values = reader.list("activateOn", JIRA_ISSUE_TEMPLATE_LIMITS.activations, 140);
  const parsed = values.map((value) => parseActivation(value));
  if (values.length === 0 || parsed.includes(undefined)) {
    reader.errors.push({ code: "invalid-value", key: "activateOn" });
    return [];
  }
  return parsed.filter((item): item is JiraTemplateActivation => item !== undefined);
}

/** Removes a trailing run of colons and blanks without a backtracking expression. */
function withoutTrailingColons(text: string): string {
  let end = text.length;
  while (end > 0 && (text.charAt(end - 1) === ":" || /\s/u.test(text.charAt(end - 1)))) end -= 1;
  return text.slice(0, end);
}

/** Normalised key shared by the template body and the description the checker reads. */
export function normalizeJiraSectionHeading(heading: string): string {
  const text = heading.replaceAll(/\\([\\*_+^~{}[\]!|#?.>-])/gu, "$1");
  return withoutTrailingColons(text.replace(/[*_`]/gu, ""))
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function bodySections(lines: readonly string[], optional: ReadonlySet<string>): readonly string[] {
  const sections: string[] = [];
  const seen = new Set<string>(optional);
  for (const heading of readJiraDescriptionSections(lines.join("\n"))) {
    if (heading.level !== 2) continue;
    const title = withoutTrailingColons(heading.title.replace(/[*_`]/gu, "")).trim();
    const key = normalizeJiraSectionHeading(title);
    if (title.length === 0 || seen.has(key)) continue;
    seen.add(key);
    sections.push(title);
  }
  return sections;
}

function distinctErrors(errors: readonly JiraTemplateParseError[]): JiraTemplateParseError[] {
  const seen = new Set<string>();
  return errors.filter((error) => {
    const id = `${error.code}|${error.key ?? ""}|${String(error.line ?? "")}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function requireKeys(entries: readonly RawEntry[], errors: JiraTemplateParseError[]): void {
  for (const key of ["keiko", "version", "project", "issueType", "activateOn"] as const) {
    if (entryOf(entries, key) === undefined) errors.push({ code: "missing-key", key });
  }
}

function readHeader(reader: Reader): { project: string; issueType: string } | undefined {
  const marker = reader.scalar("keiko", 64);
  const version = reader.scalar("version", 8);
  const project = reader.scalar("project", JIRA_ISSUE_TEMPLATE_LIMITS.keyChars);
  const issueType = reader.scalar("issueType", JIRA_ISSUE_TEMPLATE_LIMITS.textChars);
  if (marker !== undefined && marker !== JIRA_ISSUE_TEMPLATE_MARKER)
    reader.errors.push({ code: "invalid-value", key: "keiko" });
  if (version !== undefined && version !== String(JIRA_ISSUE_TEMPLATE_VERSION))
    reader.errors.push({ code: "invalid-value", key: "version" });
  if (project !== undefined && !/^[A-Za-z]\w*$/u.test(project))
    reader.errors.push({ code: "invalid-value", key: "project" });
  if (project === undefined || issueType === undefined) return undefined;
  return { project: project.toUpperCase(), issueType };
}

/** The typed names a binding was resolved from. */
interface TypedNames {
  readonly parentTypes: readonly string[] | undefined;
  readonly requiredFields: readonly string[];
  readonly parentField: string | undefined;
  readonly transitionTargets: readonly string[];
}

/** The targets of the `transition:<target>` activations, in the order the file lists them. */
export function jiraTemplateTransitionTargets(
  template: Pick<JiraIssueTemplate, "activations">,
): readonly string[] {
  return template.activations.flatMap((activation) =>
    activation.kind === "transition" && activation.target !== undefined ? [activation.target] : [],
  );
}

function typedNamesOf(
  template: Pick<JiraIssueTemplate, "activations" | "parent" | "requiredFields">,
): TypedNames {
  return {
    parentTypes: template.parent.issueTypes,
    requiredFields: template.requiredFields,
    parentField: template.parent.field,
    transitionTargets: jiraTemplateTransitionTargets(template),
  };
}

interface BindingValues {
  readonly issueTypeId: string | undefined;
  readonly digest: string | undefined;
  readonly parentIds: readonly string[] | undefined;
  readonly fieldIds: readonly string[] | undefined;
  readonly parentFieldId: string | undefined;
  readonly statusIds: readonly string[] | undefined;
}

const invalidScalar = (value: string | undefined, valid: (id: string) => boolean): boolean =>
  value !== undefined && !valid(value);
const invalidList = (
  values: readonly string[] | undefined,
  valid: (id: string) => boolean,
): boolean => values?.some((value) => !valid(value)) === true;

/** The binding keys written with a value that is no id or digest. A missing key is no binding, not an error. */
function invalidBindingKeys(found: BindingValues): readonly TemplateKey[] {
  const checks: readonly (readonly [TemplateKey, boolean])[] = [
    ["issueTypeId", invalidScalar(found.issueTypeId, isTypeId)],
    ["jiraBinding", invalidScalar(found.digest, (value) => BINDING_DIGEST.test(value))],
    ["parentIssueTypeIds", invalidList(found.parentIds, isTypeId)],
    ["requiredFieldIds", invalidList(found.fieldIds, isFieldId)],
    ["parentFieldId", invalidScalar(found.parentFieldId, isFieldId)],
    ["transitionStatusIds", invalidList(found.statusIds, isStatusId)],
  ];
  return checks.filter(([, wrong]) => wrong).map(([key]) => key);
}

/** One id per typed name, or none at all for a list the template does not type. */
function alignedWith(
  ids: readonly string[] | undefined,
  typed: readonly string[] | undefined,
): boolean {
  return (ids?.length ?? 0) === (typed?.length ?? 0);
}

/** Ids line up one for one with the typed names they claim to resolve, or the binding is nobody's. */
function lined(found: BindingValues, typed: TypedNames): boolean {
  return (
    alignedWith(found.parentIds, typed.parentTypes) &&
    alignedWith(found.fieldIds, typed.requiredFields) &&
    (found.parentFieldId === undefined) === (typed.parentField === undefined) &&
    alignedWith(found.statusIds, typed.transitionTargets)
  );
}

function readBindingValues(reader: Reader, entries: readonly RawEntry[]): BindingValues {
  const listOf = (key: TemplateKey, chars: number): readonly string[] | undefined => {
    const ids = reader.list(key, JIRA_ISSUE_TEMPLATE_LIMITS.listItems, chars, true);
    return entryOf(entries, key) === undefined ? undefined : ids;
  };
  return {
    issueTypeId: reader.scalar("issueTypeId", JIRA_NATIVE_ID_CHARS_MAX),
    digest: reader.scalar("jiraBinding", 32),
    parentIds: listOf("parentIssueTypeIds", JIRA_NATIVE_ID_CHARS_MAX),
    fieldIds: listOf("requiredFieldIds", 80),
    parentFieldId: reader.scalar("parentFieldId", 80),
    statusIds: listOf("transitionStatusIds", JIRA_NATIVE_ID_CHARS_MAX),
  };
}

const nonEmpty = (ids: readonly string[] | undefined): readonly string[] | undefined =>
  ids === undefined || ids.length === 0 ? undefined : ids;

function readBinding(
  reader: Reader,
  entries: readonly RawEntry[],
  typed: TypedNames,
): JiraTemplateBinding | undefined {
  const found = readBindingValues(reader, entries);
  for (const key of invalidBindingKeys(found))
    reader.errors.push({ code: "invalid-value", key, line: entryOf(entries, key)?.line ?? 0 });
  // Ids without the digest that says what they were resolved from are nobody's binding: the
  // template is matched by name (a hand-written id never governs by itself).
  const { issueTypeId, digest, parentFieldId } = found;
  if (issueTypeId === undefined || digest === undefined || !lined(found, typed)) return undefined;
  return {
    digest,
    issueTypeId,
    ...optionalIds({
      parentIssueTypeIds: nonEmpty(found.parentIds),
      requiredFieldIds: nonEmpty(found.fieldIds),
      parentFieldId,
      transitionStatusIds: nonEmpty(found.statusIds),
    }),
  };
}

/** Only the id entries a binding actually carries. */
function optionalIds(ids: {
  readonly parentIssueTypeIds: readonly string[] | undefined;
  readonly requiredFieldIds: readonly string[] | undefined;
  readonly parentFieldId: string | undefined;
  readonly transitionStatusIds: readonly string[] | undefined;
}): Partial<JiraTemplateBinding> {
  return {
    ...(ids.parentIssueTypeIds === undefined ? {} : { parentIssueTypeIds: ids.parentIssueTypeIds }),
    ...(ids.requiredFieldIds === undefined ? {} : { requiredFieldIds: ids.requiredFieldIds }),
    ...(ids.parentFieldId === undefined ? {} : { parentFieldId: ids.parentFieldId }),
    ...(ids.transitionStatusIds === undefined
      ? {}
      : { transitionStatusIds: ids.transitionStatusIds }),
  };
}

function readRequiredFields(reader: Reader): readonly string[] {
  return reader.list(
    "requiredFields",
    JIRA_ISSUE_TEMPLATE_LIMITS.listItems,
    JIRA_ISSUE_TEMPLATE_LIMITS.textChars,
  );
}

function readSummary(reader: Reader): JiraIssueTemplate["summary"] {
  const max = JIRA_ISSUE_TEMPLATE_LIMITS.summaryChars;
  const minLength = reader.integer("summaryMinLength", 1, max);
  const maxLength = reader.integer("summaryMaxLength", 1, max);
  const pattern = reader.pattern("summaryPattern");
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength)
    reader.errors.push({ code: "invalid-value", key: "summaryMaxLength" });
  return {
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(pattern === undefined ? {} : { pattern }),
  };
}

function readLabels(reader: Reader): JiraIssueTemplate["labels"] {
  const limits = JIRA_ISSUE_TEMPLATE_LIMITS;
  const required = reader.list("requiredLabels", limits.listItems, limits.labelChars);
  const pattern = reader.pattern("labelPattern");
  const minCount = reader.integer("minLabels", 1, limits.listItems);
  return {
    required,
    ...(pattern === undefined ? {} : { pattern }),
    ...(minCount === undefined ? {} : { minCount }),
  };
}

function hasRules(template: JiraIssueTemplate): boolean {
  const { summary, labels, parent } = template;
  return (
    Object.keys(summary).length > 0 ||
    template.requiredFields.length > 0 ||
    template.requiredSections.length > 0 ||
    labels.required.length > 0 ||
    labels.pattern !== undefined ||
    labels.minCount !== undefined ||
    parent.field !== undefined ||
    parent.link !== undefined
  );
}

function readParent(reader: Reader, entries: readonly RawEntry[]): JiraIssueTemplate["parent"] {
  const field = reader.scalar("parentField", JIRA_ISSUE_TEMPLATE_LIMITS.textChars);
  const link = reader.scalar("parentLink", JIRA_ISSUE_TEMPLATE_LIMITS.textChars);
  const entry = entryOf(entries, "parentIssueTypes");
  const issueTypes = reader.list(
    "parentIssueTypes",
    JIRA_ISSUE_TEMPLATE_LIMITS.listItems,
    JIRA_ISSUE_TEMPLATE_LIMITS.textChars,
  );
  if (
    entry !== undefined &&
    (field === undefined ||
      issueTypes.length === 0 ||
      issueTypes.some((type) => type.trim().length === 0))
  ) {
    reader.errors.push({ code: "invalid-value", key: "parentIssueTypes", line: entry.line });
  }
  return {
    ...(field === undefined ? {} : { field }),
    ...(link === undefined ? {} : { link }),
    ...(entry === undefined ? {} : { issueTypes }),
  };
}

/**
 * Strict, total parser. A document that is not a template yields `not-a-template`; a template
 * document that is malformed yields every error found (bounded), never a partial template.
 */
export function parseJiraIssueTemplate(markdown: string): JiraIssueTemplateParseResult {
  const lines = splitDocument(markdown);
  const front = frontMatterOf(lines);
  if (front.kind === "none" || !isJiraIssueTemplateDocument(markdown))
    return { ok: false, errors: [{ code: "not-a-template" }] };
  if (front.kind === "open") return { ok: false, errors: [{ code: "front-matter-unterminated" }] };
  const scan = scanFrontMatter(front.lines);
  const reader = new Reader(scan.entries);
  requireKeys(scan.entries, scan.errors);
  const header = readHeader(reader);
  const activations = readActivations(reader);
  const summary = readSummary(reader);
  const labels = readLabels(reader);
  const parent = readParent(reader, scan.entries);
  const requiredFields = readRequiredFields(reader);
  const binding = readBinding(
    reader,
    scan.entries,
    typedNamesOf({ activations, parent, requiredFields }),
  );
  const optional = reader.list(
    "optionalSections",
    JIRA_ISSUE_TEMPLATE_LIMITS.sections,
    JIRA_ISSUE_TEMPLATE_LIMITS.textChars,
  );
  const requiredSections = bodySections(
    lines.slice(front.bodyStart),
    new Set(optional.map(normalizeJiraSectionHeading)),
  );
  const errors = distinctErrors([...scan.errors, ...reader.errors]);
  if (requiredSections.length > JIRA_ISSUE_TEMPLATE_LIMITS.sections)
    errors.push({ code: "limit-exceeded" });
  if (errors.length === 0 && header !== undefined) {
    const template: JiraIssueTemplate = {
      ...header,
      activations,
      summary,
      requiredFields,
      requiredSections,
      labels,
      parent,
      ...(binding === undefined ? {} : { binding }),
    };
    if (hasRules(template)) return { ok: true, template };
    errors.push({ code: "no-rules" });
  }
  return { ok: false, errors: errors.slice(0, JIRA_ISSUE_TEMPLATE_LIMITS.errors) };
}

/** Body-free description of a parse failure: closed codes, key names and line numbers only. */
export function describeJiraTemplateParseErrors(errors: readonly JiraTemplateParseError[]): string {
  return errors
    .map((error) => {
      const key = error.key === undefined ? "" : ` (${error.key})`;
      const line = error.line === undefined ? "" : ` at line ${String(error.line)}`;
      return `${error.code}${key}${line}`;
    })
    .join("; ");
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * THE issue-type matcher: every place that decides whether a template governs, validates or is
 * offered for an issue type asks here. A bound template governs by id alone; a template without a
 * binding (an older file, or one bound for another Jira) matches the typed name in the language it
 * was written in, or a typed id.
 */
export function jiraTemplateIssueTypeMatches(
  template: Pick<JiraIssueTemplate, "issueType" | "binding">,
  type: { readonly id?: string | undefined; readonly name: string },
): boolean {
  if (template.binding !== undefined) return type.id === template.binding.issueTypeId;
  return (
    sameName(type.name, template.issueType) ||
    (type.id !== undefined && type.id === template.issueType)
  );
}

/**
 * Whether two templates of one project govern the same issue type, by the one rule: two bound templates
 * by the id they were bound to, any other pair by the typed name. The template list and the gate use
 * this, so they cannot disagree about which templates share a type (#4354).
 */
export function jiraTemplatesShareIssueType(
  left: Pick<JiraIssueTemplate, "project" | "issueType" | "binding">,
  right: Pick<JiraIssueTemplate, "project" | "issueType" | "binding">,
): boolean {
  if (!sameName(left.project, right.project)) return false;
  return left.binding !== undefined && right.binding !== undefined
    ? left.binding.issueTypeId === right.binding.issueTypeId
    : sameName(left.issueType, right.issueType);
}

/**
 * The same rule for ONE parent type the template allows, by its position in `parentIssueTypes`: a bound
 * template compares the id it was bound to at that position, any other the typed name or id.
 */
export function jiraTemplateParentEntryMatches(
  template: Pick<JiraIssueTemplate, "parent" | "binding">,
  index: number,
  type: { readonly id: string; readonly name: string },
): boolean {
  const ids = template.binding?.parentIssueTypeIds;
  if (ids !== undefined) return ids[index] === type.id;
  const typed = template.parent.issueTypes?.[index];
  return typed !== undefined && (typed === type.id || sameName(type.name, typed));
}

/** The same rule for the parent types a template allows: whether any allowed entry is this type. */
export function jiraTemplateParentTypeMatches(
  template: Pick<JiraIssueTemplate, "parent" | "binding">,
  type: { readonly id: string; readonly name: string },
): boolean {
  return (template.parent.issueTypes ?? []).some((_, index) =>
    jiraTemplateParentEntryMatches(template, index, type),
  );
}

const normalisedName = (value: string): string => value.trim().toLowerCase();

/**
 * What a binding was resolved from AND what it says: the identity of the Jira, the template's typed
 * names and every id the product wrote, in a normal form (case and surrounding blanks do not matter,
 * nothing else does). THE one rule that says whether a binding is still in force:
 * `jiraTemplateForInstance` recomputes it, so a hand edit of any binding line drops the binding.
 */
export function jiraTemplateBindingDigest(
  instance: string,
  template: Pick<JiraIssueTemplate, "issueType" | "parent" | "requiredFields" | "activations">,
  ids: JiraTemplateBindingIds,
): string {
  const typed = typedNamesOf(template);
  const source = JSON.stringify([
    "keiko-jira-template-binding",
    2,
    instance,
    normalisedName(template.issueType),
    typed.parentTypes?.map(normalisedName) ?? null,
    typed.requiredFields.map(normalisedName),
    typed.parentField === undefined ? null : normalisedName(typed.parentField),
    typed.transitionTargets.map(normalisedName),
    ids.issueTypeId,
    ids.parentIssueTypeIds ?? null,
    ids.requiredFieldIds ?? null,
    ids.parentFieldId ?? null,
    ids.transitionStatusIds ?? null,
  ]);
  return portableSha256Hex(source).slice(0, 32);
}

/**
 * A template as it governs one Jira: its binding stays only when it was resolved for this Jira from
 * the names the template still types and its ids are still the ones written. Any other binding
 * (another Jira, an edited name, an edited id, a hand-written id) is dropped here, so every consumer
 * matches that template by name instead.
 */
export function jiraTemplateForInstance(
  template: JiraIssueTemplate,
  instance: string | undefined,
): JiraIssueTemplate {
  const { binding } = template;
  if (binding === undefined) return template;
  if (
    instance !== undefined &&
    binding.digest === jiraTemplateBindingDigest(instance, template, binding)
  )
    return template;
  const { binding: _unconfirmed, ...rest } = template;
  return rest;
}

/** What a guided edit knows about references it adds: ids this Jira's own metadata gave them. */
export interface JiraTemplateEditedIds {
  /** Field id by typed field reference (compared case-insensitively). */
  readonly fieldIds?: ReadonlyMap<string, string>;
  /** Status id by typed transition target (compared case-insensitively). */
  readonly statusIds?: ReadonlyMap<string, string>;
}

function previousId(
  typed: readonly string[],
  ids: readonly string[] | undefined,
  reference: string,
): string | undefined {
  const index = typed.findIndex((entry) => sameName(entry, reference));
  return index < 0 ? undefined : ids?.[index];
}

function idFor(
  typed: readonly string[],
  ids: readonly string[] | undefined,
  known: ReadonlyMap<string, string> | undefined,
  reference: string,
): string {
  const kept = previousId(typed, ids, reference);
  if (kept !== undefined) return kept;
  const normal = normalisedName(reference);
  for (const [name, id] of known ?? []) if (normalisedName(name) === normal) return id;
  return JIRA_BINDING_UNRESOLVED;
}

/**
 * The binding of a template after a guided edit of its rules, for the Jira that confirmed the binding:
 * every reference the edit leaves alone keeps the id it was bound to (its position may move, its id
 * never changes), and a reference the edit adds takes the id this Jira's metadata gave it, or stays
 * unresolved. Undefined when the template carries no binding that is in force for `instance`, or the
 * edit does not read: the caller then removes the binding and the next check binds afresh.
 */
export function rebindJiraTemplateAfterEdit(
  template: JiraIssueTemplate,
  instance: string | undefined,
  edit: { readonly requiredFields: readonly string[]; readonly activateOn: readonly string[] },
  resolved: JiraTemplateEditedIds = {},
): JiraTemplateBinding | undefined {
  const bound = jiraTemplateForInstance(template, instance).binding;
  // The strict reader (`Reader.list`) drops repeated tokens, so the digest is built over the same set.
  const parsed = [...new Set(edit.activateOn)].map(parseActivation);
  const activations = parsed.filter((item): item is JiraTemplateActivation => item !== undefined);
  if (instance === undefined || bound === undefined || activations.length !== parsed.length)
    return undefined;
  const requiredFields = [...new Set(edit.requiredFields)];
  const targets = jiraTemplateTransitionTargets({ activations });
  const ids: JiraTemplateBindingIds = {
    issueTypeId: bound.issueTypeId,
    ...(bound.parentIssueTypeIds === undefined
      ? {}
      : { parentIssueTypeIds: bound.parentIssueTypeIds }),
    ...(requiredFields.length === 0
      ? {}
      : {
          requiredFieldIds: requiredFields.map((field) =>
            idFor(template.requiredFields, bound.requiredFieldIds, resolved.fieldIds, field),
          ),
        }),
    ...(bound.parentFieldId === undefined ? {} : { parentFieldId: bound.parentFieldId }),
    ...(targets.length === 0
      ? {}
      : {
          transitionStatusIds: targets.map((target) =>
            idFor(
              jiraTemplateTransitionTargets(template),
              bound.transitionStatusIds,
              resolved.statusIds,
              target,
            ),
          ),
        }),
  };
  const typed = {
    issueType: template.issueType,
    parent: template.parent,
    requiredFields,
    activations,
  };
  return { digest: jiraTemplateBindingDigest(instance, typed, ids), ...ids };
}

/**
 * The field id a bound template carries for a typed field reference (`requiredFields` entry or
 * `parentField`), or undefined where the template is unbound or that name did not resolve: such a
 * reference is matched by name or by a typed id, as before.
 */
export function jiraTemplateBoundFieldId(
  template: Pick<JiraIssueTemplate, "binding" | "requiredFields" | "parent">,
  reference: string,
): string | undefined {
  const { binding } = template;
  if (binding === undefined) return undefined;
  const index = template.requiredFields.findIndex((field) => sameName(field, reference));
  const id = index >= 0 ? binding.requiredFieldIds?.[index] : parentFieldIdOf(template, reference);
  return id === undefined || id === JIRA_BINDING_UNRESOLVED ? undefined : id;
}

/**
 * Ids a template reference names. A field the template is bound to by id resolves to exactly that id
 * (and to nothing when the catalog has no such field); otherwise an exact field id first, otherwise
 * every same-named field. THE one rule: the write gate, the report and the guided editor ask here.
 */
export function resolveJiraTemplateFieldIds(
  reference: string,
  catalog: readonly { readonly id: string; readonly name: string }[],
  template?: Pick<JiraIssueTemplate, "binding" | "requiredFields" | "parent">,
): readonly string[] {
  const bound = template === undefined ? undefined : jiraTemplateBoundFieldId(template, reference);
  if (bound !== undefined) return catalog.some((entry) => entry.id === bound) ? [bound] : [];
  const exact = catalog.filter((entry) => entry.id === reference);
  if (exact.length > 0) return exact.map((entry) => entry.id);
  return catalog.filter((entry) => sameName(entry.name, reference)).map((entry) => entry.id);
}

/** The bound parent-link field id, when the reference names the template's parent field. */
function parentFieldIdOf(
  template: Pick<JiraIssueTemplate, "binding" | "parent">,
  reference: string,
): string | undefined {
  return template.parent.field !== undefined && sameName(template.parent.field, reference)
    ? template.binding?.parentFieldId
    : undefined;
}

/**
 * The status id a bound template carries for one of its `transition:<target>` activations, or
 * undefined where the template is unbound or that target did not resolve to a status (a typed transition
 * id, or a name that is no status name): such a target is matched as before.
 */
export function jiraTemplateBoundStatusId(
  template: Pick<JiraIssueTemplate, "binding" | "activations">,
  activation: JiraTemplateActivation,
): string | undefined {
  const index = jiraTemplateTransitionTargets(template).indexOf(
    activation.kind === "transition" ? (activation.target ?? "") : "",
  );
  const id = index < 0 ? undefined : template.binding?.transitionStatusIds?.[index];
  return id === undefined || id === JIRA_BINDING_UNRESOLVED ? undefined : id;
}

const BINDING_KEY_LINE =
  /^(?:issueTypeId|parentIssueTypeIds|requiredFieldIds|parentFieldId|transitionStatusIds|jiraBinding)[ \t]*:/u;
const BINDING_LIST_KEY_LINE =
  /^(?:parentIssueTypeIds|requiredFieldIds|transitionStatusIds)[ \t]*:/u;
const ISSUE_TYPE_KEY_LINE = /^issueType[ \t]*:/u;
const BLOCK_ITEM_LINE = /^[ \t]*-(?:\s|$)/u;

interface TextLine {
  readonly line: string;
  readonly ending: string;
}

/** The document as lines with the exact line ending each carried, so nothing but the binding moves. */
function textLines(markdown: string): readonly TextLine[] {
  const parts = markdown.split(/(\r\n|\n|\r)/u);
  const lines: TextLine[] = [];
  for (let index = 0; index < parts.length; index += 2)
    lines.push({ line: parts[index] ?? "", ending: parts[index + 1] ?? "" });
  return lines;
}

/** The index of the line that closes the front matter, or undefined without a closed front matter. */
function closingLine(lines: readonly TextLine[]): number | undefined {
  if (lines[0]?.line.trimEnd() !== "---") return undefined;
  const closing = lines.findIndex((entry, index) => index > 0 && entry.line.trimEnd() === "---");
  return closing < 0 ? undefined : closing;
}

type BindingLineKind = "key" | "list-key" | "item" | "other";

/** What one front-matter line is to the binding: its key, the key of a block list, or a block item of it. */
function bindingLineKind(line: string, inList: boolean): BindingLineKind {
  if (BINDING_KEY_LINE.test(line))
    return BINDING_LIST_KEY_LINE.test(line) && !line.includes("[") ? "list-key" : "key";
  return inList && BLOCK_ITEM_LINE.test(line) ? "item" : "other";
}

/** The lines without any binding line (a key in the first column and its block items), and where `issueType` sits. */
function withoutBinding(
  lines: readonly TextLine[],
  closing: number,
): { readonly kept: TextLine[]; readonly at: number } {
  const kept: TextLine[] = [];
  let at = -1;
  let inList = false;
  for (const [index, entry] of lines.entries()) {
    const inFront = index > 0 && index < closing;
    const kind: BindingLineKind = inFront ? bindingLineKind(entry.line, inList) : "other";
    if (kind !== "other") {
      inList = kind !== "key";
      continue;
    }
    inList = false;
    if (inFront && at < 0 && ISSUE_TYPE_KEY_LINE.test(entry.line)) at = kept.length;
    kept.push(entry);
  }
  return { kept, at };
}

function bindingText(binding: JiraTemplateBinding): readonly string[] {
  const list = (key: string, ids: readonly string[] | undefined): readonly string[] =>
    ids === undefined ? [] : [`${key}: ${JSON.stringify(ids)}`];
  return [
    `issueTypeId: ${JSON.stringify(binding.issueTypeId)}`,
    ...list("parentIssueTypeIds", binding.parentIssueTypeIds),
    ...list("requiredFieldIds", binding.requiredFieldIds),
    ...(binding.parentFieldId === undefined
      ? []
      : [`parentFieldId: ${JSON.stringify(binding.parentFieldId)}`]),
    ...list("transitionStatusIds", binding.transitionStatusIds),
    `jiraBinding: ${JSON.stringify(binding.digest)}`,
  ];
}

function canonicalBinding(binding: JiraTemplateBinding | undefined): string {
  return JSON.stringify(
    binding === undefined
      ? null
      : [
          binding.digest,
          binding.issueTypeId,
          binding.parentIssueTypeIds ?? null,
          binding.requiredFieldIds ?? null,
          binding.parentFieldId ?? null,
          binding.transitionStatusIds ?? null,
        ],
  );
}

/** Whether the text parses back to a template carrying exactly this binding. */
function carriesBinding(text: string, binding: JiraTemplateBinding): boolean {
  const check = parseJiraIssueTemplate(text);
  return check.ok && canonicalBinding(check.template.binding) === canonicalBinding(binding);
}

/**
 * The template's Markdown with its binding lines written beside `issueType`. Only the binding lines
 * (a key starting in the first column and the block items that follow it) are replaced: every other
 * byte, and the line endings of the document, stay as they were. Undefined when the document has no
 * closed front matter, no `issueType` line, or when the result does not parse back to a template
 * carrying exactly this binding: nothing the product writes is a template that does not validate.
 */
export function bindJiraIssueTemplateText(
  markdown: string,
  binding: JiraTemplateBinding,
): string | undefined {
  const lines = textLines(markdown);
  const closing = closingLine(lines);
  if (closing === undefined) return undefined;
  const { kept, at } = withoutBinding(lines, closing);
  if (at < 0) return undefined;
  const ending = /\r\n|\n|\r/u.exec(markdown)?.[0] ?? "\n";
  kept.splice(at + 1, 0, ...bindingText(binding).map((line) => ({ line, ending })));
  const text = kept.map((entry) => entry.line + entry.ending).join("");
  return carriesBinding(text, binding) ? text : undefined;
}

/** Stable label of a template in violations, summaries and logs. */
export function jiraIssueTemplateLabel(
  template: Pick<JiraIssueTemplate, "project" | "issueType">,
): string {
  return `${template.project}/${template.issueType}`;
}
