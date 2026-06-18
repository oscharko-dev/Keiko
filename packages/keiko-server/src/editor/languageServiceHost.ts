// A workspace-contained TypeScript LanguageServiceHost (Issue #1198, ADR-0042 D4). Every file the
// language service reads is forced through one of three gates: (1) the in-memory overlay buffer for
// the document under analysis, (2) the TypeScript compiler's own default-library directory (its
// runtime lib.*.d.ts, which is not workspace content), or (3) the audited WorkspaceFs port behind a
// realpath containment check, so the language service can never read a path outside the registered
// workspace root — including via a symlink. tsconfig discovery resolves the nearest config inside
// the root and follows `extends` through the same gate; it never enumerates the whole project.

import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  type LanguageServiceLimits,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import { containedRealPathInfo } from "@oscharko-dev/keiko-workspace";
import ts from "typescript";
import { pathIsDenied } from "../files-deny.js";

export interface ContainedHostOptions {
  readonly fs: WorkspaceFs;
  readonly realRoot: string;
  readonly overlayPath: string;
  readonly overlayText: string;
  readonly languageId: string;
  readonly cancellation: ts.HostCancellationToken;
  readonly limits?: LanguageServiceLimits | undefined;
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

interface ContainedReaderState {
  readonly fs: WorkspaceFs;
  readonly realRoot: string;
  readonly libDir: string;
  readonly cancellation: ts.HostCancellationToken;
  readonly limits: LanguageServiceLimits;
  readonly containedRealCache: Map<string, string | undefined>;
  readonly workspaceReadCache: Map<string, string>;
  workspacePathProbes: number;
  workspaceReadBytes: number;
  workspaceReadFiles: number;
}

interface ContainedReaders {
  readFile: (fileName: string) => string | undefined;
  fileExists: (fileName: string) => boolean;
  containedReal: (fileName: string) => string | undefined;
}

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

function throwIfLanguageServiceCancelled(cancellation: ts.HostCancellationToken): void {
  if (!cancellation.isCancellationRequested()) return;
  // TypeScript catches this exact class while cancelling language-service work.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw new ts.OperationCanceledException();
}

function cacheContainedReal(
  state: ContainedReaderState,
  key: string,
  value: string | undefined,
): string | undefined {
  state.containedRealCache.set(key, value);
  return value;
}

function resolveContainedReal(state: ContainedReaderState, fileName: string): string | undefined {
  throwIfLanguageServiceCancelled(state.cancellation);
  const key = normalizeSlashes(resolve(fileName));
  if (state.containedRealCache.has(key)) {
    return state.containedRealCache.get(key);
  }
  if (state.workspacePathProbes >= state.limits.maxWorkspaceReadFiles) {
    return cacheContainedReal(state, key, undefined);
  }
  state.workspacePathProbes += 1;
  try {
    const info = containedRealPathInfo(state.fs, state.realRoot, fileName);
    return cacheContainedReal(state, key, pathIsDenied(info.realRelative) ? undefined : info.path);
  } catch {
    return cacheContainedReal(state, key, undefined);
  }
}

function workspaceReadAllowedByStat(state: ContainedReaderState, stat: WorkspaceStat): boolean {
  return (
    stat.isFile &&
    stat.size <= state.limits.maxWorkspaceReadFileBytes &&
    state.workspaceReadFiles < state.limits.maxWorkspaceReadFiles &&
    state.workspaceReadBytes + stat.size <= state.limits.maxWorkspaceReadBytes
  );
}

function readBoundedWorkspaceFile(state: ContainedReaderState, real: string): string | undefined {
  const cached = state.workspaceReadCache.get(real);
  if (cached !== undefined) return cached;
  throwIfLanguageServiceCancelled(state.cancellation);
  let stat: WorkspaceStat;
  try {
    stat = state.fs.stat(real);
  } catch {
    return undefined;
  }
  if (!workspaceReadAllowedByStat(state, stat)) return undefined;
  let content: string;
  try {
    content = state.fs.readFileUtf8(real);
  } catch {
    return undefined;
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > state.limits.maxWorkspaceReadFileBytes) return undefined;
  if (state.workspaceReadBytes + bytes > state.limits.maxWorkspaceReadBytes) return undefined;
  state.workspaceReadFiles += 1;
  state.workspaceReadBytes += bytes;
  state.workspaceReadCache.set(real, content);
  return content;
}

// Builds a containment-aware reader closure set shared by the config parser and the host. A path is
// readable only if it is the overlay, a compiler lib file, or contained inside the workspace root.
function createContainedReaders(
  fs: WorkspaceFs,
  realRoot: string,
  overlayPath: string,
  overlayText: string,
  libDir: string,
  cancellation: ts.HostCancellationToken,
  limits: LanguageServiceLimits,
): ContainedReaders {
  const overlay = normalizeSlashes(overlayPath);
  const isLibPath = (fileName: string): boolean => isWithinLibDir(libDir, fileName);
  const state: ContainedReaderState = {
    fs,
    realRoot,
    libDir,
    cancellation,
    limits,
    containedRealCache: new Map<string, string | undefined>(),
    workspaceReadCache: new Map<string, string>(),
    workspacePathProbes: 0,
    workspaceReadBytes: 0,
    workspaceReadFiles: 0,
  };
  const containedReal = (fileName: string): string | undefined =>
    resolveContainedReal(state, fileName);
  const readFile = (fileName: string): string | undefined => {
    throwIfLanguageServiceCancelled(cancellation);
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
    return readBoundedWorkspaceFile(state, real);
  };
  const fileExists = (fileName: string): boolean => {
    throwIfLanguageServiceCancelled(cancellation);
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
  readers: ContainedReaders,
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
  return {
    ...defaults,
    ...parsed.options,
    allowJs: true,
    allowNonTsExtensions: true,
    noEmit: true,
  };
}

function containedDirectoryExists(
  fs: WorkspaceFs,
  readers: ContainedReaders,
  libDir: string,
  directory: string,
): boolean {
  if (isWithinLibDir(libDir, directory)) return fs.exists(directory);
  const real = readers.containedReal(directory);
  return real !== undefined && fs.exists(real);
}

function containedDirectories(
  fs: WorkspaceFs,
  readers: ContainedReaders,
  libDir: string,
  limits: LanguageServiceLimits,
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
      .slice(0, limits.maxWorkspaceReadFiles)
      .map((entry) => resolve(real, entry.name));
  } catch {
    return [];
  }
}

export function createContainedLanguageServiceHost(
  options: ContainedHostOptions,
): ts.LanguageServiceHost {
  const { fs, realRoot, overlayPath, overlayText, cancellation } = options;
  const limits = options.limits ?? DEFAULT_LANGUAGE_SERVICE_LIMITS;
  const libDir = normalizeSlashes(dirname(ts.getDefaultLibFilePath(defaultCompilerOptions())));
  const readers = createContainedReaders(
    fs,
    realRoot,
    overlayPath,
    overlayText,
    libDir,
    cancellation,
    limits,
  );
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
      containedDirectories(fs, readers, libDir, limits, directory),
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
