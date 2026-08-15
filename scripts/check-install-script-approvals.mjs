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

const LOCKFILE = join(process.cwd(), "package-lock.json");
const MANIFEST = join(process.cwd(), "package.json");

/**
 * Every third-party package permitted to run an install script, at the exact version reviewed.
 * Adding an entry is a supply-chain decision: state what the script does and why it is acceptable.
 */
const REVIEWED_INSTALL_SCRIPTS = new Map([
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

function fail(lines) {
  console.error("check-install-script-approvals: FAIL");
  for (const line of lines) console.error(`  ${line}`);
  process.exit(1);
}

const lock = JSON.parse(readFileSync(LOCKFILE, "utf8"));
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const allowScripts = manifest.allowScripts ?? {};

// Lockfile paths are like "node_modules/a/node_modules/b" — the package name is the last segment
// after the final "node_modules/", which keeps scoped names (@scope/name) intact.
function packageNameFromLockPath(lockPath) {
  const at = lockPath.lastIndexOf("node_modules/");
  return at === -1 ? lockPath : lockPath.slice(at + "node_modules/".length);
}

const locked = new Map();
for (const [lockPath, entry] of Object.entries(lock.packages ?? {})) {
  if (entry.hasInstallScript !== true) continue;
  locked.set(packageNameFromLockPath(lockPath), entry.version);
}

const problems = [];

for (const [name, version] of locked) {
  const reviewed = REVIEWED_INSTALL_SCRIPTS.get(name);
  if (reviewed === undefined) {
    problems.push(
      `${name}@${version} runs an install script and has never been reviewed. Read what its ` +
        "script does, then add it to REVIEWED_INSTALL_SCRIPTS in this file and approve it with " +
        "`npm approve-scripts`.",
    );
    continue;
  }
  if (reviewed.version !== version) {
    problems.push(
      `${name} was reviewed at ${reviewed.version} but the lockfile now resolves ${version}. ` +
        "Re-read the install script at the new version before updating the recorded version.",
    );
  }
  // npm must also be enforcing it at install time; the pinned key is preferred where npm honours it.
  const approved = allowScripts[`${name}@${version}`] === true || allowScripts[name] === true;
  if (!approved) {
    problems.push(
      `${name}@${version} is recorded as reviewed here but is not in package.json allowScripts, ` +
        "so npm would not let `npm ci` complete. Run `npm approve-scripts " +
        `${name}\`.`,
    );
  }
}

for (const name of REVIEWED_INSTALL_SCRIPTS.keys()) {
  if (!locked.has(name)) {
    problems.push(
      `${name} is recorded as a reviewed install-script package but no longer appears in the ` +
        "lockfile with an install script. Remove its entry so the record stays honest.",
    );
  }
}

if (problems.length > 0) fail(problems);

console.log(
  `check-install-script-approvals: PASS — ${String(locked.size)} third-party install script(s), ` +
    "all reviewed at the exact locked version and approved for npm.",
);
