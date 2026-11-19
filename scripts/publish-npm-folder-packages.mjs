#!/usr/bin/env node
// Publishes the qualified npm folder packages as the GitHub prerelease `npm-folder-<version>`.
//
// An npm folder package cannot be a product release asset: its lockfile needs the integrity npm
// reports for the released version, and the product release is immutable once published
// (docs/release/standalone-npm-package.md). This script is the companion: it checks that the three
// ZIPs the qualification matrix tested are the bytes that go up, and publishes them. The
// prerelease is a transport for those ZIPs; it is never `latest` and grants no update trust.
//
//   verify     checks the downloaded qualification artifacts and writes the release notes
//   preflight  refuses a version whose companion prerelease exists or whose product release does not
//   publish    creates the release as a draft, uploads, checks every asset, then publishes it
//
// A release is immutable once published, so it is created as a draft, uploaded and verified there,
// and published last (the same order scripts/release-publish.mjs follows).

import { spawnSync } from "node:child_process";
import { appendFileSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { sha256FileChunked } from "./lib/digest.mjs";
import {
  FOLDER_PACKAGE_MAX_BYTES,
  FOLDER_RELEASE_TARGETS,
  folderChecksumText,
  folderPackageArchiveName,
} from "./lib/folder-package-release.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { CHECK_NAMES, DEFAULT_REPOSITORY, EVIDENCE_KIND } from "./lib/npm-folder-qualification.mjs";

export class NpmFolderPublishRefusal extends Error {}

function refuse(message) {
  throw new NpmFolderPublishRefusal(message);
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DOCUMENT_URL =
  "https://github.com/oscharko-dev/Keiko/blob/dev/docs/release/standalone-npm-package.md";

/** The tag and release name of a version's companion prerelease. */
export function companionTag(version) {
  if (!VERSION_PATTERN.test(String(version))) refuse("version must be x.y.z");
  return `npm-folder-${version}`;
}

function assetNames(target) {
  const zip = folderPackageArchiveName(target, "npm");
  return { zip, sha: `${zip}.sha256`, evidenceName: `keiko-${target}.npm.evidence.json` };
}

/** Every file name the downloaded qualification artifacts must hold, and no other. */
export function expectedFileNames() {
  return FOLDER_RELEASE_TARGETS.flatMap((target) => Object.values(assetNames(target))).sort();
}

function regularFile(path, label) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) refuse(`${label} is not a regular file`);
  return stat;
}

function unpassedChecks(evidence) {
  const results = new Map((evidence?.checks ?? []).map((check) => [check.name, check.result]));
  return CHECK_NAMES.filter((name) => results.get(name) !== "pass").map(
    (name) => `check ${name} did not pass`,
  );
}

function checkEvidence(evidence, { target, version, zipSha256 }) {
  const claims = {
    kind: evidence?.kind === EVIDENCE_KIND,
    target: evidence?.target === target,
    version: evidence?.version === version,
    passed: evidence?.passed === true,
    "tested bytes differ from uploaded bytes": evidence?.zipSha256 === zipSha256,
    "archive digest": SHA256_PATTERN.test(String(evidence?.archiveSha256)),
  };
  const failures = Object.entries(claims)
    .filter(([, holds]) => !holds)
    .map(([claim]) => claim);
  failures.push(...unpassedChecks(evidence));
  if (failures.length > 0) refuse(`the ${target} evidence is refused: ${failures.join(", ")}`);
}

function verifyTarget(dir, target, version) {
  const names = assetNames(target);
  const zipPath = join(dir, names.zip);
  const stat = regularFile(zipPath, names.zip);
  if (stat.size >= FOLDER_PACKAGE_MAX_BYTES) refuse(`${names.zip} is too large for a release`);
  const zipSha256 = sha256FileChunked(zipPath);
  regularFile(join(dir, names.sha), names.sha);
  const declared = readFileSync(join(dir, names.sha), "utf8");
  if (declared !== folderChecksumText(zipSha256, names.zip)) {
    refuse(`${names.sha} does not describe the bytes of ${names.zip}`);
  }
  regularFile(join(dir, names.evidenceName), names.evidenceName);
  const evidence = JSON.parse(readFileSync(join(dir, names.evidenceName), "utf8"));
  checkEvidence(evidence, { target, version, zipSha256 });
  return { target, evidence, zipSha256, sizeBytes: stat.size, ...names };
}

/** Checks the three tested packages in `dir` and returns what the release will carry. */
export function verifyNpmFolderAssets({ dir, version }) {
  companionTag(version);
  const present = readdirSync(dir).sort();
  const expected = expectedFileNames();
  if (JSON.stringify(present) !== JSON.stringify(expected)) {
    refuse(`the artifacts hold [${present.join(", ")}], expected [${expected.join(", ")}]`);
  }
  return FOLDER_RELEASE_TARGETS.map((target) => verifyTarget(dir, target, version));
}

