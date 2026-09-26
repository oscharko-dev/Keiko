import type {
  ContextCoverageTruncationReason,
  LineRange,
  ValidationResult,
} from "./connected-context.js";
import { isValidLineRange, isValidScopePath } from "./connected-context.js";
import type { EditorPatchRejectionReason } from "./editor-patch-apply.js";

declare global {
  interface RegExpConstructor {
    escape(value: string): string;
  }
}

export type WorkspaceSearchMode = "literal" | "regex";

export const WORKSPACE_SEARCH_MODES: readonly WorkspaceSearchMode[] = Object.freeze([
  "literal",
  "regex",
]);

export interface WorkspaceSearchRequest {
  readonly root: string;
  readonly scopePath?: string | undefined;
  readonly query: string;
  readonly mode: WorkspaceSearchMode;
  readonly caseSensitive: boolean;
  readonly wholeWord?: boolean | undefined;
  readonly includeGlobs: readonly string[];
  readonly excludeGlobs: readonly string[];
  readonly maxResults: number;
}

export interface WorkspaceSearchResultMatch {
  readonly path: string;
  readonly lineRange: LineRange;
  readonly snippet: string;
  readonly score: number;
}

export interface WorkspaceSearchResponse {
  readonly results: readonly WorkspaceSearchResultMatch[];
  readonly truncated: boolean;
  readonly filesScanned: number;
  readonly elapsedMs: number;
}

export interface WorkspaceSymbolSearchRequest {
  readonly root: string;
  readonly query: string;
  readonly maxResults: number;
  readonly scopePath?: string | undefined;
}

export interface WorkspaceSymbolSearchResult {
  readonly symbol: string;
  readonly kind: SymbolDefinitionKind;
  readonly path: string;
  readonly line: number;
  readonly score: number;
  readonly enclosingSymbol?: string | undefined;
}

export interface WorkspaceSymbolSearchResponse {
  readonly results: readonly WorkspaceSymbolSearchResult[];
  readonly truncated: boolean;
  readonly filesScanned: number;
  readonly elapsedMs: number;
}

export type SymbolDefinitionKind =
  "function" | "class" | "interface" | "type" | "enum" | "variable";

export interface WorkspaceReplacePreviewRequest {
  readonly root: string;
  readonly query: string;
  readonly mode: WorkspaceSearchMode;
  readonly caseSensitive: boolean;
  readonly includeGlobs: readonly string[];
  readonly excludeGlobs: readonly string[];
  readonly replacement: string;
  readonly maxFiles: number;
}

export interface WorkspaceReplacePreviewTextRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface WorkspaceReplacePreviewEdit {
  readonly range: WorkspaceReplacePreviewTextRange;
  readonly originalText: string;
  readonly newText: string;
}

export interface WorkspaceReplacePreviewFileEdit {
  readonly path: string;
  readonly baseContentHash: string;
  readonly edits: readonly WorkspaceReplacePreviewEdit[];
}

export interface WorkspaceReplacePreviewResponse {
  readonly files: readonly WorkspaceReplacePreviewFileEdit[];
  readonly fileCount: number;
  readonly editCount: number;
  readonly truncated: boolean;
  readonly omittedFileCount: number;
  // KEIKO-0645/KEIKO-0645-r3: distinguishes the cause of `truncated`. `omittedFileCount` counts
  // files that matched the query but were dropped by the per-request `maxFiles` cap inside
  // buildReplacePreviewFiles -- a precise "replace-file-omitted" signal. `searchTruncationReasons`
  // is the upstream `searchText` coverage cause list (see `ContextCoverageTruncationReason`): it
  // covers bounded-search exits generally, not just a distinct matching file being dropped -- for
  // example "match-cap" fires when the overall match budget is exhausted while still inside one
  // already-enumerated file, with no other matching file omitted. A caller that wants "was a
  // distinct matching file left out of the upstream search" checks
  // `searchTruncationReasons.includes("file-cap")`, not the presence of any reason. An empty array
  // means the upstream search itself did not truncate; `truncated` is still the union with
  // `omittedFileCount > 0`.
  readonly searchTruncationReasons: readonly ContextCoverageTruncationReason[];
}

export interface WorkspaceReplaceApplyFile {
  readonly path: string;
  readonly baseContentHash: string;
  readonly edits: readonly WorkspaceReplacePreviewEdit[];
}

export interface WorkspaceReplaceApplyRequest {
  readonly root: string;
  readonly files: readonly WorkspaceReplaceApplyFile[];
}

