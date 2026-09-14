#!/usr/bin/env node
// ADR-0177 D8: a stable tag build asks release.yml to publish exactly that build. The decision and
// its report live in scripts/lib/release-publish-request.mjs; this file only wires gh.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { releasePublishRequestMain } from "./lib/release-publish-request.mjs";

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = releasePublishRequestMain({
    appendFile: appendFileSync,
    env: process.env,
    runGh: (args) => spawnSync(resolveHostExecutable("gh"), args, { encoding: "utf8" }),
    write: (stream, text) => process[stream].write(text),
  });
}
