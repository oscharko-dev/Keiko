import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { resolveWithinWorkspace } from "@oscharko-dev/keiko-workspace";
import { EvidenceReadError, EvidenceWriteError } from "./errors.js";

export interface OwnedDirectoryOptions {
  readonly mode?: number | undefined;
  readonly parentReal?: string | undefined;
}

function contained(realRoot: string, realCandidate: string): boolean {
  const root = resolve(realRoot);
  const candidate = resolve(realCandidate);
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertContained(realRoot: string, realCandidate: string, label: string): void {
  if (!contained(realRoot, realCandidate)) {
    throw new EvidenceWriteError(`${label} escapes its evidence parent`);
  }
}

function assertOwnedDirectoryEntry(dir: string, label: string, forWrite: boolean): void {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink() === true) {
    const message = `${label} must not be a symlink`;
    if (forWrite) throw new EvidenceWriteError(message);
    throw new EvidenceReadError(message);
  }
  if (!stat?.isDirectory()) {
    const message = `${label} must be a real directory`;
    if (forWrite) throw new EvidenceWriteError(message);
    throw new EvidenceReadError(message);
  }
}

export function prepareOwnedDirectory(
  dir: string,
  fs: WorkspaceFs,
  label: string,
  options: OwnedDirectoryOptions = {},
): string {
  try {
    mkdirSync(dir, { recursive: true, mode: options.mode ?? 0o700 });
    assertOwnedDirectoryEntry(dir, label, true);
    const real = fs.realPath(dir);
    if (options.parentReal !== undefined) assertContained(options.parentReal, real, label);
    return real;
  } catch (error) {
    if (error instanceof EvidenceWriteError) throw error;
    throw new EvidenceWriteError(
      `cannot create ${label}: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

export function existingOwnedDirectory(
  dir: string,
  fs: WorkspaceFs,
  label: string,
  options: Pick<OwnedDirectoryOptions, "parentReal"> = {},
): string | undefined {
  if (!fs.exists(dir)) return undefined;
  try {
    assertOwnedDirectoryEntry(dir, label, false);
    const real = fs.realPath(dir);
    if (options.parentReal !== undefined) assertContained(options.parentReal, real, label);
    return real;
  } catch (error) {
    if (error instanceof EvidenceReadError || error instanceof EvidenceWriteError) throw error;
    throw new EvidenceReadError(
      `cannot read ${label}: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

export function ownedChildPath(realBase: string, name: string): string {
  return resolveWithinWorkspace(realBase, name);
}

function assertDeletableOwnedTree(dir: string, label: string): void {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new EvidenceWriteError(`${label} must be a real directory`);
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = resolveWithinWorkspace(dir, entry.name);
    const childStat = lstatSync(child);
    if (childStat.isSymbolicLink()) {
      throw new EvidenceWriteError(`${label} contains a symlink entry`);
    }
    if (childStat.isFile() && childStat.nlink > 1) {
      throw new EvidenceWriteError(`${label} contains a hardlinked file`);
    }
    if (childStat.isDirectory()) {
      assertDeletableOwnedTree(child, label);
    }
  }
}

// eslint-disable-next-line complexity -- containment deletion has to check missing, symlink, hardlink, and realpath cases inline.
export function removeOwnedRunDirectory(
  rootDir: string,
  runId: string,
  fs: WorkspaceFs,
  label: string,
  options: { readonly containmentRoot?: string | undefined } = {},
): boolean {
  let realRoot: string | undefined;
  try {
    realRoot = existingOwnedDirectory(rootDir, fs, label);
  } catch (error) {
    if (error instanceof EvidenceReadError) throw new EvidenceWriteError(error.message);
    throw error;
  }
  if (realRoot === undefined) return false;
  if (options.containmentRoot !== undefined) {
    let realContainmentRoot: string | undefined;
    try {
      realContainmentRoot = existingOwnedDirectory(options.containmentRoot, fs, "evidence root");
    } catch (error) {
      if (error instanceof EvidenceReadError) throw new EvidenceWriteError(error.message);
      throw error;
    }
    if (realContainmentRoot === undefined || !contained(realContainmentRoot, realRoot)) {
      throw new EvidenceWriteError(`${label} escapes the evidence directory`);
    }
  }
  const runDir = ownedChildPath(realRoot, runId);
  const stat = lstatSync(runDir, { throwIfNoEntry: false });
  if (stat === undefined) return false;
  if (stat.isSymbolicLink()) {
    throw new EvidenceWriteError(`${label} run directory must not be a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new EvidenceWriteError(`${label} run directory must be a real directory`);
  }
  const realRunDir = fs.realPath(runDir);
  assertContained(realRoot, realRunDir, `${label} run directory`);
  assertDeletableOwnedTree(runDir, `${label} run directory`);
  rmSync(runDir, { recursive: true, force: true });
  return true;
}
