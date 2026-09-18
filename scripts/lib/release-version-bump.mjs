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
// The authorization is the PR's own identity, nothing else: it can only have been opened by the
// release App from the owner+dev-gated request job (scripts/release-candidate.mjs --request calls
// applyVersionBumpRequest only after that job's `if:` already verified an allowlisted human), it
// targets dev from the reserved branch prefix, and it carries exactly the one mechanical commit
// set-version.mjs produces -- never a PR a collaborator could open, or add a commit to, and have
// auto-released with no further check. Losing any one of those checks is a safe failure: the bump
// just does not auto-release, not a release it should not have made.

import { compareStableVersions, parseStableVersion } from "../check-release-impact.mjs";
import { readFound } from "./github-api.mjs";
import { requireVersion } from "./set-version.mjs";

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
  return isVersionBumpAuthorizationPr(pr) ? pr : undefined;
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

/**
 * Moves the repository to `version` on a fresh branch, opens a PR to dev and arms native auto-merge.
 * Runs from an already-checked-out working tree at the commit the button was pressed on.
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
  runStep(runGit, "authenticating the version-bump push", [
    "remote",
    "set-url",
    "origin",
    remoteUrl,
  ]);
  runStep(runGit, "creating the version-bump branch", ["checkout", "-b", branch]);
  commitVersionBump(runGit, applySetVersion, version);
  runStep(runGit, "pushing the version-bump branch", ["push", "origin", branch]);
  const prNumber = openVersionBumpPr(runGhWithTagToken, repository, branch, version);
  runStep(runGhWithTagToken, "arming native auto-merge", [
    "pr",
    "merge",
    "--auto",
    "--squash",
    String(prNumber),
    "--repo",
    repository,
  ]);
  return { branch, prNumber, version };
}
