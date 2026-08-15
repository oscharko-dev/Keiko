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
      version: "2.3.2",
      reason:
        "Transitive devDependency of playwright/vite for macOS file watching. Ships a binding.gyp, " +
        "so npm treats it as an implicit `install: node-gyp rebuild`; its package.json declares no " +
        "install or postinstall script of its own. darwin-only and optional.",
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
  if (record.version !== version) {
    problems.push(
      `${name} was reviewed at ${record.version} but the lockfile now resolves ${version}. ` +
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
  const locked = new Map();
  for (const [lockPath, entry] of Object.entries(lock.packages ?? {})) {
    if (entry.hasInstallScript !== true) continue;
    locked.set(packageNameFromLockPath(lockPath), entry.version);
  }

  const problems = [];
  for (const [name, version] of locked) {
    problems.push(...problemsForLockedPackage(name, version, reviewed.get(name), allowScripts));
  }

  for (const name of reviewed.keys()) {
    if (!locked.has(name)) {
      problems.push(
        `${name} is recorded as a reviewed install-script package but no longer appears in the ` +
          "lockfile with an install script. Remove its entry so the record stays honest.",
      );
    }
  }

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
