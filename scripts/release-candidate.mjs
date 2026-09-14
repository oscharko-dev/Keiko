#!/usr/bin/env node
// ADR-0177 D8: points v<version> at the green dev head when that version is approved for every
// portable target and not yet published. The decision, the write and the report live in
// scripts/lib/release-candidate.mjs; this file only wires the host executables.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { releaseCandidateMain } from "./lib/release-candidate.mjs";
import { portableRehearsalReadiness } from "./portable-rehearsal-readiness.mjs";

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = releaseCandidateMain({
    appendFile: appendFileSync,
    argv: process.argv.slice(2),
    decideReadiness: portableRehearsalReadiness,
    env: process.env,
    readText: (path) => readFileSync(resolve(process.cwd(), path), "utf8"),
    spawn: (executable, args, env) =>
      spawnSync(resolveHostExecutable(executable), args, { encoding: "utf8", env }),
    write: (stream, text) => process[stream].write(text),
  });
}
