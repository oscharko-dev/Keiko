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

import { sha256, sha256FileChunked } from "./lib/digest.mjs";
import {
  FOLDER_PACKAGE_MAX_BYTES,
  FOLDER_RELEASE_TARGETS,
  folderChecksumText,
  folderPackageArchiveName,
} from "./lib/folder-package-release.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { CHECK_NAMES, DEFAULT_REPOSITORY, EVIDENCE_KIND } from "./lib/npm-folder-qualification.mjs";
import { createdDraftId, remoteDigestFailures } from "./lib/portable-release-publication.mjs";

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
  const shaSha256 = sha256(declared);
  const shaSizeBytes = Buffer.byteLength(declared);
  return { target, evidence, zipSha256, sizeBytes: stat.size, shaSha256, shaSizeBytes, ...names };
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

function gh(runner, args, label = args.slice(0, 2).join(" ")) {
  const result = runner(args);
  if (result.status !== 0) refuse(`gh ${label} failed: ${result.stderr.trim().slice(-300)}`);
  return result.stdout;
}

// "absent" only on a clear 404: any other failure to read is no proof that the tag is free. A draft
// is told apart because it is the leftover of a failed run, which the owner can delete.
function releaseTagState(runner, repository, tag) {
  const listed = JSON.parse(
    gh(runner, [
      ...["release", "list", "--repo", repository, "--limit", "1000"],
      ...["--json", "tagName,isDraft"],
    ]),
  );
  const entry = listed.find((candidate) => candidate.tagName === tag);
  if (entry !== undefined) return entry.isDraft === true ? "draft" : "published";
  const ref = runner(["api", `repos/${repository}/git/ref/tags/${tag}`]);
  if (ref.status === 0) return "published";
  if (/\bHTTP 404\b/u.test(ref.stderr)) return "absent";
  return refuse(
    `${tag} could not be checked (${ref.stderr.trim().slice(-200)}); nothing was changed`,
  );
}

function refuseExisting(runner, repository, tag) {
  const state = releaseTagState(runner, repository, tag);
  if (state === "draft") {
    refuse(
      `${tag} exists as an unpublished DRAFT left by an earlier failed run; delete that draft ` +
        `(gh release delete ${tag} --repo ${repository} --yes, or on the Releases page) and run again`,
    );
  }
  if (state === "published") {
    refuse(`${tag} already exists; a release is immutable, so it is never replaced`);
  }
}

/**
 * Refuses a version whose product release is missing or whose companion already exists, and returns
 * the commit of the product release's tag.
 */
export function preflight({ version, repository, runner = runGh }) {
  const tag = companionTag(version);
  refuseExisting(runner, repository, tag);
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

// GitHub records a SHA-256 digest for every asset; a missing or different one is a refusal, for the
// ZIPs and for their checksum files alike.
function checkUploaded(listed, packages) {
  const wanted = new Map(
    packages.flatMap((p) => [
      [p.zip, { size: p.sizeBytes, digest: p.zipSha256 }],
      [p.sha, { size: p.shaSizeBytes, digest: p.shaSha256 }],
    ]),
  );
  const names = listed.assets.map((asset) => asset.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...wanted.keys()].sort())) {
    refuse(`the draft holds [${names.join(", ")}], not the verified assets`);
  }
  const failures = remoteDigestFailures(
    listed.assets,
    [...wanted].map(([assetName, { digest }]) => ({ assetName, expectedSha256: digest })),
  );
  for (const asset of listed.assets) {
    if (asset.size !== wanted.get(asset.name).size)
      failures.push(`${asset.name} has another size.`);
  }
  if (failures.length > 0) refuse(`the draft assets are refused: ${failures.join(" ")}`);
}

const releasePath = (repository, id) => `repos/${repository}/releases/${String(id)}`;

// Whether GitHub still holds the release as a draft. Any answer but a plain "draft" is a no: an
// unreadable state must never lead to deleting a release that may already be published.
function isStillDraft(runner, path) {
  const view = runner(["api", path]);
  if (view.status !== 0) return false;
  try {
    return JSON.parse(view.stdout).draft === true;
  } catch {
    return false;
  }
}

// Says what became of the draft, so a failed run never leaves the owner guessing.
function removeDraft(runner, repository, id) {
  const path = releasePath(repository, id);
  if (!isStillDraft(runner, path)) {
    return "the release was kept because GitHub does not report it as a draft";
  }
  const removed = runner(["api", "--method", "DELETE", path]);
  return removed.status === 0
    ? "the draft was removed"
    : `the draft could not be removed (${removed.stderr.trim().slice(-200)}); delete it by hand`;
}

