// Project-aware TypeScript language service substrate for the built-in editor (Epic #2089,
// Issue #2100). This module builds warm, bounded tsconfig-backed LanguageService instances through
// the WorkspaceFs containment port only. It is not wired to the route by itself; later navigation
// and refactoring resolvers consume the project handle exported here.

import { Buffer } from "node:buffer";
import { dirname, extname, join, relative, resolve } from "node:path";
import {
  type LanguageCompletionItem,
  type LanguageCompletionItemKind,
  type LanguageCompletionResult,
  type LanguageDiagnostic,
  type LanguageDiagnosticSeverity,
  type LanguageFormattingOptions,
  type LanguageHoverResult,
  type LanguagePosition,
  type LanguageServiceErrorCode,
  type LanguageServiceLimits,
  type LanguageSymbolKind,
  type LanguageTextEdit,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import { containedRealPathInfo } from "@oscharko-dev/keiko-workspace";
import ts from "typescript";
import { pathIsDenied } from "../files-deny.js";
import type {
  LanguageDiagnosticsRaw,
  LanguageFormattingRaw,
  LanguageProviderContext,
  LanguageSymbolsRaw,
} from "./languageProvider.js";
import { computeLineStarts, positionToOffset, spanToRange } from "./textOffsets.js";

const PROJECT_CACHE_MAX_ENTRIES = 8;
const PROJECT_CACHE_IDLE_MS = 5 * 60 * 1_000;
const TS_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage"]);
const CASE_SENSITIVE = ts.sys.useCaseSensitiveFileNames;

export interface TypescriptProjectServiceError {
  readonly kind: "error";
  readonly code: LanguageServiceErrorCode;
  readonly message: string;
}

export interface TypescriptProjectServiceMiss {
  readonly kind: "notProject";
  readonly reason: string;
}

export interface TypescriptProjectHandle {
  readonly service: ts.LanguageService;
  readonly configPath: string;
  readonly projectKey: string;
  readonly rootFileNames: readonly string[];
  readonly limits: LanguageServiceLimits;
  readonly overlayPath: string;
  readonly overlayText: string;
  readonly wasReused: boolean;
  readonly truncated: boolean;
  sourceText(fileName: string): string | undefined;
  workspaceRelativePath(fileName: string): string | undefined;
}

export type TypescriptProjectServiceResult =
  | { readonly kind: "project"; readonly project: TypescriptProjectHandle }
  | TypescriptProjectServiceMiss
  | TypescriptProjectServiceError;

export interface TypescriptProjectService {
  readonly resolveProject: (ctx: LanguageProviderContext) => TypescriptProjectServiceResult;
  readonly cacheSize: () => number;
  readonly reset: () => void;
}

interface ProjectServiceOptions {
  readonly maxEntries?: number | undefined;
  readonly idleTimeoutMs?: number | undefined;
}

interface ProjectEntry {
  readonly key: string;
  readonly configPath: string;
  readonly root: string;
  readonly fs: WorkspaceFs;
  readonly files: readonly string[];
  readonly truncated: boolean;
  readonly host: ProjectLanguageServiceHost;
  readonly service: ts.LanguageService;
  idleTimer: NodeJS.Timeout | undefined;
  lastUsed: number;
  useCount: number;
}

interface ProjectDiscovery {
  readonly kind: "discovered";
  readonly configPath: string;
  readonly files: readonly string[];
  readonly compilerOptions: ts.CompilerOptions;
  readonly truncated: boolean;
}

interface BoundedReadState {
  readonly fs: WorkspaceFs;
  readonly root: string;
  readonly limits: LanguageServiceLimits;
  readonly libDir: string;
  readonly realCache: Map<string, string | undefined>;
  readonly readCache: Map<string, string>;
  workspaceReadFiles: number;
  workspaceReadBytes: number;
  truncated: boolean;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
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

function isWithinLibDir(libDir: string, fileName: string): boolean {
  const normalized = normalizeSlashes(resolve(fileName));
  return normalized === libDir || normalized.startsWith(`${libDir}/`);
}

function errorResult(
  code: LanguageServiceErrorCode,
  message: string,
): TypescriptProjectServiceError {
  return { kind: "error", code, message };
}

function containedReal(state: BoundedReadState, candidate: string): string | undefined {
  const key = normalizeSlashes(resolve(candidate));
  if (state.realCache.has(key)) return state.realCache.get(key);
  if (state.workspaceReadFiles >= state.limits.maxWorkspaceReadFiles) {
    state.truncated = true;
    state.realCache.set(key, undefined);
    return undefined;
  }
  try {
    const info = containedRealPathInfo(state.fs, state.root, candidate);
    const value = pathIsDenied(info.realRelative) ? undefined : info.path;
    state.realCache.set(key, value);
    return value;
  } catch {
    state.realCache.set(key, undefined);
    return undefined;
  }
}

function workspaceReadAllowed(state: BoundedReadState, stat: WorkspaceStat): boolean {
  return (
    stat.isFile &&
    stat.size <= state.limits.maxWorkspaceReadFileBytes &&
    state.workspaceReadFiles < state.limits.maxWorkspaceReadFiles &&
    state.workspaceReadBytes + stat.size <= state.limits.maxWorkspaceReadBytes
  );
}

function readWorkspaceFile(state: BoundedReadState, absolutePath: string): string | undefined {
  const real = containedReal(state, absolutePath);
  if (real === undefined) return undefined;
  const cached = state.readCache.get(real);
  if (cached !== undefined) return cached;
  let stat: WorkspaceStat;
  try {
    stat = state.fs.stat(real);
  } catch {
    return undefined;
  }
  if (!workspaceReadAllowed(state, stat)) {
    state.truncated = true;
    return undefined;
  }
  const text = state.fs.readFileUtf8(real);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > state.limits.maxWorkspaceReadFileBytes) {
    state.truncated = true;
    return undefined;
  }
  state.workspaceReadFiles += 1;
  state.workspaceReadBytes += bytes;
  state.readCache.set(real, text);
  return text;
}

function readFile(state: BoundedReadState, fileName: string): string | undefined {
  if (isWithinLibDir(state.libDir, fileName)) {
    try {
      return state.fs.readFileUtf8(fileName);
    } catch {
      return undefined;
    }
  }
  return readWorkspaceFile(state, fileName);
}

function fileExists(state: BoundedReadState, fileName: string): boolean {
  if (isWithinLibDir(state.libDir, fileName)) return state.fs.exists(fileName);
  const real = containedReal(state, fileName);
  return real !== undefined && state.fs.exists(real);
}

function directoryExists(state: BoundedReadState, directory: string): boolean {
  if (isWithinLibDir(state.libDir, directory)) return state.fs.exists(directory);
  const real = containedReal(state, directory);
  return real !== undefined && state.fs.exists(real);
}

function newReadState(
  fs: WorkspaceFs,
  root: string,
  limits: LanguageServiceLimits,
): BoundedReadState {
  return {
    fs,
    root,
    limits,
    libDir: normalizeSlashes(dirname(ts.getDefaultLibFilePath(defaultCompilerOptions()))),
    realCache: new Map<string, string | undefined>(),
    readCache: new Map<string, string>(),
    workspaceReadFiles: 0,
    workspaceReadBytes: 0,
    truncated: false,
  };
}

function findConfigPath(ctx: LanguageProviderContext): string | undefined {
  let current = dirname(ctx.overlayPath);
  while (normalizeSlashes(current).startsWith(normalizeSlashes(ctx.root))) {
    const candidate = join(current, "tsconfig.json");
    try {
      const info = containedRealPathInfo(ctx.fs, ctx.root, candidate);
      if (!pathIsDenied(info.realRelative) && ctx.fs.exists(info.path)) return info.path;
    } catch {
      return undefined;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function sourceFileCandidate(name: string): boolean {
  return TS_SOURCE_EXTENSIONS.has(extname(name));
}

function shouldDescendDirectory(name: string): boolean {
  return !SKIPPED_DIRECTORIES.has(name);
}

function appendSourceFile(state: BoundedReadState, filePath: string, out: string[]): void {
  if (containedReal(state, filePath) !== undefined) out.push(filePath);
}

function collectSourceFiles(state: BoundedReadState, directory: string, out: string[]): void {
  if (out.length >= state.limits.maxWorkspaceReadFiles) {
    state.truncated = true;
    return;
  }
  const real = containedReal(state, directory);
  if (real === undefined) return;
  let entries: ReturnType<WorkspaceFs["readDir"]>;
  try {
    entries = state.fs.readDir(real);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= state.limits.maxWorkspaceReadFiles) {
      state.truncated = true;
      return;
    }
    if (entry.isDirectory && shouldDescendDirectory(entry.name)) {
      collectSourceFiles(state, join(real, entry.name), out);
    } else if (entry.isFile && sourceFileCandidate(entry.name)) {
      appendSourceFile(state, join(real, entry.name), out);
    }
  }
}

function readDirectoryForConfig(state: BoundedReadState): ts.ParseConfigHost["readDirectory"] {
  return (rootDir: string, extensions: readonly string[] | undefined): string[] => {
    const files: string[] = [];
    collectSourceFiles(state, rootDir, files);
    if (extensions === undefined || extensions.length === 0) return files;
    const allowed = new Set(extensions);
    return files.filter((file) => allowed.has(extname(file)));
  };
}

function parseProjectConfig(
  ctx: LanguageProviderContext,
  configPath: string,
): ProjectDiscovery | TypescriptProjectServiceError {
  const state = newReadState(ctx.fs, ctx.root, ctx.limits);
  const configFile = ts.readConfigFile(configPath, (path) => readFile(state, path));
  if (configFile.error !== undefined || typeof configFile.config !== "object") {
    return errorResult("INVALID_REQUEST", "The TypeScript project configuration is invalid.");
  }
  const parseHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: CASE_SENSITIVE,
    readDirectory: readDirectoryForConfig(state),
    fileExists: (fileName: string): boolean => fileExists(state, fileName),
    readFile: (fileName: string): string | undefined => readFile(state, fileName),
  };
  const parsed = ts.parseJsonConfigFileContent(configFile.config, parseHost, dirname(configPath));
  if (parsed.errors.length > 0) {
    return errorResult("INVALID_REQUEST", "The TypeScript project configuration is invalid.");
  }
  const files = boundedProjectFiles(ctx, state, parsed.fileNames);
  if (files.length === 0) {
    return errorResult("INVALID_REQUEST", "The TypeScript project contains no analyzable files.");
  }
  return {
    kind: "discovered",
    configPath,
    files,
    compilerOptions: {
      ...defaultCompilerOptions(),
      ...parsed.options,
      allowJs: true,
      allowNonTsExtensions: true,
      noEmit: true,
    },
    truncated: state.truncated || parsed.fileNames.length > files.length,
  };
}

function boundedProjectFiles(
  ctx: LanguageProviderContext,
  state: BoundedReadState,
  candidates: readonly string[],
): readonly string[] {
  const files: string[] = [];
  for (const fileName of candidates) {
    if (files.length >= ctx.limits.maxWorkspaceReadFiles) {
      state.truncated = true;
      break;
    }
    const real = containedReal(state, fileName);
    if (real !== undefined && sourceFileCandidate(real)) files.push(real);
  }
  if (!files.includes(ctx.overlayPath)) files.push(ctx.overlayPath);
  return files;
}

class ProjectLanguageServiceHost implements ts.LanguageServiceHost {
  private overlayPath = "";
  private overlayText = "";
  private overlayVersion = 0;

  public constructor(
    private readonly fs: WorkspaceFs,
    private readonly root: string,
    private readonly files: readonly string[],
    private readonly compilerOptions: ts.CompilerOptions,
    private readonly limits: LanguageServiceLimits,
  ) {}

  public updateOverlay(path: string, text: string): void {
    this.overlayPath = path;
    this.overlayText = text;
    this.overlayVersion += 1;
  }

  public getCompilationSettings(): ts.CompilerOptions {
    return this.compilerOptions;
  }

  public getScriptFileNames(): string[] {
    return [...this.files];
  }

  public getScriptVersion(fileName: string): string {
    if (normalizeSlashes(fileName) === normalizeSlashes(this.overlayPath)) {
      return `overlay-${String(this.overlayVersion)}`;
    }
    try {
      const stat = this.fs.stat(fileName);
      return `${String(stat.mtimeMs ?? 0)}:${String(stat.size)}`;
    } catch {
      return "missing";
    }
  }

  public getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    const text = this.sourceText(fileName);
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
  }

  public sourceText(fileName: string): string | undefined {
    if (normalizeSlashes(fileName) === normalizeSlashes(this.overlayPath)) return this.overlayText;
    const state = newReadState(this.fs, this.root, this.limits);
    return readFile(state, fileName);
  }

  public getCurrentDirectory(): string {
    return this.root;
  }

  public getDefaultLibFileName(compilerOptions: ts.CompilerOptions): string {
    return ts.getDefaultLibFilePath(compilerOptions);
  }

  public fileExists(fileName: string): boolean {
    return fileExists(newReadState(this.fs, this.root, this.limits), fileName);
  }

  public readFile(fileName: string): string | undefined {
    return this.sourceText(fileName);
  }

  public directoryExists(directory: string): boolean {
    return directoryExists(newReadState(this.fs, this.root, this.limits), directory);
  }

  public getDirectories(directory: string): string[] {
    const state = newReadState(this.fs, this.root, this.limits);
    const real = containedReal(state, directory);
    if (real === undefined) return [];
    try {
      return this.fs
        .readDir(real)
        .filter((entry) => entry.isDirectory)
        .map((entry) => join(real, entry.name));
    } catch {
      return [];
    }
  }

  public realpath(path: string): string {
    const state = newReadState(this.fs, this.root, this.limits);
    return containedReal(state, path) ?? path;
  }

  public useCaseSensitiveFileNames(): boolean {
    return CASE_SENSITIVE;
  }
}

function projectKey(root: string, configPath: string): string {
  return `${normalizeSlashes(root)}\0${normalizeSlashes(configPath)}`;
}

function workspaceRelative(root: string, fileName: string, fs: WorkspaceFs): string | undefined {
  try {
    const info = containedRealPathInfo(fs, root, fileName);
    if (pathIsDenied(info.realRelative)) return undefined;
    return normalizeSlashes(relative(root, info.path));
  } catch {
    return undefined;
  }
}

function makeHandle(ctx: LanguageProviderContext, entry: ProjectEntry): TypescriptProjectHandle {
  return {
    service: entry.service,
    configPath: entry.configPath,
    projectKey: entry.key,
    rootFileNames: entry.files,
    limits: ctx.limits,
    overlayPath: ctx.overlayPath,
    overlayText: ctx.overlayText,
    wasReused: entry.useCount > 1,
    truncated: entry.truncated,
    sourceText: (fileName: string): string | undefined => entry.host.sourceText(fileName),
    workspaceRelativePath: (fileName: string): string | undefined =>
      workspaceRelative(ctx.root, fileName, ctx.fs),
  };
}

class CachedTypescriptProjectService implements TypescriptProjectService {
  private readonly entries = new Map<string, ProjectEntry>();
  private readonly maxEntries: number;
  private readonly idleTimeoutMs: number;

  public constructor(options: ProjectServiceOptions) {
    this.maxEntries = options.maxEntries ?? PROJECT_CACHE_MAX_ENTRIES;
    this.idleTimeoutMs = options.idleTimeoutMs ?? PROJECT_CACHE_IDLE_MS;
  }

  public resolveProject(ctx: LanguageProviderContext): TypescriptProjectServiceResult {
    const configPath = findConfigPath(ctx);
    if (configPath === undefined) {
      return { kind: "notProject", reason: "No containing tsconfig.json was discovered." };
    }
    const cached = this.entries.get(projectKey(ctx.root, configPath));
    if (cached !== undefined) return this.reuseEntry(ctx, cached);
    const discovery = parseProjectConfig(ctx, configPath);
    if (discovery.kind === "error") return discovery;
    return { kind: "project", project: makeHandle(ctx, this.createEntry(ctx, discovery)) };
  }

  public cacheSize(): number {
    return this.entries.size;
  }

  public reset(): void {
    for (const key of [...this.entries.keys()]) this.disposeEntry(key);
  }

  private disposeEntry(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.service.dispose();
    this.entries.delete(key);
  }

  private scheduleIdle(entry: ProjectEntry): void {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      this.disposeEntry(entry.key);
    }, this.idleTimeoutMs);
    entry.idleTimer.unref();
  }

  private evictLru(): void {
    if (this.entries.size <= this.maxEntries) return;
    const oldest = [...this.entries.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (oldest !== undefined) this.disposeEntry(oldest.key);
  }

  private createEntry(ctx: LanguageProviderContext, discovery: ProjectDiscovery): ProjectEntry {
    const key = projectKey(ctx.root, discovery.configPath);
    const host = new ProjectLanguageServiceHost(
      ctx.fs,
      ctx.root,
      discovery.files,
      discovery.compilerOptions,
      ctx.limits,
    );
    host.updateOverlay(ctx.overlayPath, ctx.overlayText);
    const entry: ProjectEntry = {
      key,
      configPath: discovery.configPath,
      root: ctx.root,
      fs: ctx.fs,
      files: discovery.files,
      truncated: discovery.truncated,
      host,
      service: ts.createLanguageService(host, ts.createDocumentRegistry()),
      idleTimer: undefined,
      lastUsed: Date.now(),
      useCount: 1,
    };
    this.entries.set(key, entry);
    this.scheduleIdle(entry);
    this.evictLru();
    return entry;
  }

  private reuseEntry(
    ctx: LanguageProviderContext,
    entry: ProjectEntry,
  ): TypescriptProjectServiceResult {
    entry.host.updateOverlay(ctx.overlayPath, ctx.overlayText);
    entry.lastUsed = Date.now();
    entry.useCount += 1;
    this.scheduleIdle(entry);
    return { kind: "project", project: makeHandle(ctx, entry) };
  }
}

