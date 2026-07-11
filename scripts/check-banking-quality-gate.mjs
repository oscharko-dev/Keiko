#!/usr/bin/env node

import { readFileSync } from "node:fs";

const checkName = "Banking Quality Gate";
const gitarAppId = 827041;
const gitarGraceMs = 90_000;
const socketAppId = 156372;

export const bankingRequiredChecks = [
  { appId: 15368, name: "ci" },
  { appId: 15368, name: "actionlint" },
  { appId: 15368, name: "Verify pinned action SHAs" },
  { appId: 15368, name: "Analyze (actions)" },
  { appId: 15368, name: "Analyze (javascript-typescript)" },
  { appId: 15368, name: "Build, scan, SBOM, smoke" },
  { appId: 15368, name: "Review dependency diff (dev/main)" },
  { appId: 15368, name: "ui" },
  { appId: 15368, name: "zizmor" },
  { appId: 15368, name: "Mutation quality gate" },
  { appId: 15368, name: "Scan dependency lockfiles" },
  { appId: 12526, name: "SonarCloud Code Analysis" },
  { appId: 156372, name: "Socket Security: Project Report" },
  { appId: 156372, name: "Socket Security: Pull Request Alerts" },
  { appId: gitarAppId, name: "Gitar" },
];

function matchingCheck(checks, requirement, headSha) {
  return checks.find(
    (check) =>
      check.name === requirement.name &&
      check.appId === requirement.appId &&
      check.headSha === headSha,
  );
}

export function evaluateBankingEvidence(input) {
  const checks = evaluateRequiredChecks(input);
  const gitar = evaluateGitar(input);
  const socket = evaluateSocket(input);
  return {
    failures: [...checks.failures, ...gitar.failures, ...socket.failures],
    pending: [...checks.pending, ...gitar.pending, ...socket.pending],
  };
}

function evaluateRequiredChecks(input) {
  const failures = [];
  const pending = [];
  for (const requirement of input.requiredChecks) {
    const check = matchingCheck(input.checks, requirement, input.headSha);
    if (check === undefined) pending.push(`${requirement.name} (missing)`);
    else if (check.status !== "completed") pending.push(`${requirement.name} (${check.status})`);
    else if (check.conclusion !== "success")
      failures.push(`${requirement.name} concluded ${check.conclusion ?? "without a conclusion"}.`);
  }
  return { failures, pending };
}

function evaluateGitar(input) {
  const failures = [];
  const pending = [];
  const gitar = matchingCheck(
    input.checks,
    { appId: input.gitarAppId, name: "Gitar" },
    input.headSha,
  );
  const blockingReview = input.reviews.some(
    (review) =>
      review.appId === input.gitarAppId &&
      review.commitSha === input.headSha &&
      review.state === "CHANGES_REQUESTED",
  );
  if (blockingReview || gitarCommentHasFindings(input, gitar))
    failures.push("Gitar has unresolved findings on the current head commit.");
  if (
    !blockingReview &&
    gitar?.status === "completed" &&
    gitar.completedAt !== undefined &&
    input.now - Date.parse(gitar.completedAt) < input.gitarGraceMs
  )
    pending.push("Gitar finding stabilization window");
  return { failures, pending };
}

function gitarCommentHasFindings(input, gitar) {
  if (gitar?.startedAt === undefined) return false;
  const comment = (input.comments ?? []).find(
    (candidate) =>
      candidate.appId === input.gitarAppId &&
      Date.parse(candidate.updatedAt) >= Date.parse(gitar.startedAt),
  );
  return (comment?.findingCount ?? 0) > 0;
}

function evaluateSocket(input) {
  const socket = matchingCheck(
    input.checks,
    { appId: input.socketAppId ?? socketAppId, name: "Socket Security: Pull Request Alerts" },
    input.headSha,
  );
  if (socket?.startedAt === undefined) return { failures: [], pending: [] };
  const comment = (input.comments ?? []).find(
    (candidate) =>
      candidate.appId === (input.socketAppId ?? socketAppId) &&
      Date.parse(candidate.updatedAt) >= Date.parse(socket.startedAt),
  );
  return {
    failures:
      (comment?.alertCount ?? 0) > 0
        ? [`Socket reports ${String(comment.alertCount)} unresolved dependency alert(s).`]
        : [],
    pending: [],
  };
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubJson(path, token, init = {}) {
  const response = await globalThis.fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { ...githubHeaders(token), ...init.headers },
  });
  if (!response.ok) throw new Error(`GitHub API ${path} returned ${String(response.status)}.`);
  return response.json();
}

function normalizeChecks(payload) {
  return (payload.check_runs ?? []).map((check) => ({
    appId: check.app?.id,
    completedAt: check.completed_at,
    conclusion: check.conclusion,
    headSha: check.head_sha,
    name: check.name,
    startedAt: check.started_at,
    status: check.status,
  }));
}

