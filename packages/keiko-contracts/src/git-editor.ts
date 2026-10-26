// Editor Git read contracts (Issue #2227, Epic #2093, ADR-0127). These bounded wire shapes lift
// the existing client-only unified-diff vocabulary into the contracts leaf and add the structured
// diff/blame metadata consumed by later route, bridge, renderer, and agent-context issues.
// Leaf-package rule (ADR-0019): no @oscharko-dev/keiko-* imports; pure types + guards only.

export const GIT_EDITOR_SCHEMA_VERSION = "1" as const;

// The byte/file limits deliberately match diffParser.ts and DEFAULT_PATCH_PREVIEW_LIMITS. The
// structural caps additionally prevent one pathological file or hunk from monopolizing the UI.
export const GIT_EDITOR_DIFF_MAX_BYTES = 512 * 1024;
export const GIT_EDITOR_DIFF_MAX_FILES = 400;
export const GIT_EDITOR_DIFF_MAX_HUNKS_PER_FILE = 256;
export const GIT_EDITOR_DIFF_MAX_LINES_PER_HUNK = 2_048;
export const GIT_EDITOR_DIFF_MAX_HEADER_CHARS = 512;
export const GIT_EDITOR_DIFF_MAX_LINE_CHARS = 16_384;
export const GIT_EDITOR_PATH_MAX_BYTES = 4_096;

export const GIT_EDITOR_BLAME_MAX_BYTES = 256 * 1024;
export const GIT_EDITOR_BLAME_MAX_LINES = 2_000;
export const GIT_EDITOR_BLAME_AUTHOR_MAX_CHARS = 256;
export const GIT_EDITOR_BLAME_SUMMARY_MAX_CHARS = 512;

// Shared agent-context projection limits (Issues #2234/#2298). The passive CodingContextPack and
// active editor_git_context tool use one policy so an on-demand read cannot bypass the model-facing
// file/hunk/blame ceilings merely by choosing the tool path.
export const GIT_AGENT_CONTEXT_MAX_FILES = 8;
export const GIT_AGENT_CONTEXT_MAX_HUNKS = 16;
export const GIT_AGENT_CONTEXT_MAX_BLAME_LINES = 32;
export const GIT_AGENT_CONTEXT_MAX_RESULT_BYTES = 192 * 1024;

export type GitEditorDiffScope = "staged" | "unstaged";
export type GitEditorDiffLayer = "staged" | "worktree";
export type GitEditorDiffLineKind = "ctx" | "add" | "del" | "meta";
export type GitEditorDiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export const GIT_EDITOR_DIFF_SCOPES: readonly GitEditorDiffScope[] = Object.freeze([
  "staged",
  "unstaged",
] as const satisfies readonly GitEditorDiffScope[]);

export const GIT_EDITOR_DIFF_LAYERS: readonly GitEditorDiffLayer[] = Object.freeze([
  "staged",
  "worktree",
] as const satisfies readonly GitEditorDiffLayer[]);

export const GIT_EDITOR_DIFF_LINE_KINDS: readonly GitEditorDiffLineKind[] = Object.freeze([
  "ctx",
  "add",
  "del",
  "meta",
] as const satisfies readonly GitEditorDiffLineKind[]);

export const GIT_EDITOR_DIFF_FILE_STATUSES: readonly GitEditorDiffFileStatus[] = Object.freeze([
  "added",
  "modified",
  "deleted",
  "renamed",
] as const satisfies readonly GitEditorDiffFileStatus[]);

export interface GitEditorDiffLine {
  readonly kind: GitEditorDiffLineKind;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
}

export interface GitEditorDiffHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly GitEditorDiffLine[];
  readonly truncated: boolean;
}

export interface GitEditorDiffFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly layer: GitEditorDiffLayer;
  readonly status: GitEditorDiffFileStatus;
  readonly binary: boolean;
  readonly hunks: readonly GitEditorDiffHunk[];
  readonly addedLines: number;
  readonly removedLines: number;
  readonly truncated: boolean;
}

export interface GitEditorDiffRequest {
  readonly schemaVersion: typeof GIT_EDITOR_SCHEMA_VERSION;
  readonly scope: GitEditorDiffScope;
  readonly path?: string | undefined;
}

