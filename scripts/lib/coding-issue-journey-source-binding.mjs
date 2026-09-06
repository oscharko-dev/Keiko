// Git-backed freshness boundary for #3390 qualification evidence. The five live flows bind one
// frozen source commit. A later commit may add only the canonical manifest and descriptor-owned
// receipt files; all executable source, inputs and general documentation stay byte-identical.

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { listChangedGitPaths } from "./git-changed-paths.mjs";
import { readGitSourceContent } from "./git-source-content.mjs";
import { resolveHostExecutable } from "./host-executable.mjs";

export const CODING_ISSUE_JOURNEY_DESCRIPTOR_PATH =
  "docs/acceptance/coding-issue-journey-3390.json";
export const CODING_ISSUE_JOURNEY_MANIFEST_PATH =
  "docs/qa/evidence/coding-issue-journey/3390/manifest.json";
export const CODING_ISSUE_JOURNEY_RECEIPTS_PATH =
  "docs/qa/evidence/coding-issue-journey/3390/receipts";

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const SCENARIO_ID = /^[a-z][a-z0-9-]{1,80}$/u;

function git(root, args) {
  return execFileSync(resolveHostExecutable("git"), args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30_000,
  }).trim();
}

function canonicalPathFailures(root, manifestPath, receiptsDir, descriptorPath) {
  const bindings = [
    [manifestPath, CODING_ISSUE_JOURNEY_MANIFEST_PATH, "manifest"],
    [receiptsDir, CODING_ISSUE_JOURNEY_RECEIPTS_PATH, "receipts"],
    [descriptorPath, CODING_ISSUE_JOURNEY_DESCRIPTOR_PATH, "descriptor"],
  ];
  const failures = bindings
    .filter(([actual, expected]) => resolve(actual) !== resolve(root, expected))
    .map(([, , label]) => `qualification ${label} path is not canonical`);
  return failures;
}

function isSafeWorktreeEntry(root, relativePath, kind) {
  const canonicalRoot = realpathSync(root);
  const segments = relative(canonicalRoot, resolve(canonicalRoot, relativePath)).split(sep);
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "..")) {
    return false;
  }
  let cursor = canonicalRoot;
  try {
    for (const segment of segments) {
      cursor = resolve(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) return false;
    }
    const final = lstatSync(cursor);
    return (
      realpathSync(cursor) === cursor &&
      (kind === "directory" ? final.isDirectory() : final.isFile())
    );
  } catch {
    return false;
  }
}

function worktreeEvidenceFailures(root, allowed) {
  const files = [CODING_ISSUE_JOURNEY_DESCRIPTOR_PATH, ...allowed];
  const failures = files.some((path) => !isSafeWorktreeEntry(root, path, "file"))
    ? ["qualification evidence inputs must be canonical regular worktree entries"]
    : [];
  if (!isSafeWorktreeEntry(root, CODING_ISSUE_JOURNEY_RECEIPTS_PATH, "directory")) {
    failures.push("qualification receipts directory must be a canonical worktree directory");
  }
  return failures;
}

function gitEvidenceFailures(root, landingCommitSha, allowed) {
  try {
    readGitSourceContent(
      landingCommitSha,
      [CODING_ISSUE_JOURNEY_DESCRIPTOR_PATH, ...allowed],
      root,
      execFileSync,
    );
    return [];
  } catch {
    return ["qualification evidence inputs must be tracked regular Git blobs"];
  }
}

function contentMap(root, files) {
  return new Map(
    files.map(({ path, contentBase64 }) => [
      resolve(root, path),
      Buffer.from(contentBase64, "base64"),
    ]),
  );
}

function readLandingDescriptor(root, landingCommitSha, descriptorPath) {
  const files = readGitSourceContent(
    landingCommitSha,
    [CODING_ISSUE_JOURNEY_DESCRIPTOR_PATH],
    root,
    execFileSync,
  );
  const bytes = contentMap(root, files).get(resolve(descriptorPath));
  if (bytes === undefined) throw new TypeError("Qualification descriptor Git blob is missing");
  return JSON.parse(bytes.toString("utf8"));
}

