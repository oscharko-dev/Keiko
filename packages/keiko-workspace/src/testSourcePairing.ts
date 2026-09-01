// Test/source pairing adapter (Epic #177, Issue #180). Given a workspace-relative path or a
// bare symbol name, it first pairs tests and source through resolved code-intelligence import
// edges, then falls back to deterministic naming conventions. Output normalized to EvidenceAtom
// via the shared buildAtom helper. Stays within ADR-0019 rule 3b: imports only
// @oscharko-dev/keiko-contracts, sibling workspace modules, and Node stdlib (node:crypto).

import { createHash } from "node:crypto";
import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { PathDeniedError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import {
  assertContainedRealPath,
  containedRealPathInfo,
  isCanonicalAllowedContainedPath,
  realRootIsDeniedViaSymlink,
} from "./realpath.js";
import { buildCodeIntelligenceIndex, type CodeIntelligenceIndex } from "./codeIntelligence.js";
import { buildAtom, gatherCandidates, isIoError } from "./repoSearchScan.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import type {
  StructuralAdapter,
  StructuralAdapterDeps,
  StructuralCoverageDiagnostics,
} from "./structuralAdapters.js";

// Canonical fingerprint shared by every structural adapter: SHA-256({kind,text}) → 16 hex chars.
function queryFingerprint(query: RetrievalQuery): string {
  const canonical = JSON.stringify({ kind: query.kind, text: query.text });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

const CODE_EXTENSIONS = new Set([
  "cjs",
  "cpp",
  "cs",
  "cts",
  "fs",
  "go",
  "groovy",
  "java",
  "js",
  "jsx",
  "kt",
  "kts",
  "mjs",
  "mts",
  "php",
  "py",
  "pyi",
  "rb",
  "rs",
  "scala",
  "swift",
  "ts",
  "tsx",
  "vb",
]);
const JS_LIKE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const TEST_MARKER_RE = /\.(?:test|spec)\.[^.]+$/u;

function looksLikePath(text: string): boolean {
  return extractExtension(text) !== undefined;
}

function extractExtension(path: string): { stem: string; ext: string } | undefined {
  const dot = path.lastIndexOf(".");
  if (dot <= 0 || dot === path.length - 1) {
    return undefined;
  }
  const ext = path.slice(dot);
  if (!CODE_EXTENSIONS.has(ext.slice(1).toLowerCase())) {
    return undefined;
  }
  return { stem: path.slice(0, dot), ext };
}

function basenameOf(stem: string): { dir: string; base: string } {
  const slash = stem.lastIndexOf("/");
  if (slash === -1) {
    return { dir: "", base: stem };
  }
  return { dir: stem.slice(0, slash), base: stem.slice(slash + 1) };
}

function pushUnique(out: string[], candidate: string): void {
  if (!out.includes(candidate)) {
    out.push(candidate);
  }
}

function sourceLikeTestBase(base: string, ext: string): readonly string[] {
  const out: string[] = [];
  if (ext === ".go" || ext === ".py" || ext === ".pyi") {
    out.push(`${base}_test`, `test_${base}`);
  }
  out.push(`${base}Test`, `${base}Tests`, `${base}Spec`, `${base}IT`);
  return out;
}

function stripTestBase(base: string): readonly string[] {
  const out: string[] = [];
  if (base.startsWith("test_") && base.length > "test_".length) {
    out.push(base.slice("test_".length));
  }
  if (base.endsWith("_test") && base.length > "_test".length) {
    out.push(base.slice(0, -"_test".length));
  }
  for (const suffix of ["Tests", "Test", "Spec", "IT"]) {
    if (base.endsWith(suffix) && base.length > suffix.length) {
      out.push(base.slice(0, -suffix.length));
    }
  }
  return out;
}

function mapMainToTestStem(stem: string, testBase: string): string | undefined {
  for (const segment of ["java", "kotlin", "scala", "groovy"]) {
    const marker = `/src/main/${segment}/`;
    const index = stem.indexOf(marker);
    if (index >= 0) {
      const prefix = stem.slice(0, index);
      const rest = stem.slice(index + marker.length);
      const dir = basenameOf(rest).dir;
      const testFileName = dir === "" ? testBase : `${dir}/${testBase}`;
      return `${prefix}/src/test/${segment}/${testFileName}`;
    }
  }
  if (stem.startsWith("src/")) {
    return `tests/${stem.slice(4)}_${testBase}`;
  }
  return undefined;
}

function mapTestToMainStem(stem: string, sourceBase: string): readonly string[] {
  const out: string[] = [];
  for (const segment of ["java", "kotlin", "scala", "groovy"]) {
    const marker = `/src/test/${segment}/`;
    const index = stem.indexOf(marker);
    if (index >= 0) {
      const prefix = stem.slice(0, index);
      const rest = stem.slice(index + marker.length);
      const dir = basenameOf(rest).dir;
      const sourceFileName = dir === "" ? sourceBase : `${dir}/${sourceBase}`;
      pushUnique(out, `${prefix}/src/main/${segment}/${sourceFileName}`);
    }
  }
  if (stem.startsWith("tests/")) {
    const rest = stem.slice(6);
    const dir = basenameOf(rest).dir;
    const sourceFileName = dir === "" ? sourceBase : `${dir}/${sourceBase}`;
    pushUnique(out, `src/${sourceFileName}`);
  }
  return out;
}

function isTestPath(path: string): boolean {
  const parts = extractExtension(path);
  if (parts === undefined) {
    return false;
  }
  const lower = path.toLowerCase();
  const { base } = basenameOf(parts.stem);
  return (
    TEST_MARKER_RE.test(path) ||
    lower.includes("/src/test/") ||
    lower.includes("/tests/") ||
    lower.startsWith("tests/") ||
    base.startsWith("test_") ||
    base.endsWith("_test") ||
    /(?:test|tests|spec|it)$/u.test(base)
  );
}

// Map a source-shaped path to a prioritized list of candidate test paths.
function candidateTestsFor(path: string): readonly string[] {
  const parts = extractExtension(path);
  if (parts === undefined) {
    return [];
  }
  const { stem, ext } = parts;
  const { dir, base } = basenameOf(stem);
  const out: string[] = [];
  if (JS_LIKE_EXTENSIONS.has(ext)) {
    if (stem.startsWith("src/")) {
      pushUnique(out, `tests/${stem.slice(4)}.test${ext}`);
    }
    pushUnique(out, `${stem}.test${ext}`);
    pushUnique(out, `${stem}.spec${ext}`);
    const nestedDir = dir === "" ? "__tests__" : `${dir}/__tests__`;
    pushUnique(out, `${nestedDir}/${base}.test${ext}`);
  }
  for (const testBase of sourceLikeTestBase(base, ext)) {
    const mapped = mapMainToTestStem(stem, testBase);
    if (mapped !== undefined) {
      pushUnique(out, `${mapped}${ext}`);
    }
    const testFileName = dir === "" ? testBase : `${dir}/${testBase}`;
    pushUnique(out, `${testFileName}${ext}`);
    const testDir = dir === "" ? "tests" : `${dir}/tests`;
    pushUnique(out, `${testDir}/${testBase}${ext}`);
  }
  return out;
}

// Candidates derived from stripping a JS-like test marker (".test." / ".spec.") back to the
// source stem, including the __tests__/tests directory conventions for that stem.
function candidateSourcesFromTestMarker(
  path: string,
  stem: string,
  ext: string,
): readonly string[] {
  const out: string[] = [];
  if (!(JS_LIKE_EXTENSIONS.has(ext) && TEST_MARKER_RE.test(path))) {
    return out;
  }
  const marker = TEST_MARKER_RE.exec(path);
  const sourceStem = marker === null ? stem : path.slice(0, marker.index);
  const sourceDir = basenameOf(sourceStem).dir;
  const sourceBase = basenameOf(sourceStem).base;
  if (sourceStem.startsWith("tests/")) {
    pushUnique(out, `src/${sourceStem.slice(6)}${ext}`);
  }
  if (sourceDir.endsWith("/__tests__")) {
    pushUnique(out, `${sourceDir.slice(0, -"/__tests__".length)}/${sourceBase}${ext}`);
  } else if (sourceDir === "__tests__") {
    pushUnique(out, `${sourceBase}${ext}`);
  }
  pushUnique(out, `${sourceStem}${ext}`);
  return out;
}

// Candidates derived from stripped test-name suffixes/prefixes (Test/Spec/IT/test_/_test),
// mapped back through the main/test directory conventions in priority order.
function candidateSourcesFromNamingConvention(
  stem: string,
  dir: string,
  base: string,
  ext: string,
): readonly string[] {
  const out: string[] = [];
  for (const sourceBase of stripTestBase(base)) {
    for (const mapped of mapTestToMainStem(stem, sourceBase)) {
      pushUnique(out, `${mapped}${ext}`);
    }
    if (dir.endsWith("/tests")) {
      pushUnique(out, `${dir.slice(0, -"/tests".length)}/${sourceBase}${ext}`);
    }
    if (dir === "tests") {
      pushUnique(out, `${sourceBase}${ext}`);
    }
    const sourceFileName = dir === "" ? sourceBase : `${dir}/${sourceBase}`;
    pushUnique(out, `${sourceFileName}${ext}`);
  }
  return out;
}

// Map a test-shaped path back to its paired source path. The marker (".test." / ".spec.")
// and trailing extension are stripped to recover the stem; conventions are inverted to
// produce candidates in priority order.
function candidateSourcesFor(path: string): readonly string[] {
  const parts = extractExtension(path);
  if (parts === undefined || !isTestPath(path)) {
    return [];
  }
  const { stem, ext } = parts;
  const { dir, base } = basenameOf(stem);
  const out: string[] = [];
  for (const candidate of candidateSourcesFromTestMarker(path, stem, ext)) {
    pushUnique(out, candidate);
  }
  for (const candidate of candidateSourcesFromNamingConvention(stem, dir, base, ext)) {
    pushUnique(out, candidate);
  }
  return out;
}

interface PairContext {
  readonly scope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly fingerprint: string;
  readonly allowedPaths: ReadonlySet<string> | undefined;
  readonly candidatePaths?: readonly string[] | undefined;
  readonly candidatePathSet?: ReadonlySet<string> | undefined;
  readonly skippedSymbolicLinkSet?: ReadonlySet<string> | undefined;
  readonly codeIndex: CodeIntelligenceIndex;
}

function isAllowedPath(ctx: PairContext, relativePath: string): boolean {
  return ctx.allowedPaths === undefined || ctx.allowedPaths.has(relativePath);
}

function skippedSymbolicLinkAncestor(ctx: PairContext, candidate: string): string | undefined {
  let path = candidate;
  while (path !== "") {
    if (ctx.skippedSymbolicLinkSet?.has(path) === true) return path;
    const slash = path.lastIndexOf("/");
    path = slash < 0 ? "" : path.slice(0, slash);
  }
  return undefined;
}

function canonicalPairCandidatePath(ctx: PairContext, candidate: string): string {
  const absolutePath = resolveWithinWorkspace(ctx.scope.workspace.root, candidate);
  const contained = containedRealPathInfo(ctx.fs, ctx.scope.workspace.root, absolutePath);
  const realCandidate = contained.realRelative.replaceAll("\\", "/");
  const slash = candidate.lastIndexOf("/");
  const lexicalParent = slash < 0 ? "" : candidate.slice(0, slash);
  const missingCanonicalLeaf = contained.path === absolutePath && realCandidate === lexicalParent;
  const missingCanonicalLeafIsAllowed =
    missingCanonicalLeaf &&
    !isDenied(candidate) &&
    !isDenied(realCandidate) &&
    !realRootIsDeniedViaSymlink(contained.realBase, ctx.scope.workspace.root);
  if (
    !missingCanonicalLeafIsAllowed &&
    !isCanonicalAllowedContainedPath(contained, ctx.scope.workspace.root, candidate)
  ) {
    throw new PathDeniedError(
      `refusing to pair through an unsafe workspace alias: ${candidate}`,
      candidate,
    );
  }
  return contained.path;
}

function isCurrentPairCandidate(ctx: PairContext, candidate: string): boolean {
  try {
    const contained = canonicalPairCandidatePath(ctx, candidate);
    const stat = ctx.fs.stat(contained);
    return stat.isFile && !(stat.hardLinkCount !== undefined && stat.hardLinkCount > 1);
  } catch (error) {
    // A request-local inventory is a snapshot: a benign candidate may disappear before lookup.
    // Treat ordinary filesystem churn as a missing convention, while trust-boundary errors from
    // containment/deny checks remain fatal and cannot be downgraded to absence.
    if (!isIoError(error)) throw error;
    return false;
  }
}

function firstExistingPair(ctx: PairContext, candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (!isAllowedPath(ctx, candidate)) {
      continue;
    }
    // A request context freezes the adapter's exact candidate inventory. Use it only as a negative
    // prefilter so repeated queries do not probe missing conventions; a positive candidate still
    // passes the live containment/stat gate below to preserve TOCTOU-safe evidence emission.
    if (ctx.candidatePathSet !== undefined && !ctx.candidatePathSet.has(candidate)) {
      // Discovery intentionally omits symlinks but records their names in this internal inventory.
      // Revalidate only a candidate that crosses one of those trust-boundary omissions; genuinely
      // missing naming conventions require no filesystem probe and cannot produce evidence.
      const skippedLink = skippedSymbolicLinkAncestor(ctx, candidate);
      if (skippedLink !== undefined) {
        const absoluteLink = resolveWithinWorkspace(ctx.scope.workspace.root, skippedLink);
        assertContainedRealPath(ctx.fs, ctx.scope.workspace.root, absoluteLink, "scope");
      }
      continue;
    }
    if (isCurrentPairCandidate(ctx, candidate)) return candidate;
  }
  return undefined;
}

