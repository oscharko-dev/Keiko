import {
  containsBidiOrZeroWidth,
  hasControlCharacter,
  stripUnsafeFormatChars,
} from "@oscharko-dev/keiko-contracts/text-safety";

/**
 * The pure half of repository item admission (#3903, ADR-0137): turns one repository-authored
 * Markdown file (a custom agent, a custom command or a skill) into the sanitized copy Keiko writes
 * into the run's private discovery directory, or into a closed refusal. Nothing here reads a file
 * or logs; the reader and the evidence are `codingRuntimeRepositoryItems.ts`.
 *
 * The pinned 2.1.4 producer reads these items from a configuration directory as YAML frontmatter
 * plus a Markdown body. Frontmatter is where authority lives (`permissions`, `model`, a tool
 * switch, a provider, an MCP or plugin entry), so nothing of the original frontmatter is ever
 * forwarded: the source is parsed by a deliberately small, closed parser, only the keys of a
 * per-kind allowlist are read, each by a typed reader, and the copy's frontmatter is rendered
 * anew from the validated values. Every other key is dropped and only counted. A shape the closed
 * parser does not understand is refused, never guessed at: one malformed file would otherwise
 * stop the producer from loading the others (proven against the original executable).
 *
 * The Markdown body is untrusted prose the model reads (a system prompt, a command template, a
 * skill), exactly like the workspace AGENTS.md: it grants no authority. A command template is the
 * one body with an executable feature: the producer runs every !-backtick block outside the
 * permission hook (proven against the original executable), including one an argument forms at a
 * placeholder boundary, so a template that contains or can form one is refused.
 */
export const REPOSITORY_ITEM_KINDS = ["agent", "command", "skill"] as const;
export type RepositoryItemKind = (typeof REPOSITORY_ITEM_KINDS)[number];

export const REPOSITORY_ITEM_REFUSAL_REASONS = [
  "directory-unreadable",
  "not-regular-file",
  "unreadable",
  "oversize",
  "limit-exceeded",
  "invalid-name",
  "reserved-name",
  "duplicate-name",
  "frontmatter-malformed",
  "frontmatter-unsupported",
  "value-invalid",
  "description-missing",
  "body-empty",
  "unsafe-characters",
  "template-shell-substitution",
  "agent-not-admitted",
  "name-mismatch",
  "restriction-unrepresentable",
] as const;
export type RepositoryItemRefusalReason = (typeof REPOSITORY_ITEM_REFUSAL_REASONS)[number];

/** One file's bytes, UTF-8: an agent's system prompt is re-sent with every turn it runs. */
export const REPOSITORY_ITEM_MAX_BYTES = 32_768;
export const REPOSITORY_ITEM_NAME_MAX_CHARS = 48;

// Descriptions ride in the model's tool and skill catalogues on every turn (a command's rides in the
// `/` menu, whose contract bound is 200), so each kind is bounded to what its catalogue can carry.
const DESCRIPTION_MAX_CHARS: Readonly<Record<RepositoryItemKind, number>> = Object.freeze({
  agent: 256,
  command: 200,
  skill: 512,
});
const TEMPERATURE_MAX = 2;
const TOP_P_MAX = 1;

const ITEM_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const RESERVED_NAME_PREFIX = "keiko";
// The producer's built-in agents, commands and skills (a file of the same id replaces the built-in),
// the sentinel words its configuration uses, and Keiko's own namespace. One set for every kind so a
// command can never shadow an agent's name either.
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "build",
  "plan",
  "general",
  "explore",
  "compaction",
  "title",
  "summary",
  "init",
  "review",
  "opencode",
  "report",
  "default",
  "all",
]);

/** The keys each kind forwards, in the order the copy renders them. Every other key is dropped. */
const ALLOWED_KEYS: Readonly<Record<RepositoryItemKind, readonly string[]>> = Object.freeze({
  agent: ["description", "mode", "temperature", "top_p"],
  command: ["description", "agent", "subagent", "subtask"],
  skill: ["name", "description"],
});

