#!/usr/bin/env node

/**
 * Publishes a portable EVALUATION prerelease (ADR-0163 D9) end to end, encoding every lesson the
 * 0.3.0-beta.0 → beta.1 cycle taught so none of them has to be relearned:
 *
 * 1. Assets come only from a `portable-assets.yml` workflow_dispatch with `evaluation_build=true`
 *    on the requested ref. A run with any failed staging job is refused — never publish a partial
 *    target set.
 * 2. The publish set is EXACTLY four assets — three target ZIPs plus the Windows setup companion.
 *    Stray loose binaries inside artifacts are never published.
 * 3. SHA-256 checksums for all four assets are computed locally and embedded in the release body.
 * 4. On a darwin host the macOS arm64 bundle is verified the way Gatekeeper judges it before
 *    anything is published: `codesign --verify --deep --strict` must pass, and the historical
 *    "code has no resources but signature indicates they must be present" (beta.0's "damaged"
 *    dead end) must not appear. On a non-darwin host the script says the verification did not
 *    run — a skipped check is reported, never silently dropped.
 * 5. The release is created as a PRERELEASE with provenance (source commit + workflow run id) in
 *    the body, and the previous beta of the same version gets a superseded pointer prepended.
 *
 * The evaluation lane is never publishable to npm and never promoted to `latest` here; this
 * script owns only the GitHub prerelease surface. `release:publish` owns npm.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveHostExecutable } from "./lib/host-executable.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const WORKFLOW_PATH = ".github/workflows/portable-assets.yml";
const EVALUATION_ARTIFACTS = [
  "portable-stage-macos-arm64-evaluation-unsigned",
  "portable-stage-macos-x64-evaluation-unsigned",
  "portable-stage-windows-x64-evaluation-unsigned",
];
const PUBLISH_ASSETS = [
  { artifact: EVALUATION_ARTIFACTS[0], file: "keiko-macos-arm64.zip" },
  { artifact: EVALUATION_ARTIFACTS[1], file: "keiko-macos-x64.zip" },
  { artifact: EVALUATION_ARTIFACTS[2], file: "keiko-windows-x64.zip" },
  { artifact: EVALUATION_ARTIFACTS[2], file: "keiko-windows-x64-setup.exe" },
];
const DAMAGED_SIGNATURE_TEXT = "code has no resources but signature indicates they must be present";
const POLL_INTERVAL_MS = 30_000;
const MAX_WAIT_MS = 60 * 60 * 1000;
const DISPATCH_FIND_INTERVAL_MS = 10_000;
const DISPATCH_FIND_ATTEMPTS = 30;

class PrereleaseFailure extends Error {}

function fail(message) {
  throw new PrereleaseFailure(`release-portable-prerelease: FAIL - ${message}`);
}

function log(message) {
  process.stdout.write(`release-portable-prerelease: ${message}\n`);
}

const VALUE_FLAGS = new Map([
  ["--ref", "ref"],
  ["--tag", "tag"],
  ["--run-id", "runId"],
]);

export function parseArgs(argv) {
  const options = { ref: "dev", tag: undefined, runId: undefined, planOnly: false };
  let index = 0;
  while (index < argv.length) {
    const value = argv[index];
    const field = VALUE_FLAGS.get(value);
    if (value === "--plan-only") {
      index += 1;
    } else if (field !== undefined && argv[index + 1] !== undefined) {
      options[field] = argv[index + 1];
      index += 2;
    } else {
      return undefined;
    }
    if (value === "--plan-only") options.planOnly = true;
  }
  return options;
}

let processRunner = spawnSyncRunner;
let hostPlatform = process.platform;
let sleeper = atomicsSleep;

/** Test seam: pretend to run on another platform for a callback's duration. */
export function withHostPlatform(platform, callback) {
  const previous = hostPlatform;
  hostPlatform = platform;
  try {
    return callback();
  } finally {
    hostPlatform = previous;
  }
}

/** Test seam: swap the process runner for a callback's duration, always restoring it. */
export function withProcessRunner(runner, callback) {
  const previous = processRunner;
  processRunner = runner;
  try {
    return callback();
  } finally {
    processRunner = previous;
  }
}

/** Test seam: replace the blocking sleeper so polling paths run hermetically without waiting. */
export function withSleeper(replacement, callback) {
  const previous = sleeper;
  sleeper = replacement;
  try {
    return callback();
  } finally {
    sleeper = previous;
  }
}

function spawnSyncRunner(command, args, options = {}) {
  return spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", ...options });
}

