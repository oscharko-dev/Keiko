#!/usr/bin/env node
// Measures how long a merged pull request sat between "every required check is green" and "merged".
//
// Clean pull requests auto-merge minutes after the last check goes green. Pull requests that
// received review findings took 108-122 minutes wall-clock although every required check was green
// at 25-32 minutes (Issue #2708). The difference is settlement - review cadence, repair rounds and
// agent reaction time - and none of it was measured. This report makes it visible.
//
// It is a REPORT, not a gate. ADR-0139 D1 keeps wall-clock assertions out of the required lane, so
// nothing here may ever become a required check; it is run on demand and read by a human.
//
// Redaction is structural, not a filter: the collector converts findings to bare TIMESTAMPS at the
// point of collection, so no finding body, file name, author or diff content exists anywhere in this
// module's data model to leak. The output schema admits numbers, ISO-8601 instants, booleans and two
// closed enums - nothing else - and the test asserts exactly that over every leaf.
//
// Unlike a gate, malformed input FAILS LOUD here. A silently wrong latency number is worse than no
// number, so a bad timestamp, an out-of-order head or a missing merge instant throws rather than
// being coerced. A pull request that merged without ever being fully green is a real state, not
// malformed data, and is reported as such.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHostExecutable } from "./lib/host-executable.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRIBUTING = resolve(repoRoot, "CONTRIBUTING.md");

const MEASURED = "measured";
const NEVER_FULLY_GREEN = "never-fully-green";
const MERGED_BEFORE_GREEN = "merged-before-green";
const TRUNCATED = "truncated";
const UNOBSERVED = "unobserved";
const FINDING_BEARING = "finding-bearing";
const CLEAN = "clean";

/** The two closed enums the output may contain. Everything else is a number, instant or boolean. */
export const OUTCOMES = Object.freeze([
  MEASURED,
  NEVER_FULLY_GREEN,
  MERGED_BEFORE_GREEN,
  TRUNCATED,
  UNOBSERVED,
]);
export const COHORTS = Object.freeze([FINDING_BEARING, CLEAN]);

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const REPOSITORY_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const REQUIRED_CHECK_ENTRY = /^\d+\.\s+`([^`]+)`\s*$/u;
const REQUIRED_CHECK_HEADING = /required status checks must pass/u;
const MILLISECONDS_PER_MINUTE = 60_000;
const GH_API_MAX_BUFFER = 64 * 1024 * 1024;
// An outbound call with no ceiling is an unbounded failure mode: a hung request would stall the
// report forever instead of failing. Two minutes is far above the slowest observed page.
const GH_API_TIMEOUT_MS = 120_000;
const DEFAULT_WINDOW = 20;

/**
 * The required-check names come from CONTRIBUTING.md, which AGENTS.md §10 names as authoritative,
 * rather than from a second copy that would drift against it.
 */
export function requiredChecksFromContributing(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => REQUIRED_CHECK_HEADING.test(line));
  if (start < 0) throw new Error("CONTRIBUTING.md no longer states the required status checks");
  const checks = [];
  for (const line of lines.slice(start + 1)) {
    const entry = REQUIRED_CHECK_ENTRY.exec(line);
    if (entry?.[1] !== undefined) {
      checks.push(entry[1]);
      continue;
    }
    if (checks.length > 0 && line.trim() !== "") break;
  }
  if (checks.length === 0) throw new Error("CONTRIBUTING.md lists no required status checks");
  return checks;
}

export function readRequiredChecks(read = readFileSync) {
  return requiredChecksFromContributing(read(CONTRIBUTING, "utf8"));
}

function instant(value, what) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) {
    throw new Error(`${what} must be an ISO-8601 instant, received ${JSON.stringify(value)}`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${what} is not a valid instant: ${value}`);
  return parsed;
}

function minutesBetween(fromMs, toMs) {
  return Math.round(((toMs - fromMs) / MILLISECONDS_PER_MINUTE) * 10) / 10;
}