// Dropped keys named here are counted apart from the rest: they are the ones that would have
// registered authority, routed a model, switched a tool or loaded code.
const AUTHORITY_KEY_NAMES: ReadonlySet<string> = new Set([
  "permission",
  "permissions",
  "tools",
  "model",
  "provider",
  "providers",
  "mcp",
  "plugin",
  "plugins",
  "disabled",
  "allowed-tools",
  "request",
  "options",
  "variant",
]);

type Step<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: RepositoryItemRefusalReason };

type Field = readonly [key: string, rendered: string];

function ok<T>(value: T): Step<T> {
  return { ok: true, value };
}

function refuse(reason: RepositoryItemRefusalReason): Step<never> {
  return { ok: false, reason };
}

export function repositoryItemNameRefusal(
  name: string,
): "invalid-name" | "reserved-name" | undefined {
  if (name.length > REPOSITORY_ITEM_NAME_MAX_CHARS || !ITEM_NAME.test(name)) return "invalid-name";
  return RESERVED_NAMES.has(name) || name.startsWith(RESERVED_NAME_PREFIX)
    ? "reserved-name"
    : undefined;
}

export interface RepositoryItemContext {
  /** The agents admitted as subagents in this run: the only agents a command may name. */
  readonly admittedSubagents: ReadonlySet<string>;
}

export type RepositoryItemOutcome =
  | {
      readonly ok: true;
      readonly content: string;
      /** The admitted agent's mode; absent for a command and a skill. */
      readonly mode?: "subagent" | "primary";
      readonly strippedAuthorityKeyCount: number;
      readonly strippedOtherKeyCount: number;
    }
  | { readonly ok: false; readonly reason: RepositoryItemRefusalReason };

interface FrontmatterEntry {
  readonly key: string;
  readonly value: string;
  readonly continuation: string[];
  /** The continuation lines as written, with their indentation (an agent's permission map). */
  readonly rawContinuation: string[];
}

interface PreparedItem {
  readonly entries: readonly FrontmatterEntry[];
  readonly body: string;
}

export function sanitizeRepositoryItem(
  kind: RepositoryItemKind,
  name: string,
  rawText: string,
  context: RepositoryItemContext,
): RepositoryItemOutcome {
  const prepared = prepareItem(rawText);
  if (!prepared.ok) return prepared;
  const { entries, body } = prepared.value;
  const read = readFields(kind, name, entries, body, context);
  if (!read.ok) return read;
  const allowed = new Set(ALLOWED_KEYS[kind]);
  const stripped = entries.filter(({ key }) => !allowed.has(key));
  const authority = stripped.filter(({ key }) => AUTHORITY_KEY_NAMES.has(key)).length;
  return {
    ok: true,
    content: renderItem(read.value.fields, body),
    ...(read.value.mode === undefined ? {} : { mode: read.value.mode }),
    strippedAuthorityKeyCount: authority,
    strippedOtherKeyCount: stripped.length - authority,
  };
}

function prepareItem(rawText: string): Step<PreparedItem> {
  const text = rawText.replace(/^\uFEFF/u, "").replaceAll(/\r\n?/gu, "\n");
  if (Buffer.byteLength(text, "utf8") > REPOSITORY_ITEM_MAX_BYTES) return refuse("oversize");
  if (stripUnsafeFormatChars(text) !== text) return refuse("unsafe-characters");
  const split = splitFrontmatter(text);
  if (!split.ok) return split;
  const entries = parseEntries(split.value.frontmatter);
  if (!entries.ok) return entries;
  const body = split.value.body.replace(/^(?:[ \t]*\n)+/u, "").trimEnd();
  if (body.length === 0) return refuse("body-empty");
  return ok({ entries: entries.value, body });
}

function splitFrontmatter(
  text: string,
): Step<{ readonly frontmatter: readonly string[]; readonly body: string }> {
  if (!text.startsWith("---\n")) return ok({ frontmatter: [], body: text });
  const lines = text.split("\n");
  const closing = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (closing === -1) return refuse("frontmatter-malformed");
  return ok({ frontmatter: lines.slice(1, closing), body: lines.slice(closing + 1).join("\n") });
}