/** Exported for the hermetic suite: the spawn/exit failure paths must stay provable. */
export function run(command, args, options = {}) {
  const result = processRunner(command, args, options);
  if (result.error !== undefined) fail(`${command} could not spawn: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${String(result.status)}: ${result.stderr}`);
  }
  return result.stdout ?? "";
}

function gh(args, options = {}) {
  return run(resolveHostExecutable("gh"), args, options);
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

/** The next free beta number for the version: v<version>-beta.<n>. */
export function nextBetaTag(version, existingTags) {
  const prefix = `v${version}-beta.`;
  const used = existingTags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => Number.parseInt(tag.slice(prefix.length), 10))
    .filter((value) => Number.isInteger(value) && value >= 0);
  const next = used.length === 0 ? 0 : Math.max(...used) + 1;
  return `${prefix}${String(next)}`;
}

export function previousBetaTag(tag, existingTags) {
  const match = /^(?<prefix>v.+-beta\.)(?<index>\d+)$/u.exec(tag);
  if (match?.groups === undefined) return undefined;
  const previous = Number.parseInt(match.groups.index, 10) - 1;
  if (previous < 0) return undefined;
  const candidate = `${match.groups.prefix}${String(previous)}`;
  return existingTags.includes(candidate) ? candidate : undefined;
}

function rootVersion() {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
}

function repositorySlug() {
  return ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
}

function existingReleaseTags() {
  return ghJson(["api", "repos/{owner}/{repo}/releases?per_page=100"]).map(
    (entry) => entry.tag_name,
  );
}

function listWorkflowRunIds(ref) {
  const runs = ghJson([
    "run",
    "list",
    "--workflow",
    WORKFLOW_PATH,
    "--branch",
    ref,
    "--limit",
    "50",
    "--json",
    "databaseId",
  ]);
  return runs.map((run) => String(run.databaseId));
}

/**
 * The newest list entry is NOT necessarily the run this dispatch created — a previous or
 * concurrent run can sit at the top of the list. Only a run id that did not exist BEFORE the
 * dispatch can be the one just created, so the pre-dispatch id set is captured first and the
 * poll waits for an id outside it (review finding on #3037).
 */
function dispatchWorkflow(ref) {
  const before = new Set(listWorkflowRunIds(ref));
  gh(["workflow", "run", WORKFLOW_PATH, "--ref", ref, "-f", "evaluation_build=true"]);
  log(`dispatched ${WORKFLOW_PATH} on ${ref} (evaluation_build=true)`);
  for (let attempt = 0; attempt < DISPATCH_FIND_ATTEMPTS; attempt += 1) {
    // The freshly dispatched run needs a moment to exist before it can be found.
    sleep(DISPATCH_FIND_INTERVAL_MS);
    const created = listWorkflowRunIds(ref).find((id) => !before.has(id));
    if (created !== undefined) return created;
  }
  fail(
    `the dispatched workflow run did not appear within ${String(DISPATCH_FIND_ATTEMPTS)} polls; refusing to guess at an existing run.`,
  );
  return "";
}

function atomicsSleep(milliseconds) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, milliseconds);
}

function sleep(milliseconds) {
  sleeper(milliseconds);
}

function waitForRun(runId) {
  const startedAt = Date.now();
  for (;;) {
    const view = ghJson(["run", "view", runId, "--json", "status,conclusion,headSha"]);
    if (view.status === "completed") return view;
    if (Date.now() - startedAt > MAX_WAIT_MS) fail(`run ${runId} did not complete within an hour.`);
    sleep(POLL_INTERVAL_MS);
  }
}

/** The package version at the exact commit the workflow built, read through the GitHub API. */
function builtVersion(commitSha) {
  const manifest = ghJson([
    "api",
    `repos/{owner}/{repo}/contents/package.json?ref=${commitSha}`,
    "-H",
    "Accept: application/vnd.github.raw+json",
  ]);
  return String(manifest.version);
}

/**
 * The release is bound to the BUILT commit, not the local checkout: with --run-id an operator can
 * point at any older run, so a v<version>-beta.N release could otherwise carry another package
 * version's assets. The version at the run's head commit must match the local checkout, and the
 * selected tag must name exactly that version (review finding on #3037).
 */
function assertRunMatchesRelease(commitSha, version, tag) {
  const built = builtVersion(commitSha);
  if (built !== version) {
    fail(
      `the workflow head commit ${commitSha} builds version ${built} but the local checkout is ${version}; refusing to publish another version's assets.`,
    );
  }
  const match = /^v(?<version>.+)-beta\.\d+$/u.exec(tag);
  if (match?.groups?.version !== built) {
    fail(`tag ${tag} does not name the built version ${built} (expected v${built}-beta.<n>).`);
  }
}