export interface GitEditorDiffResponse {
  readonly schemaVersion: typeof GIT_EDITOR_SCHEMA_VERSION;
  readonly scope: GitEditorDiffScope;
  readonly files: readonly GitEditorDiffFile[];
  readonly truncated: boolean;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly maxBytes: typeof GIT_EDITOR_DIFF_MAX_BYTES;
  readonly maxFiles: typeof GIT_EDITOR_DIFF_MAX_FILES;
}

export interface GitEditorBlameRequest {
  readonly schemaVersion: typeof GIT_EDITOR_SCHEMA_VERSION;
  readonly path: string;
  readonly startLine: number;
  readonly maxLines: number;
}

export interface GitEditorBlameLine {
  readonly line: number;
  readonly commitHash: string;
  readonly author: string;
  readonly authorTime: string;
  readonly summary: string;
}

export interface GitEditorBlameResponse {
  readonly schemaVersion: typeof GIT_EDITOR_SCHEMA_VERSION;
  readonly path: string;
  readonly startLine: number;
  readonly lines: readonly GitEditorBlameLine[];
  readonly truncated: boolean;
  readonly totalLines: number;
  readonly totalBytes: number;
  readonly maxBytes: typeof GIT_EDITOR_BLAME_MAX_BYTES;
  readonly maxLines: typeof GIT_EDITOR_BLAME_MAX_LINES;
}

export interface GitEditorParseOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface GitEditorParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type GitEditorParseResult<T> = GitEditorParseOk<T> | GitEditorParseFail;

const GIT_EDITOR_DIFF_FILE_STATUSES_VALUES: readonly unknown[] = GIT_EDITOR_DIFF_FILE_STATUSES;
const GIT_EDITOR_DIFF_LAYERS_VALUES: readonly unknown[] = GIT_EDITOR_DIFF_LAYERS;
const GIT_EDITOR_DIFF_LINE_KINDS_VALUES: readonly unknown[] = GIT_EDITOR_DIFF_LINE_KINDS;
const GIT_EDITOR_DIFF_SCOPES_VALUES: readonly unknown[] = GIT_EDITOR_DIFF_SCOPES;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

function isBoundedText(value: unknown, maxChars: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maxChars &&
    !value.includes("\0")
  );
}

function isWorkspacePath(value: unknown): value is string {
  if (!isBoundedText(value, GIT_EDITOR_PATH_MAX_BYTES)) return false;
  if (new TextEncoder().encode(value).length > GIT_EDITOR_PATH_MAX_BYTES) return false;
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function isGitEditorDiffScope(value: unknown): value is GitEditorDiffScope {
  return typeof value === "string" && GIT_EDITOR_DIFF_SCOPES_VALUES.includes(value);
}

export function isGitEditorDiffLayer(value: unknown): value is GitEditorDiffLayer {
  return typeof value === "string" && GIT_EDITOR_DIFF_LAYERS_VALUES.includes(value);
}

export function isGitEditorDiffLineKind(value: unknown): value is GitEditorDiffLineKind {
  return typeof value === "string" && GIT_EDITOR_DIFF_LINE_KINDS_VALUES.includes(value);
}

export function isGitEditorDiffFileStatus(value: unknown): value is GitEditorDiffFileStatus {
  return typeof value === "string" && GIT_EDITOR_DIFF_FILE_STATUSES_VALUES.includes(value);
}

function hasValidLineCoordinates(value: Readonly<Record<string, unknown>>): boolean {
  const oldLine = value.oldLine;
  const newLine = value.newLine;
  if (value.kind === "ctx") return isIntegerAtLeast(oldLine, 1) && isIntegerAtLeast(newLine, 1);
  if (value.kind === "add") return oldLine === null && isIntegerAtLeast(newLine, 1);
  if (value.kind === "del") return isIntegerAtLeast(oldLine, 1) && newLine === null;
  return value.kind === "meta" && oldLine === null && newLine === null;
}

export function isGitEditorDiffLine(value: unknown): value is GitEditorDiffLine {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["kind", "oldLine", "newLine", "text"]) &&
    isGitEditorDiffLineKind(value.kind) &&
    hasValidLineCoordinates(value) &&
    isBoundedText(value.text, GIT_EDITOR_DIFF_MAX_LINE_CHARS, true)
  );
}