/**
 * A head is green when every documented required check that RAN on it succeeded, and enough of them
 * ran to be meaningful. The floor exists because the required set has changed over time (ADR-0159
 * merged four contexts into one), so a historical head legitimately carries a different vocabulary;
 * demanding all eleven would report every older pull request as never-green, and demanding one would
 * call a single green check a green head.
 */
export function requiredGreenAt(contexts, requiredChecks) {
  const latest = latestPerCheck(contexts, new Set(requiredChecks));
  if (latest.size < Math.floor(requiredChecks.length / 2) + 1) return null;
  let newest = Number.NEGATIVE_INFINITY;
  for (const attempt of latest.values()) {
    // Judged on the LATEST attempt only: a required check that failed and was then re-run green is
    // a green head. Judging the first attempt would report every re-run as never-green.
    if (!attempt.successful) return null;
    if (attempt.at > newest) newest = attempt.at;
  }
  return new Date(newest).toISOString();
}

function latestPerCheck(contexts, required) {
  const latest = new Map();
  for (const context of contexts) {
    const name = context.name ?? context.context;
    if (typeof name !== "string" || !required.has(name)) continue;
    const attempt = attemptOf(context, name);
    const known = latest.get(name);
    if (known === undefined || attempt.at > known.at) latest.set(name, attempt);
  }
  return latest;
}

/**
 * A check still running carries no completion instant. That is a real state, not corrupt data, and
 * it is the most recent thing known about that check — so it wins the per-name comparison, and it is
 * not green.
 */
function attemptOf(context, name) {
  const completedAt = context.completedAt ?? context.createdAt;
  if (typeof completedAt !== "string") return { at: Number.POSITIVE_INFINITY, successful: false };
  return { at: instant(completedAt, `completion of ${name}`), successful: isSuccessful(context) };
}

function isSuccessful(context) {
  return context.conclusion === "SUCCESS" || context.state === "SUCCESS";
}

/**
 * When CI first started on a head - the closest observable proxy for when the push landed, and much
 * closer than the commit date, which is when the author committed locally.
 */
export function earliestStart(contexts) {
  const starts = contexts
    .map((context) => context.startedAt ?? context.createdAt)
    .filter((at) => typeof at === "string" && ISO_INSTANT.test(at))
    .map((at) => Date.parse(at));
  return starts.length === 0 ? undefined : new Date(Math.min(...starts)).toISOString();
}

function validatedHeads(heads) {
  if (!Array.isArray(heads)) throw new TypeError("a pull request timeline must carry a head list");
  let previous = Number.NEGATIVE_INFINITY;
  return heads.map((head, index) => {
    const startedAt = instant(head.startedAt, `head ${String(index)} start`);
    if (startedAt < previous) throw new Error("heads must be ordered by their start instant");
    previous = startedAt;
    const greenAt = head.requiredGreenAt === null ? null : instant(head.requiredGreenAt, "green");
    return { startedAt, greenAt };
  });
}

function reactionMinutes(heads, findingsMs) {
  const reactions = [];
  for (let index = 1; index < heads.length; index += 1) {
    // From when the PREVIOUS head started, not from when it turned green: review bots publish while
    // CI is still running, so bounding at green would discard the common case and under-report.
    const from = heads[index - 1].startedAt;
    const to = heads[index].startedAt;
    const responded = findingsMs.filter((at) => at >= from && at < to);
    if (responded.length > 0) reactions.push(minutesBetween(Math.min(...responded), to));
  }
  return reactions;
}

/**
 * The full settlement span: from the FIRST moment the change was green - the first instant it could
 * have merged had no finding arrived - to the merge. Deliberately independent of the outcome: a run
 * that merged before its FINAL head finished still had a first green head, and that span is a fact.
 * Only the final gap is outcome-gated, because only it depends on the final head being green. Issue #2708's founding 108-122 minute
 * measurements are this number, not the final-head gap, which auto-merge closes in seconds. Keeping
 * both is what makes the difference between "auto-merge is slow" and "repair rounds are the cost"
 * legible instead of arguable.
 */
