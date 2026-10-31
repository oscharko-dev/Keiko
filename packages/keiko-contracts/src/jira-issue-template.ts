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
export const JIRA_ISSUE_TEMPLATE_MARKER = "jira-issue-template";
export const JIRA_ISSUE_TEMPLATE_VERSION = 1;

export const JIRA_ISSUE_TEMPLATE_LIMITS = Object.freeze({
  keyChars: 128,
  textChars: 120,
  labelChars: 255,
  patternChars: 200,
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

export interface JiraIssueTemplate {
  /** Upper-cased Jira project key. */
  readonly project: string;
  /** Issue type name (case-insensitive) or numeric issue type id. */
  readonly issueType: string;
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
  readonly parent: { readonly field?: string; readonly link?: string };
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
  "template-unreadable",
] as const;
export type JiraTemplateRuleId = (typeof JIRA_TEMPLATE_RULE_IDS)[number];

export interface JiraTemplateViolation {
  readonly ruleId: JiraTemplateRuleId;
  /** The field, section, label or template element the rule names; bounded, never a body. */
  readonly subject: string;
  /** `PROJECT/Issue type` of the template that raised it. */
  readonly template: string;
}

/** What a template check yields for the model: bounded, closed ids plus short names. */
export const JIRA_TEMPLATE_VIOLATIONS_MAX = 25;

interface PatternGroup {
  inner: boolean;
}

function quantifierAt(source: string, index: number): boolean {
  const character = source[index];
  if (character === "*" || character === "+") return true;
  return character === "{" && /^\{\d{1,3}(?:,\d{0,3})?\}/u.test(source.slice(index));
}

/** Index after a character class starting at `start`, or -1 when it never closes. */
function classEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === "]") return index;
  }
  return -1;
}

function unsafeGroupStructure(source: string): boolean {
  const stack: PatternGroup[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === "\\") {
      if (/[1-9kK]/u.test(source[index + 1] ?? "")) return true;
      index += 1;
    } else if (character === "[") {
      const end = classEnd(source, index);
      if (end < 0) return true;
      index = end;
    } else if (character === "(") {
      if (source[index + 1] === "?" && source[index + 2] !== ":") return true;
      stack.push({ inner: false });
    } else if (character === ")") {
      const group = stack.pop();
      if (group === undefined) return true;
      const quantified = quantifierAt(source, index + 1);
      if (quantified && group.inner) return true;
      const parent = stack.at(-1);
      if (parent !== undefined && (quantified || group.inner)) parent.inner = true;
    } else if (character === "|" || quantifierAt(source, index)) {
      const group = stack.at(-1);
      if (group !== undefined) group.inner = true;
    }
  }
  return stack.length > 0;
}

/**
 * Why a template pattern is refused, or `undefined` when it is safe to run. Patterns run on text a
 * model wrote, so a quantified group may not contain a quantifier or an alternation (catastrophic
 * backtracking), and lookarounds and back-references are not part of the grammar. Input is also
 * bounded by the checker (a Jira summary or label is at most 255 characters).
 */
export function jiraTemplatePatternIssue(source: string): string | undefined {
  if (source.length === 0 || source.length > JIRA_ISSUE_TEMPLATE_LIMITS.patternChars)
    return "pattern length";
  if (unsafeGroupStructure(source)) return "pattern structure";
  try {
    new RegExp(source, "u");
  } catch {
    return "pattern syntax";
  }
  return undefined;
}

/** The compiled template pattern; callers must have accepted the pattern at parse time. */
export function compileJiraTemplatePattern(source: string): RegExp {
  const issue = jiraTemplatePatternIssue(source);
  if (issue !== undefined) throw new TypeError(issue);
  return new RegExp(source, "u");
}

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
  "optionalSections",
] as const;
type TemplateKey = (typeof KEYS)[number];
const KEY_SET: ReadonlySet<string> = new Set(KEYS);

