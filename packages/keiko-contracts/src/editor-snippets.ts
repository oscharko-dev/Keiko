import {
  EDITOR_M7_SCHEMA_VERSION,
  type EditorM7ParseResult,
  type EditorM7ReasonCode,
} from "./editor-m7.js";

export const EDITOR_M7_SNIPPET_COLLECTION_VERSION = EDITOR_M7_SCHEMA_VERSION;

export interface EditorM7SnippetProvenance {
  readonly source: "workspace";
  readonly workspaceFingerprint: string;
}

export interface EditorM7WorkspaceSnippet {
  readonly id: string;
  readonly name: string;
  readonly prefixes: readonly string[];
  readonly description: string;
  readonly languages: readonly string[];
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly body: readonly string[];
  readonly revision: number;
  readonly provenance: EditorM7SnippetProvenance;
}

export interface EditorM7WorkspaceSnippetInput {
  readonly id: string;
  readonly name: string;
  readonly prefixes: readonly string[];
  readonly description: string;
  readonly languages: readonly string[];
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly body: readonly string[];
}

export interface EditorM7WorkspaceSnippetCollection {
  readonly schemaVersion: typeof EDITOR_M7_SNIPPET_COLLECTION_VERSION;
  readonly revision: number;
  readonly snippets: readonly EditorM7WorkspaceSnippet[];
}

export interface EditorM7WorkspaceSnippetSnapshot extends EditorM7WorkspaceSnippetCollection {
  readonly storeState: "absent" | "ready" | "unavailable";
  readonly etag: string;
  readonly workspaceFingerprint: string;
}

export type EditorM7WorkspaceSnippetMutationAction = "replace" | "reset";

export interface EditorM7WorkspaceSnippetMutation {
  readonly schemaVersion: typeof EDITOR_M7_SNIPPET_COLLECTION_VERSION;
  readonly root: string;
  readonly expectedRevision: number;
  readonly action: EditorM7WorkspaceSnippetMutationAction;
  readonly snippets?: readonly EditorM7WorkspaceSnippetInput[] | undefined;
}

export type EditorM7WorkspaceSnippetMutationResult =
  | {
      readonly kind: "ok";
      readonly changed: boolean;
      readonly revision: number;
      readonly etag: string;
      readonly snapshot: EditorM7WorkspaceSnippetSnapshot;
    }
  | { readonly kind: "conflict"; readonly code: "STALE_REVISION"; readonly etag: string }
  | {
      readonly kind: "idempotencyConflict";
      readonly code: "IDEMPOTENCY_KEY_REUSED";
      readonly etag: string;
    }
  | { readonly kind: "invalid"; readonly code: EditorM7ReasonCode }
  | { readonly kind: "unavailable"; readonly code: "STATE_UNAVAILABLE" };

export interface EditorM7SnippetCompletion {
  readonly id: string;
  readonly label: string;
  readonly insertText: string;
  readonly detail: string;
  readonly sortText: string;
}

export interface EditorM7SnippetDiagnostics {
  readonly schemaVersion: typeof EDITOR_M7_SNIPPET_COLLECTION_VERSION;
  readonly revision: number;
  readonly snippetCount: number;
  readonly prefixCount: number;
  readonly bodyHash: string;
  readonly reasonCodes: readonly EditorM7ReasonCode[];
}

type UnknownRecord = Readonly<Record<string, unknown>>;

const MAX_SNIPPETS = 128;
const MAX_BODY_LINES = 64;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_PREFIXES = 8;
const MAX_PREFIX_BYTES = 64;
const MAX_LANGUAGE_SCOPES = 16;
const MAX_PATTERNS = 32;
const MAX_PATTERN_BYTES = 160;
const MAX_NESTING_DEPTH = 4;
const SAFE_VARIABLES = Object.freeze([
  "TM_FILENAME",
  "TM_FILENAME_BASE",
  "CURRENT_YEAR",
  "CURRENT_MONTH",
  "CURRENT_DATE",
] as const);
const SAFE_VARIABLE_SET = new Set<string>(SAFE_VARIABLES);
const ACTIVE_HTML_TAGS = new Set([
  "audio",
  "base",
  "button",
  "embed",
  "form",
  "iframe",
  "img",
  "input",
  "link",
  "math",
  "meta",
  "object",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "textarea",
  "track",
  "video",
]);
const UNSAFE_SNIPPET_MARKERS = Object.freeze([
  "javascript:",
  "vbscript:",
  "data:text/html",
  "data:image/svg+xml",
  "`",
]);
const SAFE_TOKEN = /^[A-Za-z0-9._:-]{1,96}$/u;
const SAFE_LANGUAGE = /^[a-z0-9][a-z0-9.+-]{0,63}$/u;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) ?? 0;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code > 0xffff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && SAFE_TOKEN.test(value);
}

function validBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && utf8ByteLength(value) <= maxBytes;
}

function validUniqueStringArray(
  value: unknown,
  maxItems: number,
  maxBytes: number,
  predicate: (entry: unknown) => entry is string,
): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!predicate(entry) || utf8ByteLength(entry) > maxBytes || seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
}

function validLanguage(value: unknown): value is string {
  return typeof value === "string" && SAFE_LANGUAGE.test(value);
}

function validPattern(value: unknown): value is string {
  if (!validBoundedString(value, MAX_PATTERN_BYTES)) return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  return !value.split("/").some((segment) => segment === "." || segment === "..");
}

function validOptionalPatterns(value: unknown): boolean {
  return (
    value === undefined ||
    validUniqueStringArray(value, MAX_PATTERNS, MAX_PATTERN_BYTES, validPattern)
  );
}

function validSnippetEnvelope(value: unknown): value is UnknownRecord {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "name",
      "prefixes",
      "description",
      "languages",
      "include",
      "exclude",
      "body",
      "revision",
      "provenance",
    ])
  );
}

function validProvenance(value: unknown): value is EditorM7SnippetProvenance {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["source", "workspaceFingerprint"]) &&
    value.source === "workspace" &&
    typeof value.workspaceFingerprint === "string" &&
    /^[a-f0-9]{16,64}$/u.test(value.workspaceFingerprint)
  );
}

function validSnippetBody(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BODY_LINES) return false;
  let totalBytes = 0;
  for (const line of value) {
    if (typeof line !== "string") return false;
    totalBytes += utf8ByteLength(line);
    if (totalBytes > MAX_BODY_BYTES || !snippetLineSafe(line)) return false;
  }
  return !containsActiveContent(value.join("\n"));
}

function snippetLineSafe(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return safeSnippetSyntax(value);
}

function safeSnippetSyntax(line: string): boolean {
  if (containsActiveContent(line)) return false;
  const cursor: SnippetCursor = { text: line, index: 0 };
  return parseSnippetSequence(cursor, 0, false) && cursor.index === line.length;
}

interface SnippetCursor {
  readonly text: string;
  index: number;
}

function parseSnippetSequence(
  cursor: SnippetCursor,
  depth: number,
  closesOnBrace: boolean,
): boolean {
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index];
    if (char === "}" && closesOnBrace) return true;
    if (char === "\\") {
      cursor.index += cursor.index + 1 < cursor.text.length ? 2 : 1;
      continue;
    }
    if (char === "$" && !parseDollarToken(cursor, depth)) return false;
    else if (char !== "$") cursor.index += 1;
  }
  return !closesOnBrace;
}

function parseDollarToken(cursor: SnippetCursor, depth: number): boolean {
  const next = cursor.text[cursor.index + 1];
  if (next === "(") return false;
  if (next === "{") {
    if (depth >= MAX_NESTING_DEPTH) return false;
    cursor.index += 2;
    return parseBracedToken(cursor, depth + 1);
  }
  if (isAsciiDigit(next)) {
    cursor.index += 2;
    consumeWhile(cursor, isAsciiDigit);
    return true;
  }
  if (isIdentifierStart(next)) {
    cursor.index += 1;
    return SAFE_VARIABLE_SET.has(consumeIdentifier(cursor));
  }
  cursor.index += 1;
  return true;
}

function parseBracedToken(cursor: SnippetCursor, depth: number): boolean {
  if (isAsciiDigit(cursor.text[cursor.index])) {
    consumeWhile(cursor, isAsciiDigit);
    const separator = cursor.text[cursor.index];
    if (separator === "}") return consumeClosingBrace(cursor);
    if (separator === ":") {
      cursor.index += 1;
      if (!parseSnippetSequence(cursor, depth, true)) return false;
      return consumeClosingBrace(cursor);
    }
    if (separator === "|") return parseChoice(cursor, depth);
    return false;
  }
  if (!isIdentifierStart(cursor.text[cursor.index])) return false;
  const variable = consumeIdentifier(cursor);
  return SAFE_VARIABLE_SET.has(variable) && consumeClosingBrace(cursor);
}

