#!/usr/bin/env node
// Resolve whether the exact tree this integration run was handed has ALREADY been proven green by
// a pull-request run, so the required matrix is never charged twice for identical bytes.
//
// Why a tree and not a commit: `dev` is protected with linear history and signed SQUASH merges, and
// branch protection only integrates a head that is up to date with its base. The squash commit that
// lands on `dev` therefore carries a DIFFERENT commit sha but the IDENTICAL tree sha as the pull
// request head the required matrix already measured. A tree sha is the recursive content hash of
// the whole worktree — every source file, every lockfile, every workflow file under `.github/`.
// Two commits that share it cannot differ in a single byte a gate could read. Re-running the matrix
// on that tree cannot discover anything the pull-request run did not already see; it can only
// re-roll the dice on flaky infrastructure and paint a verified tree red (Issue: 15 of the last 100
// `dev` runs failed this way, at 48 minutes each).
//
// This is evidence REUSE, not evidence loss, and it fails closed on every uncertainty:
//   * anything other than a `push` to a protected integration branch or a `merge_group` -> no reuse
//   * no merged pull request whose `merge_commit_sha` is exactly this commit -> no reuse
//   * the pull-request head tree differs from this commit's tree by one byte -> no reuse
//   * no completed `pull_request` CI run on that head, or it did not conclude `success` -> no reuse
//   * the candidate run SKIPPED any job whose result would now be reused -> no reuse
//   * any API error, malformed payload, or unreadable field -> no reuse
// Because a workflow file lives inside the tree, editing CI itself changes the tree and forces a
// full run by construction. There is no path by which reuse can outlive the evidence it cites.

import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Jobs whose verdict this run reuses. A candidate that skipped one of them is not evidence. */
export const REUSED_JOB_NAMES = Object.freeze([
  "Semantic duplication",
  "Core quality",
  "Coverage suite (keiko-ui)",
  "Coverage suite (scripts)",
  "Coverage and SonarCloud",
  "Build, scan, SBOM, smoke",
  "Node 26 compatibility",
  "ui",
]);

/** Job-name prefixes whose verdict this run reuses (matrix legs carry a suffix). */
export const REUSED_JOB_PREFIXES = Object.freeze([
  "Cross-platform smoke",
  "Coverage shard (packages",
]);

const API_ROOT = "https://api.github.com";

/** @typedef {{ verified: false, reason: string }} NotVerified */
/** @typedef {{ verified: true, runId: number, headSha: string, treeSha: string }} Verified */

/**
 * Read a required environment variable, failing closed when it is absent or blank.
 * @param {string} name
 * @returns {string}
 */
export function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value.trim();
}

/**
 * Call the GitHub REST API and parse the JSON body, failing closed on any non-2xx status.
 * @param {string} path
 * @param {string} token
 * @returns {Promise<unknown>}
 */
export async function api(path, token) {
  const response = await globalThis.fetch(`${API_ROOT}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${path}`);
  }
  return response.json();
}

/**
 * Resolve the tree sha a commit points at.
 * @param {string} repo
 * @param {string} sha
 * @param {string} token
 * @returns {Promise<string>}
 */
export async function resolveTreeSha(repo, sha, token) {
  const commit = await api(`/repos/${repo}/commits/${sha}`, token);
  const treeSha = /** @type {{ commit?: { tree?: { sha?: unknown } } }} */ (commit).commit?.tree
    ?.sha;
  if (typeof treeSha !== "string" || !/^[0-9a-f]{40}$/.test(treeSha)) {
    throw new Error(`commit ${sha} returned no usable tree sha`);
  }
  return treeSha;
}

/**
 * Find the merged pull request this exact integration commit came from.
 * @param {string} repo
 * @param {string} sha
 * @param {string} token
 * @returns {Promise<{ number: number, headSha: string } | null>}
 */
export async function resolveMergedPullRequest(repo, sha, token) {
  const pulls = await api(`/repos/${repo}/commits/${sha}/pulls?per_page=100`, token);
  if (!Array.isArray(pulls)) {
    return null;
  }
  for (const pull of pulls) {
    const accepted = acceptMergedPullCandidate(pull, sha);
    if (accepted !== null) {
      return accepted;
    }
  }
  return null;
}

/**
 * Decide whether ONE candidate from the commit-association endpoint is the merged pull request this
 * exact integration commit came from. Pure, so every rejection is directly provable.
 *
 * Each condition closes a specific way a non-candidate could pass:
 *   * `merged_at` must be a non-empty STRING — a `=== null` test alone admits an absent or
 *     non-string field, letting an unmerged pull request satisfy it;
 *   * `merge_commit_sha` must be THIS commit — the endpoint also returns pull requests that merely
 *     CONTAIN the commit, whose green run would then stand in as evidence for a different tree;
 *   * `number` and `head.sha` must be usable, or there is nothing to look evidence up with.
 * @param {unknown} pull
 * @param {string} sha
 * @returns {{ number: number, headSha: string } | null}
 */
export function acceptMergedPullCandidate(pull, sha) {
  const candidate =
    /** @type {{ number?: unknown, merged_at?: unknown, merge_commit_sha?: unknown, head?: { sha?: unknown } }} */ (
      pull
    );
  if (typeof candidate?.merged_at !== "string" || candidate.merged_at.length === 0) {
    return null;
  }
  if (typeof candidate.merge_commit_sha !== "string" || candidate.merge_commit_sha !== sha) {
    return null;
  }
  const number = candidate.number;
  const headSha = candidate.head?.sha;
  if (typeof number !== "number" || typeof headSha !== "string" || headSha.length === 0) {
    return null;
  }
  return { number, headSha };
}