// One separating blank, then the rest of the line; the value is trimmed where it is read.
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t](.*))?$/u;

// A closed subset of YAML: top-level `key: scalar` lines, and indented or `-` lines that continue
// the key above them. Anything else (a quoted key, a merge key, a document marker, a duplicate key)
// is not guessed at.
function parseEntries(lines: readonly string[]): Step<readonly FrontmatterEntry[]> {
  const entries: FrontmatterEntry[] = [];
  for (const line of lines) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const accepted = /^[ \t-]/u.test(line)
      ? continueEntry(entries, line)
      : startEntry(entries, line);
    if (!accepted) return refuse("frontmatter-malformed");
  }
  return ok(entries);
}

function continueEntry(entries: readonly FrontmatterEntry[], line: string): boolean {
  const previous = entries.at(-1);
  previous?.continuation.push(line.trim());
  previous?.rawContinuation.push(line);
  return previous !== undefined;
}

function startEntry(entries: FrontmatterEntry[], line: string): boolean {
  const match = KEY_LINE.exec(line);
  const key = match?.[1];
  if (key === undefined || entries.some((entry) => entry.key === key)) return false;
  entries.push({ key, value: (match?.[2] ?? "").trim(), continuation: [], rawContinuation: [] });
  return true;
}

const BLOCK_SCALAR_INDICATOR = /^[|>][+-]?$/u;
// A plain scalar cannot start with a YAML indicator: a flow collection, an anchor or alias, a tag,
// a directive or a reserved character is a different construct, not text.
const PLAIN_SCALAR_FORBIDDEN_START = /^[[\]{}&*!%@`|>]/u;

function scalarOf(entry: FrontmatterEntry): Step<string> {
  const raw = entry.value;
  if (raw.startsWith('"')) return doubleQuoted(entry);
  if (raw.startsWith("'")) return singleQuoted(entry);
  if (BLOCK_SCALAR_INDICATOR.test(raw)) return foldedScalar(entry.continuation);
  if (PLAIN_SCALAR_FORBIDDEN_START.test(raw)) return refuse("frontmatter-unsupported");
  const first = stripInlineComment(raw);
  const rest = entry.continuation;
  const invalid = rest.some(
    (line) => line.startsWith("#") || line.startsWith("- ") || line.includes(": "),
  );
  return invalid ? refuse("frontmatter-unsupported") : foldedScalar([first, ...rest]);
}

function foldedScalar(lines: readonly string[]): Step<string> {
  const text = lines.filter((line) => line.length > 0).join(" ");
  return text.length === 0 ? refuse("value-invalid") : ok(text);
}

function stripInlineComment(raw: string): string {
  if (raw.startsWith("#")) return "";
  const index = raw.search(/[ \t]#/u);
  return (index === -1 ? raw : raw.slice(0, index)).trim();
}

// A YAML double-quoted scalar that is also a JSON string (the escapes YAML adds are not admitted),
// matched before it is decoded: the decoder never sees a text it could reject.
const JSON_STRING_LITERAL = /^"(?:[^"\\\p{Cc}]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"$/u;

function doubleQuoted(entry: FrontmatterEntry): Step<string> {
  if (entry.continuation.length > 0) return refuse("frontmatter-unsupported");
  if (!JSON_STRING_LITERAL.test(entry.value)) return refuse("value-invalid");
  const parsed: unknown = JSON.parse(entry.value);
  return typeof parsed === "string" ? ok(parsed) : refuse("value-invalid");
}

function singleQuoted(entry: FrontmatterEntry): Step<string> {
  if (entry.continuation.length > 0) return refuse("frontmatter-unsupported");
  const raw = entry.value;
  if (raw.length < 2 || !raw.endsWith("'")) return refuse("value-invalid");
  const inner = raw.slice(1, -1);
  return inner.replaceAll("''", "").includes("'")
    ? refuse("value-invalid")
    : ok(inner.replaceAll("''", "'"));
}

function entryNamed(
  entries: readonly FrontmatterEntry[],
  key: string,
): FrontmatterEntry | undefined {
  return entries.find((entry) => entry.key === key);
}

function optionalField(
  entries: readonly FrontmatterEntry[],
  key: string,
  read: (value: string) => Step<string>,
): Step<Field | undefined> {
  const entry = entryNamed(entries, key);
  if (entry === undefined) return ok(undefined);
  const scalar = scalarOf(entry);
  if (!scalar.ok) return scalar;
  const value = read(scalar.value);
  return value.ok ? ok([key, value.value] as const) : value;
}

function descriptionReader(kind: RepositoryItemKind): (value: string) => Step<string> {
  return (value): Step<string> => {
    const text = value.replaceAll(/\s+/gu, " ").trim();
    if (text.length === 0) return refuse("description-missing");
    const unsafe =
      text.length > DESCRIPTION_MAX_CHARS[kind] ||
      hasControlCharacter(text) ||
      containsBidiOrZeroWidth(text);
    return unsafe ? refuse("value-invalid") : ok(JSON.stringify(text));
  };
}

function enumReader(allowed: readonly string[]): (value: string) => Step<string> {
  return (value): Step<string> => (allowed.includes(value) ? ok(value) : refuse("value-invalid"));
}

function boundedNumberReader(max: number): (value: string) => Step<string> {
  return (value): Step<string> => {
    const valid = /^\d{1,3}(?:\.\d{1,4})?$/u.test(value) && Number(value) <= max;
    return valid ? ok(String(Number(value))) : refuse("value-invalid");
  };
}

// Only the grammar: whether an agent a command names is admitted is decided against the run's
// admitted subagents, which a reserved or unknown name is never in.
function nameReader(value: string): Step<string> {
  return repositoryItemNameRefusal(value) === "invalid-name" ? refuse("value-invalid") : ok(value);
}

interface ReadFields {
  readonly fields: readonly Field[];
  readonly mode?: "subagent" | "primary";
}

function collectFields(steps: readonly Step<Field | undefined>[]): Step<readonly Field[]> {
  const fields: Field[] = [];
  for (const step of steps) {
    if (!step.ok) return step;
    if (step.value !== undefined) fields.push(step.value);
  }
  return ok(fields);
}

function readFields(
  kind: RepositoryItemKind,
  name: string,
  entries: readonly FrontmatterEntry[],
  body: string,
  context: RepositoryItemContext,
): Step<ReadFields> {
  if (kind === "agent") return agentFields(entries);
  if (kind === "command") return commandFields(entries, body, context);
  return skillFields(name, entries);
}

// A custom agent Keiko cannot select as the session's primary agent is only useful as a subagent,
// so an agent that names no mode is admitted as one (the producer's own default would be primary).
function agentFields(entries: readonly FrontmatterEntry[]): Step<ReadFields> {
  const mode = optionalField(entries, "mode", enumReader(["subagent", "primary"]));
  if (!mode.ok) return mode;
  const fields = collectFields([
    optionalField(entries, "description", descriptionReader("agent")),
    optionalField(entries, "temperature", boundedNumberReader(TEMPERATURE_MAX)),
    optionalField(entries, "top_p", boundedNumberReader(TOP_P_MAX)),
    agentRestrictions(entries),
    agentRuleList(entries),
  ]);
  if (!fields.ok) return fields;
  const effective = mode.value?.[1] === "primary" ? "primary" : "subagent";
  return ok({ fields: [...fields.value, ["mode", effective] as const], mode: effective });
}

/**
 * An agent's own permission rules, kept where they restrict (#3897 review): a repository reviewer
 * that denies `edit` must stay unable to edit. Only `deny` is forwarded. An `allow` or `ask` rule
 * would widen nothing behind Keiko's policy hook, which decides every allowed or asked action, but
 * the runtime lets a later rule override an earlier one, so a forwarded `allow` could undo one of
 * Keiko's own denials before the hook is asked; a configured `deny` is final. Dropping an `allow`
 * exception can only narrow the agent. The closed grammar is an action with a value, or an action
 * with a one-level map of quoted or plain patterns to values. Any other shape, and a `tools` switch
 * that turns a tool off (which cannot be carried over faithfully), refuses the whole agent instead
 * of silently dropping a restriction; a switch that only turns tools on is dropped like any other
 * authority key.
 */
function agentRestrictions(entries: readonly FrontmatterEntry[]): Step<Field | undefined> {
  if (disablesTools(entryNamed(entries, "tools"))) return refuse("restriction-unrepresentable");
  const permission = entryNamed(entries, "permission");
  if (permission === undefined) return ok(undefined);
  if (permission.value.length > 0) return refuse("restriction-unrepresentable");
  const denied = deniedRules(permission.rawContinuation);
  if (denied === undefined) return refuse("restriction-unrepresentable");
  return ok(denied.length === 0 ? undefined : (["permission", `\n${denied.join("\n")}`] as const));
}

/**
 * The canonical V2 rule array (`permissions: [{action, resource, effect}]`, written as a block
 * list), kept the same way as the map above: each `deny` rule re-rendered, `allow` and `ask`
 * dropped. A flow list, an unknown key, a missing field or any other shape refuses the agent.
 */
function agentRuleList(entries: readonly FrontmatterEntry[]): Step<Field | undefined> {
  const permissions = entryNamed(entries, "permissions");
  if (permissions === undefined) return ok(undefined);
  if (permissions.value.length > 0) return refuse("restriction-unrepresentable");
  const rules = permissionRules(permissions.rawContinuation);
  if (rules === undefined) return refuse("restriction-unrepresentable");
  const denied = rules.filter((rule) => rule.effect === "deny");
  if (denied.length === 0) return ok(undefined);
  const rendered = denied.flatMap((rule) => [
    `  - action: ${rule.action}`,
    `    resource: ${rule.resource}`,
    "    effect: deny",
  ]);
  return ok(["permissions", `\n${rendered.join("\n")}`] as const);
}

interface PermissionRule {
  action?: string;
  resource?: string;
  effect?: string;
}

const RULE_FIELD_LINE = /^(action|resource|effect):[ \t]+(\S(?:.*\S)?)[ \t]*$/u;

/** The rules of a block list, or undefined when any line or item is outside the closed shape. */
function permissionRules(
  lines: readonly string[],
): readonly Required<PermissionRule>[] | undefined {
  const rules: PermissionRule[] = [];
  const shape = { itemIndent: undefined as number | undefined };
  for (const line of lines) {
    if (line.trim().startsWith("#")) continue;
    if (!ruleLine(rules, shape, line)) return undefined;
  }
  return rules.every(completeRule) ? (rules as Required<PermissionRule>[]) : undefined;
}

// One line: `- key: value` opens an item at the list's indentation, `key: value` two columns
// deeper continues it.
function ruleLine(
  rules: PermissionRule[],
  shape: { itemIndent: number | undefined },
  line: string,
): boolean {
  const indent = /^ */u.exec(line)?.[0].length ?? 0;
  shape.itemIndent ??= indent;
  const content = line.slice(indent);
  const opens = indent === shape.itemIndent && content.startsWith("- ");
  if (opens) rules.push({});
  else if (indent !== shape.itemIndent + 2) return false;
  const current = rules.at(-1);
  return current !== undefined && ruleField(current, opens ? content.slice(2) : content);
}

function ruleField(rule: PermissionRule, content: string): boolean {
  const match = RULE_FIELD_LINE.exec(content);
  const key = match?.[1] as keyof PermissionRule | undefined;
  const value = match?.[2];
  if (key === undefined || value === undefined || rule[key] !== undefined) return false;
  const parsed = ruleValue(key, value);
  if (parsed === undefined) return false;
  rule[key] = parsed;
  return true;
}

function ruleValue(key: keyof PermissionRule, value: string): string | undefined {
  if (key === "effect") return /^(deny|allow|ask)$/u.test(value) ? value : undefined;
  const line =
    key === "action"
      ? PERMISSION_ACTION_LINE.exec(`${value}: deny`)
      : PERMISSION_PATTERN_LINE.exec(`${value}: deny`);
  return line?.[1] === undefined ? undefined : quotedName(line[1]);
}

function completeRule(rule: PermissionRule): boolean {
  return rule.action !== undefined && rule.resource !== undefined && rule.effect !== undefined;
}

function disablesTools(tools: FrontmatterEntry | undefined): boolean {
  if (tools === undefined) return false;
  return [tools.value, ...tools.continuation].some((line) => /\bfalse\b/u.test(line));
}

type PermissionLine =
  | { readonly kind: "rule"; readonly action: string; readonly value: string | undefined }
  | { readonly kind: "pattern"; readonly pattern: string; readonly value: string };

interface PermissionBlock {
  readonly denied: string[];
  actionIndent: number | undefined;
  patternIndent: number | undefined;
  /** The action whose pattern map is open, and the deny rules read from it so far. */
  open: { readonly action: string; readonly denies: string[] } | undefined;
}

/** The rendered `deny` rules of a permission block, or undefined when its shape is not closed. */
function deniedRules(lines: readonly string[]): string[] | undefined {
  const block: PermissionBlock = {
    denied: [],
    actionIndent: undefined,
    patternIndent: undefined,
    open: undefined,
  };
  for (const line of lines) {
    if (line.trim().startsWith("#")) continue;
    const parsed = permissionLine(block, line);
    if (parsed === undefined || !applyPermissionLine(block, parsed)) return undefined;
  }
  flushPatternRules(block);
  return block.denied;
}

function applyPermissionLine(block: PermissionBlock, parsed: PermissionLine): boolean {
  if (parsed.kind === "pattern") {
    if (block.open === undefined) return false;
    if (parsed.value === "deny") block.open.denies.push(`    ${parsed.pattern}: deny`);
    return true;
  }
  flushPatternRules(block);
  block.patternIndent = undefined;
  block.open = parsed.value === undefined ? { action: parsed.action, denies: [] } : undefined;
  if (parsed.value === "deny") block.denied.push(`  ${parsed.action}: deny`);
  return true;
}

/** One line of the block, read at its indentation: an action line, or a pattern below one. */
function permissionLine(block: PermissionBlock, line: string): PermissionLine | undefined {
  const indent = /^ */u.exec(line)?.[0].length ?? 0;
  const content = line.slice(indent);
  if (indent === 0 || content.startsWith("\t")) return undefined;
  block.actionIndent ??= indent;
  if (indent === block.actionIndent) return actionLine(content);
  if (indent < block.actionIndent) return undefined;
  block.patternIndent ??= indent;
  return indent === block.patternIndent ? patternLine(content) : undefined;
}

function actionLine(content: string): PermissionLine | undefined {
  const rule = PERMISSION_ACTION_LINE.exec(content);
  if (rule === null) return undefined;
  return { kind: "rule", action: quotedName(rule[1] ?? ""), value: rule[2] };
}

function patternLine(content: string): PermissionLine | undefined {
  const pattern = PERMISSION_PATTERN_LINE.exec(content);
  if (pattern === null) return undefined;
  return { kind: "pattern", pattern: quotedName(pattern[1] ?? ""), value: pattern[2] ?? "" };
}

/**
 * A name rendered as a double-quoted YAML string. The grammar admits no escape inside either
 * quoting style, so the quoted text is the literal name.
 */
function quotedName(written: string): string {
  const quoted = written.startsWith('"') || written.startsWith("'");
  return JSON.stringify(quoted ? written.slice(1, -1) : written);
}

const PERMISSION_VALUE = "(deny|allow|ask)";
/** `edit: deny`, `"mcp_*": deny`, or `edit:` opening a pattern map. */
const PERMISSION_ACTION_LINE = new RegExp(
  String.raw`^([a-z][a-z0-9_]{0,63}|"[a-z0-9_*]{1,64}"):(?:[ \t]+${PERMISSION_VALUE})?[ \t]*$`,
  "u",
);
/** `"*": deny` or `git status: allow`, inside an action's pattern map. */
const PERMISSION_PATTERN_LINE = new RegExp(
  String.raw`^("[^"\\\p{Cc}]{1,200}"|'[^'\p{Cc}]{1,200}'|[A-Za-z0-9_./][A-Za-z0-9_./* -]{0,199}):[ \t]+${PERMISSION_VALUE}[ \t]*$`,
  "u",
);

