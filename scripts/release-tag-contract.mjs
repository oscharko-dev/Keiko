#!/usr/bin/env node

/**
 * The ONE owner of the release tag shape (review finding on #3043).
 *
 * Two shapes are accepted, both bound to the CURRENT root package version:
 *
 *   - EXACT: `v<version>` — including an npm prerelease version such as `v0.3.1-rc.1` over
 *     `0.3.1-rc.1`. This is the tag a stable or exact-prerelease npm publish rides on.
 *   - GOVERNED PORTABLE BETA: `v<version>-beta.<n>` LAYERED OVER the package version, minted by
 *     `scripts/release-portable-prerelease.mjs` (ADR-0163 D9). The index carries no leading
 *     zeros, so `v0.3.0-beta.00` is refused.
 *
 * Anything else — a foreign version, a non-exact RC, a malformed index — fails closed.
 *
 * Both the producer (the prerelease script) and the consumer (the `Release verification` job in
 * `.github/workflows/release.yml`) import or invoke this module, so the syntax cannot drift
 * between the lane that mints a tag and the workflow that validates its push.
 *
 * Dependency-free on purpose: the release-verify job runs it before any `npm ci`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The governed beta index: no leading zeros, so every tag has exactly one spelling. */
export const BETA_INDEX = "(?:0|[1-9][0-9]*)";

/** Matches any governed beta tag, without binding it to a particular version. */
export const GOVERNED_BETA_TAG_RE = new RegExp(String.raw`^v.+-beta\.${BETA_INDEX}$`, "u");

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/** True when `tag` is the governed portable beta tag layered over exactly `version`. */
export function isGovernedBetaTag(tag, version) {
  const beta = new RegExp(String.raw`^v${escapeForRegExp(version)}-beta\.${BETA_INDEX}$`, "u");
  return beta.test(tag);
}

/** True when `tag` is the exact tag for `version` (an npm prerelease version included). */
export function isExactReleaseTag(tag, version) {
  return tag === `v${version}`;
}

/** True for either accepted shape. */
export function isAcceptedReleaseTag(tag, version) {
  return isExactReleaseTag(tag, version) || isGovernedBetaTag(tag, version);
}

export function rootPackageVersion(repoRoot = process.cwd()) {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  return manifest.version;
}

/**
 * CLI: `node scripts/release-tag-contract.mjs <tag>` — exits non-zero on a refused tag.
 * Exported so the suite exercises the operator-facing path (messages and exit code) directly,
 * rather than only the predicates behind it.
 */
export function runReleaseTagContractCli(argv) {
  const tag = argv[0] ?? process.env.RELEASE_TAG;
  if (typeof tag !== "string" || tag.length === 0) {
    process.stderr.write("release-tag-contract: pass the tag as an argument or RELEASE_TAG.\n");
    process.exitCode = 1;
    return;
  }
  const version = rootPackageVersion();
  if (!isAcceptedReleaseTag(tag, version)) {
    process.stderr.write(
      `release-tag-contract: FAIL - release tag ${tag} does not match package version ${version} ` +
        `(expected v${version} or v${version}-beta.<n> without a leading-zero index).\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`release-tag-contract: PASS - ${tag} matches package version ${version}.\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"));
if (invokedDirectly) {
  runReleaseTagContractCli(process.argv.slice(2));
}
