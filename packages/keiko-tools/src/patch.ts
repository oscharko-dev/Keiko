// Patch workflow: validate (all checks, structured report), renderDryRun (preview, never
// writes), and applyPatch (fail-closed, atomic with multi-file rollback). Every target path is
// validated via resolveWithinWorkspace + isDenied; the validated absolute path is the ONLY value
// handed to the WorkspaceWriter, so a static analyser's path sanitizer sits on this boundary
// (ADR-0006 D4). node:fs is never imported here — reads go through WorkspaceFs, writes through
// WorkspaceWriter, both injected.

import {
  containedRealPathInfo,
  isDenied,
  PathDeniedError,
  PathEscapeError,
  resolveWithinWorkspace,
  type WorkspaceFs,
  type WorkspaceInfo,
  type WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { EditorDocumentVersion } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  CommandCancelledError,
  PatchApplyDisabledError,
  PatchApplyError,
  PatchValidationError,
} from "./errors.js";
import { computeFileContent, type ApplyOutcome } from "./patch-content.js";
import { normalizeUnifiedDiffHunks } from "./patch-normalize.js";
import { parseUnifiedDiff, PatchParseError } from "./patch-parse.js";
import { createContainedNodeWorkspaceWriter, type WorkspaceWriter } from "./writer.js";
import {
  DEFAULT_PATCH_LIMITS,
  type PatchApplyResult,
  type PatchChangeKind,
  type PatchConflict,
  type PatchFileChange,
  type PatchHunk,
  type PatchLimits,
  type PatchRejection,
  type PatchValidation,
} from "./types.js";

const PATCH_SOURCE_MAX_FILE_BYTES = 1_000_000;
const PATCH_SOURCE_MAX_TOTAL_BYTES = 4_000_000;

interface SourceReadBudget {
  totalBytes: number;
}

interface SourceSnapshot {
  readonly absolute: string;
  readonly content: string | undefined;
  readonly sourceContentHash: string;
  readonly sourceVersion?: EditorDocumentVersion | undefined;
}

class SourceReadError extends Error {
  readonly rejection: PatchRejection;

  constructor(rejection: PatchRejection) {
    super(rejection.message);
    this.name = "SourceReadError";
    this.rejection = rejection;
  }
}

function containsNul(value: string): boolean {
  return value.includes("\u0000");
}

function isBinaryDiff(diff: string): boolean {
  return (
    diff.includes("GIT binary patch") || /^Binary files .* differ$/m.test(diff) || containsNul(diff)
  );
}

function hasEscapedDiffLineBreak(diff: string): boolean {
  return diff.includes("\\n+") || diff.includes("\\n-") || diff.includes("\\n ");
}

function enforcePath(workspace: WorkspaceInfo, fs: WorkspaceFs, path: string): string {
  let resolved: string;
  try {
    resolved = resolveWithinWorkspace(workspace.root, path);
  } catch (error) {
    if (error instanceof PathEscapeError) {
      throw error;
    }
    throw error;
  }
  const rel = resolved.slice(workspace.root.length).replace(/^[/\\]/, "");
  if (isDenied(rel === "" ? path : rel)) {
    throw new PathDeniedError("path matches an always-on deny pattern", path);
  }
  const info = containedRealPathInfo(fs, workspace.root, resolved);
  if (!realPathMatchesLexicalTarget(fs, resolved, rel, info.realRelative)) {
    throw new PathDeniedError("path resolves through an in-workspace alias", path);
  }
  if (fs.exists(resolved) && (fs.stat(resolved).hardLinkCount ?? 1) > 1) {
    throw new PathDeniedError("path resolves through a hard-linked alias", path);
  }
  if (isDenied(info.realRelative)) {
    throw new PathDeniedError("path matches an always-on deny pattern", path);
  }
  return resolved;
}

function realPathMatchesLexicalTarget(
  fs: WorkspaceFs,
  absolutePath: string,
  rel: string,
  realRelative: string,
): boolean {
  if (fs.exists(absolutePath)) {
    return realRelative === rel;
  }
  return realRelative === "" || rel === realRelative || rel.startsWith(`${realRelative}/`);
}