function firstGreenToMerged(heads, mergedAt) {
  const first = heads.find((head) => head.greenAt !== null && head.greenAt <= mergedAt);
  return first === undefined ? null : minutesBetween(first.greenAt, mergedAt);
}

function validatedFindings(findings = []) {
  if (!Array.isArray(findings)) throw new TypeError("findings must be an array of instants");
  return findings.map((at) => instant(at, "finding instant"));
}

function unmeasured(number, heads, findingsMs, outcome) {
  return {
    number,
    cohort: findingsMs.length > 0 ? FINDING_BEARING : CLEAN,
    outcome,
    headCount: heads.length,
    repairRounds: Math.max(heads.length - 1, 0),
    findingCount: findingsMs.length,
    checksGreenToMergedMinutes: null,
    firstGreenToMergedMinutes: null,
    reactionMinutes: reactionMinutes(heads, findingsMs),
  };
}

function outcomeFor(finalGreen, mergedAt) {
  if (finalGreen === null) return NEVER_FULLY_GREEN;
  return finalGreen > mergedAt ? MERGED_BEFORE_GREEN : MEASURED;
}

/** One merged pull request reduced to durations and counts. Throws on malformed input. */
export function summarizePullRequest(timeline) {
  if (typeof timeline?.number !== "number" || !Number.isSafeInteger(timeline.number)) {
    throw new TypeError("a pull request timeline must carry an integer number");
  }
  const mergedAt = instant(timeline.mergedAt, "merge instant");
  const heads = validatedHeads(timeline.heads);
  const findingsMs = validatedFindings(timeline.findings);
  // Two real states that must not abort the whole report over one pull request: GitHub truncated a
  // connection, or CI never observed a single head (an old pull request, or one merged before its
  // checks existed). Both are reported; only a malformed TYPE throws.
  if (timeline.truncated === true) return unmeasured(timeline.number, heads, findingsMs, TRUNCATED);
  if (heads.length === 0) return unmeasured(timeline.number, heads, findingsMs, UNOBSERVED);
  const finalGreen = heads.at(-1).greenAt;
  // Green-after-merge is a real state, not corrupt data: an administrative merge does not wait, and
  // a required check can still be completing on the head when the merge lands. It gets its own
  // outcome instead of an exception, because reporting it as a negative gap would poison the median
  // and reporting it as measured would claim a settlement that never happened.
  const outcome = outcomeFor(finalGreen, mergedAt);
  return {
    number: timeline.number,
    cohort: findingsMs.length > 0 ? FINDING_BEARING : CLEAN,
    outcome,
    headCount: heads.length,
    repairRounds: heads.length - 1,
    findingCount: findingsMs.length,
    checksGreenToMergedMinutes: outcome === MEASURED ? minutesBetween(finalGreen, mergedAt) : null,
    firstGreenToMergedMinutes: outcome === TRUNCATED ? null : firstGreenToMerged(heads, mergedAt),
    reactionMinutes: reactionMinutes(heads, findingsMs),
  };
}

export function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle];
  return Math.round(((ordered[middle - 1] + ordered[middle]) / 2) * 10) / 10;
}

function maxOf(values) {
  return values.length === 0 ? null : Math.max(...values);
}

function cohortSummary(reports, cohort) {
  const inCohort = reports.filter((report) => report.cohort === cohort);
  const measured = inCohort.filter((report) => report.outcome === MEASURED);
  const reactions = inCohort.flatMap((report) => report.reactionMinutes);
  return {
    cohort,
    pullRequests: inCohort.length,
    measured: measured.length,
    medianGapMinutes: median(measured.map((report) => report.checksGreenToMergedMinutes)),
    medianSettlementMinutes: median(
      inCohort.map((report) => report.firstGreenToMergedMinutes).filter((value) => value !== null),
    ),
    maxSettlementMinutes: maxOf(
      inCohort.map((report) => report.firstGreenToMergedMinutes).filter((value) => value !== null),
    ),
    medianRepairRounds: median(inCohort.map((report) => report.repairRounds)),
    medianReactionMinutes: median(reactions),
    reactionSamples: reactions.length,
  };
}

