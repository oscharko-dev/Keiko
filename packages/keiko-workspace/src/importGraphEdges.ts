import { posix as path } from "node:path";
import { readWorkspaceFile } from "./discovery.js";
import type { WorkspaceFs } from "./fs.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo, isCanonicalAllowedContainedPath } from "./realpath.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import {
  gatherCandidatesWithControl,
  limitCandidateSetForStructuralBuild,
  probeBinary,
  type CandidateSet,
} from "./repoSearchScan.js";
import { importEdgeStableId } from "./stableId.js";
import {
  createStructuralExecutionControl,
  structuralExecutionStopped,
  type StructuralExecutionControl,
} from "./structuralExecution.js";

export type ImportEdgeKind = "static-import" | "re-export" | "commonjs-require" | "dynamic-import";
export type ImportResolutionKind =
  "relative" | "tsconfig-path" | "package-export" | "package-fallback" | "unresolved";

export interface ImportSpecifierHit {
  readonly specifier: string;
  readonly kind: ImportEdgeKind;
  readonly line: number;
  readonly ordinal: number;
}

export interface ResolvedImportEdge {
  readonly stableId: string;
  readonly importerPath: string;
  readonly specifier: string;
  readonly targetPath: string | undefined;
  readonly kind: ImportEdgeKind;
  readonly resolutionKind: ImportResolutionKind;
  readonly line: number;
  readonly ordinal: number;
  readonly confidence: number;
  readonly distance: number;
  readonly score: number;
}

export interface ImportGraph {
  readonly edges: readonly ResolvedImportEdge[];
  readonly forward: ReadonlyMap<string, readonly ResolvedImportEdge[]>;
  readonly reverse: ReadonlyMap<string, readonly ResolvedImportEdge[]>;
  readonly unresolved: readonly ResolvedImportEdge[];
  readonly diagnostics: ImportGraphDiagnostics;
}

export interface ImportGraphDiagnostics {
  readonly filesScanned: number;
  readonly filesSkipped: number;
  readonly truncated: boolean;
}

export interface ImportGraphTraversalOptions {
  readonly transitive?: boolean | undefined;
}

interface TsconfigAlias {
  readonly pattern: string;
  readonly targets: readonly string[];
  readonly baseUrl: string;
}

interface PackageInfo {
  readonly name: string;
  readonly rootPath: string;
  readonly manifest: Record<string, unknown>;
}

interface PackageTarget {
  readonly target: string;
  readonly kind: ImportResolutionKind;
}

interface ParsedJsonFile {
  readonly value: Record<string, unknown> | undefined;
  readonly failed: boolean;
}

interface ImportMetadata<T> {
  readonly items: readonly T[];
  readonly filesSkipped: number;
  readonly truncated: boolean;
}

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
]);
const RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
  ".json",
];
// The former `(?:[ \t]+\S+(?:[ \t]+\S+){0,50000}[ \t]+from)?` clause tried to enumerate every
// whitespace-separated token of the import clause before "from" -- a nested repetition group
// that keeps the ambiguous-shape S8786 flags no matter how the outer bound is tuned (a bound
// only caps the worst case, it doesn't make the two `\S+` atoms disjoint from each other).
//
// An earlier fix for that shape ("first quote after `import` is always the specifier") was too
// permissive in two ways, confirmed by direct review: it dropped side-effect/from-clause imports
// whose specifier's opening quote sits on a later line (the search never looked past the current
// line), and it fabricated `static-import` edges for ANY `import`-prefixed line that happens to
// contain a later quote at all -- including `import someIdentifier.foo("bar")` (not an import
// statement) and bare `import("./x")` (a dynamic-import EXPRESSION, already covered by
// DYNAMIC_IMPORT below, and now double-counted). `scanImportClauseFrom` restores the original
// regex's actual guarantee -- the text between `import` and the specifier's quote is provably
// nothing but clause syntax (identifiers, `{`/`}`/`,`/`*`, and whitespace including newlines) --
// by validating that shape character-by-character instead of assuming it. Any other character
// aborts the match for this `import` occurrence, exactly as the original regex would simply fail
// to match and move on to the next line.
const ESM_IMPORT_KEYWORD = /^[ \t]*import\b/gmu;
const IMPORT_CLAUSE_STRUCTURAL_CHARS = new Set(["{", "}", ",", "*"]);