export interface WorkspaceReplaceApplyConflict {
  readonly path: string;
  readonly reason: EditorPatchRejectionReason;
  readonly detail: string;
}

export interface WorkspaceReplaceApplyResponse {
  readonly appliedCount: number;
  readonly conflictCount: number;
  readonly conflicts: readonly WorkspaceReplaceApplyConflict[];
}

const MAX_QUERY_LENGTH = 200;
const MAX_REPLACEMENT_BYTES = 64 * 1024;
const MAX_GLOBS = 32;
const MAX_GLOB_LENGTH = 200;
export const WORKSPACE_SEARCH_MAX_RESULTS = 200;
export const WORKSPACE_REPLACE_MAX_FILES = 200;
const TEXT_ENCODER = new TextEncoder();
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const REGEX_META_CHARS = new Set(["\\", "(", ")", "[", "]", "{", "}", "+", "*", "?", "|"]);
const GROUP_OR_CLASS_QUANTIFIER_CHARS = new Set(["+", "*", "{"]);

/**
 * Does `source` contain an `open`-delimited run (no nested `open`/`close` tracking needed, since a
 * negated class or `[^)]`-shaped group content can never consume its own `close` delimiter, so the
 * *first* `close` after any `open` is always the only candidate end for it) immediately followed by
 * a repetition quantifier? A single left-to-right scan tracks "have we seen an unresolved open
 * since the last close" and settles it in one pass, with no possibility of backtracking.
 */
function hasQuantifiedDelimiterPair(source: string, open: string, close: string): boolean {
  let isOpen = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === open) {
      isOpen = true;
    } else if (char === close) {
      if (isOpen && GROUP_OR_CLASS_QUANTIFIER_CHARS.has(source[index + 1] ?? "")) {
        return true;
      }
      isOpen = false;
    }
  }
  return false;
}

/**
 * Plain-JS equivalent of the old `/\([^)]*\)[+*{]|\[[^\]]*\][+*{]/` check: does `source` contain a
 * parenthesized group or bracketed class immediately followed by a repetition quantifier (e.g.
 * `(a+)+` or `[abc]+{2}`)? The old regex cost O(n^2) in the worst case, because it is unanchored
 * (every start position is retried) and a backtracking engine mechanically retries every possible
 * run length before concluding a required-but-absent delimiter can't be reached, even though
 * logically only one attempt was ever necessary.
 */
export function hasDangerousGroupOrClassRepetition(source: string): boolean {
  return (
    hasQuantifiedDelimiterPair(source, "(", ")") || hasQuantifiedDelimiterPair(source, "[", "]")
  );
}

function atomEnd(source: string, start: number): number | undefined {
  const char = source[start];
  if (char === "\\") {
    const escaped = source[start + 1];
    if (
      escaped === undefined ||
      escaped === "\n" ||
      escaped === "\r" ||
      escaped === "\u2028" ||
      escaped === "\u2029"
    ) {
      return undefined;
    }
    return start + 2;
  }
  return char === undefined || REGEX_META_CHARS.has(char) ? undefined : start + 1;
}

function isAsciiDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function boundedQuantifierEnd(source: string, start: number): number | undefined {
  let cursor = start + 1;
  const digitStart = cursor;
  while (isAsciiDigit(source[cursor])) cursor += 1;
  if (cursor === digitStart) return undefined;
  if (source[cursor] === ",") {
    cursor += 1;
    while (isAsciiDigit(source[cursor])) cursor += 1;
  }
  return source[cursor] === "}" ? cursor + 1 : undefined;
}

function quantifierEnd(source: string, start: number): number | undefined {
  const char = source[start];
  if (char === "+" || char === "*") return start + 1;
  return char === "{" ? boundedQuantifierEnd(source, start) : undefined;
}

function hasAdjacentQuantifiedAtoms(source: string): boolean {
  for (let start = 0; start < source.length; start += 1) {
    const firstAtomEnd = atomEnd(source, start);
    if (firstAtomEnd === undefined) continue;
    const firstQuantifierEnd = quantifierEnd(source, firstAtomEnd);
    if (firstQuantifierEnd === undefined) continue;
    const secondAtomEnd = atomEnd(source, firstQuantifierEnd);
    if (secondAtomEnd === undefined) continue;
    if (quantifierEnd(source, secondAtomEnd) !== undefined) return true;
  }
  return false;
}

