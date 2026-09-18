#!/usr/bin/env node
// Moves the product version everywhere it lives mechanically and proves the result with
// check-version-consistency: `npm run set-version -- 1.2.3`. The logic lives in
// scripts/lib/set-version.mjs; this file only wires the file system and the host executables.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { nodeSetVersionHost, setVersionMain } from "./lib/set-version.mjs";

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = setVersionMain({
    ...nodeSetVersionHost(),
    argv: process.argv.slice(2),
    root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    write: (stream, text) => process[stream].write(text),
  });
}
