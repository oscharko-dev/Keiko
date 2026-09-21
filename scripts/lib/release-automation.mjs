// ADR-0177 D9: the one-button release. An allowlisted owner dispatches release.yml on dev, and that
// run is the authorization for exactly the commit it was started on (scripts/release-candidate.mjs
// --request binds the tag to it). Everything after that is driven by GitHub events, never by a clock:
//
//   - `advance` runs whenever the request, the stable tag build, or a release-required check
//     workflow completes (release-advance.yml, `workflow_run`). It dispatches release.yml on the tag
//     once the requested commit's build and every release-required check are green. Whichever of them
//     finishes last starts the publish, so nothing polls and nothing waits for a timeout.
//   - `authorize` is the first job of that publish. It accepts the dispatch only for a commit an
//     allowlisted owner requested and hands the exact stable build to the publish job.
//
// A GitHub dispatch made with the workflow token names github-actions[bot] as its triggering actor, so
// the bot never authorizes anything itself: it can only carry out the request a human already made.

import { Buffer } from "node:buffer";

import {
  CHECK_RUN_PAGE_LIMIT,
  CHECK_RUN_PAGE_SIZE,
  evaluateRequiredChecks,
  parseRequiredChecks,
  resolveSkippedWithTreeEvidence,
} from "../verify-release-required-checks.mjs";
import { readFound, readGithub } from "./github-api.mjs";
import {
  isOwnerReleaseRequest,
  isReleaseOwner,
  npmHasVersion,
  readDevHead,
  readReleaseDispatchRuns,
  releaseExists,
  releaseOwners,
  remoteTagCommit,
} from "./release-candidate.mjs";
import { readVersionBumpAuthorization } from "./release-version-bump.mjs";

export const AUTOMATION_ACTOR = "github-actions[bot]";
const PORTABLE_ASSETS_WORKFLOW_PATH = ".github/workflows/portable-assets.yml";
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const STABLE_TAG = /^v\d+\.\d+\.\d+$/u;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;
// One page size and one page bound for every check-run listing, shared with the publish job's
// verifier: the two readers must never see different halves of the same commit (#3565).
const PAGE_SIZE = CHECK_RUN_PAGE_SIZE;
const PAGE_LIMIT = CHECK_RUN_PAGE_LIMIT;

class ReleaseAutomationError extends Error {}

function fail(message) {
  throw new ReleaseAutomationError(message);
}

function requireStableTag(tag) {
  if (!STABLE_TAG.test(String(tag))) fail(`${String(tag)} is not a stable release tag.`);
  return tag;
}

function requireCommitSha(sha, label) {
  if (!COMMIT_SHA.test(String(sha))) fail(`${label} is not a full commit SHA.`);
  return sha;
}

function runNumber(run) {
  return Number.isSafeInteger(run?.run_number) ? run.run_number : 0;
}

function newestFirst(runs) {
  return runs.toSorted((left, right) => runNumber(right) - runNumber(left));
}

/** The newest release request an owner made that completed successfully, or undefined. */
export function newestOwnerRequest(releaseRuns, owners) {
  return newestFirst(
    releaseRuns.filter(
      (run) => isOwnerReleaseRequest(run, owners) && run?.conclusion === "success",
    ),
  )[0];
}

/** The newest stable tag build of `tag` at `sha`, or undefined when none has started. */
export function newestStableBuild(buildRuns, tag, sha) {
  return newestFirst(
    buildRuns.filter(
      (run) =>
        run?.event === "push" &&
        run?.head_branch === tag &&
        run?.head_sha === sha &&
        String(run?.path ?? "").split("@")[0] === PORTABLE_ASSETS_WORKFLOW_PATH,
    ),
  )[0];
}

function idle(reason) {
  return { action: "idle", reason };
}

function publishAttemptState(attempt) {
  return attempt.status === "completed"
    ? `ended ${String(attempt.conclusion)}; a new press of the release button retries it`
    : "is running";
}