function hasValidHunkCoordinates(value: Readonly<Record<string, unknown>>): boolean {
  return (
    isIntegerAtLeast(value.oldStart, 0) &&
    isIntegerAtLeast(value.oldCount, 0) &&
    isIntegerAtLeast(value.newStart, 0) &&
    isIntegerAtLeast(value.newCount, 0)
  );
}

export function isGitEditorDiffHunk(value: unknown): value is GitEditorDiffHunk {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "header",
      "oldStart",
      "oldCount",
      "newStart",
      "newCount",
      "lines",
      "truncated",
    ]) &&
    isBoundedText(value.header, GIT_EDITOR_DIFF_MAX_HEADER_CHARS) &&
    hasValidHunkCoordinates(value) &&
    Array.isArray(value.lines) &&
    value.lines.length <= GIT_EDITOR_DIFF_MAX_LINES_PER_HUNK &&
    isDiffLineCollection(value.lines) &&
    typeof value.truncated === "boolean"
  );
}

function hasValidFileMetadata(value: Readonly<Record<string, unknown>>): boolean {
  if (!isWorkspacePath(value.path)) return false;
  if (value.oldPath !== undefined && !isWorkspacePath(value.oldPath)) return false;
  if (value.status === "renamed") return typeof value.oldPath === "string";
  return value.oldPath === undefined;
}

function hasValidDiffHunks(value: Readonly<Record<string, unknown>>): boolean {
  return (
    Array.isArray(value.hunks) &&
    value.hunks.length <= GIT_EDITOR_DIFF_MAX_HUNKS_PER_FILE &&
    isDiffHunkCollection(value.hunks)
  );
}

function hasValidBinaryShape(value: Readonly<Record<string, unknown>>): boolean {
  if (value.binary !== true) return true;
  return (
    Array.isArray(value.hunks) &&
    value.hunks.length === 0 &&
    value.addedLines === 0 &&
    value.removedLines === 0
  );
}

function hasValidDiffFileValues(value: Readonly<Record<string, unknown>>): boolean {
  return (
    isGitEditorDiffFileStatus(value.status) &&
    isGitEditorDiffLayer(value.layer) &&
    hasValidFileMetadata(value) &&
    typeof value.binary === "boolean" &&
    hasValidDiffHunks(value) &&
    hasValidBinaryShape(value) &&
    isIntegerAtLeast(value.addedLines, 0) &&
    isIntegerAtLeast(value.removedLines, 0) &&
    typeof value.truncated === "boolean"
  );
}

export function isGitEditorDiffFile(value: unknown): value is GitEditorDiffFile {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "path",
      "oldPath",
      "layer",
      "status",
      "binary",
      "hunks",
      "addedLines",
      "removedLines",
      "truncated",
    ])
  ) {
    return false;
  }
  return hasValidDiffFileValues(value);
}

const GIT_HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ISO_AUTHOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export function isGitEditorBlameLine(value: unknown): value is GitEditorBlameLine {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["line", "commitHash", "author", "authorTime", "summary"]) &&
    isIntegerAtLeast(value.line, 1) &&
    typeof value.commitHash === "string" &&
    GIT_HASH_PATTERN.test(value.commitHash) &&
    isBoundedText(value.author, GIT_EDITOR_BLAME_AUTHOR_MAX_CHARS) &&
    typeof value.authorTime === "string" &&
    ISO_AUTHOR_TIME_PATTERN.test(value.authorTime) &&
    Number.isFinite(Date.parse(value.authorTime)) &&
    isBoundedText(value.summary, GIT_EDITOR_BLAME_SUMMARY_MAX_CHARS, true)
  );
}

function parserInspectionClass(error: unknown): "TypeError" | "Error" | "unknown error" {
  if (typeof error !== "object" || error === null) return "unknown error";
  try {
    const prototype: unknown = Object.getPrototypeOf(error);
    if (prototype === TypeError.prototype) return "TypeError";
    return prototype === Error.prototype ? "Error" : "unknown error";
  } catch {
    return "unknown error";
  }
}