interface RawEntry {
  readonly key: string;
  readonly values: readonly string[];
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

/** True when the document declares itself a Jira issue template (valid or not). */
export function isJiraIssueTemplateDocument(markdown: string): boolean {
  const front = frontMatterOf(splitDocument(markdown));
  if (front.kind === "none") return false;
  const lines = front.kind === "found" ? front.lines : splitDocument(markdown).slice(1);
  return lines.some((line) => /^keiko\s*:\s*"?jira-issue-template"?\s*$/u.test(line.trim()));
}

function unquote(raw: string): string | undefined {
  const value = raw.trim();
  if (!value.startsWith('"')) return value.includes('"') ? undefined : value;
  if (value.length < 2 || !value.endsWith('"')) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function inlineItems(raw: string): readonly string[] | undefined {
  const inner = raw.trim().slice(1, -1);
  if (inner.trim().length === 0) return [];
  const items: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index] ?? "";
    if (character === "\\" && quoted) {
      current += character + (inner[index + 1] ?? "");
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
      current += character;
    } else if (character === "," && !quoted) {
      items.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (quoted) return undefined;
  items.push(current);
  const values = items.map(unquote);
  return values.every((value): value is string => value !== undefined && value.length > 0)
    ? values
    : undefined;
}

interface Scan {
  readonly entries: RawEntry[];
  readonly errors: JiraTemplateParseError[];
}

function addKeyedLine(scan: Scan, text: string, line: number): void {
  const match = /^([A-Za-z][A-Za-z0-9]*)\s*:(?:\s+(.*))?$/u.exec(text);
  if (match === null) {
    scan.errors.push({ code: "malformed-line", line });
    return;
  }
  const key = match[1] ?? "";
  const raw = (match[2] ?? "").trim();
  if (!KEY_SET.has(key)) {
    scan.errors.push({ code: "unknown-key", key, line });
  } else if (scan.entries.some((entry) => entry.key === key)) {
    scan.errors.push({ code: "duplicate-key", key, line });
  } else if (raw.startsWith("[")) {
    const items = raw.endsWith("]") ? inlineItems(raw) : undefined;
    if (items === undefined) scan.errors.push({ code: "invalid-value", key, line });
    else scan.entries.push({ key, values: items, list: true, inline: true, line });
  } else if (raw.length === 0) {
    scan.entries.push({ key, values: [], list: true, line });
  } else {
    const value = unquote(raw);
    if (value === undefined || value.length === 0) {
      scan.errors.push({ code: "invalid-value", key, line });
    } else {
      scan.entries.push({ key, values: [value], list: false, line });
    }
  }
}

function addBlockItem(scan: Scan, text: string, line: number): void {
  const last = scan.entries.at(-1);
  const value = unquote(text.slice(1));
  if (last === undefined || !last.list || last.inline === true || value === undefined || value.length === 0) {
    scan.errors.push({ code: "malformed-line", line });
    return;
  }
  scan.entries[scan.entries.length - 1] = { ...last, values: [...last.values, value] };
}

function scanFrontMatter(lines: readonly string[]): Scan {
  const scan: Scan = { entries: [], errors: [] };
  lines.forEach((source, offset) => {
    const text = source.trim();
    if (text.length === 0 || text.startsWith("#")) return;
    if (text.startsWith("-") && (text.length === 1 || /\s/u.test(text.charAt(1)))) {
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

  public list(key: TemplateKey, max: number, itemChars: number): readonly string[] {
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
    return [...new Set(entry.values)];
  }

  public pattern(key: TemplateKey): string | undefined {
    const value = this.scalar(key, JIRA_ISSUE_TEMPLATE_LIMITS.patternChars);
    if (value === undefined) return undefined;
    if (jiraTemplatePatternIssue(value) !== undefined) {
      this.errors.push({ code: "unsafe-pattern", key, line: entryOf(this.entries, key)?.line ?? 0 });
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
  const parsed = values.map(parseActivation);
  if (values.length === 0 || parsed.includes(undefined)) {
    reader.errors.push({ code: "invalid-value", key: "activateOn" });
    return [];
  }
  return parsed.filter((item): item is JiraTemplateActivation => item !== undefined);
}

const HEADING = /^\s{0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/u;
const FENCE = /^\s{0,3}(```|~~~)/u;

/** Normalised key shared by the template body and the description the checker reads. */
export function normalizeJiraSectionHeading(heading: string): string {
  return heading
    .replace(/[*_`]/gu, "")
    .replace(/[:\s]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function bodySections(lines: readonly string[], optional: ReadonlySet<string>): readonly string[] {
  const sections: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : HEADING.exec(line);
    const title = heading?.[1]?.replace(/[*_`]/gu, "").replace(/[:\s]+$/u, "").trim();
    if (title === undefined || title.length === 0) continue;
    if (optional.has(normalizeJiraSectionHeading(title))) continue;
    if (!sections.some((seen) => normalizeJiraSectionHeading(seen) === normalizeJiraSectionHeading(title))) {
      sections.push(title);
    }
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
  if (project !== undefined && !/^[A-Za-z][A-Za-z0-9_]*$/u.test(project))
    reader.errors.push({ code: "invalid-value", key: "project" });
  if (project === undefined || issueType === undefined) return undefined;
  return { project: project.toUpperCase(), issueType };
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
  const parentField = reader.scalar("parentField", JIRA_ISSUE_TEMPLATE_LIMITS.textChars);
  const parentLink = reader.scalar("parentLink", JIRA_ISSUE_TEMPLATE_LIMITS.textChars);
  const requiredFields = reader.list(
    "requiredFields",
    JIRA_ISSUE_TEMPLATE_LIMITS.listItems,
    JIRA_ISSUE_TEMPLATE_LIMITS.textChars,
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
      parent: {
        ...(parentField === undefined ? {} : { field: parentField }),
        ...(parentLink === undefined ? {} : { link: parentLink }),
      },
    };
    if (hasRules(template)) return { ok: true, template };
    errors.push({ code: "no-rules" });
  }
  return { ok: false, errors: errors.slice(0, JIRA_ISSUE_TEMPLATE_LIMITS.errors) };
}

/** Body-free description of a parse failure: closed codes, key names and line numbers only. */
export function describeJiraTemplateParseErrors(errors: readonly JiraTemplateParseError[]): string {
  return errors
    .map(
      (error) =>
        `${error.code}${error.key === undefined ? "" : ` (${error.key})`}${
          error.line === undefined ? "" : ` at line ${String(error.line)}`
        }`,
    )
    .join("; ");
}

/** Stable label of a template in violations, summaries and logs. */
export function jiraIssueTemplateLabel(template: Pick<JiraIssueTemplate, "project" | "issueType">): string {
  return `${template.project}/${template.issueType}`;
}
