// Markdown renderers for the review evaluation family (Issue #4132). Every rate is printed with
// its absolute counts and its Wilson interval, and an absent rate prints as an em dash, never 0 %.

import type { WilsonInterval } from "@oscharko-dev/keiko-contracts";

import type { ReviewBaseline, ReviewProducerBaseline } from "./baseline.js";
import type {
  ReviewOutcomeCounts,
  ReviewPrecisionGateResult,
  ReviewPrecisionSummary,
  ReviewSeedCaseReport,
  ReviewSeedGateReport,
} from "./types.js";

const PRODUCER_NAMES: Readonly<Record<string, string>> = {
  "keiko-for-quality": "Keiko for Quality",
  coderabbit: "CodeRabbit",
  codex: "Codex",
  qodo: "Qodo",
  human: "Human",
  other: "Other bots and deleted accounts",
};

function verdictLine(verdict: string, reasons: readonly string[]): string {
  const detail = reasons.length === 0 ? "" : ` (${reasons.join("; ")})`;
  return `- Verdict: ${verdict}${detail}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
}

/** `12.3 % (12/97; 95 % CI 7.1-20.4 %)`, or `— (0/0)` when nothing was counted. */
export function formatWilson(interval: WilsonInterval): string {
  const counts = `${String(interval.successes)}/${String(interval.trials)}`;
  if (interval.rate === null || interval.lower === null || interval.upper === null) {
    return `— (${counts})`;
  }
  const bounds = `${(interval.lower * 100).toFixed(1)}-${(interval.upper * 100).toFixed(1)} %`;
  return `${percent(interval.rate)} (${counts}; 95 % CI ${bounds})`;
}

function ratio(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

function producerRow(entry: ReviewProducerBaseline): string[] {
  return [
    PRODUCER_NAMES[entry.producer] ?? entry.producer,
    String(entry.pullRequestsReviewed),
    String(entry.threads),
    ratio(entry.findingsPerReviewedPullRequest),
    formatWilson(entry.threadChangeRate),
    String(entry.unmeasured),
    `${String(entry.refutations.total)} (${String(entry.refutations.confirmed)} confirmed, ${String(entry.refutations.contradicted)} contradicted)`,
    `${String(entry.hits)} / ${String(entry.falseAlarms)} / ${String(entry.undecided)}`,
    formatWilson(entry.acceptanceRate),
  ];
}

/** The per-producer baseline table of `docs/qa/review-agent-baseline-*.md`. */
export function renderReviewBaseline(baseline: ReviewBaseline): string {
  return table(
    [
      "Producer",
      "PRs reviewed",
      "Threads",
      "Findings per reviewed PR",
      "Thread-change rate",
      "Region unmeasured",
      "Refutations",
      "Hits / false alarms / undecided",
      "Acceptance rate",
    ],
    baseline.producers.map(producerRow),
  ).join("\n");
}

function outcomeRow(name: string, counts: ReviewOutcomeCounts): string[] {
  return [
    name,
    String(counts.findings),
    String(counts.hit),
    String(counts.falseAlarm),
    String(counts.undecided),
    String(counts.unmeasured),
    String(counts.unmatched),
    formatWilson(counts.actionableRate),
  ];
}

/** The precision gate report: verdict, overall and per-category/per-severity counts, cost. */
export function renderReviewPrecision(
  summary: ReviewPrecisionSummary,
  gate: ReviewPrecisionGateResult,
): string {
  const header = [
    "Population",
    "Findings",
    "Hits",
    "False alarms",
    "Undecided",
    "Unmeasured",
    "Unmatched (hand-graded)",
    "Actionable rate",
  ];
  const rows = [
    outcomeRow("All", summary.overall),
    ...Object.entries(summary.byCategory).map(([key, counts]) =>
      outcomeRow(`category ${key}`, counts),
    ),
    ...Object.entries(summary.bySeverity).map(([key, counts]) =>
      outcomeRow(`severity ${key}`, counts),
    ),
  ];
  return [
    verdictLine(gate.verdict, gate.reasons),
    `- Split: ${summary.split} (${summary.purpose}), holdout from #${String(summary.holdoutFromPullRequest)}`,
    `- Model: ${summary.modelId}; pull requests: ${String(summary.pullRequests)}`,
    `- Findings per pull request: mean ${ratio(summary.findingsPerPullRequest.mean)}, max ${String(summary.findingsPerPullRequest.max)}`,
    `- Cost per pull request: ${ratio(summary.cost.inputTokens.meanPerPullRequest)} input tokens, ${ratio(summary.cost.outputTokens.meanPerPullRequest)} output tokens, ${ratio(summary.cost.wallTimeMs.meanPerPullRequest)} ms wall time`,
    "",
    ...table(header, rows),
  ].join("\n");
}

function seedRole(entry: ReviewSeedCaseReport): string {
  if (entry.cleanControl) return "clean control";
  return entry.required ? "required" : "advisory";
}

/** The seed gate report: verdict, stale seeds, and every seed's outcome. */
export function renderReviewSeedGate(report: ReviewSeedGateReport): string {
  const rows = report.cases.map((entry) => [
    entry.id,
    seedRole(entry),
    entry.outcome,
    String(entry.findings),
    String(entry.falseAlarms),
  ]);
  return [
    verdictLine(report.verdict, report.reasons),
    `- Model: ${report.modelId}`,
    `- Required found: ${String(report.score.requiredFound)}/${String(report.score.requiredCount)}; stale seeds: ${String(report.staleSeeds.length)}`,
    `- False alarms on clean controls: ${String(report.cleanControlFalseAlarms)}`,
    "",
    ...table(["Seed", "Role", "Outcome", "Findings", "False alarms"], rows),
  ].join("\n");
}
