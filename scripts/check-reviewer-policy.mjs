#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateReviewBotSuppression } from "./check-review-bot-suppression.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { runCliCheck } from "./lib/run-cli-check.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MAX_CONFIG_BYTES = 256 * 1024;
export const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_TREE_BYTES = 32 * 1024 * 1024;
const REGULAR_BLOB_MODES = new Set(["100644", "100755"]);
export const REQUIRED_CONTROL_PATHS = new Set([
  ".codspeed-policy.json",
  ".coderabbit.yaml",
  ".greptile/config.json",
  ".greptile/files.json",
]);
export const TRUST_ANCHOR_PATHS = [
  ".github/workflows",
  "scripts/check-runtime-toolchain.mjs",
  "scripts/check-codspeed-policy.mjs",
  "scripts/check-reviewer-policy.mjs",
  "scripts/check-review-bot-suppression.mjs",
  "scripts/lib/codspeed-policy-contract.mjs",
  "scripts/lib/host-executable.mjs",
  "scripts/lib/run-cli-check.mjs",
];
const APPROVED_POLICY_DIGESTS = new Map([
  ["codeRabbit", new Set(["fd3c74f53bba477ca16686d3ac7198a9419d0fd910d55ca054bb5ef9604344cd"])],
  ["greptileConfig", new Set(["b153fd2f7a642c9bca314e3a9ea4b93d5491d47c582da7f44b6990041df69368"])],
  ["greptileFiles", new Set(["2f271deb2c95afef169e7b618369ba680306d9649dde6fbddddcf02dc6397b1c"])],
]);

function output(message) {
  process.stdout.write(`${message}\n`);
}

function diagnostic(message) {
  process.stderr.write(`${message}\n`);
}

function readBounded(path, maximumBytes, label) {
  try {
    if (typeof path !== "string" || path.length === 0) throw new Error();
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > maximumBytes) throw new Error();
    const source = readFileSync(path, "utf8");
    if (Buffer.byteLength(source, "utf8") > maximumBytes) throw new Error();
    return source;
  } catch {
    throw new Error(`${label} is unavailable or exceeds its size limit`);
  }
}

function candidatePath(env, name) {
  const value = env[name];
  return typeof value === "string" ? value : "";
}

function parseAnchorRecord(record) {
  const match = /^(040000|100644|100755) (blob|tree) ([0-9a-f]{40})\t(.+)$/u.exec(record);
  if (match === null || !TRUST_ANCHOR_PATHS.includes(match[4])) return undefined;
  const validKind =
    (match[1] === "040000" && match[2] === "tree") ||
    (REGULAR_BLOB_MODES.has(match[1]) && match[2] === "blob");
  return validKind ? [match[4], { mode: match[1], sha: match[3], type: match[2] }] : undefined;
}