function parseSafely<T>(
  input: unknown,
  nonRecordError: "request must be an object" | "response must be an object",
  validate: (
    value: Readonly<Record<string, unknown>>,
    errors: string[],
  ) => value is Readonly<Record<string, unknown>> & T,
): GitEditorParseResult<T> {
  try {
    if (!isRecord(input)) return { ok: false, errors: [nonRecordError] };
    const errors: string[] = [];
    return validate(input, errors) ? { ok: true, value: input } : { ok: false, errors };
  } catch (error: unknown) {
    return {
      ok: false,
      errors: [`payload could not be inspected: ${parserInspectionClass(error)}`],
    };
  }
}

function isDiffLineCollection(value: readonly unknown[]): value is readonly GitEditorDiffLine[] {
  const extent = value.length;
  for (let index = 0; index < extent; index += 1) {
    if (!(index in value) || !isGitEditorDiffLine(value[index])) return false;
  }
  return true;
}

function isDiffHunkCollection(value: readonly unknown[]): value is readonly GitEditorDiffHunk[] {
  const extent = value.length;
  for (let index = 0; index < extent; index += 1) {
    if (!(index in value) || !isGitEditorDiffHunk(value[index])) return false;
  }
  return true;
}

function isDiffFileCollection(value: readonly unknown[]): value is readonly GitEditorDiffFile[] {
  const extent = value.length;
  for (let index = 0; index < extent; index += 1) {
    if (!(index in value) || !isGitEditorDiffFile(value[index])) return false;
  }
  return true;
}

function isBlameLineCollection(value: readonly unknown[]): value is readonly GitEditorBlameLine[] {
  const extent = value.length;
  for (let index = 0; index < extent; index += 1) {
    if (!(index in value) || !isGitEditorBlameLine(value[index])) return false;
  }
  return true;
}

function validateResponseFileLayers(
  input: Readonly<Record<string, unknown>>,
  errors: string[],
): boolean {
  const files = input.files;
  if (!Array.isArray(files))
    return rejectEditorField(errors, "file layers must match the response scope");
  const extent = files.length;
  for (let index = 0; index < extent; index += 1) {
    const file: unknown = files[index];
    if (!(index in files) || !isGitEditorDiffFile(file))
      return rejectEditorField(errors, "files contain an invalid entry");
    if (file.layer !== (input.scope === "staged" ? "staged" : "worktree"))
      return rejectEditorField(errors, "file layers must match the response scope");
  }
  return true;
}

function rejectEditorField(errors: string[], message: string): false {
  errors.push(message);
  return false;
}

function validateDiffRequestFields(
  input: Readonly<Record<string, unknown>>,
  errors: string[],
): input is Readonly<Record<string, unknown>> & GitEditorDiffRequest {
  let valid = true;
  if (!hasOnlyKeys(input, ["schemaVersion", "scope", "path"]))
    valid = rejectEditorField(errors, "request has unknown fields");
  if (input.schemaVersion !== GIT_EDITOR_SCHEMA_VERSION)
    valid = rejectEditorField(errors, "schemaVersion invalid");
  if (!isGitEditorDiffScope(input.scope))
    valid = rejectEditorField(errors, "scope must be staged or unstaged");
  if (input.path !== undefined && !isWorkspacePath(input.path)) {
    valid = rejectEditorField(
      errors,
      "path must be a bounded workspace-relative path when present",
    );
  }
  return valid;
}

export function parseGitEditorDiffRequest(
  input: unknown,
): GitEditorParseResult<GitEditorDiffRequest> {
  return parseSafely(input, "request must be an object", validateDiffRequestFields);
}

function validateDiffResponseShape(
  input: Readonly<Record<string, unknown>>,
  errors: string[],
): boolean {
  let valid = true;
  if (
    !hasOnlyKeys(input, [
      "schemaVersion",
      "scope",
      "files",
      "truncated",
      "totalFiles",
      "totalBytes",
      "maxBytes",
      "maxFiles",
    ])
  ) {
    valid = rejectEditorField(errors, "response has unknown fields");
  }
  if (input.schemaVersion !== GIT_EDITOR_SCHEMA_VERSION)
    valid = rejectEditorField(errors, "schemaVersion invalid");
  if (!isGitEditorDiffScope(input.scope))
    valid = rejectEditorField(errors, "scope must be staged or unstaged");
  return valid;
}

