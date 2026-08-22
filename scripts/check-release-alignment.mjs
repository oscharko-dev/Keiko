#!/usr/bin/env node
// Release-alignment gate (issue #3252).
//
// The owner's instruction after the 0.3.12-0.3.15 incident: version, tag, GitHub Latest release,
// npm `latest`, and the `npm-publish` deployment record must never diverge silently again. Those
// releases published through the governed-container path, which creates no GitHub deployment, so
// the Deployments panel kept showing v0.3.11 while npm `latest` was already 0.3.15 — nothing ever
// read all five sources together and said so.
//
// Reads five sources and applies one rule: let L = npm `latest`. Tag `v<L>` must exist, the
// GitHub Latest release must be `v<L>`, and the newest `npm-publish` deployment ref must be
// `v<L>`. The checkout version may equal L (already released) or be exactly one patch/minor step
// ahead of it (a release cut pending) — anything else is a divergence. An unreadable source is
// itself a divergence: this gate fails closed, never silently passes on a network hiccup.
//
// Exported as `checkReleaseAlignment(seams)` so scripts/__tests__ can drive it hermetically, and
// so scripts/release-publish.mjs can call it at the end of a real `latest` publish without a
// second implementation of the same rule.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main-module.mjs";
import { readJsonFile } from "./lib/json.mjs";
import { resolveGithubRepository } from "./lib/github-repository.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

