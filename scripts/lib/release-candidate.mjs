// ADR-0177 D8: a green dev head whose version is approved for every portable target and not yet
// published is the release candidate, and `v<version>` points at it. ADR-0177 D9: the release button
// (`release.yml` dispatched on dev by an allowlisted owner) binds the tag to exactly the commit it was
// pressed on, and no later dev push moves the tag away from that request. This module owns the
// decision and the tag write; `scripts/release-candidate.mjs` only wires the host executables, so
// every branch here is proven in-process. The button never prepares a version: the pull request that
// declares a release carries its version bump (check:release-impact refuses an entry ahead of
// package.json, #3565), so a dev head is either published or a fully proven unreleased version.

import { readFound, readGithub } from "./github-api.mjs";

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
// A release.yml run is open from its dispatch until it completes. A publish and its portable inputs
// are bound to the commit the run was dispatched for, so the tag must not move under it, and an owner
// request that is still running holds its tag the same way.
const OPEN_RUN_STATUSES = new Set(["requested", "waiting", "pending", "queued", "in_progress"]);
const WRITING_ACTIONS = new Set(["create", "move"]);
export const PORTABLE_BUILD_OWNERS = Object.freeze({
  DEV_REHEARSAL: "dev-rehearsal",
  NONE: "none",
  STABLE_TAG: "stable-tag",
});

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
 * @param ownerRequestHeld  an owner's release request holds the tag at the commit it points at
 * @param published         npm or GitHub already carries the version
 * @param remoteTagSha      the commit `v<version>` points at, or undefined when it does not exist
 * @param publishRunActive  a release.yml publish of this tag is open, waiting for approval included
 * @returns {{ action: "skip" | "keep" | "create" | "move", portableBuild: "none" | "dev-rehearsal" | "stable-tag", tag: string, reason: string }}
 */
export function releaseCandidatePlan({
  candidateSha,
  devHeadSha,
  ownerRequestHeld = false,
  publishRunActive,
  published,
  readiness,
  remoteTagSha,
}) {
  requireCommitSha(candidateSha, "the candidate commit");
  requireCommitSha(devHeadSha, "the dev head");
  if (remoteTagSha !== undefined) requireCommitSha(remoteTagSha, "the release tag commit");
  const tag = readiness.releaseTag;
  if (!readiness.ready) {
    return {
      action: "skip",
      portableBuild: PORTABLE_BUILD_OWNERS.NONE,
      tag,
      reason: readiness.reason,
    };
  }
  if (devHeadSha !== candidateSha) {
    return {
      action: "skip",
      portableBuild: PORTABLE_BUILD_OWNERS.NONE,
      tag,
      reason: `dev has moved on to ${devHeadSha}, the newer candidate`,
    };
  }
  return currentDevCandidatePlan({
    candidateSha,
    ownerRequestHeld,
    publishRunActive,
    published,
    remoteTagSha,
    tag,
  });
}

function candidatePlan(action, portableBuild, tag, reason) {
  return { action, portableBuild, tag, reason };
}

function currentDevCandidatePlan({
  candidateSha,
  ownerRequestHeld,
  publishRunActive,
  published,
  remoteTagSha,
  tag,
}) {
  const { DEV_REHEARSAL, NONE, STABLE_TAG } = PORTABLE_BUILD_OWNERS;
  if (publishRunActive) {
    return candidatePlan(
      "skip",
      NONE,
      tag,
      `a publish of ${tag} is open, so no second portable build may start`,
    );
  }
  if (published) {
    return candidatePlan(
      "skip",
      DEV_REHEARSAL,
      tag,
      `${tag} is already published, and its tag never moves`,
    );
  }
  if (remoteTagSha === candidateSha) {
    return candidatePlan("keep", STABLE_TAG, tag, `${tag} already points at ${candidateSha}`);
  }
  if (ownerRequestHeld) {
    return candidatePlan(
      "skip",
      NONE,
      tag,
      `a release owner requested ${tag} at ${String(remoteTagSha)}, so the tag stays there`,
    );
  }
  if (remoteTagSha === undefined) {
    return candidatePlan("create", STABLE_TAG, tag, `${tag} does not exist yet`);
  }
  return candidatePlan(
    "move",
    STABLE_TAG,
    tag,
    `${tag} moves from ${remoteTagSha} to the green dev head`,
  );
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

export function releaseExists(runGh, repository, tag) {
  const release = readGithub(runGh, `repos/${repository}/releases/tags/${tag}`);
  if (release.kind === "error") fail(`the GitHub release for ${tag} could not be read.`);
  return release.kind === "found";
}

export function npmHasVersion(runNpm, packageName, version) {
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

const RELEASE_REQUEST_BRANCH = "dev";

/**
 * The allowlisted release owners from `KEIKO_RELEASE_OWNER_GITHUB_LOGINS`, lower-cased because GitHub
 * logins are case-insensitive. Empty, missing, or malformed configuration refuses every owner.
 */
export function releaseOwners(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value ?? ""));
  } catch {
    parsed = undefined;
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every((login) => typeof login === "string" && login !== "" && !login.endsWith("[bot]"));
  if (!valid) fail("KEIKO_RELEASE_OWNER_GITHUB_LOGINS is not a JSON array of human logins.");
  return new Set(parsed.map((login) => login.toLowerCase()));
}

