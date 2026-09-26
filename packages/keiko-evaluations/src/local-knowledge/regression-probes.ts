// Canonical Local Knowledge non-tautology probes (ADR-0152 D5). The fixture registry has one owner
// here, beside the goldsets and runner it validates. Probes preserve the gold expectations and
// inject genuinely bad retrieval output at the scorer boundary; changing the golden answer into a
// decoy would only prove that two inconsistent goldens differ, not that bad system output is caught.

import { ALL_FIXTURES } from "./fixtures.js";
import type { RetrievalEvalFixture, RetrievalEvalScorecard } from "./types.js";
import { runRetrievalEval } from "./runner.js";

export function hasRetrievalGroundTruth(fixture: RetrievalEvalFixture): boolean {
  return fixture.queries.some(
    (query) => query.expectedChunkIds !== undefined && query.expectedChunkIds.length > 0,
  );
}

// KEIKO-0288: derive the probe id list from the fixture registry so a new ground-truth fixture is
// automatically covered by check:retrieval-quality. Restating the ids as a hardcoded literal used to
// drop 10 fixtures (single-topic, multi-capsule, ambiguous-query, source-isolation, multi-page,
// structured-files, context-budget, stale-index, broad-query-diversity, mixed-strategy) from the
// non-tautology regression sweep without any test flipping. A fixtures.test.ts sync-check pins that
// every ground-truth fixture stays in this list.
export const RETRIEVAL_REGRESSION_PROBE_FIXTURE_IDS: readonly string[] = Object.freeze(
  ALL_FIXTURES.filter(hasRetrievalGroundTruth).map((fixture) => fixture.id),
);

export function runBadOutputRetrievalProbe(
  fixture: RetrievalEvalFixture,
): Promise<RetrievalEvalScorecard> {
  return runRetrievalEval(fixture, { transformReferences: () => [] });
}