const NPM_PUBLISH_ENVIRONMENT = "npm-publish";
const UNREADABLE = "UNREADABLE";
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)/u;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVersion(text) {
  const match = typeof text === "string" ? VERSION_PATTERN.exec(text) : null;
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function sameVersion(left, right) {
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch;
}

// A release cut has landed in package.json but has not yet published: exactly one patch bump
// (same minor) or one minor bump (patch reset to 0), never a major bump and never more than one
// step — anything wider is a real divergence, not a pending cut.
function isExactlyOneStepAhead(checkout, latest) {
  if (checkout.major !== latest.major) return false;
  const patchBump = checkout.minor === latest.minor && checkout.patch === latest.patch + 1;
  const minorBump = checkout.minor === latest.minor + 1 && checkout.patch === 0;
  return patchBump || minorBump;
}

function checkoutDiverges(checkoutVersion, latestVersion) {
  const checkout = parseVersion(checkoutVersion);
  const latest = parseVersion(latestVersion);
  if (checkout === undefined || latest === undefined) return true;
  if (sameVersion(checkout, latest)) return false;
  return !isExactlyOneStepAhead(checkout, latest);
}

function parsedJson(result) {
  if (result?.error !== undefined || result?.status !== 0) return undefined;
  try {
    return JSON.parse(String(result.stdout ?? ""));
  } catch {
    return undefined;
  }
}

function readNpmLatest({ packageName, registry, rows, runNpm }) {
  const result = runNpm(["view", packageName, "dist-tags", "--json", "--registry", registry]);
  const parsed = parsedJson(result);
  const latest = isRecord(parsed) ? parsed.latest : undefined;
  if (typeof latest !== "string" || latest.length === 0) {
    rows.push({ source: "npm latest dist-tag", value: UNREADABLE });
    return undefined;
  }
  rows.push({ source: "npm latest dist-tag", value: latest });
  return latest;
}

function readTags({ rows, runGit }) {
  const result = runGit(["tag", "--list", "v*"]);
  if (result?.error !== undefined || result?.status !== 0) {
    rows.push({ source: "newest tag", value: UNREADABLE });
    return undefined;
  }
  const tags = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const newest = tags
    .map((tag) => ({ tag, version: parseVersion(tag) }))
    .filter((entry) => entry.version !== undefined)
    .reduce((best, entry) => {
      if (best === undefined) return entry;
      const cmp =
        entry.version.major - best.version.major ||
        entry.version.minor - best.version.minor ||
        entry.version.patch - best.version.patch;
      return cmp > 0 ? entry : best;
    }, undefined);
  rows.push({ source: "newest tag", value: newest?.tag ?? "(none)" });
  return { newestTag: newest?.tag, tags };
}

function readGithubLatestRelease({ repository, rows, runGh }) {
  const result = runGh(["api", `repos/${repository}/releases/latest`]);
  const parsed = parsedJson(result);
  const tagName = isRecord(parsed) ? parsed.tag_name : undefined;
  if (typeof tagName !== "string" || tagName.length === 0) {
    rows.push({ source: "GitHub Latest release", value: UNREADABLE });
    return undefined;
  }
  rows.push({ source: "GitHub Latest release", value: tagName });
  return tagName;
}

function readNewestDeploymentRef({ repository, rows, runGh }) {
  const result = runGh([
    "api",
    `repos/${repository}/deployments?environment=${NPM_PUBLISH_ENVIRONMENT}&per_page=1`,
  ]);
  const parsed = parsedJson(result);
  const newest = Array.isArray(parsed) ? parsed[0] : undefined;
  const ref = isRecord(newest) ? newest.ref : undefined;
  if (typeof ref !== "string" || ref.length === 0) {
    rows.push({ source: "newest npm-publish deployment", value: UNREADABLE });
    return undefined;
  }
  rows.push({ source: "newest npm-publish deployment", value: ref });
  return ref;
}

// A newer tag can exist while the expected one is still present — a stray or premature tag push
// — so this checks BOTH "does the expected tag exist" and "is it the newest one", not just
// existence (issue #3252 review finding).
function tagFailures({ expectedTag, latest, newestTag, tags }) {
  if (tags === undefined) return ["tag list could not be read."];
  if (expectedTag === undefined) return [];
  if (!tags.includes(expectedTag)) {
    return [`tag ${expectedTag} does not exist (npm latest is ${latest}).`];
  }
  if (newestTag !== expectedTag) {
    return [`newest tag is ${newestTag}, expected ${expectedTag} (a newer tag already exists).`];
  }
  return [];
}

function githubLatestReleaseFailures({ expectedTag, githubLatestTag }) {
  if (githubLatestTag === undefined) return ["GitHub Latest release could not be read."];
  if (expectedTag !== undefined && githubLatestTag !== expectedTag) {
    return [`GitHub Latest release is ${githubLatestTag}, expected ${expectedTag}.`];
  }
  return [];
}

function deploymentFailures({ deploymentRef, expectedTag }) {
  if (deploymentRef === undefined) {
    return [`no ${NPM_PUBLISH_ENVIRONMENT} deployment could be read.`];
  }
  if (expectedTag !== undefined && deploymentRef !== expectedTag) {
    return [
      `newest ${NPM_PUBLISH_ENVIRONMENT} deployment ref is ${deploymentRef}, expected ${expectedTag} (stale deployment record).`,
    ];
  }
  return [];
}

// Always evaluates every source's own readability independent of whether any other source
// (including npm latest itself) was readable — two sources can be broken at once, and the gate's
// whole reason to exist is to say so, not to report only the first thing it noticed (issue #3252
// review finding: an unreadable npm latest previously masked a simultaneously unreadable
// GitHub Latest release from the failures list, even though `rows` already showed both).
function evaluateAgainstLatest({ deploymentRef, githubLatestTag, latest, newestTag, tags }) {
  const expectedTag = latest === undefined ? undefined : `v${latest}`;
  return [
    ...(latest === undefined ? ["npm latest dist-tag could not be read."] : []),
    ...tagFailures({ expectedTag, latest, newestTag, tags }),
    ...githubLatestReleaseFailures({ expectedTag, githubLatestTag }),
    ...deploymentFailures({ deploymentRef, expectedTag }),
  ];
}

/**
 * @param packageName      npm package name of the checkout
 * @param checkoutVersion  root package.json version of the checkout
 * @param repository       `owner/repo`
 * @param registry         npm registry URL
 * @param runGit, runGh, runNpm  (args) => {status, stdout, stderr, error} seams
 * @returns { aligned, rows, failures }
 */
export function checkReleaseAlignment({
  checkoutVersion,
  packageName,
  registry,
  repository,
  runGh,
  runGit,
  runNpm,
}) {
  const rows = [{ source: "checkout version", value: checkoutVersion }];

  const latest = readNpmLatest({ packageName, registry, rows, runNpm });
  const { newestTag, tags } = readTags({ rows, runGit }) ?? {};
  const githubLatestTag = readGithubLatestRelease({ repository, rows, runGh });
  const deploymentRef = readNewestDeploymentRef({ repository, rows, runGh });

  const failures = evaluateAgainstLatest({
    deploymentRef,
    githubLatestTag,
    latest,
    newestTag,
    tags,
  });
  if (latest !== undefined && checkoutDiverges(checkoutVersion, latest)) {
    failures.push(
      `checkout version ${checkoutVersion} diverges from npm latest ${latest} ` +
        "(must equal it or be exactly one patch/minor release ahead).",
    );
  }

  return { aligned: failures.length === 0, failures, rows };
}

export function printAlignmentReport(result, { log = console.log, logError = console.error } = {}) {
  log("release-alignment: source -> value");
  const width = Math.max(...result.rows.map((row) => row.source.length));
  for (const row of result.rows) {
    log(`  ${row.source.padEnd(width)}  ${row.value}`);
  }
  if (result.aligned) {
    log(
      "release-alignment: PASS - version, tag, GitHub Latest release, npm latest, and the " +
        "deployment record agree.",
    );
    return;
  }
  logError("release-alignment: FAIL");
  for (const failure of result.failures) {
    logError(`  - ${failure}`);
  }
}

function spawnResult(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

function realSeams() {
  return {
    runGh: (args) => spawnResult(resolveHostExecutable("gh"), args),
    runGit: (args) => spawnResult(resolveHostExecutable("git"), args),
    runNpm: (args) => spawnResult(resolveHostExecutable("npm"), args),
  };
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = readJsonFile(resolve(repoRoot, "package.json"));
  const seams = realSeams();
  const repository = resolveGithubRepository({ env: process.env, runGit: seams.runGit });
  if (repository === undefined) {
    console.error("release-alignment: could not determine GitHub repository.");
    process.exit(1);
  }
  const result = checkReleaseAlignment({
    checkoutVersion: manifest.version,
    packageName: manifest.name,
    registry: process.env.KEIKO_REGISTRY_URL ?? "https://registry.npmjs.org/",
    repository,
    runGh: seams.runGh,
    runGit: seams.runGit,
    runNpm: seams.runNpm,
  });
  printAlignmentReport(result);
  process.exit(result.aligned ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
  main();
}
