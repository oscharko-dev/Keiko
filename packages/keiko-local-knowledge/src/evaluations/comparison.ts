// Unified retrieval-mode comparison (Epic #1826, child #2010). Aggregates the scorecards the
// EXISTING eval harness already produces over the EXISTING fixtures into one per-mode view so a
// reviewer can see lexical vs. vector vs. fused movement in one place, instead of cross-
// referencing individual fixture rows. This adds NO parallel retrieval path and NO new
// fixtures: it groups the mode-representative fixtures that Epic #1817/#1818 already shipped and
// reports each leg's aggregate ranking metrics plus its headroom above the gate floor.
//
// Reranking is deliberately NOT modelled here. Its regression control (`reranker-off` /
// `reranker-reversed`) lives in `check:grounded-retrieval-quality` (keiko-server) and must not
// be duplicated; the ledger documents that ownership.
//
// Fusion-evidence gate (audit fix, #2010 defect): grouping fixtures under the "fused" label by
// taxonomy intent alone does NOT prove fusion contributed. Every fixture — lexical, vector, or
// fused-labelled — runs through the SAME unmodified `runLocalKnowledgeRetrieval` pipeline, so a
// "fused" row could clear the recall/precision floor even if RRF silently degraded to a single
// leg, as long as that one leg still finds the expected chunk. To close that gap without adding a
// parallel retrieval path, this module reads the production `RetrievalDiagnostics.mode` that
// `runLocalKnowledgeRetrieval` ALREADY reports per query (redacted enum tag, no bodies) and
// requires the "fused" row to show at least one query where BOTH the lexical and dense lanes
// produced candidates ("hybrid" mode). A regression that collapsed fusion to one leg would zero
// out every "hybrid" observation and this gate would fail the row even though recall stayed 1.0.

import type { RetrievalEvalScorecard } from "./types.js";
import { PASS_THRESHOLDS } from "./types.js";

const HYBRID_MODE = "hybrid";

export type RetrievalComparisonMode = "lexical" | "vector" | "fused";

// Each mode-representative fixture mapped to the retrieval leg it exercises, per the #2008
// taxonomy. Only fixtures whose PURPOSE is to demonstrate a specific leg appear here; the other
// shipped fixtures gate different dimensions (citation, context budget, source isolation,
// no-evidence, sealed-pod policy) and are intentionally excluded from the leg comparison.
export const RETRIEVAL_COMPARISON_MODE_MAP: Readonly<Record<string, RetrievalComparisonMode>> =
  Object.freeze({
    "exact-technical": "lexical",
    "semantic-paraphrase": "vector",
    "multilingual-retrieval": "vector",
    "broad-query-diversity": "fused",
    "mixed-strategy": "fused",
    "multi-space": "fused",
  });

const MODE_ORDER: readonly RetrievalComparisonMode[] = ["lexical", "vector", "fused"];

export interface RetrievalComparisonRow {
  readonly mode: RetrievalComparisonMode;
  readonly fixtureIds: readonly string[];
  readonly recall: number;
  readonly precision: number;
  readonly meanReciprocalRank: number;
  readonly ndcg: number;
  // Delta of the weakest ranking metric above its pass floor. Negative ⇒ this leg regressed
  // below the gate floor, so the comparison surfaces a mode-specific regression rather than
  // hiding it inside a single aggregate score.
  readonly floorHeadroom: number;
  // Number of underlying queries whose production `RetrievalDiagnostics.mode` was "hybrid"
  // (both the lexical and dense lanes produced candidates that were RRF-fused). Always 0 for
  // the "lexical"/"vector" rows by construction of those fixtures; required to be > 0 for the
  // "fused" row — see the fusion-evidence gate note at the top of this file.
  readonly hybridQueryCount: number;
  readonly passed: boolean;
}

