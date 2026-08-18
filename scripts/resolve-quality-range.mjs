#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHostExecutable } from "./lib/host-executable.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = /^[0-9a-f]{40}$/u;
const ZERO_SHA = "0".repeat(40);

function repositoryGit(args) {
  return execFileSync(resolveHostExecutable("git"), args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
}

function requireCommit(sha, git) {
  git(["cat-file", "-e", `${sha}^{commit}`]);
}

function requireImmutableSha(value, message) {
  if (value === undefined || !SHA.test(value)) throw new Error(message);
  return value;
}

function candidateBase(base, head, eventName, git, fallbackBaseRef) {
  if (base !== ZERO_SHA && SHA.test(base ?? "")) return base;
  if (eventName === "push") {
    // A push that creates a branch delivers the zero SHA as its before-pointer. Falling back
    // to the repository root here scanned the ENTIRE history (918 commits on release/0.3.9)
    // and failed the gate on long-accepted historical fixtures, while bounding at head^ would
    // skip earlier commits of a multi-commit branch creation — a secret introduced and deleted
    // again before the head would escape the promised history inspection. The merge-base with
    // the workflow-provided fallback ref (dev) precedes every commit the branch creation
    // introduced; without that ref this fails closed rather than guessing a narrower range.
    if (fallbackBaseRef === undefined || fallbackBaseRef === "") {
      throw new Error(
        "a branch-creating push needs QUALITY_FALLBACK_BASE_REF to bound its scan range",
      );
    }
    return requireImmutableSha(
      git(["merge-base", fallbackBaseRef, head]).split("\n")[0],
      "new-branch push base could not be resolved against the fallback base ref",
    );
  }
  if (eventName === "workflow_dispatch") {
    return requireImmutableSha(
      git(["rev-parse", "--verify", `${head}^`]),
      "run base could not be resolved to the head's parent",
    );
  }
  return requireImmutableSha(
    git(["rev-list", "--max-parents=0", head]).split("\n")[0],
    "base could not be resolved to an immutable commit SHA",
  );
}

export function resolveQualityRange(
  { base, head, eventName, fallbackBaseRef },
  git = repositoryGit,
) {
  const immutableHead = requireImmutableSha(head, "head must be an immutable commit SHA");
  requireCommit(immutableHead, git);
  const candidate = candidateBase(base, immutableHead, eventName, git, fallbackBaseRef);
  requireCommit(candidate, git);
  const resolvedBase = requireImmutableSha(
    git(["merge-base", candidate, immutableHead]).split("\n")[0],
    "merge base could not be resolved to an immutable commit SHA",
  );
  if (resolvedBase !== candidate) requireCommit(resolvedBase, git);
  git(["merge-base", "--is-ancestor", resolvedBase, immutableHead]);
  return { base: resolvedBase, head: immutableHead };
}

function writeOutput(message) {
  process.stdout.write(`${message}\n`);
}

function writeDiagnostic(message) {
  process.stderr.write(`${message}\n`);
}

export function main(
  env = process.env,
  git = repositoryGit,
  write = writeOutput,
  diagnose = writeDiagnostic,
) {
  try {
    const range = resolveQualityRange(
      {
        base: env.QUALITY_BASE_SHA,
        eventName: env.GITHUB_EVENT_NAME,
        fallbackBaseRef: env.QUALITY_FALLBACK_BASE_REF,
        head: env.QUALITY_HEAD_SHA,
      },
      git,
    );
    write(`base=${range.base}`);
    write(`head=${range.head}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "quality range resolution failed";
    diagnose(`quality-range: FAIL - ${message}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
