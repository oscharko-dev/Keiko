#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCliCheck } from "./lib/run-cli-check.mjs";

const EXPECTED_REPOSITORY = "oscharko-dev/Keiko";
const EXPECTED_APP_ID = 867_647;
const EXPECTED_CHECK = "Greptile Review";
const SHA = /^[0-9a-f]{40}$/u;
const PR_NUMBER = /^[1-9][0-9]*$/u;
const PAGE_SIZE = 100;

function output(message) {
  process.stdout.write(`${message}\n`);
}

function diagnostic(message) {
  process.stderr.write(`${message}\n`);
}

function pause(milliseconds) {
  return new Promise((finish) => globalThis.setTimeout(finish, milliseconds));
}

function requestHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
}

async function requestJson(request, url, token, options = {}) {
  const response = await request(url, {
    ...options,
    headers: requestHeaders(token),
    signal: globalThis.AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("GitHub evidence request did not succeed");
  return response.json();
}

function validateContext(env) {
  if (env.GITHUB_REPOSITORY !== EXPECTED_REPOSITORY) {
    throw new Error("repository identity does not match the governed project");
  }
  if (!PR_NUMBER.test(env.QUALITY_PULL_REQUEST ?? "")) {
    throw new Error("pull request number is missing or invalid");
  }
  if (!SHA.test(env.QUALITY_HEAD_SHA ?? "")) {
    throw new Error("head must be an immutable commit SHA");
  }
  if (typeof env.GITHUB_TOKEN !== "string" || env.GITHUB_TOKEN.length === 0) {
    throw new Error("GitHub read token is unavailable");
  }
  return {
    head: env.QUALITY_HEAD_SHA,
    number: env.QUALITY_PULL_REQUEST,
    repository: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
  };
}

function currentGreptileCheck(payload, head) {
  if (!Array.isArray(payload?.check_runs)) return undefined;
  return payload.check_runs.find(
    (run) =>
      run?.app?.id === EXPECTED_APP_ID && run.head_sha === head && run.name === EXPECTED_CHECK,
  );
}

async function waitForCheck(context, request, wait) {
  const url = `https://api.github.com/repos/${context.repository}/commits/${context.head}/check-runs?check_name=Greptile%20Review&filter=latest`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const payload = await requestJson(request, url, context.token);
    const check = currentGreptileCheck(payload, context.head);
    if (check?.status === "completed") return check;
    await wait(10_000);
  }
  throw new Error("exact-head Greptile review did not complete within ten minutes");
}

async function fetchIssueComments(context, request) {
  const comments = [];
  for (let page = 1; page <= 50; page += 1) {
    const url = `https://api.github.com/repos/${context.repository}/issues/${context.number}/comments?per_page=${String(PAGE_SIZE)}&page=${String(page)}`;
    const payload = await requestJson(request, url, context.token);
    if (!Array.isArray(payload)) throw new Error("pull request comments response is malformed");
    comments.push(...payload);
    if (payload.length < PAGE_SIZE) return comments;
  }
  throw new Error("pull request comment evidence exceeds the bounded audit scope");
}

function reviewThreadQuery() {
  return `query GreptileThreads($owner: String!, $repository: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repository) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          nodes { isResolved comments(first: 100) { nodes { author { login } } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;
}

function reviewThreadConnection(payload) {
  const connection = payload?.data?.repository?.pullRequest?.reviewThreads;
  if (!Array.isArray(connection?.nodes)) throw new Error("review thread response is malformed");
  return connection;
}

function nextThreadCursor(connection) {
  if (connection.pageInfo?.hasNextPage !== true) return undefined;
  if (typeof connection.pageInfo.endCursor !== "string") {
    throw new Error("review thread pagination cursor is missing");
  }
  return connection.pageInfo.endCursor;
}

async function fetchReviewThreads(context, request) {
  const threads = [];
  let after = null;
  for (let page = 0; page < 50; page += 1) {
    const payload = await requestJson(request, "https://api.github.com/graphql", context.token, {
      body: JSON.stringify({
        query: reviewThreadQuery(),
        variables: {
          after,
          number: Number(context.number),
          owner: "oscharko-dev",
          repository: "Keiko",
        },
      }),
      method: "POST",
    });
    const connection = reviewThreadConnection(payload);
    threads.push(...connection.nodes);
    const nextCursor = nextThreadCursor(connection);
    if (nextCursor === undefined) return threads;
    after = nextCursor;
  }
  throw new Error("review thread evidence exceeds the bounded audit scope");
}

function latestGreptileSummary(comments) {
  return comments
    .filter(
      (comment) =>
        isGreptileLogin(comment?.user?.login) && comment?.body?.includes("<h3>Greptile Summary"),
    )
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))[0];
}

function isGreptileLogin(login) {
  return login === "greptile-apps" || login === "greptile-apps[bot]";
}

function unresolvedGreptileThreadCount(threads) {
  return threads.filter(
    (thread) =>
      thread?.isResolved !== true &&
      thread?.comments?.nodes?.some((comment) => isGreptileLogin(comment?.author?.login)),
  ).length;
}

export function validateGreptileEvidence({ check, comments, head, threads }) {
  return [
    ...validateGreptileCheck(check, head),
    ...validateGreptileSummary(comments, head),
    ...validateGreptileThreads(threads),
  ];
}

function validateGreptileCheck(check, head) {
  const problems = [];
  if (
    check?.app?.id !== EXPECTED_APP_ID ||
    check.head_sha !== head ||
    check.name !== EXPECTED_CHECK
  ) {
    problems.push("review completion is not bound to the expected app and exact head");
  }
  if (check?.status !== "completed" || check.conclusion !== "success") {
    problems.push("exact-head Greptile review did not complete successfully");
  }
  return problems;
}

function validateGreptileSummary(comments, head) {
  const summary = latestGreptileSummary(comments);
  if (!summary?.body?.includes(`/commit/${head}`)) {
    return ["latest Greptile summary is not bound to the exact head"];
  }
  return /alt="P[012]"/u.test(summary.body)
    ? ["latest Greptile summary contains an unresolved severity finding"]
    : [];
}

function validateGreptileThreads(threads) {
  if (unresolvedGreptileThreadCount(threads) > 0) {
    return ["Greptile has unresolved inline review conversations"];
  }
  return [];
}

async function collectEvidence(context, check, request) {
  const [comments, threads] = await Promise.all([
    fetchIssueComments(context, request),
    fetchReviewThreads(context, request),
  ]);
  return validateGreptileEvidence({ check, comments, head: context.head, threads });
}

async function waitForSettledEvidence(context, check, request, wait) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const problems = await collectEvidence(context, check, request);
    if (!problems.includes("latest Greptile summary is not bound to the exact head"))
      return problems;
    await wait(5_000);
  }
  return ["latest Greptile summary is not bound to the exact head"];
}

export async function checkGreptileFindings(env, request = globalThis.fetch, wait = pause) {
  const context = validateContext(env);
  const check = await waitForCheck(context, request, wait);
  return waitForSettledEvidence(context, check, request, wait);
}

export async function main(
  env = process.env,
  request = globalThis.fetch,
  wait = pause,
  log = output,
  error = diagnostic,
) {
  return runCliCheck({
    check: () => checkGreptileFindings(env, request, wait),
    error,
    failureFallback: "review evidence validation failed",
    failurePrefix: "greptile-findings",
    log,
    passMessage:
      "greptile-findings: PASS — exact-head review completed with zero unresolved findings",
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