function parseChoice(cursor: SnippetCursor, depth: number): boolean {
  cursor.index += 1;
  while (cursor.index < cursor.text.length) {
    const step = parseChoiceStep(cursor, depth);
    if (step === "complete") return true;
    if (step === "invalid") return false;
  }
  return false;
}

type SnippetChoiceStep = "continue" | "complete" | "invalid";

function parseChoiceStep(cursor: SnippetCursor, depth: number): SnippetChoiceStep {
  const char = cursor.text[cursor.index];
  if (char === "\\") {
    if (cursor.index + 1 >= cursor.text.length) return "invalid";
    cursor.index += 2;
    return "continue";
  }
  if (char === "|") {
    if (cursor.text[cursor.index + 1] !== "}") return "invalid";
    cursor.index += 2;
    return "complete";
  }
  if (char === "}") return "invalid";
  if (char === "$" && !parseDollarToken(cursor, depth)) return "invalid";
  if (char !== "$") cursor.index += 1;
  return "continue";
}

function consumeClosingBrace(cursor: SnippetCursor): boolean {
  if (cursor.text[cursor.index] !== "}") return false;
  cursor.index += 1;
  return true;
}

function consumeIdentifier(cursor: SnippetCursor): string {
  const start = cursor.index;
  consumeWhile(cursor, isIdentifierPart);
  return cursor.text.slice(start, cursor.index);
}

function consumeWhile(
  cursor: SnippetCursor,
  predicate: (char: string | undefined) => boolean,
): void {
  while (predicate(cursor.text[cursor.index])) cursor.index += 1;
}

function isAsciiDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function isIdentifierStart(char: string | undefined): boolean {
  return (
    char !== undefined &&
    ((char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_")
  );
}

function isIdentifierPart(char: string | undefined): boolean {
  return isIdentifierStart(char) || isAsciiDigit(char);
}

function containsActiveContent(line: string): boolean {
  const lower = line.toLowerCase();
  if (UNSAFE_SNIPPET_MARKERS.some((marker) => lower.includes(marker))) return true;
  if (containsActiveHtml(lower)) return true;
  return containsUnescapedMarkdownImage(line);
}

function containsActiveHtml(lower: string): boolean {
  let start = lower.indexOf("<");
  while (start >= 0) {
    const end = lower.indexOf(">", start + 1);
    const nested = lower.indexOf("<", start + 1);
    if (nested >= 0 && (end < 0 || nested < end)) {
      start = nested;
      continue;
    }
    const tag = lower.slice(start + 1, end < 0 ? lower.length : end);
    const name = htmlTagName(tag);
    if (ACTIVE_HTML_TAGS.has(name) || containsActiveHtmlAttribute(tag)) return true;
    if (end < 0) return false;
    start = lower.indexOf("<", end + 1);
  }
  return false;
}

function htmlTagName(tag: string): string {
  let index = tag.startsWith("/") ? 1 : 0;
  while (isHtmlWhitespace(tag[index])) index += 1;
  const start = index;
  while (isIdentifierPart(tag[index]) || tag[index] === "-") index += 1;
  return tag.slice(start, index);
}

function containsActiveHtmlAttribute(tag: string): boolean {
  for (let index = 0; index < tag.length - 2; index += 1) {
    if (activeHtmlAttributeAt(tag, index)) return true;
  }
  return false;
}

function activeHtmlAttributeAt(tag: string, index: number): boolean {
  const boundary = index === 0 || isHtmlWhitespace(tag[index - 1]) || tag[index - 1] === "/";
  if (!boundary) return false;
  let end = index;
  while (isIdentifierPart(tag[end]) || tag[end] === "-") end += 1;
  const name = tag.slice(index, end);
  if (name !== "srcdoc" && !(name.startsWith("on") && name.length > 2)) return false;
  while (isHtmlWhitespace(tag[end])) end += 1;
  return tag[end] === "=";
}

function isHtmlWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

function containsUnescapedMarkdownImage(line: string): boolean {
  for (let index = 0; index < line.length - 1; index += 1) {
    if (line[index] !== "!" || line[index + 1] !== "[") continue;
    let escapes = 0;
    for (let previous = index - 1; previous >= 0 && line[previous] === "\\"; previous -= 1) {
      escapes += 1;
    }
    if (escapes % 2 === 0) return true;
  }
  return false;
}

function validSnippetIdentity(value: UnknownRecord): boolean {
  if (!validToken(value.id) || !validBoundedString(value.name, 128)) {
    return false;
  }
  if (!validUniqueStringArray(value.prefixes, MAX_PREFIXES, MAX_PREFIX_BYTES, validToken)) {
    return false;
  }
  return validBoundedString(value.description, 256);
}

function validSnippetLanguageScope(value: UnknownRecord): boolean {
  return validUniqueStringArray(value.languages, MAX_LANGUAGE_SCOPES, 64, validLanguage);
}

function validSnippetRevisionAndProvenance(value: UnknownRecord): boolean {
  return validRevision(value.revision) && validProvenance(value.provenance);
}

function parseSnippet(value: unknown): EditorM7ParseResult<EditorM7WorkspaceSnippet> {
  if (!validSnippetEnvelope(value) || !validSnippetIdentity(value)) {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
  if (!validSnippetLanguageScope(value)) return { ok: false, reasonCode: "INVALID_INPUT" };
  if (!validOptionalPatterns(value.include) || !validOptionalPatterns(value.exclude)) {
    return { ok: false, reasonCode: "UNSAFE_PATH" };
  }
  if (!validSnippetBody(value.body)) return { ok: false, reasonCode: "UNSAFE_SNIPPET" };
  if (!validSnippetRevisionAndProvenance(value)) {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
  return { ok: true, value: value as unknown as EditorM7WorkspaceSnippet };
}

export function parseEditorM7WorkspaceSnippetCollection(
  value: unknown,
): EditorM7ParseResult<EditorM7WorkspaceSnippetCollection> {
  try {
    return parseCollectionUnsafe(value);
  } catch {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
}

function parseCollectionUnsafe(
  value: unknown,
): EditorM7ParseResult<EditorM7WorkspaceSnippetCollection> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "revision", "snippets"])) {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
  if (value.schemaVersion !== EDITOR_M7_SNIPPET_COLLECTION_VERSION) {
    return { ok: false, reasonCode: "SCHEMA_VERSION_UNSUPPORTED" };
  }
  if (!validRevision(value.revision) || !Array.isArray(value.snippets)) {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
  if (value.snippets.length > MAX_SNIPPETS) return { ok: false, reasonCode: "OVERSIZED" };
  const snippets: EditorM7WorkspaceSnippet[] = [];
  for (const candidate of value.snippets) {
    const parsed = parseSnippet(candidate);
    if (!parsed.ok) return parsed;
    snippets.push(parsed.value);
  }
  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
      revision: value.revision,
      snippets: Object.freeze(snippets),
    },
  };
}

export function compileEditorM7SnippetBody(body: readonly string[]): EditorM7ParseResult<string> {
  if (!validSnippetBody(body)) return { ok: false, reasonCode: "UNSAFE_SNIPPET" };
  const text = body.join("\n");
  return { ok: true, value: text.includes("$0") ? text : `${text}$0` };
}

export function editorM7SnippetDiagnostics(
  collection: EditorM7WorkspaceSnippetCollection,
  bodyHash: string,
): EditorM7SnippetDiagnostics {
  return {
    schemaVersion: collection.schemaVersion,
    revision: collection.revision,
    snippetCount: collection.snippets.length,
    prefixCount: collection.snippets.reduce((total, snippet) => total + snippet.prefixes.length, 0),
    bodyHash,
    reasonCodes: [],
  };
}

export function matchingEditorM7Snippets(args: {
  readonly collection: EditorM7WorkspaceSnippetCollection;
  readonly languageId: string;
  readonly relativePath: string;
  readonly prefix: string;
  readonly insertionSafe: boolean;
  readonly signal?: AbortSignal | undefined;
}): readonly EditorM7SnippetCompletion[] {
  if (!args.insertionSafe || args.signal?.aborted === true) return [];
  const prefix = args.prefix.toLowerCase();
  const matches = args.collection.snippets.flatMap((snippet) =>
    snippetMatches(snippet, args.languageId, args.relativePath, prefix)
      ? [snippetCompletion(snippet)]
      : [],
  );
  return [...dedupeSnippetCompletions(matches)].sort((left, right) =>
    left.sortText.localeCompare(right.sortText),
  );
}

function snippetMatches(
  snippet: EditorM7WorkspaceSnippet,
  languageId: string,
  relativePath: string,
  prefix: string,
): boolean {
  if (!snippet.languages.includes(languageId)) return false;
  if (!snippet.prefixes.some((candidate) => candidate.toLowerCase().startsWith(prefix))) {
    return false;
  }
  if (snippet.exclude?.some((pattern) => globMatches(pattern, relativePath)) === true) return false;
  if (snippet.include === undefined || snippet.include.length === 0) return true;
  return snippet.include.some((pattern) => globMatches(pattern, relativePath));
}

function snippetCompletion(snippet: EditorM7WorkspaceSnippet): EditorM7SnippetCompletion {
  const compiled = compileEditorM7SnippetBody(snippet.body);
  const insertText = compiled.ok ? compiled.value : "";
  return {
    id: snippet.id,
    label: snippet.prefixes[0] ?? snippet.name,
    insertText,
    detail: `Workspace snippet: ${snippet.name}`,
    sortText: `1-snippet-${snippet.name.toLowerCase()}-${snippet.id}`,
  };
}

function dedupeSnippetCompletions(
  completions: readonly EditorM7SnippetCompletion[],
): readonly EditorM7SnippetCompletion[] {
  const seen = new Set<string>();
  return completions.filter((completion) => {
    const key = completion.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function globMatches(pattern: string, relativePath: string): boolean {
  const tokens = tokenizeGlob(pattern);
  let states = globEpsilonClosure(new Set([0]), tokens);
  for (const char of Array.from(relativePath)) {
    const nextStates = new Set<number>();
    for (const state of states) {
      advanceGlobState(tokens, state, char, nextStates);
    }
    states = globEpsilonClosure(nextStates, tokens);
    if (states.size === 0) return false;
  }
  return globEpsilonClosure(states, tokens).has(tokens.length);
}

type GlobTokenKind =
  "literal" | "segment-star" | "globstar" | "globstar-directory" | "globstar-directory-tail";

interface GlobToken {
  readonly kind: GlobTokenKind;
  readonly value?: string | undefined;
}

function tokenizeGlob(pattern: string): readonly GlobToken[] {
  const chars = Array.from(pattern);
  const tokens: GlobToken[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] !== "*") {
      tokens.push({ kind: "literal", value: chars[index] });
      continue;
    }
    if (chars[index + 1] !== "*") {
      tokens.push({ kind: "segment-star" });
      continue;
    }
    if (chars[index + 2] === "/") {
      tokens.push({ kind: "globstar-directory" }, { kind: "globstar-directory-tail" });
      index += 2;
      continue;
    }
    tokens.push({ kind: "globstar" });
    index += 1;
  }
  return tokens;
}

function globEpsilonClosure(seed: ReadonlySet<number>, tokens: readonly GlobToken[]): Set<number> {
  const closure = new Set(seed);
  const pending = [...seed];
  for (const state of pending) {
    const token = tokens[state];
    const next = token?.kind === "globstar-directory" ? state + 2 : state + 1;
    if (
      token !== undefined &&
      token.kind !== "literal" &&
      token.kind !== "globstar-directory-tail" &&
      !closure.has(next)
    ) {
      closure.add(next);
      pending.push(next);
    }
  }
  return closure;
}

function advanceGlobstarDirectory(state: number, char: string, nextStates: Set<number>): void {
  nextStates.add(state + 1);
  if (char === "/") nextStates.add(state + 2);
}

function advanceGlobState(
  tokens: readonly GlobToken[],
  state: number,
  char: string,
  nextStates: Set<number>,
): void {
  const token = tokens[state];
  switch (token?.kind) {
    case "literal":
      if (token.value === char) nextStates.add(state + 1);
      return;
    case "segment-star":
      if (char !== "/") nextStates.add(state);
      return;
    case "globstar":
      nextStates.add(state);
      return;
    case "globstar-directory":
      advanceGlobstarDirectory(state, char, nextStates);
      return;
    case "globstar-directory-tail":
      nextStates.add(state);
      if (char === "/") nextStates.add(state + 1);
      return;
    default:
      return;
  }
}