/**
 * A completed run is not enough: the production-signing jobs skip by design, so the check is that
 * every evaluation STAGING job succeeded — a partial target set must never publish.
 */
function assertStagingJobsSucceeded(runId) {
  const { jobs } = ghJson(["run", "view", runId, "--json", "jobs"]);
  const staging = jobs.filter((job) => job.name.startsWith("Stage portable asset"));
  if (staging.length !== 3) {
    fail(`expected 3 staging jobs, found ${String(staging.length)} — refusing to publish.`);
  }
  const failed = staging.filter((job) => job.conclusion !== "success");
  if (failed.length > 0) {
    fail(`staging jobs failed: ${failed.map((job) => job.name).join(", ")}`);
  }
}

function downloadAssets(runId) {
  const workDir = mkdtempSync(join(tmpdir(), "keiko-prerelease-"));
  try {
    return assembleDownloadedAssets(runId, workDir);
  } catch (error) {
    // A refusal INSIDE assembly (missing artifact, drifting publish set) throws before the
    // caller's finally exists — the temp directory must not survive it (review finding on #3037).
    rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
}

function assembleDownloadedAssets(runId, workDir) {
  for (const artifact of EVALUATION_ARTIFACTS) {
    gh(["run", "download", runId, "--name", artifact, "--dir", join(workDir, artifact)]);
  }
  const publishDir = join(workDir, "publish");
  run("/bin/mkdir", ["-p", publishDir]);
  for (const asset of PUBLISH_ASSETS) {
    const source = findAssetFile(join(workDir, asset.artifact), asset.file);
    run("/bin/cp", [source, join(publishDir, asset.file)]);
  }
  const byName = (left, right) => left.localeCompare(right);
  const names = readdirSync(publishDir).sort(byName);
  const expected = PUBLISH_ASSETS.map((asset) => asset.file).sort(byName);
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail(`publish set must be exactly [${expected.join(", ")}], found [${names.join(", ")}].`);
  }
  return { workDir, publishDir };
}

function findAssetFile(root, name) {
  const direct = join(root, name);
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(root)) {
    const candidate = join(root, entry, name);
    if (existsSync(candidate)) return candidate;
  }
  fail(`artifact is missing the expected asset ${name}.`);
  return name;
}

function checksumLines(publishDir) {
  return PUBLISH_ASSETS.map((asset) => {
    const path = join(publishDir, asset.file);
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    const size = statSync(path).size;
    log(`${asset.file}: sha256 ${digest} (${String(size)} bytes)`);
    return `${digest}  ${asset.file}`;
  });
}

/**
 * The beta.0 pin, run where Gatekeeper actually runs: an unsealed bundle inside the ZIP is the
 * "damaged" dead end and must never publish again. Only darwin can execute codesign; any other
 * host states the skip out loud instead of implying coverage.
 */
