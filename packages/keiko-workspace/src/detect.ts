// Workspace detection: walk up from a start directory to the nearest root containing a
// `.git` entry or a `package.json`, then read safe metadata. The only JSON parse in the
// module is wrapped in a single try/catch at this IO boundary (ADR-0005). No clock, no RNG.

import { dirname, join, relative, resolve } from "node:path";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { WorkspaceNotFoundError } from "./errors.js";
import { isDenied } from "./ignore.js";
import { assertContainedRealPath } from "./realpath.js";
import type { TestFramework, WorkspaceInfo, WorkspaceLanguage } from "./types.js";

const MARKERS = [".git", "package.json"] as const;

function isRoot(dir: string, fs: WorkspaceFs): boolean {
  return MARKERS.some((marker) => fs.exists(join(dir, marker)));
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
        `no workspace root (.git or package.json) found above ${startDir}`,
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

function detectLanguages(root: string, fs: WorkspaceFs): readonly WorkspaceLanguage[] {
  const languages: WorkspaceLanguage[] = [];
  if (fs.exists(join(root, "tsconfig.json"))) {
    languages.push("typescript");
  }
  languages.push("javascript");
  return languages;
}

export function detectWorkspace(
  startDir: string,
  fs: WorkspaceFs = nodeWorkspaceFs,
): WorkspaceInfo {
  const root = findRoot(startDir, fs);
  const meta = readPackageMeta(root, fs);
  return {
    root,
    name: meta.name,
    version: meta.version,
    testFramework: meta.testFramework,
    sourceDirs: detectDirs(root, fs, ["src"]),
    testDirs: detectDirs(root, fs, ["tests", "test", "__tests__"]),
    languages: detectLanguages(root, fs),
    ignoreLines: readIgnoreLines(root, fs),
  };
}