function evidenceSummary({ target, evidence, zipSha256, sizeBytes, zip }) {
  const durationS = Math.round(evidence.checks.reduce((sum, c) => sum + c.durationMs, 0) / 1000);
  const { os, arch, osRelease } = evidence.runner;
  return [
    `- \`${target}\` (\`${zip}\`, ${sizeBytes} bytes)`,
    `  - qualified on a ${os}/${arch} runner (${osRelease}): ${evidence.checks.length} of ${evidence.checks.length} checks passed in ${durationS} s`,
    `  - ZIP sha256 \`${zipSha256}\``,
    `  - source archive \`keiko-${target}.zip\` sha256 \`${evidence.archiveSha256}\``,
  ].join("\n");
}

/** The prerelease notes: what the form is, how to verify it and what each target proved. */
export function releaseNotes({ version, packages, repository = DEFAULT_REPOSITORY }) {
  return [
    `npm folder packages for Keiko ${version}.`,
    "",
    "An npm folder package is Keiko as one small folder: it carries the Node.js runtime and a pinned",
    "lockfile, and Keiko arrives from the npm registry at the first start, into the folder's own",
    "`node_modules`. Nothing is installed on the computer and no administrator rights are needed.",
    `See [the npm folder package guide](${DOCUMENT_URL}).`,
    "",
    "Each ZIP below was started on its own platform before it was uploaded: install on the first start,",
    "health with exactly this version, the installation record, the Coding runtime package, a second",
    "start, stop and the Activity Log lifecycle lines. These are the bytes that were tested.",
    "",
    ...packages.map(evidenceSummary),
    "",
    "Verify a download:",
    "",
    "```bash",
    "shasum -a 256 -c keiko-<target>.npm.zip.sha256",
    `gh attestation verify keiko-<target>.npm.zip --repo ${repository}`,
    "```",
    "",
    "A ZIP downloaded with a browser carries the operating system's download mark and the start files",
    "carry no vendor signature: remove the mark from the ZIP before extracting it (`xattr -d",
    "com.apple.quarantine <zip>` on macOS, `Unblock-File <zip>` in PowerShell on Windows) or",
    "distribute the folder through an internal share.",
    "",
    "This prerelease is a transport for the tested ZIPs. It is not the product release, it is never",
    "marked latest, and it grants no update trust: installed Keiko versions read only the product",
    "release for updates, and an npm folder package never offers an in-app update.",
    "",
  ].join("\n");
}

