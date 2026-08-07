import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  approvedNodeStageArguments,
  loadPortableRuntimeApprovals,
} from "./portable-runtime-approvals.mjs";
import { PORTABLE_TARGET_NAMES } from "./portable-runtime.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

function fail(message) {
  throw new Error(`portable-assets-stage: ${message}`);
}

function parseArgs(argv) {
  const options = {
    evaluation: false,
    outDir: join(repoRoot, ".portable-runtime", "staging"),
    payloadRoot: join(repoRoot, ".portable-sidecar-payloads"),
    target: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    // Bare flag, matched before the value guard below: every other argument consumes the next
    // token, so a value-less flag has to be handled first or it fails (or swallows a sibling).
    if (arg === "--evaluation") {
      options.evaluation = true;
      continue;
    }
    if (value === undefined || value.startsWith("--")) fail(`${arg} requires a value`);
    if (arg === "--target") options.target = value;
    else if (arg === "--out-dir") options.outDir = resolve(value);
    else if (arg === "--payload-root") options.payloadRoot = resolve(value);
    else fail(`unsupported argument ${arg}`);
    index += 1;
  }
  if (!PORTABLE_TARGET_NAMES.includes(options.target)) {
    fail(`--target must be one of ${PORTABLE_TARGET_NAMES.join(", ")}`);
  }
  return options;
}

export function collectSidecarSpecPaths(payloadRoot, target) {
  const targetRoot = join(payloadRoot, target);
  if (!existsSync(targetRoot) || !statSync(targetRoot).isDirectory()) return [];
  const specs = [];
  for (const entry of readdirSync(targetRoot)) {
    const specPath = join(targetRoot, entry, `${entry}.spec.json`);
    if (existsSync(specPath) && statSync(specPath).isFile()) specs.push(specPath);
  }
  return specs.sort((a, b) => a.localeCompare(b));
}

function resolveCommitSha(env) {
  const fromEnv = env.GITHUB_SHA;
  if (typeof fromEnv === "string" && COMMIT_PATTERN.test(fromEnv)) return fromEnv;
  const result = spawnSync(resolveHostExecutable("git"), ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const sha = result.stdout?.trim() ?? "";
  if (result.status !== 0 || !COMMIT_PATTERN.test(sha)) fail("cannot resolve commit sha");
  return sha;
}

const DEFAULT_WORKFLOW_RUN = Object.freeze({ runAttempt: 0, runId: 0 });

export function stageArgumentsForTarget(
  options,
  approvals,
  commitSha,
  packageVersion,
  workflow = DEFAULT_WORKFLOW_RUN,
  appleTeamId = undefined,
) {
  const node = approvedNodeStageArguments(approvals, options.target);
  const args = [
    "scripts/stage-portable-runtime.mjs",
    "--target",
    options.target,
    "--node-version",
    node.nodeVersion,
    "--node-archive-url",
    node.nodeArchiveUrl,
    "--node-sha256",
    node.nodeArchiveSha256,
    "--out-dir",
    options.outDir,
    "--release-id",
    "0",
    "--release-tag",
    `v${packageVersion}`,
    "--commit-sha",
    commitSha,
    "--workflow-run-id",
    String(workflow.runId),
    "--workflow-run-attempt",
    String(workflow.runAttempt),
  ];
  if (options.target !== "windows-x64" && appleTeamId !== undefined) {
    if (!APPLE_TEAM_ID_PATTERN.test(appleTeamId)) fail("APPLE_TEAM_ID is invalid");
    args.push("--apple-team-id", appleTeamId);
  }
  for (const specPath of collectSidecarSpecPaths(options.payloadRoot, options.target)) {
    args.push("--sidecar-runtime-spec", specPath);
  }
  // Absent by default and present exactly once when the caller opted in; nothing else in this
  // wrapper — no environment variable, no approval file — can introduce it.
  if (options.evaluation === true) args.push("--evaluation-build");
  return args;
}

function workflowIdentity(env) {
  const runId = Number(env.GITHUB_RUN_ID ?? 0);
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT ?? 0);
  if (!Number.isSafeInteger(runId) || runId < 0) fail("GITHUB_RUN_ID is invalid");
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 0) fail("GITHUB_RUN_ATTEMPT is invalid");
  return { runAttempt, runId };
}

export function runPortableAssetsStage(argv, env = process.env) {
  const options = parseArgs(argv);
  const approvals = loadPortableRuntimeApprovals(repoRoot);
  const packageVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
  const args = stageArgumentsForTarget(
    options,
    approvals,
    resolveCommitSha(env),
    packageVersion,
    workflowIdentity(env),
    env.APPLE_TEAM_ID,
  );
  const specCount = args.filter((arg) => arg === "--sidecar-runtime-spec").length;
  const lane = options.evaluation === true ? "evaluation-unqualified" : "unverified-staging";
  console.log(
    `portable-assets-stage: staging ${options.target} (${lane}) with node ${approvals.node.version} and ${String(specCount)} sidecar spec(s)`,
  );
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) fail(`staging failed for ${options.target}`);
  return { specCount, target: options.target };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runPortableAssetsStage(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
