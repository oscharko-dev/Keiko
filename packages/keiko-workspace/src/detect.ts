// Workspace detection: find a root marker, then read safe metadata at the IO boundary (ADR-0005).

import { dirname, join, relative, resolve } from "node:path";
import { WORKSPACE_LANGUAGES } from "./types.js";
import { nodeWorkspaceFs, type WorkspaceDirEntry, type WorkspaceFs } from "./fs.js";
import { PathDeniedError, WorkspaceNotFoundError } from "./errors.js";
import { isDenied } from "./ignore.js";
import { LANGUAGE_MARKERS, languageForFileName } from "./languageClassification.js";
import {
  assertCanonicalWorkspaceRootIdentity,
  containedRealPathInfo,
  isCanonicalAllowedContainedPath,
  resolveExistingAllowedWorkspaceRealRoot,
  workspaceFsBoundToCanonicalRoot,
} from "./realpath.js";
import { StructuralExecutionStoppedError } from "./structuralExecution.js";
import type { TestFramework, WorkspaceInfo, WorkspaceLanguage } from "./types.js";
import {
  CANONICAL_MANIFEST_BASENAMES,
  isCanonicalMetadataFile,
  workspaceLanguageForPath,
} from "./ecosystems.js";
import { discoverCandidateInventory } from "./discovery.js";

const EXTRA_ROOT_MARKERS = [
  ".java-version",
  ".scala-version",
  "schema.sql",
  "main.tf",
  "versions.tf",
  "providers.tf",
  "buf.yaml",
  "buf.gen.yaml",
  "openapi.yaml",
  "openapi.yml",
  "openapi.json",
  "swagger.yaml",
  "swagger.yml",
  "swagger.json",
  "schema.graphql",
] as const;

const MARKERS: readonly string[] = [".git", ...CANONICAL_MANIFEST_BASENAMES, ...EXTRA_ROOT_MARKERS];
const LANGUAGE_DISCOVERY = { maxDepth: 8, maxFiles: 2_000, applyGitignore: true } as const;
const DETECTION_TEXT_MAX_BYTES = 1_048_576;
const ROOT_MARKER_ENTRY_LIMIT = 4_096;

function isExactCanonicalChild(
  root: string,
  relativePath: string,
  contained: ReturnType<typeof containedRealPathInfo>,
): boolean {
  return (
    contained.realBase === root &&
    contained.realRelative.replaceAll("\\", "/") === relativePath.replaceAll("\\", "/")
  );
}

function containedDetectionPath(
  root: string,
  relativePath: string,
  fs: WorkspaceFs,
  allowDeniedMarker = false,
): string | undefined {
  try {
    const absolutePath = join(root, relativePath);
    const contained = containedRealPathInfo(fs, root, absolutePath);
    const allowed = allowDeniedMarker
      ? isExactCanonicalChild(root, relativePath, contained)
      : isCanonicalAllowedContainedPath(contained, root, relativePath);
    return allowed ? contained.path : undefined;
  } catch (error) {
    if (error instanceof PathDeniedError || error instanceof StructuralExecutionStoppedError) {
      throw error;
    }
    return undefined;
  }
}

function containedPathStat(
  root: string,
  relativePath: string,
  fs: WorkspaceFs,
  allowDeniedMarker = false,
): ReturnType<WorkspaceFs["stat"]> | undefined {
  const path = containedDetectionPath(root, relativePath, fs, allowDeniedMarker);
  if (path === undefined) return undefined;
  try {
    if (!fs.exists(path)) return undefined;
    const stat = fs.stat(path);
    if (containedDetectionPath(root, relativePath, fs, allowDeniedMarker) !== path)
      return undefined;
    return stat.isSymbolicLink ? undefined : stat;
  } catch (error) {
    if (error instanceof PathDeniedError || error instanceof StructuralExecutionStoppedError) {
      throw error;
    }
    return undefined;
  }
}

function containedFileExists(root: string, relativePath: string, fs: WorkspaceFs): boolean {
  return containedPathStat(root, relativePath, fs)?.isFile === true;
}

