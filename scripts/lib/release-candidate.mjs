// ADR-0177 D8: a green dev head whose version is approved for every portable target and not yet
// published is the release candidate, and `v<version>` points at it. This module owns the decision
// and the tag write; `scripts/release-candidate.mjs` only wires the host executables, so every
// branch here is proven in-process.

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
// A release.yml publish is open from its dispatch until it completes, including while it waits for
// the npm-publish approval: that approval is given for the commit the run was dispatched for, so the
// tag must not move under it. The publish request reads the same set.
export const OPEN_RUN_STATUSES = new Set([
  "requested",
  "waiting",
  "pending",
  "queued",
  "in_progress",
]);
const WRITING_ACTIONS = new Set(["create", "move"]);

class ReleaseCandidateError extends Error {}

function fail(message) {
  throw new ReleaseCandidateError(`release-candidate: ${message}`);
}

function requireCommitSha(value, label) {
  if (typeof value !== "string" || !COMMIT_SHA.test(value)) {
    fail(`${label} is not a full commit SHA.`);
  }
  return value;
}

/**
 * @param readiness         portableRehearsalReadiness() for the candidate checkout
 * @param candidateSha      the green dev commit this run was started for
 * @param devHeadSha        the dev head right now
 * @param published         npm or GitHub already carries the version
 * @param remoteTagSha      the commit `v<version>` points at, or undefined when it does not exist
 * @param publishRunActive  a release.yml publish of this tag is open, waiting for approval included
 * @returns {{ action: "skip" | "keep" | "create" | "move", tag: string, reason: string }}
 */
export function releaseCandidatePlan({
  candidateSha,
  devHeadSha,
  publishRunActive,
  published,
  readiness,
  remoteTagSha,
}) {
  requireCommitSha(candidateSha, "the candidate commit");
  requireCommitSha(devHeadSha, "the dev head");
  if (remoteTagSha !== undefined) requireCommitSha(remoteTagSha, "the release tag commit");
  const tag = readiness.releaseTag;
  if (!readiness.ready) return { action: "skip", tag, reason: readiness.reason };
  if (devHeadSha !== candidateSha) {
    return {
      action: "skip",
      tag,
      reason: `dev has moved on to ${devHeadSha}, the newer candidate`,
    };
  }
  if (published) {
    return { action: "skip", tag, reason: `${tag} is already published, and its tag never moves` };
  }
  if (remoteTagSha === candidateSha) {
    return { action: "keep", tag, reason: `${tag} already points at ${candidateSha}` };
  }
  if (remoteTagSha === undefined) {
    return { action: "create", tag, reason: `${tag} does not exist yet` };
  }
  if (publishRunActive) {
    return {
      action: "skip",
      tag,
      reason: `a publish of ${tag} is open, so the tag stays at ${remoteTagSha} until it ends`,
    };
  }
  return { action: "move", tag, reason: `${tag} moves from ${remoteTagSha} to the green dev head` };
}

function readGithub(runGh, path) {
  const result = runGh(["api", path]);
  if (result?.error === undefined && result?.status === 0) {
    try {
      return { kind: "found", value: JSON.parse(String(result.stdout)) };
    } catch {
      return { kind: "error" };
    }
  }
  return /\bHTTP 404\b/u.test(String(result?.stderr ?? ""))
    ? { kind: "missing" }
    : { kind: "error" };
}

/** A GitHub API read that must succeed; any failure, a 404 included, fails closed. */
function readFound(runGh, path, label) {
  const read = readGithub(runGh, path);
  if (read.kind !== "found") fail(`${label} could not be read.`);
  return read.value;
}

function peeledTagCommit(runGh, repository, tag, target) {
  if (target?.type === "commit") return requireCommitSha(target.sha, `the ${tag} ref`);
  if (target?.type !== "tag") fail(`the ${tag} ref points at a ${String(target?.type)}.`);
  const annotated = readFound(
    runGh,
    `repos/${repository}/git/tags/${target.sha}`,
    `the ${tag} tag`,
  );
  if (annotated?.object?.type !== "commit") fail(`the ${tag} tag does not point at a commit.`);
  return requireCommitSha(annotated.object.sha, `the ${tag} tag`);
}

