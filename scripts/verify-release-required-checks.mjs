#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

const githubApiVersion = "2022-11-28";
const defaultBaseBranch = "release/1.0";
const defaultPollSeconds = 15;
// ADR-0177 D8 writes the stable tag on the dev push, so every waiter on that tag runs beside the
// tagged commit's CI and must be able to span a whole run: 32 to 36 minutes when runners are free,
// 62 under congestion, and the longest ci.yml job may take 50. A failed check is refused at once.
const defaultTimeoutSeconds = 90 * 60;

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
    throw new TypeError(
      "RELEASE_REQUIRED_CHECKS must be a JSON array, comma list, or newline list.",
    );
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

// ADR-0178. An integration run reuses the required matrix's verdict when this commit's tree is
// byte-identical to a pull-request head that matrix already proved green, so the gate it reused
// reports `skipped` on THIS commit while its evidence binds the tree-identical head. The release
// binds a tree, not a sha: the tagged commit and that head cannot differ in one byte a gate could
// read. This step therefore resolves a `skipped` required check — and ONLY `skipped` — against a
// commit that carries the identical tree.
//
// It never rescues a check that ran and FAILED here, never accepts evidence from a commit whose
// tree was not confirmed equal, and returns the verdict untouched when no such evidence exists.

/**
 * Re-classify `skipped` required checks that an identical tree already proved green.
 * @param {{failed: Array<{name: string, state: string}>, missing: string[], ok: boolean, passed: string[], pending: unknown[]}} result
 * @param {Array<{name?: unknown, status?: unknown, conclusion?: unknown}>} treeCheckRuns
 * @returns {typeof result}
 */
/** Identity of a check for reuse: its name AND the app that produced it. */
function evidenceKey(name, appId) {
  return `${String(name)}\u0000${appId === undefined || appId === null ? "" : String(appId)}`;
}

export function resolveSkippedWithTreeEvidence(result, treeCheckRuns) {
  // Keyed by name AND producing app id. A check name is not unique across GitHub Apps, so matching
  // on the name alone would let an unrelated app's same-named success rescue a skipped required
  // check. An entry whose own app is unknown can only be matched by an evidence run whose app is
  // equally unknown, so the pairing never loosens.
  const provenByTree = new Set(
    (Array.isArray(treeCheckRuns) ? treeCheckRuns : [])
      .filter((run) => run?.status === "completed" && run?.conclusion === "success")
      .filter((run) => typeof run?.name === "string")
      .map((run) => evidenceKey(run.name, run?.app?.id)),
  );
  if (provenByTree.size === 0) return result;

  const rescued = result.failed.filter(
    (entry) => entry.state === "skipped" && provenByTree.has(evidenceKey(entry.name, entry.appId)),
  );
  if (rescued.length === 0) return result;

  const stillFailed = result.failed.filter((entry) => !rescued.includes(entry));
  const passed = [...result.passed, ...rescued.map((entry) => entry.name)];
  return {
    ...result,
    failed: stillFailed,
    ok: stillFailed.length === 0 && result.missing.length === 0 && result.pending.length === 0,
    passed,
  };
}

function recordCheckRun(name, checkRun, result) {
  if (checkRun.status === "completed" && checkRun.conclusion === "success") {
    result.passed.push(name);
    return;
  }
  const entry = {
    name,
    source: "check-run",
    state: describeCheckRun(checkRun),
    appId: checkRun?.app?.id,
  };
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
  let executable;
  try {
    executable = resolveHostExecutable("gh");
  } catch {
    return undefined;
  }
  const env = { ...process.env };
  if (typeof token === "string" && token.length > 0) {
    env.GH_TOKEN = token;
  }
  const result = spawnSync(
    executable,
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

/**
 * Read the tree sha a commit points at, or undefined when it cannot be read.
 * @returns {Promise<string | undefined>}
 */
export async function fetchTreeSha({ owner, repo, sha, token }) {
  try {
    const commit = await githubJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`,
      token,
    );
    const treeSha = commit?.commit?.tree?.sha;
    return typeof treeSha === "string" && /^[0-9a-f]{40}$/.test(treeSha) ? treeSha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collect check runs from commits that carry the IDENTICAL tree to this one. Only the heads of
 * pull requests this commit merged are considered, and each candidate's tree is confirmed equal
 * before any of its evidence is used. Any error yields no evidence, so the caller fails closed.
 * @returns {Promise<Array<{name?: unknown, status?: unknown, conclusion?: unknown}>>}
 */
export async function fetchTreeIdenticalCheckRuns({ owner, repo, sha, token }) {
  const treeSha = await fetchTreeSha({ owner, repo, sha, token });
  if (treeSha === undefined) return [];
  let pulls;
  try {
    pulls = await githubJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/pulls?per_page=100`,
      token,
    );
  } catch {
    return [];
  }
  if (!Array.isArray(pulls)) return [];

  // ONE candidate, never a union. Combining check runs from several tree-identical commits would
  // let a gate be satisfied by pieces from different runs, with no single commit having passed the
  // complete gate. The first candidate that carries the identical tree is the evidence, or there
  // is none.
  for (const pull of pulls) {
    const headSha = pull?.head?.sha;
    if (typeof headSha !== "string" || headSha === sha) continue;
    const runs = await checkRunsForIdenticalTree({ headSha, owner, repo, token, treeSha });
    if (runs.length > 0) return runs;
  }
  return [];
}

/**
 * Read one candidate head's check runs, but only after confirming it carries the identical tree.
 * A tree that cannot be read, or that differs, yields nothing.
 * @returns {Promise<Array<{name?: unknown, status?: unknown, conclusion?: unknown}>>}
 */
export async function checkRunsForIdenticalTree({ headSha, owner, repo, token, treeSha }) {
  const headTree = await fetchTreeSha({ owner, repo, sha: headSha, token });
  if (headTree === undefined || headTree !== treeSha) return [];
  try {
    const payload = await githubJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100&filter=latest`,
      token,
    );
    return Array.isArray(payload.check_runs) ? payload.check_runs : [];
  } catch {
    return [];
  }
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

/**
 * A required check that a tree-identical commit already proved green is evidence, not absence
 * (ADR-0178). Only `skipped` is resolved this way, and only after the trees are confirmed equal;
 * a verdict with nothing skipped is returned untouched without any extra API call.
 * @returns {Promise<typeof verdict>}
 */
export async function applyTreeEvidence(config, verdict) {
  if (!verdict.failed.some((entry) => entry.state === "skipped")) return verdict;
  const resolved = resolveSkippedWithTreeEvidence(
    verdict,
    await fetchTreeIdenticalCheckRuns(config),
  );
  for (const name of resolved.passed.filter((entry) => !verdict.passed.includes(entry))) {
    console.log(`release-required-checks: ${name} reused proven evidence from an identical tree.`);
  }
  return resolved;
}

async function waitForRequiredChecks(config, requiredChecks, timeoutAt) {
  for (;;) {
    const evidence = await fetchCommitEvidence(config);
    const result = await applyTreeEvidence(
      config,
      evaluateRequiredChecks(requiredChecks, evidence.checkRuns, evidence.statuses),
    );

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
  try {
    await verifyRequiredChecks();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
