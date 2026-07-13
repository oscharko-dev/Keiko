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

function collectTsImportResolverConfig(
  scope: SearchScope,
  fs: WorkspaceFs,
  candidates: readonly { readonly relativePath: string }[],
): TsImportResolverConfig {
  const aliases: TsPathAlias[] = [];
  const baseUrls: string[] = [];
  for (const candidate of candidates) {
    if (!isTsconfigPath(candidate.relativePath)) {
      continue;
    }
    let parsed: unknown;
    try {
      const text = readWorkspaceFile(
        scope.workspace,
        candidate.relativePath,
        { maxBytes: 262_144 },
        fs,
      ).text;
      const result = ts.parseConfigFileTextToJson(candidate.relativePath, text);
      parsed = result.error === undefined ? result.config : undefined;
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.compilerOptions)) {
      continue;
    }
    const compilerOptions = parsed.compilerOptions;
    const baseUrl = typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : ".";
    const configDir = tsconfigDir(candidate.relativePath);
    if (typeof compilerOptions.baseUrl === "string") {
      baseUrls.push(normalizeScopePath(posix.join(configDir, compilerOptions.baseUrl)));
    }
    if (!isRecord(compilerOptions.paths)) {
      continue;
    }
    for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
      aliases.push({ configDir, baseUrl, pattern, targets: asStringArray(targets) });
    }
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
  return target.includes("*") ? target.replace(/\*/gu, substitution) : target;
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

function resolveWorkspacePackageTarget(
  specifier: string,
  pathSet: ReadonlySet<string>,
  resolver: TsImportResolverConfig,
): string | undefined {
  for (const pkg of resolver.packages) {
    if (specifier === pkg.name) {
      for (const target of pkg.entryTargets) {
        const resolved = resolvePackageTargetPath(pathSet, pkg, target);
        if (resolved !== undefined) {
          return resolved;
        }
      }
      continue;
    }
    if (!specifier.startsWith(`${pkg.name}/`)) {
      continue;
    }
    const subpath = specifier.slice(pkg.name.length + 1);
    const exact = pkg.exports.find((item) => item.subpath === subpath);
    const wildcard = pkg.exports
      .map((item) => ({ item, substitution: wildcardSubstitution(item.subpath, subpath) }))
      .find((entry) => entry.substitution !== undefined);
    const targets = exact?.targets ?? wildcard?.item.targets ?? [subpath];
    const substitution = wildcard?.substitution ?? "";
    for (const target of targets.map((candidate) => applyWildcard(candidate, substitution))) {
      const resolved = resolvePackageTargetPath(pathSet, pkg, target);
      if (resolved !== undefined) {
        return resolved;
      }
    }
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
    posix.join(baseDir, moduleName.replace(/\./gu, "/")),
    PY_EXTENSIONS,
  );
}

function resolveImportTarget(
  edge: Omit<CodeImportEdge, "targetPath" | "confidence">,
  pathSet: ReadonlySet<string>,
  resolver: TsImportResolverConfig,
): Pick<CodeImportEdge, "targetPath" | "confidence"> {
  const specifier = edge.specifier;
  const importerDir = dirname(edge.importerPath);
  if (edge.language === "python" && specifier.startsWith(".")) {
    const target = resolvePythonRelativeImport(edge.importerPath, specifier, pathSet);
    return target === undefined
      ? { confidence: "heuristic" }
      : { targetPath: target, confidence: "resolved" };
  }
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const joined = specifier.startsWith("/")
      ? specifier.slice(1)
      : posix.join(importerDir === "." ? "" : importerDir, specifier);
    const target = resolveCandidate(
      pathSet,
      joined,
      edge.language === "python" ? PY_EXTENSIONS : JS_EXTENSIONS,
    );
    return target === undefined
      ? { confidence: "heuristic" }
      : { targetPath: target, confidence: "resolved" };
  }
  if (specifier.startsWith("@/")) {
    const target = resolveCandidate(pathSet, `src/${specifier.slice(2)}`, JS_EXTENSIONS);
    return target === undefined
      ? { confidence: "heuristic" }
      : { targetPath: target, confidence: "resolved" };
  }
  if (edge.language === "typescript" || edge.language === "javascript") {
    const target =
      resolveTsAliasTarget(specifier, pathSet, resolver) ??
      resolveWorkspacePackageTarget(specifier, pathSet, resolver);
    if (target !== undefined) {
      return { targetPath: target, confidence: "resolved" };
    }
  }
  if (
    edge.language === "java" ||
    edge.language === "kotlin" ||
    edge.language === "scala" ||
    edge.language === "groovy"
  ) {
    const suffix = `${specifier.replace(/\./g, "/")}.${edge.language === "kotlin" ? "kt" : edge.language === "scala" ? "scala" : edge.language === "groovy" ? "groovy" : "java"}`;
    const target = suffixCandidate(pathSet, suffix);
    return target === undefined
      ? { confidence: "heuristic" }
      : { targetPath: target, confidence: "resolved" };
  }
  if (edge.language === "python") {
    const modulePath = specifier.replace(/\./g, "/");
    const target =
      resolveCandidate(pathSet, modulePath, PY_EXTENSIONS) ??
      suffixCandidate(pathSet, `${modulePath}.py`) ??
      suffixCandidate(pathSet, `${modulePath}/__init__.py`);
    return target === undefined
      ? { confidence: "heuristic" }
      : { targetPath: target, confidence: "resolved" };
  }
  if (edge.language === "go") {
    const target =
      resolveGoModuleTarget(specifier, pathSet, resolver) ??
      suffixCandidate(pathSet, `${specifier.replace(/^.*?\//u, "")}.go`) ??
      suffixCandidate(pathSet, specifier);
    return target === undefined
      ? { confidence: "heuristic" }
      : { targetPath: target, confidence: "resolved" };
  }
  const last = specifier.split(/[/.]/u).filter(Boolean).at(-1);
  const target =
    last === undefined
      ? undefined
      : suffixCandidate(pathSet, `${last}.${extension(edge.importerPath)}`);
  return target === undefined
    ? { confidence: "heuristic" }
    : { targetPath: target, confidence: "resolved" };
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
    if (rustUse?.[1] !== undefined) emit("import", rustUse[1].replace(/::/gu, "/"));
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

