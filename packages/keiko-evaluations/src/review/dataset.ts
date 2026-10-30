// Loading the review harvest dataset (Issue #4132). The dataset is written by
// `scripts/review-harvest.mjs`, which owns its digest; this side only checks the shape, fail closed,
// before any replay or baseline reads it. A dataset that carries an unknown key, a body or a login
// is rejected rather than silently ignored: the closed key set is what keeps it body-free.

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import {
  REVIEW_PRODUCERS,
  REVIEW_REGION_CHANGES,
  REVIEW_REPLY_CLASSIFICATIONS,
  type ReviewHarvestDataset,
  type ReviewHarvestPullRequest,
  type ReviewHarvestReply,
  type ReviewHarvestThread,
  type ReviewProducer,
} from "./types.js";

/** A dataset that does not have the harvest's shape. `path` names the field, never its value. */
export class ReviewDatasetError extends Error {
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`review dataset: ${path} ${problem}`);
    this.name = "ReviewDatasetError";
    this.path = path;
  }
}

type Fields = Readonly<Record<string, unknown>>;

const THREAD_KEYS = new Set([
  "id",
  "producer",
  "path",
  "startLine",
  "endLine",
  "fileLevel",
  "side",
  "reviewedCommit",
  "resolved",
  "outdated",
  "reply",
  "regionChange",
  "bodyDigest",
]);
const PULL_REQUEST_KEYS = new Set([
  "number",
  "state",
  "headCommit",
  "baseCommit",
  "reviewedBy",
  "threads",
]);
const COMMIT_OID = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function record(value: unknown, path: string, keys?: ReadonlySet<string>): Fields {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewDatasetError(path, "must be an object");
  }
  const fields = value as Fields;
  const unknown = keys === undefined ? [] : Object.keys(fields).filter((key) => !keys.has(key));
  if (unknown.length > 0) throw new ReviewDatasetError(`${path}.${unknown[0] ?? ""}`, "is unknown");
  return fields;
}

function oneOf<const T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw new ReviewDatasetError(path, "is not an allowed value");
  return match;
}

function text(value: unknown, path: string, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new ReviewDatasetError(path, "must be a well-formed string");
  }
  return value;
}

function flag(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ReviewDatasetError(path, "must be a boolean");
  return value;
}

function lineOrNull(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ReviewDatasetError(path, "must be a positive line or null");
  }
  return value as number;
}

function commitOrNull(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path, COMMIT_OID);
}

function reply(value: unknown, path: string): ReviewHarvestReply | null {
  if (value === null) return null;
  const fields = record(value, path, new Set(["classification", "producer"]));
  return {
    classification: oneOf(
      fields.classification,
      REVIEW_REPLY_CLASSIFICATIONS,
      `${path}.classification`,
    ),
    producer: oneOf(fields.producer, REVIEW_PRODUCERS, `${path}.producer`),
  };
}

function anchor(
  fields: Fields,
  path: string,
): Pick<ReviewHarvestThread, "startLine" | "endLine" | "fileLevel"> {
  const fileLevel = flag(fields.fileLevel, `${path}.fileLevel`);
  const startLine = lineOrNull(fields.startLine, `${path}.startLine`);
  const endLine = lineOrNull(fields.endLine, `${path}.endLine`);
  const consistent = fileLevel
    ? startLine === null && endLine === null
    : startLine !== null && endLine !== null && startLine <= endLine;
  if (!consistent) throw new ReviewDatasetError(path, "has an inconsistent anchor");
  return { startLine, endLine, fileLevel };
}

function thread(value: unknown, path: string): ReviewHarvestThread {
  const fields = record(value, path, THREAD_KEYS);
  return {
    id: text(fields.id, `${path}.id`),
    producer: oneOf(fields.producer, REVIEW_PRODUCERS, `${path}.producer`),
    path: text(fields.path, `${path}.path`),
    ...anchor(fields, path),
    side: oneOf(fields.side, ["left", "right"], `${path}.side`),
    reviewedCommit: commitOrNull(fields.reviewedCommit, `${path}.reviewedCommit`),
    resolved: flag(fields.resolved, `${path}.resolved`),
    outdated: flag(fields.outdated, `${path}.outdated`),
    reply: reply(fields.reply, `${path}.reply`),
    regionChange: oneOf(fields.regionChange, REVIEW_REGION_CHANGES, `${path}.regionChange`),
    bodyDigest: text(fields.bodyDigest, `${path}.bodyDigest`, DIGEST),
  };
}