function runGh(args, env = process.env) {
  const result = spawnSync("gh", args, { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

function gh(runner, args) {
  const result = runner(args);
  if (result.status !== 0) {
    refuse(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim().slice(-300)}`);
  }
  return result.stdout;
}

function releaseTagExists(runner, repository, tag) {
  const listed = JSON.parse(
    gh(runner, ["release", "list", "--repo", repository, "--limit", "1000", "--json", "tagName"]),
  );
  if (listed.some((entry) => entry.tagName === tag)) return true;
  return runner(["api", `repos/${repository}/git/ref/tags/${tag}`]).status === 0;
}

/**
 * Refuses a version whose product release is missing or whose companion already exists, and returns
 * the commit of the product release's tag.
 */
export function preflight({ version, repository, runner = runGh }) {
  const tag = companionTag(version);
  if (releaseTagExists(runner, repository, tag)) {
    refuse(`${tag} already exists; a release is immutable, so it is never replaced`);
  }
  const product = JSON.parse(
    gh(runner, [
      "release",
      "view",
      `v${version}`,
      "--repo",
      repository,
      "--json",
      "isDraft,tagName",
    ]),
  );
  if (product.isDraft !== false) refuse(`the product release v${version} is not published`);
  const commit = gh(runner, [
    "api",
    `repos/${repository}/commits/v${version}`,
    "--jq",
    ".sha",
  ]).trim();
  if (!COMMIT_PATTERN.test(commit)) refuse(`v${version} does not resolve to a commit`);
  return { tag, commit };
}

function checkUploaded(listed, packages) {
  const wanted = new Map(
    packages.flatMap((p) => [
      [p.zip, { size: p.sizeBytes, digest: p.zipSha256 }],
      [p.sha, undefined],
    ]),
  );
  const names = listed.assets.map((asset) => asset.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...wanted.keys()].sort())) {
    refuse(`the draft holds [${names.join(", ")}], not the verified assets`);
  }
  for (const asset of listed.assets) {
    const expected = wanted.get(asset.name);
    if (expected === undefined) continue;
    if (asset.size !== expected.size) refuse(`${asset.name} has another size on GitHub`);
    if (typeof asset.digest === "string" && asset.digest !== `sha256:${expected.digest}`) {
      refuse(`${asset.name} has another digest on GitHub`);
    }
  }
}

// Whether GitHub still holds the release as a draft. Any answer but a plain "draft" is a no: an
// unreadable state must never lead to deleting a release that may already be published.
function isStillDraft(runner, tag, base) {
  const view = runner(["release", "view", tag, ...base, "--json", "isDraft"]);
  if (view.status !== 0) return false;
  try {
    return JSON.parse(view.stdout).isDraft === true;
  } catch {
    return false;
  }
}

/** Creates the draft, uploads and checks it, then publishes it as a prerelease, never latest. */
export function publish({ version, commit, dir, notesPath, repository, runner = runGh }) {
  const tag = companionTag(version);
  if (!COMMIT_PATTERN.test(String(commit))) refuse("--commit must be a full commit sha");
  const packages = verifyNpmFolderAssets({ dir, version });
  if (releaseTagExists(runner, repository, tag)) refuse(`${tag} already exists`);
  const base = ["--repo", repository];
  gh(runner, [
    ...["release", "create", tag, "--draft", "--prerelease", "--latest=false"],
    ...["--target", commit, "--title", `Keiko ${version} npm folder packages`],
    ...["--notes-file", notesPath, ...base],
  ]);
  try {
    const files = packages.flatMap((p) => [join(dir, p.zip), join(dir, p.sha)]);
    gh(runner, ["release", "upload", tag, ...files, ...base]);
    const listed = JSON.parse(gh(runner, ["release", "view", tag, ...base, "--json", "assets"]));
    checkUploaded(listed, packages);
    gh(runner, [
      "release",
      "edit",
      tag,
      "--draft=false",
      "--prerelease",
      "--latest=false",
      ...base,
    ]);
  } catch (error) {
    // Only a draft is removed, so a corrected run can create it again: nothing is immutable yet. A
    // release GitHub published although the last call reported a failure stays untouched, and so
    // does one whose state cannot be read.
    if (isStillDraft(runner, tag, base)) runner(["release", "delete", tag, "--yes", ...base]);
    throw error;
  }
  const final = JSON.parse(
    gh(runner, ["release", "view", tag, ...base, "--json", "isDraft,isPrerelease,tagName"]),
  );
  if (final.isDraft !== false || final.isPrerelease !== true || final.tagName !== tag) {
    refuse(`${tag} is not a published prerelease`);
  }
  return { tag, packages };
}

const FLAGS = Object.freeze({
  "--version": "version",
  "--dir": "dir",
  "--commit": "commit",
  "--notes": "notesPath",
  "--repository": "repository",
});

/** Parses `<mode> --flag value ...`; anything unknown is refused. */
export function parsePublishArgs(argv) {
  const [mode, ...rest] = argv;
  if (!["verify", "preflight", "publish"].includes(mode)) {
    refuse("the first argument must be verify, preflight or publish");
  }
  const options = { mode, repository: DEFAULT_REPOSITORY };
  for (let index = 0; index < rest.length; index += 2) {
    const name = FLAGS[rest[index]];
    const value = rest[index + 1];
    if (name === undefined) refuse(`unknown argument ${String(rest[index])}`);
    if (value === undefined || value.startsWith("--")) refuse(`${rest[index]} needs a value`);
    options[name] = value;
  }
  if (options.version === undefined) refuse("--version is required");
  if (!REPOSITORY_PATTERN.test(options.repository)) refuse("--repository must be owner/name");
  return options;
}

function runMode(options) {
  const dir = options.dir === undefined ? undefined : resolve(options.dir);
  if (options.mode === "preflight") {
    const { tag, commit } = preflight(options);
    if (process.env.GITHUB_OUTPUT !== undefined) {
      appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\ntag=${tag}\n`);
    }
    console.log(`PASS preflight ${tag} is free; v${options.version} is ${commit}`);
    return;
  }
  if (dir === undefined || options.notesPath === undefined)
    refuse("--dir and --notes are required");
  if (options.mode === "verify") {
    const packages = verifyNpmFolderAssets({ dir, version: options.version });
    writeFileSync(
      resolve(options.notesPath),
      releaseNotes({ version: options.version, packages, repository: options.repository }),
    );
    for (const p of packages) console.log(`PASS verified ${p.zip} sha256 ${p.zipSha256}`);
    return;
  }
  const { tag } = publish({ ...options, dir });
  console.log(`PASS published prerelease ${tag}`);
}

if (isMainModule(import.meta.url)) {
  try {
    runMode(parsePublishArgs(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof NpmFolderPublishRefusal)) throw error;
    console.error(`FAIL publish-npm-folder-packages: ${error.message}`);
    process.exitCode = 1;
  }
}