function flushPatternRules(block: PermissionBlock): void {
  const open = block.open;
  if (open !== undefined && open.denies.length > 0)
    block.denied.push(`  ${open.action}:`, ...open.denies);
  block.open = undefined;
}

// A command that names an agent switches the session to it unless the agent is a subagent, which
// runs the command in a child session instead (proven against the original executable). Switching
// would move the session's primary agent behind Keiko's own record of it (a Plan session could
// leave read-only), so only an admitted subagent may be named.
function commandFields(
  entries: readonly FrontmatterEntry[],
  body: string,
  context: RepositoryItemContext,
): Step<ReadFields> {
  if (hasShellSubstitution(body)) return refuse("template-shell-substitution");
  const agent = optionalField(entries, "agent", nameReader);
  if (agent.ok && agent.value !== undefined && !context.admittedSubagents.has(agent.value[1])) {
    return refuse("agent-not-admitted");
  }
  // `subtask` is the producer's deprecated alias of `subagent`, which wins when both are present.
  const flagKey = entryNamed(entries, "subagent") === undefined ? "subtask" : "subagent";
  const flag = optionalField(entries, flagKey, enumReader(["true", "false"]));
  const fields = collectFields([
    optionalField(entries, "description", descriptionReader("command")),
    agent,
    flag.ok && flag.value !== undefined ? ok(["subagent", flag.value[1]] as const) : flag,
  ]);
  return fields.ok ? ok({ fields: fields.value }) : fields;
}