function buildState(build, tag) {
  if (build === undefined) return { action: "wait", reason: `the ${tag} build has not started` };
  if (build.status !== "completed")
    return { action: "wait", reason: `the ${tag} build is running` };
  if (build.conclusion !== "success") {
    return {
      action: "blocked",
      reason: `the ${tag} build ended ${String(build.conclusion)}; re-run it to continue`,
    };
  }
  return undefined;
}

function checksState(checks) {
  if (checks.failed.length > 0) {
    const failed = checks.failed.map((entry) => `${entry.name} (${entry.state})`).join(", ");
    return { action: "blocked", reason: `release-required checks failed: ${failed}` };
  }
  if (!checks.ok) {
    const waiting = [...checks.pending.map((entry) => entry.name), ...checks.missing];
    return { action: "wait", reason: `waiting for ${waiting.join(", ")}` };
  }
  return undefined;
}

/**
 * The decision after any prerequisite completed. Every fact is read fresh, so the evaluation that
 * runs after the last prerequisite finished sees all of them complete.
 *
 * @param request         newestOwnerRequest(): the button press, or undefined
 * @param tag             v<version> of the requested commit
 * @param published       npm or a GitHub release already carries the version
 * @param remoteTagSha    the commit the tag points at now
 * @param publishAttempt  a release.yml run on the tag started after the request, or undefined
 * @param build           newestStableBuild() for the tag at the requested commit
 * @param checks          evaluateRequiredChecks() for the requested commit
 * @returns {{ action: "dispatch" | "wait" | "blocked" | "idle", reason: string }}
 */
export function releaseAdvancePlan({
  build,
  checks,
  publishAttempt,
  published,
  remoteTagSha,
  request,
  tag,
}) {
  if (request === undefined) return idle("no release has been requested");
  if (published) return idle(`${tag} is published`);
  if (remoteTagSha !== request.head_sha) {
    return idle(
      `${tag} points at ${remoteTagSha ?? "nothing"}, not the requested ${request.head_sha}`,
    );
  }
  if (publishAttempt !== undefined) {
    return idle(`the publish of ${tag} ${publishAttemptState(publishAttempt)}`);
  }
  return (
    buildState(build, tag) ??
    checksState(checks) ?? {
      action: "dispatch",
      reason: `${tag} at ${request.head_sha} is built and green`,
    }
  );
}

/**
 * Who may publish, and what. An allowlisted owner may dispatch the tag directly; the automation may
 * only publish a commit an owner requested with the release button.
 *
 * @returns {{ runId: number, runAttempt: number, reason: string }}
 */
export function releaseAuthorizePlan({
  actor,
  build,
  owners,
  releaseRuns,
  remoteTagSha,
  sha,
  tag,
}) {
  requireStableTag(tag);
  requireCommitSha(sha, "the release commit");
  const authority = publishAuthority({ actor, owners, releaseRuns, sha });
  if (remoteTagSha !== sha) {
    fail(`${tag} points at ${remoteTagSha ?? "nothing"}, not the release commit ${sha}.`);
  }
  if (build?.status !== "completed" || build?.conclusion !== "success") {
    fail(`${tag} has no successful stable build at ${sha}.`);
  }
  return {
    reason: `${authority}; ${tag} at ${sha} publishes the build of run ${String(build.id)}`,
    runAttempt: build.run_attempt,
    runId: build.id,
  };
}

function publishAuthority({ actor, owners, releaseRuns, sha }) {
  if (isReleaseOwner(actor, owners)) return `release owner ${actor} dispatched the publish`;
  if (actor !== AUTOMATION_ACTOR) fail(`${String(actor)} may not publish a release.`);
  const requested = releaseRuns.some(
    (run) =>
      run?.head_sha === sha && isOwnerReleaseRequest(run, owners) && run?.conclusion === "success",
  );
  if (!requested) fail(`no release owner requested the release of ${sha}.`);
  return "a release owner requested this commit with the release button";
}