export function readCodingIssueJourneyEvidenceAtLanding({
  root,
  landingCommitSha,
  manifestPath,
  receiptsDir,
  descriptorPath,
}) {
  const manifestOnly = new Set([CODING_ISSUE_JOURNEY_MANIFEST_PATH]);
  const failures = [
    ...canonicalPathFailures(root, manifestPath, receiptsDir, descriptorPath),
    ...worktreeEvidenceFailures(root, manifestOnly),
  ];
  if (failures.length > 0) return { failures, descriptor: undefined, contentByPath: new Map() };
  let descriptor;
  try {
    descriptor = readLandingDescriptor(root, landingCommitSha, descriptorPath);
  } catch {
    return {
      failures: ["qualification descriptor must be a tracked regular Git JSON blob"],
      descriptor: undefined,
      contentByPath: new Map(),
    };
  }
  const allowed = allowedEvidencePaths(descriptor);
  if (allowed === null) {
    return {
      failures: ["qualification descriptor contains an unsafe evidence id"],
      descriptor,
      contentByPath: new Map(),
    };
  }
  failures.push(
    ...worktreeEvidenceFailures(root, allowed),
    ...gitEvidenceFailures(root, landingCommitSha, allowed),
  );
  if (failures.length > 0) return { failures, descriptor, contentByPath: new Map() };
  try {
    const paths = [CODING_ISSUE_JOURNEY_DESCRIPTOR_PATH, ...allowed];
    const files = readGitSourceContent(landingCommitSha, paths, root, execFileSync);
    return { failures, descriptor, contentByPath: contentMap(root, files) };
  } catch {
    return {
      failures: ["qualification evidence inputs must be tracked regular Git blobs"],
      descriptor,
      contentByPath: new Map(),
    };
  }
}

function descriptorEvidenceIds(descriptor) {
  const scenarios = Array.isArray(descriptor?.scenarios) ? descriptor.scenarios : [];
  const flows = Array.isArray(descriptor?.flows) ? descriptor.flows : [];
  const ids = [
    ...scenarios.map((scenario) => scenario?.scenarioId),
    ...flows.map((flow) => flow?.flowId),
  ];
  return ids.every((id) => typeof id === "string" && SCENARIO_ID.test(id)) ? ids : null;
}

function allowedEvidencePaths(descriptor) {
  const ids = descriptorEvidenceIds(descriptor);
  if (ids === null) return null;
  const paths = new Set([CODING_ISSUE_JOURNEY_MANIFEST_PATH]);
  for (const id of ids) {
    paths.add(`${CODING_ISSUE_JOURNEY_RECEIPTS_PATH}/${id}.artifact`);
    paths.add(`${CODING_ISSUE_JOURNEY_RECEIPTS_PATH}/${id}.receipt.json`);
  }
  return paths;
}

function gitIdentity(root, sourceCommitSha, landingCommitSha, sourceTreeSha) {
  if (!COMMIT_SHA.test(sourceCommitSha) || !COMMIT_SHA.test(landingCommitSha)) {
    return {
      failures: ["qualification source or landing commit is invalid"],
      actualSourceTree: null,
    };
  }
  try {
    const actualLanding = git(root, ["rev-parse", "HEAD"]);
    const actualSourceTree = git(root, ["rev-parse", `${sourceCommitSha}^{tree}`]);
    git(root, ["merge-base", "--is-ancestor", sourceCommitSha, landingCommitSha]);
    const failures = [];
    if (actualLanding !== landingCommitSha) failures.push("qualification landing commit is stale");
    if (actualSourceTree !== sourceTreeSha) {
      failures.push("qualification source tree does not match the frozen source commit");
    }
    return { failures, actualSourceTree };
  } catch {
    return {
      failures: ["qualification source commit is missing, foreign, or not an ancestor"],
      actualSourceTree: null,
    };
  }
}

export function inspectCodingIssueJourneySourceBinding({
  root,
  sourceCommitSha,
  sourceTreeSha,
  landingCommitSha,
  manifestPath,
  receiptsDir,
  descriptorPath,
  descriptor,
}) {
  const failures = canonicalPathFailures(root, manifestPath, receiptsDir, descriptorPath);
  const allowed = allowedEvidencePaths(descriptor);
  if (allowed === null) failures.push("qualification descriptor contains an unsafe evidence id");
  if (allowed !== null) {
    failures.push(
      ...worktreeEvidenceFailures(root, allowed),
      ...gitEvidenceFailures(root, landingCommitSha, allowed),
    );
  }
  const identity = gitIdentity(root, sourceCommitSha, landingCommitSha, sourceTreeSha);
  failures.push(...identity.failures);
  try {
    if (git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).length > 0) {
      failures.push("qualification landing worktree is not clean");
    }
    if (allowed !== null && identity.failures.length === 0) {
      for (const changedPath of listChangedGitPaths(sourceCommitSha, root)) {
        if (!allowed.has(changedPath)) {
          failures.push(`qualification source changed outside evidence outputs: ${changedPath}`);
        }
      }
    }
  } catch {
    failures.push("qualification source change set is unavailable");
  }
  return {
    failures,
    sourceCommitSha,
    sourceTreeSha: identity.actualSourceTree ?? sourceTreeSha,
    landingCommitSha,
  };
}