export function createTypescriptProjectService(
  options: ProjectServiceOptions = {},
): TypescriptProjectService {
  return new CachedTypescriptProjectService(options);
}

function completionKind(kind: string): LanguageCompletionItemKind {
  return (
    new Map<string, LanguageCompletionItemKind>([
      [ts.ScriptElementKind.memberVariableElement, "property"],
      [ts.ScriptElementKind.memberFunctionElement, "method"],
      [ts.ScriptElementKind.functionElement, "function"],
      [ts.ScriptElementKind.classElement, "class"],
      [ts.ScriptElementKind.interfaceElement, "interface"],
      [ts.ScriptElementKind.moduleElement, "module"],
      [ts.ScriptElementKind.constElement, "constant"],
      [ts.ScriptElementKind.variableElement, "variable"],
      [ts.ScriptElementKind.keyword, "keyword"],
    ]).get(kind) ?? "text"
  );
}

function symbolKind(kind: string): LanguageSymbolKind {
  return (
    new Map<string, LanguageSymbolKind>([
      [ts.ScriptElementKind.moduleElement, "module"],
      [ts.ScriptElementKind.classElement, "class"],
      [ts.ScriptElementKind.interfaceElement, "interface"],
      [ts.ScriptElementKind.functionElement, "function"],
      [ts.ScriptElementKind.memberFunctionElement, "method"],
      [ts.ScriptElementKind.memberVariableElement, "property"],
      [ts.ScriptElementKind.constElement, "constant"],
      [ts.ScriptElementKind.variableElement, "variable"],
    ]).get(kind) ?? "variable"
  );
}