function validateDiffResponseFiles(
  input: Readonly<Record<string, unknown>>,
  errors: string[],
): boolean {
  let valid = true;
  if (!Array.isArray(input.files) || input.files.length > GIT_EDITOR_DIFF_MAX_FILES) {
    valid = rejectEditorField(
      errors,
      `files must be an array of at most ${String(GIT_EDITOR_DIFF_MAX_FILES)} entries`,
    );
  } else if (!isDiffFileCollection(input.files))
    valid = rejectEditorField(errors, "files contain an invalid entry");
  else if (isGitEditorDiffScope(input.scope)) {
    valid = validateResponseFileLayers(input, errors) && valid;
  }
  return valid;
}

function validateDiffResponseTotals(
  input: Readonly<Record<string, unknown>>,
  errors: string[],
): boolean {
  let valid = true;
  if (typeof input.truncated !== "boolean")
    valid = rejectEditorField(errors, "truncated must be a boolean");
  if (!isIntegerAtLeast(input.totalFiles, 0))
    valid = rejectEditorField(errors, "totalFiles must be a non-negative integer");
  if (!isIntegerAtLeast(input.totalBytes, 0))
    valid = rejectEditorField(errors, "totalBytes must be a non-negative integer");
  if (input.maxBytes !== GIT_EDITOR_DIFF_MAX_BYTES)
    valid = rejectEditorField(errors, "maxBytes invalid");
  if (input.maxFiles !== GIT_EDITOR_DIFF_MAX_FILES)
    valid = rejectEditorField(errors, "maxFiles invalid");
  valid = validateDiffResponseConsistency(input, errors) && valid;
  return valid;
}

function validateResponseByteLimit(
  input: Readonly<Record<string, unknown>>,
  maximum: number,
  errors: string[],
): boolean {
  if (
    isIntegerAtLeast(input.totalBytes, 0) &&
    input.totalBytes > maximum &&
    input.truncated !== true
  ) {
    return rejectEditorField(errors, "truncated must be true when totalBytes exceeds maxBytes");
  }
  return true;
}

function validateResponseCardinality(
  input: Readonly<Record<string, unknown>>,
  collectionField: "files" | "lines",
  totalField: "totalFiles" | "totalLines",
  errors: string[],
): boolean {
  if (
    Array.isArray(input[collectionField]) &&
    isIntegerAtLeast(input[totalField], 0) &&
    input[totalField] < input[collectionField].length
  ) {
    return rejectEditorField(
      errors,
      `${totalField} must not be smaller than ${collectionField}.length`,
    );
  }
  return true;
}

function validateDiffResponseConsistency(
  input: Readonly<Record<string, unknown>>,
  errors: string[],
): boolean {
  const valid = validateResponseCardinality(input, "files", "totalFiles", errors);
  return validateResponseByteLimit(input, GIT_EDITOR_DIFF_MAX_BYTES, errors) && valid;
}

function validateDiffResponseFields(
  input: Readonly<Record<string, unknown>>,
  errors: string[],
): input is Readonly<Record<string, unknown>> & GitEditorDiffResponse {
  let valid = true;
  valid = validateDiffResponseShape(input, errors) && valid;
  valid = validateDiffResponseFiles(input, errors) && valid;
  valid = validateDiffResponseTotals(input, errors) && valid;
  return valid;
}

export function parseGitEditorDiffResponse(
  input: unknown,
): GitEditorParseResult<GitEditorDiffResponse> {
  return parseSafely(input, "response must be an object", validateDiffResponseFields);
}