/** The commit `tag` points at, peeling an annotated tag, or undefined when the tag does not exist. */
export function remoteTagCommit(runGh, repository, tag) {
  const ref = readGithub(runGh, `repos/${repository}/git/ref/tags/${tag}`);
  if (ref.kind === "missing") return undefined;
  if (ref.kind === "error") fail(`the ${tag} ref could not be read.`);
  return peeledTagCommit(runGh, repository, tag, ref.value?.object);
}

function releaseExists(runGh, repository, tag) {
  const release = readGithub(runGh, `repos/${repository}/releases/tags/${tag}`);
  if (release.kind === "error") fail(`the GitHub release for ${tag} could not be read.`);
  return release.kind === "found";
}

function npmHasVersion(runNpm, packageName, version) {
  const result = runNpm(["view", `${packageName}@${version}`, "version", "--json"]);
  if (result?.error === undefined && result?.status === 0) {
    return String(result.stdout).trim() === JSON.stringify(version);
  }
  if (/\bE404\b/u.test(`${String(result?.stdout ?? "")}${String(result?.stderr ?? "")}`))
    return false;
  return fail(`npm could not say whether ${packageName}@${version} exists.`);
}

const RUN_PAGE_SIZE = 100;
// A release history still full after this many pages is not one this repository has; refusing it
// bounds the read instead of deciding on a partial listing.
const RUN_PAGE_LIMIT = 20;

/**
 * Every workflow_dispatch run of release.yml, page by page until a page is not full. A malformed
 * page or an unbounded listing fails closed: a decision on one page could miss an open publish.
 */
export function readReleaseDispatchRuns(runGh, repository) {
  const runs = [];
  for (let page = 1; page <= RUN_PAGE_LIMIT; page += 1) {
    const listing = readFound(
      runGh,
      `repos/${repository}/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=${RUN_PAGE_SIZE}&page=${page}`,
      "the release workflow runs",
    );
    if (!Array.isArray(listing?.workflow_runs)) fail("the release workflow runs are malformed.");
    runs.push(...listing.workflow_runs);
    if (listing.workflow_runs.length < RUN_PAGE_SIZE) return runs;
  }
  return fail(`the release workflow runs span more than ${RUN_PAGE_LIMIT} pages.`);
}

function publishRunActive(runGh, repository, tag) {
  return readReleaseDispatchRuns(runGh, repository).some(
    (run) => run?.head_branch === tag && OPEN_RUN_STATUSES.has(run?.status),
  );
}

/**
 * Gathers every fact the plan needs through the caller's host seams.
 *
 * @param runGh   (args) => {status, stdout, stderr, error}; reads with the workflow token
 * @param runNpm  (args) => {status, stdout, stderr, error}
 */
export function planReleaseCandidate({
  candidateSha,
  repository,
  rootPackage,
  readiness,
  runGh,
  runNpm,
}) {
  const tag = readiness.releaseTag;
  const devHead = readFound(runGh, `repos/${repository}/git/ref/heads/dev`, "the dev head");
  const facts = {
    candidateSha,
    devHeadSha: devHead?.object?.sha,
    publishRunActive: false,
    published: false,
    readiness,
    remoteTagSha: undefined,
  };
  if (readiness.ready) {
    facts.published =
      npmHasVersion(runNpm, rootPackage.name, rootPackage.version) ||
      releaseExists(runGh, repository, tag);
    facts.remoteTagSha = remoteTagCommit(runGh, repository, tag);
    facts.publishRunActive = publishRunActive(runGh, repository, tag);
  }
  return releaseCandidatePlan(facts);
}

/**
 * Writes the tag for a create or move plan with the tag token and proves the result by reading
 * the ref back. Any other plan writes nothing.
 *
 * @param runGhWithTagToken  (args) => {status, stdout, stderr, error}; the GitHub App token
 */
export function applyReleaseCandidatePlan({
  candidateSha,
  plan,
  repository,
  runGh,
  runGhWithTagToken,
}) {
  if (!WRITING_ACTIONS.has(plan.action)) return false;
  const args =
    plan.action === "create"
      ? [
          "api",
          "--method",
          "POST",
          `repos/${repository}/git/refs`,
          "-f",
          `ref=refs/tags/${plan.tag}`,
          "-f",
          `sha=${candidateSha}`,
        ]
      : [
          "api",
          "--method",
          "PATCH",
          `repos/${repository}/git/refs/tags/${plan.tag}`,
          "-f",
          `sha=${candidateSha}`,
          "-F",
          "force=true",
        ];
  const result = runGhWithTagToken(args);
  if (result?.error !== undefined || result?.status !== 0) {
    fail(`the ${plan.tag} tag could not be written (${plan.action}).`);
  }
  if (remoteTagCommit(runGh, repository, plan.tag) !== candidateSha) {
    fail(`${plan.tag} does not point at ${candidateSha} after the write.`);
  }
  return true;
}

