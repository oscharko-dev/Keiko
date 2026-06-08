import { sep } from "node:path";
import {
  checkPatchAgainstScope,
  type ProposedPatchEntry,
  type WorkflowHandoffRequest,
} from "@oscharko-dev/keiko-contracts/workflow-handoff";
import type { PatchFileChange, PatchValidation, WorkspaceWriter } from "@oscharko-dev/keiko-tools";
import { resolveWithinWorkspace } from "@oscharko-dev/keiko-workspace";

function fileHeader(file: PatchFileChange): readonly string[] {
  if (file.kind === "create") {
    return ["--- /dev/null", `+++ b/${file.path}`];
  }
  if (file.kind === "delete") {
    return [`--- a/${file.path}`, "+++ /dev/null"];
  }
  return [`--- a/${file.path}`, `+++ b/${file.path}`];
}

function filePatchBytes(file: PatchFileChange): number {
  const lines = [...fileHeader(file)];
  for (const hunk of file.hunks) {
    lines.push(`@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`);
    lines.push(...hunk.lines);
  }
  return Buffer.byteLength(lines.join("\n"), "utf8");
}

function absoluteEditablePaths(
  workspaceRoot: string,
  editablePaths: readonly string[],
): ReadonlySet<string> {
  return new Set(editablePaths.map((path) => resolveWithinWorkspace(workspaceRoot, path)));
}

function canCreateDirectory(dir: string, allowedFiles: ReadonlySet<string>): boolean {
  for (const allowed of allowedFiles) {
    if (allowed === dir || allowed.startsWith(`${dir}${sep}`)) {
      return true;
    }
  }
  return false;
}

export function proposedPatchEntriesFromValidation(
  validation: PatchValidation,
): readonly ProposedPatchEntry[] {
  if (validation.files.length === 0) {
    return [];
  }
  const entries = validation.files.map((file) => ({
    path: file.path,
    newFile: file.kind === "create",
    patchBytes: filePatchBytes(file),
  }));
  const observed = entries.reduce((sum, entry) => sum + entry.patchBytes, 0);
  const delta = Math.max(0, validation.totalBytes - observed);
  if (delta > 0) {
    const last = entries[entries.length - 1];
    if (last !== undefined) {
      last.patchBytes += delta;
    }
  }
  return entries;
}

export function governedPatchRejectionCode(
  handoff: WorkflowHandoffRequest | undefined,
  validation: PatchValidation,
): string | undefined {
  if (handoff === undefined) {
    return undefined;
  }
  const scopeCheck = checkPatchAgainstScope(
    handoff.patchScope,
    proposedPatchEntriesFromValidation(validation),
  );
  return scopeCheck.ok ? undefined : "out-of-scope";
}

export function createScopedWriter(
  baseWriter: WorkspaceWriter,
  workspaceRoot: string,
  editablePaths: readonly string[],
): WorkspaceWriter {
  const allowedFiles = absoluteEditablePaths(workspaceRoot, editablePaths);
  const assertAllowed = (absolutePath: string): void => {
    if (!allowedFiles.has(absolutePath)) {
      throw new Error(`Patch scope forbids writing ${absolutePath}`);
    }
  };
  return {
    writeFileUtf8(absolutePath, content): void {
      assertAllowed(absolutePath);
      baseWriter.writeFileUtf8(absolutePath, content);
    },
    mkdirp(absoluteDir): void {
      if (!canCreateDirectory(absoluteDir, allowedFiles)) {
        throw new Error(`Patch scope forbids creating ${absoluteDir}`);
      }
      baseWriter.mkdirp(absoluteDir);
    },
    remove(absolutePath): void {
      assertAllowed(absolutePath);
      baseWriter.remove(absolutePath);
    },
    rename(fromAbsolute, toAbsolute): void {
      assertAllowed(fromAbsolute);
      assertAllowed(toAbsolute);
      baseWriter.rename(fromAbsolute, toAbsolute);
    },
  };
}