// The identity of the draft comes from the create answer: a listing lagged behind the create once
// (portable release v1.0.1, "found 0").
function createDraft(runner, { tag, commit, version, notesPath, repository }) {
  const created = runner([
    ...["api", "--method", "POST", `repos/${repository}/releases`],
    ...["-f", `tag_name=${tag}`, "-f", `target_commitish=${commit}`],
    ...["-f", `name=Keiko ${version} npm folder packages`, "-F", `body=@${notesPath}`],
    ...["-F", "draft=true", "-F", "prerelease=true", "-f", "make_latest=false"],
  ]);
  if (created.status !== 0) {
    refuse(
      `gh release create failed: ${created.stderr.trim().slice(-300)}; a draft ${tag} may exist, ` +
        "check the Releases page and delete it before running again",
    );
  }
  let release;
  try {
    release = JSON.parse(created.stdout);
  } catch {
    release = undefined;
  }
  const draft = createdDraftId(release, tag);
  if (draft.failure === undefined) return draft.id;
  const note = Number.isSafeInteger(release?.id)
    ? removeDraft(runner, repository, release.id)
    : `no release id is known, so check the Releases page for a draft ${tag}`;
  return refuse(`${draft.failure} ${note}`);
}

// The waits between upload attempts. gh finds a draft through the release listing, and the listing
// lagged behind a create once (portable release v1.0.1), so a first miss is not yet a failure.
const UPLOAD_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000]);

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// Uploaded with gh's own command, exactly as the product release uploads into its draft
// (`uploadIntoDraft` in lib/portable-release-publication.mjs). `--clobber` makes a repeated attempt
// exact: an asset a failed attempt left behind is replaced, never duplicated. What GitHub then
// holds is read back by the draft's id and compared before anything is published.
function uploadAssets(runner, { repository, tag, dir, packages }, sleep) {
  const files = packages.flatMap((p) => [join(dir, p.zip), join(dir, p.sha)]);
  const args = ["release", "upload", tag, "--repo", repository, "--clobber", ...files];
  for (const delay of UPLOAD_RETRY_DELAYS_MS) {
    if (runner(args).status === 0) return;
    sleep(delay);
  }
  gh(runner, args, "release upload");
}

function uploadVerifyPublish(runner, { repository, tag, id, dir, packages }, sleep) {
  uploadAssets(runner, { repository, tag, dir, packages }, sleep);
  const path = releasePath(repository, id);
  checkUploaded(JSON.parse(gh(runner, ["api", path])), packages);
  const edit = ["api", "--method", "PATCH", path, "-F", "draft=false", "-F", "prerelease=true"];
  gh(runner, [...edit, "-f", "make_latest=false"], "release edit");
}

// A published release is immutable, so after publication nothing is removed whatever this check finds.
function confirmPublished(runner, repository, id, tag) {
  const unconfirmed = (reason) =>
    refuse(
      `${tag} IS PUBLISHED as a prerelease, but the final check ${reason}; nothing was removed ` +
        "because a published release is immutable: inspect it on the Releases page",
    );
  const view = runner(["api", releasePath(repository, id)]);
  if (view.status !== 0) unconfirmed("could not read it");
  let final;
  try {
    final = JSON.parse(view.stdout);
  } catch {
    unconfirmed("could not read it");
  }
  if (final.draft !== false || final.prerelease !== true || final.tag_name !== tag) {
    unconfirmed("disagrees with a published prerelease");
  }
}

/** Creates the draft, uploads and checks it, then publishes it as a prerelease, never latest. */
export function publish(options) {
  const { version, commit, dir, notesPath, repository } = options;
  const { runner = runGh, sleep = sleepSync } = options;
  const tag = companionTag(version);
  if (!COMMIT_PATTERN.test(String(commit))) refuse("--commit must be a full commit sha");
  const packages = verifyNpmFolderAssets({ dir, version });
  refuseExisting(runner, repository, tag);
  const id = createDraft(runner, { tag, commit, version, notesPath, repository });
  try {
    uploadVerifyPublish(runner, { repository, tag, id, dir, packages }, sleep);
  } catch (error) {
    // Only a draft is removed, so a corrected run can create it again: nothing is immutable yet. A
    // release GitHub published although the last call reported a failure stays untouched, and so
    // does one whose state cannot be read.
    const reason = error instanceof Error ? error.message : String(error);
    throw new NpmFolderPublishRefusal(`${reason}; ${removeDraft(runner, repository, id)}`, {
      cause: error,
    });
  }
  confirmPublished(runner, repository, id, tag);
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
