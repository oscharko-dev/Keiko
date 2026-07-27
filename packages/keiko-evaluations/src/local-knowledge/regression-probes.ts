// Canonical Local Knowledge non-tautology probes (ADR-0152 D5). The fixture registry has one owner
// here, beside the goldsets and runner it validates. Probes preserve the gold expectations and
// inject genuinely bad retrieval output at the scorer boundary; changing the golden answer into a
// decoy would only prove that two inconsistent goldens differ, not that bad system output is caught.

import type { RetrievalEvalFixture, RetrievalEvalScorecard } from "./types.js";
import { runRetrievalEval } from "./runner.js";

export const RETRIEVAL_REGRESSION_PROBE_FIXTURE_IDS: readonly string[] = Object.freeze([
  "exact-technical",
  "semantic-paraphrase",
  "multilingual-retrieval",
  "multi-space",
  "html-manual-structure",
  "code-repository",
  "chained-question",
  "html-manual-table-row",
  "html-manual-frameset",
  "html-manual-code-block",
  "html-manual-malformed",
  "html-manual-denied-link",
  "html-manual-index-page",
  "html-manual-multilingual",
  "confluence-connector-pod",
  "jira-connector-pod",
]);

export function hasRetrievalGroundTruth(fixture: RetrievalEvalFixture): boolean {
  return fixture.queries.some(
    (query) => query.expectedChunkIds !== undefined && query.expectedChunkIds.length > 0,
  );
}

export function runBadOutputRetrievalProbe(
  fixture: RetrievalEvalFixture,
): Promise<RetrievalEvalScorecard> {
  return runRetrievalEval(fixture, { transformReferences: () => [] });
}