interface GroupScan {
  readonly end: number;
  readonly containsRepetition: boolean;
}

function characterClassEnd(source: string, start: number): number | undefined {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
    } else if (source[cursor] === "]") {
      return cursor + 1;
    } else {
      cursor += 1;
    }
  }
  return undefined;
}

function adjustedGroupDepth(depth: number, char: string | undefined): number {
  if (char === "(") return depth + 1;
  if (char === ")") return depth - 1;
  return depth;
}

function isRepetitionStart(source: string, cursor: number): boolean {
  const char = source[cursor];
  return char === "+" || char === "*" || boundedQuantifierEnd(source, cursor) !== undefined;
}

function scanGroup(source: string, start: number): GroupScan | undefined {
  if (source[start] !== "(") return undefined;
  let depth = 1;
  let containsRepetition = false;
  let cursor = start + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "[") {
      const end = characterClassEnd(source, cursor);
      if (end === undefined) return undefined;
      cursor = end;
      continue;
    }
    depth = adjustedGroupDepth(depth, char);
    if (depth === 0) return { end: cursor + 1, containsRepetition };
    if (isRepetitionStart(source, cursor)) containsRepetition = true;
    cursor += 1;
  }
  return undefined;
}

function hasConcatenatedQuantifiedGroups(source: string): boolean {
  let start = 0;
  while (start < source.length) {
    if (source[start] === "\\") {
      start += 2;
      continue;
    }
    if (source[start] === "[") {
      const end = characterClassEnd(source, start);
      if (end === undefined) return false;
      start = end;
      continue;
    }
    const first = scanGroup(source, start);
    if (first?.containsRepetition === true) {
      const second = scanGroup(source, first.end);
      if (second?.containsRepetition === true) return true;
    }
    start += 1;
  }
  return false;
}

function buildResult(reasons: readonly string[]): ValidationResult {
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyTrimmed(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveIntegerWithin(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max;
}

function utf8ByteLength(value: string): number {
  return TEXT_ENCODER.encode(value).length;
}

/**
 * Canonical ReDoS gate for every regex constructed from user-supplied search/replace input.
 * `keiko-workspace`'s `repoSearchRegexSafety.ts` re-exports this function rather than keeping
 * a second copy, so the two search surfaces (agent-context `repoSearch` and this user-facing
 * workspace search) cannot drift apart on catastrophic-backtracking detection.
 */
export function regexSafetyIssue(source: string): string | undefined {
  if (source.length > MAX_QUERY_LENGTH) return "query regex too long";
  if (hasDangerousGroupOrClassRepetition(source)) return "query regex unsafe";
  if (hasAdjacentQuantifiedAtoms(source)) return "query regex unsafe";
  if (hasConcatenatedQuantifiedGroups(source)) return "query regex unsafe";
  const safeSource = safeRegexSource(source);
  if (safeSource === undefined) return "query regex invalid";
  try {
    new RegExp(safeSource);
  } catch {
    return "query regex invalid";
  }
  return undefined;
}

function regexEscapeToken(character: string): string | undefined {
  switch (character) {
    case "b":
      return String.raw`\b`;
    case "B":
      return String.raw`\B`;
    case "d":
      return String.raw`\d`;
    case "D":
      return String.raw`\D`;
    case "s":
      return String.raw`\s`;
    case "S":
      return String.raw`\S`;
    case "w":
      return String.raw`\w`;
    case "W":
      return String.raw`\W`;
    default:
      return undefined;
  }
}

function regexOperatorToken(character: string): string | undefined {
  switch (character) {
    case ".":
      return ".";
    case "(":
      return "(";
    case ")":
      return ")";
    case "*":
      return "*";
    case "+":
      return "+";
    case "?":
      return "?";
    case "^":
      return "^";
    case "$":
      return "$";
    default:
      return undefined;
  }
}

interface SafeRegexCharacterClass {
  readonly end: number;
  readonly source: string;
}

function safeRegexCharacterClass(
  source: string,
  start: number,
): SafeRegexCharacterClass | undefined {
  let output = "[";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === "]") return { end: index, source: `${output}]` };
    if (character === "\\") {
      const escapedCharacter = source[index + 1];
      if (escapedCharacter === undefined) return undefined;
      output += regexEscapeToken(escapedCharacter) ?? RegExp.escape(escapedCharacter);
      index += 1;
    } else if (character === "^" && index === start + 1) {
      output += "^";
    } else {
      output += RegExp.escape(character);
    }
  }
  return undefined;
}

