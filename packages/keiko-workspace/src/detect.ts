// Workspace detection: walk up from a start directory to the nearest root containing a
// VCS marker or common ecosystem manifest, then read safe metadata. The only JSON parse in the
// module is wrapped in a single try/catch at this IO boundary (ADR-0005). No clock, no RNG.

import { dirname, join, relative, resolve } from "node:path";
import { WORKSPACE_LANGUAGES } from "./types.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { WorkspaceNotFoundError } from "./errors.js";
import { isDenied } from "./ignore.js";
import { assertContainedRealPath } from "./realpath.js";
import type { TestFramework, WorkspaceInfo, WorkspaceLanguage } from "./types.js";
import {
  CANONICAL_MANIFEST_BASENAMES,
  isCanonicalMetadataFile,
  workspaceLanguageForPath,
} from "./ecosystems.js";
import { discoverFiles } from "./discovery.js";

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

function isRoot(dir: string, fs: WorkspaceFs): boolean {
  if (MARKERS.some((marker) => fs.exists(join(dir, marker)))) {
    return true;
  }
  try {
    return fs.readDir(dir).some((entry) => entry.isFile && isCanonicalMetadataFile(entry.name));
  } catch {
    return false;
  }
}

function findRoot(startDir: string, fs: WorkspaceFs): string {
  let current = resolve(startDir);
  // Bounded by the filesystem: dirname() reaches a fixed point at the volume root.
  for (;;) {
    if (isRoot(current, fs)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new WorkspaceNotFoundError(
        `no workspace root marker found above ${startDir}`,
        startDir,
      );
    }
    current = parent;
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

function toRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split("\\").join("/");
}

function toRealRelative(root: string, fs: WorkspaceFs, absolutePath: string): string {
  try {
    return toRelative(fs.realPath(root), absolutePath);
  } catch {
    return toRelative(root, absolutePath);
  }
}

function readContainedText(root: string, path: string, fs: WorkspaceFs): string | undefined {
  if (!fs.exists(path)) {
    return undefined;
  }
  try {
    const containedPath = assertContainedRealPath(fs, root, path, path);
    if (isDenied(toRealRelative(root, fs, containedPath))) {
      return undefined;
    }
    return fs.readFileUtf8(containedPath);
  } catch {
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
  } catch {
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

function isExistingDir(absolutePath: string, fs: WorkspaceFs): boolean {
  return fs.exists(absolutePath) && fs.stat(absolutePath).isDirectory;
}

function detectDirs(
  root: string,
  fs: WorkspaceFs,
  candidates: readonly string[],
): readonly string[] {
  return candidates.filter((dir) => isExistingDir(join(root, dir), fs));
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
    name: meta.name,
    version: meta.version,
    testFramework: meta.testFramework,
    sourceDirs,
    testDirs,
    languages: [],
    ignoreLines,
  };
}

const LANGUAGE_MARKERS: readonly (readonly [WorkspaceLanguage, readonly string[]])[] = [
  ["typescript", ["tsconfig.json", "tsconfig.base.json", "tsconfig.build.json"]],
  ["javascript", ["package.json", "jsconfig.json"]],
  ["java", ["pom.xml", "build.gradle", "build.gradle.kts", ".java-version"]],
  ["kotlin", ["build.gradle.kts", "settings.gradle.kts"]],
  ["scala", ["build.sbt", ".scala-version"]],
  ["groovy", ["build.gradle", "settings.gradle"]],
  ["go", ["go.mod", "go.work"]],
  ["rust", ["Cargo.toml", "rust-toolchain.toml", "rust-toolchain"]],
  ["python", ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"]],
  ["csharp", ["global.json", "Directory.Build.props"]],
  ["cpp", ["CMakeLists.txt"]],
  ["swift", ["Package.swift"]],
  ["ruby", ["Gemfile"]],
  ["php", ["composer.json"]],
  ["sql", ["schema.sql"]],
  ["terraform", ["main.tf", "versions.tf", "providers.tf"]],
  ["protobuf", ["buf.yaml", "buf.gen.yaml"]],
  [
    "openapi",
    ["openapi.yaml", "openapi.yml", "openapi.json", "swagger.yaml", "swagger.yml", "swagger.json"],
  ],
  ["graphql", ["schema.graphql"]],
];

const EXTENSION_LANGUAGES: Readonly<Partial<Record<string, WorkspaceLanguage>>> = {
  c: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  csx: "csharp",
  cxx: "cpp",
  fs: "fsharp",
  fsi: "fsharp",
  fsx: "fsharp",
  go: "go",
  gradle: "groovy",
  graphql: "graphql",
  groovy: "groovy",
  gql: "graphql",
  h: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  java: "java",
  js: "javascript",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  php: "php",
  proto: "protobuf",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scala: "scala",
  sql: "sql",
  swift: "swift",
  tf: "terraform",
  tfvars: "terraform",
  ts: "typescript",
  tsx: "typescript",
  vb: "vb",
};

const FILE_NAME_LANGUAGES: readonly (readonly [RegExp, WorkspaceLanguage])[] = [
  [/^(openapi|swagger)\.(?:ya?ml|json)$/u, "openapi"],
];

function addLanguage(languages: Set<WorkspaceLanguage>, language: WorkspaceLanguage): void {
  languages.add(language);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function languageForFileName(name: string): WorkspaceLanguage | undefined {
  const lower = name.toLowerCase();
  for (const [pattern, language] of FILE_NAME_LANGUAGES) {
    if (pattern.test(lower)) {
      return language;
    }
  }
  return EXTENSION_LANGUAGES[extensionOf(lower)];
}

function detectLanguages(
  root: string,
  fs: WorkspaceFs,
  meta: PackageMeta,
  sourceDirs: readonly string[],
  testDirs: readonly string[],
  ignoreLines: readonly string[],
): readonly WorkspaceLanguage[] {
  const languages = new Set<WorkspaceLanguage>();
  for (const [language, markers] of LANGUAGE_MARKERS) {
    if (markers.some((marker) => fs.exists(join(root, marker)))) {
      addLanguage(languages, language);
    }
  }
  try {
    const workspace = discoveryWorkspace(root, meta, sourceDirs, testDirs, ignoreLines);
    const files = discoverFiles(workspace, LANGUAGE_DISCOVERY, fs);
    for (const file of files) {
      const language = workspaceLanguageForPath(file.relativePath) ?? languageForFileName(file.relativePath);
      if (language !== undefined) {
        addLanguage(languages, language);
      }
    }
  } catch {
    // Detection is advisory metadata. Preserve the previous safe fallback if the bounded scan fails.
  }
  if (languages.size === 0) {
    languages.add("javascript");
  }
  return WORKSPACE_LANGUAGES.filter((language) => languages.has(language));
}

// Build workspace metadata treating `root` as THE workspace root — no walk-up, never throws
// WorkspaceNotFoundError. The connected-context feature uses this for a folder the user explicitly
// connected (Files-window scope): that folder IS the root even when it carries no `.git`/
// ecosystem marker, so an arbitrary documents folder is searchable just like a repository.
export function detectWorkspaceAt(root: string, fs: WorkspaceFs = nodeWorkspaceFs): WorkspaceInfo {
  const resolved = resolve(root);
  const meta = readPackageMeta(resolved, fs);
  const sourceDirs = detectDirs(resolved, fs, ["src"]);
  const testDirs = detectDirs(resolved, fs, ["tests", "test", "__tests__"]);
  const ignoreLines = readIgnoreLines(resolved, fs);
  return {
    root: resolved,
    name: meta.name,
    version: meta.version,
    testFramework: meta.testFramework,
    sourceDirs,
    testDirs,
    languages: detectLanguages(resolved, fs, meta, sourceDirs, testDirs, ignoreLines),
    ignoreLines,
  };
}

// Walk up from startDir to the nearest marker root, then read its metadata. Used
// for auto-detection (e.g. the CLI) where the caller starts inside a repository subdirectory.
export function detectWorkspace(
  startDir: string,
  fs: WorkspaceFs = nodeWorkspaceFs,
): WorkspaceInfo {
  return detectWorkspaceAt(findRoot(startDir, fs), fs);
}
