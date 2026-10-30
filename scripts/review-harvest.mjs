#!/usr/bin/env node
// Review harvest (Issue #4132, ADR-0182 D9): reads every review thread on a repository's merged and
// closed pull requests and writes the body-free, versioned dataset the review replay, precision
// gate and baseline read. Repository tooling, not product runtime: deterministic PASS/FAIL output,
// read-only against GitHub (one `gh api graphql` query shape and its node continuations), and
// outside the Activity Log rules.
//
//   node scripts/review-harvest.mjs --repo oscharko-dev/Keiko --git-dir <bare repo with refs/pull>
//     --checkpoint <file> --out packages/keiko-evaluations/src/review/fixtures/<dataset>.json.gz
//   node scripts/review-harvest.mjs --verify <dataset>.json.gz
//
// The checkpoint is body-free like the dataset and is rewritten after every page, so an interrupted
// run resumes where it stopped. How to prepare `--git-dir` and what each field means is documented
// in docs/qa/review-agent-measurement.md.

import { Buffer } from "node:buffer";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync, gzipSync } from "node:zlib";

import { isMainModule } from "./lib/is-main-module.mjs";
import { createGitRegionProbe } from "./lib/review-harvest-git.mjs";
import { createGhTransport, harvestReviewThreads } from "./lib/review-harvest-graphql.mjs";
import {
  buildReviewHarvestDataset,
  verifyReviewHarvestDataset,
} from "./lib/review-harvest-records.mjs";

const REPOSITORY_SLUG = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/u;
const USAGE =
  "usage: review-harvest --repo <owner/name> --git-dir <dir> --checkpoint <file> --out <file>" +
  " [--page-size <n>] [--fetch-missing-commits] | --verify <file>";

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function harvestRequest(argv) {
  const repo = REPOSITORY_SLUG.exec(argValue(argv, "--repo") ?? "");
  const gitDir = argValue(argv, "--git-dir");
  const checkpoint = argValue(argv, "--checkpoint");
  const out = argValue(argv, "--out");
  if (repo === null || gitDir === undefined || checkpoint === undefined || out === undefined) {
    throw new Error(USAGE);
  }
  return { mode: "harvest", owner: repo[1], name: repo[2], gitDir, checkpoint, out };
}

/** Parses the command line into a harvest or a verify request; throws a usage error otherwise. */
export function parseHarvestArguments(argv) {
  const verify = argValue(argv, "--verify");
  if (verify !== undefined) return { mode: "verify", path: verify };
  const pageSize = Number(argValue(argv, "--page-size") ?? "10");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new Error("--page-size must be an integer from 1 to 50");
  }
  return {
    ...harvestRequest(argv),
    pageSize,
    fetchMissing: argv.includes("--fetch-missing-commits"),
  };
}

/** Reads a dataset written by this tool, gzip-compressed when its name ends in `.gz`. */
export function readDataset(path, read = readFileSync) {
  const bytes = read(path);
  return JSON.parse((path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
}

/** Serializes a dataset; `.gz` output is gzip at a fixed level with no embedded timestamp. */
export function encodeDataset(path, dataset) {
  const text = `${JSON.stringify(dataset)}\n`;
  return path.endsWith(".gz") ? gzipSync(text, { level: 9 }) : Buffer.from(text, "utf8");
}

function fileCheckpointStore(path) {
  return {
    load: () => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined),
    save: (checkpoint) => {
      writeFileSync(`${path}.tmp`, `${JSON.stringify(checkpoint)}\n`);
      renameSync(`${path}.tmp`, path);
    },
  };
}

function datasetTotals(dataset) {
  const threads = dataset.pullRequests.flatMap((pullRequest) => pullRequest.threads);
  const unavailable = threads.filter((thread) => thread.regionChange === "unavailable").length;
  return { threads: threads.length, unavailable };
}

function summaryLine(verdict, dataset) {
  const totals = datasetTotals(dataset);
  return (
    `review-harvest ${verdict}: ${String(dataset.population.pullRequestCount)} pull requests ` +
    `(#${String(dataset.population.firstPullRequest)}-#${String(dataset.population.lastPullRequest)}), ` +
    `${String(totals.threads)} threads, ${String(totals.unavailable)} with region change unavailable, ` +
    `digest ${dataset.digest}`
  );
}

async function runHarvest(request, io) {
  const { checkpoint, pointsUsed } = await harvestReviewThreads({
    owner: request.owner,
    name: request.name,
    transport: io.transport ?? createGhTransport(),
    probe:
      io.probe ??
      createGitRegionProbe(request.gitDir, undefined, { fetchMissing: request.fetchMissing }),
    store: io.store ?? fileCheckpointStore(request.checkpoint),
    io,
    pageSize: request.pageSize,
  });
  const dataset = buildReviewHarvestDataset({
    repository: checkpoint.repository,
    pullRequests: checkpoint.pullRequests,
    excludedNoticeThreads: checkpoint.excludedNoticeThreads,
  });
  (io.write ?? writeFileSync)(request.out, encodeDataset(request.out, dataset));
  io.out(summaryLine("PASS", dataset));
  io.out(`review-harvest: ${String(pointsUsed)} GraphQL points used`);
  return 0;
}

function runVerify(request, io) {
  const dataset = readDataset(request.path, io.read);
  const verdict = verifyReviewHarvestDataset(dataset) ? "PASS" : "FAIL";
  io.out(summaryLine(verdict, dataset));
  return verdict === "PASS" ? 0 : 1;
}

/** The CLI body, with every effect injectable. Resolves to the process exit code. */
export async function executeReviewHarvestCli(argv, io) {
  try {
    const request = parseHarvestArguments(argv);
    return request.mode === "verify" ? runVerify(request, io) : await runHarvest(request, io);
  } catch (error) {
    io.out(`review-harvest FAIL: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  const io = {
    out: (line) => console.log(line),
    log: (line) => console.error(line),
    now: () => Date.now(),
    sleep: (ms) => delay(ms),
  };
  process.exitCode = await executeReviewHarvestCli(process.argv.slice(2), io);
}
