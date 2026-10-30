// The review seed gate (Issue #4132, ADR-0182 D9), ported in meaning from the retired reviewer's
// `seed-gate-lib.mjs`. It runs every seed fixture — the shipped synthetic corpus the caller passes
// in, plus the Keiko consumer seeds planted here — through the injected review port and scores the
// presented findings with `scoreReviewSeedRun`, the one seed scorer the server's pair
// qualification uses as well. This module never re-derives that rule: per-seed outcomes come from
// scoring each seed alone with the same function.
//
// The gate fails when any required seed is missed, incomplete or stale, and when any consumer seed
// no longer plants (a stale `find` blocks, it is never skipped). False alarms on clean controls are
// reported apart from the recall verdict. An incomplete run never counts as found — the settlement
// invariant that incomplete work never presents as clean — while its presented findings on a clean
// control still count as false alarms.

import type {
  ReviewCodeLocation,
  ReviewRunSettlement,
  ReviewSeedFixture,
  ReviewSeedRunResult,
  ReviewSeedScore,
} from "@oscharko-dev/keiko-contracts";
import { scoreReviewSeedRun } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-rules";
import type { ModelPort } from "@oscharko-dev/keiko-harness";

import type { ReviewConsumerSeed } from "./consumer-seeds.js";
import { measureReviewCase, resolveReviewModel, type ReviewModelOptions } from "./model.js";
import type {
  ReviewGateVerdict,
  ReviewRunCost,
  ReviewSeedCaseReport,
  ReviewSeedGateReport,
  ReviewSeedOutcome,
} from "./types.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** A consumer seed whose tier, requirement and demotion contradict the tier rules. */
export class ReviewSeedDefinitionError extends Error {
  readonly seedId: string;

  constructor(seedId: string, problem: string) {
    super(`review seed ${seedId}: ${problem}`);
    this.name = "ReviewSeedDefinitionError";
    this.seedId = seedId;
  }
}

function demotionProblem(seed: ReviewConsumerSeed): string | undefined {
  if (seed.demotion === undefined) {
    return seed.required ? undefined : "tier 2 needs a demotion to be advisory";
  }
  if (seed.required) return "a demoted seed is advisory";
  const dated = ISO_DATE.test(seed.demotion.date) && seed.demotion.evidence.trim() !== "";
  return dated ? undefined : "a demotion needs a YYYY-MM-DD date and evidence";
}

function requirementProblem(seed: ReviewConsumerSeed): string | undefined {
  if (seed.measurement) {
    return seed.required ? "a measurement seed is advisory by design" : undefined;
  }
  if (seed.tier === 1) {
    return seed.required && seed.demotion === undefined ? undefined : "a tier-1 seed is required";
  }
  return demotionProblem(seed);
}

function shapeProblem(seed: ReviewConsumerSeed): string | undefined {
  const fields = [seed.id, seed.file, seed.find, seed.replace, seed.rationale];
  if (fields.some((field) => field.trim() === "")) return "every text field must be non-empty";
  return seed.find === seed.replace
    ? "find and replace are identical — nothing is planted"
    : undefined;
}

/** Validates a consumer seed set at load time; throws before any model is called. */
export function assertConsumerSeeds(seeds: readonly ReviewConsumerSeed[]): void {
  const seen = new Set<string>();
  for (const seed of seeds) {
    const problem = shapeProblem(seed) ?? requirementProblem(seed);
    if (problem !== undefined) throw new ReviewSeedDefinitionError(seed.id, problem);
    if (seen.has(seed.id)) throw new ReviewSeedDefinitionError(seed.id, "duplicate id");
    seen.add(seed.id);
  }
}

export type PlantedConsumerSeed =
  | { readonly kind: "planted"; readonly fixture: ReviewSeedFixture }
  | {
      readonly kind: "stale";
      readonly seed: ReviewConsumerSeed;
      readonly reason: "file-missing" | "find-missing" | "find-ambiguous";
    };

function lineOfIndex(content: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (content.codePointAt(position) === 10) line += 1;
  }
  return line;
}

/**
 * Plants one consumer seed into the current content of its file. Zero and multiple matches are
 * both refusals: a seed that matches twice would plant an ambiguous defect. The expected range is
 * where the replacement sits in the seeded file, ignoring a trailing newline of the replacement.
 */
export function plantConsumerSeed(
  seed: ReviewConsumerSeed,
  content: string | undefined,
): PlantedConsumerSeed {
  if (content === undefined) return { kind: "stale", seed, reason: "file-missing" };
  const at = content.indexOf(seed.find);
  if (at === -1) return { kind: "stale", seed, reason: "find-missing" };
  if (content.includes(seed.find, at + 1)) return { kind: "stale", seed, reason: "find-ambiguous" };
  const seeded = content.slice(0, at) + seed.replace + content.slice(at + seed.find.length);
  const startLine = lineOfIndex(seeded, at);
  const lines = Math.max(1, seed.replace.replace(/\n$/u, "").split("\n").length);
  return {
    kind: "planted",
    fixture: {
      seed: {
        id: seed.id,
        seedClass: seed.seedClass,
        required: seed.required,
        cleanControl: false,
        expected: { file: seed.file, startLine, endLine: startLine + lines - 1 },
      },
      scope: "overlay",
      baseFiles: { [seed.file]: content },
      headFiles: { [seed.file]: seeded },
    },
  };
}

/** What the review pipeline under test returns for one seed fixture. */
export interface ReviewSeedPortResult {
  readonly settlement: ReviewRunSettlement;
  /** The head moved while the run was in flight; such a run can never count as found. */
  readonly headMoved: boolean;
  readonly findings: readonly ReviewCodeLocation[];
}

