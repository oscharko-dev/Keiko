#!/usr/bin/env node
// ADR-0177 D8: points v<version> at the green dev head when that version is approved for every
// portable target and not yet published. The decision and the write live in
// scripts/lib/release-candidate.mjs; this file only wires the host executables and the two tokens.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { ReleaseCandidateError, runReleaseCandidate } from "./lib/release-candidate.mjs";
import { portableRehearsalReadiness } from "./portable-rehearsal-readiness.mjs";

function hostRunner(executable, token) {
  return (args) => {
    const env = { ...process.env };
    if (token !== undefined) env.GH_TOKEN = token;
    return spawnSync(resolveHostExecutable(executable), args, { encoding: "utf8", env });
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const { line } = runReleaseCandidate({
      appendFile: appendFileSync,
      decideReadiness: portableRehearsalReadiness,
      env: process.env,
      mode: process.argv[2],
      readText: (path) => readFileSync(resolve(process.cwd(), path), "utf8"),
      runGh: hostRunner("gh", process.env.GITHUB_TOKEN),
      runGhWithTagToken: hostRunner("gh", process.env.KEIKO_RELEASE_TAG_TOKEN),
      runNpm: hostRunner("npm", undefined),
    });
    process.stdout.write(`${line}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${error instanceof ReleaseCandidateError ? message : `release-candidate: ${message}`}\n`,
    );
    process.exitCode = 1;
  }
}
