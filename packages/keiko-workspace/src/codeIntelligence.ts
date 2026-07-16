/* eslint-disable complexity, max-lines-per-function -- Polyglot regex indexing is intentionally consolidated here so resolver/scanner heuristics stay auditable in one place. */
import { createHash } from "node:crypto";
import { dirname, normalize, posix } from "node:path";
import ts from "typescript";
import type {
  EvidenceAtom,
  EvidenceEdge,
  EvidenceEdgeEndpoint,
  EvidenceEdgeKind,
  LineRange,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { redact } from "@oscharko-dev/keiko-security";
import { readWorkspaceFile } from "./discovery.js";
import { FileTooLargeError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import { resolveWithinWorkspace } from "./paths.js";
import { buildAtom, gatherCandidates } from "./repoSearchScan.js";
import { expandedQueryTerms } from "./repoSearchQueryTerms.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import { assertContainedRealPath } from "./realpath.js";

export type CodeLanguage =
  | "typescript"
  | "javascript"
  | "java"
  | "kotlin"
  | "scala"
  | "groovy"
  | "go"
  | "rust"
  | "python"
  | "csharp"
  | "fsharp"
  | "vb"
  | "cpp"
  | "swift"
  | "ruby"
  | "php"
  | "protobuf"
  | "graphql"
  | "openapi";

export type CodeSymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "record"
  | "struct"
  | "trait"
  | "constant"
  | "module";

export type CodeParserKind = "typescript-compiler-ast" | "polyglot-regex";

export interface CodeParserCoverage {
  readonly parser: CodeParserKind;
  readonly filesIndexed: number;
}

export interface CodeImportEdge {
  readonly kind: "import" | "export";
  readonly importerPath: string;
  readonly importerLine: number;
  readonly specifier: string;
  readonly targetPath?: string | undefined;
  readonly confidence: "resolved" | "heuristic";
  readonly language: CodeLanguage;
  readonly parser: CodeParserKind;
}

export interface CodeSymbol {
  readonly name: string;
  readonly kind: CodeSymbolKind;
  readonly scopePath: string;
  readonly language: CodeLanguage;
  readonly lineRange: LineRange;
  readonly fields: readonly string[];
  readonly parser: CodeParserKind;
}

export interface CodeCallEdge {
  readonly callerPath: string;
  readonly callerLine: number;
  readonly calleeName: string;
  readonly targetName: string;
  readonly targetPath: string;
  readonly targetLineRange: LineRange;
  readonly confidence: "resolved" | "heuristic";
  readonly parser: CodeParserKind;
}

export interface CodeReferenceEdge {
  readonly referencerPath: string;
  readonly referenceLineRange: LineRange;
  readonly referenceName: string;
  readonly targetName: string;
  readonly targetPath: string;
  readonly targetLineRange: LineRange;
  readonly confidence: "resolved" | "heuristic";
  readonly parser: CodeParserKind;
}

export interface ApiEndpoint {
  readonly role: "server" | "client";
  readonly method: string;
  readonly path: string;
  readonly scopePath: string;
  readonly lineRange: LineRange;
  readonly language: CodeLanguage;
  readonly parser: CodeParserKind;
}

export interface ApiContractEdge {
  readonly client: ApiEndpoint;
  readonly server: ApiEndpoint;
  readonly confidence: "resolved" | "heuristic";
}

export interface DtoContractEdge {
  readonly source: CodeSymbol;
  readonly target: CodeSymbol;
  readonly sharedFields: readonly string[];
  readonly confidence: "resolved" | "heuristic";
}

export type PackageDependencyKind =
  "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";

export interface PackageDependencyEdge {
  readonly sourcePackage: string;
  readonly sourcePath: string;
  readonly targetPackage: string;
  readonly targetPath: string;
  readonly dependencyKind: PackageDependencyKind;
  readonly confidence: "resolved" | "heuristic";
}

export interface CodeIntelligenceIndex {
  readonly imports: readonly CodeImportEdge[];
  readonly symbols: readonly CodeSymbol[];
  readonly calls: readonly CodeCallEdge[];
  readonly references: readonly CodeReferenceEdge[];
  readonly endpoints: readonly ApiEndpoint[];
  readonly apiContracts: readonly ApiContractEdge[];
  readonly dtoContracts: readonly DtoContractEdge[];
  readonly packageDependencies: readonly PackageDependencyEdge[];
  readonly filesIndexed: number;
  readonly filesSkipped: number;
  readonly filesPartiallyIndexed: number;
  readonly parserCoverage: readonly CodeParserCoverage[];
}

interface SourceFile {
  readonly scopePath: string;
  readonly text: string;
  readonly language: CodeLanguage;
  readonly parser: CodeParserKind;
  readonly syntaxTree?: ts.SourceFile | undefined;
}

interface SourceText {
  readonly scopePath: string;
  readonly text: string;
  readonly language: CodeLanguage;
  readonly partial: boolean;
}

interface CodeImportBinding {
  readonly importerPath: string;
  readonly localName: string;
  readonly importedName: string;
  readonly targetPath: string;
}

interface TypescriptReExportBinding {
  readonly exporterPath: string;
  readonly exportedName?: string | undefined;
  readonly importedName?: string | undefined;
  readonly targetPath: string;
}

interface TypescriptDefaultExport {
  readonly scopePath: string;
  readonly symbolName: string;
}

interface TypescriptReExportResolverContext {
  readonly reExportsByFile: ReadonlyMap<string, readonly TypescriptReExportBinding[]>;
  readonly defaultExportsByFile: ReadonlyMap<string, readonly string[]>;
  readonly symbolsByFile: ReadonlyMap<string, readonly CodeSymbol[]>;
}

interface ResolvedTypescriptImportTarget {
  readonly targetPath: string;
  readonly importedName: string;
}

interface BuildDeps {
  readonly nowMs?: () => number;
  readonly disableCache?: boolean | undefined;
}

interface TsPathAlias {
  readonly configDir: string;
  readonly baseUrl?: string | undefined;
  readonly pattern: string;
  readonly targets: readonly string[];
}

interface TsImportResolverConfig {
  readonly aliases: readonly TsPathAlias[];
  readonly baseUrls: readonly string[];
  readonly packages: readonly WorkspacePackageAlias[];
  readonly goModules: readonly GoModuleAlias[];
}

interface WorkspacePackageExport {
  readonly subpath: string;
  readonly targets: readonly string[];
}

interface WorkspacePackageAlias {
  readonly name: string;
  readonly root: string;
  readonly manifestPath: string;
  readonly entryTargets: readonly string[];
  readonly exports: readonly WorkspacePackageExport[];
  readonly dependencies: readonly {
    readonly name: string;
    readonly kind: PackageDependencyKind;
  }[];
}

interface GoModuleAlias {
  readonly modulePath: string;
  readonly root: string;
}

const INDEX_CACHE_LIMIT = 16;
const PERSISTENT_CACHE_SCHEMA_VERSION = 13;
// Structural indexing benefits from whole declarations/import sections. Keep this bounded, but do
// not inherit the lexical scanner's smaller per-file prefix cap that is tuned for fast grep-style IO.
const CODE_INDEX_MAX_SOURCE_BYTES = 2_097_152;
const PERSISTENT_CACHE_DIR = ".keiko/code-intelligence";
const GRAPH_NEIGHBOR_DEPTH_LIMIT = 4;
const GRAPH_NEIGHBOR_ATOM_LIMIT = 80;
const GRAPH_NEIGHBOR_SEED_ATOM_LIMIT = 32;
const GRAPH_NEIGHBOR_SCORE_DECAY = 0.92;
const RE_EXPORT_RESOLUTION_DEPTH_LIMIT = 12;
const fsCacheIds = new WeakMap<WorkspaceFs, number>();
const indexCache = new Map<string, CodeIntelligenceIndex>();
let nextFsCacheId = 1;

function cacheIdForFs(fs: WorkspaceFs): number {
  const existing = fsCacheIds.get(fs);
  if (existing !== undefined) {
    return existing;
  }
  const id = nextFsCacheId;
  nextFsCacheId += 1;
  fsCacheIds.set(fs, id);
  return id;
}

const EXTENSION_LANGUAGE: Readonly<Partial<Record<string, CodeLanguage>>> = {
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  cts: "typescript",
  fs: "fsharp",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  groovy: "groovy",
  gvy: "groovy",
  java: "java",
  js: "javascript",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  mjs: "javascript",
  mts: "typescript",
  php: "php",
  proto: "protobuf",
  py: "python",
  pyi: "python",
  rb: "ruby",
  rs: "rust",
  scala: "scala",
  sc: "scala",
  swift: "swift",
  ts: "typescript",
  tsx: "typescript",
  vb: "vb",
  vue: "typescript",
  yaml: "openapi",
  yml: "openapi",
};

const SOURCE_EXTENSIONS = new Set(Object.keys(EXTENSION_LANGUAGE));
const JS_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue"];
const PY_EXTENSIONS = ["py", "pyi"];
const IGNORED_CALL_NAMES = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "sizeof",
  "typeof",
  "new",
  "super",
  "this",
]);

function queryFingerprint(query: RetrievalQuery): string {
  const canonical = JSON.stringify({ kind: query.kind, text: query.text });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function extension(scopePath: string): string {
  const base = scopePath.toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1);
}

function isOpenApiSpecPath(scopePath: string): boolean {
  const lower = scopePath.toLowerCase();
  return /(?:^|\/)(?:openapi|swagger)\.(?:ya?ml|json)$/u.test(lower);
}

function languageForPath(scopePath: string): CodeLanguage | undefined {
  if (isOpenApiSpecPath(scopePath)) {
    return "openapi";
  }
  return EXTENSION_LANGUAGE[extension(scopePath)];
}

function isIndexable(scopePath: string): boolean {
  return isOpenApiSpecPath(scopePath) || SOURCE_EXTENSIONS.has(extension(scopePath));
}

function lineRange(line: number): LineRange {
  return { startLine: line, endLine: line };
}

function supportsTypescriptCompilerAst(scopePath: string, language: CodeLanguage): boolean {
  if (language !== "typescript" && language !== "javascript") {
    return false;
  }
  return extension(scopePath) !== "vue";
}

function parserKindForSource(scopePath: string, language: CodeLanguage): CodeParserKind {
  return supportsTypescriptCompilerAst(scopePath, language)
    ? "typescript-compiler-ast"
    : "polyglot-regex";
}

function scriptKindForPath(scopePath: string): ts.ScriptKind {
  switch (extension(scopePath)) {
    case "jsx":
      return ts.ScriptKind.JSX;
    case "js":
    case "mjs":
    case "cjs":
      return ts.ScriptKind.JS;
    case "tsx":
      return ts.ScriptKind.TSX;
    case "json":
      return ts.ScriptKind.JSON;
    default:
      return ts.ScriptKind.TS;
  }
}

function parseTypescriptSource(file: Omit<SourceFile, "parser" | "syntaxTree">): ts.SourceFile {
  return ts.createSourceFile(
    file.scopePath,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(file.scopePath),
  );
}

function nodeStartLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function nodeLineRange(sourceFile: ts.SourceFile, node: ts.Node): LineRange {
  const startLine = nodeStartLine(sourceFile, node);
  const endPosition = Math.max(node.getStart(sourceFile), node.getEnd() - 1);
  const endLine = sourceFile.getLineAndCharacterOfPosition(endPosition).line + 1;
  return { startLine, endLine };
}

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function declarationNameText(
  name: ts.PropertyName | ts.BindingName | undefined,
): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  return undefined;
}

function normalizeScopePath(scopePath: string): string {
  return normalize(scopePath).split("\\").join("/");
}

function resolveCandidate(
  pathSet: ReadonlySet<string>,
  base: string,
  extensions: readonly string[],
): string | undefined {
  const normalized = normalizeScopePath(base);
  if (pathSet.has(normalized)) {
    return normalized;
  }
  for (const ext of extensions) {
    const candidate = `${normalized}.${ext}`;
    if (pathSet.has(candidate)) {
      return candidate;
    }
  }
  for (const ext of extensions) {
    const candidate = `${normalized}/index.${ext}`;
    if (pathSet.has(candidate)) {
      return candidate;
    }
    const init = `${normalized}/__init__.${ext}`;
    if (pathSet.has(init)) {
      return init;
    }
  }
  return undefined;
}

function resolveDirectoryCandidate(
  pathSet: ReadonlySet<string>,
  directory: string,
  extensions: readonly string[],
): string | undefined {
  const normalized = normalizeScopePath(directory).replace(/\/$/u, "");
  const prefix = normalized.length === 0 ? "" : `${normalized}/`;
  const matches = [...pathSet].filter((path) => {
    if (!path.startsWith(prefix)) {
      return false;
    }
    const rest = path.slice(prefix.length);
    return !rest.includes("/") && extensions.some((ext) => rest.endsWith(`.${ext}`));
  });
  matches.sort(
    (a, b) => Number(a.endsWith("_test.go")) - Number(b.endsWith("_test.go")) || a.localeCompare(b),
  );
  return matches[0];
}

function tsconfigDir(scopePath: string): string {
  const dir = dirname(scopePath);
  return dir === "." ? "" : normalizeScopePath(dir);
}

function isTsconfigPath(scopePath: string): boolean {
  const base = scopePath.split("/").at(-1)?.toLowerCase() ?? "";
  return /^tsconfig(?:\.[^.]+)?\.json$/u.test(base);
}

function isPackageJsonPath(scopePath: string): boolean {
  return scopePath.split("/").at(-1)?.toLowerCase() === "package.json";
}

function isGoModPath(scopePath: string): boolean {
  return scopePath.split("/").at(-1)?.toLowerCase() === "go.mod";
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function exportTargets(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!isRecord(value)) {
    return [];
  }
  const preferred = ["import", "default", "types", "module", "require", "main"];
  const out: string[] = [];
  for (const key of preferred) {
    const child = value[key];
    if (typeof child === "string") {
      out.push(child);
    }
  }
  return out;
}

function packageEntryTargets(parsed: Record<string, unknown>): readonly string[] {
  const exportsTargets = isRecord(parsed.exports)
    ? exportTargets(parsed.exports["."])
    : exportTargets(parsed.exports);
  const fallback = [parsed.module, parsed.main, parsed.types].filter(
    (value): value is string => typeof value === "string",
  );
  return [...new Set([...exportsTargets, ...fallback, "."])];
}

function packageExports(parsed: Record<string, unknown>): readonly WorkspacePackageExport[] {
  if (!isRecord(parsed.exports)) {
    return [];
  }
  const out: WorkspacePackageExport[] = [];
  for (const [subpath, value] of Object.entries(parsed.exports)) {
    if (!subpath.startsWith("./") || subpath === ".") {
      continue;
    }
    const targets = exportTargets(value);
    if (targets.length > 0) {
      out.push({ subpath: subpath.slice(2), targets });
    }
  }
  return out;
}