function safePath(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  path: string,
): PatchRejection | undefined {
  try {
    enforcePath(workspace, fs, path);
    return undefined;
  } catch (error) {
    if (error instanceof PathEscapeError) {
      return { code: "path-unsafe", message: "path escapes the workspace", path };
    }
    if (error instanceof PathDeniedError) {
      return { code: "path-denied", message: "path matches an always-on deny pattern", path };
    }
    return {
      code: "path-denied",
      message: "source file could not be inspected safely",
      path,
    };
  }
}

function collectPathReasons(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  files: readonly PatchFileChange[],
): PatchRejection[] {
  const reasons: PatchRejection[] = [];
  for (const file of files) {
    const rejection = safePath(workspace, fs, file.path);
    if (rejection !== undefined) {
      reasons.push(rejection);
    }
  }
  return reasons;
}

function sourceReadFailure(path: string, code: PatchRejection["code"], message: string): never {
  throw new SourceReadError({ code, message, path });
}

function normalizeSourceReadError(error: unknown, path: string): SourceReadError {
  if (error instanceof SourceReadError) {
    return error;
  }
  if (error instanceof PathEscapeError) {
    return new SourceReadError({
      code: "path-unsafe",
      message: "path escapes the workspace",
      path,
    });
  }
  if (error instanceof PathDeniedError) {
    return new SourceReadError({
      code: "path-denied",
      message: "path matches an always-on deny pattern",
      path,
    });
  }
  return new SourceReadError({
    code: "path-denied",
    message: "source file could not be inspected safely",
    path,
  });
}

function statSource(fs: WorkspaceFs, absolute: string, path: string): WorkspaceStat {
  try {
    return fs.stat(absolute);
  } catch {
    return sourceReadFailure(path, "path-denied", "source file could not be inspected safely");
  }
}

function reserveSourceBytes(stat: WorkspaceStat, budget: SourceReadBudget, path: string): void {
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    return sourceReadFailure(path, "path-denied", "source file could not be inspected safely");
  }
  if (stat.size > PATCH_SOURCE_MAX_FILE_BYTES) {
    return sourceReadFailure(path, "size-limit", "source file exceeds the per-file byte limit");
  }
  if (budget.totalBytes + stat.size > PATCH_SOURCE_MAX_TOTAL_BYTES) {
    return sourceReadFailure(path, "size-limit", "source files exceed the aggregate byte limit");
  }
  budget.totalBytes += stat.size;
}

function readSourceContent(fs: WorkspaceFs, absolute: string, path: string): string {
  try {
    return fs.readFileUtf8(absolute);
  } catch {
    return sourceReadFailure(path, "path-denied", "source file could not be read safely");
  }
}

function verifySourceBytes(
  content: string,
  stat: WorkspaceStat,
  budget: SourceReadBudget,
  path: string,
): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > PATCH_SOURCE_MAX_FILE_BYTES) {
    return sourceReadFailure(path, "size-limit", "source file exceeds the per-file byte limit");
  }
  if (budget.totalBytes - stat.size + bytes > PATCH_SOURCE_MAX_TOTAL_BYTES) {
    return sourceReadFailure(path, "size-limit", "source files exceed the aggregate byte limit");
  }
  if (bytes !== stat.size) {
    return sourceReadFailure(path, "path-denied", "source file changed during validation");
  }
}

function inspectSource(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  path: string,
  budget: SourceReadBudget,
): SourceSnapshot {
  try {
    const absolute = enforcePath(workspace, fs, path);
    if (!fs.exists(absolute)) {
      return { absolute, content: undefined, sourceContentHash: sha256Hex("") };
    }
    const stat = statSource(fs, absolute, path);
    if (!stat.isFile || stat.isDirectory || stat.isSymbolicLink) {
      return sourceReadFailure(path, "path-denied", "source target is not a regular file");
    }
    if ((stat.hardLinkCount ?? 1) > 1) {
      return sourceReadFailure(path, "path-denied", "path matches an always-on deny pattern");
    }
    reserveSourceBytes(stat, budget, path);
    const content = readSourceContent(fs, absolute, path);
    verifySourceBytes(content, stat, budget, path);
    const sourceContentHash = sha256Hex(content);
    const sourceVersion = sourceVersionFromStat(stat, sourceContentHash);
    return {
      absolute,
      content,
      sourceContentHash,
      ...(sourceVersion === undefined ? {} : { sourceVersion }),
    };
  } catch (error) {
    throw normalizeSourceReadError(error, path);
  }
}

