#!/usr/bin/env node
// ADR-0177 D9: runs whenever the release request, the stable tag build, or a release-required check
// workflow completes, and starts the publish of the requested commit once it is built and green. The
// decision lives in scripts/lib/release-automation.mjs; this file only wires the host executables.

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import { spawnHostExecutable } from "./lib/host-executable.mjs";
import { releaseAutomationMain, runReleaseAdvance } from "./lib/release-automation.mjs";

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const spawn = (executable, env) => (args) => spawnHostExecutable(executable, args, { env });
  const ghEnv = { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN };
  process.exitCode = releaseAutomationMain({
    appendFile: appendFileSync,
    env: process.env,
    prefix: "release-advance",
    run: () =>
      runReleaseAdvance({
        env: process.env,
        runGh: spawn("gh", ghEnv),
        runNpm: spawn("npm", process.env),
      }),
    write: (stream, text) => process[stream].write(text),
  });
}