export function summarizeCohorts(reports) {
  return COHORTS.map((cohort) => cohortSummary(reports, cohort));
}

export function requireRepositorySlug(value) {
  if (typeof value !== "string" || !REPOSITORY_SLUG.test(value)) {
    throw new Error("a repository slug of the form owner/name is required");
  }
  return value;
}

// ADR-0139 D6, at this layer: a GitHub 502/504 is weather, and a report that dies on one is a report
// nobody runs. Bounded attempts with backoff, then fail - a persistent outage still ends loud.
const TRANSPORT_ATTEMPTS = 3;
const TRANSPORT_BACKOFF_MS = 2000;
const TRANSIENT_TRANSPORT = /HTTP (?:429|500|502|503|504)/u;

export function ghGraphqlWithRetry(query, variables, io = {}) {
  const attempts = io.attempts ?? TRANSPORT_ATTEMPTS;
  const wait = io.wait ?? sleepSync;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return ghGraphql(query, variables, io);
    } catch (cause) {
      lastError = cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!TRANSIENT_TRANSPORT.test(message) || attempt === attempts) throw cause;
      wait(attempt * TRANSPORT_BACKOFF_MS);
    }
  }
  throw lastError;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function ghGraphql(query, variables, io = {}) {
  const execute = io.execute ?? spawnSync;
  const executable = io.ghExecutable ?? resolveHostExecutable("gh");
  const result = execute(executable, graphqlArguments(query, variables), {
    encoding: "utf8",
    maxBuffer: GH_API_MAX_BUFFER,
    timeout: GH_API_TIMEOUT_MS,
  });
  if (result.error !== undefined && result.error !== null) throw result.error;
  if (result.status !== 0) {
    // Carrying stderr matters: the failures that actually happen here are a node-cost rejection or a
    // secondary rate limit, and "exited with status 1" sends the reader hunting for the wrong thing.
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const detail = stderr === "" ? "" : `: ${stderr}`;
    throw new Error(`gh api graphql exited with status ${String(result.status)}${detail}`);
  }
  const payload = JSON.parse(result.stdout);
  if (payload.errors !== undefined) {
    throw new Error(`gh api graphql reported ${String(payload.errors.length)} error(s)`);
  }
  return payload.data;
}

function graphqlArguments(query, variables) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    // A null variable is omitted rather than stringified: `-F after=null` would send the four-letter
    // string, while an absent nullable variable is the null GraphQL expects for a first page.
    if (value === null || value === undefined) continue;
    // `-F` type-infers, which is what an Int variable needs; `-f` keeps a cursor a raw string.
    args.push(typeof value === "number" ? "-F" : "-f", `${key}=${String(value)}`);
  }
  return args;
}

// Page size is bounded because GitHub scores a GraphQL request by the nodes it could return, and
// pull requests x commits x check contexts multiplies fast: asking for the whole window in one
// request exceeds the node limit and fails the query outright.
export const PULL_REQUEST_PAGE_SIZE = 4;

export const MERGED_PULL_REQUESTS_QUERY = `query($owner:String!,$name:String!,$count:Int!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:MERGED,baseRefName:"dev",orderBy:{field:UPDATED_AT,direction:DESC},first:$count,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{
        number mergedAt
        commits(last:100){totalCount nodes{commit{oid committedDate
          statusCheckRollup{contexts(first:60){totalCount nodes{
            __typename
            ... on CheckRun{name conclusion startedAt completedAt}
            ... on StatusContext{context state createdAt}
          }}}
        }}}
        reviewThreads(first:100){totalCount nodes{comments(first:1){nodes{createdAt}}}}
      }
    }
  }
}`;