function repositoryOf(env) {
  const repository = env.GITHUB_REPOSITORY;
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) {
    fail("GITHUB_REPOSITORY is not owner/repo.");
  }
  return repository;
}

/** The root package identity at `sha`, read through the contents API. */
export function readRootPackageAt(runGh, repository, sha) {
  const file = readFound(
    runGh,
    `repos/${repository}/contents/package.json?ref=${sha}`,
    `package.json at ${sha}`,
  );
  if (file?.encoding !== "base64" || typeof file?.content !== "string") {
    fail(`package.json at ${sha} is not a base64 file.`);
  }
  try {
    const { name, version } = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    return { name, version };
  } catch {
    return fail(`package.json at ${sha} is not JSON.`);
  }
}

/** Every stable-build candidate run of portable-assets.yml for `sha`. */
export function readBuildRuns(runGh, repository, sha) {
  const listing = readFound(
    runGh,
    `repos/${repository}/actions/workflows/portable-assets.yml/runs?event=push&head_sha=${sha}&per_page=${PAGE_SIZE}`,
    "the portable-assets runs",
  );
  if (!Array.isArray(listing?.workflow_runs)) fail("the portable-assets runs are malformed.");
  // One commit never has a full page of builds; refusing one keeps the decision off a partial listing.
  if (listing.workflow_runs.length >= PAGE_SIZE) fail(`${sha} has too many portable-assets runs.`);
  return listing.workflow_runs;
}

/** The check runs (latest per name) and commit statuses of `sha`, every page of them. */
function readCheckRuns(runGh, repository, sha) {
  const checkRuns = [];
  for (let page = 1; page <= PAGE_LIMIT; page += 1) {
    const listing = readFound(
      runGh,
      `repos/${repository}/commits/${sha}/check-runs?filter=latest&per_page=${PAGE_SIZE}&page=${page}`,
      `the check runs of ${sha}`,
    );
    if (!Array.isArray(listing?.check_runs)) fail(`the check runs of ${sha} are malformed.`);
    checkRuns.push(...listing.check_runs);
    if (listing.check_runs.length < PAGE_SIZE) return checkRuns;
  }
  return fail(`the check runs of ${sha} span more than ${PAGE_LIMIT} pages.`);
}

export function readCommitChecks(runGh, repository, sha) {
  const checkRuns = readCheckRuns(runGh, repository, sha);
  const status = readFound(runGh, `repos/${repository}/commits/${sha}/status`, "the status");
  return { checkRuns, statuses: Array.isArray(status?.statuses) ? status.statuses : [] };
}

function readTreeSha(runGh, repository, sha) {
  const read = readGithub(runGh, `repos/${repository}/commits/${sha}`);
  const treeSha = read.kind === "found" ? read.value?.commit?.tree?.sha : undefined;
  return COMMIT_SHA.test(String(treeSha)) ? treeSha : undefined;
}

function candidateCheckRuns(runGh, repository, headSha, treeSha) {
  if (readTreeSha(runGh, repository, headSha) !== treeSha) return [];
  try {
    return readCheckRuns(runGh, repository, headSha);
  } catch {
    // Evidence that cannot be read completely is no evidence: the check stays `skipped`.
    return [];
  }
}

/**
 * ADR-0178 for the advance decision. The check runs of ONE pull-request head that carries the
 * byte-identical tree of `sha`, or none: the same lookup the publish job's verifier performs
 * (fetchTreeIdenticalCheckRuns), so a gate the dev run reused is judged identically by both. Every
 * unreadable step yields no evidence, never a guess.
 */