function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_$]/u.test(char);
}

function skipWhitespaceRun(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/u.test(text.charAt(index))) index += 1;
  return index;
}

function scanIdentifierRun(text: string, from: number): number {
  let end = from;
  while (end < text.length && isIdentifierChar(text.charAt(end))) end += 1;
  return end;
}

// Scans a from-clause-or-none import header starting right after the required whitespace that
// follows `import`, returning the index right after a validated `from` keyword, or `undefined` if
// the header is not built entirely from clause syntax before either running out of text or
// reaching a character that could never appear in one (e.g. the `.`/`(` in
// `someIdentifier.foo(`, or the `(` that opens a dynamic-import expression).
function scanImportClauseFrom(text: string, start: number): number | undefined {
  let index = start;
  for (;;) {
    if (index >= text.length) return undefined;
    const char = text.charAt(index);
    if (/\s/u.test(char)) {
      index = skipWhitespaceRun(text, index);
      continue;
    }
    if (IMPORT_CLAUSE_STRUCTURAL_CHARS.has(char)) {
      index += 1;
      continue;
    }
    if (isIdentifierChar(char)) {
      const end = scanIdentifierRun(text, index);
      if (text.slice(index, end) === "from") return end;
      index = end;
      continue;
    }
    return undefined;
  }
}

function readQuotedSpecifier(text: string, at: number): { readonly value: string } | undefined {
  const quote = text.charAt(at);
  if (quote !== '"' && quote !== "'") return undefined;
  const closeIndex = text.indexOf(quote, at + 1);
  if (closeIndex === -1) return undefined;
  const value = text.slice(at + 1, closeIndex);
  return value.length > 0 && !value.includes("\n") ? { value } : undefined;
}

function matchEsmStaticImportSpecifier(
  text: string,
  afterKeyword: number,
): { readonly value: string } | undefined {
  // "import" must be followed by at least one whitespace char, exactly like the original regex's
  // mandatory `\s+` -- a bare "(" here is a dynamic-import EXPRESSION (DYNAMIC_IMPORT handles
  // it), and nothing else can legally abut "import" either way.
  if (afterKeyword >= text.length || !/\s/u.test(text.charAt(afterKeyword))) return undefined;
  const afterRequiredWhitespace = skipWhitespaceRun(text, afterKeyword);
  const nextChar = text.charAt(afterRequiredWhitespace);
  if (nextChar === '"' || nextChar === "'") {
    return readQuotedSpecifier(text, afterRequiredWhitespace);
  }
  const afterFrom = scanImportClauseFrom(text, afterRequiredWhitespace);
  if (afterFrom === undefined) return undefined;
  const afterFromWhitespace = skipWhitespaceRun(text, afterFrom);
  if (afterFromWhitespace === afterFrom) return undefined;
  return readQuotedSpecifier(text, afterFromWhitespace);
}
const ESM_REEXPORT_KEYWORD = /^[ \t]*export\b/gmu;
const CJS_REQUIRE = /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

function readReexportSpecifier(text: string, at: number): string | undefined {
  const quote = text.charAt(at);
  if (quote !== '"' && quote !== "'") return undefined;
  for (let index = at + 1; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "\n") return undefined;
    if (char === '"' || char === "'") {
      return index === at + 1 ? undefined : text.slice(at + 1, index);
    }
  }
  return undefined;
}

function matchEsmReexportSpecifier(text: string, afterKeyword: number): string | undefined {
  if (afterKeyword >= text.length || !/\s/u.test(text.charAt(afterKeyword))) return undefined;
  let index = skipWhitespaceRun(text, afterKeyword);
  if (text.charAt(index) === "*") {
    index += 1;
  } else if (text.charAt(index) === "{") {
    const closeIndex = text.indexOf("}", index + 1);
    if (closeIndex === -1) return undefined;
    index = closeIndex + 1;
  } else {
    return undefined;
  }
  if (!/\s/u.test(text.charAt(index))) return undefined;
  index = skipWhitespaceRun(text, index);
  if (!text.startsWith("from", index)) return undefined;
  index += "from".length;
  if (!/\s/u.test(text.charAt(index))) return undefined;
  return readReexportSpecifier(text, skipWhitespaceRun(text, index));
}