function verifyMacosSeal(publishDir) {
  if (hostPlatform !== "darwin") {
    log(
      "WARNING: macOS seal verification did not run (non-darwin host) — verify the arm64 asset on a Mac before announcing the release.",
    );
    return "skipped-non-darwin";
  }
  const extractDir = join(publishDir, "..", "seal-check");
  run("/usr/bin/unzip", ["-q", join(publishDir, "keiko-macos-arm64.zip"), "-d", extractDir]);
  const app = join(extractDir, "Keiko", "Keiko.app");
  const result = processRunner("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {});
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (output.includes(DAMAGED_SIGNATURE_TEXT)) {
    fail(`the arm64 bundle is unsealed (the beta.0 "damaged" regression): ${output.trim()}`);
  }
  if (result.status !== 0) fail(`codesign --verify --deep --strict failed: ${output.trim()}`);
  rmSync(extractDir, { recursive: true, force: true });
  log("macOS arm64 bundle seal verified (codesign --verify --deep --strict).");
  return "verified";
}

export function releaseBody(input) {
  return [
    `# Keiko ${input.version} — evaluation prerelease ${input.tag}`,
    "",
    "Unsigned evaluation build (ADR-0163 D9): platform signature, notarization and platform",
    "attestation are waived and declared honestly everywhere; every integrity digest stays",
    "enforced. Not publishable to npm latest.",
    "",
    "## Install on macOS",
    "",
    "1. Download and unzip; double-click `Keiko.app` inside the extracted folder (moving it to",
    "   `/Applications` first also works — the first start adopts it there).",
    "2. macOS will say it cannot verify the developer. Open **System Settings → Privacy &",
    "   Security**, scroll to **Security**, click **Open Anyway**, and confirm. One time only.",
    "3. Keiko installs itself to `/Applications`, starts, and opens at `http://127.0.0.1:1983`.",
    "",
    "If a start fails, Keiko now says why in a dialog. Runbook:",
    "[macOS first-launch](https://github.com/" +
      input.repository +
      "/blob/dev/docs/troubleshooting/macos-portable-first-launch.md)",
    "",
    "## Install on Windows",
    "",
    "Run `keiko-windows-x64-setup.exe` (SmartScreen: More info → Run anyway), or unzip and start",
    "`Keiko.exe`.",
    "",
    "## Checksums (SHA-256)",
    "",
    "```",
    ...input.checksums,
    "```",
    "",
    `macOS seal verification: ${input.sealVerification}.`,
    `Built from commit ${input.commitSha} by workflow run ${input.runId}.`,
    input.previousTag === undefined ? "" : `Supersedes ${input.previousTag}.`,
  ].join("\n");
}

function createRelease(input) {
  const bodyPath = join(input.workDir, "release-body.md");
  // A direct fs write — never a shell — so no file name ever reaches a command line
  // (CodeQL js/shell-command-injection-from-environment on #3037).
  writeFileSync(bodyPath, input.body);
  gh([
    "release",
    "create",
    input.tag,
    "--prerelease",
    // The tag must point at the exact commit the workflow built — a branch target would drift
    // whenever the branch advances mid-run or an older --run-id is reused, making the release's
    // source and its assets disagree (review finding on #3032).
    "--target",
    input.commitSha,
    "--title",
    `Keiko ${input.version} (${input.tag})`,
    "--notes-file",
    bodyPath,
    ...PUBLISH_ASSETS.map((asset) => join(input.publishDir, asset.file)),
  ]);
  log(`published ${input.tag}.`);
}

function markPreviousSuperseded(previousTag, tag, repository) {
  if (previousTag === undefined) return;
  const body = ghJson(["api", `repos/${repository}/releases/tags/${previousTag}`]).body ?? "";
  const pointer = `> **Superseded by [${tag}](https://github.com/${repository}/releases/tag/${tag}).**\n\n`;
  if (body.startsWith("> **Superseded")) return;
  gh(["release", "edit", previousTag, "--notes-file", "-"], { input: pointer + body });
  log(`marked ${previousTag} as superseded.`);
}

export function runPortablePrerelease(argv) {
  const options = parseArgs(argv);
  if (options === undefined) {
    fail(
      "usage: release-portable-prerelease [--ref dev] [--tag vX.Y.Z-beta.N] [--run-id id] [--plan-only]",
    );
    return;
  }
  const version = rootVersion();
  const repository = repositorySlug();
  const tags = existingReleaseTags();
  const tag = options.tag ?? nextBetaTag(version, tags);
  if (tags.includes(tag)) fail(`release ${tag} already exists.`);
  const runId = options.runId ?? dispatchWorkflow(options.ref);
  log(`waiting for workflow run ${runId} ...`);
  const view = waitForRun(runId);
  if (view.conclusion !== "success" && view.conclusion !== "failure") {
    fail(`run ${runId} concluded ${view.conclusion}; refusing to publish from it.`);
  }
  assertRunMatchesRelease(view.headSha, version, tag);
  assertStagingJobsSucceeded(runId);
  const { workDir, publishDir } = downloadAssets(runId);
  try {
    runPublishSteps({ workDir, publishDir, options, version, repository, tags, tag, runId, view });
  } finally {
    // Refusals exit through fail() — the temp directory must not survive them, nor a plan-only
    // run (review findings on #3032).
    rmSync(workDir, { recursive: true, force: true });
  }
}

function runPublishSteps({
  workDir,
  publishDir,
  options,
  version,
  repository,
  tags,
  tag,
  runId,
  view,
}) {
  const checksums = checksumLines(publishDir);
  const sealVerification = verifyMacosSeal(publishDir);
  const previousTag = previousBetaTag(tag, tags);
  const body = releaseBody({
    version,
    tag,
    repository,
    checksums,
    sealVerification,
    commitSha: view.headSha,
    runId,
    previousTag,
  });
  if (options.planOnly) {
    process.stdout.write(`${body}\n`);
    log(`PLAN-ONLY complete for ${tag} (nothing published).`);
    return;
  }
  createRelease({ workDir, publishDir, tag, commitSha: view.headSha, version, body });
  markPreviousSuperseded(previousTag, tag, repository);
  log(`DONE - ${tag} is live with 4 verified assets.`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"));
if (invokedDirectly) {
  try {
    runPortablePrerelease(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