function rootMarkerExists(root: string, marker: string, fs: WorkspaceFs): boolean {
  const stat = containedPathStat(root, marker, fs, marker === ".git");
  if (stat === undefined) return false;
  return marker === ".git" ? stat.isFile || stat.isDirectory : stat.isFile;
}

function readRootMarkerEntries(root: string, fs: WorkspaceFs): readonly WorkspaceDirEntry[] {
  assertCanonicalWorkspaceRootIdentity(fs, root);
  const entries = fs.readDir(root, ROOT_MARKER_ENTRY_LIMIT + 1);
  assertCanonicalWorkspaceRootIdentity(fs, root);
  return entries;
}

function hasCurrentDynamicRootMarker(
  root: string,
  fs: WorkspaceFs,
  entries: readonly WorkspaceDirEntry[],
): boolean {
  if (entries.length > ROOT_MARKER_ENTRY_LIMIT) return false;
  return entries.some(
    (entry) =>
      entry.isFile && isCanonicalMetadataFile(entry.name) && rootMarkerExists(root, entry.name, fs),
  );
}

function isRoot(dir: string, fs: WorkspaceFs): boolean {
  assertCanonicalWorkspaceRootIdentity(fs, dir);
  if (MARKERS.some((marker) => rootMarkerExists(dir, marker, fs))) {
    return true;
  }
  try {
    return hasCurrentDynamicRootMarker(dir, fs, readRootMarkerEntries(dir, fs));
  } catch (error) {
    if (error instanceof PathDeniedError || error instanceof StructuralExecutionStoppedError) {
      throw error;
    }
    return false;
  }
}

function workspaceNotFound(startDir: string): WorkspaceNotFoundError {
  return new WorkspaceNotFoundError("workspace root is unavailable", startDir);
}

function workspaceMarkerNotFound(startDir: string): WorkspaceNotFoundError {
  return new WorkspaceNotFoundError("no workspace root marker found", startDir);
}

function admitDetectionRoot(root: string, fs: WorkspaceFs): string {
  const resolved = resolve(root);
  try {
    return resolveExistingAllowedWorkspaceRealRoot(fs, resolved);
  } catch (error) {
    if (
      error instanceof PathDeniedError ||
      error instanceof WorkspaceNotFoundError ||
      error instanceof StructuralExecutionStoppedError
    ) {
      throw error;
    }
    throw workspaceNotFound(root);
  }
}

function admitAncestorRoot(root: string, startDir: string, fs: WorkspaceFs): string {
  try {
    return admitDetectionRoot(root, fs);
  } catch (error) {
    if (error instanceof StructuralExecutionStoppedError) throw error;
    if (error instanceof PathDeniedError || error instanceof WorkspaceNotFoundError) {
      throw workspaceMarkerNotFound(startDir);
    }
    throw error;
  }
}

// The canonical root the walk admitted, paired with the lexical path that names it for the caller.
interface DetectedRoot {
  readonly root: string;
  readonly selectedRoot: string;
}

// Carry the caller's lexical naming of the root up the walk alongside the canonical one, one
// dirname step at a time, and keep it only while it still resolves to the canonical directory the
// walk is standing on. An intermediate symlink can change a tree's depth, so counting levels
// afterwards would invent an alias that names a different directory; verifying each step instead
// makes `selectedRoot` either a proven alias of `root` or nothing. `undefined` means "no verified
// lexical identity" and the caller falls back to the canonical root — the walk itself, and every
// filesystem effect bound to it, is unaffected either way.
function lexicalParentAliasOf(
  lexical: string,
  canonicalParent: string,
  fs: WorkspaceFs,
): string | undefined {
  const candidate = dirname(lexical);
  if (candidate === lexical) return undefined;
  try {
    return resolveExistingAllowedWorkspaceRealRoot(fs, candidate) === canonicalParent
      ? candidate
      : undefined;
  } catch {
    // A denied or unresolvable alias is not an authorization decision here — the canonical walk
    // already made that one. Drop the lexical identity and keep going.
    return undefined;
  }
}

