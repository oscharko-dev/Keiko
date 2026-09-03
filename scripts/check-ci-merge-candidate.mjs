#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveHostExecutable } from "./lib/host-executable.mjs";

const PULL_REQUEST_MERGE_REF = /^refs\/pull\/\d+\/merge$/u;

export function mergeCandidateFailures(candidate) {
  if (candidate.eventName !== "pull_request") return [];

  const failures = [];
  if (!PULL_REQUEST_MERGE_REF.test(candidate.ref ?? "")) {
    failures.push("pull-request ref is not a GitHub merge ref");
  }
  if (candidate.actualSha !== candidate.runSha) {
    failures.push("checked-out revision does not match the immutable workflow revision");
  }
  if (candidate.parents.length !== 2) {
    failures.push("candidate is not a two-parent merge commit");
  }
  if (candidate.parents[0] !== candidate.baseSha) {
    failures.push("candidate first parent does not match the pull-request base");
  }
  if (candidate.parents[1] !== candidate.headSha) {
    failures.push("candidate second parent does not match the pull-request head");
  }
  return failures;
}

export function inspectCurrentCandidate(input = {}) {
  const execute = input.execute ?? execFileSync;
  const executable = (input.resolveExecutable ?? resolveHostExecutable)("git");
  const options =
    input.cwd === undefined ? { encoding: "utf8" } : { cwd: input.cwd, encoding: "utf8" };
  const actualSha = execute(executable, ["rev-parse", "HEAD"], options).trim();
  const commitLines = execute(executable, ["cat-file", "commit", "HEAD"], options).split(/\r?\n/u);
  const headerEnd = commitLines.indexOf("");
  const commitHeaders = headerEnd < 0 ? [] : commitLines.slice(0, headerEnd);
  return {
    actualSha,
    parents: commitHeaders
      .filter((line) => line.startsWith("parent "))
      .map((line) => line.slice("parent ".length)),
  };
}

export function runCiMergeCandidateCheck(input = {}) {
  const env = input.env ?? process.env;
  const log = input.log ?? console.log;
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    log("ci-merge-candidate: PASS - not a pull-request event.");
    return [];
  }

  const inspected = (input.inspect ?? inspectCurrentCandidate)();
  const failures = mergeCandidateFailures({
    ...inspected,
    baseSha: env.KEIKO_CANDIDATE_BASE_SHA,
    eventName: env.GITHUB_EVENT_NAME,
    headSha: env.KEIKO_CANDIDATE_HEAD_SHA,
    ref: env.GITHUB_REF,
    runSha: env.GITHUB_SHA,
  });
  if (failures.length > 0) throw new Error(failures.join("\n"));
  log("ci-merge-candidate: PASS - exact base, head, and immutable merge revision verified.");
  return failures;
}

const isCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isCli) {
  try {
    runCiMergeCandidateCheck();
  } catch (error) {
    console.error(
      `ci-merge-candidate: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
