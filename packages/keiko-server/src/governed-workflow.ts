import { createHash } from "node:crypto";
import { sep } from "node:path";
import type { EvidenceGovernedWorkflowHandoff } from "@oscharko-dev/keiko-contracts/evidence";
import type { ConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  EXPECTED_CHECKS,
  type ExpectedCheck,
  type ProposedPatchEntry,
  type UserApprovalTokenInput,
  type WorkflowHandoffRequest,
} from "@oscharko-dev/keiko-contracts/workflow-handoff";
import type { PatchFileChange, PatchValidation, WorkspaceWriter } from "@oscharko-dev/keiko-tools";
import { resolveWithinWorkspace } from "@oscharko-dev/keiko-workspace";

export interface GovernedWorkflowHandoffContext {
  readonly request: WorkflowHandoffRequest;
  readonly sourceGroundedRunId?: string | undefined;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sortChecks(checks: readonly ExpectedCheck[]): readonly ExpectedCheck[] {
  const order = new Map(EXPECTED_CHECKS.map((check, index) => [check, index]));
  return [...checks].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999) || a.localeCompare(b));
}

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

export function contextPackStableIdForPacks(packs: readonly ConnectedContextPack[]): string {
  if (packs.length === 1) {
    return packs[0]?.stableId ?? `p-${"0".repeat(64)}`;
  }
  const joined = packs.map((pack) => pack.stableId).sort().join("|");
  return `p-${sha256Hex(joined)}`;
}

export function readOnlyPathsForPacks(
  packs: readonly ConnectedContextPack[],
  editablePaths: readonly string[],
): readonly string[] {
  const editable = new Set(editablePaths);
  const unique = new Set<string>();
  for (const pack of packs) {
    for (const file of pack.files) {
      if (!editable.has(file.scopePath)) {
        unique.add(file.scopePath);
      }
    }
  }
  return [...unique].sort();
}

export function evidenceAtomIdsForPacks(
  packs: readonly ConnectedContextPack[],
): readonly string[] {
  const unique = new Set<string>();
  for (const pack of packs) {
    for (const file of pack.files) {
      for (const excerpt of file.excerpts) {
        unique.add(excerpt.atom.stableId);
      }
    }
  }
  return [...unique].sort();
}

export function approvalTokenInputFor(
  request: WorkflowHandoffRequest,
): UserApprovalTokenInput {
  return {
    contextPackStableId: request.contextPackStableId,
    workflowKind: request.workflowKind,
    editablePaths: [...request.patchScope.editablePaths].sort(),
    readOnlyPaths: [...request.patchScope.readOnlyPaths].sort(),
    evidenceAtomIds: [...request.patchScope.evidenceAtomIds].sort(),
    limits: request.patchScope.limits,
    expectedChecks: sortChecks(request.patchScope.expectedChecks),
    unknowns: [...request.patchScope.unknowns].sort(),
  };
}

export function createApprovalToken(input: UserApprovalTokenInput): string {
  return sha256Hex(JSON.stringify(input));
}

export function buildGovernedHandoffEvidence(
  handoff: GovernedWorkflowHandoffContext,
): EvidenceGovernedWorkflowHandoff {
  return {
    sourceGroundedRunId: handoff.sourceGroundedRunId ?? "unavailable",
    contextPackStableIdHash: sha256Hex(handoff.request.contextPackStableId),
    workflowKind: handoff.request.workflowKind,
    editablePathCount: handoff.request.patchScope.editablePaths.length,
    readOnlyPathCount: handoff.request.patchScope.readOnlyPaths.length,
    evidenceAtomCount: handoff.request.patchScope.evidenceAtomIds.length,
    expectedChecks: [...handoff.request.patchScope.expectedChecks],
    approvalTokenHash: sha256Hex(handoff.request.userApprovalToken),
  };
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