const SEVERITY_BY_CATEGORY: Readonly<Record<ts.DiagnosticCategory, LanguageDiagnosticSeverity>> = {
  [ts.DiagnosticCategory.Error]: "error",
  [ts.DiagnosticCategory.Warning]: "warning",
  [ts.DiagnosticCategory.Suggestion]: "hint",
  [ts.DiagnosticCategory.Message]: "info",
};

function projectLineStarts(project: TypescriptProjectHandle, fileName: string): readonly number[] {
  return computeLineStarts(project.sourceText(fileName) ?? "");
}

export function getProjectDiagnostics(project: TypescriptProjectHandle): LanguageDiagnosticsRaw {
  const syntactic = project.service.getSyntacticDiagnostics(project.overlayPath);
  const semantic = project.service.getSemanticDiagnostics(project.overlayPath);
  const all = [...syntactic, ...semantic];
  const diagnostics = all.map((diagnostic): LanguageDiagnostic => {
    const text = project.sourceText(diagnostic.file?.fileName ?? project.overlayPath) ?? "";
    const lineStarts = computeLineStarts(text);
    return {
      range: spanToRange(text, lineStarts, diagnostic.start, diagnostic.length),
      severity: SEVERITY_BY_CATEGORY[diagnostic.category],
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      source: "typescript",
      code: String(diagnostic.code),
    };
  });
  return { diagnostics, truncated: project.truncated };
}