const PACKAGE_DEPENDENCY_KINDS: readonly PackageDependencyKind[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function packageDependencies(
  parsed: Record<string, unknown>,
): WorkspacePackageAlias["dependencies"] {
  const out: { name: string; kind: PackageDependencyKind }[] = [];
  const seen = new Set<string>();
  for (const kind of PACKAGE_DEPENDENCY_KINDS) {
    const deps = parsed[kind];
    if (!isRecord(deps)) {
      continue;
    }
    for (const name of Object.keys(deps).sort((a, b) => a.localeCompare(b))) {
      const key = `${kind}\0${name}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ name, kind });
    }
  }
  return out;
}

function collectWorkspacePackages(
  scope: SearchScope,
  fs: WorkspaceFs,
  candidates: readonly { readonly relativePath: string }[],
): readonly WorkspacePackageAlias[] {
  const packages: WorkspacePackageAlias[] = [];
  for (const candidate of candidates) {
    if (
      !isPackageJsonPath(candidate.relativePath) ||
      candidate.relativePath.includes("node_modules/")
    ) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        readWorkspaceFile(scope.workspace, candidate.relativePath, { maxBytes: 262_144 }, fs).text,
      );
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.name !== "string" || parsed.name.length === 0) {
      continue;
    }
    packages.push({
      name: parsed.name,
      root: tsconfigDir(candidate.relativePath),
      manifestPath: candidate.relativePath,
      entryTargets: packageEntryTargets(parsed),
      exports: packageExports(parsed),
      dependencies: packageDependencies(parsed),
    });
  }
  return packages;
}

function collectGoModules(
  scope: SearchScope,
  fs: WorkspaceFs,
  candidates: readonly { readonly relativePath: string }[],
): readonly GoModuleAlias[] {
  const modules: GoModuleAlias[] = [];
  for (const candidate of candidates) {
    if (!isGoModPath(candidate.relativePath)) {
      continue;
    }
    let text: string;
    try {
      text = readWorkspaceFile(
        scope.workspace,
        candidate.relativePath,
        { maxBytes: 65_536 },
        fs,
      ).text;
    } catch {
      continue;
    }
    const modulePath = /^\s*module\s+(\S+)/mu.exec(text)?.[1];
    if (modulePath === undefined || modulePath.length === 0) {
      continue;
    }
    modules.push({ modulePath, root: tsconfigDir(candidate.relativePath) });
  }
  modules.sort((a, b) => b.modulePath.length - a.modulePath.length || a.root.localeCompare(b.root));
  return modules;
}

function readTsCompilerOptions(
  scope: SearchScope,
  fs: WorkspaceFs,
  relativePath: string,
): Record<string, unknown> | undefined {
  try {
    const text = readWorkspaceFile(scope.workspace, relativePath, { maxBytes: 262_144 }, fs).text;
    const result = ts.parseConfigFileTextToJson(relativePath, text);
    const parsed: unknown = result.error === undefined ? (result.config as unknown) : undefined;
    return isRecord(parsed) && isRecord(parsed.compilerOptions)
      ? parsed.compilerOptions
      : undefined;
  } catch {
    return undefined;
  }
}

function collectTsConfigAliases(
  aliases: TsPathAlias[],
  compilerOptions: Readonly<Record<string, unknown>>,
  configDir: string,
  baseUrl: string,
): void {
  if (!isRecord(compilerOptions.paths)) return;
  for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
    aliases.push({ configDir, baseUrl, pattern, targets: asStringArray(targets) });
  }
}

function collectTsImportResolverConfig(
  scope: SearchScope,
  fs: WorkspaceFs,
  candidates: readonly { readonly relativePath: string }[],
): TsImportResolverConfig {
  const aliases: TsPathAlias[] = [];
  const baseUrls: string[] = [];
  for (const candidate of candidates) {
    if (!isTsconfigPath(candidate.relativePath)) continue;
    const compilerOptions = readTsCompilerOptions(scope, fs, candidate.relativePath);
    if (compilerOptions === undefined) continue;
    const baseUrl = typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : ".";
    const configDir = tsconfigDir(candidate.relativePath);
    if (typeof compilerOptions.baseUrl === "string") {
      baseUrls.push(normalizeScopePath(posix.join(configDir, compilerOptions.baseUrl)));
    }
    collectTsConfigAliases(aliases, compilerOptions, configDir, baseUrl);
  }
  return {
    aliases,
    baseUrls: [...new Set(baseUrls)],
    packages: collectWorkspacePackages(scope, fs, candidates),
    goModules: collectGoModules(scope, fs, candidates),
  };
}

function linkPackageDependencies(
  packages: readonly WorkspacePackageAlias[],
): readonly PackageDependencyEdge[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const edges: PackageDependencyEdge[] = [];
  for (const source of packages) {
    for (const dependency of source.dependencies) {
      const target = byName.get(dependency.name);
      if (target === undefined || target.manifestPath === source.manifestPath) {
        continue;
      }
      edges.push({
        sourcePackage: source.name,
        sourcePath: source.manifestPath,
        targetPackage: target.name,
        targetPath: target.manifestPath,
        dependencyKind: dependency.kind,
        confidence: "resolved",
      });
    }
  }
  return edges.sort(
    (a, b) =>
      a.sourcePath.localeCompare(b.sourcePath) ||
      a.targetPath.localeCompare(b.targetPath) ||
      a.dependencyKind.localeCompare(b.dependencyKind),
  );
}

function wildcardSubstitution(pattern: string, value: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star < 0) {
    return pattern === value ? "" : undefined;
  }
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) {
    return undefined;
  }
  return value.slice(prefix.length, value.length - suffix.length);
}

function applyWildcard(target: string, substitution: string): string {
  return target.includes("*") ? target.replaceAll(/\*/gu, substitution) : target;
}

function aliasBase(alias: TsPathAlias, target: string): string {
  return normalizeScopePath(posix.join(alias.configDir, alias.baseUrl ?? ".", target));
}

function resolveTsAliasTarget(
  specifier: string,
  pathSet: ReadonlySet<string>,
  resolver: TsImportResolverConfig,
): string | undefined {
  for (const alias of resolver.aliases) {
    const substitution = wildcardSubstitution(alias.pattern, specifier);
    if (substitution === undefined) {
      continue;
    }
    for (const target of alias.targets) {
      const candidate = resolveCandidate(
        pathSet,
        aliasBase(alias, applyWildcard(target, substitution)),
        JS_EXTENSIONS,
      );
      if (candidate !== undefined) {
        return candidate;
      }
    }
  }
  for (const baseUrl of resolver.baseUrls) {
    const candidate = resolveCandidate(pathSet, posix.join(baseUrl, specifier), JS_EXTENSIONS);
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function resolvePackageTargetPath(
  pathSet: ReadonlySet<string>,
  pkg: WorkspacePackageAlias,
  target: string,
): string | undefined {
  const base = normalizeScopePath(posix.join(pkg.root, target));
  const direct = resolveCandidate(pathSet, base, JS_EXTENSIONS);
  if (direct !== undefined) {
    return direct;
  }
  const sourceSibling = base.replace(/\.(?:mjs|cjs|js|jsx)$/u, "");
  return sourceSibling === base
    ? undefined
    : resolveCandidate(pathSet, sourceSibling, JS_EXTENSIONS);
}

function resolveWorkspacePackageEntry(
  pathSet: ReadonlySet<string>,
  pkg: WorkspacePackageAlias,
): string | undefined {
  for (const target of pkg.entryTargets) {
    const resolved = resolvePackageTargetPath(pathSet, pkg, target);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function resolveWorkspacePackageSubpath(
  subpath: string,
  pathSet: ReadonlySet<string>,
  pkg: WorkspacePackageAlias,
): string | undefined {
  const exact = pkg.exports.find((item) => item.subpath === subpath);
  const wildcard = pkg.exports
    .map((item) => ({ item, substitution: wildcardSubstitution(item.subpath, subpath) }))
    .find((entry) => entry.substitution !== undefined);
  const targets = exact?.targets ?? wildcard?.item.targets ?? [subpath];
  const substitution = wildcard?.substitution ?? "";
  for (const target of targets.map((candidate) => applyWildcard(candidate, substitution))) {
    const resolved = resolvePackageTargetPath(pathSet, pkg, target);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function resolveWorkspacePackageTarget(
  specifier: string,
  pathSet: ReadonlySet<string>,
  resolver: TsImportResolverConfig,
): string | undefined {
  for (const pkg of resolver.packages) {
    if (specifier === pkg.name) return resolveWorkspacePackageEntry(pathSet, pkg);
    if (!specifier.startsWith(`${pkg.name}/`)) continue;
    const subpath = specifier.slice(pkg.name.length + 1);
    return resolveWorkspacePackageSubpath(subpath, pathSet, pkg);
  }
  return undefined;
}

function resolveGoModuleTarget(
  specifier: string,
  pathSet: ReadonlySet<string>,
  resolver: TsImportResolverConfig,
): string | undefined {
  for (const module of resolver.goModules) {
    if (specifier !== module.modulePath && !specifier.startsWith(`${module.modulePath}/`)) {
      continue;
    }
    const subpath =
      specifier === module.modulePath ? "" : specifier.slice(module.modulePath.length + 1);
    const packageDir = normalizeScopePath(posix.join(module.root, subpath));
    const direct = resolveCandidate(pathSet, packageDir, ["go"]);
    if (direct !== undefined) {
      return direct;
    }
    const directory = resolveDirectoryCandidate(pathSet, packageDir, ["go"]);
    if (directory !== undefined) {
      return directory;
    }
  }
  return undefined;
}

function suffixCandidate(pathSet: ReadonlySet<string>, suffix: string): string | undefined {
  const normalized = normalizeScopePath(suffix).toLowerCase();
  const matches = [...pathSet].filter((path) => path.toLowerCase().endsWith(normalized));
  matches.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  return matches[0];
}

function resolvePythonRelativeImport(
  importerPath: string,
  specifier: string,
  pathSet: ReadonlySet<string>,
): string | undefined {
  const leadingDots = /^\.+/u.exec(specifier)?.[0].length ?? 0;
  const moduleName = specifier.slice(leadingDots);
  if (leadingDots === 0 || moduleName.length === 0) {
    return undefined;
  }
  let baseDir = dirname(importerPath);
  for (let i = 1; i < leadingDots; i += 1) {
    baseDir = dirname(baseDir);
  }
  return resolveCandidate(
    pathSet,
    posix.join(baseDir, moduleName.replaceAll(/\./gu, "/")),
    PY_EXTENSIONS,
  );
}

type ImportResolution = Pick<CodeImportEdge, "targetPath" | "confidence">;

function importResolution(target: string | undefined): ImportResolution {
  return target === undefined
    ? { confidence: "heuristic" }
    : { targetPath: target, confidence: "resolved" };
}

function resolveLocalImport(
  edge: Omit<CodeImportEdge, "targetPath" | "confidence">,
  pathSet: ReadonlySet<string>,
): ImportResolution {
  const importerDir = dirname(edge.importerPath);
  const relativeBase = importerDir === "." ? "" : importerDir;
  const joined = edge.specifier.startsWith("/")
    ? edge.specifier.slice(1)
    : posix.join(relativeBase, edge.specifier);
  return importResolution(
    resolveCandidate(pathSet, joined, edge.language === "python" ? PY_EXTENSIONS : JS_EXTENSIONS),
  );
}

function resolveTypescriptImportTarget(
  specifier: string,
  pathSet: ReadonlySet<string>,
  resolver: TsImportResolverConfig,
): string | undefined {
  return (
    resolveTsAliasTarget(specifier, pathSet, resolver) ??
    resolveWorkspacePackageTarget(specifier, pathSet, resolver)
  );
}

function jvmSourceExtension(language: CodeImportEdge["language"]): string {
  switch (language) {
    case "kotlin":
      return "kt";
    case "scala":
      return "scala";
    case "groovy":
      return "groovy";
    default:
      return "java";
  }
}

function resolveJvmImport(
  language: CodeImportEdge["language"],
  specifier: string,
  pathSet: ReadonlySet<string>,
): ImportResolution {
  const sourceExtension = jvmSourceExtension(language);
  return importResolution(
    suffixCandidate(pathSet, `${specifier.replaceAll(".", "/")}.${sourceExtension}`),
  );
}

function resolvePythonImport(specifier: string, pathSet: ReadonlySet<string>): ImportResolution {
  const modulePath = specifier.replaceAll(".", "/");
  return importResolution(
    resolveCandidate(pathSet, modulePath, PY_EXTENSIONS) ??
      suffixCandidate(pathSet, `${modulePath}.py`) ??
      suffixCandidate(pathSet, `${modulePath}/__init__.py`),
  );
}

function resolveGoImport(
  specifier: string,
  pathSet: ReadonlySet<string>,
  resolver: TsImportResolverConfig,
): ImportResolution {
  return importResolution(
    resolveGoModuleTarget(specifier, pathSet, resolver) ??
      suffixCandidate(pathSet, `${specifier.replace(/^.*?\//u, "")}.go`) ??
      suffixCandidate(pathSet, specifier),
  );
}

function resolveFallbackImport(
  edge: Omit<CodeImportEdge, "targetPath" | "confidence">,
  pathSet: ReadonlySet<string>,
): ImportResolution {
  const parts = edge.specifier.split(/[/.]/u);
  let last: string | undefined;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part !== undefined && part.length > 0) {
      last = part;
      break;
    }
  }
  return importResolution(
    last === undefined
      ? undefined
      : suffixCandidate(pathSet, `${last}.${extension(edge.importerPath)}`),
  );
}

function resolveImportTarget(
  edge: Omit<CodeImportEdge, "targetPath" | "confidence">,
  pathSet: ReadonlySet<string>,
  resolver: TsImportResolverConfig,
): Pick<CodeImportEdge, "targetPath" | "confidence"> {
  const specifier = edge.specifier;
  if (edge.language === "python" && specifier.startsWith(".")) {
    return importResolution(resolvePythonRelativeImport(edge.importerPath, specifier, pathSet));
  }
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return resolveLocalImport(edge, pathSet);
  }
  if (specifier.startsWith("@/")) {
    return importResolution(resolveCandidate(pathSet, `src/${specifier.slice(2)}`, JS_EXTENSIONS));
  }
  switch (edge.language) {
    case "typescript":
    case "javascript": {
      const target = resolveTypescriptImportTarget(specifier, pathSet, resolver);
      return target === undefined ? resolveFallbackImport(edge, pathSet) : importResolution(target);
    }
    case "java":
    case "kotlin":
    case "scala":
    case "groovy":
      return resolveJvmImport(edge.language, specifier, pathSet);
    case "python":
      return resolvePythonImport(specifier, pathSet);
    case "go":
      return resolveGoImport(specifier, pathSet, resolver);
    default:
      return resolveFallbackImport(edge, pathSet);
  }
}

function collectImportEdges(
  file: SourceFile,
  pathSet: ReadonlySet<string>,
  resolver: TsImportResolverConfig,
): readonly CodeImportEdge[] {
  if (file.syntaxTree !== undefined) {
    return collectTypescriptImportEdges(file, pathSet, resolver);
  }
  const edges: CodeImportEdge[] = [];
  const lines = file.text.split(/\r?\n/u);
  let inGoImportBlock = false;
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const emit = (kind: "import" | "export", specifier: string): void => {
      const partial = {
        kind,
        importerPath: file.scopePath,
        importerLine: lineNo,
        specifier,
        language: file.language,
        parser: "polyglot-regex",
      } satisfies Omit<CodeImportEdge, "targetPath" | "confidence">;
      edges.push({ ...partial, ...resolveImportTarget(partial, pathSet, resolver) });
    };
    for (const pattern of [
      /^\s*import(?:[ \t]+\S+(?:[ \t]+\S+)*[ \t]+from)?\s+["']([^"'\n]+)["']/u,
      /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/u,
      /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/u,
    ]) {
      const match = pattern.exec(line);
      if (match?.[1] !== undefined) emit("import", match[1]);
    }
    const exportMatch = /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"'\n]+)["']/u.exec(line);
    if (exportMatch?.[1] !== undefined) emit("export", exportMatch[1]);
    const javaMatch =
      /^\s*import\s+(?:static\s+)?([A-Za-z_][\w.*]*(?:\.[A-Za-z_][\w*]*)?)\s*;/u.exec(line);
    if (javaMatch?.[1] !== undefined) emit("import", javaMatch[1].replace(/\.\*$/u, ""));
    const pythonFrom = /^\s*from\s+(\.*[A-Za-z_][\w.]*)\s+import\b/u.exec(line);
    if (pythonFrom?.[1] !== undefined) emit("import", pythonFrom[1]);
    const pythonImport = /^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+\w+)?/u.exec(line);
    if (pythonImport?.[1] !== undefined) emit("import", pythonImport[1]);
    if (/^\s*import\s*\(\s*$/u.test(line)) {
      inGoImportBlock = true;
      return;
    }
    if (inGoImportBlock && /^\s*\)/u.test(line)) {
      inGoImportBlock = false;
      return;
    }
    const goImport =
      /^\s*import\s+"([^"]+)"/u.exec(line) ??
      (inGoImportBlock ? /^\s*(?:\w+\s+)?["']([^"']+)["']/u.exec(line) : null);
    if (goImport?.[1] !== undefined) emit("import", goImport[1]);
    const rustUse = /^\s*(?:pub\s+)?(?:use|mod)\s+([A-Za-z_][\w:]*)/u.exec(line);
    if (rustUse?.[1] !== undefined) emit("import", rustUse[1].replaceAll(/::/gu, "/"));
    const csharpUsing = /^\s*using\s+([A-Za-z_][\w.]*)\s*;/u.exec(line);
    if (csharpUsing?.[1] !== undefined) emit("import", csharpUsing[1]);
  });
  return edges;
}