function emitPairAtom(
  ctx: PairContext,
  pairedPath: string,
  queryPath: string,
  confidence: "resolved" | "heuristic",
): EvidenceAtom {
  const queryIsTest = isTestPath(queryPath);
  const sourcePath = queryIsTest ? queryPath : pairedPath;
  const targetPath = queryIsTest ? pairedPath : queryPath;
  return buildAtom({
    scopeId: ctx.scope.scopeId,
    scopePath: pairedPath,
    lineRange: undefined,
    provenanceKind: "structural",
    tool: "test-source-pairing",
    queryFingerprint: ctx.fingerprint,
    edge: {
      kind: "test-source",
      source: { scopePath: sourcePath },
      target: { scopePath: targetPath },
      label: "test-source",
      confidence,
    },
    score: confidence === "resolved" ? 0.95 : 0.8,
    emittedAtMs: ctx.nowMs(),
  });
}

function graphPairsForPath(ctx: PairContext, path: string): readonly EvidenceAtom[] {
  const isTest = isTestPath(path);
  const paired = ctx.codeIndex.imports
    .filter((edge) =>
      isTest
        ? edge.importerPath === path &&
          edge.targetPath !== undefined &&
          !isTestPath(edge.targetPath)
        : edge.targetPath === path && isTestPath(edge.importerPath),
    )
    .map((edge) => (isTest ? edge.targetPath : edge.importerPath))
    .filter(
      (candidate): candidate is string => candidate !== undefined && isAllowedPath(ctx, candidate),
    );
  return [...new Set(paired)].map((candidate) => emitPairAtom(ctx, candidate, path, "resolved"));
}

