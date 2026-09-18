// ADR-0177 D9 follow-up: the release button still works once the dev version it would request is
// already published. release-impact.catalog.json entries are written ahead of time, during the
// normal review of the change that needs them -- every entry already in this catalog was authored
// that way (KEIKO-0118, epic #3495's own 1.0.6 entry sat reviewed on dev before any bump existed).
// So "prepare the next release" needs no new judgment call: it is the lowest stable version the
// catalog already carries a reviewed, unpublished entry for. This module moves the repository there
// mechanically (scripts/lib/set-version.mjs) on a PR, and gives the rest of the release automation a
// non-forgeable way to recognize that PR's merge as the same owner authorization that opened it,
// across the merge boundary a direct-to-dev push can never cross (AGENTS.md's human-control
// invariant forbids pushing the bump straight to dev).
//
// The authorization is the PR's own identity and its content, not its metadata alone (#3555 review:
// a collaborator with ordinary repo write access -- this repository has two -- can force-push a
// same-commit-count replacement onto release/bump-<version>, since that branch carries no ruleset,
// and every PR-metadata field isVersionBumpAuthorizationPr checks -- opener, base, head prefix,
// commit count -- survives a same-count replace unchanged). readVersionBumpAuthorization therefore
// also verifies the merge commit's own content against its parent, file by file, reusing
// set-version.mjs's own pure transforms: every touched file must be exactly what a clean mechanical
// bump would have produced from the parent, nothing added or removed, and nothing else touched. This
// closes the same gap a signature would, without a new App permission or a repository ruleset: content
// a forger cannot reproduce without literally performing the same harmless mechanical bump.

import { Buffer } from "node:buffer";

import { compareStableVersions, parseStableVersion } from "../check-release-impact.mjs";
import { readFound } from "./github-api.mjs";
import {
  normalizedLockfileText,
  requireVersion,
  versionedManifest,
  versionedSource,
} from "./set-version.mjs";

export const VERSION_BUMP_APP_LOGIN = "keiko-release-tags[bot]";
export const VERSION_BUMP_BRANCH_PREFIX = "release/bump-";

class ReleaseVersionBumpError extends Error {}

function fail(message) {
  throw new ReleaseVersionBumpError(`release-version-bump: ${message}`);
}

function isReviewedRelease(entry) {
  return entry.review?.status === "reviewed" && entry.review?.humanApproved === true;
}

function isFreshEntryFor(entry, rootPackage) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    entry.packageName === rootPackage.name &&
    entry.correctionOf === undefined &&
    entry.supersedes === undefined &&
    typeof entry.packageVersion === "string" &&
    parseStableVersion(entry.packageVersion) !== undefined
  );
}

function isReviewedEntryFor(entry, rootPackage) {
  return isFreshEntryFor(entry, rootPackage) && isReviewedRelease(entry);
}

function lowestVersion(entries) {
  return entries.reduce((best, entry) =>
    compareStableVersions(
      parseStableVersion(entry.packageVersion),
      parseStableVersion(best.packageVersion),
    ) < 0
      ? entry
      : best,
  );
}

/**
 * The lowest stable version above `rootPackage.version` that `catalog` already carries a reviewed,
 * non-correction entry for, or undefined when none exists yet. Refuses when more than one entry
 * claims that same next version: ambiguous review evidence is not something to guess between.
 */
export function nextReviewedVersion(catalog, rootPackage) {
  const current = parseStableVersion(rootPackage.version);
  if (current === undefined) fail(`${rootPackage.version} is not a stable version.`);
  const candidates = catalog.entries.filter(
    (entry) =>
      isReviewedEntryFor(entry, rootPackage) &&
      compareStableVersions(parseStableVersion(entry.packageVersion), current) > 0,
  );
  if (candidates.length === 0) return undefined;
  const lowest = lowestVersion(candidates);
  const tied = candidates.filter((entry) => entry.packageVersion === lowest.packageVersion);
  if (tied.length > 1) {
    fail(
      `${String(tied.length)} reviewed catalog entries claim ${lowest.packageVersion}; ` +
        "consolidate them before the next version can be released.",
    );
  }
  return lowest.packageVersion;
}

export function versionBumpBranch(version) {
  return `${VERSION_BUMP_BRANCH_PREFIX}${requireVersion(version)}`;
}

/**
 * True when `pr` can only have been opened by this repository's own release automation, from an
 * owner-authorized button press, and merged unmodified.
 */
function isVersionBumpBranch(pr) {
  return typeof pr.head?.ref === "string" && pr.head.ref.startsWith(VERSION_BUMP_BRANCH_PREFIX);
}