export function loadBaseTrustAnchors(repoRoot = REPO_ROOT) {
  try {
    const source = execFileSync(
      resolveHostExecutable("git"),
      ["ls-tree", "-z", "HEAD", "--", ...TRUST_ANCHOR_PATHS],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const records = source
      .split("\0")
      .filter(Boolean)
      .map((record) => parseAnchorRecord(record));
    if (records.some((record) => record === undefined)) throw new Error();
    const anchors = new Map(records);
    if (anchors.size !== TRUST_ANCHOR_PATHS.length) throw new Error();
    return anchors;
  } catch {
    throw new Error("protected-base trust anchors are unavailable");
  }
}

export function loadReviewerPreflightSources(
  env = process.env,
  loadAnchors = loadBaseTrustAnchors,
) {
  return {
    baseSha: candidatePath(env, "QUALITY_BASE_SHA"),
    candidateCommit: readBounded(
      candidatePath(env, "QUALITY_REVIEWER_COMMIT_PATH"),
      MAX_EVENT_BYTES,
      "candidate commit",
    ),
    candidateHead: candidatePath(env, "QUALITY_HEAD_SHA"),
    candidateTree: readBounded(
      candidatePath(env, "QUALITY_REVIEWER_TREE_PATH"),
      MAX_TREE_BYTES,
      "candidate tree",
    ),
    githubEvent: readBounded(
      candidatePath(env, "GITHUB_EVENT_PATH"),
      MAX_EVENT_BYTES,
      "GitHub event",
    ),
    trustedAnchors: loadAnchors(),
    trustedGreptileFiles: readBounded(
      join(REPO_ROOT, ".greptile/files.json"),
      MAX_CONFIG_BYTES,
      "protected-base Greptile inventory",
    ),
  };
}

export function loadReviewerPolicySources(env = process.env, loadAnchors = loadBaseTrustAnchors) {
  return {
    ...loadReviewerPreflightSources(env, loadAnchors),
    codeRabbit: readBounded(
      candidatePath(env, "QUALITY_CODERABBIT_PATH"),
      MAX_CONFIG_BYTES,
      "candidate CodeRabbit policy",
    ),
    greptileConfig: readBounded(
      candidatePath(env, "QUALITY_GREPTILE_CONFIG_PATH"),
      MAX_CONFIG_BYTES,
      "candidate Greptile config",
    ),
    greptileFiles: readBounded(
      candidatePath(env, "QUALITY_GREPTILE_FILES_PATH"),
      MAX_CONFIG_BYTES,
      "candidate Greptile inventory",
    ),
    ...loadTrustedPolicySources(),
  };
}

function loadTrustedPolicySources() {
  return {
    trustedCodeRabbit: readBounded(
      join(REPO_ROOT, ".coderabbit.yaml"),
      MAX_CONFIG_BYTES,
      "protected-base CodeRabbit policy",
    ),
    trustedGreptileConfig: readBounded(
      join(REPO_ROOT, ".greptile/config.json"),
      MAX_CONFIG_BYTES,
      "protected-base Greptile config",
    ),
    trustedGreptileFiles: readBounded(
      join(REPO_ROOT, ".greptile/files.json"),
      MAX_CONFIG_BYTES,
      "protected-base Greptile inventory",
    ),
  };
}

function digest(source) {
  return createHash("sha256").update(source).digest("hex");
}

function validateApprovedPolicy(label, trustedSource, candidateSource) {
  const approved = APPROVED_POLICY_DIGESTS.get(label);
  if (approved?.has(digest(trustedSource)) !== true) {
    return [`protected-base ${label} policy is not approved`];
  }
  return approved.has(digest(candidateSource))
    ? []
    : [`candidate ${label} policy differs from the protected-base approval`];
}

function parseObject(source, label) {
  try {
    const value = JSON.parse(source);
    if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error();
    return { problems: [], value };
  } catch {
    return { problems: [`${label} must contain a JSON object`], value: undefined };
  }
}

function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function validateEventBinding(source, candidateHead, baseSha) {
  const parsed = parseObject(source, "GitHub event");
  if (parsed.value === undefined) return parsed.problems;
  const suppressionProblems = validateReviewBotSuppression(parsed.value, true);
  const pullRequest = parsed.value.pull_request;
  if (pullRequest === null || Array.isArray(pullRequest) || typeof pullRequest !== "object") {
    return suppressionProblems;
  }
  return [...suppressionProblems, ...validateEventShas(pullRequest, candidateHead, baseSha)];
}

function validateEventShas(pullRequest, candidateHead, baseSha) {
  const problems = [];
  if (pullRequest.base?.ref !== "dev") {
    problems.push("reviewer policy applies only to pull requests targeting dev");
  }
  if (!isSha(candidateHead) || pullRequest.head?.sha !== candidateHead) {
    problems.push("candidate policy data is not bound to the exact pull-request head");
  }
  if (!isSha(baseSha) || pullRequest.base?.sha !== baseSha) {
    problems.push("reviewer policy execution is not bound to the protected base");
  }
  return problems;
}

function parseTrustedInventory(source) {
  const parsed = parseObject(source, "protected-base Greptile inventory");
  if (parsed.value === undefined || !Array.isArray(parsed.value.files)) {
    return { paths: [], problems: ["protected-base Greptile inventory is invalid"] };
  }
  const paths = parsed.value.files.map((entry) => entry?.path);
  if (paths.some((path) => typeof path !== "string") || new Set(paths).size !== paths.length) {
    return { paths: [], problems: ["protected-base Greptile inventory is invalid"] };
  }
  return { paths, problems: [] };
}

function isAdditionalReviewerControl(entry) {
  if (REQUIRED_CONTROL_PATHS.has(entry.path)) return false;
  if (entry.path === ".greptile") {
    return entry.type !== "tree" || entry.mode !== "040000";
  }
  const segments = entry.path.split("/");
  return segments.includes(".greptile") || posix.basename(entry.path) === ".coderabbit.yaml";
}

function isBoundedTreePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 1024 &&
    !path.includes("\\") &&
    !hasControlCharacter(path) &&
    !posix.isAbsolute(path) &&
    posix.normalize(path) === path &&
    path !== ".." &&
    !path.startsWith("../")
  );
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function indexTreeEntries(tree) {
  const entries = new Map();
  const problems = [];
  for (const entry of tree) {
    if (entry === null || Array.isArray(entry) || typeof entry !== "object") {
      problems.push("candidate tree contains an invalid entry");
      continue;
    }
    if (!isBoundedTreePath(entry.path) || entries.has(entry.path)) {
      problems.push("candidate tree contains an invalid or duplicate path");
      continue;
    }
    entries.set(entry.path, entry);
  }
  return { entries, problems };
}

function validateRegularPaths(entries, paths) {
  const problems = [];
  for (const path of paths) {
    const entry = entries.get(path);
    if (!isRegularBlob(entry)) {
      problems.push("candidate reviewer policy or governance inventory is not a regular blob");
    }
  }
  return problems;
}

