#!/usr/bin/env node
// Dead-code / unused-export gate (knip, config in knip.json). Invokes knip through its own bin
// entry directly rather than node_modules/.bin or npx, so the gate is hermetic and independent of
// platform-specific shim shape (mirrors scripts/arch-check-negative.mjs's dependency-cruiser call).

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const knipEntry = join(repoRoot, "node_modules", "knip", "bin", "knip.js");

function run() {
  const result = spawnSync(process.execPath, [knipEntry, "--no-progress"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    console.error(`check:knip FAILED — could not launch knip: ${result.error.message}`);
    return 1;
  }
  const code = result.status ?? 1;
  if (code === 0) {
    console.log("check:knip PASS — no unused files, exports, dependencies, or binaries.");
  } else {
    console.error(
      "check:knip FAILED — knip reported unresolved findings above. Remove the dead code, or if a " +
        "finding is a verified false positive, add a narrow, justified exception to knip.json " +
        "(entry/ignore/ignoreDependencies/ignoreBinaries) — never widen it to silence a real finding.",
    );
  }
  return code;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = run();
}
