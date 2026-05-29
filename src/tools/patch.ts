// Patch workflow: validate (all checks, structured report), renderDryRun (preview, never
// writes), and applyPatch (fail-closed, atomic with multi-file rollback). Every target path is
// validated via resolveWithinWorkspace + isDenied; the validated absolute path is the ONLY value
// handed to the WorkspaceWriter, so a static analyser's path sanitizer sits on this boundary
// (ADR-0006 D4). node:fs is never imported here — reads go through WorkspaceFs, writes through
// WorkspaceWriter, both injected.

import { isDenied } from "../workspace/ignore.js";
import { resolveWithinWorkspace } from "../workspace/paths.js";
import { assertContainedRealPath } from "../workspace/realpath.js";
import { PathEscapeError } from "../workspace/errors.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "../workspace/fs.js";
import type { WorkspaceInfo } from "../workspace/types.js";
import {
  CommandCancelledError,
  PatchApplyDisabledError,
  PatchApplyError,
  PatchValidationError,
} from "./errors.js";
import { computeFileContent } from "./patch-content.js";
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

function safePath(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  path: string,
): PatchRejection | undefined {
  let resolved: string;
  try {
    resolved = resolveWithinWorkspace(workspace.root, path);
  } catch (error) {
    if (error instanceof PathEscapeError) {
      return { code: "path-unsafe", message: "path escapes the workspace", path };
    }
    throw error;
  }
  const rel = resolved.slice(workspace.root.length).replace(/^[/\\]/, "");
  if (isDenied(rel === "" ? path : rel)) {
    return { code: "path-denied", message: "path matches an always-on deny pattern", path };
  }
  // Symlink containment: a lexically-contained target whose real path (or, for a create target,
  // whose nearest existing parent) escapes the root is rejected here — the same gate the read
  // path applies. This blocks the symlink-write/.git-hooks escalation (ADR-0006 D2, S-H1).
  try {
    assertContainedRealPath(fs, workspace.root, resolved, rel === "" ? path : rel);
  } catch (error) {
    if (error instanceof PathEscapeError) {
      return { code: "path-unsafe", message: "path escapes the workspace via symlink", path };
    }
    throw error;
  }
  return undefined;
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
  if (totalBytes > limits.maxPatchBytes) {
    reasons.push({
      code: "size-limit",
      message: `patch exceeds ${String(limits.maxPatchBytes)} bytes`,
    });
  }
  if (isBinaryDiff(diff)) {
    reasons.push({ code: "binary", message: "binary patches are not supported" });
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

export interface ValidateDeps {
  readonly fs?: WorkspaceFs | undefined;
  readonly limits?: PatchLimits | undefined;
}

export function validatePatch(
  workspace: WorkspaceInfo,
  diff: string,
  deps: ValidateDeps = {},
): PatchValidation {
  const fs = deps.fs ?? nodeWorkspaceFs;
  const limits = deps.limits ?? DEFAULT_PATCH_LIMITS;
  const totalBytes = Buffer.byteLength(diff, "utf8");
  let files: readonly PatchFileChange[];
  try {
    files = parseUnifiedDiff(diff).files;
  } catch (error) {
    const message = error instanceof PatchParseError ? error.message : "unparseable diff";
    return {
      ok: false,
      files: [],
      totalChangedLines: 0,
      totalBytes,
      reasons: [{ code: "malformed", message }],
      conflicts: [],
    };
  }
  const totalChangedLines = files.reduce((sum, f) => sum + f.addedLines + f.removedLines, 0);
  const reasons = [
    ...sizeAndCountReasons(diff, files, totalChangedLines, limits, totalBytes),
    ...collectPathReasons(workspace, fs, files),
  ];
  // Conflict detection touches the filesystem; only run it when the path checks passed, so a
  // denied/oversized patch never reads target files.
  const conflicts = reasons.length === 0 ? collectConflicts(workspace, fs, files) : [];
  return {
    ok: reasons.length === 0 && conflicts.length === 0,
    files,
    totalChangedLines,
    totalBytes,
    reasons,
    conflicts,
  };
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
  files: readonly PatchFileChange[],
): readonly PlannedWrite[] {
  return files.map((file) => {
    const absolute = resolveWithinWorkspace(workspace.root, file.path);
    // Defense in depth: re-assert symlink containment at the write boundary so the validated
    // absolute path handed to the WorkspaceWriter cannot escape via a symlink even if a caller
    // reached applyPatch without validatePatch (S-H1). Throws PathEscapeError on escape.
    assertContainedRealPath(fs, workspace.root, absolute, file.path);
    const original = readCurrent(workspace, fs, file.path);
    const outcome = computeFileContent(file, original);
    return { path: file.path, absolute, kind: file.kind, newContent: outcome.content, original };
  });
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

function commit(writer: WorkspaceWriter, plans: readonly PlannedWrite[]): void {
  const done: PlannedWrite[] = [];
  for (const plan of plans) {
    try {
      applyOne(writer, plan);
      done.push(plan);
    } catch (error) {
      rollback(writer, done);
      const message = error instanceof Error ? error.message : "write failed";
      throw new PatchApplyError(`apply failed, rolled back: ${message}`, plan.path);
    }
  }
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
    throw new PatchValidationError("patch failed validation", validation.reasons);
  }
  if (deps.signal.aborted) {
    throw new CommandCancelledError("apply cancelled before write phase");
  }
  const plans = planWrites(workspace, fs, validation.files);
  commit(writer, plans);
  return summarize(plans);
}