function safeRegexSource(source: string): string | undefined {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (source.startsWith("(?:", index)) {
      output += "(?:";
      index += 3;
      continue;
    }
    if (character === "[") {
      const characterClass = safeRegexCharacterClass(source, index);
      if (characterClass === undefined) return undefined;
      output += characterClass.source;
      index = characterClass.end + 1;
      continue;
    }
    if (character === "\\") {
      const escapedCharacter = source[index + 1];
      if (escapedCharacter === undefined) return undefined;
      output += regexEscapeToken(escapedCharacter) ?? RegExp.escape(escapedCharacter);
      index += 1;
    } else {
      output += regexOperatorToken(character) ?? RegExp.escape(character);
    }
    index += 1;
  }
  return output;
}

/**
 * Compiles the supported, ReDoS-checked workspace-search grammar without ever passing the raw
 * request text to the RegExp constructor. Unsupported metacharacters are literal search text.
 */
export function compileSafeWorkspaceSearchRegex(source: string, caseSensitive: boolean): RegExp {
  const issue = regexSafetyIssue(source);
  if (issue !== undefined) throw new TypeError(issue);
  const safeSource = safeRegexSource(source);
  if (safeSource === undefined) throw new TypeError("query regex invalid");
  return new RegExp(safeSource, caseSensitive ? "g" : "gi");
}

function validateRoot(root: unknown, reasons: string[]): void {
  if (!isNonEmptyTrimmed(root)) {
    reasons.push("root empty");
  }
}

function validateQuery(query: unknown, mode: unknown, reasons: string[]): void {
  if (!isNonEmptyTrimmed(query)) {
    reasons.push("query empty");
    return;
  }
  if (query.length > MAX_QUERY_LENGTH) {
    reasons.push("query too long");
  }
  if (mode === "regex") {
    const issue = regexSafetyIssue(query);
    if (issue !== undefined) reasons.push(issue);
  }
}

function validateGlob(pattern: string, field: string, reasons: string[]): void {
  if (pattern.trim().length === 0 || pattern.length > MAX_GLOB_LENGTH) {
    reasons.push(`${field} invalid`);
  }
  if (pattern.includes("\0") || pattern.startsWith("/") || pattern.includes("\\")) {
    reasons.push(`${field} invalid`);
  }
  if (pattern.split("/").some((segment) => segment === "." || segment === "..")) {
    reasons.push(`${field} invalid`);
  }
}

function validateGlobs(value: unknown, field: string, reasons: string[]): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    reasons.push(`${field} invalid`);
    return;
  }
  if (value.length > MAX_GLOBS) {
    reasons.push(`${field} too many`);
  }
  const patterns: readonly string[] = value;
  for (const pattern of patterns) {
    validateGlob(pattern, field, reasons);
  }
}

function validateSharedRequest(value: unknown, reasons: string[]): void {
  if (!isRecord(value)) {
    reasons.push("request invalid");
    return;
  }
  validateRoot(value.root, reasons);
  if (!WORKSPACE_SEARCH_MODES.includes(value.mode as WorkspaceSearchMode)) {
    reasons.push("mode invalid");
  }
  validateQuery(value.query, value.mode, reasons);
  if (typeof value.caseSensitive !== "boolean") {
    reasons.push("caseSensitive invalid");
  }
  validateGlobs(value.includeGlobs, "includeGlobs", reasons);
  validateGlobs(value.excludeGlobs, "excludeGlobs", reasons);
}

