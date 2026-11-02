// Nested-package resolution for monorepos whose package.json is not at the workspace root (for
// example a Maven multi-module repository with one TypeScript front-end package deep inside). Every
// filesystem access goes through the workspace boundary (resolveWithinWorkspace +
// assertContainedRealPath + WorkspaceFs), the deny-list applies to every folder, symbolic links are
// never followed during discovery, and the search is bounded. The only regular expression is one
// linear, anchored-literal match of the `packageManager` field, so there is no ReDoS surface.

import { join, posix } from "node:path";
import {
  assertContainedRealPath,
  detectWorkspaceAt,
  isDenied,
  readWorkspaceFile,
  resolveWithinWorkspace,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import type { VerificationPackageManager } from "./types.js";

/** A resolved nested package: where it lives and how its scripts are run. */
export interface VerificationPackage {
  // Workspace-relative POSIX folder holding the package.json; never "" (the root keeps the legacy
  // path and is represented by the absence of a package).
  readonly dir: string;
  readonly manager: VerificationPackageManager;
  // Whether the package's own dependency tree is installed (node_modules or Plug'n'Play).
  readonly installed: boolean;
  // The package folder detected as a workspace of its own: scripts, test framework.
  readonly workspace: WorkspaceInfo;
}

export type PackageRefusalReason = "invalid-path" | "outside-workspace" | "no-package";

export type PackageResolution =
  // The root package.json (or no package at all) answers: the legacy root path applies.
  | { readonly kind: "root" }
  | { readonly kind: "package"; readonly package: VerificationPackage }
  // Several candidate folders and nothing to pick one: the caller must name one.
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "refused"; readonly reason: PackageRefusalReason };

export interface PackageRequest {
  // Explicit workspace-relative package folder.
  readonly packageDir?: string | undefined;
  // Workspace-relative file the verifier targets; its nearest package.json ancestor is used.
  readonly targetPath?: string | undefined;
  // Receives a filesystem probe that failed; the probed folder then counts as no package.
  readonly onProbeFailure?: ((error: unknown) => void) | undefined;
}

export interface PackageDiscoveryLimits {
  readonly maxDepth: number;
  readonly maxDirectories: number;
  readonly maxEntriesPerDirectory: number;
  readonly maxCandidates: number;
}

export const PACKAGE_DISCOVERY_LIMITS: PackageDiscoveryLimits = Object.freeze({
  maxDepth: 8,
  maxDirectories: 4_000,
  maxEntriesPerDirectory: 2_000,
  maxCandidates: 10,
});

// Build output, dependency trees and VCS metadata never hold a package a person asks to verify.
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "target",
  "build",
  "dist",
  "out",
  "coverage",
  ".git",
  ".yarn",
  ".pnpm-store",
]);

const PACKAGE_READ_BYTES = 262_144;

function normalizeRelative(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\u0000") ||
    (normalized.length >= 2 && normalized[1] === ":")
  ) {
    return undefined;
  }
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return undefined;
  return segments.join("/");
}

/** The workspace a resolution reads, and the port a failed filesystem probe is reported to. */
interface Probe {
  readonly workspace: WorkspaceInfo;
  readonly fs: WorkspaceFs;
  readonly onFailure: ((error: unknown) => void) | undefined;
}

// A probe that could not read a folder or manifest answers "not a package" and is reported, so a
// candidate that vanished from the result can still be explained from the caller's log.
function reportPackageProbeFailure(probe: Probe, error: unknown): void {
  probe.onFailure?.(error);
}

function isPackageDirectory(probe: Probe, dir: string): boolean {
  const { workspace, fs } = probe;
  if (isDenied(dir)) return false;
  try {
    const folder = resolveWithinWorkspace(workspace.root, dir);
    const real = assertContainedRealPath(fs, workspace.root, folder, "verification package");
    if (!fs.stat(real).isDirectory) return false;
    const manifest = resolveWithinWorkspace(workspace.root, posix.join(dir, "package.json"));
    if (!fs.exists(manifest)) return false;
    const manifestReal = assertContainedRealPath(
      fs,
      workspace.root,
      manifest,
      "verification package manifest",
    );
    return fs.stat(manifestReal).isFile;
  } catch (error) {
    reportPackageProbeFailure(probe, error);
    return false;
  }
}