function isRegularBlob(entry) {
  return entry?.type === "blob" && REGULAR_BLOB_MODES.has(entry.mode) && isSha(entry.sha);
}

function validateControlSizes(entries) {
  return [...REQUIRED_CONTROL_PATHS].flatMap((path) => {
    const size = entries.get(path)?.size;
    return Number.isInteger(size) && size >= 0 && size <= MAX_CONFIG_BYTES
      ? []
      : ["candidate quality-control data exceeds its size limit"];
  });
}

function validateTrustAnchors(entries, anchors) {
  if (!(anchors instanceof Map) || anchors.size !== TRUST_ANCHOR_PATHS.length) {
    return ["protected-base trust anchors are unavailable"];
  }
  const problems = [];
  for (const path of TRUST_ANCHOR_PATHS) {
    const trusted = anchors.get(path);
    const candidate = entries.get(path);
    if (
      !isExecutionAnchor(trusted) ||
      candidate?.type !== trusted.type ||
      candidate.mode !== trusted.mode ||
      candidate.sha !== trusted.sha
    ) {
      problems.push("candidate tree changes a protected-base execution anchor");
    }
  }
  return problems;
}

function isExecutionAnchor(entry) {
  return (
    isSha(entry?.sha) &&
    ((entry.type === "tree" && entry.mode === "040000") || isRegularBlob(entry))
  );
}

function validateCommitTreeBinding(commitSource, tree, candidateHead) {
  const parsed = parseObject(commitSource, "candidate commit");
  if (parsed.value === undefined) return parsed.problems;
  const treeSha = parsed.value.tree?.sha;
  return parsed.value.sha === candidateHead && isSha(treeSha) && tree.sha === treeSha
    ? []
    : ["candidate tree is not bound to the exact pull-request head"];
}

function validateCandidateTree(
  commitSource,
  treeSource,
  candidateHead,
  governancePaths,
  trustedAnchors,
) {
  const parsed = parseObject(treeSource, "candidate tree");
  if (parsed.value === undefined) return parsed.problems;
  const problems = validateCommitTreeBinding(commitSource, parsed.value, candidateHead);
  if (parsed.value.truncated !== false || !Array.isArray(parsed.value.tree)) {
    problems.push("candidate tree inventory is incomplete");
    return problems;
  }
  const indexed = indexTreeEntries(parsed.value.tree);
  problems.push(...indexed.problems);
  if ([...indexed.entries.values()].some((entry) => isAdditionalReviewerControl(entry))) {
    problems.push("candidate tree contains an unapproved reviewer control");
  }
  problems.push(
    ...validateRegularPaths(indexed.entries, [...REQUIRED_CONTROL_PATHS, ...governancePaths]),
  );
  problems.push(...validateControlSizes(indexed.entries));
  problems.push(...validateTrustAnchors(indexed.entries, trustedAnchors));
  return problems;
}

export function validateReviewerPreflight(sources) {
  const inventory = parseTrustedInventory(sources.trustedGreptileFiles);
  return [
    ...inventory.problems,
    ...validateEventBinding(sources.githubEvent, sources.candidateHead, sources.baseSha),
    ...validateCandidateTree(
      sources.candidateCommit,
      sources.candidateTree,
      sources.candidateHead,
      inventory.paths,
      sources.trustedAnchors,
    ),
  ];
}

export function validateReviewerPolicy(sources) {
  return [
    ...validateApprovedPolicy("codeRabbit", sources.trustedCodeRabbit, sources.codeRabbit),
    ...validateApprovedPolicy(
      "greptileConfig",
      sources.trustedGreptileConfig,
      sources.greptileConfig,
    ),
    ...validateApprovedPolicy("greptileFiles", sources.trustedGreptileFiles, sources.greptileFiles),
    ...validateReviewerPreflight(sources),
  ];
}

export async function main(sources, log = output, error = diagnostic) {
  return runCliCheck({
    check: () => validateReviewerPolicy(sources ?? loadReviewerPolicySources()),
    error,
    failureFallback: "base-trusted reviewer policy validation failed",
    failurePrefix: "reviewer-policy",
    log,
    passMessage: "reviewer-policy: PASS — exact-head reviewer controls match protected-base policy",
  });
}

export async function preflightMain(sources, log = output, error = diagnostic) {
  return runCliCheck({
    check: () => validateReviewerPreflight(sources ?? loadReviewerPreflightSources()),
    error,
    failureFallback: "base-trusted reviewer preflight failed",
    failurePrefix: "reviewer-policy-preflight",
    log,
    passMessage: "reviewer-policy-preflight: PASS — exact-head inputs are bounded and base-trusted",
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = process.argv.includes("--preflight") ? await preflightMain() : await main();
}
