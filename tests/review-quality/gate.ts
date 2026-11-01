// The offline review gate (Issue #4138, ADR-0182 D9): replays the development sample, the holdout
// or the seed sets through the real review pipeline and writes body-free evidence. Usage:
//
//   npm run review:quality-gate -- --set development|holdout|seeds [--variant ...] ...
//
// The evaluation family owns the holdout discipline, the scoring and the verdicts; this composition
// only supplies the review ports, the evaluation repository and the evidence. It runs one review at
// a time and stops the composed server when it is done.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ReviewSeedFixture } from "@oscharko-dev/keiko-contracts";
import { ReviewEval } from "@oscharko-dev/keiko-evaluations";

import {
  materializeSeedRepository,
  REVIEW_SEED_BASE_BRANCH,
  REVIEW_SEED_HEAD_BRANCH,
} from "../../packages/keiko-server/src/review/qualification/seedRepository.js";
import { REVIEW_SEED_CORPUS } from "../../packages/keiko-server/src/review/qualification/seed-corpus/index.js";
import { type GateArguments, parseGateArguments } from "./cli.js";
import {
  gateConfiguration,
  type GateConfiguration,
  renderGateCost,
  settlementCounts,
  summarizeGateCost,
} from "./evidence.js";
import {
  createGateReviewer,
  type GateReviewer,
  presentedLocations,
  presentedReports,
  UNUSED_EVALUATION_MODEL,
} from "./ports.js";
import { fileAt, git, hasCommit, prepareOverlay, preparePullRequest } from "./repository.js";
import { developmentSample, holdoutPullRequests } from "./selection.js";
import { type GateServer, startGateServer } from "./server.js";

const READINESS_TIMEOUT_MS = 900_000;

interface GateContext {
  readonly args: GateArguments;
  readonly server: GateServer;
  readonly reviewer: GateReviewer;
  readonly configuration: GateConfiguration;
  readonly dataset: ReviewEval.ReviewHarvestDataset;
}

function modelOptions(args: GateArguments): ReviewEval.ReviewModelOptions {
  return { mode: "live", modelId: args.reviewerModelId, factory: () => UNUSED_EVALUATION_MODEL };
}

/** Probes both models through the composition's readiness route, as an operator's start would. */
async function probeReadiness(args: GateArguments): Promise<Record<string, string>> {
  const outcomes: Record<string, string> = {};
  for (const modelId of [args.reviewerModelId, args.counterCheckerModelId]) {
    const response = await fetch(`http://127.0.0.1:${String(args.port)}/api/gateway/readiness`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-keiko-csrf": "1" },
      body: JSON.stringify({ modelId }),
      signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
    });
    const body = (await response.json()) as { readonly overallStatus?: string };
    outcomes[modelId] = `${String(response.status)}/${body.overallStatus ?? "unknown"}`;
  }
  return outcomes;
}

function preparedPullRequests(
  ctx: GateContext,
  selected: readonly number[],
): {
  readonly available: readonly number[];
  readonly unavailable: readonly number[];
} {
  const byNumber = new Map(ctx.dataset.pullRequests.map((pr) => [pr.number, pr]));
  const available: number[] = [];
  const unavailable: number[] = [];
  for (const number of selected) {
    const pullRequest = byNumber.get(number);
    const refs =
      pullRequest === undefined ? undefined : preparePullRequest(ctx.args.repository, pullRequest);
    (refs === undefined ? unavailable : available).push(number);
  }
  return { available, unavailable };
}

async function runReplay(ctx: GateContext): Promise<Record<string, unknown>> {
  const { args, dataset } = ctx;
  const holdout = args.set === "holdout";
  const selected = holdout
    ? holdoutPullRequests(dataset)
    : (args.pullRequests ?? developmentSample(dataset, args.sampleSize));
  const { available, unavailable } = preparedPullRequests(ctx, selected);
  const run = await ReviewEval.runReviewReplay({
    dataset,
    split: holdout ? "holdout" : "development",
    purpose: holdout ? "evaluation" : "tuning",
    tuningInputs: args.tuningInputs,
    pullRequests: available,
    model: modelOptions(args),
    port: {
      reviewPullRequest: async ({ pullRequest }) => {
        const refs = preparePullRequest(args.repository, pullRequest);
        if (refs === undefined)
          throw new Error(`pull request ${String(pullRequest.number)} lost its commits`);
        const { view, record } = await ctx.reviewer.review(
          `pr-${String(pullRequest.number)}`,
          args.repository,
          refs,
        );
        return { settlement: record.settlement, findings: presentedReports(view) };
      },
    },
  });
  const summary = ReviewEval.summarizeReviewPrecision(run);
  const verdict = ReviewEval.evaluateReviewPrecisionGate(summary);
  return {
    selected,
    unavailable,
    run,
    summary,
    verdict,
    markdown: ReviewEval.renderReviewPrecision(summary, verdict),
  };
}