function sourceVersionFromStat(
  stat: WorkspaceStat,
  contentHash: string,
): EditorDocumentVersion | undefined {
  const modifiedAt = stat.mtimeMs;
  if (modifiedAt === undefined || !Number.isFinite(modifiedAt) || modifiedAt < 0) return undefined;
  return { sizeBytes: stat.size, modifiedAt, contentHash };
}

function prepareSources(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  files: readonly PatchFileChange[],
  signal?: AbortSignal,
): ReadonlyMap<string, SourceSnapshot> {
  const budget: SourceReadBudget = { totalBytes: 0 };
  const sources = new Map<string, SourceSnapshot>();
  for (const file of files) {
    if (signal?.aborted === true) {
      throw new CommandCancelledError("apply cancelled before write planning completed");
    }
    if (!sources.has(file.path)) {
      sources.set(file.path, inspectSource(workspace, fs, file.path, budget));
    }
  }
  return sources;
}

function toLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function hunkPreimageLines(file: PatchFileChange, hunkIndex: number): readonly string[] {
  const hunk = file.hunks[hunkIndex];
  if (hunk === undefined) {
    return [];
  }
  return hunk.lines
    .filter((line) => line.startsWith(" ") || line.startsWith("-"))
    .map((line) => line.slice(1));
}

function startsWithSequence(
  lines: readonly string[],
  index: number,
  needle: readonly string[],
): boolean {
  return needle.every((line, offset) => lines[index + offset] === line);
}

function uniqueSequenceIndex(
  lines: readonly string[],
  needle: readonly string[],
): number | undefined {
  if (needle.length === 0 || needle.length > lines.length) {
    return undefined;
  }
  let found: number | undefined;
  for (let index = 0; index <= lines.length - needle.length; index += 1) {
    if (!startsWithSequence(lines, index, needle)) {
      continue;
    }
    if (found !== undefined) {
      return undefined;
    }
    found = index;
  }
  return found;
}

function alignFileHunks(file: PatchFileChange, current: string | undefined): PatchFileChange {
  if (file.kind !== "modify") {
    return file;
  }
  if (current === undefined) {
    return isCreateOnlyModify(file) ? { ...file, kind: "create" } : file;
  }
  const currentLines = toLines(current);
  const hunks = file.hunks.map((hunk, index) => {
    const preimage = hunkPreimageLines(file, index);
    if (hunk.oldStart > 0 && startsWithSequence(currentLines, hunk.oldStart - 1, preimage)) {
      return hunk;
    }
    const anchor = uniqueSequenceIndex(currentLines, preimage);
    if (anchor === undefined) {
      return hunk;
    }
    const start = anchor + 1;
    return { ...hunk, oldStart: start, newStart: start };
  });
  if (hunks.every((hunk, index) => hunk === file.hunks[index])) {
    return file;
  }
  return { ...file, hunks };
}

function isCreateOnlyModify(file: PatchFileChange): boolean {
  return (
    file.hunks.length > 0 &&
    file.hunks.every(
      (hunk) => hunk.oldLines === 0 && hunk.lines.every((line) => line.startsWith("+")),
    )
  );
}

function alignHunksToCurrentContent(
  files: readonly PatchFileChange[],
  sources: ReadonlyMap<string, SourceSnapshot>,
): readonly PatchFileChange[] {
  return files.map((file) => alignFileHunks(file, sources.get(file.path)?.content));
}

function unanchoredModifyReasons(files: readonly PatchFileChange[]): PatchRejection[] {
  return files
    .filter((file) => file.kind === "modify" && file.hunks.some((hunk) => hunk.oldStart <= 0))
    .map((file) => ({
      code: "malformed" as const,
      message: "modify hunk has no unique anchor",
      path: file.path,
    }));
}