function validateReplaceEdit(value: unknown, reasons: string[]): void {
  if (!isRecord(value) || !isRecord(value.range)) {
    reasons.push("edit invalid");
    return;
  }
  const range = value.range;
  // The four bounds and their ORDERING are one rule with one reason string: each bound was
  // previously checked in isolation, so a backwards range reached the patch applier, which would
  // slice from a start position after its end. The sibling isValidLineRange in connected-context.ts
  // already enforces this ordering for line ranges; an out-of-order range is malformed and is
  // rejected, never silently swapped.
  if (!isWellFormedEditRange(range)) {
    reasons.push("edit range invalid");
  }
  if (typeof value.originalText !== "string" || typeof value.newText !== "string") {
    reasons.push("edit text invalid");
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isWellFormedEditRange(range: Record<string, unknown>): boolean {
  if (
    !isPositiveInteger(range.startLine) ||
    !isPositiveInteger(range.startColumn) ||
    !isPositiveInteger(range.endLine) ||
    !isPositiveInteger(range.endColumn)
  ) {
    return false;
  }
  return !isBackwardsRange(range.startLine, range.startColumn, range.endLine, range.endColumn);
}

// A zero-width range (end === start) is a legal insertion point and stays accepted.
function isBackwardsRange(
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
): boolean {
  if (endLine < startLine) return true;
  return endLine === startLine && endColumn < startColumn;
}

function validateApplyFile(value: unknown, reasons: string[]): void {
  if (!isRecord(value)) {
    reasons.push("file invalid");
    return;
  }
  if (!isNonEmptyTrimmed(value.path) || !isValidScopePath(value.path, { mustBeRelative: true })) {
    reasons.push("file path invalid");
  }
  if (typeof value.baseContentHash !== "string" || !SHA256_HEX.test(value.baseContentHash)) {
    reasons.push("file baseContentHash invalid");
  }
  if (!Array.isArray(value.edits) || value.edits.length === 0) {
    reasons.push("file edits invalid");
    return;
  }
  for (const edit of value.edits) validateReplaceEdit(edit, reasons);
}

export function validateWorkspaceSearchRequest(value: unknown): ValidationResult {
  const reasons: string[] = [];
  validateSharedRequest(value, reasons);
  if (isRecord(value)) {
    if (!isPositiveIntegerWithin(value.maxResults, WORKSPACE_SEARCH_MAX_RESULTS)) {
      reasons.push("maxResults invalid");
    }
    if (value.wholeWord !== undefined && typeof value.wholeWord !== "boolean") {
      reasons.push("wholeWord invalid");
    }
    if (
      value.scopePath !== undefined &&
      (!isNonEmptyTrimmed(value.scopePath) ||
        !isValidScopePath(value.scopePath, { mustBeRelative: true }))
    ) {
      reasons.push("scopePath invalid");
    }
  }
  return buildResult(reasons);
}

export function validateWorkspaceSymbolSearchRequest(value: unknown): ValidationResult {
  const reasons: string[] = [];
  if (!isRecord(value)) {
    reasons.push("request invalid");
    return buildResult(reasons);
  }
  validateRoot(value.root, reasons);
  validateQuery(value.query, "literal", reasons);
  if (!isPositiveIntegerWithin(value.maxResults, WORKSPACE_SEARCH_MAX_RESULTS)) {
    reasons.push("maxResults invalid");
  }
  if (
    value.scopePath !== undefined &&
    (!isNonEmptyTrimmed(value.scopePath) ||
      !isValidScopePath(value.scopePath, { mustBeRelative: true }))
  ) {
    reasons.push("scopePath invalid");
  }
  return buildResult(reasons);
}

export function validateWorkspaceReplacePreviewRequest(value: unknown): ValidationResult {
  const reasons: string[] = [];
  validateSharedRequest(value, reasons);
  if (isRecord(value)) {
    if (typeof value.replacement !== "string") {
      reasons.push("replacement invalid");
    } else if (utf8ByteLength(value.replacement) > MAX_REPLACEMENT_BYTES) {
      reasons.push("replacement too large");
    }
    if (!isPositiveIntegerWithin(value.maxFiles, WORKSPACE_REPLACE_MAX_FILES)) {
      reasons.push("maxFiles invalid");
    }
  }
  return buildResult(reasons);
}

export function validateWorkspaceReplaceApplyRequest(value: unknown): ValidationResult {
  const reasons: string[] = [];
  if (!isRecord(value)) {
    reasons.push("request invalid");
    return buildResult(reasons);
  }
  validateRoot(value.root, reasons);
  if (!Array.isArray(value.files) || value.files.length === 0) {
    reasons.push("files invalid");
  } else if (value.files.length > WORKSPACE_REPLACE_MAX_FILES) {
    reasons.push("files too many");
  } else {
    for (const file of value.files) validateApplyFile(file, reasons);
  }
  return buildResult(reasons);
}

export function isWorkspaceSearchResultMatch(value: unknown): value is WorkspaceSearchResultMatch {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyTrimmed(value.path) &&
    isValidScopePath(value.path, { mustBeRelative: true }) &&
    isValidLineRange(value.lineRange) &&
    typeof value.snippet === "string" &&
    typeof value.score === "number" &&
    Number.isFinite(value.score) &&
    value.score >= 0 &&
    value.score <= 1
  );
}