export function isVersionBumpAuthorizationPr(pr) {
  if (pr === null || typeof pr !== "object") return false;
  return (
    pr.merged === true &&
    pr.user?.login === VERSION_BUMP_APP_LOGIN &&
    pr.base?.ref === "dev" &&
    isVersionBumpBranch(pr) &&
    pr.commits === 1
  );
}

const ROOT_MANIFEST_PATH = "package.json";
const LOCKFILE_PATH = "package-lock.json";
const WORKSPACE_MANIFEST_PATH = /^packages\/[^/]+\/package\.json$/u;
const WORKSPACE_VERSION_SOURCE_PATH = /^packages\/[^/]+\/src\/version\.ts$/u;
const MAX_BUMP_FILES = 300;

function isVersionBumpPath(path) {
  return (
    path === ROOT_MANIFEST_PATH ||
    path === LOCKFILE_PATH ||
    WORKSPACE_MANIFEST_PATH.test(path) ||
    WORKSPACE_VERSION_SOURCE_PATH.test(path)
  );
}

function fileContentAt(runGh, repository, path, sha) {
  const file = readFound(
    runGh,
    `repos/${repository}/contents/${path}?ref=${sha}`,
    `${path} at ${sha}`,
  );
  if (file?.encoding !== "base64" || typeof file?.content !== "string") {
    fail(`${path} at ${sha} is not a base64 file.`);
  }
  return Buffer.from(file.content, "base64").toString("utf8");
}

/** The `name` of every `packages/*` workspace at `sha`, read the same way set-version.mjs finds them. */
function workspaceNamesAt(runGh, repository, sha) {
  const listing = readFound(
    runGh,
    `repos/${repository}/contents/packages?ref=${sha}`,
    `packages at ${sha}`,
  );
  if (!Array.isArray(listing)) fail(`packages at ${sha} is not a directory listing.`);
  const names = listing
    .filter((entry) => entry?.type === "dir")
    .map(
      (entry) =>
        JSON.parse(fileContentAt(runGh, repository, `${entry.path}/package.json`, sha)).name,
    );
  return new Set(names);
}

function expectedFileContent(path, parentText, version, workspaceNames) {
  if (path === LOCKFILE_PATH) return undefined; // compared normalized, not verbatim
  if (path === ROOT_MANIFEST_PATH || WORKSPACE_MANIFEST_PATH.test(path)) {
    return versionedManifest(parentText, workspaceNames, version);
  }
  return versionedSource(parentText, version);
}

function verifyBumpFile(runGh, repository, file, parentSha, headSha, version, workspaceNames) {
  if (file.status !== "modified") fail(`${file.filename} was ${file.status}, not modified.`);
  if (!isVersionBumpPath(file.filename)) fail(`${file.filename} is not a version-bump file.`);
  const parentText = fileContentAt(runGh, repository, file.filename, parentSha);
  const headText = fileContentAt(runGh, repository, file.filename, headSha);
  if (file.filename === LOCKFILE_PATH) {
    if (normalizedLockfileText(headText) !== normalizedLockfileText(parentText)) {
      fail(`${file.filename} changed beyond a version bump.`);
    }
    return;
  }
  if (headText !== expectedFileContent(file.filename, parentText, version, workspaceNames)) {
    fail(`${file.filename} does not match a clean mechanical version bump.`);
  }
}

function bumpCommitParentAndFiles(commit, sha) {
  const parentSha = commit?.parents?.[0]?.sha;
  if (typeof parentSha !== "string") fail(`commit ${sha} has no single parent.`);
  const files = commit?.files;
  if (!Array.isArray(files) || files.length === 0) fail(`commit ${sha} touches no files.`);
  if (files.length >= MAX_BUMP_FILES) {
    fail(`commit ${sha} touches too many files to verify safely.`);
  }
  return { files, parentSha };
}

function bumpTargetVersion(runGh, repository, sha) {
  const rootManifest = JSON.parse(fileContentAt(runGh, repository, ROOT_MANIFEST_PATH, sha));
  if (typeof rootManifest.version !== "string") {
    fail(`${ROOT_MANIFEST_PATH} at ${sha} has no version.`);
  }
  return rootManifest.version;
}

/**
 * Refuses (throws) unless the merge commit `sha` on `dev` changed nothing but a clean, complete
 * mechanical version bump relative to its own parent: every changed file is one set-version.mjs
 * moves, none were added or removed, and every one of them holds exactly the content that function
 * would have produced from the parent -- the lockfile compared normalized (normalizedLockfileText),
 * every other file compared verbatim (versionedManifest/versionedSource). The target version is
 * read from the root manifest's own new content, not asserted by the caller: this proves the
 * *relationship* between parent and head, not a claim about which version was intended.
 */