function collectConflicts(
  files: readonly PatchFileChange[],
  sources: ReadonlyMap<string, SourceSnapshot>,
  allowOverwrite: boolean,
): PatchConflict[] {
  const conflicts: PatchConflict[] = [];
  for (const file of files) {
    const current = sources.get(file.path)?.content;
    const outcome = computeFileContent(file, current, allowOverwrite);
    for (const conflict of outcome.conflicts) {
      conflicts.push({ path: file.path, hunkIndex: conflict.hunkIndex, reason: conflict.reason });
    }
  }
  return conflicts;
}

function sizeAndCountReasons(
  diff: string,
  files: readonly PatchFileChange[],
  totalChangedLines: number,
  limits: PatchLimits,
  totalBytes: number,
): PatchRejection[] {
  const reasons: PatchRejection[] = [];
  if (diff.trim().length > 0 && files.length === 0) {
    reasons.push({ code: "malformed", message: "diff does not contain any file changes" });
  }
  if (totalBytes > limits.maxPatchBytes) {
    reasons.push({
      code: "size-limit",
      message: `patch exceeds ${String(limits.maxPatchBytes)} bytes`,
    });
  }
  if (isBinaryDiff(diff)) {
    reasons.push({ code: "binary", message: "binary patches are not supported" });
  }
  if (hasEscapedDiffLineBreak(diff)) {
    reasons.push({
      code: "malformed",
      message: "diff contains escaped newline markers; use real line breaks",
    });
  }
  if (totalChangedLines > limits.maxChangedLines) {
    reasons.push({
      code: "line-limit",
      message: `changed lines exceed ${String(limits.maxChangedLines)}`,
    });
  }
  if (files.length > limits.maxFilesChanged) {
    reasons.push({
      code: "file-limit",
      message: `files changed exceed ${String(limits.maxFilesChanged)}`,
    });
  }
  return reasons;
}

function renderHeader(file: PatchFileChange): readonly string[] {
  if (file.kind === "create") {
    return ["--- /dev/null", `+++ b/${file.path}`];
  }
  if (file.kind === "delete") {
    return [`--- a/${file.path}`, "+++ /dev/null"];
  }
  return [`--- a/${file.path}`, `+++ b/${file.path}`];
}

function renderParsedPatch(files: readonly PatchFileChange[]): string {
  const lines: string[] = [];
  for (const file of files) {
    lines.push(...renderHeader(file));
    for (const hunk of file.hunks) {
      lines.push(
        `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(
          hunk.newStart,
        )},${String(hunk.newLines)} @@`,
        ...hunk.lines,
      );
    }
  }
  return lines.join("\n");
}