export function normalizeComments(payload) {
  return payload.flatMap((comment) => normalizeBotComment(comment)).reverse();
}

function normalizeBotComment(comment) {
  if (comment.user?.login === "gitar-bot[bot]") return [normalizeGitarComment(comment)];
  if (comment.user?.login !== "socket-security[bot]") return [];
  return [normalizeSocketComment(comment)];
}

function normalizeGitarComment(comment) {
  return {
    appId: gitarAppId,
    findingCount: Number(comment.body?.match(/\b(\d+) findings?\b/u)?.[1] ?? 0),
    updatedAt: comment.updated_at,
  };
}

function normalizeSocketComment(comment) {
  const alertCount = comment.body?.match(/<td[^>]*>\s*(?:Error|Warn)\s*<\/td>/gu)?.length ?? 0;
  return { alertCount, appId: socketAppId, updatedAt: comment.updated_at };
}

function normalizeReviews(payload) {
  return payload.map((review) => ({
    appId: review.user?.login === "gitar-bot[bot]" ? gitarAppId : undefined,
    commitSha: review.commit_id,
    state: review.state,
  }));
}

async function createCheck(config) {
  return githubJson(`/repos/${config.owner}/${config.repo}/check-runs`, config.token, {
    body: JSON.stringify({ head_sha: config.headSha, name: checkName, status: "in_progress" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

async function finishCheck(config, checkId, conclusion, summary) {
  await githubJson(
    `/repos/${config.owner}/${config.repo}/check-runs/${String(checkId)}`,
    config.token,
    {
      body: JSON.stringify({
        completed_at: new Date().toISOString(),
        conclusion,
        output: { summary, title: checkName },
        status: "completed",
      }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    },
  );
}

async function fetchEvidence(config) {
  const [checks, reviews, comments] = await Promise.all([
    githubJson(
      `/repos/${config.owner}/${config.repo}/commits/${config.headSha}/check-runs?per_page=100&filter=latest`,
      config.token,
    ),
    githubJson(
      `/repos/${config.owner}/${config.repo}/pulls/${String(config.pullRequest)}/reviews?per_page=100`,
      config.token,
    ),
    githubJson(
      `/repos/${config.owner}/${config.repo}/issues/${String(config.pullRequest)}/comments?per_page=100`,
      config.token,
    ),
  ]);
  return {
    checks: normalizeChecks(checks),
    comments: normalizeComments(comments),
    reviews: normalizeReviews(reviews),
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

async function awaitBankingEvidence(config) {
  const deadline = Date.now() + 90 * 60_000;
  for (;;) {
    const current = await fetchEvidence(config);
    const result = evaluateBankingEvidence({
      ...current,
      gitarAppId,
      gitarGraceMs,
      headSha: config.headSha,
      now: Date.now(),
      requiredChecks: bankingRequiredChecks,
      socketAppId,
    });
    if (result.failures.length > 0) throw new Error(result.failures.join(" "));
    if (result.pending.length === 0) return;
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${result.pending.join(", ")}.`);
    console.log(`banking-quality-gate: waiting for ${result.pending.join(", ")}.`);
    await sleep(20_000);
  }
}

async function runtimeConfig() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (eventPath === undefined || repository === undefined || token === undefined)
    throw new Error("GitHub runtime variables are required.");
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const [owner, repo] = repository.split("/", 2);
  const pullRequest = await triggeringPullRequest(event, (headSha) =>
    githubJson(`/repos/${owner}/${repo}/commits/${headSha}/pulls`, token),
  );
  if (pullRequest === undefined) return undefined;
  return {
    headSha: pullRequest.head.sha,
    owner,
    pullRequest: pullRequest.number,
    repo,
    token,
  };
}

export async function triggeringPullRequest(event, lookupPullRequests = async () => []) {
  const workflowRun = event.workflow_run;
  if (workflowRun?.event !== "pull_request") return undefined;
  const embedded = selectDevPullRequest(workflowRun, workflowRun.pull_requests ?? []);
  if (embedded !== undefined) return embedded;
  const candidates = await lookupPullRequests(workflowRun.head_sha);
  return selectDevPullRequest(workflowRun, candidates);
}

function selectDevPullRequest(workflowRun, pullRequests) {
  return pullRequests.find(
    (pullRequest) =>
      pullRequest.base?.ref === "dev" && pullRequest.head?.sha === workflowRun.head_sha,
  );
}

async function main() {
  const config = await runtimeConfig();
  if (config === undefined) {
    console.log("banking-quality-gate: skipped - CI run is not for a dev pull request.");
    return;
  }
  const check = await createCheck(config);
  try {
    await awaitBankingEvidence(config);
    await finishCheck(
      config,
      check.id,
      "success",
      "All Banking Grade quality gates passed for the current head commit.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishCheck(config, check.id, "failure", message);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(
      `banking-quality-gate: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