function verifyMechanicalVersionBump(runGh, repository, sha) {
  const commit = readFound(runGh, `repos/${repository}/commits/${sha}`, `commit ${sha}`);
  const { files, parentSha } = bumpCommitParentAndFiles(commit, sha);
  const version = bumpTargetVersion(runGh, repository, sha);
  const workspaceNames = workspaceNamesAt(runGh, repository, parentSha);
  for (const file of files) {
    verifyBumpFile(runGh, repository, file, parentSha, sha, version, workspaceNames);
  }
}

/**
 * The version-bump authorization whose merge commit is `sha`, or undefined. A commit is associated
 * with the pull request that merged it through GitHub's own commit-to-PR index, so this never has to
 * search or guess which PR to check.
 */
export function readVersionBumpAuthorization(runGh, repository, sha) {
  const associated = readFound(
    runGh,
    `repos/${repository}/commits/${sha}/pulls`,
    `the pull requests for ${sha}`,
  );
  if (!Array.isArray(associated)) fail(`the pull requests for ${sha} are malformed.`);
  const candidate = associated.find(
    (pr) => pr?.user?.login === VERSION_BUMP_APP_LOGIN && pr?.merge_commit_sha === sha,
  );
  if (candidate === undefined || !Number.isSafeInteger(candidate.number)) return undefined;
  const pr = readFound(
    runGh,
    `repos/${repository}/pulls/${String(candidate.number)}`,
    `pull request ${String(candidate.number)}`,
  );
  if (!isVersionBumpAuthorizationPr(pr)) return undefined;
  try {
    verifyMechanicalVersionBump(runGh, repository, sha);
  } catch {
    // A content mismatch, or any failure verifying it, means this cannot be proven to be a clean
    // mechanical bump -- the same fail-closed direction as every other check here, never a crash of
    // the caller (release-candidate.mjs's tag hold, release-automation.mjs's request derivation).
    return undefined;
  }
  return pr;
}

function runStep(runner, label, args) {
  const result = runner(args);
  if (result?.error !== undefined || result?.status !== 0) {
    const detail = result?.stderr ? `: ${String(result.stderr).trim()}` : ".";
    fail(`${label} failed${detail}`);
  }
  return result;
}

function versionBumpPrBody(version) {
  return (
    `Mechanical version bump to ${version}, opened by the release automation after an allowlisted ` +
    "owner pressed the release button while the current dev version was already published. Its " +
    `release-impact.catalog.json entry for ${version} was reviewed ahead of time, during the normal ` +
    "review of the change that needed it. Native auto-merge is armed: this releases itself once the " +
    "merge, the tag build, and every release-required check are green.\n\n" +
    "🤖 Generated by the Keiko release button"
  );
}

function openVersionBumpPr(runGhWithTagToken, repository, branch, version) {
  const result = runStep(runGhWithTagToken, "opening the version-bump pull request", [
    "api",
    "--method",
    "POST",
    `repos/${repository}/pulls`,
    "-f",
    `title=chore(release): bump to ${version}`,
    "-f",
    `head=${branch}`,
    "-f",
    "base=dev",
    "-F",
    `body=${versionBumpPrBody(version)}`,
  ]);
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? ""));
  } catch {
    fail("the opened pull request response could not be parsed as JSON.");
  }
  if (!Number.isSafeInteger(parsed?.number)) fail("the opened pull request has no number.");
  return parsed.number;
}

function commitVersionBump(runGit, applySetVersion, version) {
  applySetVersion(version);
  runStep(runGit, "configuring the version-bump commit name", [
    "config",
    "user.name",
    VERSION_BUMP_APP_LOGIN,
  ]);
  runStep(runGit, "configuring the version-bump commit email", [
    "config",
    "user.email",
    `${VERSION_BUMP_APP_LOGIN}@users.noreply.github.com`,
  ]);
  runStep(runGit, "staging the version bump", ["add", "-A"]);
  runStep(runGit, "committing the version bump", [
    "commit",
    "--no-verify",
    "-m",
    `chore(release): bump to ${version}`,
  ]);
}

function branchExists(runGhWithTagToken, repository, branch) {
  const result = runGhWithTagToken(["api", `repos/${repository}/git/ref/heads/${branch}`]);
  return result?.error === undefined && result?.status === 0;
}

const PR_PAGE_SIZE = 100;

/**
 * Every pull request ever opened from `branch`, open or closed, newest first. A prior press can
 * leave at most one branch behind (the name is deterministic), so this never needs more than one
 * page in practice; a page this full refuses rather than guessing which one matters.
 */