function seedPort(ctx: GateContext, seedBase: string): ReviewEval.ReviewSeedPort {
  const seedRoot = join(ctx.args.stateDir, "review-gate-seeds");
  return {
    reviewSeed: async ({
      fixture,
    }: {
      readonly fixture: ReviewSeedFixture;
    }): Promise<ReviewEval.ReviewSeedPortResult> => {
      const id = fixture.seed.id;
      if (fixture.scope === "overlay") {
        const refs = prepareOverlay(ctx.args.repository, id, seedBase, fixture.headFiles);
        const { view, record } = await ctx.reviewer.review(`seed-${id}`, ctx.args.repository, refs);
        return {
          settlement: record.settlement,
          headMoved: view?.stale ?? false,
          findings: presentedLocations(view),
        };
      }
      const services = ctx.server.deps.reviewServices;
      if (services === undefined) throw new Error("the composition has no review services");
      const root = join(seedRoot, id);
      rmSync(root, { recursive: true, force: true });
      await materializeSeedRepository(
        root,
        fixture,
        services.reviewRunner(`review-gate-seed-${id}`),
      );
      try {
        const refs = { baseRef: REVIEW_SEED_BASE_BRANCH, headRef: REVIEW_SEED_HEAD_BRANCH };
        const { view, record } = await ctx.reviewer.review(`seed-${id}`, root, refs);
        return {
          settlement: record.settlement,
          headMoved: view?.stale ?? false,
          findings: presentedLocations(view),
        };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

async function runSeeds(ctx: GateContext): Promise<Record<string, unknown>> {
  const seedBase = ctx.configuration.checkoutCommit;
  if (!hasCommit(ctx.args.repository, seedBase)) {
    throw new Error("the evaluation repository lacks the checkout's commit; fetch it first");
  }
  const report = await ReviewEval.runReviewSeedGate({
    fixtures: REVIEW_SEED_CORPUS,
    consumerSeeds: {
      seeds: ReviewEval.KEIKO_CONSUMER_SEEDS,
      readFile: (path) => fileAt(ctx.args.repository, seedBase, path),
    },
    port: seedPort(ctx, seedBase),
    model: modelOptions(ctx.args),
  });
  return { seedBase, report, markdown: ReviewEval.renderReviewSeedGate(report) };
}

function writeEvidence(
  ctx: GateContext,
  readiness: Record<string, string>,
  result: Record<string, unknown>,
): string {
  const dir = resolve(ctx.args.outDir, `${ctx.args.iteration}-${ctx.args.variant}`);
  mkdirSync(dir, { recursive: true });
  const records = ctx.reviewer.records();
  const evidence = {
    set: ctx.args.set,
    variant: ctx.args.variant,
    iteration: ctx.args.iteration,
    models: { reviewer: ctx.args.reviewerModelId, counterChecker: ctx.args.counterCheckerModelId },
    gatewayGeneration: ctx.server.deps.gatewayConfig?.generation() ?? null,
    datasetDigest: ctx.dataset.digest,
    holdoutFromPullRequest: ReviewEval.REVIEW_EVALUATION_MANIFEST.holdoutFromPullRequest,
    configuration: ctx.configuration,
    readiness,
    activityLogReadiness: ctx.server.activityLogReadiness,
    settlements: settlementCounts(records),
    cost: summarizeGateCost(records),
    reviews: records,
    ...result,
  };
  writeFileSync(join(dir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(
    join(dir, "summary.md"),
    [
      typeof result.markdown === "string" ? result.markdown : "",
      renderGateCost(evidence.cost, evidence.settlements),
    ].join("\n"),
  );
  return dir;
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseGateArguments(argv);
  const checkout = process.cwd();
  const configuration = gateConfiguration(checkout, args);
  const manifest = ReviewEval.REVIEW_EVALUATION_MANIFEST;
  const dataset = ReviewEval.loadReviewHarvestDataset(resolve(checkout, manifest.datasetPath));
  if (dataset.digest !== manifest.datasetDigest)
    throw new Error("the harvest dataset digest does not match the manifest");
  git(args.repository, ["rev-parse", "--git-dir"]);
  const server = await startGateServer({
    stateDir: args.stateDir,
    repository: args.repository,
    configPath: args.configPath,
    port: args.port,
    variant: args.variant,
    env: process.env,
  });
  try {
    const readiness = await probeReadiness(args);
    const ctx: GateContext = {
      args,
      server,
      reviewer: createGateReviewer(server.deps, args),
      configuration,
      dataset,
    };
    const result = args.set === "seeds" ? await runSeeds(ctx) : await runReplay(ctx);
    const dir = writeEvidence(ctx, readiness, result);
    process.stdout.write(`review gate: evidence in ${dir}\n`);
  } finally {
    await server.close();
  }
}

await main(process.argv.slice(2));