export interface ReviewSeedPort {
  readonly reviewSeed: (input: {
    readonly fixture: ReviewSeedFixture;
    readonly model: ModelPort;
    readonly signal: AbortSignal;
  }) => Promise<ReviewSeedPortResult>;
}

export interface ReviewSeedGateOptions {
  /** Ready fixtures, typically the server's synthetic qualification corpus. */
  readonly fixtures: readonly ReviewSeedFixture[];
  readonly consumerSeeds?:
    | {
        readonly seeds: readonly ReviewConsumerSeed[];
        /** Current content of a repository file, or undefined when it does not exist. */
        readonly readFile: (path: string) => string | undefined;
      }
    | undefined;
  readonly port: ReviewSeedPort;
  readonly model: ReviewModelOptions;
  readonly now?: (() => number) | undefined;
  readonly signal?: AbortSignal | undefined;
}

function runResultOf(
  fixture: ReviewSeedFixture,
  result: ReviewSeedPortResult,
): ReviewSeedRunResult {
  const counts = fixture.seed.cleanControl || result.settlement.kind === "complete";
  return {
    caseId: fixture.seed.id,
    outcome: result.headMoved ? "stale" : "settled",
    findings: counts ? result.findings : [],
  };
}

function outcomeOf(
  fixture: ReviewSeedFixture,
  result: ReviewSeedPortResult,
  score: ReviewSeedScore,
): ReviewSeedOutcome {
  if (fixture.seed.cleanControl) {
    if (score.falseAlarms > 0) return "false-alarm";
    return result.headMoved ? "stale-run" : "clean";
  }
  if (score.stale > 0) return "stale-run";
  if (score.found > 0) return "found";
  return result.settlement.kind === "complete" ? "missed" : "incomplete";
}

interface SeedRun {
  readonly result: ReviewSeedRunResult;
  readonly report: ReviewSeedCaseReport;
}

async function runFixture(
  fixture: ReviewSeedFixture,
  options: ReviewSeedGateOptions,
  signal: AbortSignal,
): Promise<SeedRun> {
  const model = resolveReviewModel(fixture.seed.id, options.model);
  const { result, cost } = await measureReviewCase(model, options.now ?? Date.now, (port) =>
    options.port.reviewSeed({ fixture, model: port, signal }),
  );
  const runResult = runResultOf(fixture, result);
  const score = scoreReviewSeedRun([fixture.seed], [runResult]);
  return {
    result: runResult,
    report: {
      id: fixture.seed.id,
      required: fixture.seed.required,
      cleanControl: fixture.seed.cleanControl,
      outcome: outcomeOf(fixture, result, score),
      findings: result.findings.length,
      falseAlarms: score.falseAlarms,
      cost,
    },
  };
}

const NO_COST: ReviewRunCost = { modelCalls: 0, inputTokens: 0, outputTokens: 0, wallTimeMs: 0 };

function staleReport(stale: Extract<PlantedConsumerSeed, { kind: "stale" }>): ReviewSeedCaseReport {
  return {
    id: stale.seed.id,
    required: stale.seed.required,
    cleanControl: false,
    outcome: "stale-seed",
    findings: 0,
    falseAlarms: 0,
    staleReason: stale.reason,
    cost: NO_COST,
  };
}

function plantAll(options: ReviewSeedGateOptions): readonly PlantedConsumerSeed[] {
  const consumer = options.consumerSeeds;
  if (consumer === undefined) return [];
  assertConsumerSeeds(consumer.seeds);
  return consumer.seeds.map((seed) => plantConsumerSeed(seed, consumer.readFile(seed.file)));
}

function verdictOf(
  score: ReviewSeedScore,
  staleSeeds: readonly string[],
  requiredFailures: readonly ReviewSeedCaseReport[],
): { readonly verdict: ReviewGateVerdict; readonly reasons: readonly string[] } {
  const reasons = [
    ...staleSeeds.map((id) => `seed ${id} is stale and must be recalibrated`),
    ...requiredFailures.map((report) => `required seed ${report.id} was ${report.outcome}`),
    ...(score.unmatchedResults > 0
      ? [`${String(score.unmatchedResults)} result(s) matched no seed`]
      : []),
  ];
  if (reasons.length > 0) return { verdict: "fail", reasons };
  if (score.requiredCount === 0)
    return { verdict: "unmeasured", reasons: ["no required seed ran"] };
  return { verdict: "pass", reasons };
}

/** Runs the seed gate and returns its report; consumer seeds are planted before any model call. */
export async function runReviewSeedGate(
  options: ReviewSeedGateOptions,
): Promise<ReviewSeedGateReport> {
  const planted = plantAll(options);
  const fixtures = [
    ...options.fixtures,
    ...planted.flatMap((entry) => (entry.kind === "planted" ? [entry.fixture] : [])),
  ];
  const stale = planted.flatMap((entry) => (entry.kind === "stale" ? [entry] : []));
  const signal = options.signal ?? new AbortController().signal;
  const runs: SeedRun[] = [];
  for (const fixture of fixtures) runs.push(await runFixture(fixture, options, signal));
  const score = scoreReviewSeedRun(
    fixtures.map((fixture) => fixture.seed),
    runs.map((run) => run.result),
  );
  const reports = [...runs.map((run) => run.report), ...stale.map(staleReport)];
  const staleSeeds = stale.map((entry) => entry.seed.id);
  const requiredFailures = reports.filter(
    (report) => report.required && report.outcome !== "found" && report.outcome !== "stale-seed",
  );
  return {
    ...verdictOf(score, staleSeeds, requiredFailures),
    modelId: options.model.modelId,
    score,
    staleSeeds,
    requiredFailures: requiredFailures.map((report) => report.id),
    cleanControlFalseAlarms: score.falseAlarms,
    cases: reports,
  };
}
