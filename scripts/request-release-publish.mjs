#!/usr/bin/env node
// ADR-0177 D8: a stable tag build asks release.yml to publish exactly that build. The decision lives
// in scripts/lib/release-publish-request.mjs; this file only wires gh.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import {
  ReleasePublishRequestError,
  runReleasePublishRequest,
} from "./lib/release-publish-request.mjs";
import { ReleaseCandidateError } from "./lib/release-candidate.mjs";

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const line = runReleasePublishRequest({
      env: process.env,
      runGh: (args) => spawnSync(resolveHostExecutable("gh"), args, { encoding: "utf8" }),
    });
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
    process.stdout.write(`${line}\n`);
  } catch (error) {
    const known =
      error instanceof ReleasePublishRequestError || error instanceof ReleaseCandidateError;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${known ? message : `request-release-publish: ${message}`}\n`);
    process.exitCode = 1;
  }
}
