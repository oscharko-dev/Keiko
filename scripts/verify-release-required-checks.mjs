#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const githubApiVersion = "2022-11-28";
const defaultBaseBranch = "release/0.2";
const defaultPollSeconds = 15;
const defaultTimeoutSeconds = 30 * 60;

function fail(message) {
  console.error(`release-required-checks: FAIL - ${message}`);
  process.exit(1);
}

export function parseRequiredChecks(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  const trimmed = value.trim();
  let parsed;
  if (trimmed.startsWith("[")) {
    parsed = JSON.parse(trimmed);
  } else {
    parsed = trimmed
      .split(/[\n,]/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("RELEASE_REQUIRED_CHECKS must be a JSON array, comma list, or newline list.");
  }

  const checks = [];
  const seen = new Set();
  for (const entry of parsed) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error("RELEASE_REQUIRED_CHECKS entries must be non-empty strings.");
    }
    const check = entry.trim();
    if (seen.has(check)) continue;
    seen.add(check);
    checks.push(check);
  }
  return checks;
}

export function requiredChecksFromBranchProtection(protection) {
  const statusChecks = protection?.required_status_checks;
  const checks = [];
  const seen = new Set();

  const add = (value) => {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) return;
    seen.add(value);
    checks.push(value);
  };

  if (Array.isArray(statusChecks?.contexts)) {
    for (const context of statusChecks.contexts) add(context);
  }
  if (Array.isArray(statusChecks?.checks)) {
    for (const check of statusChecks.checks) add(check.context);
  }

  return checks;
}

function comparableTimestamp(item) {
  const timestamp = item?.completed_at ?? item?.started_at ?? item?.updated_at ?? item?.created_at;
  if (typeof timestamp !== "string") return 0;
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? 0 : value;
}

