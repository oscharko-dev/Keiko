// Test/source pairing adapter (Epic #177, Issue #180). Deterministic, pure-JS mapper that,
// given a workspace-relative path or a bare symbol name, locates the paired test (or paired
// source) file using fixed name conventions. Output normalized to EvidenceAtom via the shared
// buildAtom helper. Stays within ADR-0019 rule 3b: imports only @oscharko-dev/keiko-contracts,
// sibling workspace modules, and Node stdlib (node:crypto).

import { createHash } from "node:crypto";
import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import type { WorkspaceFs } from "./fs.js";
import { resolveWithinWorkspace } from "./paths.js";
import { assertContainedRealPath } from "./realpath.js";
import { buildAtom, gatherCandidates } from "./repoSearchScan.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import type { StructuralAdapter, StructuralAdapterDeps } from "./structuralAdapters.js";
import {
  buildImportGraph,
  importersForTarget,
  importsFromSource,
  type ImportGraph,
  type ResolvedImportEdge,
} from "./importGraphEdges.js";

// Canonical fingerprint shared by every structural adapter: SHA-256({kind,text}) → 16 hex chars.
function queryFingerprint(query: RetrievalQuery): string {
  const canonical = JSON.stringify({ kind: query.kind, text: query.text });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

const PATH_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TEST_MARKER_RE = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

function looksLikePath(text: string): boolean {
  return PATH_EXT_RE.test(text);
}

function extractExtension(path: string): { stem: string; ext: string } | undefined {
  const match = PATH_EXT_RE.exec(path);
  if (match === null) {
    return undefined;
  }
  return { stem: path.slice(0, match.index), ext: match[0] };
}

function basenameOf(stem: string): { dir: string; base: string } {
  const slash = stem.lastIndexOf("/");
  if (slash === -1) {
    return { dir: "", base: stem };
  }
  return { dir: stem.slice(0, slash), base: stem.slice(slash + 1) };
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
  if (stem.startsWith("src/")) {
    out.push(`tests/${stem.slice(4)}.test${ext}`);
  }
  out.push(`${stem}.test${ext}`);
  out.push(`${stem}.spec${ext}`);
  const nestedDir = dir === "" ? "__tests__" : `${dir}/__tests__`;
  out.push(`${nestedDir}/${base}.test${ext}`);
  return out;
}

// Map a test-shaped path back to its paired source path. The marker (".test." / ".spec.")
// and trailing extension are stripped to recover the stem; conventions are inverted to
// produce candidates in priority order.
function candidateSourcesFor(path: string): readonly string[] {
  const match = TEST_MARKER_RE.exec(path);
  if (match === null) {
    return [];
  }
  const stem = path.slice(0, match.index);
  const extWithDot = match[0].slice(match[0].lastIndexOf("."));
  const { dir, base } = basenameOf(stem);
  const out: string[] = [];
  if (stem.startsWith("tests/")) {
    out.push(`src/${stem.slice(6)}${extWithDot}`);
  }
  if (dir.endsWith("/__tests__")) {
    out.push(`${dir.slice(0, -"/__tests__".length)}/${base}${extWithDot}`);
  } else if (dir === "__tests__") {
    out.push(`${base}${extWithDot}`);
  }
  out.push(`${stem}${extWithDot}`);
  return Array.from(new Set(out));
}

interface PairContext {
  readonly scope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly fingerprint: string;
  readonly allowedPaths: ReadonlySet<string> | undefined;
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

function emitPairAtom(ctx: PairContext, pairedPath: string, score = 0.8): EvidenceAtom {
  return buildAtom({
    scopeId: ctx.scope.scopeId,
    scopePath: pairedPath,
    lineRange: undefined,
    provenanceKind: "structural",
    tool: "test-source-pairing",
    queryFingerprint: ctx.fingerprint,
    score,
    emittedAtMs: ctx.nowMs(),
  });
}

function compareEdges(a: ResolvedImportEdge, b: ResolvedImportEdge): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.importerPath !== b.importerPath) return a.importerPath < b.importerPath ? -1 : 1;
  return a.targetPath === b.targetPath ? 0 : (a.targetPath ?? "") < (b.targetPath ?? "") ? -1 : 1;
}

function importEdgePairForPath(
  ctx: PairContext,
  graph: ImportGraph | undefined,
  path: string,
): EvidenceAtom | undefined {
  if (graph === undefined) {
    return undefined;
  }
  const edges = TEST_MARKER_RE.test(path)
    ? importsFromSource(graph, path).filter(
        (edge) =>
          edge.targetPath !== undefined &&
          !TEST_MARKER_RE.test(edge.targetPath) &&
          isAllowedPath(ctx, edge.targetPath),
      )
    : importersForTarget(graph, path).filter(
        (edge) => TEST_MARKER_RE.test(edge.importerPath) && isAllowedPath(ctx, edge.importerPath),
      );
  const best = [...edges].sort(compareEdges)[0];
  if (best === undefined) {
    return undefined;
  }
  const pairedPath = TEST_MARKER_RE.test(path) ? best.targetPath : best.importerPath;
  return pairedPath === undefined ? undefined : emitPairAtom(ctx, pairedPath, 0.95);
}

function pairForPath(
  ctx: PairContext,
  path: string,
  graph: ImportGraph | undefined,
): EvidenceAtom | undefined {
  const importPair = importEdgePairForPath(ctx, graph, path);
  if (importPair !== undefined) {
    return importPair;
  }
  const isTest = TEST_MARKER_RE.test(path);
  const candidates = isTest ? candidateSourcesFor(path) : candidateTestsFor(path);
  const found = firstExistingPair(ctx, candidates);
  return found === undefined ? undefined : emitPairAtom(ctx, found);
}

function pathsForSymbol(ctx: PairContext, symbol: string, limits: SearchLimits): readonly string[] {
  const lowered = symbol.toLowerCase();
  const out: string[] = [];
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
    return pathsForSymbol(ctx, query.text, limits);
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
  };
  const inputs = inputsForQuery(ctx, query, limits);
  const graph = inputs.length === 0 ? undefined : await buildImportGraph(scope, limits, fs);
  const atoms: EvidenceAtom[] = [];
  for (const input of inputs) {
    if (atoms.length >= limits.maxMatchesReturned) {
      break;
    }
    const atom = pairForPath(ctx, input, graph);
    if (atom !== undefined) {
      atoms.push(atom);
    }
  }
  return atoms;
}
