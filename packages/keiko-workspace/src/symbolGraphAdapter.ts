import { createHash } from "node:crypto";
import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { RepoSearchInvalidQueryError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import { buildAtom } from "./repoSearchScan.js";
import type {
  StructuralAdapter,
  StructuralAdapterDeps,
  StructuralCoverageDiagnostics,
} from "./structuralAdapters.js";
import {
  buildSymbolGraph,
  callsToSymbol,
  definitionsForSymbol,
  referencesForSymbol,
} from "./symbolGraphBuild.js";
import { candidateSymbolsForText } from "./symbolGraphLexing.js";
import type { SymbolGraph, SymbolGraphRecord } from "./symbolGraphTypes.js";

function queryFingerprint(query: RetrievalQuery): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind: query.kind, text: query.text, tool: "symbol-graph" }))
    .digest("hex")
    .slice(0, 16);
}

function emitRecordAtom(
  scope: SearchScope,
  record: SymbolGraphRecord,
  query: RetrievalQuery,
  nowMs: () => number,
): EvidenceAtom {
  return buildAtom({
    scopeId: scope.scopeId,
    scopePath: record.scopePath,
    lineRange: { startLine: record.line, endLine: record.line },
    provenanceKind: "structural",
    tool: "symbol-graph",
    queryFingerprint: queryFingerprint(query),
    score: record.confidence,
    emittedAtMs: nowMs(),
  });
}

function symbolCandidates(query: RetrievalQuery): readonly string[] {
  return query.kind === "exact-symbol" ? [query.text] : candidateSymbolsForText(query.text);
}

function recordsForQuery(graph: SymbolGraph, query: RetrievalQuery): readonly SymbolGraphRecord[] {
  const seen = new Set<string>();
  const out: SymbolGraphRecord[] = [];
  for (const symbol of symbolCandidates(query)) {
    for (const record of [
      ...definitionsForSymbol(graph, symbol),
      ...callsToSymbol(graph, symbol),
      ...referencesForSymbol(graph, symbol),
    ]) {
      if (seen.has(record.stableId)) continue;
      seen.add(record.stableId);
      out.push(record);
    }
  }
  return out.sort((a, b) => a.scopePath.localeCompare(b.scopePath) || a.line - b.line);
}

async function graphForRequest(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  deps: StructuralAdapterDeps | undefined,
): Promise<SymbolGraph> {
  deps?.requestContext?.assertGraphBinding(scope, limits, fs);
  const graph =
    deps?.requestContext === undefined
      ? await buildSymbolGraph(scope, limits, fs, deps?.signal)
      : await deps.requestContext.symbolGraph();
  deps?.requestContext?.assertGraphBinding(scope, limits, fs);
  return graph;
}

export const symbolGraphAdapter: StructuralAdapter = {
  name: "symbol-graph",
  isAvailable: (): Promise<boolean> => Promise.resolve(true),
  lookup: async (
    scope: SearchScope,
    query: RetrievalQuery,
    limits: SearchLimits,
    fs: WorkspaceFs,
    deps?: StructuralAdapterDeps,
  ): Promise<readonly EvidenceAtom[]> => {
    if (query.kind !== "natural-language" && query.kind !== "exact-symbol") {
      throw new RepoSearchInvalidQueryError(
        `symbol-graph adapter does not accept query kind: ${query.kind}`,
      );
    }
    const graph = await graphForRequest(scope, limits, fs, deps);
    const nowMs = deps?.nowMs ?? Date.now;
    return recordsForQuery(graph, query)
      .slice(0, Math.min(limits.maxMatchesReturned, query.maxResults))
      .map((record) => emitRecordAtom(scope, record, query, nowMs));
  },
  coverage: async (scope, limits, fs, deps): Promise<StructuralCoverageDiagnostics> => {
    const graph = await graphForRequest(scope, limits, fs, deps);
    return {
      name: "symbol-graph",
      filesIndexed: graph.diagnostics.filesScanned,
      filesSkipped: graph.diagnostics.filesSkipped,
      candidateLimitReached: graph.diagnostics.truncated,
      parserCoverage: [
        { parser: "polyglot-symbol-graph", filesIndexed: graph.diagnostics.filesScanned },
      ],
    };
  },
};