/** True when `login` is an allowlisted human release owner. */
export function isReleaseOwner(login, owners) {
  return typeof login === "string" && !login.endsWith("[bot]") && owners.has(login.toLowerCase());
}

/**
 * True when an allowlisted owner pressed the release button: dispatched release.yml on dev. GitHub
 * records the dispatching account as the run's triggering actor, which no token can choose, so the
 * run is that owner's authorization for exactly its head commit.
 */
export function isOwnerReleaseRequest(run, owners) {
  return (
    run?.event === "workflow_dispatch" &&
    run?.head_branch === RELEASE_REQUEST_BRANCH &&
    isReleaseOwner(run?.triggering_actor?.login, owners)
  );
}

// A successful request, or one still running, holds the tag at its commit. Only an owner's request
// counts: any other account's dispatch never holds the tag, not even for the seconds it is open.
function ownerRequestHolds(runs, owners, remoteTagSha) {
  return runs.some(
    (run) =>
      run?.head_sha === remoteTagSha &&
      isOwnerReleaseRequest(run, owners) &&
      (run?.conclusion === "success" || OPEN_RUN_STATUSES.has(run?.status)),
  );
}

/**
 * Gathers every fact the plan needs through the caller's host seams. A release request binds the
 * exact commit the owner pressed the button on, so it neither yields to a newer dev head nor to an
 * older request; a dev push yields to both.
 *
 * @param owners  releaseOwners(), or undefined where the tag is never written. The dev rehearsal's
 *                readiness reads no repository variable and needs no hold: a held tag and a moved
 *                one both leave that commit without a dev rehearsal.
 * @param request true for the release button, false for a dev push
 * @param runGh   (args) => {status, stdout, stderr, error}; reads with the workflow token
 * @param runNpm  (args) => {status, stdout, stderr, error}
 */
export function planReleaseCandidate({
  candidateSha,
  owners,
  repository,
  request = false,
  rootPackage,
  readiness,
  runGh,
  runNpm,
}) {
  const tag = readiness.releaseTag;
  const facts = {
    candidateSha,
    devHeadSha: request ? candidateSha : readDevHead(runGh, repository),
    ownerRequestHeld: false,
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
    const runs = readReleaseDispatchRuns(runGh, repository);
    facts.publishRunActive = runs.some(
      (run) => run?.head_branch === tag && OPEN_RUN_STATUSES.has(run?.status),
    );
    facts.ownerRequestHeld =
      !request &&
      owners !== undefined &&
      facts.remoteTagSha !== undefined &&
      ownerRequestHolds(runs, owners, facts.remoteTagSha);
  }
  return releaseCandidatePlan(facts);
}

export function readDevHead(runGh, repository) {
  return readFound(runGh, `repos/${repository}/git/ref/heads/dev`, "the dev head")?.object?.sha;
}

function writeArgs(repository, plan, candidateSha) {
  if (plan.action === "create") {
    return [
      "api",
      "--method",
      "POST",
      `repos/${repository}/git/refs`,
      "-f",
      `ref=refs/tags/${plan.tag}`,
      "-f",
      `sha=${candidateSha}`,
    ];
  }
  return [
    "api",
    "--method",
    "PATCH",
    `repos/${repository}/git/refs/tags/${plan.tag}`,
    "-f",
    `sha=${candidateSha}`,
    "-F",
    "force=true",
  ];
}

/**
 * The commit a ref-write response body says the tag now points at, or undefined when the body is
 * not a lightweight ref pointing at a commit. GitHub's git-refs POST/PATCH returns the ref just
 * written with `object.type === "commit"` and `object.sha` set to the commit passed in, so the
 * response body is authoritative and — unlike a subsequent GET — is atomic with the write.
 */
function writtenCommitSha(body) {
  if (body?.object?.type !== "commit") return undefined;
  return typeof body.object.sha === "string" ? body.object.sha : undefined;
}