function pairsForPath(ctx: PairContext, path: string): readonly EvidenceAtom[] {
  const graphPairs = graphPairsForPath(ctx, path);
  if (graphPairs.length > 0) {
    return graphPairs;
  }
  const isTest = isTestPath(path);
  const candidates = isTest ? candidateSourcesFor(path) : candidateTestsFor(path);
  const found = firstExistingPair(ctx, candidates);
  return found === undefined ? [] : [emitPairAtom(ctx, found, path, "heuristic")];
}

function symbolMatchesQuery(name: string, query: RetrievalQuery): boolean {
  return query.caseSensitive
    ? name === query.text
    : name.toLowerCase() === query.text.toLowerCase();
}

function pathsForSymbol(
  ctx: PairContext,
  query: RetrievalQuery,
  limits: SearchLimits,
): readonly string[] {
  const lowered = query.text.toLowerCase();
  const out: string[] = [];
  for (const symbol of ctx.codeIndex.symbols) {
    if (symbolMatchesQuery(symbol.name, query) && isAllowedPath(ctx, symbol.scopePath)) {
      pushUnique(out, symbol.scopePath);
    }
  }
  const files =
    ctx.candidatePaths ??
    (ctx.allowedPaths === undefined
      ? gatherCandidates(ctx.scope, limits, ctx.fs).files.map((file) => file.relativePath)
      : [...ctx.allowedPaths]);
  for (const relativePath of files) {
    const parts = extractExtension(relativePath);
    if (parts === undefined) {
      continue;
    }
    const base = basenameOf(parts.stem).base.replace(/\.(?:test|spec)$/, "");
    if (base.toLowerCase() === lowered) {
      out.push(relativePath);
    }
  }
  return out;
}