function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new ReviewDatasetError(path, "must be an array");
  return value;
}

function pullRequest(value: unknown, path: string): ReviewHarvestPullRequest {
  const fields = record(value, path, PULL_REQUEST_KEYS);
  if (!Number.isSafeInteger(fields.number) || (fields.number as number) < 1) {
    throw new ReviewDatasetError(`${path}.number`, "must be a positive integer");
  }
  return {
    number: fields.number as number,
    state: oneOf(fields.state, ["merged", "closed"], `${path}.state`),
    headCommit: commitOrNull(fields.headCommit, `${path}.headCommit`),
    baseCommit: commitOrNull(fields.baseCommit, `${path}.baseCommit`),
    reviewedBy: list(fields.reviewedBy, `${path}.reviewedBy`).map(
      (producer, index): ReviewProducer =>
        oneOf(producer, REVIEW_PRODUCERS, `${path}.reviewedBy.${String(index)}`),
    ),
    threads: list(fields.threads, `${path}.threads`).map((entry, index) =>
      thread(entry, `${path}.threads.${String(index)}`),
    ),
  };
}

function noticeCounts(value: unknown): Readonly<Record<ReviewProducer, number>> {
  const fields = record(value, "excludedNoticeThreads", new Set(REVIEW_PRODUCERS));
  const counts = {} as Record<ReviewProducer, number>;
  for (const producer of REVIEW_PRODUCERS) {
    const count = fields[producer];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new ReviewDatasetError(`excludedNoticeThreads.${producer}`, "must be a count");
    }
    counts[producer] = count as number;
  }
  return counts;
}

function ascending(pullRequests: readonly ReviewHarvestPullRequest[]): void {
  pullRequests.forEach((entry, index) => {
    const previous = pullRequests[index - 1];
    if (previous !== undefined && previous.number >= entry.number) {
      throw new ReviewDatasetError(`pullRequests.${String(index)}`, "is out of order or repeated");
    }
  });
}

function countOrNull(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ReviewDatasetError(path, "must be a count or null");
  }
  return value as number;
}

function population(value: unknown): ReviewHarvestDataset["population"] {
  const fields = record(value, "population");
  const pullRequestCount = countOrNull(fields.pullRequestCount, "population.pullRequestCount");
  if (pullRequestCount === null)
    throw new ReviewDatasetError("population.pullRequestCount", "is required");
  return {
    states: list(fields.states, "population.states").map((state, index) =>
      text(state, `population.states.${String(index)}`),
    ),
    pullRequestCount,
    firstPullRequest: countOrNull(fields.firstPullRequest, "population.firstPullRequest"),
    lastPullRequest: countOrNull(fields.lastPullRequest, "population.lastPullRequest"),
  };
}

function rules(value: unknown): ReviewHarvestDataset["rules"] {
  const fields = record(value, "rules");
  for (const [key, rule] of Object.entries(fields)) {
    if (typeof rule !== "string" && typeof rule !== "number") {
      throw new ReviewDatasetError(`rules.${key}`, "must be a string or a number");
    }
  }
  return fields as Readonly<Record<string, string | number>>;
}

/** Validates an already-parsed dataset value; throws `ReviewDatasetError` on the first problem. */
export function parseReviewHarvestDataset(value: unknown): ReviewHarvestDataset {
  const fields = record(value, "$");
  if (fields.schemaVersion !== 1) throw new ReviewDatasetError("schemaVersion", "must be 1");
  const pullRequests = list(fields.pullRequests, "pullRequests").map((entry, index) =>
    pullRequest(entry, `pullRequests.${String(index)}`),
  );
  ascending(pullRequests);
  return {
    schemaVersion: 1,
    repository: text(fields.repository, "repository"),
    rules: rules(fields.rules),
    population: population(fields.population),
    excludedNoticeThreads: noticeCounts(fields.excludedNoticeThreads),
    pullRequests,
    digest: text(fields.digest, "digest", DIGEST),
  };
}

/** Reads and validates a dataset file; a `.gz` name is decompressed first. */
export function loadReviewHarvestDataset(path: string): ReviewHarvestDataset {
  const bytes = readFileSync(path);
  const textContent = (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");
  return parseReviewHarvestDataset(JSON.parse(textContent) as unknown);
}
