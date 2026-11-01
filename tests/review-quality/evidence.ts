// The evidence of one offline gate run (Issue #4138): what was run, on which configuration, with
// which result and at what cost, body-free. The configuration digest covers the committed review
// code, the counter-check and presentation limits, the variant and the model pair, so two runs
// with the same digest ran the same configuration. A run refuses to start when that code has
// uncommitted changes, because their digest would name a configuration nobody can check out.

import { createHash } from "node:crypto";

import type { GateArguments } from "./cli.js";
import { git } from "./repository.js";
import type { GateReviewRecord, RoleCost } from "./ports.js";

/** The paths whose committed content is the review configuration under test. */
export const CONFIGURATION_PATHS = [
  "packages/keiko-server/src/review",
  "packages/keiko-contracts/src/pull-request-review.ts",
  "packages/keiko-contracts/src/pull-request-review-rules.ts",
] as const;

const PROMPT_PATHS = [
  "packages/keiko-server/src/review/runtime/reviewPrompt.ts",
  "packages/keiko-server/src/review/counter-check/prompt.ts",
] as const;

export interface GateConfiguration {
  readonly checkoutCommit: string;
  readonly configurationDigest: string;
  readonly promptDigest: string;
  readonly objects: Readonly<Record<string, string>>;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** Reads the configuration identity of the checkout the gate runs from. */
export function gateConfiguration(checkout: string, args: GateArguments): GateConfiguration {
  const dirty = git(checkout, ["status", "--porcelain", "--", ...CONFIGURATION_PATHS]);
  if (dirty !== "") {
    throw new Error("the review configuration has uncommitted changes; commit them before a run");
  }
  const checkoutCommit = git(checkout, ["rev-parse", "HEAD"]);
  const objects: Record<string, string> = {};
  for (const path of [...CONFIGURATION_PATHS, ...PROMPT_PATHS]) {
    objects[path] = git(checkout, ["rev-parse", `HEAD:${path}`]);
  }
  const identity = {
    objects: CONFIGURATION_PATHS.map((path) => objects[path]),
    variant: args.variant,
    reviewerModelId: args.reviewerModelId,
    counterCheckerModelId: args.counterCheckerModelId,
  };
  return {
    checkoutCommit,
    configurationDigest: sha256(JSON.stringify(identity)),
    promptDigest: sha256(JSON.stringify(PROMPT_PATHS.map((path) => objects[path]))),
    objects,
  };
}

export interface RoleCostSummary {
  readonly total: RoleCost;
  readonly meanPerReview: RoleCost | null;
}

export interface GateCostSummary {
  readonly reviews: number;
  readonly reviewer: RoleCostSummary;
  readonly counterChecker: RoleCostSummary;
  readonly wallTimeMs: {
    readonly total: number;
    readonly median: number | null;
    readonly max: number;
  };
}

function sumCosts(costs: readonly RoleCost[]): RoleCost {
  return costs.reduce(
    (sum, cost) => ({
      promptTokens: sum.promptTokens + cost.promptTokens,
      completionTokens: sum.completionTokens + cost.completionTokens,
      durationMs: sum.durationMs + cost.durationMs,
    }),
    { promptTokens: 0, completionTokens: 0, durationMs: 0 },
  );
}

function roleSummary(costs: readonly RoleCost[]): RoleCostSummary {
  const total = sumCosts(costs);
  const count = costs.length;
  return {
    total,
    meanPerReview:
      count === 0
        ? null
        : {
            promptTokens: total.promptTokens / count,
            completionTokens: total.completionTokens / count,
            durationMs: total.durationMs / count,
          },
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? 0) + upper) / 2;
}

/** The cost of a run's reviews per role, as each review's own record accounted it. */
export function summarizeGateCost(records: readonly GateReviewRecord[]): GateCostSummary {
  const wallTimes = records.map((record) => record.wallTimeMs);
  return {
    reviews: records.length,
    reviewer: roleSummary(records.map((record) => record.reviewer)),
    counterChecker: roleSummary(records.map((record) => record.counterChecker)),
    wallTimeMs: {
      total: wallTimes.reduce((sum, value) => sum + value, 0),
      median: median(wallTimes),
      max: wallTimes.reduce((max, value) => Math.max(max, value), 0),
    },
  };
}

/** Settlement kinds and reasons over a run's reviews, as `kind` or `kind/reason`. */
export function settlementCounts(
  records: readonly GateReviewRecord[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const { settlement } of records) {
    const key =
      settlement.kind === "complete" ? "complete" : `${settlement.kind}/${settlement.reason}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function costRow(role: string, summary: RoleCostSummary): string {
  const mean = summary.meanPerReview;
  const cells =
    mean === null
      ? ["—", "—", "—"]
      : [mean.promptTokens, mean.completionTokens, mean.durationMs / 1000].map((value) =>
          value.toFixed(0),
        );
  return `| ${role} | ${cells.join(" | ")} | ${String(summary.total.promptTokens)} |`;
}

/**
 * The gate's own cost and settlement section of `summary.md`. The evaluation family meters only
 * its injected model port, which the composed pipeline never calls, so its cost line reads zero;
 * this section reports what each review's record accounted.
 */
export function renderGateCost(
  cost: GateCostSummary,
  settlements: Readonly<Record<string, number>>,
): string {
  const median = cost.wallTimeMs.median;
  return [
    "## Gate cost and settlements",
    "",
    "The cost line above is the evaluation family's metered port, which this composition does not call.",
    "",
    "| Role | Mean prompt tokens | Mean completion tokens | Mean duration (s) | Total prompt tokens |",
    "| --- | --- | --- | --- | --- |",
    costRow("Reviewer", cost.reviewer),
    costRow("Counter-checker", cost.counterChecker),
    "",
    `Median wall time per review: ${median === null ? "—" : `${(median / 1000).toFixed(0)} s`}.`,
    "",
    "| Settlement | Reviews |",
    "| --- | --- |",
    ...Object.entries(settlements)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => `| ${key} | ${String(count)} |`),
    "",
  ].join("\n");
}