function stringField(item, field) {
  const value = item?.[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isNewer(item, current) {
  const itemTime = comparableTimestamp(item);
  const currentTime = comparableTimestamp(current);
  if (itemTime !== currentTime) return itemTime > currentTime;
  return Number(item.id ?? 0) > Number(current.id ?? 0);
}

function latestByStringField(items, field) {
  const latest = new Map();
  for (const item of items) {
    const key = stringField(item, field);
    if (key === undefined) continue;
    const current = latest.get(key);
    if (current === undefined || isNewer(item, current)) {
      latest.set(key, item);
    }
  }
  return latest;
}

export function latestCheckRunsByName(checkRuns) {
  return latestByStringField(checkRuns, "name");
}

export function latestStatusesByContext(statuses) {
  return latestByStringField(statuses, "context");
}

function describeCheckRun(run) {
  if (run.status !== "completed") return String(run.status ?? "unknown");
  return String(run.conclusion ?? "unknown");
}

function describeStatus(status) {
  return String(status.state ?? "unknown");
}

export function evaluateRequiredChecks(requiredChecks, checkRuns, statuses) {
  const checkRunsByName = latestCheckRunsByName(checkRuns);
  const statusesByContext = latestStatusesByContext(statuses);
  const passed = [];
  const pending = [];
  const failed = [];
  const missing = [];

  for (const name of requiredChecks) {
    recordRequiredCheck(name, {
      checkRunsByName,
      failed,
      missing,
      passed,
      pending,
      statusesByContext,
    });
  }

  return {
    failed,
    missing,
    ok: failed.length === 0 && missing.length === 0 && pending.length === 0,
    passed,
    pending,
  };
}

function recordRequiredCheck(name, context) {
  const { checkRunsByName, failed, missing, passed, pending, statusesByContext } = context;
  const checkRun = checkRunsByName.get(name);
  if (checkRun !== undefined) {
    recordCheckRun(name, checkRun, { failed, passed, pending });
    return;
  }

  const status = statusesByContext.get(name);
  if (status !== undefined) {
    recordStatus(name, status, { failed, passed, pending });
    return;
  }

  missing.push(name);
}

function recordCheckRun(name, checkRun, result) {
  if (checkRun.status === "completed" && checkRun.conclusion === "success") {
    result.passed.push(name);
    return;
  }
  const entry = { name, source: "check-run", state: describeCheckRun(checkRun) };
  if (checkRun.status === "completed") {
    result.failed.push(entry);
    return;
  }
  result.pending.push(entry);
}

function recordStatus(name, status, result) {
  if (status.state === "success") {
    result.passed.push(name);
    return;
  }
  const entry = { name, source: "status", state: describeStatus(status) };
  if (status.state === "pending") {
    result.pending.push(entry);
    return;
  }
  result.failed.push(entry);
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer but received ${String(value)}.`);
  }
  return parsed;
}

function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": githubApiVersion,
  };
  if (typeof token === "string" && token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function githubJson(path, token) {
  const ghJson = githubJsonFromGh(path, token);
  if (ghJson !== undefined) return ghJson;
  return githubJsonFromFetch(path, token);
}

function githubJsonFromGh(path, token) {
  const env = { ...process.env };
  if (typeof token === "string" && token.length > 0) {
    env.GH_TOKEN = token;
  }
  const result = spawnSync(
    "gh",
    ["api", path, "--header", `X-GitHub-Api-Version: ${githubApiVersion}`],
    {
      encoding: "utf8",
      env,
    },
  );
  if (result.error?.code === "ENOENT") return undefined;
  if (result.status !== 0) {
    throw new Error(`gh api ${path} exited ${String(result.status)}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

async function githubJsonFromFetch(path, token) {
  const response = await globalThis.fetch(`https://api.github.com${path}`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${path} returned ${response.status}: ${body}`);
  }
  return response.json();
}

async function resolveRequiredChecks({ baseBranch, owner, repo, token, value }) {
  const configured = parseRequiredChecks(value);
  if (configured.length > 0) return configured;

  const protection = await githubJson(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(
      baseBranch,
    )}/protection`,
    token,
  );
  const fromProtection = requiredChecksFromBranchProtection(protection);
  if (fromProtection.length === 0) {
    throw new Error(`No required checks configured for ${baseBranch}.`);
  }
  return fromProtection;
}

async function fetchCommitEvidence({ owner, repo, sha, token }) {
  const [checkRunsPayload, statusPayload] = await Promise.all([
    githubJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(
        sha,
      )}/check-runs?per_page=100&filter=latest`,
      token,
    ),
    githubJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(
        sha,
      )}/status`,
      token,
    ),
  ]);
  return {
    checkRuns: Array.isArray(checkRunsPayload.check_runs) ? checkRunsPayload.check_runs : [],
    statuses: Array.isArray(statusPayload.statuses) ? statusPayload.statuses : [],
  };
}

function formatNamedStates(entries) {
  return entries.map((entry) => `${entry.name} (${entry.state})`).join(", ");
}

function readRuntimeConfig() {
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.RELEASE_SHA ?? process.env.GITHUB_SHA;
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const baseBranch = process.env.RELEASE_BASE_BRANCH ?? defaultBaseBranch;
  const timeoutSeconds = parsePositiveInteger(
    process.env.RELEASE_CHECK_TIMEOUT_SECONDS,
    defaultTimeoutSeconds,
  );
  const pollSeconds = parsePositiveInteger(
    process.env.RELEASE_CHECK_POLL_SECONDS,
    defaultPollSeconds,
  );

  if (typeof repository !== "string" || !repository.includes("/")) {
    throw new Error("Set GITHUB_REPOSITORY to owner/repo.");
  }
  if (typeof sha !== "string" || sha.length === 0) {
    throw new Error("Set RELEASE_SHA or GITHUB_SHA to the release commit SHA.");
  }

  const [owner, repo] = repository.split("/", 2);
  return {
    baseBranch,
    owner,
    pollSeconds,
    repo,
    sha,
    timeoutSeconds,
    token,
  };
}

async function verifyRequiredChecks() {
  const config = readRuntimeConfig();
  const requiredChecks = await resolveRequiredChecks({
    baseBranch: config.baseBranch,
    owner: config.owner,
    repo: config.repo,
    token: config.token,
    value: process.env.RELEASE_REQUIRED_CHECKS,
  });
  const timeoutAt = Date.now() + config.timeoutSeconds * 1000;

  console.log(
    `release-required-checks: verifying ${requiredChecks.length} required checks for ${config.sha} ` +
      `against ${config.baseBranch}.`,
  );

  await waitForRequiredChecks(config, requiredChecks, timeoutAt);
}

async function waitForRequiredChecks(config, requiredChecks, timeoutAt) {
  for (;;) {
    const evidence = await fetchCommitEvidence(config);
    const result = evaluateRequiredChecks(requiredChecks, evidence.checkRuns, evidence.statuses);

    if (result.ok) {
      console.log(
        `release-required-checks: PASS - ${result.passed.length} required checks succeeded.`,
      );
      return;
    }

    if (result.failed.length > 0) {
      throw new Error(`Required checks failed: ${formatNamedStates(result.failed)}.`);
    }

    const missingText = result.missing.length > 0 ? `missing: ${result.missing.join(", ")}` : "";
    const pendingText =
      result.pending.length > 0 ? `pending: ${formatNamedStates(result.pending)}` : "";
    const waitingFor = [pendingText, missingText].filter((entry) => entry.length > 0).join("; ");

    if (Date.now() >= timeoutAt) {
      throw new Error(`Timed out waiting for required checks (${waitingFor}).`);
    }

    console.log(`release-required-checks: waiting for ${waitingFor}.`);
    await sleep(config.pollSeconds * 1000);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  verifyRequiredChecks().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
