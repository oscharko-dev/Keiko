#!/usr/bin/env node
// Moves the product version everywhere it lives mechanically and proves the result with
// check-version-consistency: `npm run set-version -- 1.2.3`. The logic lives in
// scripts/lib/set-version.mjs; this file only wires the file system and the host executables.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { setVersionMain } from "./lib/set-version.mjs";

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = setVersionMain({
    argv: process.argv.slice(2),
    listWorkspaceDirs: (packagesDir) =>
      readdirSync(packagesDir)
        .map((name) => join(packagesDir, name))
        .filter((dir) => statSync(dir).isDirectory() && existsSync(join(dir, "package.json"))),
    readOptionalText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
    readText: (path) => readFileSync(path, "utf8"),
    root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    spawn: (executable, args, cwd) =>
      spawnSync(resolveHostExecutable(executable), args, { cwd, encoding: "utf8" }),
    write: (stream, text) => process[stream].write(text),
    writeText: (path, text) => writeFileSync(path, text, "utf8"),
  });
}