function hasRootManifest(probe: Probe): boolean {
  return probe.fs.exists(join(probe.workspace.root, "package.json"));
}

// The nearest folder at or above the file that holds a package.json, never the root itself.
function nearestPackageAbove(probe: Probe, targetPath: string): string | undefined {
  const normalized = normalizeRelative(targetPath);
  if (normalized === undefined) return undefined;
  let directory = posix.dirname(normalized);
  while (directory !== "." && directory !== "") {
    if (isPackageDirectory(probe, directory)) return directory;
    directory = posix.dirname(directory);
  }
  return undefined;
}

interface DiscoveryState {
  readonly probe: Probe;
  readonly limits: PackageDiscoveryLimits;
  readonly candidates: string[];
  visited: number;
}

function childFolders(state: DiscoveryState, dir: string): readonly string[] {
  const { workspace, fs } = state.probe;
  let entries: ReturnType<WorkspaceFs["readDir"]>;
  try {
    entries = fs.readDir(
      resolveWithinWorkspace(workspace.root, dir === "" ? "." : dir),
      state.limits.maxEntriesPerDirectory,
    );
  } catch (error) {
    reportPackageProbeFailure(state.probe, error);
    return [];
  }
  return entries
    .filter(
      (entry) => entry.isDirectory && !entry.isSymbolicLink && !SKIPPED_DIRECTORIES.has(entry.name),
    )
    .map((entry) => (dir === "" ? entry.name : posix.join(dir, entry.name)))
    .filter((child) => !isDenied(child))
    .sort(compareStrings);
}

// False when a bound stopped the search before it could finish.
function discoverIn(state: DiscoveryState, dir: string, depth: number): boolean {
  if (state.candidates.length > state.limits.maxCandidates) return false;
  if (state.visited >= state.limits.maxDirectories) return false;
  state.visited += 1;
  if (dir !== "" && isPackageDirectory(state.probe, dir)) {
    state.candidates.push(dir);
    return true;
  }
  if (depth >= state.limits.maxDepth) return true;
  return childFolders(state, dir).every((child) => discoverIn(state, child, depth + 1));
}

// Every outermost folder below the root that holds a package.json, bounded by depth, directory and
// candidate counts. A search that hits a bound stops with what it has: the caller sees more than one
// candidate (ambiguous) or a single one it can trust only when the search was not truncated.
function discoverPackages(
  probe: Probe,
  limits: PackageDiscoveryLimits,
): { readonly candidates: readonly string[]; readonly complete: boolean } {
  const state: DiscoveryState = { probe, limits, candidates: [], visited: 0 };
  const complete = discoverIn(state, "", 0);
  return { candidates: state.candidates.sort(compareStrings), complete };
}

function readManifestText(probe: Probe, dir: string): string {
  try {
    return readWorkspaceFile(
      probe.workspace,
      posix.join(dir, "package.json"),
      { maxBytes: PACKAGE_READ_BYTES },
      probe.fs,
    ).text;
  } catch (error) {
    reportPackageProbeFailure(probe, error);
    return "";
  }
}

// The `packageManager` field of a manifest; text that is not JSON simply declares none.
function declaredPackageManager(manifestText: string): VerificationPackageManager | undefined {
  const match = /"packageManager"\s*:\s*"(npm|yarn|pnpm)@/u.exec(manifestText);
  const name = match?.[1];
  return name === "yarn" || name === "pnpm" || name === "npm" ? name : undefined;
}

function existsIn(probe: Probe, dir: string, name: string): boolean {
  return probe.fs.exists(resolveWithinWorkspace(probe.workspace.root, posix.join(dir, name)));
}

/**
 * The package manager of a nested package: the nearest folder from the package up to the workspace
 * root that answers — by its `packageManager` field, then by its lockfile (`yarn.lock` or
 * `.yarnrc.yml` for Yarn, `pnpm-lock.yaml` for pnpm, `package-lock.json` for npm) — otherwise npm.
 * A Yarn or pnpm workspace keeps its lockfile at the root, not in each package.
 */
export function detectPackageManager(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  dir: string,
  onFailure?: (error: unknown) => void,
): VerificationPackageManager {
  return managerOf({ workspace, fs, onFailure }, dir);
}