function collectTypescriptImportEdges(
  file: SourceFile,
  pathSet: ReadonlySet<string>,
  resolver: TsImportResolverConfig,
): readonly CodeImportEdge[] {
  const edges: CodeImportEdge[] = [];
  const sourceFile = file.syntaxTree;
  if (sourceFile === undefined) {
    return edges;
  }
  const emit = (kind: "import" | "export", node: ts.Node, specifier: string): void => {
    const partial = {
      kind,
      importerPath: file.scopePath,
      importerLine: nodeStartLine(sourceFile, node),
      specifier,
      language: file.language,
      parser: "typescript-compiler-ast",
    } satisfies Omit<CodeImportEdge, "targetPath" | "confidence">;
    edges.push({ ...partial, ...resolveImportTarget(partial, pathSet, resolver) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== undefined) {
        emit("import", node, specifier);
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== undefined) {
        emit("export", node, specifier);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = stringLiteralText(node.moduleReference.expression);
      if (specifier !== undefined) {
        emit("import", node, specifier);
      }
    } else if (ts.isCallExpression(node)) {
      const [firstArg] = node.arguments;
      const specifier = stringLiteralText(firstArg);
      if (
        specifier !== undefined &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        emit("import", node, specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return edges;
}

function resolvedTargetsBySpecifier(
  file: SourceFile,
  imports: readonly CodeImportEdge[],
  kind?: CodeImportEdge["kind"],
): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  for (const edge of imports) {
    if (edge.importerPath !== file.scopePath || edge.targetPath === undefined) continue;
    if (kind !== undefined && edge.kind !== kind) continue;
    targets.set(edge.specifier, edge.targetPath);
  }
  return targets;
}

function appendTypescriptImportBinding(
  bindings: CodeImportBinding[],
  file: SourceFile,
  resolver: TypescriptReExportResolverContext,
  targetBySpecifier: ReadonlyMap<string, string>,
  specifier: string,
  localName: string,
  importedName: string,
): void {
  const targetPath = targetBySpecifier.get(specifier);
  if (targetPath === undefined) return;
  const resolved = resolveTypescriptReExportedSymbol(targetPath, importedName, resolver);
  bindings.push({
    importerPath: file.scopePath,
    localName,
    importedName: resolved?.importedName ?? importedName,
    targetPath: resolved?.targetPath ?? targetPath,
  });
}

function appendTypescriptImportDeclarationBindings(
  bindings: CodeImportBinding[],
  file: SourceFile,
  resolver: TypescriptReExportResolverContext,
  targetBySpecifier: ReadonlyMap<string, string>,
  statement: ts.ImportDeclaration,
): void {
  const specifier = stringLiteralText(statement.moduleSpecifier);
  const clause = statement.importClause;
  if (specifier === undefined || clause === undefined) return;
  if (clause.name !== undefined) {
    appendTypescriptImportBinding(
      bindings,
      file,
      resolver,
      targetBySpecifier,
      specifier,
      clause.name.text,
      "default",
    );
  }
  if (clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) return;
  for (const element of clause.namedBindings.elements) {
    appendTypescriptImportBinding(
      bindings,
      file,
      resolver,
      targetBySpecifier,
      specifier,
      element.name.text,
      element.propertyName?.text ?? element.name.text,
    );
  }
}

function collectTypescriptImportBindings(
  file: SourceFile,
  imports: readonly CodeImportEdge[],
  resolver: TypescriptReExportResolverContext,
): readonly CodeImportBinding[] {
  const sourceFile = file.syntaxTree;
  if (sourceFile === undefined) {
    return [];
  }
  const targetBySpecifier = resolvedTargetsBySpecifier(file, imports);
  const bindings: CodeImportBinding[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    appendTypescriptImportDeclarationBindings(
      bindings,
      file,
      resolver,
      targetBySpecifier,
      statement,
    );
  }
  return bindings;
}

function collectPolyglotImportBindings(
  file: SourceFile,
  imports: readonly CodeImportEdge[],
): readonly CodeImportBinding[] {
  if (file.language !== "python") {
    return [];
  }
  const targetBySpecifier = new Map<string, string>();
  for (const edge of imports) {
    if (edge.importerPath === file.scopePath && edge.targetPath !== undefined) {
      targetBySpecifier.set(edge.specifier, edge.targetPath);
    }
  }
  const bindings: CodeImportBinding[] = [];
  const lines = file.text.split(/\r?\n/u);
  for (const line of lines) {
    const match = /^\s*from\s+(\.*[A-Za-z_][\w.]*)\s+import\s+(.+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }
    const targetPath = targetBySpecifier.get(match[1]);
    if (targetPath === undefined) {
      continue;
    }
    const importList = match[2].replace(/\s*#.*$/u, "").replace(/[()]/gu, "");
    for (const part of importList.split(",")) {
      const importMatch = /^\s*([A-Za-z_][\w]*)(?:\s+as\s+([A-Za-z_][\w]*))?\s*$/u.exec(part);
      if (importMatch?.[1] === undefined) {
        continue;
      }
      bindings.push({
        importerPath: file.scopePath,
        localName: importMatch[2] ?? importMatch[1],
        importedName: importMatch[1],
        targetPath,
      });
    }
  }
  return bindings;
}

function appendTypescriptReExportBindings(
  bindings: TypescriptReExportBinding[],
  exporterPath: string,
  targetBySpecifier: ReadonlyMap<string, string>,
  statement: ts.ExportDeclaration,
): void {
  const specifier = stringLiteralText(statement.moduleSpecifier);
  const targetPath = specifier === undefined ? undefined : targetBySpecifier.get(specifier);
  if (targetPath === undefined) return;
  const clause = statement.exportClause;
  if (clause === undefined) {
    bindings.push({ exporterPath, targetPath });
    return;
  }
  if (!ts.isNamedExports(clause)) return;
  for (const element of clause.elements) {
    bindings.push({
      exporterPath,
      exportedName: element.name.text,
      importedName: element.propertyName?.text ?? element.name.text,
      targetPath,
    });
  }
}

function collectTypescriptReExportBindings(
  file: SourceFile,
  imports: readonly CodeImportEdge[],
): readonly TypescriptReExportBinding[] {
  const sourceFile = file.syntaxTree;
  if (sourceFile === undefined) {
    return [];
  }
  const targetBySpecifier = resolvedTargetsBySpecifier(file, imports, "export");
  const bindings: TypescriptReExportBinding[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    appendTypescriptReExportBindings(bindings, file.scopePath, targetBySpecifier, statement);
  }
  return bindings;
}

function hasDefaultModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ===
      true
  );
}

function defaultExportNames(statement: ts.Statement): readonly string[] {
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    hasDefaultModifier(statement)
  ) {
    return [declarationNameText(statement.name) ?? "default"];
  }
  if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
    return [ts.isIdentifier(statement.expression) ? statement.expression.text : "default"];
  }
  if (
    !ts.isExportDeclaration(statement) ||
    statement.moduleSpecifier !== undefined ||
    statement.exportClause === undefined ||
    !ts.isNamedExports(statement.exportClause)
  ) {
    return [];
  }
  return statement.exportClause.elements
    .filter((element) => element.name.text === "default")
    .map((element) => element.propertyName?.text ?? element.name.text);
}

function collectTypescriptDefaultExports(file: SourceFile): readonly TypescriptDefaultExport[] {
  const sourceFile = file.syntaxTree;
  if (sourceFile === undefined) {
    return [];
  }
  const defaults: TypescriptDefaultExport[] = [];
  for (const statement of sourceFile.statements) {
    for (const symbolName of defaultExportNames(statement)) {
      defaults.push({ scopePath: file.scopePath, symbolName });
    }
  }
  return defaults;
}

function buildTypescriptReExportResolverContext(
  reExports: readonly TypescriptReExportBinding[],
  defaultExports: readonly TypescriptDefaultExport[],
  symbols: readonly CodeSymbol[],
): TypescriptReExportResolverContext {
  const reExportsByFile = new Map<string, TypescriptReExportBinding[]>();
  for (const binding of reExports) {
    reExportsByFile.set(binding.exporterPath, [
      ...(reExportsByFile.get(binding.exporterPath) ?? []),
      binding,
    ]);
  }
  const defaultExportsByFile = new Map<string, string[]>();
  for (const item of defaultExports) {
    defaultExportsByFile.set(item.scopePath, [
      ...(defaultExportsByFile.get(item.scopePath) ?? []),
      item.symbolName,
    ]);
  }
  const symbolsByFile = new Map<string, CodeSymbol[]>();
  for (const symbol of symbols) {
    symbolsByFile.set(symbol.scopePath, [...(symbolsByFile.get(symbol.scopePath) ?? []), symbol]);
  }
  return { reExportsByFile, defaultExportsByFile, symbolsByFile };
}

function fileDefinesTypescriptSymbol(
  resolver: TypescriptReExportResolverContext,
  scopePath: string,
  symbolName: string,
): boolean {
  return (resolver.symbolsByFile.get(scopePath) ?? []).some((symbol) => symbol.name === symbolName);
}

interface TypescriptReExportResolutionRequest {
  readonly exportedName: string;
  readonly resolver: TypescriptReExportResolverContext;
  readonly seen: ReadonlySet<string>;
  readonly depth: number;
}

function resolveDefaultTypescriptExport(
  exporterPath: string,
  resolver: TypescriptReExportResolverContext,
): ResolvedTypescriptImportTarget | undefined {
  for (const symbolName of resolver.defaultExportsByFile.get(exporterPath) ?? []) {
    if (fileDefinesTypescriptSymbol(resolver, exporterPath, symbolName)) {
      return { targetPath: exporterPath, importedName: symbolName };
    }
  }
  return undefined;
}

function resolveTypescriptReExportBinding(
  binding: TypescriptReExportBinding,
  importedName: string,
  request: TypescriptReExportResolutionRequest,
): ResolvedTypescriptImportTarget | undefined {
  const resolved = resolveTypescriptReExportedSymbol(
    binding.targetPath,
    importedName,
    request.resolver,
    request.seen,
    request.depth + 1,
  );
  if (resolved !== undefined) return resolved;
  return fileDefinesTypescriptSymbol(request.resolver, binding.targetPath, importedName)
    ? { targetPath: binding.targetPath, importedName }
    : undefined;
}

function resolveNamedTypescriptReExport(
  bindings: readonly TypescriptReExportBinding[],
  request: TypescriptReExportResolutionRequest,
): ResolvedTypescriptImportTarget | undefined {
  for (const binding of bindings) {
    if (binding.exportedName !== request.exportedName || binding.importedName === undefined) {
      continue;
    }
    const resolved = resolveTypescriptReExportBinding(binding, binding.importedName, request);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function resolveWildcardTypescriptReExport(
  bindings: readonly TypescriptReExportBinding[],
  request: TypescriptReExportResolutionRequest,
): ResolvedTypescriptImportTarget | undefined {
  for (const binding of bindings) {
    if (binding.exportedName !== undefined) continue;
    const resolved = resolveTypescriptReExportBinding(binding, request.exportedName, request);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function resolveTypescriptReExportedSymbol(
  exporterPath: string,
  exportedName: string,
  resolver: TypescriptReExportResolverContext,
  seen: ReadonlySet<string> = new Set(),
  depth = 0,
): ResolvedTypescriptImportTarget | undefined {
  if (depth > RE_EXPORT_RESOLUTION_DEPTH_LIMIT) {
    return undefined;
  }
  const key = `${exporterPath}\0${exportedName}`;
  if (seen.has(key)) {
    return undefined;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(key);
  if (exportedName === "default") {
    const resolvedDefault = resolveDefaultTypescriptExport(exporterPath, resolver);
    if (resolvedDefault !== undefined) return resolvedDefault;
  }
  if (fileDefinesTypescriptSymbol(resolver, exporterPath, exportedName)) {
    return { targetPath: exporterPath, importedName: exportedName };
  }
  const reExports = resolver.reExportsByFile.get(exporterPath) ?? [];
  const request = { exportedName, resolver, seen: nextSeen, depth };
  const named = resolveNamedTypescriptReExport(reExports, request);
  if (named !== undefined || exportedName === "default") return named;
  return resolveWildcardTypescriptReExport(reExports, request);
}

const NON_FIELD_COMPONENT_NAMES = new Set([
  "string",
  "number",
  "boolean",
  "int",
  "long",
  "double",
  "float",
  "short",
  "byte",
  "char",
  "list",
  "map",
  "set",
  "optional",
]);

function fieldNameFromSerializationAnnotation(text: string): string | undefined {
  const match =
    /\b(?:JsonPropertyName|JsonProperty|SerializedName)\s*\(\s*["']([^"']+)["']/u.exec(text)?.[1] ??
    /\b(?:JsonPropertyName|JsonProperty|SerializedName)\s*\([^)]*\b(?:name|value)\s*=\s*["']([^"']+)["']/u.exec(
      text,
    )?.[1];
  if (match === undefined || match.length === 0 || match === "-") {
    return undefined;
  }
  return match;
}

function fieldNameFromComponent(component: string): string | undefined {
  const serializedFieldName = fieldNameFromSerializationAnnotation(component);
  if (serializedFieldName !== undefined) {
    return serializedFieldName;
  }
  const cleaned = component
    .replace(/@\w+(?:\([^)]*\))?/gu, " ")
    .replace(/=[^,]+$/u, " ")
    .trim();
  const kotlinConstructorProperty =
    /^(?:(?:public|private|protected|internal|override)\s+)*(?:val|var)\s+([A-Za-z_$][\w$]*)\??\s*:/u.exec(
      cleaned,
    )?.[1];
  if (kotlinConstructorProperty !== undefined) {
    return kotlinConstructorProperty;
  }
  const tsName = /^([A-Za-z_$][\w$]*)\??\s*:/u.exec(cleaned)?.[1];
  if (tsName !== undefined) {
    return tsName;
  }
  const names = [...cleaned.matchAll(/\b([A-Za-z_$][\w$]*)\b/gu)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
  const candidate = names.at(-1);
  if (candidate === undefined || NON_FIELD_COMPONENT_NAMES.has(candidate.toLowerCase())) {
    return undefined;
  }
  return candidate;
}

interface FieldComponentSplitState {
  current: string;
  parenDepth: number;
  bracketDepth: number;
  braceDepth: number;
  angleDepth: number;
  quoted: "'" | '"' | undefined;
  escaped: boolean;
}

function appendQuotedFieldCharacter(state: FieldComponentSplitState, character: string): void {
  state.current += character;
  if (state.escaped) {
    state.escaped = false;
  } else if (character === "\\") {
    state.escaped = true;
  } else if (character === state.quoted) {
    state.quoted = undefined;
  }
}

function updateFieldComponentDepth(state: FieldComponentSplitState, character: string): boolean {
  if (character === "(") state.parenDepth += 1;
  else if (character === ")" && state.parenDepth > 0) state.parenDepth -= 1;
  else if (character === "[") state.bracketDepth += 1;
  else if (character === "]" && state.bracketDepth > 0) state.bracketDepth -= 1;
  else if (character === "{") state.braceDepth += 1;
  else if (character === "}" && state.braceDepth > 0) state.braceDepth -= 1;
  else if (character === "<") state.angleDepth += 1;
  else if (character === ">" && state.angleDepth > 0) state.angleDepth -= 1;
  else return false;
  return true;
}

function isTopLevelFieldSeparator(state: FieldComponentSplitState, character: string): boolean {
  return (
    character === "," &&
    state.parenDepth === 0 &&
    state.bracketDepth === 0 &&
    state.braceDepth === 0 &&
    state.angleDepth === 0
  );
}

function splitFieldComponents(text: string): readonly string[] {
  const components: string[] = [];
  const state: FieldComponentSplitState = {
    current: "",
    parenDepth: 0,
    bracketDepth: 0,
    braceDepth: 0,
    angleDepth: 0,
    quoted: undefined,
    escaped: false,
  };
  for (const character of text) {
    if (state.quoted !== undefined) {
      appendQuotedFieldCharacter(state, character);
      continue;
    }
    if (character === "'" || character === '"') {
      state.quoted = character;
    } else if (updateFieldComponentDepth(state, character)) {
      state.current += character;
      continue;
    } else if (isTopLevelFieldSeparator(state, character)) {
      components.push(state.current);
      state.current = "";
      continue;
    }
    state.current += character;
  }
  components.push(state.current);
  return components;
}

function parseFieldList(text: string): readonly string[] {
  const fields = splitFieldComponents(text)
    .map(fieldNameFromComponent)
    .filter((field): field is string => field !== undefined);
  return [...new Set(fields)];
}

function openApiSchemaSymbol(
  file: SourceFile,
  name: string,
  fields: readonly string[],
  lineNo: number,
): CodeSymbol {
  return {
    name,
    kind: "interface",
    scopePath: file.scopePath,
    language: file.language,
    lineRange: lineRange(lineNo),
    fields: [...new Set(fields)],
    parser: "polyglot-regex",
  };
}

function openApiSchemaFields(schema: unknown): readonly string[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return [];
  }
  return Object.keys(schema.properties);
}

function collectOpenApiJsonSchemaSymbols(file: SourceFile): readonly CodeSymbol[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return [];
  }
  const schemas = isRecord(parsed)
    ? isRecord(parsed.components)
      ? parsed.components.schemas
      : undefined
    : undefined;
  if (!isRecord(schemas)) {
    return [];
  }
  const symbols: CodeSymbol[] = [];
  for (const [name, schema] of Object.entries(schemas)) {
    const fields = openApiSchemaFields(schema);
    if (fields.length === 0) {
      continue;
    }
    const quotedName = JSON.stringify(name);
    const offset = file.text.indexOf(quotedName);
    symbols.push(openApiSchemaSymbol(file, name, fields, lineNumberAtOffset(file.text, offset)));
  }
  return symbols;
}

interface OpenApiYamlState {
  phase: "root" | "components" | "schemas";
  componentsIndent: number;
  schemasIndent: number;
  currentName: string | undefined;
  currentLine: number;
  currentFields: string[];
  inProperties: boolean;
  propertiesIndent: number;
}

function flushOpenApiYamlSchema(
  file: SourceFile,
  state: OpenApiYamlState,
  symbols: CodeSymbol[],
): void {
  if (state.currentName !== undefined && state.currentFields.length > 0) {
    symbols.push(
      openApiSchemaSymbol(file, state.currentName, state.currentFields, state.currentLine),
    );
  }
  state.currentName = undefined;
  state.currentFields = [];
  state.inProperties = false;
  state.propertiesIndent = -1;
}

function advanceOpenApiComponentsState(
  state: OpenApiYamlState,
  trimmed: string,
  indent: number,
): void {
  if (indent <= state.componentsIndent && !/^components\s*:/u.test(trimmed)) {
    state.phase = "root";
  } else if (/^schemas\s*:\s*$/u.test(trimmed)) {
    state.phase = "schemas";
    state.schemasIndent = indent;
  }
}

function beginOpenApiYamlSchema(
  file: SourceFile,
  state: OpenApiYamlState,
  symbols: CodeSymbol[],
  name: string,
  lineNumber: number,
): void {
  flushOpenApiYamlSchema(file, state, symbols);
  state.currentName = name;
  state.currentLine = lineNumber;
}

function advanceOpenApiSchemasState(
  file: SourceFile,
  state: OpenApiYamlState,
  symbols: CodeSymbol[],
  trimmed: string,
  indent: number,
  lineNumber: number,
): void {
  if (indent <= state.schemasIndent && !/^schemas\s*:/u.test(trimmed)) {
    flushOpenApiYamlSchema(file, state, symbols);
    state.phase = "components";
    return;
  }
  const schemaName = /^([A-Za-z_][\w.-]*)\s*:\s*$/u.exec(trimmed)?.[1];
  if (
    schemaName !== undefined &&
    indent > state.schemasIndent &&
    indent <= state.schemasIndent + 2
  ) {
    beginOpenApiYamlSchema(file, state, symbols, schemaName, lineNumber);
    return;
  }
  if (state.currentName === undefined) return;
  if (/^properties\s*:\s*$/u.test(trimmed)) {
    state.inProperties = true;
    state.propertiesIndent = indent;
    return;
  }
  if (state.inProperties && indent <= state.propertiesIndent) state.inProperties = false;
  if (!state.inProperties) return;
  const fieldName = /^([A-Za-z_][\w-]*)\s*:/u.exec(trimmed)?.[1];
  if (fieldName !== undefined) state.currentFields.push(fieldName);
}

function advanceOpenApiYamlState(
  file: SourceFile,
  state: OpenApiYamlState,
  symbols: CodeSymbol[],
  line: string,
  lineNumber: number,
): void {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return;
  const indent = line.length - line.trimStart().length;
  if (state.phase === "root") {
    if (/^components\s*:\s*$/u.test(trimmed)) {
      state.phase = "components";
      state.componentsIndent = indent;
    }
    return;
  }
  if (state.phase === "components") {
    advanceOpenApiComponentsState(state, trimmed, indent);
    return;
  }
  advanceOpenApiSchemasState(file, state, symbols, trimmed, indent, lineNumber);
}

function collectOpenApiYamlSchemaSymbols(file: SourceFile): readonly CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = file.text.split(/\r?\n/u);
  const state: OpenApiYamlState = {
    phase: "root",
    componentsIndent: -1,
    schemasIndent: -1,
    currentName: undefined,
    currentLine: 1,
    currentFields: [],
    inProperties: false,
    propertiesIndent: -1,
  };
  lines.forEach((line, index) => {
    advanceOpenApiYamlState(file, state, symbols, line, index + 1);
  });
  flushOpenApiYamlSchema(file, state, symbols);
  return symbols;
}

function collectOpenApiSchemaSymbols(file: SourceFile): readonly CodeSymbol[] {
  return extension(file.scopePath) === "json"
    ? collectOpenApiJsonSchemaSymbols(file)
    : collectOpenApiYamlSchemaSymbols(file);
}

function outerParenthesizedText(text: string): string | undefined {
  let start = -1;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    if (character === "(") {
      if (start < 0) {
        start = i;
      }
      depth += 1;
    } else if (character === ")" && start >= 0) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start + 1, i);
      }
    }
  }
  return undefined;
}

function collectRecordFields(lines: readonly string[], startIndex: number): readonly string[] {
  const text: string[] = [];
  for (let i = startIndex; i < Math.min(lines.length, startIndex + 40); i += 1) {
    text.push(lines[i] ?? "");
    const fieldsText = outerParenthesizedText(text.join("\n"));
    if (fieldsText !== undefined) {
      return parseFieldList(fieldsText);
    }
  }
  return [];
}

function symbolLineHasConstructorFields(kind: CodeSymbolKind, line: string): boolean {
  return (
    /\b(?:(?:data|public|private|protected|internal|abstract|final|sealed|open)\s+)*class\s+[A-Za-z_$][\w$]*\s*\(/u.test(
      line,
    ) ||
    (kind === "record" && /\brecord\s+(?:class\s+|struct\s+)?[A-Za-z_$][\w$]*\s*\(/u.test(line))
  );
}

function fieldNameFromGoStructTag(tagText: string | undefined): string | undefined {
  const tagName = /\bjson:"([^"]*)"/u
    .exec(tagText ?? "")?.[1]
    ?.split(",")
    .at(0)
    ?.trim();
  if (tagName === undefined || tagName.length === 0 || tagName === "-") {
    return undefined;
  }
  return tagName;
}

function stripBracketSegments(line: string): string {
  let depth = 0;
  let output = "";
  for (const character of line) {
    if (character === "[") {
      depth += 1;
      if (depth === 1) output += " ";
    } else if (character === "]" && depth > 0) {
      depth -= 1;
    } else if (depth === 0) {
      output += character;
    }
  }
  return output;
}

function javaLikeFieldName(line: string): string | undefined {
  const assignment = line.indexOf("=");
  const terminator = line.indexOf(";");
  let end = Math.min(assignment, terminator);
  if (assignment < 0) end = terminator;
  if (terminator < 0) end = assignment;
  if (end < 0) return undefined;
  const prefix = line.slice(0, end).trim();
  if (prefix.includes(":")) return undefined;
  const tokens = prefix.split(/\s+/u);
  if (tokens.length < 2) return undefined;
  const candidate = tokens.at(-1);
  return candidate !== undefined && /^[A-Za-z_$][\w$]*$/u.test(candidate) ? candidate : undefined;
}

function declarationFieldNames(
  line: string,
  language: CodeLanguage,
  insideBlock: boolean,
): readonly string[] {
  const withoutAnnotations = line.replace(/@\w+(?:\([^()\r\n]*\))?/gu, " ");
  const declarationLine = stripBracketSegments(withoutAnnotations);
  const names = [
    /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:;]/u.exec(declarationLine)?.[1],
    javaLikeFieldName(declarationLine),
    /^\s*(?:(?:public|private|protected|internal|override|lateinit)\s+)*(?:val|var)\s+([A-Za-z_$][\w$]*)\??\s*[:=]/u.exec(
      declarationLine,
    )?.[1],
    /^\s*(?:(?:public|private|protected|internal|required|static|readonly|virtual|override|sealed|abstract|new)\s+)*[A-Za-z_$][\w$<>, ?.[\]]+\s+([A-Za-z_$][\w$]*)\s*\{/u.exec(
      declarationLine,
    )?.[1],
  ].filter((name): name is string => name !== undefined);
  if (language !== "go" || !insideBlock) return names;
  const goStructField = /^\s*([A-Za-z_][\w]*)\s+[^\s`{]+(?:\s+`([^`]*)`)?/u.exec(line);
  const goName = fieldNameFromGoStructTag(goStructField?.[2]) ?? goStructField?.[1];
  return goName === undefined || NON_FIELD_COMPONENT_NAMES.has(goName.toLowerCase())
    ? names
    : [...names, goName];
}

function collectBlockFields(
  lines: readonly string[],
  startIndex: number,
  language: CodeLanguage,
): readonly string[] {
  const fields: string[] = [];
  let pendingSerializedFieldName: string | undefined;
  for (let i = startIndex; i < Math.min(lines.length, startIndex + 80); i += 1) {
    const line = lines[i] ?? "";
    if (i > startIndex && /^\s*\}/u.test(line)) break;
    const serializedFieldName = fieldNameFromSerializationAnnotation(line);
    if (serializedFieldName !== undefined) pendingSerializedFieldName = serializedFieldName;
    const names = declarationFieldNames(line, language, i > startIndex);
    for (const fieldName of names) {
      fields.push(pendingSerializedFieldName ?? fieldName);
      pendingSerializedFieldName = undefined;
    }
    if (names.length === 0 && serializedFieldName === undefined && line.trim().length > 0) {
      pendingSerializedFieldName = undefined;
    }
  }
  return [...new Set(fields)];
}

function collectSymbols(file: SourceFile): readonly CodeSymbol[] {
  if (file.language === "openapi") {
    return collectOpenApiSchemaSymbols(file);
  }
  if (file.syntaxTree !== undefined) {
    return collectTypescriptSymbols(file);
  }
  const symbols: CodeSymbol[] = [];
  const lines = file.text.split(/\r?\n/u);
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const definitions: readonly (readonly [RegExp, CodeSymbolKind])[] = [
      [/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/u, "function"],
      [/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/u, "constant"],
      [/\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/u, "class"],
      [/\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/u, "interface"],
      [/\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/u, "type"],
      [/\b(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/u, "enum"],
      [
        /\b(?:(?:public|private|protected|internal|abstract|final|sealed|data|open)\s+)*class\s+([A-Za-z_$][\w$]*)\b\s*(?:\(([^)]*)\))?/u,
        "class",
      ],
      [/\b(?:public\s+|private\s+|protected\s+)*interface\s+([A-Za-z_$][\w$]*)\b/u, "interface"],
      [
        /\b(?:(?:public|private|protected|internal|sealed|abstract|partial|readonly)\s+)*record\s+(?:class\s+|struct\s+)?([A-Za-z_$][\w$]*)\s*(?:\(([^)]*)\))?/u,
        "record",
      ],
      [/\b(?:public\s+|private\s+|protected\s+)*enum\s+([A-Za-z_$][\w$]*)\b/u, "enum"],
      [/\bfun\s+([A-Za-z_$][\w$]*)\s*\(/u, "function"],
      [/\bdef\s+([A-Za-z_$][\w$]*)\s*\(/u, "function"],
      [/\bclass\s+([A-Za-z_$][\w$]*)\s*(?:\(|:)?/u, "class"],
      [/\bfunc\s+(?:\([^)]+\)\s*)?([A-Za-z_$][\w$]*)\s*\(/u, "function"],
      [/\btype\s+([A-Za-z_$][\w$]*)\s+(?:struct|interface)\b/u, "struct"],
      [/\bfn\s+([A-Za-z_$][\w$]*)\s*\(/u, "function"],
      [/\b(?:struct|trait)\s+([A-Za-z_$][\w$]*)\b/u, "struct"],
    ];
    for (const [pattern, kind] of definitions) {
      const match = pattern.exec(line);
      const name = match?.[1];
      if (name === undefined) {
        continue;
      }
      const recordFieldText = match?.[2];
      const recordFields =
        kind === "record" || symbolLineHasConstructorFields(kind, line)
          ? collectRecordFields(lines, index)
          : recordFieldText === undefined
            ? []
            : parseFieldList(recordFieldText);
      symbols.push({
        name,
        kind,
        scopePath: file.scopePath,
        language: file.language,
        lineRange: lineRange(lineNo),
        fields:
          recordFields.length > 0 ? recordFields : collectBlockFields(lines, index, file.language),
        parser: "polyglot-regex",
      });
      break;
    }
  });
  return symbols;
}

function collectTypescriptFields(node: ts.Node): readonly string[] {
  const fields: string[] = [];
  const pushMemberName = (member: ts.ClassElement | ts.TypeElement): void => {
    const name =
      ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)
        ? declarationNameText(member.name)
        : undefined;
    if (name !== undefined) {
      fields.push(name);
    }
  };
  if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
    for (const member of node.members) {
      pushMemberName(member);
    }
  } else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
    for (const member of node.type.members) {
      pushMemberName(member);
    }
  }
  return [...new Set(fields)];
}

