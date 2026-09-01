// Keiko-owned managed-worktree root: ownership proof + realpath containment (Issue #445, Epic #443).
//
// Before any worktree is written, the server must PROVE it owns the managed root (SC2) and that the
// derived worktree path stays inside it even after symlink resolution (AC2). Ownership is proven by a
// marker file Keiko creates with restrictive permissions; containment delegates entirely to
// @oscharko-dev/keiko-workspace (no second containment engine, ADR-0088 D5): a lexical check followed
// by a realpath check that walks the existing parent chain, so a symlinked ancestor that escapes the
// root is rejected even though the leaf worktree directory does not yet exist.

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { PathEscapeError, resolveWithinWorkspace } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { assertContainedRealPathWithinOwnedRoot } from "@oscharko-dev/keiko-workspace/internal/owned-root";
import { MANAGED_ROOT_MARKER_FILENAME } from "./naming.js";
import { TaskWorkspaceError } from "./errors.js";

const MARKER_CONTENT = JSON.stringify({ keikoManagedRoot: true, schemaVersion: "1" });
const MAX_MARKER_BYTES = 256;

function chmodBestEffort(target: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(target, mode);
  } catch {
    // best-effort permission hardening; ownership is proven by the marker, not by perms alone.
  }
}

function hardenMarkerPermissionsBestEffort(target: string): void {
  if (process.platform === "win32") return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) return;
    fchmodSync(descriptor, 0o600);
    const after = fstatSync(descriptor, { bigint: true });
    if (!after.isFile() || (after.mode & 0o777n) !== 0o600n) {
      throw new Error("managed-root marker permissions were not hardened");
    }
  } catch {
    // Preserve the existing best-effort permission contract without following a replaced symlink.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

// Creates (if absent) and proves ownership of the managed-worktree root. The marker file is the
// ownership proof: provisioning refuses to write under a root Keiko cannot establish and mark as its
// own (SC2). Throws a content-free UNSAFE_PATH error when ownership cannot be proven.
export function assertManagedRootOwned(managedRoot: string): void {
  try {
    mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
    const rootStat = nodeWorkspaceFs.stat(managedRoot);
    if (!rootStat.isDirectory || rootStat.isSymbolicLink) {
      throw new Error("managed root is not a regular directory");
    }
    chmodBestEffort(managedRoot, 0o700);
    const markerPath = join(managedRoot, MANAGED_ROOT_MARKER_FILENAME);
    if (!existsSync(markerPath)) {
      writeFileSync(markerPath, MARKER_CONTENT, { mode: 0o600, flag: "wx" });
    }
    hardenMarkerPermissionsBestEffort(markerPath);
    if (!isManagedRootOwned(managedRoot)) {
      throw new Error("managed-root marker is invalid");
    }
  } catch (error) {
    if (error instanceof TaskWorkspaceError) throw error;
    throw new TaskWorkspaceError(
      "UNSAFE_PATH",
      "managed worktree root ownership could not be established",
    );
  }
}

// Asserts the derived worktree path is contained inside the managed root lexically AND after realpath
// resolution. Delegates to keiko-workspace; any escape (parent traversal, NUL, symlinked ancestor,
// absolute outside-root target) becomes a content-free UNSAFE_PATH error.
export function assertManagedTargetContained(managedRoot: string, worktreePath: string): void {
  try {
    resolveWithinWorkspace(managedRoot, worktreePath);
    assertContainedRealPathWithinOwnedRoot(
      nodeWorkspaceFs,
      managedRoot,
      worktreePath,
      "managed worktree path",
    );
  } catch (error) {
    if (error instanceof PathEscapeError) {
      throw new TaskWorkspaceError("UNSAFE_PATH", "worktree path escapes the managed root");
    }
    throw new TaskWorkspaceError("UNSAFE_PATH", "worktree path failed containment validation");
  }
}

// Ensures the worktree's PARENT directory (`<managedRoot>/<repositoryId>`) exists before `git worktree
// add`, which creates only the leaf directory. Must run AFTER containment is asserted.
export function ensureManagedWorktreeParent(worktreePath: string): void {
  mkdirSync(dirname(worktreePath), { recursive: true, mode: 0o700 });
}

// Whether the managed worktree directory currently exists on disk. Combined with the store lookup by
// the service to classify a target as managed (resume) vs. unmanaged (reject).
export function managedTargetExists(worktreePath: string): boolean {
  return existsSync(worktreePath);
}

// Non-throwing, read-only ownership check (#448): the managed root is a no-follow directory AND its
// bounded, descriptor-safe marker is a regular file with the exact Keiko schema. Unlike
// assertManagedRootOwned it never creates the root or marker, so it is the correct gate for read-only
// health evaluation and cleanup. Any IO or identity error fails closed (not owned).
export function isManagedRootOwned(managedRoot: string): boolean {
  try {
    const rootStat = nodeWorkspaceFs.stat(managedRoot);
    if (!rootStat.isDirectory || rootStat.isSymbolicLink) return false;
    const canonicalRoot = nodeWorkspaceFs.realPath(managedRoot);
    const read = nodeWorkspaceFs.readFileUtf8WithinRootSameDescriptor;
    if (read === undefined) return false;
    const marker = read(
      canonicalRoot,
      join(canonicalRoot, MANAGED_ROOT_MARKER_FILENAME),
      MAX_MARKER_BYTES,
      "reject",
      "complete",
    );
    return marker.stat.isFile && !marker.stat.isSymbolicLink && marker.rawText === MARKER_CONTENT;
  } catch {
    return false;
  }
}

// Non-throwing containment check (#448): true iff `target` resolves inside the managed root lexically
// AND after realpath resolution. Delegates to the same keiko-workspace engine as the throwing assert
// (no second containment engine); any escape — parent traversal, NUL, symlinked ancestor, out-of-root
// absolute path — or an unverifiable parent chain fails closed (not contained).
export function isManagedTargetContained(managedRoot: string, target: string): boolean {
  try {
    assertManagedTargetContained(managedRoot, target);
    return true;
  } catch {
    return false;
  }
}
