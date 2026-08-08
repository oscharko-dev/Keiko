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
 * 4. On a darwin host BOTH macOS bundles (arm64 and x64) are verified the way Gatekeeper judges
 *    them before anything is published: `codesign --verify --deep --strict` must pass for each,
 *    and the historical "code has no resources but signature indicates they must be present"
 *    (beta.0's "damaged" dead end) must not appear. codesign verifies the x64 seal statically on
 *    an arm64 host — no execution involved. On a non-darwin host the script says the verification
 *    did not run — a skipped check is reported, never silently dropped.
 * 5. The release is created as a DRAFT PRERELEASE with provenance (source commit + workflow run
 *    id) in the body; the previous beta of the same version gets a superseded pointer prepended,
 *    and only then does the draft go public — an interrupted run leaves a resumable draft that
 *    the next PUBLISHING run deletes and recreates (a plan-only run only reports the pending
 *    recovery), never a live release missing its superseded pointer. Before creating, the tag is
 *    bound to the built commit ATOMICALLY (a git/refs POST that fails on an existing ref; an
 *    existing ref must already point at the built commit) and the create runs with --verify-tag,
 *    so a tag that moves or vanishes in between fails closed instead of re-binding the assets.
 *
 * The evaluation lane is never publishable to npm and never promoted to `latest` here; this
 * script owns only the GitHub prerelease surface. `release:publish` owns npm.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
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
const MACOS_SEALED_ASSETS = PUBLISH_ASSETS.filter((asset) =>
  asset.file.startsWith("keiko-macos-"),
).map((asset) => asset.file);
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
let assetCopier = fsAssetCopier;

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

/**
 * Test seam: swap the publish-set asset copier for a callback's duration, always restoring it.
 * The hermetic suite injects a corrupted copier here to prove the publish-set guard catches a
 * stray file dropped next to a target (review finding on #3037).
 */
export function withAssetCopier(copier, callback) {
  const previous = assetCopier;
  assetCopier = copier;
  try {
    return callback();
  } finally {
    assetCopier = previous;
  }
}

function fsAssetCopier(source, destination) {
  copyFileSync(source, destination);
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

// ONE governed beta index shape, identical to the Release verification regex in
// .github/workflows/release.yml: leading-zero indices are refused everywhere, or the lane
// could publish a tag whose own verification run stays red (review finding on #3043).
const BETA_INDEX = "(?:0|[1-9][0-9]*)";
const GOVERNED_BETA_TAG_RE = new RegExp(`^v.+-beta\\.${BETA_INDEX}$`, "u");

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

/**
 * A --tag override must not publish BELOW an existing higher beta: the newest GitHub release
 * would then be an older number, and the actual highest beta would never receive a superseded
 * pointer — the prerelease lineage must stay monotonic (review finding on #3037). Resuming the
 * highest beta's own interrupted draft stays allowed (equal is not below).
 */
/**
 * An ordinary retry after a crash between create and publish must RESUME the interrupted draft,
 * not allocate the next number: the draft counts as an existing tag, so nextBetaTag would skip
 * to N+1, pick the still-private N as predecessor, and leave the live N-1 unsuperseded (review
 * finding on #3037). Only when the highest existing beta is a PUBLISHED release does the default
 * advance past it.
 */
function defaultTagWithDraftResume(version, tags) {
  const next = nextBetaTag(version, tags);
  const highest = previousBetaTag(next, tags);
  if (highest !== undefined && releaseIsDraft(highest)) {
    log(`resuming the interrupted draft ${highest} instead of allocating ${next}.`);
    return highest;
  }
  return next;
}

function releaseIsDraft(tag) {
  const { isDraft } = ghJson(["release", "view", tag, "--json", "isDraft"]);
  return isDraft === true;
}

export function assertTagKeepsBetaSequenceMonotonic(tag, existingTags) {
  const match = new RegExp(`^(?<prefix>v.+-beta\\.)(?<index>${BETA_INDEX})$`, "u").exec(tag);
  if (match?.groups === undefined) return;
  const { prefix } = match.groups;
  const current = Number.parseInt(match.groups.index, 10);
  const higher = existingTags
    .filter((candidate) => candidate.startsWith(prefix))
    .map((candidate) => Number.parseInt(candidate.slice(prefix.length), 10))
    .filter((index) => Number.isInteger(index) && index > current);
  if (higher.length > 0) {
    fail(
      `tag ${tag} is below the existing ${prefix}${String(Math.max(...higher))} — publishing a lower beta would leave the highest release unsuperseded.`,
    );
  }
}

/**
 * The GREATEST existing beta below the tag being published — not merely index minus one: a
 * --tag override may skip numbers (beta.9 after beta.1), and the still-live latest beta must
 * carry the superseded pointer regardless of the gap (review finding on #3037).
 */
export function previousBetaTag(tag, existingTags) {
  const match = new RegExp(`^(?<prefix>v.+-beta\\.)(?<index>${BETA_INDEX})$`, "u").exec(tag);
  if (match?.groups === undefined) return undefined;
  const { prefix } = match.groups;
  const current = Number.parseInt(match.groups.index, 10);
  const lower = existingTags
    .filter((candidate) => candidate.startsWith(prefix))
    .map((candidate) => Number.parseInt(candidate.slice(prefix.length), 10))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < current);
  if (lower.length === 0) return undefined;
  return `${prefix}${String(Math.max(...lower))}`;
}

function rootVersion() {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
}

function repositorySlug() {
  return ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
}

function existingReleaseTags() {
  // --paginate fetches EVERY page: with more than 100 releases, a first-page snapshot could
  // omit the selected version's betas and re-issue an old number or skip the supersede pointer
  // (review finding on #3037). --slurp wraps the pages into one array of arrays.
  const pages = ghJson([
    "api",
    "--paginate",
    "--slurp",
    "repos/{owner}/{repo}/releases?per_page=100",
  ]);
  return pages.flat().map((entry) => entry.tag_name);
}

function listWorkflowRunIds(ref) {
  const runs = ghJson([
    "run",
    "list",
    "--workflow",
    WORKFLOW_PATH,
    "--branch",
    ref,
    // Only a dispatch-created run can be the one THIS dispatch created — a push- or
    // schedule-triggered run appearing mid-poll must neither be selected nor manufacture a
    // false ambiguity (review finding on #3037).
    "--event",
    "workflow_dispatch",
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
 * poll waits for an id outside it (review finding on #3037). gh cannot return the created run
 * id, so when TWO operators dispatch concurrently BOTH new ids are unseen and indistinguishable
 * — selecting one could publish the competing operator's assets. The binding therefore fails
 * closed on ambiguity: exactly one unseen run binds, more than one refuses (review finding on
 * #3037).
 */
function dispatchWorkflow(ref) {
  const before = new Set(listWorkflowRunIds(ref));
  gh(["workflow", "run", WORKFLOW_PATH, "--ref", ref, "-f", "evaluation_build=true"]);
  log(`dispatched ${WORKFLOW_PATH} on ${ref} (evaluation_build=true)`);
  for (let attempt = 0; attempt < DISPATCH_FIND_ATTEMPTS; attempt += 1) {
    // The freshly dispatched run needs a moment to exist before it can be found.
    sleep(DISPATCH_FIND_INTERVAL_MS);
    const unseen = listWorkflowRunIds(ref).filter((id) => !before.has(id));
    if (unseen.length === 1) return unseen[0];
    if (unseen.length > 1) {
      fail(
        `${String(unseen.length)} unseen workflow_dispatch runs (${unseen.join(", ")}) appeared on ${ref} — a concurrent dispatch by another operator is indistinguishable from this one; refusing to bind to either run.`,
      );
    }
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

/**
 * A supplied --run-id may name ANY historical run — including a successful evaluation build of
 * an unmerged feature branch whose package version happens to match the local checkout, which
 * would pass every downstream check and publish fresh branch bytes publicly. The run must be a
 * workflow_dispatch on exactly the requested ref AND a run of the portable-assets workflow
 * itself — another workflow_dispatch workflow on the same branch can expose identically named
 * staging jobs and artifacts, and its bytes must never bind (review findings on #3037). The
 * workflow is compared by database id resolved from WORKFLOW_PATH, not by display name, so a
 * renamed or impostor workflow cannot satisfy the check. The dispatch path satisfies all of
 * this by construction.
 */
function portableWorkflowDatabaseId() {
  const workflowFile = WORKFLOW_PATH.split("/").at(-1);
  const workflow = ghJson(["api", `repos/{owner}/{repo}/actions/workflows/${workflowFile}`]);
  return workflow.id;
}

function assertRunBelongsToRequestedRef(view, runId, ref) {
  if (view.event !== "workflow_dispatch") {
    fail(`run ${runId} is a ${view.event} run, not the workflow_dispatch this script requires.`);
  }
  if (view.headBranch !== ref) {
    fail(`run ${runId} built branch ${view.headBranch}, not the requested ref ${ref}.`);
  }
  const workflowId = portableWorkflowDatabaseId();
  if (view.workflowDatabaseId !== workflowId) {
    fail(
      `run ${runId} belongs to workflow ${String(view.workflowDatabaseId)}, not ${WORKFLOW_PATH} (${String(workflowId)}); refusing to publish another workflow's assets.`,
    );
  }
}

function waitForRun(runId, ref) {
  const startedAt = Date.now();
  for (;;) {
    const view = ghJson([
      "run",
      "view",
      runId,
      "--json",
      "status,conclusion,headSha,event,headBranch,workflowDatabaseId",
    ]);
    if (view.status === "completed") {
      assertRunBelongsToRequestedRef(view, runId, ref);
      return view;
    }
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
  const match = new RegExp(`^v(?<version>.+)-beta\\.${BETA_INDEX}$`, "u").exec(tag);
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
  mkdirSync(publishDir, { recursive: true });
  for (const asset of PUBLISH_ASSETS) {
    const source = findAssetFile(join(workDir, asset.artifact), asset.file);
    assetCopier(source, join(publishDir, asset.file));
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
 * The beta.0 pin, run where Gatekeeper actually runs: an unsealed bundle inside a ZIP is the
 * "damaged" dead end and must never publish again. BOTH macOS archives are judged — codesign
 * verifies the x64 seal statically on an arm64 host (no execution involved), so publishing
 * keiko-macos-x64.zip without evidence about its own bytes is never necessary (review finding on
 * #3037). A failure in either archive refuses the publish. Only darwin can execute codesign; any
 * other host states the skip out loud instead of implying coverage.
 */
function verifyMacosSeal(publishDir) {
  if (hostPlatform !== "darwin") {
    log(
      "WARNING: macOS seal verification did not run (non-darwin host) — verify both macOS assets on a Mac before announcing the release.",
    );
    return "skipped-non-darwin";
  }
  for (const file of MACOS_SEALED_ASSETS) {
    verifyMacosAssetSeal(publishDir, file);
  }
  return `verified (${MACOS_SEALED_ASSETS.join(", ")})`;
}

function verifyMacosAssetSeal(publishDir, file) {
  const extractDir = join(publishDir, "..", `seal-check-${file}`);
  run("/usr/bin/unzip", ["-q", join(publishDir, file), "-d", extractDir]);
  const app = join(extractDir, "Keiko", "Keiko.app");
  const result = processRunner("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {});
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (output.includes(DAMAGED_SIGNATURE_TEXT)) {
    fail(`the ${file} bundle is unsealed (the beta.0 "damaged" regression): ${output.trim()}`);
  }
  if (result.status !== 0) {
    fail(`codesign --verify --deep --strict failed for ${file}: ${output.trim()}`);
  }
  rmSync(extractDir, { recursive: true, force: true });
  log(`${file} bundle seal verified (codesign --verify --deep --strict).`);
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
    // Draft-first (review finding on #3037): nothing is public until the predecessor carries its
    // superseded pointer — publishDraftRelease flips --draft=false as the LAST step, so a
    // transient supersede failure leaves a resumable draft, never a live release without its
    // pointer.
    "--draft",
    "--prerelease",
    // The tag was already created ATOMICALLY at the built commit (ensureTagRefAtBuiltCommit) —
    // --verify-tag fails closed if it vanished in the remaining window instead of silently
    // minting a new one at whatever --target would resolve to (review finding on #3037).
    "--verify-tag",
    "--title",
    `Keiko ${input.version} (${input.tag})`,
    "--notes-file",
    bodyPath,
    ...PUBLISH_ASSETS.map((asset) => join(input.publishDir, asset.file)),
  ]);
  log(`created draft ${input.tag} (not public yet).`);
}

/**
 * Publishing is the LAST step: the draft goes public only after the supersede edit landed. The
 * tag ref is revalidated against the built commit HERE, at the publication boundary — a draft's
 * tag stays mutable until publication, and `--verify-tag` at create time only proved the tag
 * EXISTED, so a tag moved between create and publish would expose assets and provenance under a
 * commit they were not built from. Unlike the create-conflict check, an ABSENT ref also refuses:
 * the release was created without `--target`, so publishing over a vanished tag would re-mint it
 * at the repository's default branch head, not the built commit. The recheck narrows the window
 * to the single edit call below; it cannot close it entirely without server-side atomicity
 * (review finding on #3037).
 */
function assertTagRefStillAtBuiltCommit(tag, commitSha) {
  const ref = readRemoteTagRef(tag);
  if (ref === undefined) {
    fail(
      `tag ${tag} vanished before publication — publishing now would re-mint it at the default branch head, not the built commit ${commitSha}; recreate the tag first.`,
    );
    return;
  }
  const resolved = peelTagRefToCommit(ref);
  if (resolved !== commitSha) {
    fail(
      `tag ${tag} moved to ${resolved} after the draft was created and no longer points at the built commit ${commitSha} — publishing would expose assets and provenance under a commit they were not built from.`,
    );
  }
}

function publishDraftRelease(tag, commitSha) {
  assertTagRefStillAtBuiltCommit(tag, commitSha);
  gh(["release", "edit", tag, "--draft=false"]);
  log(`published ${tag}.`);
}

/**
 * Draft-first publishing makes an interrupted run resumable: a DRAFT carrying the target tag is
 * the remnant of a run that died between create and the final --draft=false publish — it was
 * never public, so the publish path deletes it and recreates the release fresh. A PUBLISHED
 * release keeps the historical refusal: a live tag is never recreated (review finding on #3037).
 * The check is read-only on purpose: the deletion itself happens only on the actual publish path
 * — a --plan-only preview of a recovery must never destroy the draft it previews (review finding
 * on #3037).
 */
function assertExistingTagIsResumableDraft(tag) {
  const { isDraft } = ghJson(["release", "view", tag, "--json", "isDraft"]);
  if (isDraft !== true) fail(`release ${tag} already exists.`);
}

function deleteInterruptedDraft(tag) {
  gh(["release", "delete", tag, "--yes"]);
  log(`deleted the interrupted draft ${tag}; recreating it.`);
}

/**
 * The tag is bound to the built commit ATOMICALLY: a POST to git/refs either creates the ref at
 * exactly that commit or fails on an existing ref (the GitHub API rejects duplicate refs in one
 * operation) — closing the check-then-create window in which another actor could create or move
 * the tag between a read-only assertion and `gh release create` (review finding on #3037). On
 * the conflict, the existing ref is re-read and must already point at the built commit; release
 * creation then runs with --verify-tag so a tag that vanishes afterwards fails closed.
 */
function ensureTagRefAtBuiltCommit(tag, commitSha) {
  const args = [
    "api",
    "--method",
    "POST",
    "repos/{owner}/{repo}/git/refs",
    "-f",
    `ref=refs/tags/${tag}`,
    "-f",
    `sha=${commitSha}`,
  ];
  const result = processRunner(resolveHostExecutable("gh"), args, {});
  if (result.error !== undefined) fail(`gh could not spawn: ${result.error.message}`);
  if (result.status === 0) {
    log(`created tag ${tag} at the built commit ${commitSha}.`);
    return;
  }
  if (String(result.stderr ?? "").includes("already exists")) {
    assertTagRefMatchesBuiltCommit(tag, commitSha);
    return;
  }
  fail(`gh ${args.join(" ")} exited ${String(result.status)}: ${result.stderr}`);
}

/**
 * The conflict half of ensureTagRefAtBuiltCommit: an existing ref is acceptable only when its
 * (peeled) commit IS the built commit — a resumed run's own tag, or an identical concurrent
 * creation. Anything else refuses before a release could attach fresh assets to an old commit
 * (review finding on #3037).
 */
function assertTagRefMatchesBuiltCommit(tag, commitSha) {
  const ref = readRemoteTagRef(tag);
  if (ref === undefined) return;
  const resolved = peelTagRefToCommit(ref);
  if (resolved !== commitSha) {
    fail(
      `tag ${tag} already exists as a git ref at ${resolved}, not the built commit ${commitSha} — creating the release would attach the new assets to that old commit; delete or move the tag first.`,
    );
  }
  log(`tag ${tag} already points at the built commit ${commitSha}; proceeding.`);
}

function readRemoteTagRef(tag) {
  const args = ["api", `repos/{owner}/{repo}/git/ref/tags/${tag}`];
  const result = processRunner(resolveHostExecutable("gh"), args, {});
  if (result.error !== undefined) fail(`gh could not spawn: ${result.error.message}`);
  if (result.status === 0) return JSON.parse(result.stdout ?? "");
  // Only an absent ref (404) may proceed — any other lookup failure refuses, never guesses.
  if (String(result.stderr ?? "").includes("Not Found")) return undefined;
  fail(`gh ${args.join(" ")} exited ${String(result.status)}: ${result.stderr}`);
  return undefined;
}

/** An annotated tag ref points at a TAG object, not a commit — peel (bounded) to the commit. */
function peelTagRefToCommit(ref) {
  let object = ref.object;
  for (let depth = 0; depth < 5 && object.type === "tag"; depth += 1) {
    object = ghJson(["api", `repos/{owner}/{repo}/git/tags/${object.sha}`]).object;
  }
  return object.sha;
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
  // Refuse a malformed --tag BEFORE any remote call: the Release verification regex rejects a
  // leading-zero beta index, so the lane must never mint one (review finding on #3043).
  if (options.tag !== undefined && !GOVERNED_BETA_TAG_RE.test(options.tag)) {
    fail(
      `tag ${options.tag} does not match the governed beta tag shape v<version>-beta.<n> (no leading-zero beta index) — the Release verification would reject its push.`,
    );
  }
  const repository = repositorySlug();
  const tags = existingReleaseTags();
  const tag = options.tag ?? defaultTagWithDraftResume(version, tags);
  assertTagKeepsBetaSequenceMonotonic(tag, tags);
  const hasPendingDraft = tags.includes(tag);
  if (hasPendingDraft) assertExistingTagIsResumableDraft(tag);
  const runId = options.runId ?? dispatchWorkflow(options.ref);
  log(`waiting for workflow run ${runId} ...`);
  const view = waitForRun(runId, options.ref);
  // A "failure" conclusion is still publishable on purpose: the run-level conclusion aggregates
  // non-gating lanes (the evaluation lane may fail), while the jobs that actually produce the
  // published assets are separately and strictly asserted by assertStagingJobsSucceeded below.
  if (view.conclusion !== "success" && view.conclusion !== "failure") {
    fail(`run ${runId} concluded ${view.conclusion}; refusing to publish from it.`);
  }
  assertRunMatchesRelease(view.headSha, version, tag);
  assertStagingJobsSucceeded(runId);
  const { workDir, publishDir } = downloadAssets(runId);
  try {
    runPublishSteps({
      workDir,
      publishDir,
      options,
      version,
      repository,
      tags,
      tag,
      runId,
      view,
      hasPendingDraft,
    });
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
  hasPendingDraft,
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
    if (hasPendingDraft) {
      log(
        `PLAN-ONLY: the interrupted draft ${tag} would be deleted and recreated on publish (it was not touched).`,
      );
    }
    process.stdout.write(`${body}\n`);
    log(`PLAN-ONLY complete for ${tag} (nothing published).`);
    return;
  }
  ensureTagRefAtBuiltCommit(tag, view.headSha);
  if (hasPendingDraft) deleteInterruptedDraft(tag);
  createRelease({ workDir, publishDir, tag, commitSha: view.headSha, version, body });
  markPreviousSuperseded(previousTag, tag, repository);
  publishDraftRelease(tag, view.headSha);
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