function collectTypescriptSymbols(file: SourceFile): readonly CodeSymbol[] {
  const sourceFile = file.syntaxTree;
  if (sourceFile === undefined) {
    return [];
  }
  const symbols: CodeSymbol[] = [];
  const emit = (
    node: ts.Node,
    name: string | undefined,
    kind: CodeSymbolKind,
    fields: readonly string[] = [],
  ): void => {
    if (name === undefined) {
      return;
    }
    symbols.push({
      name,
      kind,
      scopePath: file.scopePath,
      language: file.language,
      lineRange: nodeLineRange(sourceFile, node),
      fields,
      parser: "typescript-compiler-ast",
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) {
      emit(
        node,
        declarationNameText(node.name) ?? (hasDefaultModifier(node) ? "default" : undefined),
        "function",
      );
    } else if (ts.isMethodDeclaration(node)) {
      emit(node, declarationNameText(node.name), "method");
    } else if (ts.isClassDeclaration(node)) {
      emit(
        node,
        declarationNameText(node.name) ?? (hasDefaultModifier(node) ? "default" : undefined),
        "class",
        collectTypescriptFields(node),
      );
    } else if (ts.isInterfaceDeclaration(node)) {
      emit(node, declarationNameText(node.name), "interface", collectTypescriptFields(node));
    } else if (ts.isTypeAliasDeclaration(node)) {
      emit(node, declarationNameText(node.name), "type", collectTypescriptFields(node));
    } else if (ts.isEnumDeclaration(node)) {
      emit(node, declarationNameText(node.name), "enum");
    } else if (ts.isModuleDeclaration(node)) {
      emit(node, declarationNameText(node.name), "module");
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      emit(node, declarationNameText(node.name), "constant");
    } else if (
      ts.isExportAssignment(node) &&
      !node.isExportEquals &&
      !ts.isIdentifier(node.expression)
    ) {
      emit(node, "default", "constant");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return symbols;
}

function collectCalls(
  files: readonly SourceFile[],
  symbols: readonly CodeSymbol[],
  imports: readonly CodeImportEdge[],
  importBindings: readonly CodeImportBinding[],
): readonly CodeCallEdge[] {
  const byName = new Map<string, CodeSymbol[]>();
  for (const symbol of symbols) {
    const key = symbol.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), symbol]);
  }
  const importsByFile = new Map<string, CodeImportEdge[]>();
  for (const edge of imports) {
    if (edge.kind !== "import" || edge.targetPath === undefined) {
      continue;
    }
    importsByFile.set(edge.importerPath, [...(importsByFile.get(edge.importerPath) ?? []), edge]);
  }
  const bindingsByFile = groupImportBindingsByFile(importBindings);
  const calls: CodeCallEdge[] = [];
  for (const file of files) {
    const fileBindings = bindingsByFile.get(file.scopePath) ?? [];
    if (file.syntaxTree !== undefined) {
      calls.push(
        ...collectTypescriptCalls(
          file,
          byName,
          importsByFile.get(file.scopePath) ?? [],
          fileBindings,
        ),
      );
      continue;
    }
    const lines = polyglotIdentifierScanLines(file);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)) {
        const name = match[1];
        if (name === undefined || IGNORED_CALL_NAMES.has(name.toLowerCase())) {
          continue;
        }
        const resolved = resolveCallTarget(
          file.scopePath,
          name,
          byName,
          importsByFile.get(file.scopePath) ?? [],
          fileBindings,
        );
        if (resolved === undefined) {
          continue;
        }
        calls.push({
          callerPath: file.scopePath,
          callerLine: index + 1,
          calleeName: name,
          targetName: resolved.symbol.name,
          targetPath: resolved.symbol.scopePath,
          targetLineRange: resolved.symbol.lineRange,
          confidence: resolved.confidence,
          parser: "polyglot-regex",
        });
      }
    });
  }
  return calls;
}

function stripQuotedLiterals(line: string): string {
  return line.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/gu, (match) => " ".repeat(match.length));
}

function stripLineComment(line: string, language: CodeLanguage): string {
  const markers = language === "python" || language === "ruby" ? ["#"] : ["//", "#"];
  let end = line.length;
  for (const marker of markers) {
    const at = line.indexOf(marker);
    if (at >= 0) {
      end = Math.min(end, at);
    }
  }
  return line.slice(0, end);
}

function resumeDelimitedComment(
  line: string,
  index: number,
  delimiter: string,
): number | undefined {
  const end = line.indexOf(delimiter, index);
  return end < 0 ? undefined : end + delimiter.length;
}

interface CommentStart {
  readonly index: number;
  readonly kind: "block" | "python-triple";
}

function nextBlockOrDocstringStart(
  line: string,
  index: number,
  language: CodeLanguage,
): CommentStart | undefined {
  const blockStart = line.indexOf("/*", index);
  const tripleStart =
    language === "python"
      ? [line.indexOf('"""', index), line.indexOf("'''", index)]
          .filter((value) => value >= 0)
          .sort((a, b) => a - b)[0]
      : undefined;
  if (blockStart < 0 && tripleStart === undefined) return undefined;
  if (blockStart < 0) return { index: tripleStart ?? -1, kind: "python-triple" };
  return tripleStart === undefined || blockStart <= tripleStart
    ? { index: blockStart, kind: "block" }
    : { index: tripleStart, kind: "python-triple" };
}

interface StripCommentStep {
  readonly text: string;
  readonly nextIndex?: number | undefined;
}

function resumeActiveCommentStep(
  line: string,
  index: number,
  state: { inBlockComment: boolean; inPythonTripleQuote: string | undefined },
): StripCommentStep | undefined {
  if (state.inBlockComment) {
    const nextIndex = resumeDelimitedComment(line, index, "*/");
    if (nextIndex === undefined) return { text: "" };
    state.inBlockComment = false;
    return { text: "", nextIndex };
  }
  if (state.inPythonTripleQuote === undefined) return undefined;
  const nextIndex = resumeDelimitedComment(line, index, state.inPythonTripleQuote);
  if (nextIndex === undefined) return { text: "" };
  state.inPythonTripleQuote = undefined;
  return { text: "", nextIndex };
}

function stripNewBlockCommentStep(
  line: string,
  start: number,
  prefix: string,
  state: { inBlockComment: boolean },
): StripCommentStep {
  const nextIndex = resumeDelimitedComment(line, start + 2, "*/");
  if (nextIndex !== undefined) return { text: prefix, nextIndex };
  state.inBlockComment = true;
  return { text: prefix };
}

function stripNewTripleQuoteStep(
  line: string,
  start: number,
  prefix: string,
  state: { inPythonTripleQuote: string | undefined },
): StripCommentStep {
  const quote = line.slice(start, start + 3);
  const nextIndex = resumeDelimitedComment(line, start + 3, quote);
  if (nextIndex !== undefined) return { text: prefix, nextIndex };
  state.inPythonTripleQuote = quote;
  return { text: prefix };
}

function stripCommentStep(
  line: string,
  index: number,
  state: { inBlockComment: boolean; inPythonTripleQuote: string | undefined },
  language: CodeLanguage,
): StripCommentStep {
  const active = resumeActiveCommentStep(line, index, state);
  if (active !== undefined) return active;
  const start = nextBlockOrDocstringStart(line, index, language);
  if (start === undefined) return { text: line.slice(index) };
  const prefix = line.slice(index, start.index);
  return start.kind === "block"
    ? stripNewBlockCommentStep(line, start.index, prefix, state)
    : stripNewTripleQuoteStep(line, start.index, prefix, state);
}

function stripBlockCommentsFromLine(
  line: string,
  state: { inBlockComment: boolean; inPythonTripleQuote: string | undefined },
  language: CodeLanguage,
): string {
  let output = "";
  let index = 0;
  while (index < line.length) {
    const step = stripCommentStep(line, index, state, language);
    output += step.text;
    if (step.nextIndex === undefined) return output;
    index = step.nextIndex;
  }
  return output;
}

function polyglotIdentifierScanLines(file: SourceFile): readonly string[] {
  const state: { inBlockComment: boolean; inPythonTripleQuote: string | undefined } = {
    inBlockComment: false,
    inPythonTripleQuote: undefined,
  };
  return file.text.split(/\r?\n/u).map((line) => {
    const noBlockComments = stripBlockCommentsFromLine(line, state, file.language);
    return stripLineComment(stripQuotedLiterals(noBlockComments), file.language);
  });
}

interface EndpointScanText {
  readonly text: string;
  readonly lines: readonly string[];
  readonly lineOffsets: readonly number[];
  readonly isCodeAt: (offset: number) => boolean;
}

function lineCommentMarkerAt(
  text: string,
  index: number,
  language: CodeLanguage,
): string | undefined {
  if (text.startsWith("//", index) && language !== "python" && language !== "ruby") {
    return "//";
  }
  if (text[index] === "#") {
    return "#";
  }
  return undefined;
}

interface EndpointMaskState {
  readonly chars: string[];
  readonly codeMask: Uint8Array;
  index: number;
  stringDelimiter: "'" | '"' | "`" | undefined;
  escaped: boolean;
  inBlockComment: boolean;
  pythonTripleQuote: string | undefined;
}

function maskEndpointIndex(state: EndpointMaskState, index: number): void {
  if (state.chars[index] !== "\n" && state.chars[index] !== "\r") {
    state.chars[index] = " ";
  }
  state.codeMask[index] = 0;
}

function advanceEndpointBlockComment(text: string, state: EndpointMaskState): boolean {
  if (!state.inBlockComment) return false;
  if (text.startsWith("*/", state.index)) {
    maskEndpointIndex(state, state.index);
    maskEndpointIndex(state, state.index + 1);
    state.index += 2;
    state.inBlockComment = false;
  } else {
    maskEndpointIndex(state, state.index);
    state.index += 1;
  }
  return true;
}

function advanceEndpointTripleQuote(text: string, state: EndpointMaskState): boolean {
  const quote = state.pythonTripleQuote;
  if (quote === undefined) return false;
  if (text.startsWith(quote, state.index)) {
    for (let offset = 0; offset < quote.length; offset += 1) {
      maskEndpointIndex(state, state.index + offset);
    }
    state.index += quote.length;
    state.pythonTripleQuote = undefined;
  } else {
    maskEndpointIndex(state, state.index);
    state.index += 1;
  }
  return true;
}

function advanceEndpointString(text: string, state: EndpointMaskState): boolean {
  const delimiter = state.stringDelimiter;
  if (delimiter === undefined) return false;
  state.codeMask[state.index] = 0;
  const character = text[state.index];
  if (state.escaped) state.escaped = false;
  else if (character === "\\") state.escaped = true;
  else if (character === delimiter) state.stringDelimiter = undefined;
  else if (delimiter !== "`" && (character === "\n" || character === "\r")) {
    state.stringDelimiter = undefined;
  }
  state.index += 1;
  return true;
}

function startEndpointTripleQuote(
  text: string,
  language: CodeLanguage,
  state: EndpointMaskState,
): boolean {
  if (
    language !== "python" ||
    (!text.startsWith('"""', state.index) && !text.startsWith("'''", state.index))
  ) {
    return false;
  }
  state.pythonTripleQuote = text.slice(state.index, state.index + 3);
  for (let offset = 0; offset < 3; offset += 1) {
    maskEndpointIndex(state, state.index + offset);
  }
  state.index += 3;
  return true;
}

function startEndpointBlockComment(text: string, state: EndpointMaskState): boolean {
  if (!text.startsWith("/*", state.index)) return false;
  maskEndpointIndex(state, state.index);
  maskEndpointIndex(state, state.index + 1);
  state.index += 2;
  state.inBlockComment = true;
  return true;
}

function maskEndpointLineComment(
  text: string,
  language: CodeLanguage,
  state: EndpointMaskState,
): boolean {
  if (lineCommentMarkerAt(text, state.index, language) === undefined) return false;
  while (state.index < text.length && text[state.index] !== "\n" && text[state.index] !== "\r") {
    maskEndpointIndex(state, state.index);
    state.index += 1;
  }
  return true;
}

function startEndpointString(text: string, state: EndpointMaskState): void {
  const character = text[state.index];
  if (character === "'" || character === '"' || character === "`") {
    state.stringDelimiter = character;
    state.escaped = false;
    state.codeMask[state.index] = 0;
  }
  state.index += 1;
}

function advanceEndpointMask(text: string, language: CodeLanguage, state: EndpointMaskState): void {
  if (advanceEndpointBlockComment(text, state)) return;
  if (advanceEndpointTripleQuote(text, state)) return;
  if (advanceEndpointString(text, state)) return;
  if (startEndpointTripleQuote(text, language, state)) return;
  if (startEndpointBlockComment(text, state)) return;
  if (maskEndpointLineComment(text, language, state)) return;
  startEndpointString(text, state);
}

function maskEndpointCommentOrDocstringText(
  text: string,
  language: CodeLanguage,
): EndpointScanText {
  const chars = text.split("");
  const codeMask = new Uint8Array(text.length);
  codeMask.fill(1);
  const state: EndpointMaskState = {
    chars,
    codeMask,
    index: 0,
    stringDelimiter: undefined,
    escaped: false,
    inBlockComment: false,
    pythonTripleQuote: undefined,
  };
  while (state.index < text.length) {
    advanceEndpointMask(text, language, state);
  }

  const lineOffsets: number[] = [0];
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] === "\n") {
      lineOffsets.push(offset + 1);
    }
  }
  const maskedText = chars.join("");
  return {
    text: maskedText,
    lines: maskedText.split(/\r?\n/u),
    lineOffsets,
    isCodeAt: (offset: number): boolean => codeMask[offset] === 1,
  };
}

function matchStartsInCode(
  scan: EndpointScanText,
  match: Pick<RegExpMatchArray, "index">,
): boolean {
  return match.index !== undefined && scan.isCodeAt(match.index);
}

function firstCodeMatch(
  line: string,
  pattern: RegExp,
  scan: EndpointScanText,
  lineOffset: number,
): RegExpExecArray | undefined {
  const match = pattern.exec(line);
  if (match === null || !scan.isCodeAt(lineOffset + match.index)) {
    return undefined;
  }
  return match;
}

function groupImportBindingsByFile(
  importBindings: readonly CodeImportBinding[],
): ReadonlyMap<string, readonly CodeImportBinding[]> {
  const byFile = new Map<string, CodeImportBinding[]>();
  for (const binding of importBindings) {
    byFile.set(binding.importerPath, [...(byFile.get(binding.importerPath) ?? []), binding]);
  }
  return byFile;
}

function resolveImportedSymbolTarget(
  referenceName: string,
  byName: ReadonlyMap<string, readonly CodeSymbol[]>,
  importBindings: readonly CodeImportBinding[],
): CodeSymbol | undefined {
  const binding = importBindings.find((candidate) => candidate.localName === referenceName);
  if (binding === undefined) {
    return undefined;
  }
  return (byName.get(binding.importedName.toLowerCase()) ?? []).find(
    (symbol) => symbol.scopePath === binding.targetPath,
  );
}

function resolveCallTarget(
  callerPath: string,
  calleeName: string,
  byName: ReadonlyMap<string, readonly CodeSymbol[]>,
  imports: readonly CodeImportEdge[],
  importBindings: readonly CodeImportBinding[],
): { readonly symbol: CodeSymbol; readonly confidence: "resolved" | "heuristic" } | undefined {
  const importedSymbol = resolveImportedSymbolTarget(calleeName, byName, importBindings);
  if (importedSymbol !== undefined) {
    return { symbol: importedSymbol, confidence: "resolved" };
  }
  const candidates = byName.get(calleeName.toLowerCase()) ?? [];
  const importedTargets = new Set(imports.map((edge) => edge.targetPath).filter(isString));
  const imported = candidates.find((candidate) => importedTargets.has(candidate.scopePath));
  const target =
    imported ?? candidates.find((candidate) => candidate.scopePath !== callerPath) ?? candidates[0];
  if (target === undefined) {
    return undefined;
  }
  return {
    symbol: target,
    confidence: target.name === calleeName ? "resolved" : "heuristic",
  };
}

function calleeNameFromExpression(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
}

function collectTypescriptCalls(
  file: SourceFile,
  byName: ReadonlyMap<string, readonly CodeSymbol[]>,
  imports: readonly CodeImportEdge[],
  importBindings: readonly CodeImportBinding[],
): readonly CodeCallEdge[] {
  const sourceFile = file.syntaxTree;
  if (sourceFile === undefined) {
    return [];
  }
  const calls: CodeCallEdge[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeNameFromExpression(node.expression);
      if (name !== undefined && !IGNORED_CALL_NAMES.has(name.toLowerCase())) {
        const resolved = resolveCallTarget(file.scopePath, name, byName, imports, importBindings);
        if (resolved !== undefined) {
          calls.push({
            callerPath: file.scopePath,
            callerLine: nodeStartLine(sourceFile, node),
            calleeName: name,
            targetName: resolved.symbol.name,
            targetPath: resolved.symbol.scopePath,
            targetLineRange: resolved.symbol.lineRange,
            confidence: resolved.confidence,
            parser: "typescript-compiler-ast",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function isDeclarationNameIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
    (ts.isEnumDeclaration(parent) && parent.name === node) ||
    (ts.isModuleDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node)
  );
}

function isNonReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (isDeclarationNameIdentifier(node)) {
    return true;
  }
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) {
    return true;
  }
  if (ts.isExportSpecifier(parent)) {
    return true;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return true;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) {
    return true;
  }
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  return false;
}

function resolveReferenceTarget(
  file: SourceFile,
  referenceName: string,
  byName: ReadonlyMap<string, readonly CodeSymbol[]>,
  importBindings: readonly CodeImportBinding[],
): { readonly symbol: CodeSymbol; readonly confidence: "resolved" | "heuristic" } | undefined {
  const importedSymbol = resolveImportedSymbolTarget(referenceName, byName, importBindings);
  if (importedSymbol !== undefined) {
    return { symbol: importedSymbol, confidence: "resolved" };
  }
  const candidates = byName.get(referenceName.toLowerCase()) ?? [];
  const local = candidates.find((symbol) => symbol.scopePath === file.scopePath);
  if (local !== undefined) {
    return { symbol: local, confidence: "resolved" };
  }
  if (candidates.length === 1) {
    const [candidate] = candidates;
    if (candidate !== undefined) {
      return { symbol: candidate, confidence: "heuristic" };
    }
  }
  return undefined;
}

function collectReferences(
  files: readonly SourceFile[],
  symbols: readonly CodeSymbol[],
  importBindings: readonly CodeImportBinding[],
): readonly CodeReferenceEdge[] {
  const byName = new Map<string, CodeSymbol[]>();
  for (const symbol of symbols) {
    const key = symbol.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), symbol]);
  }
  const bindingsByFile = groupImportBindingsByFile(importBindings);
  return files.flatMap((file) =>
    file.syntaxTree === undefined
      ? collectPolyglotReferences(file, byName, bindingsByFile.get(file.scopePath) ?? [])
      : collectTypescriptReferences(file, byName, bindingsByFile.get(file.scopePath) ?? []),
  );
}