function normalizeProjectionPath(path: string): string {
  return path
    .replace(/\\/gu, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

function projectionPathIsContained(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || /^[A-Za-z]:/u.test(path)) return false;
  return !path.split(/[/\\]/u).includes("..");
}

function projectionFailure(message: string): never {
  throw new PatchValidationError("patch projection failed", [{ code: "malformed", message }], []);
}

export function projectValidatedPatch(
  validation: PatchValidation,
  selectedPaths: readonly string[],
): string {
  if (!validation.ok) {
    throw new PatchValidationError(
      "source patch must pass full validation before projection",
      validation.reasons,
      validation.conflicts,
    );
  }
  if (selectedPaths.length === 0 || !selectedPaths.every(projectionPathIsContained)) {
    return projectionFailure("selected paths must be a non-empty contained path list");
  }
  const available = validation.files.map((file) => normalizeProjectionPath(file.path));
  const selected = selectedPaths.map(normalizeProjectionPath);
  if (new Set(available).size !== available.length || new Set(selected).size !== selected.length) {
    return projectionFailure("patch projection paths must be unique after normalization");
  }
  const selectedSet = new Set(selected);
  if (selected.some((path) => !available.includes(path))) {
    return projectionFailure("selected paths must belong to the validated patch");
  }
  return renderParsedPatch(
    validation.files.filter((file) => selectedSet.has(normalizeProjectionPath(file.path))),
  );
}

export interface ValidateDeps {
  readonly fs?: WorkspaceFs | undefined;
  readonly limits?: PatchLimits | undefined;
  // When true (set only after explicit user confirmation), a create whose target already exists is a
  // replacement rather than a conflict (Issue #1204 AC7/AC14). Default false = no-silent-overwrite.
  readonly allowOverwrite?: boolean | undefined;
}

export interface PatchInspectionFile {
  readonly change: PatchFileChange;
  readonly original: string | undefined;
  readonly outcome: ApplyOutcome;
  readonly sourceContentHash: string;
  readonly sourceVersion?: EditorDocumentVersion | undefined;
}

export interface PatchInspection {
  readonly validation: PatchValidation;
  readonly files: readonly PatchInspectionFile[] | null;
}

interface ParsedDiff {
  readonly files: readonly PatchFileChange[];
  readonly effectiveDiff: string;
  readonly normalized: boolean;
}

function parseDiffForValidation(diff: string): ParsedDiff {
  try {
    return { files: parseUnifiedDiff(diff).files, effectiveDiff: diff, normalized: false };
  } catch (error) {
    if (!(error instanceof PatchParseError)) {
      throw error;
    }
    const normalizedDiff = normalizeUnifiedDiffHunks(diff);
    if (normalizedDiff === diff) {
      throw error;
    }
    return {
      files: parseUnifiedDiff(normalizedDiff).files,
      effectiveDiff: normalizedDiff,
      normalized: true,
    };
  }
}

function malformedValidation(diff: string, error: unknown): PatchValidation {
  const message = error instanceof PatchParseError ? error.message : "unparseable diff";
  return {
    ok: false,
    files: [],
    totalChangedLines: 0,
    totalBytes: Buffer.byteLength(diff, "utf8"),
    reasons: [{ code: "malformed", message }],
    conflicts: [],
  };
}

interface ValidationResultInput {
  readonly diff: string;
  readonly effectiveDiff: string;
  readonly files: readonly PatchFileChange[];
  readonly totalChangedLines: number;
  readonly reasons: readonly PatchRejection[];
  readonly conflicts: readonly PatchConflict[];
}

function validationResult(input: ValidationResultInput): PatchValidation {
  return {
    ok: input.reasons.length === 0 && input.conflicts.length === 0,
    files: input.files,
    totalChangedLines: input.totalChangedLines,
    totalBytes: Buffer.byteLength(input.effectiveDiff, "utf8"),
    ...(input.effectiveDiff === input.diff ? {} : { normalizedDiff: input.effectiveDiff }),
    reasons: input.reasons,
    conflicts: input.conflicts,
  };
}

type SourcePreparation =
  | { readonly ok: true; readonly sources: ReadonlyMap<string, SourceSnapshot> }
  | { readonly ok: false; readonly rejection: PatchRejection };

function prepareValidationSources(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  files: readonly PatchFileChange[],
): SourcePreparation {
  try {
    return { ok: true, sources: prepareSources(workspace, fs, files) };
  } catch (error) {
    if (error instanceof SourceReadError) {
      return { ok: false, rejection: error.rejection };
    }
    throw error;
  }
}

function validationReasons(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  limits: PatchLimits,
  parsed: ParsedDiff,
  totalChangedLines: number,
): PatchRejection[] {
  const totalBytes = Buffer.byteLength(parsed.effectiveDiff, "utf8");
  return [
    ...sizeAndCountReasons(
      parsed.effectiveDiff,
      parsed.files,
      totalChangedLines,
      limits,
      totalBytes,
    ),
    ...collectPathReasons(workspace, fs, parsed.files),
  ];
}

function patchInspectionFile(
  change: PatchFileChange,
  sources: ReadonlyMap<string, SourceSnapshot>,
  allowOverwrite: boolean,
): PatchInspectionFile {
  const source = sources.get(change.path);
  if (source === undefined) {
    throw new Error("patch source inspection invariant failed");
  }
  return {
    change,
    original: source.content,
    outcome: computeFileContent(change, source.content, allowOverwrite),
    sourceContentHash: source.sourceContentHash,
    ...(source.sourceVersion === undefined ? {} : { sourceVersion: source.sourceVersion }),
  };
}

function rejectedInspection(
  diff: string,
  parsed: ParsedDiff,
  totalChangedLines: number,
  reasons: readonly PatchRejection[],
): PatchInspection {
  return {
    validation: validationResult({
      diff,
      effectiveDiff: parsed.effectiveDiff,
      files: parsed.files,
      totalChangedLines,
      reasons,
      conflicts: [],
    }),
    files: null,
  };
}

function completeInspection(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  limits: PatchLimits,
  diff: string,
  parsed: ParsedDiff,
  allowOverwrite: boolean,
): PatchInspection {
  const files = parsed.files;
  const totalChangedLines = files.reduce((sum, f) => sum + f.addedLines + f.removedLines, 0);
  const initialReasons = validationReasons(workspace, fs, limits, parsed, totalChangedLines);
  if (initialReasons.length > 0) {
    return rejectedInspection(diff, parsed, totalChangedLines, initialReasons);
  }
  const prepared = prepareValidationSources(workspace, fs, files);
  if (!prepared.ok) {
    return rejectedInspection(diff, parsed, totalChangedLines, [prepared.rejection]);
  }
  const alignedFiles = alignHunksToCurrentContent(files, prepared.sources);
  const aligned = alignedFiles.some((file, index) => file !== files[index]);
  const effectiveDiff = parsed.normalized || aligned ? renderParsedPatch(alignedFiles) : diff;
  const reasons = unanchoredModifyReasons(alignedFiles);
  const conflicts =
    reasons.length === 0 ? collectConflicts(alignedFiles, prepared.sources, allowOverwrite) : [];
  return {
    validation: validationResult({
      diff,
      effectiveDiff,
      files: alignedFiles,
      totalChangedLines,
      reasons,
      conflicts,
    }),
    files: alignedFiles.map((file) => patchInspectionFile(file, prepared.sources, allowOverwrite)),
  };
}

export function inspectPatch(
  workspace: WorkspaceInfo,
  diff: string,
  deps: ValidateDeps = {},
): PatchInspection {
  const fs = deps.fs ?? nodeWorkspaceFs;
  const limits = deps.limits ?? DEFAULT_PATCH_LIMITS;
  try {
    return completeInspection(
      workspace,
      fs,
      limits,
      diff,
      parseDiffForValidation(diff),
      deps.allowOverwrite ?? false,
    );
  } catch (error) {
    return { validation: malformedValidation(diff, error), files: null };
  }
}

export function validatePatch(
  workspace: WorkspaceInfo,
  diff: string,
  deps: ValidateDeps = {},
): PatchValidation {
  return inspectPatch(workspace, diff, deps).validation;
}

function renderFileLine(file: PatchFileChange): string {
  return `${file.kind} ${file.path} (+${String(file.addedLines)} -${String(file.removedLines)})`;
}

// Human-readable preview returned by propose_patch. NEVER writes. Lists per-file +/- counts,
// any rejection reasons, and any conflicts so the reviewer sees exactly what apply would do.
export function renderDryRun(validation: PatchValidation): string {
  const header = validation.ok
    ? `PATCH OK — ${String(validation.files.length)} file(s), ${String(validation.totalChangedLines)} changed line(s)`
    : "PATCH REJECTED";
  const fileLines = validation.files.map(renderFileLine);
  const reasonLines = validation.reasons.map(
    (r) => `reject[${r.code}]: ${r.message}${r.path === undefined ? "" : ` (${r.path})`}`,
  );
  const conflictLines = validation.conflicts.map(
    (c) => `conflict: ${c.path} hunk#${String(c.hunkIndex)}: ${c.reason}`,
  );
  return [header, ...fileLines, ...reasonLines, ...conflictLines].join("\n");
}

// ─── Inverse patch (guarded revert proposal — Issue #1204) ──────────────────────────────────────
// Produces the unified diff that exactly undoes `diff`, for a guarded revert proposal the user reviews
// and re-applies after a failed post-apply verification. The transformation is pure and lossless: a
// create becomes a delete (and vice-versa), and a modify swaps its old/new line ranges and its +/-
// markers. Applied to the post-apply content, the inverse restores the pre-apply state. Throws
// PatchParseError on an unparseable diff (the caller already validated/applied the forward diff).

function invertHunkLine(line: string): string {
  const marker = line.charAt(0);
  if (marker === "+") {
    return `-${line.slice(1)}`;
  }
  if (marker === "-") {
    return `+${line.slice(1)}`;
  }
  return line;
}

function invertHunk(hunk: PatchHunk): PatchHunk {
  return {
    oldStart: hunk.newStart,
    oldLines: hunk.newLines,
    newStart: hunk.oldStart,
    newLines: hunk.oldLines,
    lines: hunk.lines.map(invertHunkLine),
  };
}

const INVERSE_KIND: Readonly<Record<PatchChangeKind, PatchChangeKind>> = {
  create: "delete",
  delete: "create",
  modify: "modify",
};

function invertFileChange(file: PatchFileChange): PatchFileChange {
  return {
    path: file.path,
    kind: INVERSE_KIND[file.kind],
    hunks: file.hunks.map(invertHunk),
    addedLines: file.removedLines,
    removedLines: file.addedLines,
  };
}

export function invertPatch(diff: string): string {
  const parsed = parseUnifiedDiff(diff);
  return renderParsedPatch(parsed.files.map(invertFileChange));
}

function hasCreateOverwrite(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  files: readonly PatchFileChange[],
): boolean {
  const creates = files.filter((file) => file.kind === "create");
  const sources = prepareSources(workspace, fs, creates);
  return creates.some((file) => sources.get(file.path)?.content !== undefined);
}

function throwPatchSourceValidation(error: unknown): never {
  if (error instanceof SourceReadError) {
    throw new PatchValidationError("patch failed validation", [error.rejection], []);
  }
  throw error;
}

// Builds a guarded restore proposal only when the diff needed for restoration is already content-safe.
// For normal creates, modifies, and deletes, `invertPatch` contains only content that was already in the
// reviewed forward diff. For explicit create-over-existing overwrites, a faithful restore would need the
// undisclosed pre-existing file body; returning it would create a read/exfiltration path, and returning a
// delete would destroy the pre-existing file. In that case no restore diff is emitted.
export function buildRestorePatch(
  workspace: WorkspaceInfo,
  diff: string,
  deps: ValidateDeps = {},
): string | undefined {
  const fs = deps.fs ?? nodeWorkspaceFs;
  const allowOverwrite = deps.allowOverwrite ?? false;
  const validation = validatePatch(workspace, diff, {
    fs,
    allowOverwrite,
    ...(deps.limits ? { limits: deps.limits } : {}),
  });
  if (!validation.ok) {
    throw new PatchValidationError(
      "patch failed validation",
      validation.reasons,
      validation.conflicts,
    );
  }
  if (allowOverwrite) {
    try {
      if (hasCreateOverwrite(workspace, fs, validation.files)) {
        return undefined;
      }
    } catch (error) {
      return throwPatchSourceValidation(error);
    }
  }
  return invertPatch(validation.normalizedDiff ?? diff);
}

export interface ApplyDeps {
  readonly applyEnabled: boolean;
  readonly signal: AbortSignal;
  readonly fs?: WorkspaceFs | undefined;
  readonly writer?: WorkspaceWriter | undefined;
  readonly limits?: PatchLimits | undefined;
  // When true (set only after explicit user confirmation), a create whose target already exists is a
  // replacement rather than a conflict (Issue #1204 AC7/AC14). Default false = no-silent-overwrite.
  readonly allowOverwrite?: boolean | undefined;
}

interface PlannedWrite {
  readonly path: string;
  readonly absolute: string;
  readonly kind: "create" | "modify" | "delete";
  readonly newContent: string | null;
  readonly original: string | undefined;
}

function requiredSource(
  sources: ReadonlyMap<string, SourceSnapshot>,
  path: string,
): SourceSnapshot {
  const source = sources.get(path);
  if (source === undefined) {
    return sourceReadFailure(path, "path-denied", "source file could not be inspected safely");
  }
  return source;
}

function plannedWrite(
  file: PatchFileChange,
  source: SourceSnapshot,
  allowOverwrite: boolean,
): PlannedWrite {
  const outcome = computeFileContent(file, source.content, allowOverwrite);
  if (outcome.conflicts.length > 0) {
    throw new PatchValidationError(
      "patch failed commit-time validation",
      [],
      outcome.conflicts.map((conflict) => ({ path: file.path, ...conflict })),
    );
  }
  return {
    path: file.path,
    absolute: source.absolute,
    kind: file.kind,
    newContent: outcome.content,
    original: source.content,
  };
}

function planWrites(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  signal: AbortSignal,
  files: readonly PatchFileChange[],
  allowOverwrite: boolean,
): readonly PlannedWrite[] {
  try {
    const sources = prepareSources(workspace, fs, files, signal);
    return files.map((file) =>
      plannedWrite(file, requiredSource(sources, file.path), allowOverwrite),
    );
  } catch (error) {
    return throwPatchSourceValidation(error);
  }
}

function applyOne(writer: WorkspaceWriter, plan: PlannedWrite): void {
  if (plan.kind === "delete") {
    writer.remove(plan.absolute);
    return;
  }
  const dir = plan.absolute.replace(/[/\\][^/\\]*$/, "");
  writer.mkdirp(dir);
  writer.writeFileUtf8(plan.absolute, plan.newContent ?? "");
}

function rollback(writer: WorkspaceWriter, done: readonly PlannedWrite[]): void {
  for (const plan of done) {
    if (plan.original === undefined) {
      writer.remove(plan.absolute);
    } else {
      writer.writeFileUtf8(plan.absolute, plan.original);
    }
  }
}

function commit(
  writer: WorkspaceWriter,
  plans: readonly PlannedWrite[],
  signal: AbortSignal,
): void {
  const done: PlannedWrite[] = [];
  for (const plan of plans) {
    if (isAbortRequested(signal)) {
      rollback(writer, done);
      throw new CommandCancelledError("apply cancelled during write phase");
    }
    try {
      applyOne(writer, plan);
      done.push(plan);
    } catch (error) {
      rollback(writer, done);
      const message = error instanceof Error ? error.message : "write failed";
      throw new PatchApplyError(`apply failed, rolled back: ${message}`, plan.path);
    }
    if (isAbortRequested(signal)) {
      rollback(writer, done);
      throw new CommandCancelledError("apply cancelled during write phase");
    }
  }
}

function isAbortRequested(signal: AbortSignal): boolean {
  return signal.aborted;
}

function summarize(plans: readonly PlannedWrite[]): PatchApplyResult {
  return {
    changedFiles: plans.map((p) => p.path),
    created: plans.filter((p) => p.kind === "create").map((p) => p.path),
    deleted: plans.filter((p) => p.kind === "delete").map((p) => p.path),
  };
}

// Applies a validated patch atomically. Fail-closed: no write unless applyEnabled === true.
// Order: gate → validate → abort check → plan (pure) → write with multi-file rollback.
export function applyPatch(
  workspace: WorkspaceInfo,
  diff: string,
  deps: ApplyDeps,
): PatchApplyResult {
  if (!deps.applyEnabled) {
    throw new PatchApplyDisabledError("apply is disabled (applyEnabled is false)");
  }
  const fs = deps.fs ?? nodeWorkspaceFs;
  const writer = deps.writer ?? createContainedNodeWorkspaceWriter(workspace.root);
  const allowOverwrite = deps.allowOverwrite ?? false;
  const validation = validatePatch(workspace, diff, {
    fs,
    allowOverwrite,
    ...(deps.limits ? { limits: deps.limits } : {}),
  });
  if (!validation.ok) {
    throw new PatchValidationError(
      "patch failed validation",
      validation.reasons,
      validation.conflicts,
    );
  }
  if (deps.signal.aborted) {
    throw new CommandCancelledError("apply cancelled before write phase");
  }
  const plans = planWrites(workspace, fs, deps.signal, validation.files, allowOverwrite);
  commit(writer, plans, deps.signal);
  return summarize(plans);
}
