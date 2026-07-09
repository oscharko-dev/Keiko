import type { LineRange, ValidationResult } from "./connected-context.js";
import { isValidLineRange, isValidScopePath } from "./connected-context.js";
import type { EditorPatchRejectionReason } from "./editor-patch-apply.js";

export type WorkspaceSearchMode = "literal" | "regex";

export const WORKSPACE_SEARCH_MODES: readonly WorkspaceSearchMode[] = ["literal", "regex"];

export interface WorkspaceSearchRequest {
  readonly root: string;
  readonly query: string;
  readonly mode: WorkspaceSearchMode;
  readonly caseSensitive: boolean;
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
const DANGEROUS_GROUP_OR_CLASS_REPETITION = /\([^)]*\)[+*{]|\[[^\]]*\][+*{]/;
const ADJACENT_QUANTIFIED_ATOMS =
  /(?:\\.|[^\\()[\]{}+*?|])(?:[+*]|\{\d+(?:,\d*)?\})(?:\\.|[^\\()[\]{}+*?|])(?:[+*]|\{\d+(?:,\d*)?\})/;

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
  if (DANGEROUS_GROUP_OR_CLASS_REPETITION.test(source)) return "query regex unsafe";
  if (ADJACENT_QUANTIFIED_ATOMS.test(source)) return "query regex unsafe";
  try {
    new RegExp(source);
  } catch {
    return "query regex invalid";
  }
  return undefined;
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
  if (!isPositiveInteger(range.startLine) || !isPositiveInteger(range.startColumn)) {
    reasons.push("edit range invalid");
  } else if (!isPositiveInteger(range.endLine) || !isPositiveInteger(range.endColumn)) {
    reasons.push("edit range invalid");
  }
  if (typeof value.originalText !== "string" || typeof value.newText !== "string") {
    reasons.push("edit text invalid");
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function validateApplyFile(value: unknown, reasons: string[]): void {
  if (!isRecord(value)) {
    reasons.push("file invalid");
    return;
  }
  if (typeof value.path !== "string" || !isRelativeWorkspacePathShape(value.path)) {
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

function isRelativeWorkspacePathShape(path: string): boolean {
  if (path.trim().length === 0 || path.includes("\0") || path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  return !path
    .split("/")
    .some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

export function validateWorkspaceSearchRequest(value: unknown): ValidationResult {
  const reasons: string[] = [];
  validateSharedRequest(value, reasons);
  if (isRecord(value) && !isPositiveIntegerWithin(value.maxResults, WORKSPACE_SEARCH_MAX_RESULTS)) {
    reasons.push("maxResults invalid");
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
    (typeof value.scopePath !== "string" || !isRelativeWorkspacePathShape(value.scopePath))
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
    isValidScopePath(value.path, { mustBeRelative: true }) &&
    isValidLineRange(value.lineRange) &&
    typeof value.snippet === "string" &&
    typeof value.score === "number" &&
    Number.isFinite(value.score) &&
    value.score >= 0 &&
    value.score <= 1
  );
}