function normalizeScopePath(scopePath: string): string {
  return path.normalize(scopePath.replaceAll("\\", "/")).replace(/^\.\//u, "");
}

function lineNumberOf(text: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex && i < text.length; i += 1) {
    if (text.codePointAt(i) === 10) line += 1;
  }
  return line;
}

function collectEsmStaticImports(text: string, hits: ImportSpecifierHit[]): void {
  ESM_IMPORT_KEYWORD.lastIndex = 0;
  let match: RegExpExecArray | null = ESM_IMPORT_KEYWORD.exec(text);
  while (match !== null) {
    const afterKeyword = match.index + match[0].length;
    const specifier = matchEsmStaticImportSpecifier(text, afterKeyword);
    if (specifier !== undefined) {
      hits.push({
        specifier: specifier.value,
        kind: "static-import",
        line: lineNumberOf(text, match.index),
        ordinal: hits.length,
      });
    }
    ESM_IMPORT_KEYWORD.lastIndex = afterKeyword;
    match = ESM_IMPORT_KEYWORD.exec(text);
  }
}

function collectEsmReexports(text: string, hits: ImportSpecifierHit[]): void {
  ESM_REEXPORT_KEYWORD.lastIndex = 0;
  let match: RegExpExecArray | null = ESM_REEXPORT_KEYWORD.exec(text);
  while (match !== null) {
    const afterKeyword = match.index + match[0].length;
    const specifier = matchEsmReexportSpecifier(text, afterKeyword);
    if (specifier !== undefined) {
      hits.push({
        specifier,
        kind: "re-export",
        line: lineNumberOf(text, match.index),
        ordinal: hits.length,
      });
    }
    ESM_REEXPORT_KEYWORD.lastIndex = afterKeyword;
    match = ESM_REEXPORT_KEYWORD.exec(text);
  }
}

function collectWithRegex(
  text: string,
  regex: RegExp,
  kind: ImportEdgeKind,
  hits: ImportSpecifierHit[],
): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null = regex.exec(text);
  while (match !== null) {
    const specifier = match[1];
    if (specifier !== undefined && specifier.length > 0) {
      hits.push({
        specifier,
        kind,
        line: lineNumberOf(text, match.index),
        ordinal: hits.length,
      });
    }
    match = regex.exec(text);
  }
}

export function collectImportSpecifiers(text: string): readonly ImportSpecifierHit[] {
  const hits: ImportSpecifierHit[] = [];
  collectEsmStaticImports(text, hits);
  collectEsmReexports(text, hits);
  collectWithRegex(text, CJS_REQUIRE, "commonjs-require", hits);
  collectWithRegex(text, DYNAMIC_IMPORT, "dynamic-import", hits);
  return hits.sort((a, b) => a.line - b.line || a.ordinal - b.ordinal);
}

function safeFileExists(
  scope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  candidatePaths: ReadonlySet<string>,
  resolverFailures: Set<string>,
): boolean {
  const normalized = normalizeScopePath(scopePath);
  if (
    normalized.startsWith("../") ||
    normalized === ".." ||
    isDenied(normalized) ||
    !candidatePaths.has(normalized)
  ) {
    return false;
  }
  try {
    const abs = resolveWithinWorkspace(scope.workspace.root, normalized);
    const contained = containedRealPathInfo(fs, scope.workspace.root, abs);
    if (!isCanonicalAllowedContainedPath(contained, scope.workspace.root, normalized)) {
      resolverFailures.add(normalized);
      return false;
    }
    const stat = fs.stat(contained.path);
    const allowed = stat.isFile && !(stat.hardLinkCount !== undefined && stat.hardLinkCount > 1);
    if (!allowed) resolverFailures.add(normalized);
    return allowed;
  } catch {
    resolverFailures.add(normalized);
    return false;
  }
}

function resolveModuleCandidate(
  scope: SearchScope,
  fs: WorkspaceFs,
  basePath: string,
  candidatePaths: ReadonlySet<string>,
  resolverFailures: Set<string>,
): string | undefined {
  const normalized = normalizeScopePath(basePath);
  const candidates = [
    normalized,
    ...RESOLVE_EXTENSIONS.map((ext) => `${normalized}${ext}`),
    ...RESOLVE_EXTENSIONS.map((ext) => path.join(normalized, `index${ext}`)),
  ];
  return candidates.find((candidate) =>
    safeFileExists(scope, fs, candidate, candidatePaths, resolverFailures),
  );
}