export function getProjectCompletions(
  project: TypescriptProjectHandle,
  position: LanguagePosition,
): LanguageCompletionResult {
  const offset = positionToOffset(
    project.overlayText,
    projectLineStarts(project, project.overlayPath),
    position,
  );
  const completions = project.service.getCompletionsAtPosition(project.overlayPath, offset, {
    includeCompletionsForModuleExports: false,
    includeCompletionsForImportStatements: false,
    includeInsertTextCompletions: true,
  });
  if (completions === undefined) return { items: [], isIncomplete: false, truncated: false };
  return {
    items: completions.entries.map((entry): LanguageCompletionItem => ({
      label: entry.name,
      kind: completionKind(entry.kind),
      sortText: entry.sortText,
      ...(entry.insertText !== undefined ? { insertText: entry.insertText } : {}),
    })),
    isIncomplete: completions.isIncomplete ?? false,
    truncated: project.truncated,
  };
}

export function getProjectHover(
  project: TypescriptProjectHandle,
  position: LanguagePosition,
): LanguageHoverResult {
  const offset = positionToOffset(
    project.overlayText,
    projectLineStarts(project, project.overlayPath),
    position,
  );
  const info = project.service.getQuickInfoAtPosition(project.overlayPath, offset);
  if (info === undefined) return { contents: null };
  const display = ts.displayPartsToString(info.displayParts);
  const documentation = ts.displayPartsToString(info.documentation);
  const contents = documentation.length > 0 ? `${display}\n\n${documentation}` : display;
  return {
    contents: contents.length > 0 ? contents : null,
    range: spanToRange(
      project.overlayText,
      projectLineStarts(project, project.overlayPath),
      info.textSpan.start,
      info.textSpan.length,
    ),
  };
}