function collectTypescriptImportBindings(
  file: SourceFile,
  imports: readonly CodeImportEdge[],
  resolver: TypescriptReExportResolverContext,
): readonly CodeImportBinding[] {
  const sourceFile = file.syntaxTree;
  if (sourceFile === undefined) {
    return [];
  }
  const targetBySpecifier = new Map<string, string>();
  for (const edge of imports) {
    if (edge.importerPath === file.scopePath && edge.targetPath !== undefined) {
      targetBySpecifier.set(edge.specifier, edge.targetPath);
    }
  }
  const bindings: CodeImportBinding[] = [];
  const pushBinding = (specifier: string, localName: string, importedName: string): void => {
    const targetPath = targetBySpecifier.get(specifier);
    if (targetPath === undefined) {
      return;
    }
    const resolved = resolveTypescriptReExportedSymbol(targetPath, importedName, resolver);
    bindings.push({
      importerPath: file.scopePath,
      localName,
      importedName: resolved?.importedName ?? importedName,
      targetPath: resolved?.targetPath ?? targetPath,
    });
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const specifier = stringLiteralText(statement.moduleSpecifier);
    if (specifier === undefined) {
      continue;
    }
    const clause = statement.importClause;
    if (clause === undefined) {
      continue;
    }
    if (clause.name !== undefined) {
      pushBinding(specifier, clause.name.text, "default");
    }
    if (clause.namedBindings === undefined) {
      continue;
    }
    if (ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        pushBinding(specifier, element.name.text, element.propertyName?.text ?? element.name.text);
      }
    }
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

function collectTypescriptReExportBindings(
  file: SourceFile,
  imports: readonly CodeImportEdge[],
): readonly TypescriptReExportBinding[] {
  const sourceFile = file.syntaxTree;
  if (sourceFile === undefined) {
    return [];
  }
  const targetBySpecifier = new Map<string, string>();
  for (const edge of imports) {
    if (
      edge.kind === "export" &&
      edge.importerPath === file.scopePath &&
      edge.targetPath !== undefined
    ) {
      targetBySpecifier.set(edge.specifier, edge.targetPath);
    }
  }
  const bindings: TypescriptReExportBinding[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    const specifier = stringLiteralText(statement.moduleSpecifier);
    const targetPath = specifier === undefined ? undefined : targetBySpecifier.get(specifier);
    if (targetPath === undefined) {
      continue;
    }
    const clause = statement.exportClause;
    if (clause === undefined) {
      bindings.push({ exporterPath: file.scopePath, targetPath });
      continue;
    }
    if (!ts.isNamedExports(clause)) {
      continue;
    }
    for (const element of clause.elements) {
      bindings.push({
        exporterPath: file.scopePath,
        exportedName: element.name.text,
        importedName: element.propertyName?.text ?? element.name.text,
        targetPath,
      });
    }
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

function collectTypescriptDefaultExports(file: SourceFile): readonly TypescriptDefaultExport[] {
  const sourceFile = file.syntaxTree;
  if (sourceFile === undefined) {
    return [];
  }
  const defaults: TypescriptDefaultExport[] = [];
  const pushDefault = (symbolName: string | undefined): void => {
    defaults.push({ scopePath: file.scopePath, symbolName: symbolName ?? "default" });
  };
  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      hasDefaultModifier(statement)
    ) {
      pushDefault(declarationNameText(statement.name));
      continue;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      pushDefault(ts.isIdentifier(statement.expression) ? statement.expression.text : "default");
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text === "default") {
          pushDefault(element.propertyName?.text ?? element.name.text);
        }
      }
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
    for (const symbolName of resolver.defaultExportsByFile.get(exporterPath) ?? []) {
      if (fileDefinesTypescriptSymbol(resolver, exporterPath, symbolName)) {
        return { targetPath: exporterPath, importedName: symbolName };
      }
    }
  }
  if (fileDefinesTypescriptSymbol(resolver, exporterPath, exportedName)) {
    return { targetPath: exporterPath, importedName: exportedName };
  }
  const reExports = resolver.reExportsByFile.get(exporterPath) ?? [];
  for (const binding of reExports) {
    if (binding.exportedName !== exportedName || binding.importedName === undefined) {
      continue;
    }
    const resolved = resolveTypescriptReExportedSymbol(
      binding.targetPath,
      binding.importedName,
      resolver,
      nextSeen,
      depth + 1,
    );
    if (resolved !== undefined) {
      return resolved;
    }
    if (fileDefinesTypescriptSymbol(resolver, binding.targetPath, binding.importedName)) {
      return { targetPath: binding.targetPath, importedName: binding.importedName };
    }
  }
  if (exportedName === "default") {
    return undefined;
  }
  for (const binding of reExports) {
    if (binding.exportedName !== undefined) {
      continue;
    }
    const resolved = resolveTypescriptReExportedSymbol(
      binding.targetPath,
      exportedName,
      resolver,
      nextSeen,
      depth + 1,
    );
    if (resolved !== undefined) {
      return resolved;
    }
    if (fileDefinesTypescriptSymbol(resolver, binding.targetPath, exportedName)) {
      return { targetPath: binding.targetPath, importedName: exportedName };
    }
  }
  return undefined;
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

function splitFieldComponents(text: string): readonly string[] {
  const components: string[] = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  let quoted: "'" | '"' | undefined;
  let escaped = false;
  for (const character of text) {
    if (quoted !== undefined) {
      current += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quoted) {
        quoted = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quoted = character;
    } else if (character === "(") {
      parenDepth += 1;
    } else if (character === ")" && parenDepth > 0) {
      parenDepth -= 1;
    } else if (character === "[") {
      bracketDepth += 1;
    } else if (character === "]" && bracketDepth > 0) {
      bracketDepth -= 1;
    } else if (character === "{") {
      braceDepth += 1;
    } else if (character === "}" && braceDepth > 0) {
      braceDepth -= 1;
    } else if (character === "<") {
      angleDepth += 1;
    } else if (character === ">" && angleDepth > 0) {
      angleDepth -= 1;
    } else if (
      character === "," &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      angleDepth === 0
    ) {
      components.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  components.push(current);
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

function collectOpenApiYamlSchemaSymbols(file: SourceFile): readonly CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = file.text.split(/\r?\n/u);
  let inComponents = false;
  let componentsIndent = -1;
  let inSchemas = false;
  let schemasIndent = -1;
  let currentName: string | undefined;
  let currentLine = 1;
  let currentFields: string[] = [];
  let inProperties = false;
  let propertiesIndent = -1;
  const flush = (): void => {
    if (currentName !== undefined && currentFields.length > 0) {
      symbols.push(openApiSchemaSymbol(file, currentName, currentFields, currentLine));
    }
    currentName = undefined;
    currentFields = [];
    inProperties = false;
    propertiesIndent = -1;
  };
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      return;
    }
    const indent = line.length - line.trimStart().length;
    if (!inComponents) {
      if (/^components\s*:\s*$/u.test(trimmed)) {
        inComponents = true;
        componentsIndent = indent;
      }
      return;
    }
    if (!inSchemas) {
      if (indent <= componentsIndent && !/^components\s*:/u.test(trimmed)) {
        inComponents = false;
        return;
      }
      if (/^schemas\s*:\s*$/u.test(trimmed)) {
        inSchemas = true;
        schemasIndent = indent;
      }
      return;
    }
    if (indent <= schemasIndent && !/^schemas\s*:/u.test(trimmed)) {
      flush();
      inSchemas = false;
      return;
    }
    const schemaMatch = /^([A-Za-z_][\w.-]*)\s*:\s*$/u.exec(trimmed);
    if (schemaMatch?.[1] !== undefined && indent > schemasIndent && indent <= schemasIndent + 2) {
      flush();
      currentName = schemaMatch[1];
      currentLine = index + 1;
      return;
    }
    if (currentName === undefined) {
      return;
    }
    if (/^properties\s*:\s*$/u.test(trimmed)) {
      inProperties = true;
      propertiesIndent = indent;
      return;
    }
    if (inProperties && indent <= propertiesIndent) {
      inProperties = false;
    }
    if (inProperties) {
      const fieldMatch = /^([A-Za-z_][\w-]*)\s*:/u.exec(trimmed);
      if (fieldMatch?.[1] !== undefined) {
        currentFields.push(fieldMatch[1]);
      }
    }
  });
  flush();
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

function collectBlockFields(
  lines: readonly string[],
  startIndex: number,
  language: CodeLanguage,
): readonly string[] {
  const fields: string[] = [];
  let pendingSerializedFieldName: string | undefined;
  const pushField = (fieldName: string): void => {
    fields.push(pendingSerializedFieldName ?? fieldName);
    pendingSerializedFieldName = undefined;
  };
  for (let i = startIndex; i < Math.min(lines.length, startIndex + 80); i += 1) {
    const line = lines[i] ?? "";
    if (i > startIndex && /^\s*\}/u.test(line)) {
      break;
    }
    const serializedFieldName = fieldNameFromSerializationAnnotation(line);
    if (serializedFieldName !== undefined) {
      pendingSerializedFieldName = serializedFieldName;
    }
    const declarationLine = line
      .replace(/@\w+(?:\([^)]*\))?/gu, " ")
      .replace(/\[[^\]]+\]\s*/gu, " ");
    let consumedField = false;
    const match = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:;]/u.exec(declarationLine);
    if (match?.[1] !== undefined) {
      consumedField = true;
      pushField(match[1]);
    }
    const javaField =
      /^\s*(?:private|protected|public)?\s*(?:final\s+)?[A-Za-z_$][\w$<>, ?.[\]]+\s+([A-Za-z_$][\w$]*)\s*(?:[=;])/u.exec(
        declarationLine,
      );
    if (javaField?.[1] !== undefined) {
      consumedField = true;
      pushField(javaField[1]);
    }
    const kotlinProperty =
      /^\s*(?:(?:public|private|protected|internal|override|lateinit)\s+)*(?:val|var)\s+([A-Za-z_$][\w$]*)\??\s*[:=]/u.exec(
        declarationLine,
      );
    if (kotlinProperty?.[1] !== undefined) {
      consumedField = true;
      pushField(kotlinProperty[1]);
    }
    const csharpProperty =
      /^\s*(?:(?:public|private|protected|internal|required|static|readonly|virtual|override|sealed|abstract|new)\s+)*[A-Za-z_$][\w$<>, ?.[\]]+\s+([A-Za-z_$][\w$]*)\s*\{/u.exec(
        declarationLine,
      );
    if (csharpProperty?.[1] !== undefined) {
      consumedField = true;
      pushField(csharpProperty[1]);
    }
    if (language === "go" && i > startIndex) {
      const goStructField = /^\s*([A-Za-z_][\w]*)\s+[^\s`{]+(?:\s+`([^`]*)`)?/u.exec(line);
      const fieldName = fieldNameFromGoStructTag(goStructField?.[2]) ?? goStructField?.[1];
      if (fieldName !== undefined && !NON_FIELD_COMPONENT_NAMES.has(fieldName.toLowerCase())) {
        consumedField = true;
        pushField(fieldName);
      }
    }
    if (!consumedField && serializedFieldName === undefined && declarationLine.trim().length > 0) {
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

function stripBlockCommentsFromLine(
  line: string,
  state: { inBlockComment: boolean; inPythonTripleQuote: string | undefined },
  language: CodeLanguage,
): string {
  let output = "";
  let index = 0;
  while (index < line.length) {
    if (state.inBlockComment) {
      const end = line.indexOf("*/", index);
      if (end < 0) {
        return output;
      }
      index = end + 2;
      state.inBlockComment = false;
      continue;
    }
    if (state.inPythonTripleQuote !== undefined) {
      const end = line.indexOf(state.inPythonTripleQuote, index);
      if (end < 0) {
        return output;
      }
      index = end + state.inPythonTripleQuote.length;
      state.inPythonTripleQuote = undefined;
      continue;
    }
    const blockStart = line.indexOf("/*", index);
    const tripleStart =
      language === "python"
        ? [line.indexOf('"""', index), line.indexOf("'''", index)]
            .filter((value) => value >= 0)
            .sort((a, b) => a - b)[0]
        : undefined;
    const nextStart =
      blockStart < 0
        ? tripleStart
        : tripleStart === undefined
          ? blockStart
          : Math.min(blockStart, tripleStart);
    if (nextStart === undefined || nextStart < 0) {
      output += line.slice(index);
      break;
    }
    output += line.slice(index, nextStart);
    if (nextStart === blockStart) {
      const end = line.indexOf("*/", nextStart + 2);
      if (end < 0) {
        state.inBlockComment = true;
        break;
      }
      index = end + 2;
      continue;
    }
    const quote = line.slice(nextStart, nextStart + 3);
    const end = line.indexOf(quote, nextStart + 3);
    if (end < 0) {
      state.inPythonTripleQuote = quote;
      break;
    }
    index = end + 3;
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

function maskEndpointCommentOrDocstringText(
  text: string,
  language: CodeLanguage,
): EndpointScanText {
  const chars = text.split("");
  const codeMask = new Uint8Array(text.length);
  codeMask.fill(1);

  const maskAt = (index: number): void => {
    if (chars[index] !== "\n" && chars[index] !== "\r") {
      chars[index] = " ";
    }
    codeMask[index] = 0;
  };

  let index = 0;
  let stringDelimiter: "'" | '"' | "`" | undefined;
  let escaped = false;
  let inBlockComment = false;
  let pythonTripleQuote: string | undefined;
  while (index < text.length) {
    if (inBlockComment) {
      if (text.startsWith("*/", index)) {
        maskAt(index);
        maskAt(index + 1);
        index += 2;
        inBlockComment = false;
        continue;
      }
      maskAt(index);
      index += 1;
      continue;
    }

    if (pythonTripleQuote !== undefined) {
      if (text.startsWith(pythonTripleQuote, index)) {
        for (let offset = 0; offset < pythonTripleQuote.length; offset += 1) {
          maskAt(index + offset);
        }
        index += pythonTripleQuote.length;
        pythonTripleQuote = undefined;
        continue;
      }
      maskAt(index);
      index += 1;
      continue;
    }

    if (stringDelimiter !== undefined) {
      codeMask[index] = 0;
      if (escaped) {
        escaped = false;
      } else if (text[index] === "\\") {
        escaped = true;
      } else if (text[index] === stringDelimiter) {
        stringDelimiter = undefined;
      } else if (stringDelimiter !== "`" && (text[index] === "\n" || text[index] === "\r")) {
        stringDelimiter = undefined;
      }
      index += 1;
      continue;
    }

    if (language === "python" && (text.startsWith('"""', index) || text.startsWith("'''", index))) {
      pythonTripleQuote = text.slice(index, index + 3);
      for (let offset = 0; offset < 3; offset += 1) {
        maskAt(index + offset);
      }
      index += 3;
      continue;
    }

    if (text.startsWith("/*", index)) {
      maskAt(index);
      maskAt(index + 1);
      index += 2;
      inBlockComment = true;
      continue;
    }

    const lineCommentMarker = lineCommentMarkerAt(text, index, language);
    if (lineCommentMarker !== undefined) {
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") {
        maskAt(index);
        index += 1;
      }
      continue;
    }

    const char = text[index];
    if (char === "'" || char === '"' || char === "`") {
      stringDelimiter = char;
      escaped = false;
      codeMask[index] = 0;
    }
    index += 1;
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

function collectPythonRoutePrefixes(scan: EndpointScanText): ReadonlyMap<string, string> {
  const prefixes = new Map<string, string>();
  for (const match of scan.text.matchAll(/\b([A-Za-z_][\w]*)\s*=\s*APIRouter\s*\(([^)]*)\)/gu)) {
    if (!matchStartsInCode(scan, match)) {
      continue;
    }
    const variableName = match[1];
    const prefix = namedStringArg(match[2], "prefix");
    if (variableName !== undefined && prefix !== undefined) {
      prefixes.set(variableName, prefix);
    }
  }
  for (const match of scan.text.matchAll(/\b([A-Za-z_][\w]*)\s*=\s*Blueprint\s*\(([^)]*)\)/gu)) {
    if (!matchStartsInCode(scan, match)) {
      continue;
    }
    const variableName = match[1];
    const prefix = namedStringArg(match[2], "url_prefix");
    if (variableName !== undefined && prefix !== undefined) {
      prefixes.set(variableName, prefix);
    }
  }
  for (const match of scan.text.matchAll(
    /\b[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*\.include_router\s*\(\s*([A-Za-z_][\w]*)\s*(?:,\s*([^)]*))?\)/gu,
  )) {
    if (!matchStartsInCode(scan, match)) {
      continue;
    }
    const routerName = match[1];
    const prefix = namedStringArg(match[2], "prefix");
    if (routerName !== undefined && prefix !== undefined) {
      prefixes.set(routerName, combineRoutePath(prefix, prefixes.get(routerName) ?? ""));
    }
  }
  return prefixes;
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
  let inPaths = false;
  let pathsIndent = -1;
  let currentPath: string | undefined;
  let currentPathLine = 1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (!inPaths) {
      if (/^paths\s*:\s*$/u.test(trimmed)) {
        inPaths = true;
        pathsIndent = indent;
      }
      continue;
    }
    if (indent <= pathsIndent && !trimmed.startsWith("/")) {
      break;
    }
    const pathMatch = /^["']?(\/[^:"']*)["']?\s*:\s*$/u.exec(trimmed);
    if (pathMatch?.[1] !== undefined) {
      currentPath = pathMatch[1];
      currentPathLine = index + 1;
      continue;
    }
    const methodMatch = /^([A-Za-z]+)\s*:\s*$/u.exec(trimmed);
    const method = methodMatch?.[1]?.toLowerCase();
    if (currentPath !== undefined && method !== undefined && HTTP_METHODS.has(method)) {
      endpoints.push({
        role: "server",
        method: method.toUpperCase(),
        path: normalizeRoutePath(currentPath),
        scopePath: file.scopePath,
        lineRange: lineRange(currentPathLine),
        language: file.language,
        parser: "polyglot-regex",
      });
    }
  }
  return endpoints;
}

function collectOpenApiEndpoints(file: SourceFile): readonly ApiEndpoint[] {
  return extension(file.scopePath) === "json"
    ? collectOpenApiJsonEndpoints(file)
    : collectOpenApiYamlEndpoints(file);
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
  const lines = scan.lines;
  let pendingSpringClassPrefix: string | undefined;
  let springClassPrefix: string | undefined;
  let springClassBraceDepth = 0;
  let insideSpringClass = false;
  let springAnyClassBraceDepth = 0;
  let pendingDotNetClassRoute: string | undefined;
  let pendingDotNetMethodRoute: string | undefined;
  let pendingDotNetMethod: string | undefined;
  let dotNetClassPrefix: string | undefined;
  let dotNetClassNameValue: string | undefined;
  let dotNetClassBraceDepth = 0;
  let pendingNestClassPrefix: string | undefined;
  let nestClassPrefix: string | undefined;
  let nestClassBraceDepth = 0;
  const hasRtkQueryApi =
    /\bcreateApi\s*\(/u.test(scan.text) || /\bbuilder\.(?:query|mutation)\b/u.test(scan.text);
  const axiosBasePaths = collectAxiosBasePaths(scan);
  const expressRouterMounts = collectExpressRouterMounts(scan);
  const pythonRoutePrefixes = collectPythonRoutePrefixes(scan);
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const lineOffset = scan.lineOffsets[index] ?? 0;
    const springClassDeclaration = firstCodeMatch(
      line,
      /\b(?:class|interface|record)\s+[A-Za-z_][\w$]*/u,
      scan,
      lineOffset,
    );
    if (springClassDeclaration !== undefined) {
      insideSpringClass = true;
      springAnyClassBraceDepth = 0;
      if (pendingSpringClassPrefix !== undefined) {
        springClassPrefix = pendingSpringClassPrefix;
        pendingSpringClassPrefix = undefined;
        springClassBraceDepth = 0;
      }
    }
    if (
      pendingNestClassPrefix !== undefined &&
      firstCodeMatch(line, /\bclass\s+[A-Za-z_][\w$]*/u, scan, lineOffset) !== undefined
    ) {
      nestClassPrefix = pendingNestClassPrefix;
      pendingNestClassPrefix = undefined;
      nestClassBraceDepth = 0;
    }
    const className = firstCodeMatch(line, /\bclass\s+([A-Za-z_][\w]*)/u, scan, lineOffset)?.[1];
    if (pendingDotNetClassRoute !== undefined && className !== undefined) {
      dotNetClassPrefix = replaceDotNetRouteTokens(pendingDotNetClassRoute, className);
      dotNetClassNameValue = className;
      pendingDotNetClassRoute = undefined;
      dotNetClassBraceDepth = 0;
    }
    const emit = (role: "server" | "client", method: string, path: string): void => {
      endpoints.push({
        role,
        method: method.toUpperCase(),
        path: normalizeRoutePath(path),
        scopePath: file.scopePath,
        lineRange: lineRange(lineNo),
        language: file.language,
        parser: "polyglot-regex",
      });
    };
    const dotNetRoute = parseDotNetRouteAttribute(line);
    if (dotNetRoute !== undefined) {
      const routePath = replaceDotNetRouteTokens(dotNetRoute.path, dotNetClassNameValue);
      if (dotNetRoute.isRoute) {
        if (dotNetClassNameValue === undefined) {
          pendingDotNetClassRoute = routePath;
        } else {
          pendingDotNetMethodRoute = routePath;
        }
      } else {
        pendingDotNetMethod = dotNetRoute.method;
        if (routePath.length > 0) {
          pendingDotNetMethodRoute = routePath;
        }
      }
    } else if (
      (pendingDotNetMethod !== undefined || pendingDotNetMethodRoute !== undefined) &&
      dotNetMethodDeclaration(line)
    ) {
      emit(
        "server",
        pendingDotNetMethod ?? "ANY",
        combineRoutePath(dotNetClassPrefix, pendingDotNetMethodRoute ?? ""),
      );
      pendingDotNetMethod = undefined;
      pendingDotNetMethodRoute = undefined;
    }
    const dotNetMinimalApi = firstCodeMatch(
      line,
      /\b\w+\.Map(Get|Post|Put|Patch|Delete|Head|Options|Methods)\s*\(\s*(["'`])([^"'`]+)\2([^)]*)/u,
      scan,
      lineOffset,
    );
    if (dotNetMinimalApi?.[1] !== undefined && dotNetMinimalApi[3] !== undefined) {
      emit(
        "server",
        dotNetMinimalApiMethod(dotNetMinimalApi[1], dotNetMinimalApi[4] ?? ""),
        dotNetMinimalApi[3],
      );
    }
    const spring = firstCodeMatch(
      line,
      /@(?:(Get|Post|Put|Patch|Delete)Mapping|RequestMapping)(?:\s*\(([^)]*)\))?/u,
      scan,
      lineOffset,
    );
    if (spring !== undefined) {
      const isRequestMapping = line.includes("@RequestMapping");
      const method = springMappingMethod(spring[1], spring[2]);
      const path = springMappingPath(spring[2]);
      if (isRequestMapping && !insideSpringClass && springClassPrefix === undefined) {
        if (path !== undefined) {
          pendingSpringClassPrefix = path;
        }
      } else if (path !== undefined || (!isRequestMapping && insideSpringClass)) {
        emit("server", method, combineRoutePath(springClassPrefix, path ?? ""));
      }
    }
    const nestController = firstCodeMatch(
      line,
      /@Controller\s*\(\s*(?:(["'`])([^"'`]+)\1)?\s*\)/u,
      scan,
      lineOffset,
    );
    if (
      (file.language === "typescript" || file.language === "javascript") &&
      nestController !== undefined
    ) {
      pendingNestClassPrefix = nestController[2] ?? "";
    }
    const nestRoute = firstCodeMatch(
      line,
      /@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*(?:(["'`])([^"'`]+)\2)?/u,
      scan,
      lineOffset,
    );
    if (
      (file.language === "typescript" || file.language === "javascript") &&
      nestRoute?.[1] !== undefined
    ) {
      emit(
        "server",
        nestHttpMethod(nestRoute[1]),
        combineRoutePath(nestClassPrefix, nestRoute[3] ?? ""),
      );
    }
    const express = firstCodeMatch(
      line,
      /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']/iu,
      scan,
      lineOffset,
    );
    if (express?.[1] !== undefined && express[2] !== undefined && express[3] !== undefined) {
      const objectName = express[1];
      const path = combineRoutePath(expressRouterMounts.get(objectName), express[3]);
      if (["app", "router", "server"].includes(objectName) || expressRouterMounts.has(objectName)) {
        emit("server", express[2], path);
      }
    }
    const expressRouteChain = firstCodeMatch(
      line,
      /\b([A-Za-z_$][\w$]*)\.route\s*\(\s*(["'`])([^"'`]+)\2\s*\)\s*\.\s*(get|post|put|patch|delete|head|options)\b/iu,
      scan,
      lineOffset,
    );
    if (
      expressRouteChain?.[1] !== undefined &&
      expressRouteChain[3] !== undefined &&
      expressRouteChain[4] !== undefined
    ) {
      const objectName = expressRouteChain[1];
      const path = combineRoutePath(expressRouterMounts.get(objectName), expressRouteChain[3]);
      if (["app", "router", "server"].includes(objectName) || expressRouterMounts.has(objectName)) {
        emit("server", expressRouteChain[4], path);
      }
    }
    const pyRoute = firstCodeMatch(
      line,
      /@([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\.route\s*\(\s*["']([^"']+)["'](?:[^)]*methods\s*=\s*\[["']([A-Z]+)["'])?/iu,
      scan,
      lineOffset,
    );
    if (pyRoute?.[1] !== undefined && pyRoute[2] !== undefined) {
      emit(
        "server",
        pyRoute[3] ?? "ANY",
        combineRoutePath(pythonRoutePrefixes.get(pyRoute[1]), pyRoute[2]),
      );
    }
    const pyMethodRoute = firstCodeMatch(
      line,
      /@([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\.(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']/iu,
      scan,
      lineOffset,
    );
    if (
      pyMethodRoute?.[1] !== undefined &&
      pyMethodRoute[2] !== undefined &&
      pyMethodRoute[3] !== undefined
    )
      emit(
        "server",
        pyMethodRoute[2],
        combineRoutePath(pythonRoutePrefixes.get(pyMethodRoute[1]), pyMethodRoute[3]),
      );
    if (file.language === "python") {
      const djangoRoute = firstCodeMatch(
        line,
        /\b(?:path|re_path|url)\s*\(\s*r?(["'])([^"']+)\1/iu,
        scan,
        lineOffset,
      );
      if (djangoRoute?.[2] !== undefined) emit("server", "ANY", djangoRoute[2]);
    }
    if (file.language === "go") {
      const goRoute = firstCodeMatch(
        line,
        /\bhttp\.HandleFunc\s*\(\s*["']([^"']+)["']/u,
        scan,
        lineOffset,
      );
      if (goRoute?.[1] !== undefined) emit("server", "ANY", goRoute[1]);
      const goMethodRoute = firstCodeMatch(
        line,
        /\b[A-Za-z_][\w]*\.(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*(["'`])([^"'`]+)\2/iu,
        scan,
        lineOffset,
      );
      if (goMethodRoute?.[1] !== undefined && goMethodRoute[3] !== undefined) {
        emit("server", goRouterMethodName(goMethodRoute[1]), goMethodRoute[3]);
      }
      const goHandleFuncRoute = firstCodeMatch(
        line,
        /\b[A-Za-z_][\w]*\.HandleFunc\s*\(\s*(["'`])([^"'`]+)\1[^)]*\)(?:\.Methods\s*\(([^)]*)\))?/u,
        scan,
        lineOffset,
      );
      if (goHandleFuncRoute?.[2] !== undefined) {
        emit("server", goHttpMethodFromMethodsArgs(goHandleFuncRoute[3]), goHandleFuncRoute[2]);
      }
    }
    if (hasRtkQueryApi) {
      const rtkDirectQuery = firstCodeMatch(
        line,
        /\bquery\s*:\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(["'`])([^"'`]+)\1/u,
        scan,
        lineOffset,
      );
      if (rtkDirectQuery?.[2] !== undefined) emit("client", "ANY", rtkDirectQuery[2]);
      const rtkUrl = firstCodeMatch(line, /\burl\s*:\s*(["'`])([^"'`]+)\1/u, scan, lineOffset);
      if (rtkUrl?.[2] !== undefined) {
        const rtkMethod =
          firstCodeMatch(line, /\bmethod\s*:\s*(["'])([A-Z]+)\1/iu, scan, lineOffset)?.[2] ?? "ANY";
        emit("client", rtkMethod, rtkUrl[2]);
      }
    }
    const axiosCall = firstCodeMatch(
      line,
      /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete)\s*\(\s*(["'`])([^"'`]+)\3/iu,
      scan,
      lineOffset,
    );
    if (axiosCall?.[1] !== undefined && axiosCall[2] !== undefined && axiosCall[4] !== undefined) {
      const objectName = axiosCall[1];
      if (["axios", "client", "api"].includes(objectName) || axiosBasePaths.has(objectName)) {
        emit(
          "client",
          axiosCall[2],
          combineRoutePath(axiosBasePaths.get(objectName), axiosCall[4]),
        );
      }
    }
    if (springClassPrefix !== undefined) {
      springClassBraceDepth += braceDelta(line);
      if (springClassBraceDepth <= 0 && line.includes("}")) {
        springClassPrefix = undefined;
        springClassBraceDepth = 0;
      }
    }
    if (insideSpringClass) {
      springAnyClassBraceDepth += braceDelta(line);
      if (springAnyClassBraceDepth <= 0 && line.includes("}")) {
        insideSpringClass = false;
        springAnyClassBraceDepth = 0;
        pendingSpringClassPrefix = undefined;
      }
    }
    if (dotNetClassPrefix !== undefined) {
      dotNetClassBraceDepth += braceDelta(line);
      if (dotNetClassBraceDepth <= 0 && line.includes("}")) {
        dotNetClassPrefix = undefined;
        dotNetClassNameValue = undefined;
        pendingDotNetMethod = undefined;
        pendingDotNetMethodRoute = undefined;
        dotNetClassBraceDepth = 0;
      }
    }
    if (nestClassPrefix !== undefined) {
      nestClassBraceDepth += braceDelta(line);
      if (nestClassBraceDepth <= 0 && line.includes("}")) {
        nestClassPrefix = undefined;
        nestClassBraceDepth = 0;
      }
    }
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

function expandGraphNeighborhood(
  scope: SearchScope,
  query: RetrievalQuery,
  nowMs: number,
  index: CodeIntelligenceIndex,
  directAtoms: readonly EvidenceAtom[],
): readonly EvidenceAtom[] {
  const expanded: EvidenceAtom[] = [];
  const seenAtoms = new Set(directAtoms.map((atom) => atom.stableId));
  const queue: GraphSeed[] = [];
  const seenSeeds = new Set<string>();
  const seedAtoms = [...directAtoms]
    .sort(compareEvidenceAtoms)
    .slice(0, GRAPH_NEIGHBOR_SEED_ATOM_LIMIT);
  for (const atom of seedAtoms) {
    if (atom.edge === undefined) {
      pushGraphSeed(queue, seenSeeds, atom.scopePath, undefined, 1, atom.score);
      continue;
    }
    if (atom.edge.kind === "import" || atom.edge.kind === "export") {
      if (atom.edge.target.scopePath !== atom.edge.source.scopePath) {
        pushEndpointGraphSeeds(queue, seenSeeds, atom.edge.target, 1, atom.score);
      }
      continue;
    }
    pushEndpointGraphSeeds(queue, seenSeeds, atom.edge.source, 1, atom.score);
    pushEndpointGraphSeeds(queue, seenSeeds, atom.edge.target, 1, atom.score);
  }
  const pushNeighbor = (atom: EvidenceAtom, nextDepth: number): void => {
    if (expanded.length >= GRAPH_NEIGHBOR_ATOM_LIMIT || seenAtoms.has(atom.stableId)) {
      return;
    }
    seenAtoms.add(atom.stableId);
    expanded.push(atom);
    if (atom.edge !== undefined) {
      pushEndpointGraphSeeds(queue, seenSeeds, atom.edge.source, nextDepth, atom.score);
      pushEndpointGraphSeeds(queue, seenSeeds, atom.edge.target, nextDepth, atom.score);
    }
  };
  let cursor = 0;
  while (cursor < queue.length && expanded.length < GRAPH_NEIGHBOR_ATOM_LIMIT) {
    const seed = queue[cursor];
    cursor += 1;
    if (seed === undefined || seed.depth > GRAPH_NEIGHBOR_DEPTH_LIMIT) {
      continue;
    }
    const nextDepth = seed.depth + 1;
    for (const item of index.imports) {
      if (item.targetPath !== undefined && seedMatchesImport(seed, item)) {
        pushNeighbor(
          importEdgeAtom(
            scope,
            query,
            nowMs,
            item,
            graphNeighborScore(seed, importEdgeScore(query, item)),
          ),
          nextDepth,
        );
      }
    }
    for (const item of index.symbols) {
      if (seedMatchesSymbol(seed, item.scopePath, item.name)) {
        pushNeighbor(
          symbolAtom(scope, query, nowMs, item, graphNeighborScore(seed, symbolScore())),
          nextDepth,
        );
      }
    }
    for (const item of index.calls) {
      if (seedMatchesCall(seed, item)) {
        pushNeighbor(
          callAtom(scope, query, nowMs, item, graphNeighborScore(seed, callScore(item))),
          nextDepth,
        );
      }
    }
    for (const item of index.references) {
      if (seedMatchesReference(seed, item)) {
        pushNeighbor(
          referenceAtom(scope, query, nowMs, item, graphNeighborScore(seed, referenceScore(item))),
          nextDepth,
        );
      }
    }
    for (const item of index.apiContracts) {
      if (seedMatchesApiContract(seed, item)) {
        pushNeighbor(
          apiContractAtom(
            scope,
            query,
            nowMs,
            item,
            graphNeighborScore(seed, apiContractScore(item)),
          ),
          nextDepth,
        );
      }
    }
    for (const item of index.dtoContracts) {
      if (seedMatchesDtoContract(seed, item)) {
        pushNeighbor(
          dtoContractAtom(
            scope,
            query,
            nowMs,
            item,
            graphNeighborScore(seed, dtoContractScore(item)),
          ),
          nextDepth,
        );
      }
    }
    for (const item of index.packageDependencies) {
      if (seedMatchesPackageDependency(seed, item)) {
        pushNeighbor(
          packageDependencyAtom(
            scope,
            query,
            nowMs,
            item,
            graphNeighborScore(seed, packageDependencyScore(item)),
          ),
          nextDepth,
        );
      }
    }
  }
  return expanded;
}

export function queryCodeIntelligenceIndex(
  scope: SearchScope,
  query: RetrievalQuery,
  index: CodeIntelligenceIndex,
  nowMs: number,
): readonly EvidenceAtom[] {
  const terms = queryTerms(query);
  const atoms: EvidenceAtom[] = [];
  for (const item of index.imports) {
    const text = `${item.specifier} ${item.importerPath} ${item.targetPath ?? ""}`;
    if (includesAny(text, terms, query)) atoms.push(importEdgeAtom(scope, query, nowMs, item));
  }
  for (const item of index.symbols) {
    const text = `${item.name} ${item.scopePath} ${item.fields.join(" ")}`;
    if (includesAny(text, terms, query)) atoms.push(symbolAtom(scope, query, nowMs, item));
  }
  for (const item of index.calls) {
    const text = `${item.calleeName} ${item.targetName} ${item.callerPath} ${item.targetPath}`;
    if (includesAny(text, terms, query)) atoms.push(callAtom(scope, query, nowMs, item));
  }
  for (const item of index.references) {
    const text = `${item.referenceName} ${item.targetName} ${item.referencerPath} ${item.targetPath}`;
    if (includesAny(text, terms, query)) atoms.push(referenceAtom(scope, query, nowMs, item));
  }
  for (const item of index.apiContracts) {
    const text = `${item.client.method} ${item.client.path} ${item.client.scopePath} ${item.server.scopePath}`;
    if (includesAny(text, terms, query)) atoms.push(apiContractAtom(scope, query, nowMs, item));
  }
  for (const item of index.dtoContracts) {
    const text = `${item.source.name} ${item.target.name} ${item.sharedFields.join(" ")} ${item.source.scopePath} ${item.target.scopePath}`;
    if (includesAny(text, terms, query)) atoms.push(dtoContractAtom(scope, query, nowMs, item));
  }
  for (const item of index.packageDependencies) {
    const text = `${item.sourcePackage} ${item.targetPackage} ${item.dependencyKind} ${item.sourcePath} ${item.targetPath}`;
    if (includesAny(text, terms, query))
      atoms.push(packageDependencyAtom(scope, query, nowMs, item));
  }
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