// The package folder and every folder above it up to the workspace root (""), nearest first.
function foldersUpToRoot(dir: string): readonly string[] {
  const folders: string[] = [];
  let folder = dir;
  while (folder !== "") {
    folders.push(folder);
    const parent = posix.dirname(folder);
    folder = parent === "." ? "" : parent;
  }
  folders.push("");
  return folders;
}

function managerOf(probe: Probe, dir: string): VerificationPackageManager {
  for (const folder of foldersUpToRoot(dir)) {
    const answer = managerIn(probe, folder);
    if (answer !== undefined) return answer;
  }
  return "npm";
}

function managerIn(probe: Probe, dir: string): VerificationPackageManager | undefined {
  const manifest = existsIn(probe, dir, "package.json") ? readManifestText(probe, dir) : "";
  const declared = declaredPackageManager(manifest);
  if (declared !== undefined) return declared;
  if (existsIn(probe, dir, "yarn.lock") || existsIn(probe, dir, ".yarnrc.yml")) return "yarn";
  if (existsIn(probe, dir, "pnpm-lock.yaml")) return "pnpm";
  return existsIn(probe, dir, "package-lock.json") ? "npm" : undefined;
}

// Node resolves a dependency from the package folder upward, so a tree hoisted to the workspace
// root (node_modules or Plug'n'Play) installs the package as well.
function dependenciesInstalled(probe: Probe, dir: string): boolean {
  return foldersUpToRoot(dir).some(
    (folder) => existsIn(probe, folder, "node_modules") || existsIn(probe, folder, ".pnp.cjs"),
  );
}

function packageAt(probe: Probe, dir: string): VerificationPackage {
  return {
    dir,
    manager: managerOf(probe, dir),
    installed: dependenciesInstalled(probe, dir),
    workspace: detectWorkspaceAt(resolveWithinWorkspace(probe.workspace.root, dir), probe.fs, {
      scanSourceFilesForLanguages: false,
    }),
  };
}

function explicitPackage(probe: Probe, packageDir: string): PackageResolution {
  // normalizeRelative already refuses absolute, drive-letter and parent segments, so the folder
  // stays inside the workspace by construction; containment of its real path is checked below.
  const dir = normalizeRelative(packageDir);
  if (dir === undefined) return { kind: "refused", reason: "invalid-path" };
  if (!isPackageDirectory(probe, dir)) return { kind: "refused", reason: "no-package" };
  return { kind: "package", package: packageAt(probe, dir) };
}

/**
 * Which package a verification runs in. Order: an explicit `packageDir`; the nearest package.json
 * above `targetPath`, the most specific answer for the file being verified; the workspace root when
 * it has a package.json (the legacy path, unchanged); a bounded search below the root, accepted only
 * when it finds exactly one package. Several packages answer `ambiguous` so the caller can name one;
 * none answers `root` (the legacy not-run outcome). Scripts of a nested package run from the
 * workspace root with the manager's folder flag, so dependencies hoisted to the root stay reachable.
 */
export function resolveVerificationPackage(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
  request: PackageRequest = {},
  limits: PackageDiscoveryLimits = PACKAGE_DISCOVERY_LIMITS,
): PackageResolution {
  const probe: Probe = { workspace, fs, onFailure: request.onProbeFailure };
  if (request.packageDir !== undefined && request.packageDir !== "") {
    return explicitPackage(probe, request.packageDir);
  }
  const near = packageNearTarget(probe, request.targetPath);
  if (near !== undefined) return near;
  if (hasRootManifest(probe)) return { kind: "root" };
  return discoveredPackage(probe, limits);
}

function packageNearTarget(
  probe: Probe,
  targetPath: string | undefined,
): PackageResolution | undefined {
  if (targetPath === undefined || targetPath === "") return undefined;
  const dir = nearestPackageAbove(probe, targetPath);
  return dir === undefined ? undefined : { kind: "package", package: packageAt(probe, dir) };
}

function discoveredPackage(probe: Probe, limits: PackageDiscoveryLimits): PackageResolution {
  const { candidates, complete } = discoverPackages(probe, limits);
  const [only] = candidates;
  if (candidates.length === 1 && complete && only !== undefined) {
    return { kind: "package", package: packageAt(probe, only) };
  }
  return candidates.length === 0 ? { kind: "root" } : { kind: "ambiguous", candidates };
}