/**
 * Find a completed, successful pull-request CI run on the given head that skipped none of the jobs
 * whose verdict would be reused.
 * @param {string} repo
 * @param {string} headSha
 * @param {string} workflowFile
 * @param {string} token
 * @returns {Promise<{ runId: number } | null>}
 */
export async function resolveGreenPullRequestRun(repo, headSha, workflowFile, token) {
  const runs = await api(
    `/repos/${repo}/actions/workflows/${workflowFile}/runs?head_sha=${headSha}&event=pull_request&status=success&per_page=20`,
    token,
  );
  const candidates = /** @type {{ workflow_runs?: unknown }} */ (runs).workflow_runs;
  if (!Array.isArray(candidates)) {
    return null;
  }
  for (const candidate of candidates) {
    const run = /** @type {{ id?: unknown, conclusion?: unknown }} */ (candidate);
    if (typeof run.id !== "number" || run.conclusion !== "success") {
      continue;
    }
    if (await candidateProvedEveryReusedJob(repo, run.id, token)) {
      return { runId: run.id };
    }
  }
  return null;
}

/**
 * A run only counts as evidence when every job this integration run is about to skip actually
 * EXECUTED there and concluded `success`. A skipped job in the candidate would otherwise let an
 * unmeasured gate pass itself off as proven.
 * @param {string} repo
 * @param {number} runId
 * @param {string} token
 * @returns {Promise<boolean>}
 */
export async function candidateProvedEveryReusedJob(repo, runId, token) {
  const payload = await api(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, token);
  const jobs = /** @type {{ jobs?: unknown }} */ (payload).jobs;
  if (!Array.isArray(jobs)) {
    return false;
  }
  const succeeded = new Set(
    jobs
      .filter((job) => /** @type {{ conclusion?: unknown }} */ (job).conclusion === "success")
      .map((job) => /** @type {{ name?: unknown }} */ (job).name)
      .filter((name) => typeof name === "string"),
  );
  const everyNamedJobPassed = REUSED_JOB_NAMES.every((name) => succeeded.has(name));
  const everyPrefixedJobPassed = REUSED_JOB_PREFIXES.every((prefix) =>
    [...succeeded].some((name) => name.startsWith(prefix)),
  );
  return everyNamedJobPassed && everyPrefixedJobPassed;
}

/**
 * Decide whether this run may reuse pull-request evidence for its exact tree.
 * @returns {Promise<Verified | NotVerified>}
 */
export async function resolveEvidence() {
  const eventName = requireEnv("KEIKO_EVENT_NAME");
  if (eventName !== "push" && eventName !== "merge_group") {
    return { verified: false, reason: `event ${eventName} always runs the full matrix` };
  }
  const repo = requireEnv("KEIKO_REPOSITORY");
  const sha = requireEnv("KEIKO_HEAD_SHA");
  const token = requireEnv("KEIKO_TOKEN");
  const workflowFile = process.env.KEIKO_WORKFLOW_FILE?.trim() || "ci.yml";

  const pull = await resolveMergedPullRequest(repo, sha, token);
  if (pull === null) {
    return { verified: false, reason: "no merged pull request resolves to this exact commit" };
  }
  const [integrationTree, candidateTree] = await Promise.all([
    resolveTreeSha(repo, sha, token),
    resolveTreeSha(repo, pull.headSha, token),
  ]);
  if (integrationTree !== candidateTree) {
    return {
      verified: false,
      reason: `tree differs from pull request #${pull.number} head (${integrationTree} != ${candidateTree})`,
    };
  }
  const green = await resolveGreenPullRequestRun(repo, pull.headSha, workflowFile, token);
  if (green === null) {
    return {
      verified: false,
      reason: `pull request #${pull.number} head ${pull.headSha} has no complete green CI run`,
    };
  }
  return { verified: true, runId: green.runId, headSha: pull.headSha, treeSha: integrationTree };
}

/**
 * Publish the verdict as step outputs and a human-readable line.
 * @param {Verified | NotVerified} evidence
 * @returns {Promise<void>}
 */
export async function publish(evidence) {
  const outputPath = process.env.GITHUB_OUTPUT;
  const lines = evidence.verified
    ? [
        "tree-verified=true",
        `evidence-run-id=${evidence.runId}`,
        `evidence-head-sha=${evidence.headSha}`,
        `evidence-tree-sha=${evidence.treeSha}`,
      ]
    : ["tree-verified=false", "evidence-run-id=", "evidence-head-sha=", "evidence-tree-sha="];
  if (typeof outputPath === "string" && outputPath !== "") {
    await appendFile(outputPath, `${lines.join("\n")}\n`, "utf8");
  }
  if (evidence.verified) {
    console.log(
      `tree ${evidence.treeSha} already proven green by run ${evidence.runId} on head ${evidence.headSha} — reusing that evidence`,
    );
    return;
  }
  console.log(`full matrix required: ${evidence.reason}`);
}

// Only resolve when RUN as the workflow step. Importing this module — as the regression suite does
// to prove `acceptMergedPullCandidate` — must not perform lookups or publish a verdict.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    await publish(await resolveEvidence());
  } catch (error) {
    // Fail closed: an unreadable answer is never a reason to skip a gate.
    console.log(
      `full matrix required: evidence could not be resolved (${error instanceof Error ? error.message : "unknown error"})`,
    );
    await publish({ verified: false, reason: "unresolved" });
  }
}