function validateBlameRequestFields(
  input: Readonly<Record<string, unknown>>,
  errors: string[],
): input is Readonly<Record<string, unknown>> & GitEditorBlameRequest {
  let valid = true;
  if (!hasOnlyKeys(input, ["schemaVersion", "path", "startLine", "maxLines"])) {
    valid = rejectEditorField(errors, "request has unknown fields");
  }
  if (input.schemaVersion !== GIT_EDITOR_SCHEMA_VERSION)
    valid = rejectEditorField(errors, "schemaVersion invalid");
  if (!isWorkspacePath(input.path))
    valid = rejectEditorField(errors, "path must be a bounded workspace-relative path");
  if (!isIntegerAtLeast(input.startLine, 1))
    valid = rejectEditorField(errors, "startLine must be a positive integer");
  if (
    !isIntegerAtLeast(input.maxLines, 1) ||
    (typeof input.maxLines === "number" && input.maxLines > GIT_EDITOR_BLAME_MAX_LINES)
  ) {
    valid = rejectEditorField(
      errors,
      `maxLines must be between 1 and ${String(GIT_EDITOR_BLAME_MAX_LINES)}`,
    );
  }
  return valid;
}

export function parseGitEditorBlameRequest(
  input: unknown,
): GitEditorParseResult<GitEditorBlameRequest> {
  return parseSafely(input, "request must be an object", validateBlameRequestFields);
}

function validateBlameResponseShape(
  input: Readonly<Record<string, unknown>>,
  errors: string[],
): boolean {
  let valid = true;
  if (
    !hasOnlyKeys(input, [
      "schemaVersion",
      "path",
      "startLine",
      "lines",
      "truncated",
      "totalLines",
      "totalBytes",
      "maxBytes",
      "maxLines",
    ])
  ) {
    valid = rejectEditorField(errors, "response has unknown fields");
  }
  if (input.schemaVersion !== GIT_EDITOR_SCHEMA_VERSION)
    valid = rejectEditorField(errors, "schemaVersion invalid");
  if (!isWorkspacePath(input.path))
    valid = rejectEditorField(errors, "path must be a bounded workspace-relative path");
  if (!isIntegerAtLeast(input.startLine, 1))
    valid = rejectEditorField(errors, "startLine must be a positive integer");
  return valid;
}

function validateBlameResponseLines(
  input: Readonly<Record<string, unknown>>,
  errors: string[],
): boolean {
  let valid = true;
  if (!Array.isArray(input.lines) || input.lines.length > GIT_EDITOR_BLAME_MAX_LINES) {
    valid = rejectEditorField(
      errors,
      `lines must be an array of at most ${String(GIT_EDITOR_BLAME_MAX_LINES)} entries`,
    );
  } else if (!isBlameLineCollection(input.lines))
    valid = rejectEditorField(errors, "lines contain an invalid entry");
  return valid;
}

function validateBlameResponseTotals(
  input: Readonly<Record<string, unknown>>,
  errors: string[],
): boolean {
  let valid = true;
  if (typeof input.truncated !== "boolean")
    valid = rejectEditorField(errors, "truncated must be a boolean");
  if (!isIntegerAtLeast(input.totalLines, 0))
    valid = rejectEditorField(errors, "totalLines must be a non-negative integer");
  if (!isIntegerAtLeast(input.totalBytes, 0))
    valid = rejectEditorField(errors, "totalBytes must be a non-negative integer");
  if (input.maxBytes !== GIT_EDITOR_BLAME_MAX_BYTES)
    valid = rejectEditorField(errors, "maxBytes invalid");
  if (input.maxLines !== GIT_EDITOR_BLAME_MAX_LINES)
    valid = rejectEditorField(errors, "maxLines invalid");
  valid = validateBlameResponseConsistency(input, errors) && valid;
  return valid;
}

function validateBlameResponseConsistency(
  input: Readonly<Record<string, unknown>>,
  errors: string[],
): boolean {
  const valid = validateResponseCardinality(input, "lines", "totalLines", errors);
  return validateResponseByteLimit(input, GIT_EDITOR_BLAME_MAX_BYTES, errors) && valid;
}

function validateBlameResponseFields(
  input: Readonly<Record<string, unknown>>,
  errors: string[],
): input is Readonly<Record<string, unknown>> & GitEditorBlameResponse {
  let valid = true;
  valid = validateBlameResponseShape(input, errors) && valid;
  valid = validateBlameResponseLines(input, errors) && valid;
  valid = validateBlameResponseTotals(input, errors) && valid;
  return valid;
}

export function parseGitEditorBlameResponse(
  input: unknown,
): GitEditorParseResult<GitEditorBlameResponse> {
  return parseSafely(input, "response must be an object", validateBlameResponseFields);
}