function findRoot(startDir: string, fs: WorkspaceFs): DetectedRoot {
  let current = admitDetectionRoot(startDir, fs);
  let lexical: string | undefined = resolve(startDir);
  // Bounded by the filesystem: dirname() reaches a fixed point at the volume root.
  for (;;) {
    if (isRoot(current, workspaceFsBoundToCanonicalRoot(fs, current))) {
      return { root: current, selectedRoot: lexical ?? current };
    }
    const parent = dirname(current);
    if (parent === current) {
      throw workspaceMarkerNotFound(startDir);
    }
    const admittedParent = admitAncestorRoot(parent, startDir, fs);
    lexical = lexical === undefined ? undefined : lexicalParentAliasOf(lexical, admittedParent, fs);
    current = admittedParent;
  }
}

interface PackageMeta {
  readonly name: string | undefined;
  readonly version: string | undefined;
  readonly testFramework: TestFramework;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function depKeys(value: unknown): readonly string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function detectFramework(record: Record<string, unknown>): TestFramework {
  const names = new Set<string>([
    ...depKeys(record.devDependencies),
    ...depKeys(record.dependencies),
  ]);
  if (names.has("vitest")) {
    return "vitest";
  }
  if (names.has("jest")) {
    return "jest";
  }
  if (names.has("mocha")) {
    return "mocha";
  }
  return "unknown";
}

const EMPTY_META: PackageMeta = { name: undefined, version: undefined, testFramework: "unknown" };

function readContainedText(root: string, path: string, fs: WorkspaceFs): string | undefined {
  const requestedRelativePath = relative(root, path).replaceAll("\\", "/");
  const containedPath = containedDetectionPath(root, requestedRelativePath, fs);
  if (containedPath === undefined || isDenied(requestedRelativePath)) return undefined;
  try {
    if (!fs.exists(containedPath)) return undefined;
    const expected = fs.stat(containedPath);
    const read = fs.readFileUtf8SameDescriptor?.(
      containedPath,
      DETECTION_TEXT_MAX_BYTES,
      "reject",
      expected,
    );
    if (read === undefined) return undefined;
    if (containedDetectionPath(root, requestedRelativePath, fs) !== containedPath) return undefined;
    return read.rawText;
  } catch (error) {
    if (error instanceof PathDeniedError || error instanceof StructuralExecutionStoppedError) {
      throw error;
    }
    return undefined;
  }
}

function readPackageMeta(root: string, fs: WorkspaceFs): PackageMeta {
  const path = join(root, "package.json");
  try {
    const raw = readContainedText(root, path, fs);
    if (raw === undefined) {
      return EMPTY_META;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return EMPTY_META;
    }
    return {
      name: asString(parsed.name),
      version: asString(parsed.version),
      testFramework: detectFramework(parsed),
    };
  } catch (error) {
    if (error instanceof PathDeniedError || error instanceof StructuralExecutionStoppedError) {
      throw error;
    }
    return EMPTY_META;
  }
}

function readIgnoreLines(root: string, fs: WorkspaceFs): readonly string[] {
  const path = join(root, ".gitignore");
  const raw = readContainedText(root, path, fs);
  if (raw === undefined) {
    return [];
  }
  return raw.split(/\r?\n/);
}

function detectDirs(
  root: string,
  fs: WorkspaceFs,
  candidates: readonly string[],
): readonly string[] {
  return candidates.filter((dir) => containedPathStat(root, dir, fs)?.isDirectory === true);
}

function discoveryWorkspace(
  root: string,
  meta: PackageMeta,
  sourceDirs: readonly string[],
  testDirs: readonly string[],
  ignoreLines: readonly string[],
): WorkspaceInfo {
  return {
    root,
    // The bounded language scan is a filesystem effect, so it runs against the canonical root only.
    selectedRoot: root,
    name: meta.name,
    version: meta.version,
    testFramework: meta.testFramework,
    sourceDirs,
    testDirs,
    languages: [],
    ignoreLines,
  };
}

function addLanguage(languages: Set<WorkspaceLanguage>, language: WorkspaceLanguage): void {
  languages.add(language);
}

function detectLanguages(
  root: string,
  fs: WorkspaceFs,
  meta: PackageMeta,
  sourceDirs: readonly string[],
  testDirs: readonly string[],
  ignoreLines: readonly string[],
  scanSourceFiles: boolean,
): readonly WorkspaceLanguage[] {
  const languages = new Set<WorkspaceLanguage>();
  for (const [language, markers] of LANGUAGE_MARKERS) {
    if (markers.some((marker) => containedFileExists(root, marker, fs))) {
      addLanguage(languages, language);
    }
  }
  try {
    if (!scanSourceFiles) return detectedLanguagesOrDefault(languages);
    const workspace = discoveryWorkspace(root, meta, sourceDirs, testDirs, ignoreLines);
    const files = discoverCandidateInventory(workspace, LANGUAGE_DISCOVERY, fs).files;
    for (const file of files) {
      const language =
        workspaceLanguageForPath(file.relativePath) ?? languageForFileName(file.relativePath);
      if (language !== undefined) {
        addLanguage(languages, language);
      }
    }
  } catch (error) {
    if (error instanceof PathDeniedError || error instanceof StructuralExecutionStoppedError) {
      throw error;
    }
    // Detection is advisory metadata. Preserve the previous safe fallback if the bounded scan fails.
  }
  return detectedLanguagesOrDefault(languages);
}

function detectedLanguagesOrDefault(
  languages: Set<WorkspaceLanguage>,
): readonly WorkspaceLanguage[] {
  if (languages.size === 0) languages.add("javascript");
  return WORKSPACE_LANGUAGES.filter((language) => languages.has(language));
}

function inspectCanonicalWorkspace(
  detected: DetectedRoot,
  fs: WorkspaceFs,
  scanSourceFiles: boolean,
): WorkspaceInfo {
  const root = detected.root;
  assertCanonicalWorkspaceRootIdentity(fs, root);
  const meta = readPackageMeta(root, fs);
  const sourceDirs = detectDirs(root, fs, ["src"]);
  const testDirs = detectDirs(root, fs, ["tests", "test", "__tests__"]);
  const ignoreLines = readIgnoreLines(root, fs);
  return {
    root,
    selectedRoot: detected.selectedRoot,
    name: meta.name,
    version: meta.version,
    testFramework: meta.testFramework,
    sourceDirs,
    testDirs,
    languages: detectLanguages(root, fs, meta, sourceDirs, testDirs, ignoreLines, scanSourceFiles),
    ignoreLines,
  };
}

// Build workspace metadata treating `root` as THE workspace root — no walk-up. The
// connected-context feature uses this for a folder the user explicitly connected (Files-window
// scope): that existing folder IS the root even without a `.git`/ecosystem marker. There is no
// walk, so the caller's own argument is the selected identity: admission already proved it resolves
// to the canonical root that every filesystem effect below binds to.
export function detectWorkspaceAt(
  root: string,
  fs: WorkspaceFs = nodeWorkspaceFs,
  options: { readonly scanSourceFilesForLanguages?: boolean } = {},
): WorkspaceInfo {
  const canonicalRoot = admitDetectionRoot(root, fs);
  return inspectCanonicalWorkspace(
    { root: canonicalRoot, selectedRoot: resolve(root) },
    workspaceFsBoundToCanonicalRoot(fs, canonicalRoot),
    options.scanSourceFilesForLanguages !== false,
  );
}

// Walk up from startDir to the nearest marker root, then read its metadata. Used
// for auto-detection (e.g. the CLI) where the caller starts inside a repository subdirectory.
export function detectWorkspace(
  startDir: string,
  fs: WorkspaceFs = nodeWorkspaceFs,
): WorkspaceInfo {
  const detected = findRoot(startDir, fs);
  return inspectCanonicalWorkspace(
    detected,
    workspaceFsBoundToCanonicalRoot(fs, detected.root),
    true,
  );
}
