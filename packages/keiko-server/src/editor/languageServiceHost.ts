// A workspace-contained TypeScript LanguageServiceHost (Issue #1198, ADR-0042 D4). Every file the
// language service reads is forced through one of three gates: (1) the in-memory overlay buffer for
// the document under analysis, (2) the TypeScript compiler's own default-library directory (its
// runtime lib.*.d.ts, which is not workspace content), or (3) the audited WorkspaceFs port behind a
// realpath containment check, so the language service can never read a path outside the registered
// workspace root — including via a symlink. tsconfig discovery resolves the nearest config inside
// the root and follows `extends` through the same gate; it never enumerates the whole project.

import { dirname, resolve } from "node:path";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { containedRealPathInfo } from "@oscharko-dev/keiko-workspace";
import ts from "typescript";

export interface ContainedHostOptions {
  readonly fs: WorkspaceFs;
  readonly realRoot: string;
  readonly overlayPath: string;
  readonly overlayText: string;
  readonly languageId: string;
  readonly cancellation: ts.HostCancellationToken;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

// True when `fileName` is the TypeScript compiler's own default-library directory or a file inside
// it. The path is resolved first so a `..`-bearing path (for example `<libDir>/../../etc/passwd`)
// can never masquerade as a lib path via a raw prefix match and bypass workspace containment.
function isWithinLibDir(libDir: string, fileName: string): boolean {
  const normalized = normalizeSlashes(resolve(fileName));
  return normalized === libDir || normalized.startsWith(`${libDir}/`);
}

const CASE_SENSITIVE = ts.sys.useCaseSensitiveFileNames;

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.full.d.ts"],
    allowNonTsExtensions: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    strict: false,
  };
}

// Builds a containment-aware reader closure set shared by the config parser and the host. A path is
// readable only if it is the overlay, a compiler lib file, or contained inside the workspace root.
function createContainedReaders(
  fs: WorkspaceFs,
  realRoot: string,
  overlayPath: string,
  overlayText: string,
  libDir: string,
): {
  readFile: (fileName: string) => string | undefined;
  fileExists: (fileName: string) => boolean;
  containedReal: (fileName: string) => string | undefined;
} {
  const overlay = normalizeSlashes(overlayPath);
  const isLibPath = (fileName: string): boolean => isWithinLibDir(libDir, fileName);
  const containedReal = (fileName: string): string | undefined => {
    try {
      return containedRealPathInfo(fs, realRoot, fileName).path;
    } catch {
      return undefined;
    }
  };
  const readFile = (fileName: string): string | undefined => {
    if (normalizeSlashes(fileName) === overlay) return overlayText;
    if (isLibPath(fileName)) {
      try {
        return fs.readFileUtf8(fileName);
      } catch {
        return undefined;
      }
    }
    const real = containedReal(fileName);
    if (real === undefined) return undefined;
    try {
      return fs.readFileUtf8(real);
    } catch {
      return undefined;
    }
  };
  const fileExists = (fileName: string): boolean => {
    if (normalizeSlashes(fileName) === overlay) return true;
    if (isLibPath(fileName)) return fs.exists(fileName);
    const real = containedReal(fileName);
    return real !== undefined && fs.exists(real);
  };
  return { readFile, fileExists, containedReal };
}

// Resolves the compiler options for the overlay: the nearest tsconfig inside the root (following
// `extends` through the contained reader, never enumerating files) merged over safe defaults.
function resolveCompilerOptions(
  fs: WorkspaceFs,
  realRoot: string,
  overlayPath: string,
  readers: ReturnType<typeof createContainedReaders>,
): ts.CompilerOptions {
  const defaults = defaultCompilerOptions();
  const configPath = ts.findConfigFile(dirname(overlayPath), readers.fileExists, "tsconfig.json");
  if (configPath === undefined || readers.containedReal(configPath) === undefined) {
    return defaults;
  }
  const configFile = ts.readConfigFile(configPath, (path) => readers.readFile(path));
  if (configFile.error !== undefined || typeof configFile.config !== "object") {
    return defaults;
  }
  const parseHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: CASE_SENSITIVE,
    // Only the options matter for single-document analysis; never enumerate the project.
    readDirectory: (): readonly string[] => [],
    fileExists: readers.fileExists,
    readFile: readers.readFile,
  };
  const parsed = ts.parseJsonConfigFileContent(configFile.config, parseHost, dirname(configPath));
  return { ...defaults, ...parsed.options, noEmit: true };
}

function containedDirectoryExists(
  fs: WorkspaceFs,
  readers: ReturnType<typeof createContainedReaders>,
  libDir: string,
  directory: string,
): boolean {
  if (isWithinLibDir(libDir, directory)) return fs.exists(directory);
  const real = readers.containedReal(directory);
  return real !== undefined && fs.exists(real);
}

function containedDirectories(
  fs: WorkspaceFs,
  readers: ReturnType<typeof createContainedReaders>,
  libDir: string,
  directory: string,
): string[] {
  // The compiler's own lib directory enumerates directly; everything else goes through the
  // realpath containment gate, mirroring containedDirectoryExists so the two never diverge.
  const real = isWithinLibDir(libDir, directory) ? directory : readers.containedReal(directory);
  if (real === undefined) return [];
  try {
    return fs
      .readDir(real)
      .filter((entry) => entry.isDirectory)
      .map((entry) => resolve(real, entry.name));
  } catch {
    return [];
  }
}

export function createContainedLanguageServiceHost(
  options: ContainedHostOptions,
): ts.LanguageServiceHost {
  const { fs, realRoot, overlayPath, overlayText, cancellation } = options;
  const libDir = normalizeSlashes(dirname(ts.getDefaultLibFilePath(defaultCompilerOptions())));
  const readers = createContainedReaders(fs, realRoot, overlayPath, overlayText, libDir);
  const compilerOptions = resolveCompilerOptions(fs, realRoot, overlayPath, readers);
  const overlay = normalizeSlashes(overlayPath);

  return {
    getCompilationSettings: (): ts.CompilerOptions => compilerOptions,
    getScriptFileNames: (): string[] => [overlayPath],
    getScriptVersion: (fileName: string): string =>
      normalizeSlashes(fileName) === overlay ? "overlay" : "0",
    getScriptSnapshot: (fileName: string): ts.IScriptSnapshot | undefined => {
      const content = readers.readFile(fileName);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: (): string => realRoot,
    getDefaultLibFileName: (compilerOpts: ts.CompilerOptions): string =>
      ts.getDefaultLibFilePath(compilerOpts),
    fileExists: readers.fileExists,
    readFile: readers.readFile,
    directoryExists: (directory: string): boolean =>
      containedDirectoryExists(fs, readers, libDir, directory),
    getDirectories: (directory: string): string[] =>
      containedDirectories(fs, readers, libDir, directory),
    realpath: (path: string): string => {
      // Only resolve symlinks for the compiler lib dir or paths proven contained; never realpath an
      // out-of-root path (it would confirm existence of files outside the workspace).
      if (isWithinLibDir(libDir, path)) {
        try {
          return fs.realPath(path);
        } catch {
          return path;
        }
      }
      return readers.containedReal(path) ?? path;
    },
    getCancellationToken: (): ts.HostCancellationToken => cancellation,
    useCaseSensitiveFileNames: (): boolean => CASE_SENSITIVE,
  };
}
