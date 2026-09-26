// Structural code-intelligence adapter. The exported name stays `importGraphAdapter` for API
// compatibility, while the implementation delegates to the request-local polyglot index.

import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";

import {
  buildCodeIntelligenceIndex,
  lookupCodeIntelligenceAtoms,
  queryCodeIntelligenceIndex,
  type CodeIntelligenceIndex,
} from "./codeIntelligence.js";
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
      deps?.requestContext?.assertGraphBinding(scope, limits, fs);
      assertSupportedQuery(query);
      if (deps?.requestContext === undefined) {
        return Promise.resolve(lookupCodeIntelligenceAtoms(scope, query, limits, fs, deps));
      }
      const nowMs = deps.nowMs ?? Date.now;
      return deps.requestContext.codeIntelligenceIndex().then((index) => {
        deps.requestContext?.assertGraphBinding(scope, limits, fs);
        return queryCodeIntelligenceIndex(scope, query, index, nowMs()).slice(
          0,
          Math.min(limits.maxMatchesReturned, query.maxResults),
        );
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  },
  coverage: async (
    scope: SearchScope,
    limits: SearchLimits,
    fs: WorkspaceFs,
    deps?: StructuralAdapterDeps,
  ) => {
    deps?.requestContext?.assertGraphBinding(scope, limits, fs);
    let index: CodeIntelligenceIndex;
    try {
      index = await (deps?.requestContext === undefined
        ? Promise.resolve(buildCodeIntelligenceIndex(scope, limits, fs, deps))
        : deps.requestContext.codeIntelligenceIndex());
    } catch {
      return undefined;
    }
    deps?.requestContext?.assertGraphBinding(scope, limits, fs);
    return {
      name: "import-graph",
      filesIndexed: index.filesIndexed,
      filesSkipped: index.filesSkipped,
      filesPartiallyIndexed: index.filesPartiallyIndexed,
      candidateLimitReached: index.candidateLimitReached,
      parserCoverage: index.parserCoverage,
    };
  },
};
