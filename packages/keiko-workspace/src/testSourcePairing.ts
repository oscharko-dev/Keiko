// Test/source pairing adapter (Epic #177, Issue #180). Given a workspace-relative path or a
// bare symbol name, it first pairs tests and source through resolved code-intelligence import
// edges, then falls back to deterministic naming conventions. Output normalized to EvidenceAtom
// via the shared buildAtom helper. Stays within ADR-0019 rule 3b: imports only
// @oscharko-dev/keiko-contracts, sibling workspace modules, and Node stdlib (node:crypto).

import { createHash } from "node:crypto";
import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import type { WorkspaceFs } from "./fs.js";
import { resolveWithinWorkspace } from "./paths.js";
import { assertContainedRealPath } from "./realpath.js";
import { buildCodeIntelligenceIndex, type CodeIntelligenceIndex } from "./codeIntelligence.js";
import { buildAtom, gatherCandidates } from "./repoSearchScan.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import type { StructuralAdapter, StructuralAdapterDeps } from "./structuralAdapters.js";

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
    out.push(`${base}_test`);
    out.push(`test_${base}`);
  }
  out.push(`${base}Test`);
  out.push(`${base}Tests`);
  out.push(`${base}Spec`);
  out.push(`${base}IT`);
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
      return `${prefix}/src/test/${segment}/${dir === "" ? testBase : `${dir}/${testBase}`}`;
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
      pushUnique(
        out,
        `${prefix}/src/main/${segment}/${dir === "" ? sourceBase : `${dir}/${sourceBase}`}`,
      );
    }
  }
  if (stem.startsWith("tests/")) {
    const rest = stem.slice(6);
    const dir = basenameOf(rest).dir;
    pushUnique(out, `src/${dir === "" ? sourceBase : `${dir}/${sourceBase}`}`);
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
    pushUnique(out, `${dir === "" ? testBase : `${dir}/${testBase}`}${ext}`);
    pushUnique(out, `${dir === "" ? "tests" : `${dir}/tests`}/${testBase}${ext}`);
  }
  return out;
}

// Map a test-shaped path back to its paired source path. The marker (".test." / ".spec.")
// and trailing extension are stripped to recover the stem; conventions are inverted to
// produce candidates in priority order.
// eslint-disable-next-line complexity -- Mirrors common test/source path conventions in priority order.
function candidateSourcesFor(path: string): readonly string[] {
  const parts = extractExtension(path);
  if (parts === undefined || !isTestPath(path)) {
    return [];
  }
  const { stem, ext } = parts;
  const { dir, base } = basenameOf(stem);
  const out: string[] = [];
  if (JS_LIKE_EXTENSIONS.has(ext) && TEST_MARKER_RE.test(path)) {
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
  }
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
    pushUnique(out, `${dir === "" ? sourceBase : `${dir}/${sourceBase}`}${ext}`);
  }
  return out;
}

interface PairContext {
  readonly scope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly fingerprint: string;
  readonly allowedPaths: ReadonlySet<string> | undefined;
  readonly codeIndex: CodeIntelligenceIndex;
}

function isAllowedPath(ctx: PairContext, relativePath: string): boolean {
  return ctx.allowedPaths === undefined || ctx.allowedPaths.has(relativePath);
}

function firstExistingPair(ctx: PairContext, candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (!isAllowedPath(ctx, candidate)) {
      continue;
    }
    const abs = resolveWithinWorkspace(ctx.scope.workspace.root, candidate);
    assertContainedRealPath(ctx.fs, ctx.scope.workspace.root, abs, "scope");
    if (ctx.fs.exists(abs)) {
      return candidate;
    }
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
    ctx.allowedPaths === undefined
      ? gatherCandidates(ctx.scope, limits, ctx.fs).files.map((file) => file.relativePath)
      : [...ctx.allowedPaths];
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
): ReadonlySet<string> | undefined {
  if (scope.relativePaths.length === 0) {
    return undefined;
  }
  return new Set(gatherCandidates(scope, limits, fs).files.map((file) => file.relativePath));
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
  lookup: async (
    scope: SearchScope,
    query: RetrievalQuery,
    limits: SearchLimits,
    fs: WorkspaceFs,
    deps?: StructuralAdapterDeps,
  ): Promise<readonly EvidenceAtom[]> => {
    try {
      return await runLookup(scope, query, limits, fs, deps);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  },
};

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
  const ctx: PairContext = {
    scope,
    fs,
    nowMs: deps?.nowMs ?? Date.now,
    fingerprint: queryFingerprint(query),
    allowedPaths: allowedPathsForScope(scope, limits, fs),
    codeIndex: buildCodeIntelligenceIndex(scope, limits, fs, deps),
  };
  const inputs = inputsForQuery(ctx, query, limits);
  const atoms: EvidenceAtom[] = [];
  for (const input of inputs) {
    if (atoms.length >= limits.maxMatchesReturned) {
      break;
    }
    for (const atom of pairsForPath(ctx, input)) {
      if (atoms.length >= limits.maxMatchesReturned) {
        break;
      }
      atoms.push(atom);
    }
  }
  return atoms;
}