function collectPolyglotReferences(
  file: SourceFile,
  byName: ReadonlyMap<string, readonly CodeSymbol[]>,
  importBindings: readonly CodeImportBinding[],
): readonly CodeReferenceEdge[] {
  const references: CodeReferenceEdge[] = [];
  const seen = new Set<string>();
  const lines = polyglotIdentifierScanLines(file);
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (isPolyglotImportOrNamespaceLine(line)) {
      return;
    }
    for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\b/gu)) {
      const name = match[1];
      if (name === undefined || IGNORED_CALL_NAMES.has(name.toLowerCase())) {
        continue;
      }
      const range = lineRange(lineNo);
      const resolved = resolveReferenceTarget(file, name, byName, importBindings);
      if (
        resolved === undefined ||
        (resolved.symbol.scopePath === file.scopePath &&
          sameLineRange(resolved.symbol.lineRange, range))
      ) {
        continue;
      }
      const key = [
        file.scopePath,
        String(lineNo),
        name,
        resolved.symbol.scopePath,
        resolved.symbol.name,
      ].join("|");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      references.push({
        referencerPath: file.scopePath,
        referenceLineRange: range,
        referenceName: name,
        targetName: resolved.symbol.name,
        targetPath: resolved.symbol.scopePath,
        targetLineRange: resolved.symbol.lineRange,
        confidence: resolved.confidence,
        parser: "polyglot-regex",
      });
    }
  });
  return references;
}

function isPolyglotImportOrNamespaceLine(line: string): boolean {
  return /^\s*(?:import|from|package|using|namespace)\b/u.test(line);
}

