import { posix as path } from "node:path";
import { readWorkspaceFile } from "./discovery.js";
import type { WorkspaceFs } from "./fs.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo } from "./realpath.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import { gatherCandidates, probeBinary } from "./repoSearchScan.js";
import { importEdgeStableId } from "./stableId.js";

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
const ESM_IMPORT = /^\s*import(?:[ \t]+\S+(?:[ \t]+\S+)*[ \t]+from)?\s+["']([^"'\n]+)["']/gm;
const ESM_REEXPORT = /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"'\n]+)["']/gm;
const CJS_REQUIRE = /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

function normalizeScopePath(scopePath: string): string {
  return path.normalize(scopePath.split("\\").join("/")).replace(/^\.\//u, "");
}

function lineNumberOf(text: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
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
  collectWithRegex(text, ESM_IMPORT, "static-import", hits);
  collectWithRegex(text, ESM_REEXPORT, "re-export", hits);
  collectWithRegex(text, CJS_REQUIRE, "commonjs-require", hits);
  collectWithRegex(text, DYNAMIC_IMPORT, "dynamic-import", hits);
  return hits.sort((a, b) => a.line - b.line || a.ordinal - b.ordinal);
}

function safeFileExists(scope: SearchScope, fs: WorkspaceFs, scopePath: string): boolean {
  const normalized = normalizeScopePath(scopePath);
  if (normalized.startsWith("../") || normalized === ".." || isDenied(normalized)) return false;
  try {
    const abs = resolveWithinWorkspace(scope.workspace.root, normalized);
    const contained = containedRealPathInfo(fs, scope.workspace.root, abs);
    if (isDenied(normalizeScopePath(contained.realRelative))) return false;
    if (!fs.exists(contained.path)) return false;
    return fs.stat(contained.path).isFile;
  } catch {
    return false;
  }
}

function resolveModuleCandidate(
  scope: SearchScope,
  fs: WorkspaceFs,
  basePath: string,
): string | undefined {
  const normalized = normalizeScopePath(basePath);
  const candidates = [
    normalized,
    ...RESOLVE_EXTENSIONS.map((ext) => `${normalized}${ext}`),
    ...RESOLVE_EXTENSIONS.map((ext) => path.join(normalized, `index${ext}`)),
  ];
  return candidates.find((candidate) => safeFileExists(scope, fs, candidate));
}

function readJson(
  scope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
): Record<string, unknown> | undefined {
  try {
    return JSON.parse(
      readWorkspaceFile(scope.workspace, scopePath, { maxBytes: 256 * 1024 }, fs).text,
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function tsconfigAliases(scope: SearchScope, fs: WorkspaceFs): readonly TsconfigAlias[] {
  const parsed = readJson(scope, fs, "tsconfig.json");
  const compilerOptions = parsed?.compilerOptions as Record<string, unknown> | undefined;
  const paths = compilerOptions?.paths as Record<string, unknown> | undefined;
  const baseUrl = typeof compilerOptions?.baseUrl === "string" ? compilerOptions.baseUrl : ".";
  if (paths === undefined) return [];
  return Object.entries(paths)
    .map(([pattern, value]) => ({
      pattern,
      targets: Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [],
      baseUrl,
    }))
    .filter((entry) => entry.targets.length > 0);
}

function packageInfos(
  scope: SearchScope,
  fs: WorkspaceFs,
  files: readonly string[],
): readonly PackageInfo[] {
  return files
    .filter((file) => path.basename(file) === "package.json")
    .map((file) => ({ file, manifest: readJson(scope, fs, file) }))
    .filter(
      (entry): entry is { file: string; manifest: Record<string, unknown> } =>
        entry.manifest !== undefined,
    )
    .map((entry) => ({ name: entry.manifest.name, entry }))
    .filter(
      (
        entry,
      ): entry is { name: string; entry: { file: string; manifest: Record<string, unknown> } } =>
        typeof entry.name === "string",
    )
    .map(({ name, entry }) => ({
      name,
      rootPath: path.dirname(entry.file),
      manifest: entry.manifest,
    }))
    .sort((a, b) => b.name.length - a.name.length);
}

function resolveAlias(
  scope: SearchScope,
  fs: WorkspaceFs,
  specifier: string,
  aliases: readonly TsconfigAlias[],
): string | undefined {
  for (const alias of aliases) {
    const star = alias.pattern.indexOf("*");
    const prefix = star === -1 ? alias.pattern : alias.pattern.slice(0, star);
    const suffix = star === -1 ? "" : alias.pattern.slice(star + 1);
    if (
      star === -1
        ? specifier !== alias.pattern
        : !specifier.startsWith(prefix) || !specifier.endsWith(suffix)
    )
      continue;
    const capture =
      star === -1 ? "" : specifier.slice(prefix.length, specifier.length - suffix.length);
    for (const target of alias.targets) {
      const candidate = path.join(alias.baseUrl, target.split("*").join(capture));
      const resolved = resolveModuleCandidate(scope, fs, candidate);
      if (resolved !== undefined) return resolved;
    }
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
): { readonly path: string; readonly kind: ImportResolutionKind } | undefined {
  for (const pkg of packages) {
    if (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`)) continue;
    const subpath = specifier === pkg.name ? "" : specifier.slice(pkg.name.length);
    const target = packageTarget(pkg, subpath);
    const resolved = resolveModuleCandidate(scope, fs, path.join(pkg.rootPath, target.target));
    if (resolved !== undefined) return { path: resolved, kind: target.kind };
  }
  return undefined;
}

function resolveImport(
  scope: SearchScope,
  fs: WorkspaceFs,
  importer: string,
  specifier: string,
  aliases: readonly TsconfigAlias[],
  packages: readonly PackageInfo[],
): { readonly path?: string; readonly kind: ImportResolutionKind } {
  if (specifier.startsWith(".")) {
    const resolved = resolveModuleCandidate(
      scope,
      fs,
      path.join(path.dirname(importer), specifier),
    );
    return resolved === undefined ? { kind: "unresolved" } : { path: resolved, kind: "relative" };
  }
  const alias = resolveAlias(scope, fs, specifier, aliases);
  if (alias !== undefined) return { path: alias, kind: "tsconfig-path" };
  const pkg = resolvePackage(scope, fs, specifier, packages);
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
  scope: SearchScope,
  fs: WorkspaceFs,
  importerPath: string,
  hit: ImportSpecifierHit,
  aliases: readonly TsconfigAlias[],
  packages: readonly PackageInfo[],
): ResolvedImportEdge {
  const resolved = resolveImport(scope, fs, importerPath, hit.specifier, aliases, packages);
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

async function readImportSource(
  scope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  limits: SearchLimits,
): Promise<string | undefined> {
  try {
    const absolutePath = resolveWithinWorkspace(scope.workspace.root, scopePath);
    const contained = containedRealPathInfo(fs, scope.workspace.root, absolutePath);
    if (isDenied(normalizeScopePath(contained.realRelative))) return undefined;
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
  const candidateSet = gatherCandidates(scope, limits, fs);
  const files = candidateSet.files.map((file) => file.relativePath);
  const aliases = tsconfigAliases(scope, fs);
  const packages = packageInfos(scope, fs, files);
  const edges: ResolvedImportEdge[] = [];
  const forward = new Map<string, ResolvedImportEdge[]>();
  const reverse = new Map<string, ResolvedImportEdge[]>();
  for (const file of files) {
    if (!isImportSource(file)) continue;
    const text = await readImportSource(scope, fs, file, limits);
    if (text === undefined) continue;
    for (const hit of collectImportSpecifiers(text)) {
      const edge = buildEdge(scope, fs, file, hit, aliases, packages);
      edges.push(edge);
      addToIndex(forward, edge.importerPath, edge);
      addToIndex(reverse, edge.targetPath, edge);
    }
  }
  return {
    edges,
    forward,
    reverse,
    unresolved: edges.filter((edge) => edge.targetPath === undefined),
  };
}