function skillFields(name: string, entries: readonly FrontmatterEntry[]): Step<ReadFields> {
  const label = optionalField(entries, "name", nameReader);
  if (!label.ok) return label;
  if (label.value !== undefined && label.value[1] !== name) return refuse("name-mismatch");
  const description = optionalField(entries, "description", descriptionReader("skill"));
  if (!description.ok) return description;
  if (description.value === undefined) return refuse("description-missing");
  return ok({ fields: [["name", name] as const, description.value] });
}

/** A bang directly before a backtick: where the producer's command expander starts a shell block. */
export const SHELL_BLOCK_MARKER = "!`";
const PLACEHOLDER = String.raw`\$(?:ARGUMENTS|\d+)`;
// `!` before a placeholder, or a placeholder before a backtick or another placeholder: an argument
// (or an absent positional, which becomes empty) completes a block there.
const SHELL_BLOCK_AT_PLACEHOLDER = new RegExp(
  `!${PLACEHOLDER}|${PLACEHOLDER}(?:\`|${PLACEHOLDER})`,
  "u",
);

/**
 * The producer's command expander runs `!` + backtick + command + backtick as a shell command in
 * the project directory, outside every permission hook, over the template after argument
 * substitution. The marker is refused wherever it appears, and so is any placeholder boundary at
 * which an argument could complete it.
 */
export function hasShellSubstitution(template: string): boolean {
  return template.includes(SHELL_BLOCK_MARKER) || SHELL_BLOCK_AT_PLACEHOLDER.test(template);
}

function renderItem(fields: readonly Field[], body: string): string {
  // A block value (the agent's restrictions) starts on the next line.
  const lines = fields.map(([key, value]) =>
    value.startsWith("\n") ? `${key}:${value}` : `${key}: ${value}`,
  );
  return ["---", ...lines, "---", body, ""].join("\n");
}