function branchPullRequests(runGhWithTagToken, repository, branch) {
  const [owner] = repository.split("/");
  const result = runStep(runGhWithTagToken, "listing pull requests for the version-bump branch", [
    "api",
    `repos/${repository}/pulls?head=${owner}:${branch}&state=all&per_page=${PR_PAGE_SIZE}`,
  ]);
  let prs;
  try {
    prs = JSON.parse(String(result.stdout ?? ""));
  } catch {
    fail("the version-bump branch's pull request listing could not be parsed as JSON.");
  }
  if (!Array.isArray(prs)) fail("the version-bump branch's pull request listing is malformed.");
  if (prs.length >= PR_PAGE_SIZE) fail(`${branch} has too many pull requests to resume safely.`);
  return prs;
}

/**
 * What a fresh press finds for `branch`: "create" when nothing exists yet (the common case); an
 * existing, unmerged pull request to resume from instead of re-attempting the mechanical commit and
 * push a prior press already made (#3555 review: a partial failure -- the PR API call refused before
 * the App had `pull_requests: write`, a transient error while arming auto-merge, or the button
 * pressed twice before the first press's PR merged -- must never leave the branch name permanently
 * stuck, since nothing here force-pushes over it).
 */
function versionBumpResumeState(runGhWithTagToken, repository, branch) {
  if (!branchExists(runGhWithTagToken, repository, branch)) return { action: "create" };
  const prs = branchPullRequests(runGhWithTagToken, repository, branch);
  const open = prs.find((pr) => pr?.state === "open");
  if (open !== undefined) return { action: "rearm", prNumber: open.number };
  const merged = prs.find((pr) => typeof pr?.merged_at === "string");
  if (merged !== undefined) return { action: "done", prNumber: merged.number };
  if (prs.length === 0) return { action: "open" };
  const newest = prs.toSorted((a, b) => b.number - a.number)[0];
  fail(
    `${branch} already exists with a closed, unmerged pull request #${String(newest.number)}; ` +
      "resolve or delete it before the button can prepare this version again.",
  );
}

function createVersionBump({
  applySetVersion,
  branch,
  remoteUrl,
  repository,
  runGhWithTagToken,
  runGit,
  version,
}) {
  runStep(runGit, "authenticating the version-bump push", [
    "remote",
    "set-url",
    "origin",
    remoteUrl,
  ]);
  runStep(runGit, "creating the version-bump branch", ["checkout", "-b", branch]);
  commitVersionBump(runGit, applySetVersion, version);
  runStep(runGit, "pushing the version-bump branch", ["push", "origin", branch]);
  return openVersionBumpPr(runGhWithTagToken, repository, branch, version);
}

function resumeOrCreatePr(seams) {
  const { branch, repository, runGhWithTagToken, version } = seams;
  const state = versionBumpResumeState(runGhWithTagToken, repository, branch);
  if (state.action === "rearm" || state.action === "done") return state;
  if (state.action === "open") {
    return {
      action: "rearm",
      prNumber: openVersionBumpPr(runGhWithTagToken, repository, branch, version),
    };
  }
  return { action: "rearm", prNumber: createVersionBump(seams) };
}

/**
 * Moves the repository to `version` on a fresh branch, opens a PR to dev and arms native auto-merge --
 * or, when a prior press already got partway there, resumes from exactly that point instead of
 * re-attempting it. Runs from an already-checked-out working tree at the commit the button was
 * pressed on.
 *
 * @param applySetVersion    (version) => void; mutates the checkout in place (scripts/set-version.mjs)
 * @param remoteUrl          the push URL with the release App token embedded (x-access-token)
 * @param runGit             (args) => {status, stdout, stderr, error}; git in the checked-out root
 * @param runGhWithTagToken  (args) => {status, stdout, stderr, error}; the release App token
 */
export function applyVersionBumpRequest({
  applySetVersion,
  remoteUrl,
  repository,
  runGhWithTagToken,
  runGit,
  version,
}) {
  const branch = versionBumpBranch(version);
  const resolved = resumeOrCreatePr({
    applySetVersion,
    branch,
    remoteUrl,
    repository,
    runGhWithTagToken,
    runGit,
    version,
  });
  if (resolved.action === "rearm") {
    runStep(runGhWithTagToken, "arming native auto-merge", [
      "pr",
      "merge",
      "--auto",
      "--squash",
      String(resolved.prNumber),
      "--repo",
      repository,
    ]);
  }
  return { branch, prNumber: resolved.prNumber, version };
}
