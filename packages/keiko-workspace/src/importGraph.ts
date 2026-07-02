// Structural code-intelligence adapter. The exported name stays `importGraphAdapter` for API
// compatibility, but the implementation now builds a request-local polyglot graph: resolved
// imports/re-exports, definitions, call references, API route/client contracts, and DTO links.

import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { buildCodeIntelligenceIndex, lookupCodeIntelligenceAtoms } from "./codeIntelligence.js";
import { RepoSearchInvalidQueryError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import type { StructuralAdapter, StructuralAdapterDeps } from "./structuralAdapters.js";

function assertSupportedQuery(query: RetrievalQuery): void {
  if (query.kind === "natural-language" || query.kind === "exact-symbol") {
    return;
  }
  throw new RepoSearchInvalidQueryError(
    `code-intelligence adapter does not accept query kind: ${query.kind}`,
  );
}

export const importGraphAdapter: StructuralAdapter = {
  name: "import-graph",
  isAvailable: (): Promise<boolean> => Promise.resolve(true),
  lookup: (
    scope: SearchScope,
    query: RetrievalQuery,
    limits: SearchLimits,
    fs: WorkspaceFs,
    deps?: StructuralAdapterDeps,
  ): Promise<readonly EvidenceAtom[]> => {
    try {
      assertSupportedQuery(query);
      return Promise.resolve(lookupCodeIntelligenceAtoms(scope, query, limits, fs, deps));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  },
  coverage: (
    scope: SearchScope,
    limits: SearchLimits,
    fs: WorkspaceFs,
    deps?: StructuralAdapterDeps,
  ) => {
    try {
      const index = buildCodeIntelligenceIndex(scope, limits, fs, deps);
      return Promise.resolve({
        name: "import-graph",
        filesIndexed: index.filesIndexed,
        filesSkipped: index.filesSkipped,
        filesPartiallyIndexed: index.filesPartiallyIndexed,
        parserCoverage: index.parserCoverage,
      });
    } catch {
      return Promise.resolve(undefined);
    }
  },
};
