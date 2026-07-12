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
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
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
  return true;
}

function snippetLineSafe(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/<\/?(script|iframe|object|embed|style)\b/iu.test(value)) return false;
  if (/javascript:/iu.test(value)) return false;
  if (value.includes("$(") || value.includes("`") || value.includes("${CLIPBOARD}")) return false;
  return safeSnippetSyntax(value);
}

function safeSnippetSyntax(line: string): boolean {
  let depth = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "$" && line[index + 1] === "{") {
      depth += 1;
      if (depth > MAX_NESTING_DEPTH) return false;
    } else if (line[index] === "}" && depth > 0) {
      depth -= 1;
    }
  }
  if (depth !== 0) return false;
  return safeSnippetPlaceholders(line);
}

function safeSnippetPlaceholders(line: string): boolean {
  const placeholders = line.match(/\$\{([^}]*)\}/gu) ?? [];
  for (const raw of placeholders) {
    const inner = raw.slice(2, -1);
    if (inner.includes("/") || inner.includes("$(") || inner.includes("`")) return false;
    if (/^[0-9]+(?::.*)?$/u.test(inner) || /^[0-9]+\|[^|]*\|$/u.test(inner)) continue;
    if (!SAFE_VARIABLES.includes(inner as (typeof SAFE_VARIABLES)[number])) return false;
  }
  return true;
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
  return new RegExp(`^${globToRegex(pattern)}$`, "u").test(relativePath);
}

function globToRegex(pattern: string): string {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const after = pattern[index + 2];
    if (char === "*" && next === "*" && after === "/") {
      output += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      output += ".*";
      index += 1;
    } else if (char === "*") {
      output += "[^/]*";
    } else {
      output += escapeRegexChar(char ?? "");
    }
  }
  return output;
}

function escapeRegexChar(char: string): string {
  return /[.+^${}()|[\]\\]/u.test(char) ? `\\${char}` : char;
}
