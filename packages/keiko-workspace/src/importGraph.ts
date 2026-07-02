// Import-graph adapter (Epic #177, Issue #180; hardened in #1737). The public adapter still
// emits EvidenceAtom values for connected-context callers, but the scan now flows through the
// resolved import-edge graph so reverse dependency queries and package-boundary resolution share
// one bounded implementation.

import { createHash } from "node:crypto";
import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { RepoSearchInvalidQueryError } from "./errors.js";
import { buildImportGraph, type ResolvedImportEdge } from "./importGraphEdges.js";
import type { WorkspaceFs } from "./fs.js";
import { buildAtom } from "./repoSearchScan.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import type { StructuralAdapter, StructuralAdapterDeps } from "./structuralAdapters.js";

function queryFingerprint(query: RetrievalQuery): string {
  const canonical = JSON.stringify({ kind: query.kind, text: query.text });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

interface ScanContext {
  readonly scope: SearchScope;
  readonly query: RetrievalQuery;
  readonly fingerprint: string;
  readonly nowMs: () => number;
}

function textMatches(value: string, query: RetrievalQuery): boolean {
  if (query.kind === "exact-symbol") {
    return value === query.text;
  }
  return value.toLowerCase().includes(query.text.toLowerCase());
}

function edgeMatches(edge: ResolvedImportEdge, query: RetrievalQuery): boolean {
  return (
    textMatches(edge.specifier, query) ||
    (edge.targetPath !== undefined && textMatches(edge.targetPath, query))
  );
}

function queryRelevance(edge: ResolvedImportEdge, query: RetrievalQuery): number {
  if (edge.specifier === query.text || edge.targetPath === query.text) {
    return 1.0;
  }
  return 0.7;
}

function scoreFor(edge: ResolvedImportEdge, query: RetrievalQuery): number {
  return Number((edge.score * queryRelevance(edge, query)).toFixed(3));
}

function emitEdgeAtom(ctx: ScanContext, edge: ResolvedImportEdge): EvidenceAtom {
  return buildAtom({
    scopeId: ctx.scope.scopeId,
    scopePath: edge.importerPath,
    lineRange: { startLine: edge.line, endLine: edge.line },
    provenanceKind: "structural",
    tool: "import-graph",
    queryFingerprint: ctx.fingerprint,
    score: scoreFor(edge, ctx.query),
    emittedAtMs: ctx.nowMs(),
  });
}

function elapsedOver(nowMs: () => number, startMs: number, limits: SearchLimits): boolean {
  return nowMs() - startMs > limits.elapsedMsMax;
}

export const importGraphAdapter: StructuralAdapter = {
  name: "import-graph",
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
        `import-graph adapter does not accept query kind: ${query.kind}`,
      );
    }
    const nowMs = deps?.nowMs ?? Date.now;
    const startMs = nowMs();
    const ctx: ScanContext = {
      scope,
      query,
      fingerprint: queryFingerprint(query),
      nowMs,
    };
    const graph = await buildImportGraph(scope, limits, fs);
    const atoms: EvidenceAtom[] = [];
    for (const edge of graph.edges) {
      if (atoms.length >= limits.maxMatchesReturned || elapsedOver(nowMs, startMs, limits)) {
        break;
      }
      if (edgeMatches(edge, query)) {
        atoms.push(emitEdgeAtom(ctx, edge));
      }
    }
    return atoms;
  },
};