export function readTreeIdenticalCheckRuns(runGh, repository, sha) {
  const treeSha = readTreeSha(runGh, repository, sha);
  if (treeSha === undefined) return [];
  const pulls = readGithub(runGh, `repos/${repository}/commits/${sha}/pulls?per_page=${PAGE_SIZE}`);
  if (pulls.kind !== "found" || !Array.isArray(pulls.value)) return [];
  for (const pull of pulls.value) {
    const headSha = pull?.head?.sha;
    if (!COMMIT_SHA.test(String(headSha)) || headSha === sha) continue;
    const runs = candidateCheckRuns(runGh, repository, headSha, treeSha);
    if (runs.length > 0) return runs;
  }
  return [];
}

/** The verdict the publish job will reach: evaluated, then `skipped` resolved by tree evidence. */
function requiredChecksVerdict(runGh, repository, sha, requiredChecks) {
  const { checkRuns, statuses } = readCommitChecks(runGh, repository, sha);
  const verdict = evaluateRequiredChecks(requiredChecks, checkRuns, statuses);
  if (!verdict.failed.some((entry) => entry.state === "skipped")) return verdict;
  return resolveSkippedWithTreeEvidence(
    verdict,
    readTreeIdenticalCheckRuns(runGh, repository, sha),
  );
}

function publishAttemptAfter(releaseRuns, request, tag) {
  return newestFirst(
    releaseRuns.filter((run) => run?.head_branch === tag && runNumber(run) > runNumber(request)),
  )[0];
}

function versionBumpCandidate(runGh, repository, runNpm) {
  const devHeadSha = readDevHead(runGh, repository);
  if (devHeadSha === undefined) return undefined;
  const rootPackage = readRootPackageAt(runGh, repository, devHeadSha);
  const tag = `v${String(rootPackage.version)}`;
  if (!STABLE_TAG.test(tag)) return undefined;
  const published =
    npmHasVersion(runNpm, rootPackage.name, rootPackage.version) ||
    releaseExists(runGh, repository, tag);
  if (published) return undefined;
  const remoteTagSha = remoteTagCommit(runGh, repository, tag);
  if (remoteTagSha === undefined) return undefined;
  const authorization = readVersionBumpAuthorization(runGh, repository, remoteTagSha);
  return authorization === undefined ? undefined : { head_sha: remoteTagSha };
}

/**
 * The request equivalent of an owner button press, derived instead from a merged version-bump PR
 * (scripts/lib/release-version-bump.mjs): dev's current version is unpublished, its tag is already
 * positioned there (release-candidate.mjs's own per-push tracking does that once the target
 * version's catalog entry is reviewed and releaseHeld recognizes the same authorization), and that
 * commit can only be the merge of a PR the release App opened from the owner+dev-gated request job.
 * Undefined when any of that is not, or not yet, true, or when reading it failed for any reason --
 * this path is speculative, so any failure here falls back to the classic dispatch-run request,
 * which is what a direct button press on an existing candidate produces and remains published
 * forever once its version ships. It carries the fail-closed guarantee, unchanged.
 */
function versionBumpRequest(runGh, repository, runNpm) {
  try {
    return versionBumpCandidate(runGh, repository, runNpm);
  } catch {
    return undefined;
  }
}

/** Reads every fact releaseAdvancePlan() needs, stopping at the first one that decides. */
export function gatherAdvanceFacts({ owners, repository, requiredChecks, runGh, runNpm }) {
  const releaseRuns = readReleaseDispatchRuns(runGh, repository);
  const request =
    versionBumpRequest(runGh, repository, runNpm) ?? newestOwnerRequest(releaseRuns, owners);
  if (request === undefined) return { request };
  requireCommitSha(request.head_sha, "the requested commit");
  const rootPackage = readRootPackageAt(runGh, repository, request.head_sha);
  const tag = requireStableTag(`v${String(rootPackage.version)}`);
  const published =
    npmHasVersion(runNpm, rootPackage.name, rootPackage.version) ||
    releaseExists(runGh, repository, tag);
  if (published) return { published, request, tag };
  return {
    build: newestStableBuild(
      readBuildRuns(runGh, repository, request.head_sha),
      tag,
      request.head_sha,
    ),
    checks: requiredChecksVerdict(runGh, repository, request.head_sha, requiredChecks),
    publishAttempt: publishAttemptAfter(releaseRuns, request, tag),
    published,
    remoteTagSha: remoteTagCommit(runGh, repository, tag),
    request,
    tag,
  };
}