/**
 * Reduces a GraphQL pull-request node to the timeline shape. This is where redaction happens by
 * construction: only instants survive, so nothing downstream can leak a finding's content.
 */
function notBefore(candidate, floor) {
  if (typeof candidate !== "string") return candidate;
  return floor !== "" && candidate < floor ? floor : candidate;
}

function isTruncated(connection, fetched) {
  const total = connection?.totalCount;
  return typeof total === "number" && total > fetched.length;
}

function observedHeads(commits, requiredChecks) {
  const heads = [];
  let previousStart = "";
  for (const entry of commits) {
    const commit = entry.commit;
    const contexts = commit.statusCheckRollup?.contexts?.nodes ?? [];
    // A commit that CI never observed was never a head: it arrived inside a batched push behind a
    // later commit. Counting it would report a repair round that never happened.
    if (contexts.length === 0) continue;
    const rollup = commit.statusCheckRollup?.contexts;
    // A CI start and a commit date are different clocks: the commit date is when the author
    // committed locally and can precede the previous head's CI start. Left unclamped, that ordering
    // inversion would abort the ENTIRE report over one pull request, so the fallback is clamped -
    // and only the fallback, because an observed CI start is trusted as it stands.
    const startedAt = notBefore(earliestStart(contexts) ?? commit.committedDate, previousStart);
    previousStart = startedAt;
    heads.push({
      startedAt,
      // A truncated context list cannot establish greenness: the check that failed may be the one
      // that did not fit.
      requiredGreenAt: isTruncated(rollup, contexts)
        ? null
        : requiredGreenAt(contexts, requiredChecks),
    });
  }
  return heads;
}

function findingInstants(threads) {
  return threads
    .map((thread) => thread.comments?.nodes?.[0]?.createdAt)
    .filter((createdAt) => typeof createdAt === "string");
}

export function timelineFromNode(node, requiredChecks) {
  const commits = node.commits?.nodes ?? [];
  const threads = node.reviewThreads?.nodes ?? [];
  return {
    number: node.number,
    mergedAt: node.mergedAt,
    heads: observedHeads(commits, requiredChecks),
    findings: findingInstants(threads),
    // A connection GitHub truncated would silently undercount heads or findings, and the resulting
    // durations would look measured while being wrong. Detect it and refuse to report a number.
    truncated: isTruncated(node.commits, commits) || isTruncated(node.reviewThreads, threads),
  };
}

/**
 * Three ways a paging loop can fail to make progress, all of which would spin forever: no cursor,
 * the same cursor again, or a page that promised more and delivered nothing.
 */
function nextCursor(pullRequests, current) {
  const next = pullRequests.pageInfo.endCursor;
  if (typeof next !== "string" || next === "") {
    throw new Error("GitHub reported a further page without a cursor to fetch it");
  }
  if (next === current || pullRequests.nodes.length === 0) {
    throw new Error("GitHub reported a further page but the query made no progress");
  }
  return next;
}

function pullRequestPage(data) {
  const pullRequests = data?.repository?.pullRequests;
  if (!Array.isArray(pullRequests?.nodes)) {
    throw new TypeError("the pull-request query returned no node list");
  }
  return pullRequests;
}

/**
 * GitHub's pull-request connection cannot order by merge instant - `UPDATED_AT` is the closest it
 * offers, and a pull request updated after it merged sorts ahead of a newer merge. So the collector
 * oversamples and orders by `mergedAt` here, which is what makes "the most recently merged" true
 * rather than approximately true.
 */
export const MERGE_ORDER_OVERSAMPLE = 3;

function byMergedAtDescending(left, right) {
  const leftAt = typeof left?.mergedAt === "string" ? left.mergedAt : "";
  const rightAt = typeof right?.mergedAt === "string" ? right.mergedAt : "";
  if (leftAt === rightAt) return 0;
  return leftAt < rightAt ? 1 : -1;
}

