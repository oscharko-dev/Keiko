// Patch workflow: validate (all checks, structured report), renderDryRun (preview, never
// writes), and applyPatch (fail-closed, atomic with multi-file rollback). Every target path is
// validated via resolveWithinWorkspace + isDenied; the validated absolute path is the ONLY value
// handed to the WorkspaceWriter, so a static analyser's path sanitizer sits on this boundary
// (ADR-0006 D4). node:fs is never imported here — reads go through WorkspaceFs, writes through
// WorkspaceWriter, both injected.

import { isDenied } from "../workspace/ignore.js";
import { resolveWithinWorkspace } from "../workspace/paths.js";
import { containedRealPathInfo } from "../workspace/realpath.js";
import { PathDeniedError, PathEscapeError } from "../workspace/errors.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "../workspace/fs.js";
import type { WorkspaceInfo } from "../workspace/types.js";
import {
  CommandCancelledError,
  PatchApplyDisabledError,
  PatchApplyError,
  PatchValidationError,
} from "./errors.js";
import { computeFileContent } from "./patch-content.js";
import { normalizeUnifiedDiffHunks } from "./patch-normalize.js";
import { parseUnifiedDiff, PatchParseError } from "./patch-parse.js";
import { nodeWorkspaceWriter, type WorkspaceWriter } from "./writer.js";
import {
  DEFAULT_PATCH_LIMITS,
  type PatchApplyResult,
  type PatchConflict,
  type PatchFileChange,
  type PatchLimits,
  type PatchRejection,
  type PatchValidation,
} from "./types.js";

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
    throw error;
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

function readCurrent(workspace: WorkspaceInfo, fs: WorkspaceFs, path: string): string | undefined {
  const absolute = resolveWithinWorkspace(workspace.root, path);
  if (!fs.exists(absolute)) {
    return undefined;
  }
  return fs.readFileUtf8(absolute);
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
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  files: readonly PatchFileChange[],
): readonly PatchFileChange[] {
  return files.map((file) => alignFileHunks(file, readCurrent(workspace, fs, file.path)));
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
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  files: readonly PatchFileChange[],
): PatchConflict[] {
  const conflicts: PatchConflict[] = [];
  for (const file of files) {
    const current = readCurrent(workspace, fs, file.path);
    const outcome = computeFileContent(file, current);
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

export interface ValidateDeps {
  readonly fs?: WorkspaceFs | undefined;
  readonly limits?: PatchLimits | undefined;
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

function completeValidation(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  limits: PatchLimits,
  diff: string,
  parsed: ParsedDiff,
): PatchValidation {
  const files = parsed.files;
  const totalBytes = Buffer.byteLength(parsed.effectiveDiff, "utf8");
  const totalChangedLines = files.reduce((sum, f) => sum + f.addedLines + f.removedLines, 0);
  const pathAndSizeReasons = [
    ...sizeAndCountReasons(parsed.effectiveDiff, files, totalChangedLines, limits, totalBytes),
    ...collectPathReasons(workspace, fs, files),
  ];
  const alignedFiles =
    pathAndSizeReasons.length === 0 ? alignHunksToCurrentContent(workspace, fs, files) : files;
  const aligned = alignedFiles.some((file, index) => file !== files[index]);
  const effectiveDiff = parsed.normalized || aligned ? renderParsedPatch(alignedFiles) : diff;
  const reasons = [...pathAndSizeReasons, ...unanchoredModifyReasons(alignedFiles)];
  const conflicts = reasons.length === 0 ? collectConflicts(workspace, fs, alignedFiles) : [];
  return {
    ok: reasons.length === 0 && conflicts.length === 0,
    files: alignedFiles,
    totalChangedLines,
    totalBytes: Buffer.byteLength(effectiveDiff, "utf8"),
    ...(effectiveDiff === diff ? {} : { normalizedDiff: effectiveDiff }),
    reasons,
    conflicts,
  };
}

export function validatePatch(
  workspace: WorkspaceInfo,
  diff: string,
  deps: ValidateDeps = {},
): PatchValidation {
  const fs = deps.fs ?? nodeWorkspaceFs;
  const limits = deps.limits ?? DEFAULT_PATCH_LIMITS;
  try {
    return completeValidation(workspace, fs, limits, diff, parseDiffForValidation(diff));
  } catch (error) {
    return malformedValidation(diff, error);
  }
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

export interface ApplyDeps {
  readonly applyEnabled: boolean;
  readonly signal: AbortSignal;
  readonly fs?: WorkspaceFs | undefined;
  readonly writer?: WorkspaceWriter | undefined;
  readonly limits?: PatchLimits | undefined;
}

interface PlannedWrite {
  readonly path: string;
  readonly absolute: string;
  readonly kind: "create" | "modify" | "delete";
  readonly newContent: string | null;
  readonly original: string | undefined;
}

function planWrites(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  signal: AbortSignal,
  files: readonly PatchFileChange[],
): readonly PlannedWrite[] {
  const plans: PlannedWrite[] = [];
  for (const file of files) {
    if (signal.aborted) {
      throw new CommandCancelledError("apply cancelled before write planning completed");
    }
    const absolute = enforcePath(workspace, fs, file.path);
    const original = readCurrent(workspace, fs, file.path);
    const outcome = computeFileContent(file, original);
    plans.push({
      path: file.path,
      absolute,
      kind: file.kind,
      newContent: outcome.content,
      original,
    });
  }
  return plans;
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
  const writer = deps.writer ?? nodeWorkspaceWriter;
  const validation = validatePatch(workspace, diff, {
    fs,
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
  const plans = planWrites(workspace, fs, deps.signal, validation.files);
  commit(writer, plans, deps.signal);
  return summarize(plans);
}
