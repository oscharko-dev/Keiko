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

import type { RetrievalEvalScorecard } from "./types.js";
import { PASS_THRESHOLDS } from "./types.js";

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

function rowForMode(
  mode: RetrievalComparisonMode,
  cards: readonly RetrievalEvalScorecard[],
): RetrievalComparisonRow {
  const recall = mean(cards.map((card) => card.dimensions.recall));
  const meanReciprocalRank = mean(cards.map((card) => card.dimensions.meanReciprocalRank));
  const ndcg = mean(cards.map((card) => card.dimensions.ndcg));
  const floorHeadroom = Math.min(
    recall - PASS_THRESHOLDS.recall,
    meanReciprocalRank - PASS_THRESHOLDS.meanReciprocalRank,
    ndcg - PASS_THRESHOLDS.ndcg,
  );
  return {
    mode,
    fixtureIds: cards.map((card) => card.fixtureId),
    recall,
    precision: mean(cards.map((card) => card.dimensions.precision)),
    meanReciprocalRank,
    ndcg,
    floorHeadroom,
    passed: cards.every((card) => card.passed),
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
    "| Mode | Fixtures | Recall | Precision | MRR | nDCG | Floor headroom | Pass |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
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
      row.passed ? "PASS" : "FAIL",
    ];
    return `| ${cells.join(" | ")} |`;
  });
  return [...header, ...rows].join("\n");
}
