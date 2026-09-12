#!/usr/bin/env node
// Re-measures the tool-catalog performance reference in its pinned container.
//
// The reference environment is fixed by `check-tool-catalog-performance.mjs` (linux/arm64, Node
// v24.18.0, >=14 logical cores, one pinned image digest), so a producer change that legitimately
// moves the subject could only be re-measured by hand-assembling that `docker run` from the gate's
// constants. That undocumented step is why an otherwise one-line producer edit stalled: the gate
// named the drift correctly and left no supported way to repair it. This is that way.
//
// The image is IMPORTED from the gate, never re-read out of its source: one declaration, so the
// container a measurement runs in and the container the gate attests cannot drift apart.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isMainModule } from "./lib/is-main-module.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { TOOL_CATALOG_REFERENCE_IMAGE } from "./check-tool-catalog-performance.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The exact `docker run` the reference measurement needs; pure, so its shape is testable. */
export function regenerateArguments(root, image = TOOL_CATALOG_REFERENCE_IMAGE) {
  return [
    "run",
    "--rm",
    "-v",
    `${root}:/repo`,
    "-w",
    "/repo",
    "-e",
    `KEIKO_TOOL_CATALOG_REFERENCE_IMAGE=${image}`,
    image,
    "node",
    "scripts/check-tool-catalog-performance.mjs",
    "--write-reference",
  ];
}

if (isMainModule(import.meta.url)) {
  execFileSync(resolveHostExecutable("docker"), regenerateArguments(repoRoot), {
    stdio: "inherit",
  });
}