/**
 * Writes the tag for a create or move plan with the tag token and proves the result from the
 * write's own response body. Any other plan writes nothing.
 *
 * GitHub's git-refs API is eventually consistent for read-after-write: a POST that returns 201
 * (or a PATCH that returns 200) can be invisible to the next GET for a short window, so proving
 * the write by re-reading the ref races that window and turns a successful tag write into a
 * failed job. The write's own response body carries the ref just written — `object.sha` is the
 * commit the ref now points at, atomic with the write and immune to that race — so verify from
 * the body instead. This is not a retry; it is the correct authority for the write's result.
 *
 * @param runGhWithTagToken  (args) => {status, stdout, stderr, error}; the GitHub App token
 */
export function applyReleaseCandidatePlan({ candidateSha, plan, repository, runGhWithTagToken }) {
  if (!WRITING_ACTIONS.has(plan.action)) return false;
  const result = runGhWithTagToken(writeArgs(repository, plan, candidateSha));
  if (result?.error !== undefined || result?.status !== 0) {
    fail(`the ${plan.tag} tag could not be written (${plan.action}).`);
  }
  let body;
  try {
    body = JSON.parse(String(result.stdout ?? ""));
  } catch {
    fail(`the ${plan.tag} write response (${plan.action}) could not be parsed as JSON.`);
  }
  const writtenSha = writtenCommitSha(body);
  if (writtenSha !== candidateSha) {
    fail(
      `${plan.tag} points at ${writtenSha ?? "?"} after the write (${plan.action}), not ${candidateSha}.`,
    );
  }
  return true;
}

const RUN_MODES = new Set(["--plan", "--apply", "--request"]);
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;

function requireTagToken(env) {
  if (typeof env.KEIKO_RELEASE_TAG_TOKEN !== "string" || env.KEIKO_RELEASE_TAG_TOKEN === "") {
    fail("the release tag token is missing.");
  }
}

/**
 * The whole run behind `scripts/release-candidate.mjs`. `--plan` decides and hands the action to
 * the workflow; `--apply` decides again from fresh facts, because dev or a publish can move between
 * the two jobs, and writes the tag only for a create or move. `--request` is the release button: it
 * binds the tag to the pressed commit and fails when that commit cannot be released, so a successful
 * request run is always a releasable one. A dev head whose version is already published is such a
 * failure: there is nothing to release until a pull request declares the next version and carries
 * its bump (#3565).
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
  const request = mode === "--request";
  const plan = planReleaseCandidate({
    candidateSha,
    owners: configuredOwners(env),
    readiness,
    repository,
    request,
    rootPackage,
    runGh,
    runNpm,
  });
  if (request && plan.action === "skip") {
    fail(`${plan.tag} cannot be released from ${candidateSha}: ${plan.reason}.`);
  }
  const writes = mode !== "--plan" && WRITING_ACTIONS.has(plan.action);
  if (writes) {
    requireTagToken(env);
    applyReleaseCandidatePlan({ candidateSha, plan, repository, runGhWithTagToken });
  }
  const line = reportLine({ candidateSha, plan, request, writes });
  reportRun({ appendFile, env, line, mode, plan });
  return { line, plan };
}

function reportLine({ candidateSha, plan, request, writes }) {
  if (request) {
    const tagState = writes ? `${plan.tag} written (${plan.action})` : plan.reason;
    return (
      `Release ${plan.tag} requested for ${candidateSha}: ${tagState}. The publish starts by ` +
      "itself once the tag build and every release-required check are green."
    );
  }
  return writes
    ? `Release candidate ${candidateSha}: ${plan.tag} written (${plan.action}), ${plan.reason}.`
    : `Release candidate ${candidateSha}: ${plan.action}, ${plan.reason}.`;
}

// A job that writes the tag passes the allowlist, and an empty or malformed value fails it closed; the
// rehearsal readiness passes none (see planReleaseCandidate).
function configuredOwners(env) {
  const value = env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS;
  return value === undefined ? undefined : releaseOwners(value);
}

function runInputs(env, mode) {
  if (!RUN_MODES.has(mode)) fail("pass --plan, --apply or --request.");
  const candidateSha = requireCommitSha(env.CANDIDATE_SHA, "CANDIDATE_SHA");
  const repository = env.GITHUB_REPOSITORY;
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) {
    fail("GITHUB_REPOSITORY is not owner/repo.");
  }
  return { candidateSha, repository };
}

function reportRun({ appendFile, env, line, mode, plan }) {
  if (mode === "--plan" && env.GITHUB_OUTPUT) {
    appendFile(
      env.GITHUB_OUTPUT,
      `action=${plan.action}\ntag=${plan.tag}\nportable-build=${plan.portableBuild}\n`,
    );
  }
  if (env.GITHUB_STEP_SUMMARY) appendFile(env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

/**
 * The CLI around runReleaseCandidate: reads use the workflow token, the tag write uses the GitHub
 * App token, and the run prints one report line or one error line with exit code 1.
 *
 * @param spawn            (executable, args, env) => {status, stdout, stderr, error}
 * @param write            (stream: "stdout" | "stderr", text) => void
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