function collectTypescriptReferences(
  file: SourceFile,
  byName: ReadonlyMap<string, readonly CodeSymbol[]>,
  importBindings: readonly CodeImportBinding[],
): readonly CodeReferenceEdge[] {
  const sourceFile = file.syntaxTree;
  if (sourceFile === undefined) {
    return [];
  }
  const references: CodeReferenceEdge[] = [];
  const seen = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isNonReferenceIdentifier(node)) {
      const resolved = resolveReferenceTarget(file, node.text, byName, importBindings);
      const range = nodeLineRange(sourceFile, node);
      if (
        resolved !== undefined &&
        !(
          resolved.symbol.scopePath === file.scopePath &&
          sameLineRange(resolved.symbol.lineRange, range)
        )
      ) {
        const key = [
          file.scopePath,
          String(range.startLine),
          String(range.endLine),
          node.text,
          resolved.symbol.scopePath,
          resolved.symbol.name,
        ].join("|");
        if (!seen.has(key)) {
          seen.add(key);
          references.push({
            referencerPath: file.scopePath,
            referenceLineRange: range,
            referenceName: node.text,
            targetName: resolved.symbol.name,
            targetPath: resolved.symbol.scopePath,
            targetLineRange: resolved.symbol.lineRange,
            confidence: resolved.confidence,
            parser: "typescript-compiler-ast",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function sameLineRange(left: LineRange, right: LineRange): boolean {
  return left.startLine === right.startLine && left.endLine === right.endLine;
}

function pathOnlyRouteInput(path: string): string {
  if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//u.test(path)) {
    try {
      return new URL(path).pathname;
    } catch {
      return path;
    }
  }
  return path.split(/[?#]/u)[0] ?? path;
}

function normalizeRoutePath(path: string): string {
  const pathOnly = pathOnlyRouteInput(path);
  const collapsed = `/${pathOnly}`.replace(/\/+/gu, "/");
  return (
    collapsed
      .replace(/^\/\^/u, "/")
      .replace(/\$$/u, "")
      .replace(/<[^>]+>/gu, ":param")
      .replace(/\(\?P<[^>]+>[^)]+\)/gu, ":param")
      .replace(/\$\{[^}]+\}/gu, ":param")
      .replace(/\{[^}]+\}/gu, ":param")
      .replace(/:[A-Za-z_][\w-]*/gu, ":param")
      .replace(/\/$/u, "") || "/"
  );
}

function combineRoutePath(prefix: string | undefined, path: string): string {
  if (prefix === undefined || prefix.length === 0 || prefix === "/") {
    return path;
  }
  if (path.length === 0 || path === "/") {
    return prefix;
  }
  return `${prefix.replace(/\/$/u, "")}/${path.replace(/^\//u, "")}`;
}

function braceDelta(line: string): number {
  let delta = 0;
  for (const char of line) {
    if (char === "{") {
      delta += 1;
    } else if (char === "}") {
      delta -= 1;
    }
  }
  return delta;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

interface DotNetRouteAttribute {
  readonly method: string;
  readonly path: string;
  readonly isRoute: boolean;
}

const DOT_NET_HTTP_ATTRIBUTE_METHODS: Readonly<Record<string, string>> = {
  httpdelete: "DELETE",
  httpget: "GET",
  httphead: "HEAD",
  httpoptions: "OPTIONS",
  httppatch: "PATCH",
  httppost: "POST",
  httpput: "PUT",
};

function routePathFromAttributeArgs(args: string | undefined): string {
  return /["']([^"']*)["']/u.exec(args ?? "")?.[1] ?? "";
}

function springMappingPath(args: string | undefined): string | undefined {
  const value = args ?? "";
  const named = /\b(?:path|value)\s*=\s*(?:\{\s*)?(["'`])([^"'`]+)\1/u.exec(value)?.[2];
  if (named !== undefined) {
    return named;
  }
  if (value.includes("=")) {
    return undefined;
  }
  return routePathFromAttributeArgs(value) || undefined;
}

function springMappingMethod(composedMethod: string | undefined, args: string | undefined): string {
  return (
    composedMethod ??
    /method\s*=\s*(?:\{\s*)?RequestMethod\.([A-Z]+)/u.exec(args ?? "")?.[1] ??
    "ANY"
  );
}

function parseDotNetRouteAttribute(line: string): DotNetRouteAttribute | undefined {
  const attr = /^\s*\[([A-Za-z_][\w]*?)(?:Attribute)?(?:\((.*)\))?\]\s*$/u.exec(line);
  const rawName = attr?.[1]?.toLowerCase();
  if (rawName === undefined) {
    return undefined;
  }
  const path = routePathFromAttributeArgs(attr?.[2]);
  if (rawName === "route") {
    return { method: "ANY", path, isRoute: true };
  }
  const method = DOT_NET_HTTP_ATTRIBUTE_METHODS[rawName];
  return method === undefined ? undefined : { method, path, isRoute: false };
}

function dotNetControllerRouteToken(className: string): string {
  return className.replace(/Controller$/u, "").toLowerCase();
}

function dotNetMethodDeclaration(line: string): boolean {
  return /^\s*(?:(?:public|private|protected|internal|static|async|virtual|override|sealed|partial)\s+)*(?:[A-Za-z_$][\w$<>,.[\]?]*\s+)+[A-Za-z_$][\w$]*\s*\(/u.test(
    line,
  );
}

function replaceDotNetRouteTokens(path: string, className: string | undefined): string {
  return className === undefined
    ? path
    : path.replace(/\[controller\]/giu, dotNetControllerRouteToken(className));
}

function dotNetMinimalApiMethod(mapMethod: string, args: string): string {
  if (mapMethod.toLowerCase() === "methods") {
    return /["']([A-Z]+)["']/u.exec(args)?.[1] ?? "ANY";
  }
  return mapMethod.toUpperCase();
}

function goHttpMethodFromMethodsArgs(args: string | undefined): string {
  const value = args ?? "";
  const literal = /["']([A-Z]+)["']/u.exec(value)?.[1];
  if (literal !== undefined) {
    return literal;
  }
  const constant = /\bhttp\.Method(Get|Post|Put|Patch|Delete|Head|Options)\b/u.exec(value)?.[1];
  return constant === undefined ? "ANY" : constant.toUpperCase();
}

function goRouterMethodName(method: string): string {
  return method.toUpperCase();
}

function nestHttpMethod(method: string): string {
  return method.toLowerCase() === "all" ? "ANY" : method.toUpperCase();
}

function collectAxiosBasePaths(scan: EndpointScanText): ReadonlyMap<string, string> {
  const bases = new Map<string, string>();
  for (const match of scan.text.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*axios\.create\s*\(\s*\{[\s\S]*?\bbaseURL\s*:\s*(["'`])([^"'`]+)\2[\s\S]*?\}\s*\)/gu,
  )) {
    if (!matchStartsInCode(scan, match)) {
      continue;
    }
    const variableName = match[1];
    const basePath = match[3];
    if (variableName !== undefined && basePath !== undefined) {
      bases.set(variableName, basePath);
    }
  }
  return bases;
}

function collectExpressRouterMounts(scan: EndpointScanText): ReadonlyMap<string, string> {
  const mounts = new Map<string, string>();
  for (const match of scan.text.matchAll(
    /\b(?:app|server)\.use\s*\(\s*(["'`])([^"'`]+)\1\s*,\s*([A-Za-z_$][\w$]*)/gu,
  )) {
    if (!matchStartsInCode(scan, match)) {
      continue;
    }
    const prefix = match[2];
    const routerName = match[3];
    if (prefix !== undefined && routerName !== undefined) {
      mounts.set(routerName, prefix);
    }
  }
  return mounts;
}

function fetchMethod(line: string): string {
  return /\bmethod\s*:\s*(["'`])([A-Z]+)\1/iu.exec(line)?.[2]?.toUpperCase() ?? "GET";
}

function collectFetchClientEndpoints(
  file: SourceFile,
  scan: EndpointScanText,
): readonly ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  for (const match of scan.text.matchAll(/\bfetch\s*\(\s*(["'`])([^"'`]+)\1([\s\S]*?)\)/gu)) {
    if (!matchStartsInCode(scan, match)) {
      continue;
    }
    const path = match[2];
    if (path === undefined) {
      continue;
    }
    endpoints.push({
      role: "client",
      method: fetchMethod(match[0]),
      path: normalizeRoutePath(path),
      scopePath: file.scopePath,
      lineRange: lineRange(lineNumberAtOffset(file.text, match.index)),
      language: file.language,
      parser: "polyglot-regex",
    });
  }
  return endpoints;
}

function namedStringArg(args: string | undefined, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'\`])([^"'\`]+)\\1`, "u");
  return pattern.exec(args ?? "")?.[2];
}

function collectDeclaredPythonPrefixes(
  scan: EndpointScanText,
  constructor: "APIRouter" | "Blueprint",
  argumentName: "prefix" | "url_prefix",
): ReadonlyMap<string, string> {
  const prefixes = new Map<string, string>();
  const pattern = new RegExp(
    String.raw`\b([A-Za-z_][\w]*)\s*=\s*${constructor}\s*\(([^)]*)\)`,
    "gu",
  );
  for (const match of scan.text.matchAll(pattern)) {
    if (!matchStartsInCode(scan, match)) continue;
    const variableName = match[1];
    const prefix = namedStringArg(match[2], argumentName);
    if (variableName !== undefined && prefix !== undefined) prefixes.set(variableName, prefix);
  }
  return prefixes;
}

function applyIncludedPythonRouterPrefixes(
  scan: EndpointScanText,
  prefixes: Map<string, string>,
): void {
  for (const match of scan.text.matchAll(/\.include_router\b/gu)) {
    if (!matchStartsInCode(scan, match)) continue;
    const matchEnd = match.index + match[0].length;
    const call = /^\s*\(\s*([A-Za-z_]\w*)/u.exec(scan.text.slice(matchEnd));
    const routerName = call?.[1];
    if (routerName === undefined || call === null) continue;
    const argumentsStart = matchEnd + call[0].length;
    const argumentsEnd = scan.text.indexOf(")", argumentsStart);
    if (argumentsEnd < 0) continue;
    const prefix = namedStringArg(scan.text.slice(argumentsStart, argumentsEnd), "prefix");
    if (prefix === undefined) continue;
    prefixes.set(routerName, combineRoutePath(prefix, prefixes.get(routerName) ?? ""));
  }
}

function collectPythonRoutePrefixes(scan: EndpointScanText): ReadonlyMap<string, string> {
  const prefixes = new Map([
    ...collectDeclaredPythonPrefixes(scan, "APIRouter", "prefix"),
    ...collectDeclaredPythonPrefixes(scan, "Blueprint", "url_prefix"),
  ]);
  applyIncludedPythonRouterPrefixes(scan, prefixes);
  return prefixes;
}

interface OpenApiYamlEndpointState {
  inPaths: boolean;
  pathsIndent: number;
  currentPath: string | undefined;
  currentPathLine: number;
}

function openApiPathFromLine(trimmed: string): string | undefined {
  if (!trimmed.endsWith(":")) return undefined;
  const rawCandidate = trimmed.slice(0, -1).trim();
  const quoted =
    (rawCandidate.startsWith('"') && rawCandidate.endsWith('"')) ||
    (rawCandidate.startsWith("'") && rawCandidate.endsWith("'"));
  const candidate = quoted ? rawCandidate.slice(1, -1) : rawCandidate;
  return candidate.startsWith("/") && !candidate.includes(":") ? candidate : undefined;
}

function openApiYamlEndpointForLine(
  file: SourceFile,
  state: OpenApiYamlEndpointState,
  line: string,
  lineNumber: number,
): ApiEndpoint | "done" | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return undefined;
  const indent = line.length - line.trimStart().length;
  if (!state.inPaths) {
    if (/^paths\s*:\s*$/u.test(trimmed)) {
      state.inPaths = true;
      state.pathsIndent = indent;
    }
    return undefined;
  }
  if (indent <= state.pathsIndent && !trimmed.startsWith("/")) return "done";
  const path = openApiPathFromLine(trimmed);
  if (path !== undefined) {
    state.currentPath = path;
    state.currentPathLine = lineNumber;
    return undefined;
  }
  const method = /^([A-Za-z]+)\s*:\s*$/u.exec(trimmed)?.[1]?.toLowerCase();
  if (state.currentPath === undefined || method === undefined || !HTTP_METHODS.has(method)) {
    return undefined;
  }
  return {
    role: "server",
    method: method.toUpperCase(),
    path: normalizeRoutePath(state.currentPath),
    scopePath: file.scopePath,
    lineRange: lineRange(state.currentPathLine),
    language: file.language,
    parser: "polyglot-regex",
  };
}

function graphqlEndpointPath(kind: string, fieldName: string): string {
  return `/graphql/${kind.toLowerCase()}/${fieldName}`;
}

function graphqlEndpoint(
  file: SourceFile,
  role: "server" | "client",
  kind: string,
  fieldName: string,
  lineNo: number,
): ApiEndpoint {
  return {
    role,
    method: kind.toUpperCase(),
    path: graphqlEndpointPath(kind, fieldName),
    scopePath: file.scopePath,
    lineRange: lineRange(lineNo),
    language: file.language,
    parser: "polyglot-regex",
  };
}

function collectGraphqlFields(segment: string): readonly string[] {
  const fields: string[] = [];
  for (const match of segment.matchAll(/\b([A-Za-z_][\w]*)\s*(?:\([^)]*\))?\s*:/gu)) {
    const name = match[1];
    if (name !== undefined && !["schema", "type", "extend"].includes(name.toLowerCase())) {
      fields.push(name);
    }
  }
  return fields;
}

function collectGraphqlSchemaEndpoints(
  file: SourceFile,
  scan: EndpointScanText,
): readonly ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const lines = scan.lines;
  let currentKind: string | undefined;
  let braceDepth = 0;
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const typeMatch = firstCodeMatch(
      line,
      /^\s*(?:extend\s+)?type\s+(Query|Mutation)\b(.*)$/iu,
      scan,
      scan.lineOffsets[index] ?? 0,
    );
    if (typeMatch?.[1] !== undefined) {
      currentKind = typeMatch[1].toUpperCase();
      braceDepth = braceDelta(line);
    }
    if (currentKind === undefined) {
      return;
    }
    const segment =
      typeMatch?.[2] === undefined
        ? line
        : typeMatch[2].replace(/^[^{]*\{/u, "").replace(/\}\s*$/u, "");
    for (const fieldName of collectGraphqlFields(segment)) {
      endpoints.push(graphqlEndpoint(file, "server", currentKind, fieldName, lineNo));
    }
    if (typeMatch === undefined) {
      braceDepth += braceDelta(line);
    }
    if (braceDepth <= 0) {
      currentKind = undefined;
    }
  });
  return endpoints;
}

function lineNumberAtOffset(text: string, offset: number): number {
  return text.slice(0, Math.max(0, offset)).split(/\n/u).length;
}

function firstGraphqlSelectionField(operationText: string): string | undefined {
  const selectionStart = operationText.indexOf("{");
  if (selectionStart < 0) {
    return undefined;
  }
  const selection = operationText.slice(selectionStart + 1).replace(/#[^\n]*/gu, " ");
  return /\b([A-Za-z_][\w]*)\s*(?:\([^)]*\))?/u.exec(selection)?.[1];
}

function collectGraphqlOperationEndpoints(
  file: SourceFile,
  text: string,
  baseOffset: number,
): readonly ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const operationPattern = /\b(query|mutation)\b[\s\S]*?(?=\n\s*(?:query|mutation)\b|$)/giu;
  for (const operation of text.matchAll(operationPattern)) {
    const operationText = operation[0];
    const kind = operation[1];
    const fieldName = firstGraphqlSelectionField(operationText);
    if (kind === undefined || fieldName === undefined) {
      continue;
    }
    endpoints.push(
      graphqlEndpoint(
        file,
        "client",
        kind,
        fieldName,
        lineNumberAtOffset(file.text, baseOffset + operation.index),
      ),
    );
  }
  return endpoints;
}

function collectGraphqlClientEndpoints(
  file: SourceFile,
  scan = maskEndpointCommentOrDocstringText(file.text, file.language),
): readonly ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  for (const tag of scan.text.matchAll(/\b(?:gql|graphql)\s*`([\s\S]*?)`/gu)) {
    if (!matchStartsInCode(scan, tag)) {
      continue;
    }
    const operation = tag[1] ?? "";
    endpoints.push(...collectGraphqlOperationEndpoints(file, operation, tag.index));
  }
  return endpoints;
}

function collectGraphqlDocumentEndpoints(file: SourceFile): readonly ApiEndpoint[] {
  const scan = maskEndpointCommentOrDocstringText(file.text, file.language);
  return [
    ...collectGraphqlSchemaEndpoints(file, scan),
    ...collectGraphqlOperationEndpoints(file, scan.text, 0),
  ];
}

function protobufEndpointPath(serviceName: string, rpcName: string): string {
  return `/protobuf/${serviceName.toLowerCase()}/${rpcName.toLowerCase()}`;
}

function protobufEndpoint(
  file: SourceFile,
  role: "server" | "client",
  serviceName: string,
  rpcName: string,
  lineNo: number,
): ApiEndpoint {
  return {
    role,
    method: "RPC",
    path: protobufEndpointPath(serviceName, rpcName),
    scopePath: file.scopePath,
    lineRange: lineRange(lineNo),
    language: file.language,
    parser: "polyglot-regex",
  };
}

function collectProtobufServiceEndpoints(file: SourceFile): readonly ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const scan = maskEndpointCommentOrDocstringText(file.text, file.language);
  const lines = scan.lines;
  let currentService: string | undefined;
  let serviceBraceDepth = 0;
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const lineOffset = scan.lineOffsets[index] ?? 0;
    const serviceMatch = firstCodeMatch(
      line,
      /\bservice\s+([A-Za-z_][\w]*)\s*\{/u,
      scan,
      lineOffset,
    );
    if (serviceMatch?.[1] !== undefined) {
      currentService = serviceMatch[1];
      serviceBraceDepth = braceDelta(line);
    }
    if (currentService !== undefined) {
      const rpcMatch = firstCodeMatch(line, /\brpc\s+([A-Za-z_][\w]*)\s*\(/u, scan, lineOffset);
      if (rpcMatch?.[1] !== undefined) {
        endpoints.push(protobufEndpoint(file, "server", currentService, rpcMatch[1], lineNo));
      }
      if (serviceMatch === undefined) {
        serviceBraceDepth += braceDelta(line);
      }
      if (serviceBraceDepth <= 0 && line.includes("}")) {
        currentService = undefined;
        serviceBraceDepth = 0;
      }
    }
  });
  return endpoints;
}

function collectProtobufClientEndpoints(
  file: SourceFile,
  scan: EndpointScanText,
): readonly ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const clientServicesByVariable = new Map<string, string>();
  const lines = scan.lines;
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const lineOffset = scan.lineOffsets[index] ?? 0;
    for (const declaration of line.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_][\w]*?)(?:Client)?\s*\(/gu,
    )) {
      if (!scan.isCodeAt(lineOffset + declaration.index)) {
        continue;
      }
      const variableName = declaration[1];
      const serviceName = declaration[2];
      if (variableName !== undefined && serviceName !== undefined) {
        clientServicesByVariable.set(variableName, serviceName);
      }
    }
    for (const call of line.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/gu)) {
      if (!scan.isCodeAt(lineOffset + call.index)) {
        continue;
      }
      const variableName = call[1];
      const rpcName = call[2];
      if (variableName === undefined || rpcName === undefined) {
        continue;
      }
      const serviceName = clientServicesByVariable.get(variableName);
      if (serviceName !== undefined) {
        endpoints.push(protobufEndpoint(file, "client", serviceName, rpcName, lineNo));
      }
    }
  });
  return endpoints;
}

function collectOpenApiJsonEndpoints(file: SourceFile): readonly ApiEndpoint[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.paths)) {
    return [];
  }
  const endpoints: ApiEndpoint[] = [];
  for (const [path, operations] of Object.entries(parsed.paths)) {
    if (!isRecord(operations)) {
      continue;
    }
    for (const method of Object.keys(operations)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) {
        continue;
      }
      endpoints.push({
        role: "server",
        method: method.toUpperCase(),
        path: normalizeRoutePath(path),
        scopePath: file.scopePath,
        lineRange: lineRange(1),
        language: file.language,
        parser: "polyglot-regex",
      });
    }
  }
  return endpoints;
}

function collectOpenApiYamlEndpoints(file: SourceFile): readonly ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const lines = file.text.split(/\r?\n/u);
  const state: OpenApiYamlEndpointState = {
    inPaths: false,
    pathsIndent: -1,
    currentPath: undefined,
    currentPathLine: 1,
  };
  for (let index = 0; index < lines.length; index += 1) {
    const endpoint = openApiYamlEndpointForLine(file, state, lines[index] ?? "", index + 1);
    if (endpoint === "done") break;
    if (endpoint !== undefined) endpoints.push(endpoint);
  }
  return endpoints;
}

function collectOpenApiEndpoints(file: SourceFile): readonly ApiEndpoint[] {
  return extension(file.scopePath) === "json"
    ? collectOpenApiJsonEndpoints(file)
    : collectOpenApiYamlEndpoints(file);
}

interface EndpointCollectionState {
  pendingSpringClassPrefix: string | undefined;
  springClassPrefix: string | undefined;
  springClassBraceDepth: number;
  insideSpringClass: boolean;
  springAnyClassBraceDepth: number;
  pendingDotNetClassRoute: string | undefined;
  pendingDotNetMethodRoute: string | undefined;
  pendingDotNetMethod: string | undefined;
  dotNetClassPrefix: string | undefined;
  dotNetClassName: string | undefined;
  dotNetClassBraceDepth: number;
  pendingNestClassPrefix: string | undefined;
  nestClassPrefix: string | undefined;
  nestClassBraceDepth: number;
}

interface EndpointLineContext {
  readonly file: SourceFile;
  readonly scan: EndpointScanText;
  readonly endpoints: ApiEndpoint[];
  readonly state: EndpointCollectionState;
  readonly line: string;
  readonly lineNo: number;
  readonly lineOffset: number;
  readonly hasRtkQueryApi: boolean;
  readonly axiosBasePaths: ReadonlyMap<string, string>;
  readonly expressRouterMounts: ReadonlyMap<string, string>;
  readonly pythonRoutePrefixes: ReadonlyMap<string, string>;
}

function createEndpointCollectionState(): EndpointCollectionState {
  return {
    pendingSpringClassPrefix: undefined,
    springClassPrefix: undefined,
    springClassBraceDepth: 0,
    insideSpringClass: false,
    springAnyClassBraceDepth: 0,
    pendingDotNetClassRoute: undefined,
    pendingDotNetMethodRoute: undefined,
    pendingDotNetMethod: undefined,
    dotNetClassPrefix: undefined,
    dotNetClassName: undefined,
    dotNetClassBraceDepth: 0,
    pendingNestClassPrefix: undefined,
    nestClassPrefix: undefined,
    nestClassBraceDepth: 0,
  };
}

function emitEndpoint(
  context: EndpointLineContext,
  role: "server" | "client",
  method: string,
  path: string,
): void {
  context.endpoints.push({
    role,
    method: method.toUpperCase(),
    path: normalizeRoutePath(path),
    scopePath: context.file.scopePath,
    lineRange: lineRange(context.lineNo),
    language: context.file.language,
    parser: "polyglot-regex",
  });
}

function detectEndpointClassDeclarations(context: EndpointLineContext): void {
  const { line, lineOffset, scan, state } = context;
  const springClass = firstCodeMatch(
    line,
    /\b(?:class|interface|record)\s+[A-Za-z_][\w$]*/u,
    scan,
    lineOffset,
  );
  if (springClass !== undefined) {
    state.insideSpringClass = true;
    state.springAnyClassBraceDepth = 0;
    if (state.pendingSpringClassPrefix !== undefined) {
      state.springClassPrefix = state.pendingSpringClassPrefix;
      state.pendingSpringClassPrefix = undefined;
      state.springClassBraceDepth = 0;
    }
  }
  const nestClass = firstCodeMatch(line, /\bclass\s+[A-Za-z_][\w$]*/u, scan, lineOffset);
  if (state.pendingNestClassPrefix !== undefined && nestClass !== undefined) {
    state.nestClassPrefix = state.pendingNestClassPrefix;
    state.pendingNestClassPrefix = undefined;
    state.nestClassBraceDepth = 0;
  }
  const className = firstCodeMatch(line, /\bclass\s+([A-Za-z_][\w]*)/u, scan, lineOffset)?.[1];
  if (state.pendingDotNetClassRoute !== undefined && className !== undefined) {
    state.dotNetClassPrefix = replaceDotNetRouteTokens(state.pendingDotNetClassRoute, className);
    state.dotNetClassName = className;
    state.pendingDotNetClassRoute = undefined;
    state.dotNetClassBraceDepth = 0;
  }
}

function collectDotNetLineEndpoints(context: EndpointLineContext): void {
  const { line, lineOffset, scan, state } = context;
  const route = parseDotNetRouteAttribute(line);
  if (route !== undefined) {
    const path = replaceDotNetRouteTokens(route.path, state.dotNetClassName);
    if (route.isRoute) {
      if (state.dotNetClassName === undefined) state.pendingDotNetClassRoute = path;
      else state.pendingDotNetMethodRoute = path;
    } else {
      state.pendingDotNetMethod = route.method;
      if (path.length > 0) state.pendingDotNetMethodRoute = path;
    }
  } else if (
    (state.pendingDotNetMethod !== undefined || state.pendingDotNetMethodRoute !== undefined) &&
    dotNetMethodDeclaration(line)
  ) {
    emitEndpoint(
      context,
      "server",
      state.pendingDotNetMethod ?? "ANY",
      combineRoutePath(state.dotNetClassPrefix, state.pendingDotNetMethodRoute ?? ""),
    );
    state.pendingDotNetMethod = undefined;
    state.pendingDotNetMethodRoute = undefined;
  }
  const minimal = firstCodeMatch(
    line,
    /\b\w+\.Map(Get|Post|Put|Patch|Delete|Head|Options|Methods)\s*\(\s*(["'`])([^"'`]+)\2([^)]*)/u,
    scan,
    lineOffset,
  );
  if (minimal?.[1] !== undefined && minimal[3] !== undefined) {
    emitEndpoint(
      context,
      "server",
      dotNetMinimalApiMethod(minimal[1], minimal[4] ?? ""),
      minimal[3],
    );
  }
}

function collectSpringLineEndpoints(context: EndpointLineContext): void {
  const { line, lineOffset, scan, state } = context;
  const spring = firstCodeMatch(
    line,
    /@(?:(Get|Post|Put|Patch|Delete)Mapping|RequestMapping)(?:\s*\(([^)]*)\))?/u,
    scan,
    lineOffset,
  );
  if (spring === undefined) return;
  const isRequestMapping = line.includes("@RequestMapping");
  const method = springMappingMethod(spring[1], spring[2]);
  const path = springMappingPath(spring[2]);
  if (isRequestMapping && !state.insideSpringClass && state.springClassPrefix === undefined) {
    if (path !== undefined) state.pendingSpringClassPrefix = path;
  } else if (path !== undefined || (!isRequestMapping && state.insideSpringClass)) {
    emitEndpoint(context, "server", method, combineRoutePath(state.springClassPrefix, path ?? ""));
  }
}

function quotedCallArgument(text: string): string | undefined {
  let cursor = 0;
  while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
  if (text[cursor] !== "(") return undefined;
  cursor += 1;
  while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
  const quote = text[cursor];
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
  const end = text.indexOf(quote, cursor + 1);
  return end < 0 ? undefined : text.slice(cursor + 1, end);
}

function collectNestLineEndpoints(context: EndpointLineContext): void {
  const { file, line, lineOffset, scan, state } = context;
  if (file.language !== "typescript" && file.language !== "javascript") return;
  const controller = firstCodeMatch(line, /@Controller\b/u, scan, lineOffset);
  if (controller !== undefined) {
    const afterMarker = line.slice(controller.index + controller[0].length);
    state.pendingNestClassPrefix = quotedCallArgument(afterMarker) ?? "";
  }
  const route = firstCodeMatch(
    line,
    /@(Get|Post|Put|Patch|Delete|Head|Options|All)\b/u,
    scan,
    lineOffset,
  );
  if (route?.[1] !== undefined) {
    const afterMarker = line.slice(route.index + route[0].length);
    if (!/^\s*\(/u.test(afterMarker)) return;
    emitEndpoint(
      context,
      "server",
      nestHttpMethod(route[1]),
      combineRoutePath(state.nestClassPrefix, quotedCallArgument(afterMarker) ?? ""),
    );
  }
}

function isExpressServerObject(name: string, mounts: ReadonlyMap<string, string>): boolean {
  return ["app", "router", "server"].includes(name) || mounts.has(name);
}

function collectExpressLineEndpoints(context: EndpointLineContext): void {
  const { line, lineOffset, scan, expressRouterMounts } = context;
  const direct = firstCodeMatch(
    line,
    /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']/iu,
    scan,
    lineOffset,
  );
  if (direct?.[1] !== undefined && direct[2] !== undefined && direct[3] !== undefined) {
    const path = combineRoutePath(expressRouterMounts.get(direct[1]), direct[3]);
    if (isExpressServerObject(direct[1], expressRouterMounts)) {
      emitEndpoint(context, "server", direct[2], path);
    }
  }
  const chained = firstCodeMatch(
    line,
    /\b([A-Za-z_$][\w$]*)\.route\s*\(\s*(["'`])([^"'`]+)\2\s*\)\s*\.\s*(get|post|put|patch|delete|head|options)\b/iu,
    scan,
    lineOffset,
  );
  if (chained?.[1] !== undefined && chained[3] !== undefined && chained[4] !== undefined) {
    const path = combineRoutePath(expressRouterMounts.get(chained[1]), chained[3]);
    if (isExpressServerObject(chained[1], expressRouterMounts)) {
      emitEndpoint(context, "server", chained[4], path);
    }
  }
}

function collectPythonLineEndpoints(context: EndpointLineContext): void {
  const { file, line, lineOffset, scan, pythonRoutePrefixes } = context;
  const route = firstCodeMatch(
    line,
    /@([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\.route\s*\(\s*["']([^"']+)["'](?:[^)]*methods\s*=\s*\[["']([A-Z]+)["'])?/iu,
    scan,
    lineOffset,
  );
  if (route?.[1] !== undefined && route[2] !== undefined) {
    emitEndpoint(
      context,
      "server",
      route[3] ?? "ANY",
      combineRoutePath(pythonRoutePrefixes.get(route[1]), route[2]),
    );
  }
  const methodRoute = firstCodeMatch(
    line,
    /@([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\.(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']/iu,
    scan,
    lineOffset,
  );
  if (
    methodRoute?.[1] !== undefined &&
    methodRoute[2] !== undefined &&
    methodRoute[3] !== undefined
  ) {
    emitEndpoint(
      context,
      "server",
      methodRoute[2],
      combineRoutePath(pythonRoutePrefixes.get(methodRoute[1]), methodRoute[3]),
    );
  }
  if (file.language !== "python") return;
  const django = firstCodeMatch(
    line,
    /\b(?:path|re_path|url)\s*\(\s*r?(["'])([^"']+)\1/iu,
    scan,
    lineOffset,
  );
  if (django?.[2] !== undefined) emitEndpoint(context, "server", "ANY", django[2]);
}

function collectGoLineEndpoints(context: EndpointLineContext): void {
  const { file, line, lineOffset, scan } = context;
  if (file.language !== "go") return;
  const standard = firstCodeMatch(
    line,
    /\bhttp\.HandleFunc\s*\(\s*["']([^"']+)["']/u,
    scan,
    lineOffset,
  );
  if (standard?.[1] !== undefined) emitEndpoint(context, "server", "ANY", standard[1]);
  const methodRoute = firstCodeMatch(
    line,
    /\b[A-Za-z_][\w]*\.(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*(["'`])([^"'`]+)\2/iu,
    scan,
    lineOffset,
  );
  if (methodRoute?.[1] !== undefined && methodRoute[3] !== undefined) {
    emitEndpoint(context, "server", goRouterMethodName(methodRoute[1]), methodRoute[3]);
  }
  const handleFunc = firstCodeMatch(
    line,
    /\b[A-Za-z_][\w]*\.HandleFunc\s*\(\s*(["'`])([^"'`]+)\1[^)]*\)(?:\.Methods\s*\(([^)]*)\))?/u,
    scan,
    lineOffset,
  );
  if (handleFunc?.[2] !== undefined) {
    emitEndpoint(context, "server", goHttpMethodFromMethodsArgs(handleFunc[3]), handleFunc[2]);
  }
}

function collectRtkLineEndpoints(context: EndpointLineContext): void {
  if (!context.hasRtkQueryApi) return;
  const { line, lineOffset, scan } = context;
  const direct = firstCodeMatch(
    line,
    /\bquery\s*:\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(["'`])([^"'`]+)\1/u,
    scan,
    lineOffset,
  );
  if (direct?.[2] !== undefined) emitEndpoint(context, "client", "ANY", direct[2]);
  const url = firstCodeMatch(line, /\burl\s*:\s*(["'`])([^"'`]+)\1/u, scan, lineOffset);
  if (url?.[2] === undefined) return;
  const method =
    firstCodeMatch(line, /\bmethod\s*:\s*(["'])([A-Z]+)\1/iu, scan, lineOffset)?.[2] ?? "ANY";
  emitEndpoint(context, "client", method, url[2]);
}

function collectAxiosLineEndpoints(context: EndpointLineContext): void {
  const { line, lineOffset, scan, axiosBasePaths } = context;
  const call = firstCodeMatch(
    line,
    /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete)\s*\(\s*(["'`])([^"'`]+)\3/iu,
    scan,
    lineOffset,
  );
  if (call?.[1] === undefined || call[2] === undefined || call[4] === undefined) return;
  const objectName = call[1];
  if (!["axios", "client", "api"].includes(objectName) && !axiosBasePaths.has(objectName)) return;
  emitEndpoint(
    context,
    "client",
    call[2],
    combineRoutePath(axiosBasePaths.get(objectName), call[4]),
  );
}

function updateSpringEndpointScopes(context: EndpointLineContext): void {
  const { line, state } = context;
  if (state.springClassPrefix !== undefined) {
    state.springClassBraceDepth += braceDelta(line);
    if (state.springClassBraceDepth <= 0 && line.includes("}")) {
      state.springClassPrefix = undefined;
      state.springClassBraceDepth = 0;
    }
  }
  if (state.insideSpringClass) {
    state.springAnyClassBraceDepth += braceDelta(line);
    if (state.springAnyClassBraceDepth <= 0 && line.includes("}")) {
      state.insideSpringClass = false;
      state.springAnyClassBraceDepth = 0;
      state.pendingSpringClassPrefix = undefined;
    }
  }
}

function updateDotNetEndpointScope(context: EndpointLineContext): void {
  const { line, state } = context;
  if (state.dotNetClassPrefix !== undefined) {
    state.dotNetClassBraceDepth += braceDelta(line);
    if (state.dotNetClassBraceDepth <= 0 && line.includes("}")) {
      state.dotNetClassPrefix = undefined;
      state.dotNetClassName = undefined;
      state.pendingDotNetMethod = undefined;
      state.pendingDotNetMethodRoute = undefined;
      state.dotNetClassBraceDepth = 0;
    }
  }
}

function updateNestEndpointScope(context: EndpointLineContext): void {
  const { line, state } = context;
  if (state.nestClassPrefix !== undefined) {
    state.nestClassBraceDepth += braceDelta(line);
    if (state.nestClassBraceDepth <= 0 && line.includes("}")) {
      state.nestClassPrefix = undefined;
      state.nestClassBraceDepth = 0;
    }
  }
}

function updateEndpointClassScopes(context: EndpointLineContext): void {
  updateSpringEndpointScopes(context);
  updateDotNetEndpointScope(context);
  updateNestEndpointScope(context);
}

function collectEndpointLine(context: EndpointLineContext): void {
  detectEndpointClassDeclarations(context);
  collectDotNetLineEndpoints(context);
  collectSpringLineEndpoints(context);
  collectNestLineEndpoints(context);
  collectExpressLineEndpoints(context);
  collectPythonLineEndpoints(context);
  collectGoLineEndpoints(context);
  collectRtkLineEndpoints(context);
  collectAxiosLineEndpoints(context);
  updateEndpointClassScopes(context);
}

function collectEndpoints(file: SourceFile): readonly ApiEndpoint[] {
  if (file.language === "openapi") {
    return collectOpenApiEndpoints(file);
  }
  if (file.language === "graphql") {
    return collectGraphqlDocumentEndpoints(file);
  }
  if (file.language === "protobuf") {
    return collectProtobufServiceEndpoints(file);
  }
  const scan = maskEndpointCommentOrDocstringText(file.text, file.language);
  const endpoints: ApiEndpoint[] = [];
  endpoints.push(...collectGraphqlClientEndpoints(file, scan));
  endpoints.push(...collectProtobufClientEndpoints(file, scan));
  endpoints.push(...collectFetchClientEndpoints(file, scan));
  const state = createEndpointCollectionState();
  const hasRtkQueryApi =
    /\bcreateApi\s*\(/u.test(scan.text) || /\bbuilder\.(?:query|mutation)\b/u.test(scan.text);
  const axiosBasePaths = collectAxiosBasePaths(scan);
  const expressRouterMounts = collectExpressRouterMounts(scan);
  const pythonRoutePrefixes = collectPythonRoutePrefixes(scan);
  scan.lines.forEach((line, index) => {
    collectEndpointLine({
      file,
      scan,
      endpoints,
      state,
      line,
      lineNo: index + 1,
      lineOffset: scan.lineOffsets[index] ?? 0,
      hasRtkQueryApi,
      axiosBasePaths,
      expressRouterMounts,
      pythonRoutePrefixes,
    });
  });
  return endpoints;
}

function linkApiContracts(endpoints: readonly ApiEndpoint[]): readonly ApiContractEdge[] {
  const servers = endpoints.filter((endpoint) => endpoint.role === "server");
  const clients = endpoints.filter((endpoint) => endpoint.role === "client");
  const edges: ApiContractEdge[] = [];
  for (const client of clients) {
    for (const server of servers) {
      const methodMatches =
        client.method === "ANY" || server.method === "ANY" || client.method === server.method;
      if (methodMatches && client.path === server.path) {
        edges.push({
          client,
          server,
          confidence: client.method === server.method ? "resolved" : "heuristic",
        });
      }
    }
  }
  return edges;
}

function normalizedDtoName(name: string): string {
  return name.toLowerCase().replace(/(?:dto|model|request|response|record)$/u, "");
}

function normalizedDtoFieldName(name: string): string {
  return name.replace(/[_-]/gu, "").toLowerCase();
}

function sharedDtoFields(
  sourceFields: readonly string[],
  targetFields: readonly string[],
): readonly string[] {
  const targetNormalized = new Set(targetFields.map(normalizedDtoFieldName));
  const seen = new Set<string>();
  const shared: string[] = [];
  for (const field of sourceFields) {
    const normalized = normalizedDtoFieldName(field);
    if (targetNormalized.has(normalized) && !seen.has(normalized)) {
      shared.push(field);
      seen.add(normalized);
    }
  }
  return shared;
}

function linkDtoContracts(symbols: readonly CodeSymbol[]): readonly DtoContractEdge[] {
  const typed = symbols.filter((symbol) => symbol.fields.length > 0);
  const edges: DtoContractEdge[] = [];
  for (let i = 0; i < typed.length; i += 1) {
    for (let j = i + 1; j < typed.length; j += 1) {
      const a = typed[i];
      const b = typed[j];
      if (
        a === undefined ||
        b === undefined ||
        a.scopePath === b.scopePath ||
        a.language === b.language
      ) {
        continue;
      }
      const sharedFields = sharedDtoFields(a.fields, b.fields);
      const nameMatch = normalizedDtoName(a.name) === normalizedDtoName(b.name);
      if (nameMatch || sharedFields.length >= 2) {
        edges.push({
          source: a,
          target: b,
          sharedFields,
          confidence: nameMatch ? "resolved" : "heuristic",
        });
      }
    }
  }
  return edges;
}

function cacheFingerprintFor(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  candidates: readonly { readonly relativePath: string; readonly sizeBytes: number }[],
): string {
  const entries = candidates.map((candidate) => {
    const abs = resolveWithinWorkspace(scope.workspace.root, candidate.relativePath);
    let mtime: string;
    try {
      mtime = String(fs.stat(abs).mtimeMs ?? "");
    } catch {
      mtime = "";
    }
    let ctime: string;
    try {
      ctime = String(fs.stat(abs).ctimeMs ?? "");
    } catch {
      ctime = "";
    }
    return `${candidate.relativePath}:${String(candidate.sizeBytes)}:${mtime}:${ctime}`;
  });
  return JSON.stringify({
    root: scope.workspace.root,
    scope: scope.relativePaths,
    maxFilesScanned: limits.maxFilesScanned,
    maxBytesPerFileScanned: limits.maxBytesPerFileScanned,
    codeIndexMaxSourceBytes: CODE_INDEX_MAX_SOURCE_BYTES,
    files: entries,
  });
}

function memoryCacheKeyFor(fingerprint: string, fs: WorkspaceFs): string {
  return `${String(cacheIdForFs(fs))}:${fingerprint}`;
}

function rememberIndex(cacheKey: string, index: CodeIntelligenceIndex): void {
  indexCache.set(cacheKey, index);
  if (indexCache.size <= INDEX_CACHE_LIMIT) {
    return;
  }
  const oldest = indexCache.keys().next().value;
  if (typeof oldest === "string") {
    indexCache.delete(oldest);
  }
}

type PersistentWorkspaceFs = WorkspaceFs & Required<Pick<WorkspaceFs, "makeDir" | "writeFileUtf8">>;

function hasPersistentWorkspaceState(fs: WorkspaceFs): fs is PersistentWorkspaceFs {
  return fs.makeDir !== undefined && fs.writeFileUtf8 !== undefined;
}

function persistentCacheId(fingerprint: string): string {
  return createHash("sha256").update(fingerprint).digest("hex");
}

function persistentCachePath(scope: SearchScope, fingerprint: string): string {
  return resolveWithinWorkspace(
    scope.workspace.root,
    `${PERSISTENT_CACHE_DIR}/${persistentCacheId(fingerprint)}.json`,
  );
}

function persistentCacheDir(scope: SearchScope): string {
  return resolveWithinWorkspace(scope.workspace.root, PERSISTENT_CACHE_DIR);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isParserKind(value: unknown): value is CodeParserKind {
  return value === "typescript-compiler-ast" || value === "polyglot-regex";
}

function isLineRange(value: unknown): value is LineRange {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.startLine === "number" &&
    Number.isInteger(value.startLine) &&
    typeof value.endLine === "number" &&
    Number.isInteger(value.endLine)
  );
}

function isImportEdge(value: unknown): value is CodeImportEdge {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.kind === "import" || value.kind === "export") &&
    typeof value.importerPath === "string" &&
    typeof value.importerLine === "number" &&
    typeof value.specifier === "string" &&
    (value.targetPath === undefined || typeof value.targetPath === "string") &&
    (value.confidence === "resolved" || value.confidence === "heuristic") &&
    typeof value.language === "string" &&
    isParserKind(value.parser)
  );
}

function isCodeSymbol(value: unknown): value is CodeSymbol {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.name === "string" &&
    typeof value.kind === "string" &&
    typeof value.scopePath === "string" &&
    typeof value.language === "string" &&
    isLineRange(value.lineRange) &&
    isStringArray(value.fields) &&
    isParserKind(value.parser)
  );
}

function isCallEdge(value: unknown): value is CodeCallEdge {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.callerPath === "string" &&
    typeof value.callerLine === "number" &&
    typeof value.calleeName === "string" &&
    typeof value.targetName === "string" &&
    typeof value.targetPath === "string" &&
    isLineRange(value.targetLineRange) &&
    (value.confidence === "resolved" || value.confidence === "heuristic") &&
    isParserKind(value.parser)
  );
}

function isReferenceEdge(value: unknown): value is CodeReferenceEdge {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.referencerPath === "string" &&
    isLineRange(value.referenceLineRange) &&
    typeof value.referenceName === "string" &&
    typeof value.targetName === "string" &&
    typeof value.targetPath === "string" &&
    isLineRange(value.targetLineRange) &&
    (value.confidence === "resolved" || value.confidence === "heuristic") &&
    isParserKind(value.parser)
  );
}

function isApiEndpoint(value: unknown): value is ApiEndpoint {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.role === "server" || value.role === "client") &&
    typeof value.method === "string" &&
    typeof value.path === "string" &&
    typeof value.scopePath === "string" &&
    isLineRange(value.lineRange) &&
    typeof value.language === "string" &&
    isParserKind(value.parser)
  );
}

function isParserCoverage(value: unknown): value is CodeParserCoverage {
  if (!isRecord(value)) {
    return false;
  }
  return isParserKind(value.parser) && typeof value.filesIndexed === "number";
}

function isApiContractEdge(value: unknown): value is ApiContractEdge {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isApiEndpoint(value.client) &&
    isApiEndpoint(value.server) &&
    (value.confidence === "resolved" || value.confidence === "heuristic")
  );
}

function isDtoContractEdge(value: unknown): value is DtoContractEdge {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isCodeSymbol(value.source) &&
    isCodeSymbol(value.target) &&
    isStringArray(value.sharedFields) &&
    (value.confidence === "resolved" || value.confidence === "heuristic")
  );
}

function isPackageDependencyKind(value: unknown): value is PackageDependencyKind {
  return (
    value === "dependencies" ||
    value === "devDependencies" ||
    value === "peerDependencies" ||
    value === "optionalDependencies"
  );
}

function isPackageDependencyEdge(value: unknown): value is PackageDependencyEdge {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.sourcePackage === "string" &&
    typeof value.sourcePath === "string" &&
    typeof value.targetPackage === "string" &&
    typeof value.targetPath === "string" &&
    isPackageDependencyKind(value.dependencyKind) &&
    (value.confidence === "resolved" || value.confidence === "heuristic")
  );
}

function isArrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is readonly T[] {
  return Array.isArray(value) && value.every((item) => guard(item));
}

function isCodeIntelligenceIndex(value: unknown): value is CodeIntelligenceIndex {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isArrayOf(value.imports, isImportEdge) &&
    isArrayOf(value.symbols, isCodeSymbol) &&
    isArrayOf(value.calls, isCallEdge) &&
    isArrayOf(value.references, isReferenceEdge) &&
    isArrayOf(value.endpoints, isApiEndpoint) &&
    isArrayOf(value.apiContracts, isApiContractEdge) &&
    isArrayOf(value.dtoContracts, isDtoContractEdge) &&
    isArrayOf(value.packageDependencies, isPackageDependencyEdge) &&
    typeof value.filesIndexed === "number" &&
    typeof value.filesSkipped === "number" &&
    typeof value.filesPartiallyIndexed === "number" &&
    isArrayOf(value.parserCoverage, isParserCoverage)
  );
}

function readPersistentIndex(
  scope: SearchScope,
  fs: WorkspaceFs,
  fingerprint: string,
): CodeIntelligenceIndex | undefined {
  if (!hasPersistentWorkspaceState(fs)) {
    return undefined;
  }
  try {
    const cacheFile = assertContainedRealPath(
      fs,
      scope.workspace.root,
      persistentCachePath(scope, fingerprint),
      "code-intelligence cache file",
    );
    if (!fs.exists(cacheFile)) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(fs.readFileUtf8(cacheFile));
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== PERSISTENT_CACHE_SCHEMA_VERSION ||
      parsed.fingerprint !== fingerprint ||
      !isCodeIntelligenceIndex(parsed.index)
    ) {
      return undefined;
    }
    return parsed.index;
  } catch {
    return undefined;
  }
}

function writePersistentIndex(
  scope: SearchScope,
  fs: WorkspaceFs,
  fingerprint: string,
  index: CodeIntelligenceIndex,
): void {
  if (!hasPersistentWorkspaceState(fs)) {
    return;
  }
  try {
    const cacheDir = assertContainedRealPath(
      fs,
      scope.workspace.root,
      persistentCacheDir(scope),
      "code-intelligence cache directory",
    );
    fs.makeDir(cacheDir);
    const cacheFile = assertContainedRealPath(
      fs,
      scope.workspace.root,
      persistentCachePath(scope, fingerprint),
      "code-intelligence cache file",
    );
    fs.writeFileUtf8(
      cacheFile,
      JSON.stringify({
        schemaVersion: PERSISTENT_CACHE_SCHEMA_VERSION,
        fingerprint,
        index,
      }),
    );
  } catch {
    // Cache writes are an optimization; retrieval must keep working on read-only workspaces.
  }
}

function sourceReadCap(limits: SearchLimits): number {
  return Math.max(limits.maxBytesPerFileScanned, CODE_INDEX_MAX_SOURCE_BYTES);
}

function sourceText(
  scopePath: string,
  text: string,
  language: CodeLanguage,
  partial: boolean,
): SourceText {
  return { scopePath, text, language, partial };
}

function readOversizedSourcePrefix(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  relativePath: string,
  language: CodeLanguage,
): SourceText | undefined {
  const readPrefix = fs.readFileUtf8Prefix;
  if (readPrefix === undefined) {
    return undefined;
  }
  const absolutePath = resolveWithinWorkspace(scope.workspace.root, relativePath);
  try {
    const containedPath = assertContainedRealPath(
      fs,
      scope.workspace.root,
      absolutePath,
      "code-intelligence source prefix",
    );
    const text = redact(readPrefix(containedPath, sourceReadCap(limits)));
    return text.length === 0 ? undefined : sourceText(relativePath, text, language, true);
  } catch {
    return undefined;
  }
}

function readSource(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  relativePath: string,
  language: CodeLanguage,
): SourceText {
  try {
    const content = readWorkspaceFile(
      scope.workspace,
      relativePath,
      { maxBytes: sourceReadCap(limits) },
      fs,
    );
    return sourceText(relativePath, content.text, language, false);
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      const partial = readOversizedSourcePrefix(scope, limits, fs, relativePath, language);
      if (partial !== undefined) {
        return partial;
      }
    }
    throw error;
  }
}

function readSources(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  candidates: readonly { readonly relativePath: string }[],
): { files: readonly SourceFile[]; skipped: number; partiallyIndexed: number } {
  const files: SourceFile[] = [];
  let skipped = 0;
  let partiallyIndexed = 0;
  for (const candidate of candidates) {
    if (!isIndexable(candidate.relativePath)) {
      continue;
    }
    const language = languageForPath(candidate.relativePath);
    if (language === undefined) {
      continue;
    }
    try {
      const source = readSource(scope, limits, fs, candidate.relativePath, language);
      if (source.partial) {
        partiallyIndexed += 1;
      }
      const parser = parserKindForSource(source.scopePath, source.language);
      files.push({
        scopePath: source.scopePath,
        text: source.text,
        language: source.language,
        parser,
        syntaxTree:
          parser === "typescript-compiler-ast" ? parseTypescriptSource(source) : undefined,
      });
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        skipped += 1;
        continue;
      }
      skipped += 1;
    }
  }
  return { files, skipped, partiallyIndexed };
}

function collectParserCoverage(files: readonly SourceFile[]): readonly CodeParserCoverage[] {
  const counts = new Map<CodeParserKind, number>();
  for (const file of files) {
    counts.set(file.parser, (counts.get(file.parser) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([parser, filesIndexed]) => ({ parser, filesIndexed }));
}

export function buildCodeIntelligenceIndex(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  deps?: BuildDeps,
): CodeIntelligenceIndex {
  const candidates = gatherCandidates(scope, limits, fs).files;
  const fingerprint = cacheFingerprintFor(scope, limits, fs, candidates);
  const cacheKey = memoryCacheKeyFor(fingerprint, fs);
  if (deps?.disableCache !== true) {
    const cached = indexCache.get(cacheKey);
    if (cached !== undefined) {
      indexCache.delete(cacheKey);
      indexCache.set(cacheKey, cached);
      return cached;
    }
    const persisted = readPersistentIndex(scope, fs, fingerprint);
    if (persisted !== undefined) {
      rememberIndex(cacheKey, persisted);
      return persisted;
    }
  }
  const { files, skipped, partiallyIndexed } = readSources(scope, limits, fs, candidates);
  const pathSet = new Set(files.map((file) => file.scopePath));
  const importResolver = collectTsImportResolverConfig(scope, fs, candidates);
  const packageDependencies = linkPackageDependencies(importResolver.packages);
  const imports = files.flatMap((file) => collectImportEdges(file, pathSet, importResolver));
  const symbols = files.flatMap((file) => collectSymbols(file));
  const reExports = files.flatMap((file) => collectTypescriptReExportBindings(file, imports));
  const defaultExports = files.flatMap((file) => collectTypescriptDefaultExports(file));
  const reExportResolver = buildTypescriptReExportResolverContext(
    reExports,
    defaultExports,
    symbols,
  );
  const importBindings = files.flatMap((file) =>
    file.syntaxTree === undefined
      ? collectPolyglotImportBindings(file, imports)
      : collectTypescriptImportBindings(file, imports, reExportResolver),
  );
  const calls = collectCalls(files, symbols, imports, importBindings);
  const references = collectReferences(files, symbols, importBindings);
  const endpoints = files.flatMap((file) => collectEndpoints(file));
  const apiContracts = linkApiContracts(endpoints);
  const dtoContracts = linkDtoContracts(symbols);
  const index: CodeIntelligenceIndex = {
    imports,
    symbols,
    calls,
    references,
    endpoints,
    apiContracts,
    dtoContracts,
    packageDependencies,
    filesIndexed: files.length,
    filesSkipped: skipped,
    filesPartiallyIndexed: partiallyIndexed,
    parserCoverage: collectParserCoverage(files),
  };
  if (deps?.disableCache !== true) {
    rememberIndex(cacheKey, index);
    writePersistentIndex(scope, fs, fingerprint, index);
  }
  return index;
}

function queryTerms(query: RetrievalQuery): readonly string[] {
  if (query.kind === "exact-symbol") {
    return [query.caseSensitive ? query.text : query.text.toLowerCase()];
  }
  return expandedQueryTerms(query.text, query.caseSensitive).filter(
    (term) => !STRUCTURAL_NL_STOP_TERMS.has(term.toLowerCase()),
  );
}

const STRUCTURAL_NL_STOP_TERMS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

function structuralTextTokenSet(haystack: string, caseSensitive: boolean): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const rawToken of haystack.split(/[^A-Za-z0-9_$@]+/u)) {
    if (rawToken.length === 0) {
      continue;
    }
    tokens.add(caseSensitive ? rawToken : rawToken.toLowerCase());
    for (const part of rawToken.split(/(?<=[a-z0-9])(?=[A-Z])/u)) {
      if (part.length > 0) {
        tokens.add(caseSensitive ? part : part.toLowerCase());
      }
    }
  }
  return tokens;
}

function looksStructuralPathTerm(term: string): boolean {
  return /[./:@_-]/u.test(term);
}

function includesAny(haystack: string, terms: readonly string[], query: RetrievalQuery): boolean {
  const value = query.caseSensitive ? haystack : haystack.toLowerCase();
  if (query.kind === "exact-symbol") {
    return terms.some((term) => value.includes(term));
  }
  const tokens = structuralTextTokenSet(haystack, query.caseSensitive);
  return terms.some((term) => {
    const normalizedTerm = query.caseSensitive ? term : term.toLowerCase();
    return looksStructuralPathTerm(normalizedTerm)
      ? value.includes(normalizedTerm)
      : tokens.has(normalizedTerm);
  });
}

function edgeEndpoint(
  scopePath: string,
  lineRangeValue: LineRange | undefined,
  symbol?: string,
): EvidenceEdge["source"] {
  return {
    scopePath,
    lineRange: lineRangeValue,
    symbol,
  };
}

function buildEdgeAtom(inputs: {
  readonly scopeId: string;
  readonly scopePath: string;
  readonly lineRange: LineRange | undefined;
  readonly query: RetrievalQuery;
  readonly nowMs: number;
  readonly score: number;
  readonly edge: EvidenceEdge;
}): EvidenceAtom {
  return buildAtom({
    scopeId: inputs.scopeId,
    scopePath: inputs.scopePath,
    lineRange: inputs.lineRange,
    provenanceKind: "structural",
    tool: "code-intelligence-index",
    queryFingerprint: queryFingerprint(inputs.query),
    edge: inputs.edge,
    score: inputs.score,
    emittedAtMs: inputs.nowMs,
  });
}

function importEdgeScore(query: RetrievalQuery, item: CodeImportEdge): number {
  const exactMatch =
    query.kind === "exact-symbol" &&
    (query.caseSensitive
      ? item.specifier === query.text
      : item.specifier.toLowerCase() === query.text.toLowerCase());
  return exactMatch ? 1.0 : item.confidence === "resolved" ? 0.95 : 0.7;
}

function importEdgeAtom(
  scope: SearchScope,
  query: RetrievalQuery,
  nowMs: number,
  item: CodeImportEdge,
  score = importEdgeScore(query, item),
): EvidenceAtom {
  const targetPath = item.targetPath ?? item.importerPath;
  const kind: EvidenceEdgeKind = item.kind;
  return buildEdgeAtom({
    scopeId: scope.scopeId,
    scopePath: item.importerPath,
    lineRange: lineRange(item.importerLine),
    query,
    nowMs,
    score,
    edge: {
      kind,
      source: edgeEndpoint(item.importerPath, lineRange(item.importerLine)),
      target: edgeEndpoint(targetPath, undefined, item.specifier),
      label: item.specifier,
      confidence: item.confidence,
    },
  });
}

function symbolScore(): number {
  return 0.86;
}

function symbolAtom(
  scope: SearchScope,
  query: RetrievalQuery,
  nowMs: number,
  item: CodeSymbol,
  score = symbolScore(),
): EvidenceAtom {
  return buildEdgeAtom({
    scopeId: scope.scopeId,
    scopePath: item.scopePath,
    lineRange: item.lineRange,
    query,
    nowMs,
    score,
    edge: {
      kind: "definition",
      source: edgeEndpoint(item.scopePath, item.lineRange, item.name),
      target: edgeEndpoint(item.scopePath, item.lineRange, item.name),
      label: `${item.kind}:${item.name}`,
      confidence: "resolved",
    },
  });
}

function callScore(item: CodeCallEdge): number {
  return item.confidence === "resolved" ? 0.9 : 0.74;
}

function callAtom(
  scope: SearchScope,
  query: RetrievalQuery,
  nowMs: number,
  item: CodeCallEdge,
  score = callScore(item),
): EvidenceAtom {
  return buildEdgeAtom({
    scopeId: scope.scopeId,
    scopePath: item.callerPath,
    lineRange: lineRange(item.callerLine),
    query,
    nowMs,
    score,
    edge: {
      kind: "call",
      source: edgeEndpoint(item.callerPath, lineRange(item.callerLine)),
      target: edgeEndpoint(item.targetPath, item.targetLineRange, item.targetName),
      label:
        item.calleeName === item.targetName
          ? item.targetName
          : `${item.calleeName}->${item.targetName}`,
      confidence: item.confidence,
    },
  });
}

function referenceScore(item: CodeReferenceEdge): number {
  return item.confidence === "resolved" ? 0.88 : 0.72;
}

function referenceAtom(
  scope: SearchScope,
  query: RetrievalQuery,
  nowMs: number,
  item: CodeReferenceEdge,
  score = referenceScore(item),
): EvidenceAtom {
  return buildEdgeAtom({
    scopeId: scope.scopeId,
    scopePath: item.referencerPath,
    lineRange: item.referenceLineRange,
    query,
    nowMs,
    score,
    edge: {
      kind: "reference",
      source: edgeEndpoint(item.referencerPath, item.referenceLineRange, item.referenceName),
      target: edgeEndpoint(item.targetPath, item.targetLineRange, item.targetName),
      label:
        item.referenceName === item.targetName
          ? item.targetName
          : `${item.referenceName}->${item.targetName}`,
      confidence: item.confidence,
    },
  });
}

function apiContractScore(item: ApiContractEdge): number {
  return item.confidence === "resolved" ? 0.98 : 0.83;
}

function apiContractAtom(
  scope: SearchScope,
  query: RetrievalQuery,
  nowMs: number,
  item: ApiContractEdge,
  score = apiContractScore(item),
): EvidenceAtom {
  return buildEdgeAtom({
    scopeId: scope.scopeId,
    scopePath: item.client.scopePath,
    lineRange: item.client.lineRange,
    query,
    nowMs,
    score,
    edge: {
      kind: "api-contract",
      source: edgeEndpoint(
        item.client.scopePath,
        item.client.lineRange,
        `${item.client.method} ${item.client.path}`,
      ),
      target: edgeEndpoint(
        item.server.scopePath,
        item.server.lineRange,
        `${item.server.method} ${item.server.path}`,
      ),
      label: `${item.client.method} ${item.client.path}`,
      confidence: item.confidence,
    },
  });
}

function dtoContractScore(item: DtoContractEdge): number {
  return item.confidence === "resolved" ? 0.88 : 0.76;
}

function dtoContractAtom(
  scope: SearchScope,
  query: RetrievalQuery,
  nowMs: number,
  item: DtoContractEdge,
  score = dtoContractScore(item),
): EvidenceAtom {
  return buildEdgeAtom({
    scopeId: scope.scopeId,
    scopePath: item.source.scopePath,
    lineRange: item.source.lineRange,
    query,
    nowMs,
    score,
    edge: {
      kind: "dto-contract",
      source: edgeEndpoint(item.source.scopePath, item.source.lineRange, item.source.name),
      target: edgeEndpoint(item.target.scopePath, item.target.lineRange, item.target.name),
      label: item.sharedFields.length > 0 ? item.sharedFields.join(",") : item.source.name,
      confidence: item.confidence,
    },
  });
}

function packageDependencyScore(item: PackageDependencyEdge): number {
  return item.confidence === "resolved" ? 0.9 : 0.72;
}

function packageDependencyAtom(
  scope: SearchScope,
  query: RetrievalQuery,
  nowMs: number,
  item: PackageDependencyEdge,
  score = packageDependencyScore(item),
): EvidenceAtom {
  return buildEdgeAtom({
    scopeId: scope.scopeId,
    scopePath: item.sourcePath,
    lineRange: undefined,
    query,
    nowMs,
    score,
    edge: {
      kind: "package-dependency",
      source: edgeEndpoint(item.sourcePath, undefined, item.sourcePackage),
      target: edgeEndpoint(item.targetPath, undefined, item.targetPackage),
      label: `${item.sourcePackage} -> ${item.targetPackage} (${item.dependencyKind})`,
      confidence: item.confidence,
    },
  });
}

interface GraphSeed {
  readonly scopePath: string;
  readonly symbol?: string | undefined;
  readonly depth: number;
  readonly score: number;
}

function compareEvidenceAtoms(a: EvidenceAtom, b: EvidenceAtom): number {
  return (
    b.score - a.score ||
    a.scopePath.localeCompare(b.scopePath) ||
    a.stableId.localeCompare(b.stableId)
  );
}

function graphSeedKey(scopePath: string, symbol: string | undefined): string {
  return `${scopePath}\0${symbol ?? ""}`;
}

function isIdentifierSymbol(symbol: string): boolean {
  return /^[A-Za-z_$][\w$]*$/u.test(symbol);
}

function pushGraphSeed(
  queue: GraphSeed[],
  seen: Set<string>,
  scopePath: string,
  symbol: string | undefined,
  depth: number,
  score: number,
): void {
  if (depth > GRAPH_NEIGHBOR_DEPTH_LIMIT) {
    return;
  }
  const key = graphSeedKey(scopePath, symbol);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  queue.push(
    symbol === undefined ? { scopePath, depth, score } : { scopePath, symbol, depth, score },
  );
}

function pushEndpointGraphSeeds(
  queue: GraphSeed[],
  seen: Set<string>,
  endpoint: EvidenceEdgeEndpoint,
  depth: number,
  score: number,
): void {
  pushGraphSeed(queue, seen, endpoint.scopePath, undefined, depth, score);
  if (endpoint.symbol !== undefined && isIdentifierSymbol(endpoint.symbol)) {
    pushGraphSeed(queue, seen, endpoint.scopePath, endpoint.symbol, depth, score);
  }
}

function graphNeighborScore(seed: GraphSeed, defaultScore: number): number {
  return Math.max(0.01, Math.min(defaultScore, seed.score * GRAPH_NEIGHBOR_SCORE_DECAY));
}

function seedMatchesSymbol(seed: GraphSeed, scopePath: string, symbol: string): boolean {
  return seed.scopePath === scopePath && (seed.symbol === undefined || seed.symbol === symbol);
}

function seedMatchesEndpoint(seed: GraphSeed, endpoint: EvidenceEdgeEndpoint): boolean {
  return (
    seed.scopePath === endpoint.scopePath &&
    (seed.symbol === undefined || endpoint.symbol === seed.symbol)
  );
}

function seedMatchesImport(seed: GraphSeed, edge: CodeImportEdge): boolean {
  return (
    seed.scopePath === edge.importerPath ||
    seed.scopePath === edge.targetPath ||
    (seed.symbol !== undefined && seed.symbol === edge.specifier)
  );
}

function seedMatchesCall(seed: GraphSeed, edge: CodeCallEdge): boolean {
  return (
    seedMatchesSymbol(seed, edge.callerPath, edge.calleeName) ||
    seedMatchesSymbol(seed, edge.targetPath, edge.targetName)
  );
}

function seedMatchesReference(seed: GraphSeed, edge: CodeReferenceEdge): boolean {
  return (
    seedMatchesSymbol(seed, edge.referencerPath, edge.referenceName) ||
    seedMatchesSymbol(seed, edge.targetPath, edge.targetName)
  );
}

function seedMatchesApiContract(seed: GraphSeed, edge: ApiContractEdge): boolean {
  return (
    seedMatchesEndpoint(
      seed,
      edgeEndpoint(
        edge.client.scopePath,
        edge.client.lineRange,
        `${edge.client.method} ${edge.client.path}`,
      ),
    ) ||
    seedMatchesEndpoint(
      seed,
      edgeEndpoint(
        edge.server.scopePath,
        edge.server.lineRange,
        `${edge.server.method} ${edge.server.path}`,
      ),
    )
  );
}

function seedMatchesDtoContract(seed: GraphSeed, edge: DtoContractEdge): boolean {
  return (
    seedMatchesSymbol(seed, edge.source.scopePath, edge.source.name) ||
    seedMatchesSymbol(seed, edge.target.scopePath, edge.target.name)
  );
}

function seedMatchesPackageDependency(seed: GraphSeed, edge: PackageDependencyEdge): boolean {
  return (
    seedMatchesSymbol(seed, edge.sourcePath, edge.sourcePackage) ||
    seedMatchesSymbol(seed, edge.targetPath, edge.targetPackage)
  );
}

interface GraphExpansionContext {
  readonly scope: SearchScope;
  readonly query: RetrievalQuery;
  readonly nowMs: number;
  readonly index: CodeIntelligenceIndex;
  readonly expanded: EvidenceAtom[];
  readonly seenAtoms: Set<string>;
  readonly queue: GraphSeed[];
  readonly seenSeeds: Set<string>;
}

function graphSeedQueue(directAtoms: readonly EvidenceAtom[], seenSeeds: Set<string>): GraphSeed[] {
  const queue: GraphSeed[] = [];
  const seedAtoms = [...directAtoms]
    .sort(compareEvidenceAtoms)
    .slice(0, GRAPH_NEIGHBOR_SEED_ATOM_LIMIT);
  for (const atom of seedAtoms) {
    if (atom.edge === undefined) {
      pushGraphSeed(queue, seenSeeds, atom.scopePath, undefined, 1, atom.score);
    } else if (atom.edge.kind === "import" || atom.edge.kind === "export") {
      if (atom.edge.target.scopePath !== atom.edge.source.scopePath) {
        pushEndpointGraphSeeds(queue, seenSeeds, atom.edge.target, 1, atom.score);
      }
    } else {
      pushEndpointGraphSeeds(queue, seenSeeds, atom.edge.source, 1, atom.score);
      pushEndpointGraphSeeds(queue, seenSeeds, atom.edge.target, 1, atom.score);
    }
  }
  return queue;
}

function pushGraphNeighbor(
  context: GraphExpansionContext,
  atom: EvidenceAtom,
  nextDepth: number,
): void {
  if (
    context.expanded.length >= GRAPH_NEIGHBOR_ATOM_LIMIT ||
    context.seenAtoms.has(atom.stableId)
  ) {
    return;
  }
  context.seenAtoms.add(atom.stableId);
  context.expanded.push(atom);
  if (atom.edge !== undefined) {
    pushEndpointGraphSeeds(
      context.queue,
      context.seenSeeds,
      atom.edge.source,
      nextDepth,
      atom.score,
    );
    pushEndpointGraphSeeds(
      context.queue,
      context.seenSeeds,
      atom.edge.target,
      nextDepth,
      atom.score,
    );
  }
}

function expandImportNeighbors(
  context: GraphExpansionContext,
  seed: GraphSeed,
  nextDepth: number,
): void {
  for (const item of context.index.imports) {
    if (item.targetPath === undefined || !seedMatchesImport(seed, item)) continue;
    pushGraphNeighbor(
      context,
      importEdgeAtom(
        context.scope,
        context.query,
        context.nowMs,
        item,
        graphNeighborScore(seed, importEdgeScore(context.query, item)),
      ),
      nextDepth,
    );
  }
}

function expandSymbolNeighbors(
  context: GraphExpansionContext,
  seed: GraphSeed,
  nextDepth: number,
): void {
  for (const item of context.index.symbols) {
    if (!seedMatchesSymbol(seed, item.scopePath, item.name)) continue;
    pushGraphNeighbor(
      context,
      symbolAtom(
        context.scope,
        context.query,
        context.nowMs,
        item,
        graphNeighborScore(seed, symbolScore()),
      ),
      nextDepth,
    );
  }
}

function expandCallNeighbors(
  context: GraphExpansionContext,
  seed: GraphSeed,
  nextDepth: number,
): void {
  for (const item of context.index.calls) {
    if (!seedMatchesCall(seed, item)) continue;
    pushGraphNeighbor(
      context,
      callAtom(
        context.scope,
        context.query,
        context.nowMs,
        item,
        graphNeighborScore(seed, callScore(item)),
      ),
      nextDepth,
    );
  }
}

function expandReferenceNeighbors(
  context: GraphExpansionContext,
  seed: GraphSeed,
  nextDepth: number,
): void {
  for (const item of context.index.references) {
    if (!seedMatchesReference(seed, item)) continue;
    pushGraphNeighbor(
      context,
      referenceAtom(
        context.scope,
        context.query,
        context.nowMs,
        item,
        graphNeighborScore(seed, referenceScore(item)),
      ),
      nextDepth,
    );
  }
}

function expandApiContractNeighbors(
  context: GraphExpansionContext,
  seed: GraphSeed,
  nextDepth: number,
): void {
  for (const item of context.index.apiContracts) {
    if (!seedMatchesApiContract(seed, item)) continue;
    pushGraphNeighbor(
      context,
      apiContractAtom(
        context.scope,
        context.query,
        context.nowMs,
        item,
        graphNeighborScore(seed, apiContractScore(item)),
      ),
      nextDepth,
    );
  }
}

function expandDtoContractNeighbors(
  context: GraphExpansionContext,
  seed: GraphSeed,
  nextDepth: number,
): void {
  for (const item of context.index.dtoContracts) {
    if (!seedMatchesDtoContract(seed, item)) continue;
    pushGraphNeighbor(
      context,
      dtoContractAtom(
        context.scope,
        context.query,
        context.nowMs,
        item,
        graphNeighborScore(seed, dtoContractScore(item)),
      ),
      nextDepth,
    );
  }
}

function expandPackageDependencyNeighbors(
  context: GraphExpansionContext,
  seed: GraphSeed,
  nextDepth: number,
): void {
  for (const item of context.index.packageDependencies) {
    if (!seedMatchesPackageDependency(seed, item)) continue;
    pushGraphNeighbor(
      context,
      packageDependencyAtom(
        context.scope,
        context.query,
        context.nowMs,
        item,
        graphNeighborScore(seed, packageDependencyScore(item)),
      ),
      nextDepth,
    );
  }
}

function expandGraphSeed(context: GraphExpansionContext, seed: GraphSeed): void {
  const nextDepth = seed.depth + 1;
  expandImportNeighbors(context, seed, nextDepth);
  expandSymbolNeighbors(context, seed, nextDepth);
  expandCallNeighbors(context, seed, nextDepth);
  expandReferenceNeighbors(context, seed, nextDepth);
  expandApiContractNeighbors(context, seed, nextDepth);
  expandDtoContractNeighbors(context, seed, nextDepth);
  expandPackageDependencyNeighbors(context, seed, nextDepth);
}

function expandGraphNeighborhood(
  scope: SearchScope,
  query: RetrievalQuery,
  nowMs: number,
  index: CodeIntelligenceIndex,
  directAtoms: readonly EvidenceAtom[],
): readonly EvidenceAtom[] {
  const expanded: EvidenceAtom[] = [];
  const seenAtoms = new Set(directAtoms.map((atom) => atom.stableId));
  const seenSeeds = new Set<string>();
  const queue = graphSeedQueue(directAtoms, seenSeeds);
  const context = { scope, query, nowMs, index, expanded, seenAtoms, queue, seenSeeds };
  let cursor = 0;
  while (cursor < queue.length && expanded.length < GRAPH_NEIGHBOR_ATOM_LIMIT) {
    const seed = queue[cursor];
    cursor += 1;
    if (seed === undefined || seed.depth > GRAPH_NEIGHBOR_DEPTH_LIMIT) continue;
    expandGraphSeed(context, seed);
  }
  return expanded;
}

function matchingAtoms<T>(
  items: readonly T[],
  terms: readonly string[],
  query: RetrievalQuery,
  textFor: (item: T) => string,
  atomFor: (item: T) => EvidenceAtom,
): readonly EvidenceAtom[] {
  const atoms: EvidenceAtom[] = [];
  for (const item of items) {
    if (includesAny(textFor(item), terms, query)) atoms.push(atomFor(item));
  }
  return atoms;
}

export function queryCodeIntelligenceIndex(
  scope: SearchScope,
  query: RetrievalQuery,
  index: CodeIntelligenceIndex,
  nowMs: number,
): readonly EvidenceAtom[] {
  const terms = queryTerms(query);
  const atoms: EvidenceAtom[] = [
    ...matchingAtoms(
      index.imports,
      terms,
      query,
      (item) => `${item.specifier} ${item.importerPath} ${item.targetPath ?? ""}`,
      (item) => importEdgeAtom(scope, query, nowMs, item),
    ),
    ...matchingAtoms(
      index.symbols,
      terms,
      query,
      (item) => `${item.name} ${item.scopePath} ${item.fields.join(" ")}`,
      (item) => symbolAtom(scope, query, nowMs, item),
    ),
    ...matchingAtoms(
      index.calls,
      terms,
      query,
      (item) => `${item.calleeName} ${item.targetName} ${item.callerPath} ${item.targetPath}`,
      (item) => callAtom(scope, query, nowMs, item),
    ),
    ...matchingAtoms(
      index.references,
      terms,
      query,
      (item) =>
        `${item.referenceName} ${item.targetName} ${item.referencerPath} ${item.targetPath}`,
      (item) => referenceAtom(scope, query, nowMs, item),
    ),
    ...matchingAtoms(
      index.apiContracts,
      terms,
      query,
      (item) =>
        `${item.client.method} ${item.client.path} ${item.client.scopePath} ${item.server.scopePath}`,
      (item) => apiContractAtom(scope, query, nowMs, item),
    ),
    ...matchingAtoms(
      index.dtoContracts,
      terms,
      query,
      (item) =>
        `${item.source.name} ${item.target.name} ${item.sharedFields.join(" ")} ${item.source.scopePath} ${item.target.scopePath}`,
      (item) => dtoContractAtom(scope, query, nowMs, item),
    ),
    ...matchingAtoms(
      index.packageDependencies,
      terms,
      query,
      (item) =>
        `${item.sourcePackage} ${item.targetPackage} ${item.dependencyKind} ${item.sourcePath} ${item.targetPath}`,
      (item) => packageDependencyAtom(scope, query, nowMs, item),
    ),
  ];
  atoms.push(...expandGraphNeighborhood(scope, query, nowMs, index, atoms));
  const deduped = new Map<string, EvidenceAtom>();
  for (const atom of atoms.sort(compareEvidenceAtoms)) {
    if (deduped.has(atom.stableId)) {
      continue;
    }
    deduped.set(atom.stableId, atom);
  }
  return [...deduped.values()];
}

export function lookupCodeIntelligenceAtoms(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  fs: WorkspaceFs,
  deps?: BuildDeps,
): readonly EvidenceAtom[] {
  const nowMs = deps?.nowMs ?? Date.now;
  const index = buildCodeIntelligenceIndex(scope, limits, fs, deps);
  return queryCodeIntelligenceIndex(scope, query, index, nowMs()).slice(
    0,
    Math.min(limits.maxMatchesReturned, query.maxResults),
  );
}
