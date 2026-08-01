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

export function resolveQualityRange({ base, head }, git = repositoryGit) {
  if (!SHA.test(head ?? "")) throw new Error("head must be an immutable commit SHA");
  requireCommit(head, git);
  const candidate = SHA.test(base ?? "") && base !== ZERO_SHA ? base : undefined;
  const resolvedBase = candidate ?? git(["rev-list", "--max-parents=0", head]).split("\n")[0];
  if (resolvedBase === undefined || !SHA.test(resolvedBase)) {
    throw new Error("base could not be resolved to an immutable commit SHA");
  }
  requireCommit(resolvedBase, git);
  git(["merge-base", "--is-ancestor", resolvedBase, head]);
  return { base: resolvedBase, head };
}

export function main(env = process.env, git = repositoryGit, write = console.log) {
  try {
    const range = resolveQualityRange(
      { base: env.QUALITY_BASE_SHA, head: env.QUALITY_HEAD_SHA },
      git,
    );
    write(`base=${range.base}`);
    write(`head=${range.head}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "quality range resolution failed";
    console.error(`quality-range: FAIL - ${message}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