function readJson(scope: SearchScope, fs: WorkspaceFs, scopePath: string): ParsedJsonFile {
  try {
    const parsed: unknown = JSON.parse(
      readWorkspaceFile(scope.workspace, scopePath, { maxBytes: 256 * 1024 }, fs).text,
    );
    return {
      value:
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined,
      failed: false,
    };
  } catch {
    return { value: undefined, failed: true };
  }
}

function tsconfigAliases(
  scope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string | undefined,
): ImportMetadata<TsconfigAlias> {
  if (scopePath === undefined) return { items: [], filesSkipped: 0, truncated: false };
  const result = readJson(scope, fs, scopePath);
  const parsed = result.value;
  const compilerOptions = parsed?.compilerOptions as Record<string, unknown> | undefined;
  const paths = compilerOptions?.paths as Record<string, unknown> | undefined;
  const baseUrl = typeof compilerOptions?.baseUrl === "string" ? compilerOptions.baseUrl : ".";
  if (paths === undefined) {
    return { items: [], filesSkipped: result.failed ? 1 : 0, truncated: false };
  }
  const items = Object.entries(paths)
    .map(([pattern, value]) => ({
      pattern,
      targets: Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [],
      baseUrl,
    }))
    .filter((entry) => entry.targets.length > 0);
  return { items, filesSkipped: result.failed ? 1 : 0, truncated: false };
}

function packageInfos(
  scope: SearchScope,
  fs: WorkspaceFs,
  files: readonly string[],
  control: StructuralExecutionControl,
): ImportMetadata<PackageInfo> {
  const items: PackageInfo[] = [];
  let filesSkipped = 0;
  let truncated = false;
  for (const file of files.filter((candidate) => path.basename(candidate) === "package.json")) {
    if (structuralExecutionStopped(control)) {
      truncated = true;
      break;
    }
    const result = readJson(scope, fs, file);
    if (result.failed) filesSkipped += 1;
    const manifest = result.value;
    if (manifest === undefined || typeof manifest.name !== "string") continue;
    items.push({ name: manifest.name, rootPath: path.dirname(file), manifest });
    if (structuralExecutionStopped(control)) {
      truncated = true;
      break;
    }
  }
  items.sort((a, b) => b.name.length - a.name.length);
  return { items, filesSkipped, truncated };
}

function matchAliasPattern(
  alias: TsconfigAlias,
  specifier: string,
): { readonly capture: string } | undefined {
  const star = alias.pattern.indexOf("*");
  const prefix = star === -1 ? alias.pattern : alias.pattern.slice(0, star);
  const suffix = star === -1 ? "" : alias.pattern.slice(star + 1);
  const matches =
    star === -1
      ? specifier === alias.pattern
      : specifier.startsWith(prefix) && specifier.endsWith(suffix);
  if (!matches) return undefined;
  const capture =
    star === -1 ? "" : specifier.slice(prefix.length, specifier.length - suffix.length);
  return { capture };
}