export function collectMergedPullRequests(count, io = {}) {
  const slug = requireRepositorySlug(io.repository ?? process.env.GITHUB_REPOSITORY);
  const [owner, name] = slug.split("/");
  const query =
    io.query ?? ((variables) => ghGraphqlWithRetry(MERGED_PULL_REQUESTS_QUERY, variables, io));
  const collected = [];
  const sample = Math.min(count * MERGE_ORDER_OVERSAMPLE, 100);
  let after = null;
  while (collected.length < sample) {
    const page = Math.min(PULL_REQUEST_PAGE_SIZE, sample - collected.length);
    const pullRequests = pullRequestPage(query({ owner, name, count: page, after }));
    collected.push(...pullRequests.nodes);
    if (pullRequests.pageInfo?.hasNextPage !== true) break;
    after = nextCursor(pullRequests, after);
  }
  return [...collected].sort(byMergedAtDescending).slice(0, count);
}

/** An absent value reads the same in both tables: a dash, never the literal string "null". */
function cell(value) {
  return value === null ? "-" : String(value);
}

export function renderReport(reports, cohorts) {
  const lines = [
    "| PR | cohort | outcome | heads | repair rounds | findings | settlement (min) | final gap (min) | reactions (min) |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const report of reports) {
    const gap = cell(report.checksGreenToMergedMinutes);
    const settlement = cell(report.firstGreenToMergedMinutes);
    const reactions = report.reactionMinutes.join(", ") || "-";
    lines.push(
      `| ${String(report.number)} | ${report.cohort} | ${report.outcome} | ${String(report.headCount)} | ${String(report.repairRounds)} | ${String(report.findingCount)} | ${settlement} | ${gap} | ${reactions} |`,
    );
  }
  lines.push(
    "",
    "| cohort | PRs | measured | median settlement | max settlement | median final gap | median rounds | median reaction |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const cohort of cohorts) {
    lines.push(
      `| ${cohort.cohort} | ${String(cohort.pullRequests)} | ${String(cohort.measured)} | ${cell(cohort.medianSettlementMinutes)} | ${cell(cohort.maxSettlementMinutes)} | ${cell(cohort.medianGapMinutes)} | ${cell(cohort.medianRepairRounds)} | ${cell(cohort.medianReactionMinutes)} |`,
    );
  }
  return lines.join("\n");
}

function parseCount(argv) {
  const index = argv.indexOf("--count");
  if (index < 0) return DEFAULT_WINDOW;
  const raw = argv[index + 1];
  // A flag present with no value is user error, not a request for the default: silently reporting a
  // 20-pull-request window when someone asked for something else is a misleading report.
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error("--count needs a value");
  }
  const count = Number(raw);
  if (!Number.isSafeInteger(count)) throw new TypeError("--count must be an integer");
  if (count < 1 || count > 100) throw new RangeError("--count must be between 1 and 100");
  return count;
}

/**
 * Names the pull request in any failure. Without it the report dies on "merge instant must be an
 * ISO-8601 instant" and the reader has 60 candidates and no way to tell which one.
 */
function summarizeNode(node, requiredChecks) {
  try {
    return summarizePullRequest(timelineFromNode(node, requiredChecks));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`pull request ${String(node?.number ?? "unknown")}: ${message}`, { cause });
  }
}

export function runSettlementReport(io = {}) {
  const argv = io.argv ?? process.argv.slice(2);
  const requiredChecks = (io.readRequired ?? readRequiredChecks)();
  const nodes = (io.collect ?? collectMergedPullRequests)(parseCount(argv), io);
  const reports = nodes.map((node) => summarizeNode(node, requiredChecks));
  return { reports, cohorts: summarizeCohorts(reports) };
}

export function executeSettlementCli(io = {}) {
  try {
    const { reports, cohorts } = (io.run ?? runSettlementReport)(io);
    (io.log ?? console.log)(renderReport(reports, cohorts));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    (io.error ?? console.error)(`settlement-latency: FAIL - ${message}`);
    (io.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  executeSettlementCli();
}