function allowedPathsForScope(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  candidatePaths?: readonly string[],
): ReadonlySet<string> | undefined {
  if (scope.relativePaths.length === 0) {
    return undefined;
  }
  return new Set(
    candidatePaths ?? gatherCandidates(scope, limits, fs).files.map((file) => file.relativePath),
  );
}

interface BoundedPairCandidatePaths {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

function boundedPairCandidatePaths(
  candidatePaths: readonly string[],
  limits: SearchLimits,
): BoundedPairCandidatePaths {
  const eligible = candidatePaths.filter((scopePath) => extractExtension(scopePath) !== undefined);
  const fileLimit = Math.max(0, limits.maxFilesScanned);
  return { paths: eligible.slice(0, fileLimit), truncated: eligible.length > fileLimit };
}

function inputsForQuery(
  ctx: PairContext,
  query: RetrievalQuery,
  limits: SearchLimits,
): readonly string[] {
  if (!looksLikePath(query.text)) {
    return pathsForSymbol(ctx, query, limits);
  }
  return isAllowedPath(ctx, query.text) ? [query.text] : [];
}

export const testSourcePairingAdapter: StructuralAdapter = {
  name: "test-source-pairing",
  isAvailable: (): Promise<boolean> => Promise.resolve(true),
  lookup: (
    scope: SearchScope,
    query: RetrievalQuery,
    limits: SearchLimits,
    fs: WorkspaceFs,
    deps?: StructuralAdapterDeps,
  ): Promise<readonly EvidenceAtom[]> => {
    try {
      deps?.requestContext?.assertGraphBinding(scope, limits, fs);
      return runLookup(scope, query, limits, fs, deps);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  },
  coverage: async (scope, limits, fs, deps): Promise<StructuralCoverageDiagnostics> => {
    deps?.requestContext?.assertGraphBinding(scope, limits, fs);
    const inventory = pairCandidateInventory(scope, limits, fs, deps);
    const index = await codeIndexForLookup(scope, limits, fs, deps);
    deps?.requestContext?.assertGraphBinding(scope, limits, fs);
    return {
      name: "test-source-pairing",
      filesIndexed: index.filesIndexed,
      filesSkipped: index.filesSkipped,
      filesPartiallyIndexed: index.filesPartiallyIndexed,
      candidateLimitReached: inventory.truncated || index.candidateLimitReached === true,
      parserCoverage: index.parserCoverage,
    };
  },
};

async function codeIndexForLookup(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  deps: StructuralAdapterDeps | undefined,
): Promise<CodeIntelligenceIndex> {
  if (deps?.requestContext !== undefined) {
    return await deps.requestContext.codeIntelligenceIndex();
  }
  return buildCodeIntelligenceIndex(scope, limits, fs, deps);
}

function collectPairAtoms(
  ctx: PairContext,
  query: RetrievalQuery,
  limits: SearchLimits,
): readonly EvidenceAtom[] {
  const atoms: EvidenceAtom[] = [];
  for (const input of inputsForQuery(ctx, query, limits)) {
    if (atoms.length >= limits.maxMatchesReturned) break;
    for (const atom of pairsForPath(ctx, input)) {
      if (atoms.length >= limits.maxMatchesReturned) break;
      atoms.push(atom);
    }
  }
  return atoms;
}

interface PairCandidateInventory {
  readonly paths: readonly string[];
  readonly skippedSymbolicLinks: readonly string[];
  readonly truncated: boolean;
}

function pairCandidateInventory(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  deps: StructuralAdapterDeps | undefined,
): PairCandidateInventory {
  if (deps?.requestContext !== undefined) {
    const bounded = boundedPairCandidatePaths(deps.requestContext.candidatePaths(), limits);
    return {
      paths: bounded.paths,
      skippedSymbolicLinks: deps.requestContext.skippedSymbolicLinks(),
      truncated: bounded.truncated || deps.requestContext.candidateLimitReached(),
    };
  }
  const candidates = gatherCandidates(scope, limits, fs);
  const bounded = boundedPairCandidatePaths(
    candidates.files.map((file) => file.relativePath),
    limits,
  );
  return {
    paths: bounded.paths,
    skippedSymbolicLinks: candidates.skippedSymbolicLinks,
    truncated: bounded.truncated || candidates.truncated,
  };
}

async function pairContextForLookup(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  fs: WorkspaceFs,
  deps: StructuralAdapterDeps | undefined,
): Promise<PairContext> {
  const inventory = pairCandidateInventory(scope, limits, fs, deps);
  return {
    scope,
    fs,
    nowMs: deps?.nowMs ?? Date.now,
    fingerprint: queryFingerprint(query),
    allowedPaths: allowedPathsForScope(scope, limits, fs, inventory.paths),
    candidatePaths: inventory.paths,
    candidatePathSet: new Set(inventory.paths),
    skippedSymbolicLinkSet: new Set(inventory.skippedSymbolicLinks),
    codeIndex: await codeIndexForLookup(scope, limits, fs, deps),
  };
}

async function runLookup(
  scope: SearchScope,
  query: RetrievalQuery,
  limits: SearchLimits,
  fs: WorkspaceFs,
  deps: StructuralAdapterDeps | undefined,
): Promise<readonly EvidenceAtom[]> {
  if (query.kind !== "natural-language" && query.kind !== "exact-symbol") {
    return [];
  }
  if (limits.maxMatchesReturned <= 0) {
    return [];
  }
  const pairContext = await pairContextForLookup(scope, query, limits, fs, deps);
  deps?.requestContext?.assertGraphBinding(scope, limits, fs);
  return collectPairAtoms(pairContext, query, limits);
}