function resolveAliasTargets(
  scope: SearchScope,
  fs: WorkspaceFs,
  alias: TsconfigAlias,
  capture: string,
  candidatePaths: ReadonlySet<string>,
  resolverFailures: Set<string>,
): string | undefined {
  for (const target of alias.targets) {
    const candidate = path.join(alias.baseUrl, target.split("*").join(capture));
    const resolved = resolveModuleCandidate(scope, fs, candidate, candidatePaths, resolverFailures);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function resolveAlias(
  scope: SearchScope,
  fs: WorkspaceFs,
  specifier: string,
  aliases: readonly TsconfigAlias[],
  candidatePaths: ReadonlySet<string>,
  resolverFailures: Set<string>,
): string | undefined {
  for (const alias of aliases) {
    const match = matchAliasPattern(alias, specifier);
    if (match === undefined) continue;
    const resolved = resolveAliasTargets(
      scope,
      fs,
      alias,
      match.capture,
      candidatePaths,
      resolverFailures,
    );
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function stringExportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  for (const key of ["import", "default", "require", "types"]) {
    const nested = stringExportTarget(object[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function packageExportTarget(pkg: PackageInfo, exportKey: string): string | undefined {
  const exportsField = pkg.manifest.exports;
  if (typeof exportsField === "string") {
    return exportKey === "." ? exportsField : undefined;
  }
  if (exportsField !== null && typeof exportsField === "object") {
    const exportsObject = exportsField as Record<string, unknown>;
    const declaredTarget = stringExportTarget(exportsObject[exportKey]);
    return declaredTarget ?? (exportKey === "." ? stringExportTarget(exportsObject) : undefined);
  }
  return undefined;
}

function packageFallbackTarget(pkg: PackageInfo, subpath: string): string {
  if (subpath.length > 0) return subpath.slice(1);
  const main =
    stringExportTarget(pkg.manifest.module) ?? stringExportTarget(pkg.manifest.main) ?? "index";
  return main;
}

function packageTarget(pkg: PackageInfo, subpath: string): PackageTarget {
  const exportKey = subpath.length === 0 ? "." : `.${subpath}`;
  const target = packageExportTarget(pkg, exportKey);
  if (target !== undefined) return { target, kind: "package-export" };
  return { target: packageFallbackTarget(pkg, subpath), kind: "package-fallback" };
}

function resolvePackage(
  scope: SearchScope,
  fs: WorkspaceFs,
  specifier: string,
  packages: readonly PackageInfo[],
  candidatePaths: ReadonlySet<string>,
  resolverFailures: Set<string>,
): { readonly path: string; readonly kind: ImportResolutionKind } | undefined {
  for (const pkg of packages) {
    if (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`)) continue;
    const subpath = specifier === pkg.name ? "" : specifier.slice(pkg.name.length);
    const target = packageTarget(pkg, subpath);
    const resolved = resolveModuleCandidate(
      scope,
      fs,
      path.join(pkg.rootPath, target.target),
      candidatePaths,
      resolverFailures,
    );
    if (resolved !== undefined) return { path: resolved, kind: target.kind };
  }
  return undefined;
}

// The resolver inputs one import specifier is resolved against: the workspace binding, the
// tsconfig aliases and workspace packages a bare specifier may match, the candidate set a
// resolution has to stay inside, and the failure sink that records an unreadable probe. They stay
// constant for a whole import-graph build except `resolverFailures`, which is the accumulator's,
// so they travel as one readonly context — the resolver entry points stay under the parameter bar
// (S107) and a new resolver input is threaded in one place instead of two signatures.
interface ImportResolutionContext {
  readonly scope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly aliases: readonly TsconfigAlias[];
  readonly packages: readonly PackageInfo[];
  readonly candidatePaths: ReadonlySet<string>;
  readonly resolverFailures: Set<string>;
}

function resolveImport(
  resolution: ImportResolutionContext,
  importer: string,
  specifier: string,
): { readonly path?: string; readonly kind: ImportResolutionKind } {
  const { scope, fs, candidatePaths, resolverFailures } = resolution;
  if (specifier.startsWith(".")) {
    const resolved = resolveModuleCandidate(
      scope,
      fs,
      path.join(path.dirname(importer), specifier),
      candidatePaths,
      resolverFailures,
    );
    return resolved === undefined ? { kind: "unresolved" } : { path: resolved, kind: "relative" };
  }
  const alias = resolveAlias(
    scope,
    fs,
    specifier,
    resolution.aliases,
    candidatePaths,
    resolverFailures,
  );
  if (alias !== undefined) return { path: alias, kind: "tsconfig-path" };
  const pkg = resolvePackage(
    scope,
    fs,
    specifier,
    resolution.packages,
    candidatePaths,
    resolverFailures,
  );
  return pkg === undefined ? { kind: "unresolved" } : { path: pkg.path, kind: pkg.kind };
}

function confidence(kind: ImportResolutionKind): number {
  if (kind === "relative") return 1;
  if (kind === "tsconfig-path") return 0.92;
  if (kind === "package-export") return 0.86;
  if (kind === "package-fallback") return 0.74;
  return 0.25;
}

function distance(importer: string, target: string | undefined): number {
  if (target === undefined) return 0;
  const from = path.dirname(importer).split("/").filter(Boolean);
  const to = path.dirname(target).split("/").filter(Boolean);
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared += 1;
  return from.length + to.length - shared * 2 + 1;
}

function score(confidenceValue: number, distanceValue: number): number {
  return Number((confidenceValue / (1 + Math.min(distanceValue, 8) * 0.08)).toFixed(3));
}

function buildEdge(
  resolution: ImportResolutionContext,
  importerPath: string,
  hit: ImportSpecifierHit,
): ResolvedImportEdge {
  const resolved = resolveImport(resolution, importerPath, hit.specifier);
  const confidenceValue = confidence(resolved.kind);
  const distanceValue = distance(importerPath, resolved.path);
  return {
    stableId: importEdgeStableId({
      importerPath,
      specifier: hit.specifier,
      targetPath: resolved.path,
      kind: hit.kind,
      line: hit.line,
      ordinal: hit.ordinal,
    }),
    importerPath,
    specifier: hit.specifier,
    targetPath: resolved.path,
    kind: hit.kind,
    resolutionKind: resolved.kind,
    line: hit.line,
    ordinal: hit.ordinal,
    confidence: confidenceValue,
    distance: distanceValue,
    score: score(confidenceValue, distanceValue),
  };
}

function addToIndex(
  index: Map<string, ResolvedImportEdge[]>,
  key: string | undefined,
  edge: ResolvedImportEdge,
): void {
  if (key === undefined) return;
  index.set(key, [...(index.get(key) ?? []), edge]);
}

function isImportSource(scopePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(scopePath).toLowerCase());
}

function isImportResolverMetadata(scopePath: string): boolean {
  const normalized = normalizeScopePath(scopePath);
  return normalized === "tsconfig.json" || path.basename(normalized) === "package.json";
}

function addAncestorDistances(distances: Map<string, number>, scopePath: string): void {
  const directory = path.dirname(normalizeScopePath(scopePath)).replace(/^\.$/u, "");
  const segments = directory.split("/").filter((segment) => segment.length > 0);
  for (let ancestorDepth = segments.length; ancestorDepth >= 0; ancestorDepth -= 1) {
    const ancestor = segments.slice(0, ancestorDepth).join("/");
    const distance = segments.length - ancestorDepth;
    const current = distances.get(ancestor);
    if (current === undefined || distance < current) {
      distances.set(ancestor, distance);
    }
  }
}

function rankResolverMetadata<T extends { readonly relativePath: string }>(
  metadata: readonly T[],
  sources: readonly { readonly relativePath: string }[],
): readonly T[] {
  const ancestorDistances = new Map<string, number>();
  for (const source of sources) addAncestorDistances(ancestorDistances, source.relativePath);
  return metadata
    .map((file) => ({
      file,
      distance: ancestorDistances.get(
        path.dirname(normalizeScopePath(file.relativePath)).replace(/^\.$/u, ""),
      ),
    }))
    .filter(({ distance }) => sources.length === 0 || distance !== undefined)
    .sort((left, right) => {
      const leftDistance = left.distance ?? Number.POSITIVE_INFINITY;
      const rightDistance = right.distance ?? Number.POSITIVE_INFINITY;
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return left.file.relativePath < right.file.relativePath
        ? -1
        : Number(left.file.relativePath > right.file.relativePath);
    })
    .map(({ file }) => file);
}

function boundedImportGraphInputs(candidateSet: CandidateSet, limits: SearchLimits): CandidateSet {
  const sourceInputs = candidateSet.files.filter((file) => isImportSource(file.relativePath));
  const metadataInputs = candidateSet.files.filter(
    (file) => !isImportSource(file.relativePath) && isImportResolverMetadata(file.relativePath),
  );
  const fileBudget = Math.max(0, limits.maxFilesScanned);
  const metadataCapacity = sourceInputs.length === 0 ? fileBudget : Math.floor(fileBudget / 2);
  const rankedMetadata = rankResolverMetadata(metadataInputs, sourceInputs);
  const reservedMetadata = rankedMetadata.slice(0, metadataCapacity);
  const reservedPaths = new Set(reservedMetadata.map((file) => file.relativePath));
  return limitCandidateSetForStructuralBuild(
    {
      ...candidateSet,
      files: [
        ...reservedMetadata,
        ...sourceInputs,
        ...metadataInputs.filter((file) => !reservedPaths.has(file.relativePath)),
      ],
    },
    limits,
    () => true,
  );
}

async function readImportSource(
  scope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  limits: SearchLimits,
): Promise<string | undefined> {
  try {
    const absolutePath = resolveWithinWorkspace(scope.workspace.root, scopePath);
    const contained = containedRealPathInfo(fs, scope.workspace.root, absolutePath);
    if (!isCanonicalAllowedContainedPath(contained, scope.workspace.root, scopePath)) {
      return undefined;
    }
    const stat = fs.stat(contained.path);
    if (stat.hardLinkCount !== undefined && stat.hardLinkCount > 1) return undefined;
    if (await probeBinary(fs, contained.path, stat.size)) return undefined;
    return readWorkspaceFile(
      scope.workspace,
      scopePath,
      { maxBytes: limits.maxBytesPerFileScanned },
      fs,
    ).text;
  } catch {
    return undefined;
  }
}

export function importersForTarget(
  graph: ImportGraph,
  targetPath: string,
  options: ImportGraphTraversalOptions = {},
): readonly ResolvedImportEdge[] {
  const direct = graph.reverse.get(normalizeScopePath(targetPath)) ?? [];
  if (options.transitive !== true) return direct;
  return traverseEdges(
    direct,
    (edge) => edge.importerPath,
    (key) => graph.reverse.get(key) ?? [],
  );
}

function traverseEdges(
  seed: readonly ResolvedImportEdge[],
  nextKey: (edge: ResolvedImportEdge) => string | undefined,
  lookup: (key: string) => readonly ResolvedImportEdge[],
): readonly ResolvedImportEdge[] {
  const visitedEdges = new Set<string>();
  const visitedNodes = new Set<string>();
  const queue = [...seed];
  const result: ResolvedImportEdge[] = [];
  let index = 0;
  while (index < queue.length) {
    const edge = queue[index];
    index += 1;
    if (edge === undefined || visitedEdges.has(edge.stableId)) continue;
    visitedEdges.add(edge.stableId);
    result.push(edge);
    const key = nextKey(edge);
    if (key === undefined || visitedNodes.has(key)) continue;
    visitedNodes.add(key);
    queue.push(...lookup(key));
  }
  return result;
}

export function importsFromSource(
  graph: ImportGraph,
  importerPath: string,
  options: ImportGraphTraversalOptions = {},
): readonly ResolvedImportEdge[] {
  const direct = graph.forward.get(normalizeScopePath(importerPath)) ?? [];
  if (options.transitive !== true) return direct;
  return traverseEdges(
    direct,
    (edge) => edge.targetPath,
    (key) => graph.forward.get(key) ?? [],
  );
}

export async function buildImportGraph(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
): Promise<ImportGraph> {
  const control = createStructuralExecutionControl(limits.elapsedMsMax, Date.now);
  return buildImportGraphFromCandidates(
    scope,
    limits,
    fs,
    gatherCandidatesWithControl(scope, limits, fs, control),
    control,
  );
}

interface ImportGraphCollection {
  readonly edges: readonly ResolvedImportEdge[];
  readonly forward: ReadonlyMap<string, readonly ResolvedImportEdge[]>;
  readonly reverse: ReadonlyMap<string, readonly ResolvedImportEdge[]>;
  readonly filesScanned: number;
  readonly filesSkipped: number;
  readonly truncated: boolean;
}

interface ImportGraphAccumulator {
  readonly edges: ResolvedImportEdge[];
  readonly forward: Map<string, ResolvedImportEdge[]>;
  readonly reverse: Map<string, ResolvedImportEdge[]>;
  readonly resolverFailures: Set<string>;
}

interface ImportGraphScanState {
  readonly accumulator: ImportGraphAccumulator;
  readonly sourceFailures: Set<string>;
  filesScanned: number;
}

function createImportGraphScanState(): ImportGraphScanState {
  return {
    accumulator: {
      edges: [],
      forward: new Map(),
      reverse: new Map(),
      resolverFailures: new Set(),
    },
    sourceFailures: new Set(),
    filesScanned: 0,
  };
}

// The scan inputs that stay fixed for a whole import-graph build: the workspace binding, the
// resolver metadata every edge is resolved against, and the execution control the scan is bounded
// by. They travel as one readonly context so the scan helpers stay under the parameter bar (S107)
// and so a new resolver input is threaded in one place instead of four signatures.
interface ImportGraphScanContext {
  readonly scope: SearchScope;
  readonly limits: SearchLimits;
  readonly fs: WorkspaceFs;
  readonly aliases: ImportMetadata<TsconfigAlias>;
  readonly packages: ImportMetadata<PackageInfo>;
  readonly candidatePaths: ReadonlySet<string>;
  readonly control: StructuralExecutionControl;
}

// Narrows the fixed scan context to the resolver view, binding the accumulator's failure sink so
// every edge of one file records its unreadable probes in the same place.
function importResolutionContext(
  context: ImportGraphScanContext,
  resolverFailures: Set<string>,
): ImportResolutionContext {
  return {
    scope: context.scope,
    fs: context.fs,
    aliases: context.aliases.items,
    packages: context.packages.items,
    candidatePaths: context.candidatePaths,
    resolverFailures,
  };
}

function appendImportEdges(
  context: ImportGraphScanContext,
  accumulator: ImportGraphAccumulator,
  file: string,
  text: string,
): boolean {
  const resolution = importResolutionContext(context, accumulator.resolverFailures);
  for (const hit of collectImportSpecifiers(text)) {
    if (structuralExecutionStopped(context.control)) return false;
    const edge = buildEdge(resolution, file, hit);
    accumulator.edges.push(edge);
    addToIndex(accumulator.forward, edge.importerPath, edge);
    addToIndex(accumulator.reverse, edge.targetPath, edge);
  }
  return true;
}

async function scanImportFile(
  context: ImportGraphScanContext,
  state: ImportGraphScanState,
  file: string,
): Promise<boolean> {
  if (structuralExecutionStopped(context.control)) return false;
  const text = await readImportSource(context.scope, context.fs, file, context.limits);
  if (structuralExecutionStopped(context.control)) return false;
  if (text === undefined) {
    state.sourceFailures.add(file);
    return true;
  }
  state.filesScanned += 1;
  return (
    appendImportEdges(context, state.accumulator, file, text) &&
    !structuralExecutionStopped(context.control)
  );
}

async function collectImportGraph(
  context: ImportGraphScanContext,
  files: readonly string[],
): Promise<ImportGraphCollection> {
  const state = createImportGraphScanState();
  const metadataFilesSkipped = context.aliases.filesSkipped + context.packages.filesSkipped;
  const metadataTruncated = context.aliases.truncated || context.packages.truncated;
  let executionTruncated = false;
  for (const file of files) {
    if (!(await scanImportFile(context, state, file))) {
      executionTruncated = true;
      break;
    }
  }
  return {
    edges: state.accumulator.edges,
    forward: state.accumulator.forward,
    reverse: state.accumulator.reverse,
    filesScanned: state.filesScanned,
    filesSkipped:
      metadataFilesSkipped +
      new Set([...state.sourceFailures, ...state.accumulator.resolverFailures]).size,
    truncated: metadataTruncated || executionTruncated,
  };
}

export async function buildImportGraphFromCandidates(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  candidateSet: CandidateSet,
  executionControl?: StructuralExecutionControl,
): Promise<ImportGraph> {
  const control =
    executionControl ?? createStructuralExecutionControl(limits.elapsedMsMax, Date.now);
  const boundedInputs = boundedImportGraphInputs(candidateSet, limits);
  const inputPaths = boundedInputs.files.map((file) => file.relativePath);
  const files = inputPaths.filter(isImportSource);
  const metadataFiles = inputPaths.filter(isImportResolverMetadata);
  const candidatePaths = new Set(candidateSet.files.map((file) => file.relativePath));
  const aliases = structuralExecutionStopped(control)
    ? { items: [], filesSkipped: 0, truncated: true }
    : tsconfigAliases(
        scope,
        fs,
        metadataFiles.find((file) => normalizeScopePath(file) === "tsconfig.json"),
      );
  const packages = packageInfos(scope, fs, metadataFiles, control);
  const collected = await collectImportGraph(
    { scope, limits, fs, aliases, packages, candidatePaths, control },
    files,
  );
  return {
    edges: collected.edges,
    forward: collected.forward,
    reverse: collected.reverse,
    unresolved: collected.edges.filter((edge) => edge.targetPath === undefined),
    diagnostics: {
      filesScanned: collected.filesScanned,
      filesSkipped: collected.filesSkipped,
      truncated: boundedInputs.truncated || collected.truncated,
    },
  };
}
