#!/usr/bin/env node
// ADR-0177 D9: the first job of every publish. It accepts the dispatch only from an allowlisted owner
// or for a commit an owner requested with the release button, and names the exact stable build the
// publish job may release. The decision lives in scripts/lib/release-automation.mjs; this file only
// wires the host executables.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { releaseAutomationMain, runReleaseAuthorize } from "./lib/release-automation.mjs";

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const ghEnv = { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN };
  process.exitCode = releaseAutomationMain({
    appendFile: appendFileSync,
    env: process.env,
    prefix: "release-authorize",
    run: () =>
      runReleaseAuthorize({
        env: process.env,
        runGh: (args) =>
          spawnSync(resolveHostExecutable("gh"), args, { encoding: "utf8", env: ghEnv }),
      }),
    write: (stream, text) => process[stream].write(text),
  });
}