function flattenProjectSymbols(
  node: ts.NavigationTree,
  project: TypescriptProjectHandle,
  out: LanguageSymbolsRaw["symbols"] extends readonly (infer T)[] ? T[] : never,
): void {
  const text = project.overlayText;
  const lineStarts = projectLineStarts(project, project.overlayPath);
  for (const child of node.childItems ?? []) {
    const span = child.spans[0];
    out.push({
      name: child.text,
      kind: symbolKind(child.kind),
      range: spanToRange(text, lineStarts, span?.start, span?.length),
    });
    flattenProjectSymbols(child, project, out);
  }
}

export function getProjectSymbols(project: TypescriptProjectHandle): LanguageSymbolsRaw {
  const out: LanguageSymbolsRaw["symbols"] extends readonly (infer T)[] ? T[] : never = [];
  flattenProjectSymbols(project.service.getNavigationTree(project.overlayPath), project, out);
  return { symbols: out, truncated: project.truncated };
}

export function getProjectFormatting(
  project: TypescriptProjectHandle,
  options: LanguageFormattingOptions | undefined,
): LanguageFormattingRaw {
  const settings: ts.FormatCodeSettings = { ...ts.getDefaultFormatCodeSettings("\n") };
  if (options?.tabSize !== undefined) {
    settings.tabSize = options.tabSize;
    settings.indentSize = options.tabSize;
  }
  if (options?.insertSpaces !== undefined) settings.convertTabsToSpaces = options.insertSpaces;
  const changes = project.service.getFormattingEditsForDocument(project.overlayPath, settings);
  const lineStarts = projectLineStarts(project, project.overlayPath);
  const edits = changes.map((change): LanguageTextEdit => ({
    range: spanToRange(project.overlayText, lineStarts, change.span.start, change.span.length),
    newText: change.newText,
  }));
  return { edits, truncated: project.truncated };
}