function dispatchPublish(runGh, repository, tag) {
  const result = runGh([
    "api",
    "--method",
    "POST",
    `repos/${repository}/actions/workflows/release.yml/dispatches`,
    "-f",
    `ref=${tag}`,
  ]);
  if (result?.error !== undefined || result?.status !== 0) {
    fail(`the publish of ${tag} could not be dispatched.`);
  }
}

/**
 * The whole run behind scripts/release-advance.mjs: decide, and dispatch the publish when ready.
 *
 * @param runGh   (args) => {status, stdout, stderr, error}; the workflow token with actions: write
 * @param runNpm  (args) => {status, stdout, stderr, error}
 */
export function runReleaseAdvance({ env, runGh, runNpm }) {
  const repository = repositoryOf(env);
  const requiredChecks = parseRequiredChecks(env.RELEASE_REQUIRED_CHECKS);
  if (requiredChecks.length === 0) fail("RELEASE_REQUIRED_CHECKS names no check.");
  const facts = gatherAdvanceFacts({
    owners: releaseOwners(env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS),
    repository,
    requiredChecks,
    runGh,
    runNpm,
  });
  const plan = releaseAdvancePlan(facts);
  if (plan.action === "dispatch") dispatchPublish(runGh, repository, facts.tag);
  const subject = facts.tag === undefined ? "Release" : `Release ${facts.tag}`;
  const verb = plan.action === "dispatch" ? "publish started" : plan.action;
  return { line: `${subject}: ${verb}, ${plan.reason}.`, plan };
}

/**
 * The whole run behind scripts/release-authorize.mjs, for the publish job's first job.
 *
 * @param runGh  (args) => {status, stdout, stderr, error}; the workflow token with actions: read
 */
export function runReleaseAuthorize({ env, runGh }) {
  const repository = repositoryOf(env);
  const tag = requireStableTag(env.RELEASE_TAG);
  const sha = requireCommitSha(env.GITHUB_SHA, "GITHUB_SHA");
  const result = releaseAuthorizePlan({
    actor: env.TRIGGERING_ACTOR,
    build: newestStableBuild(readBuildRuns(runGh, repository, sha), tag, sha),
    owners: releaseOwners(env.KEIKO_RELEASE_OWNER_GITHUB_LOGINS),
    releaseRuns: readReleaseDispatchRuns(runGh, repository),
    remoteTagSha: remoteTagCommit(runGh, repository, tag),
    sha,
    tag,
  });
  return {
    line: `Publish of ${tag} authorized: ${result.reason}.`,
    outputs: `run-id=${String(result.runId)}\nrun-attempt=${String(result.runAttempt)}\n`,
  };
}

function failureLine(error, prefix) {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("release-candidate: ") ? message : `${prefix}: ${message}`;
}

/**
 * A CLI around one of the two runs above: one body-free report line on stdout and in the step
 * summary, or one error line on stderr and exit code 1.
 */
export function releaseAutomationMain({ appendFile, env, prefix, run, write }) {
  try {
    const report = run();
    if (report.outputs !== undefined && env.GITHUB_OUTPUT)
      appendFile(env.GITHUB_OUTPUT, report.outputs);
    if (env.GITHUB_STEP_SUMMARY) appendFile(env.GITHUB_STEP_SUMMARY, `${report.line}\n`);
    write("stdout", `${report.line}\n`);
    return 0;
  } catch (error) {
    write("stderr", `${failureLine(error, prefix)}\n`);
    return 1;
  }
}
