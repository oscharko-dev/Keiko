// Third-party install-script approval gate (audit KEIKO-0314).
//
// npm's own `allowScripts` + `strict-allow-scripts=true` (see .npmrc) already fail `npm ci` closed
// when a dependency ships an install script nobody approved. This gate covers the two things that
// mechanism cannot do on its own:
//
//  1. VERSION PINNING. npm honours a pinned `name@version` key for some packages but, on
//     npm 11.16.0, silently ignores one for `unrs-resolver` — only the unpinned `name` key is
//     matched (`npm approve-scripts unrs-resolver@1.12.2` answers ENOMATCH while the pending list
//     still shows it). An unpinned approval blesses EVERY future version of that package,
//     including a compromised one, which is most of the value gone. The reviewed set below records
//     the exact version, and this gate fails when the lockfile moves off it.
//
//  2. PLATFORM INDEPENDENCE. `npm ci` only sees what resolves on the host it runs on: fsevents is
//     darwin-only, so a Linux runner never evaluates it and a macOS-only install script could be
//     introduced without any Linux CI job noticing. package-lock.json lists every package for
//     every platform, so reading the lockfile sees the whole tree from any host.
//
// Reviewing a new entry means reading the script the package actually runs, not just its name.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Every third-party package permitted to run an install script, at the exact version reviewed.
 * Adding an entry is a supply-chain decision: state what the script does and why it is acceptable.
 */
export const REVIEWED_INSTALL_SCRIPTS = new Map([
  [
    "fsevents",
    {
      versions: ["2.3.2", "2.3.3"],
      reason:
        "Transitive devDependency of playwright/vite for macOS file watching. npm registry " +
        "metadata marks its install action as `node-gyp rebuild`; the reviewed tarballs are " +
        "darwin-only optional native watcher packages and do not run a postinstall downloader.",
    },
  ],
  [
    "unrs-resolver",
    {
      version: "1.12.2",
      reason:
        "Transitive devDependency of eslint-config-next -> eslint-import-resolver-typescript. Its " +
        "postinstall is three lines calling napi-postinstall's checkAndPreparePackage, which " +
        "selects the platform napi binary already installed as an optionalDependency.",
    },
  ],
]);

// Lockfile paths look like "node_modules/a/node_modules/b" — the package name is everything after
// the final "node_modules/", which keeps scoped names (@scope/name) intact.
export function packageNameFromLockPath(lockPath) {
  const at = lockPath.lastIndexOf("node_modules/");
  return at === -1 ? lockPath : lockPath.slice(at + "node_modules/".length);
}

function reviewedVersionsFor(record) {
  return record.versions ?? [record.version];
}

/** The three ways one locked install-script package can be wrong. Split out of the loop below so
 * neither function carries the whole decision tree. */
function problemsForLockedPackage(name, version, record, allowScripts) {
  if (record === undefined) {
    return [
      `${name}@${version} runs an install script and has never been reviewed. Read what its ` +
        "script does, then add it to REVIEWED_INSTALL_SCRIPTS in this file and approve it with " +
        "`npm approve-scripts`.",
    ];
  }
  const problems = [];
  const reviewedVersions = new Set(reviewedVersionsFor(record));
  if (!reviewedVersions.has(version)) {
    problems.push(
      `${name} was reviewed at ${[...reviewedVersions].join(", ")} but the lockfile now ` +
        `resolves ${version}. ` +
        "Re-read the install script at the new version before updating the recorded version.",
    );
  }
  // npm must also be enforcing it at install time; the pinned key is preferred where npm honours it.
  if (allowScripts[`${name}@${version}`] !== true && allowScripts[name] !== true) {
    problems.push(
      `${name}@${version} is recorded as reviewed here but is not in package.json allowScripts, ` +
        `so npm would not let \`npm ci\` complete. Run \`npm approve-scripts ${name}\`.`,
    );
  }
  return problems;
}

/** An approval npm honours but this file never reviewed is the same hole from the other side:
 * `npm approve-scripts <pkg>` alone would let a lifecycle script run with no recorded review
 * (review finding on #3159). Split out to keep the caller inside its complexity budget. */
function unreviewedApprovals(allowScripts, reviewed) {
  const problems = [];
  for (const [key, approved] of Object.entries(allowScripts)) {
    if (approved !== true) continue;
    const name = key.includes("@", 1) ? key.slice(0, key.lastIndexOf("@")) : key;
    if (reviewed.has(name)) continue;
    problems.push(
      `package.json allowScripts approves ${key}, which is not in REVIEWED_INSTALL_SCRIPTS. ` +
        "Every npm-level approval must have a recorded review, or the record is not the record.",
    );
  }
  return problems;
}

function staleReviewedVersionProblems(reviewed, locked) {
  const lockedPairs = new Set(
    [...locked.values()].map(({ name, version }) => `${name}@${version}`),
  );
  const problems = [];
  for (const [name, record] of reviewed) {
    for (const version of reviewedVersionsFor(record)) {
      if (lockedPairs.has(`${name}@${version}`)) continue;
      problems.push(
        `${name}@${version} is recorded as a reviewed install-script package but no longer ` +
          "appears in the lockfile with an install script. Remove that exact version so the " +
          "record stays honest.",
      );
    }
  }
  return problems;
}

/**
 * @param {{packages?: Record<string, {hasInstallScript?: boolean, version?: string}>}} lock
 * @param {{allowScripts?: Record<string, boolean>}} manifest
 * @param {Map<string, {version: string}>} [reviewed]
 * @returns {{problems: string[], lockedCount: number}}
 */
export function findInstallScriptApprovalProblems(
  lock,
  manifest,
  reviewed = REVIEWED_INSTALL_SCRIPTS,
) {
  const allowScripts = manifest.allowScripts ?? {};
  // Keyed by name@version, not name. A Map keyed by name alone collapses two entries for the same
  // package at different lockfile paths — `node_modules/pkg` and `node_modules/other/node_modules/
  // pkg` — so one of the two versions vanished before validation. In a supply-chain gate that is
  // the wrong direction to lose information in: the surviving entry could be the reviewed one while
  // an unreviewed transitive copy went unmentioned (review finding on #3159).
  const locked = new Map();
  for (const [lockPath, entry] of Object.entries(lock.packages ?? {})) {
    if (entry.hasInstallScript !== true) continue;
    const name = packageNameFromLockPath(lockPath);
    locked.set(`${name}@${entry.version}`, { name, version: entry.version });
  }

  const problems = [];
  for (const { name, version } of locked.values()) {
    problems.push(...problemsForLockedPackage(name, version, reviewed.get(name), allowScripts));
  }

  problems.push(...unreviewedApprovals(allowScripts, reviewed));
  problems.push(...staleReviewedVersionProblems(reviewed, locked));

  return { problems, lockedCount: locked.size };
}

/** @returns {number} process exit code */
export function runCli(repoRoot = process.cwd()) {
  const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const { problems, lockedCount } = findInstallScriptApprovalProblems(lock, manifest);

  if (problems.length > 0) {
    console.error("check-install-script-approvals: FAIL");
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }

  console.log(
    `check-install-script-approvals: PASS — ${String(lockedCount)} third-party install script(s), ` +
      "all reviewed at the exact locked version and approved for npm.",
  );
  return 0;
}

// Run as a CLI unless imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli());
}