export interface RetrievalModeComparison {
  readonly rows: readonly RetrievalComparisonRow[];
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function hybridQueryCountOf(cards: readonly RetrievalEvalScorecard[]): number {
  let count = 0;
  for (const card of cards) {
    count += card.outcomes.retrievalModeCounts[HYBRID_MODE] ?? 0;
  }
  return count;
}

// The "fused" row's whole purpose is to demonstrate fusion happened, not merely that its
// fixtures' recall/precision cleared the floor (a single surviving leg could do that too). So,
// unlike "lexical"/"vector", it additionally requires direct evidence — at least one query
// where both lanes contributed — on top of the shared floor check.
function passesFusionEvidence(mode: RetrievalComparisonMode, hybridQueryCount: number): boolean {
  if (mode !== "fused") return true;
  return hybridQueryCount > 0;
}

// A row's `passed` must reflect only the dimensions the row itself displays and aggregates
// (recall/precision/MRR/nDCG) plus the fusion-evidence gate above — never an orthogonal
// per-card dimension the row does not surface (citationQuality, contextBudgetFit,
// sourceIsolation, noEvidenceAccuracy). Those dimensions are already reported per-fixture by
// `localKnowledgeFailuresFor` in the shipping gate; folding them into `card.passed` here would
// fail a mode row for a reason the table cannot explain (audit fix, #2016 post-merge audit).
function clearsAggregateFloor(
  recall: number,
  precision: number,
  meanReciprocalRank: number,
  ndcg: number,
): boolean {
  return (
    recall >= PASS_THRESHOLDS.recall &&
    precision >= PASS_THRESHOLDS.precision &&
    meanReciprocalRank >= PASS_THRESHOLDS.meanReciprocalRank &&
    ndcg >= PASS_THRESHOLDS.ndcg
  );
}

function rowForMode(
  mode: RetrievalComparisonMode,
  cards: readonly RetrievalEvalScorecard[],
): RetrievalComparisonRow {
  const recall = mean(cards.map((card) => card.dimensions.recall));
  const precision = mean(cards.map((card) => card.dimensions.precision));
  const meanReciprocalRank = mean(cards.map((card) => card.dimensions.meanReciprocalRank));
  const ndcg = mean(cards.map((card) => card.dimensions.ndcg));
  const floorHeadroom = Math.min(
    recall - PASS_THRESHOLDS.recall,
    meanReciprocalRank - PASS_THRESHOLDS.meanReciprocalRank,
    ndcg - PASS_THRESHOLDS.ndcg,
  );
  const hybridQueryCount = hybridQueryCountOf(cards);
  return {
    mode,
    fixtureIds: cards.map((card) => card.fixtureId),
    recall,
    precision,
    meanReciprocalRank,
    ndcg,
    floorHeadroom,
    hybridQueryCount,
    passed:
      clearsAggregateFloor(recall, precision, meanReciprocalRank, ndcg) &&
      passesFusionEvidence(mode, hybridQueryCount),
  };
}

// Groups the supplied scorecards by retrieval mode and reduces each group to one comparison
// row. Scorecards whose fixture id is not in `modeMap` are ignored; empty modes are omitted.
export function computeRetrievalModeComparison(
  scorecards: readonly RetrievalEvalScorecard[],
  modeMap: Readonly<Record<string, RetrievalComparisonMode>> = RETRIEVAL_COMPARISON_MODE_MAP,
): RetrievalModeComparison {
  const byMode = new Map<RetrievalComparisonMode, RetrievalEvalScorecard[]>();
  for (const card of scorecards) {
    const mode = modeMap[card.fixtureId];
    if (mode === undefined) continue;
    const bucket = byMode.get(mode) ?? [];
    bucket.push(card);
    byMode.set(mode, bucket);
  }
  const rows: RetrievalComparisonRow[] = [];
  for (const mode of MODE_ORDER) {
    const cards = byMode.get(mode);
    if (cards === undefined || cards.length === 0) continue;
    rows.push(rowForMode(mode, cards));
  }
  return { rows };
}

function format(value: number): string {
  return value.toFixed(3);
}

// Renders the comparison as a redacted markdown table: fixture ids, aggregate metrics, and
// pass state only — never raw queries or bodies, matching the sibling gate report.
export function renderRetrievalModeComparisonReport(comparison: RetrievalModeComparison): string {
  const header = [
    "# Local Knowledge Retrieval Mode Comparison",
    "",
    "| Mode | Fixtures | Recall | Precision | MRR | nDCG | Floor headroom | Hybrid queries | Pass |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  const rows = comparison.rows.map((row) => {
    const cells = [
      row.mode,
      row.fixtureIds.join(", "),
      format(row.recall),
      format(row.precision),
      format(row.meanReciprocalRank),
      format(row.ndcg),
      format(row.floorHeadroom),
      String(row.hybridQueryCount),
      row.passed ? "PASS" : "FAIL",
    ];
    return `| ${cells.join(" | ")} |`;
  });
  return [...header, ...rows].join("\n");
}
