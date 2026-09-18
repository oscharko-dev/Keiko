#!/usr/bin/env node
// Produces the exact human authorization command for a stable portable build. This executable has
// read-only GitHub authority and cannot dispatch or cancel a workflow.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { releasePublishHandoffMain } from "./lib/release-publish-handoff.mjs";

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = releasePublishHandoffMain({
    appendFile: appendFileSync,
    env: process.env,
    runGh: (args) => spawnSync(resolveHostExecutable("gh"), args, { encoding: "utf8" }),
    write: (stream, text) => process[stream].write(text),
  });
}