const RUN_MODES = new Set(["--plan", "--apply"]);
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;

/**
 * The whole run behind `scripts/release-candidate.mjs`. `--plan` decides and hands the action to
 * the workflow; `--apply` decides again from fresh facts, because dev or a publish can move between
 * the two jobs, and writes the tag only for a create or move.
 *
 * @param decideReadiness  ({catalog, rootPackage}) => portableRehearsalReadiness() result
 * @param readText         (repositoryRelativePath) => file text of the candidate checkout
 * @param appendFile       (path, text) => void, for GITHUB_OUTPUT and GITHUB_STEP_SUMMARY
 */
export function runReleaseCandidate({
  appendFile,
  decideReadiness,
  env,
  mode,
  readText,
  runGh,
  runGhWithTagToken,
  runNpm,
}) {
  const { candidateSha, repository } = runInputs(env, mode);
  const rootPackage = JSON.parse(readText("package.json"));
  const catalog = JSON.parse(readText("release-impact.catalog.json"));
  const readiness = decideReadiness({ catalog, rootPackage });
  const plan = planReleaseCandidate({
    candidateSha,
    readiness,
    repository,
    rootPackage,
    runGh,
    runNpm,
  });
  const writes = mode === "--apply" && WRITING_ACTIONS.has(plan.action);
  if (writes) {
    if (typeof env.KEIKO_RELEASE_TAG_TOKEN !== "string" || env.KEIKO_RELEASE_TAG_TOKEN === "") {
      fail("the release tag token is missing.");
    }
    applyReleaseCandidatePlan({ candidateSha, plan, repository, runGh, runGhWithTagToken });
  }
  const line = writes
    ? `Release candidate ${candidateSha}: ${plan.tag} written (${plan.action}), ${plan.reason}.`
    : `Release candidate ${candidateSha}: ${plan.action}, ${plan.reason}.`;
  reportRun({ appendFile, env, line, mode, plan });
  return { line, plan };
}

function runInputs(env, mode) {
  if (!RUN_MODES.has(mode)) fail("pass --plan or --apply.");
  const candidateSha = requireCommitSha(env.CANDIDATE_SHA, "CANDIDATE_SHA");
  const repository = env.GITHUB_REPOSITORY;
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) {
    fail("GITHUB_REPOSITORY is not owner/repo.");
  }
  return { candidateSha, repository };
}

function reportRun({ appendFile, env, line, mode, plan }) {
  if (mode === "--plan" && env.GITHUB_OUTPUT) {
    appendFile(env.GITHUB_OUTPUT, `action=${plan.action}\ntag=${plan.tag}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) appendFile(env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

/**
 * The CLI around runReleaseCandidate: reads use the workflow token, the tag write uses the GitHub App
 * token, and the run prints one report line or one error line with exit code 1.
 *
 * @param spawn  (executable, args, env) => {status, stdout, stderr, error}
 * @param write  (stream: "stdout" | "stderr", text) => void
 */
export function releaseCandidateMain({
  appendFile,
  argv,
  decideReadiness,
  env,
  readText,
  spawn,
  write,
}) {
  const runner = (executable, token) => (args) =>
    spawn(executable, args, token === undefined ? env : { ...env, GH_TOKEN: token });
  try {
    const { line } = runReleaseCandidate({
      appendFile,
      decideReadiness,
      env,
      mode: argv[0],
      readText,
      runGh: runner("gh", env.GITHUB_TOKEN),
      runGhWithTagToken: runner("gh", env.KEIKO_RELEASE_TAG_TOKEN),
      runNpm: runner("npm", undefined),
    });
    write("stdout", `${line}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report =
      error instanceof ReleaseCandidateError ? message : `release-candidate: ${message}`;
    write("stderr", `${report}\n`);
    return 1;
  }
}
