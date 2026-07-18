// Optional semantic reranker seam for the connected-context assembler (Epic #177,
// Issue #183). Interface ONLY — no live model calls in this PR. A future PR will add a
// keiko-model-gateway-backed implementation behind capability + privacy + budget guards.
// The default `disabledReranker` is always unavailable and the assembler treats that as
// "skip reranking" rather than as an error.

import type { CandidateFile, EvidenceAtom } from "@oscharko-dev/keiko-contracts/connected-context";

export type RerankerAvailability =
  | { readonly available: true; readonly modelLabel: string }
  | { readonly available: false; readonly reason: string };

export interface RerankerSeam {
  readonly name: string;
  isAvailable(): Promise<RerankerAvailability>;
  rerank(
    candidates: readonly CandidateFile[],
    atomsByPath: ReadonlyMap<string, readonly EvidenceAtom[]>,
    topK: number,
  ): Promise<readonly CandidateFile[]>;
}

// No `await` in the body: a plain function returning `Promise.resolve(...)` of a
// synchronous, non-throwing value preserves the async surface without triggering
// `@typescript-eslint/require-await`. No try/catch: `Promise.resolve` of a plain object
// literal / readonly reference cannot throw synchronously, so a catch here would be dead
// defensive code (SonarCloud typescript:S4822).
function unavailable(): Promise<RerankerAvailability> {
  return Promise.resolve({
    available: false as const,
    reason: "reranker-not-configured",
  });
}

function identity(
  candidates: readonly CandidateFile[],
  _atomsByPath: ReadonlyMap<string, readonly EvidenceAtom[]>,
  _topK: number,
): Promise<readonly CandidateFile[]> {
  return Promise.resolve(candidates);
}

export const disabledReranker: RerankerSeam = {
  name: "disabled-reranker",
  isAvailable: unavailable,
  rerank: identity,
};
