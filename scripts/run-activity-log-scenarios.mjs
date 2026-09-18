#!/usr/bin/env node
// Executes the curated Activity Log scenario matrix: every test file the failure-surface inventory
// resolves an end-to-end scenario (`expectActivityLogScenario("<surface>.<mode>", …)`) to. Each
// scenario drives a production entry point into one failure mode and requires the support
// analyzer's sufficiency projection to reach `complete`, so running them turns "every supported
// failure class maps to a scenario" into "that scenario passes" on every run of the gate.
//
// The file set comes from the generated inventory, which `check:op-catalog` pins byte for byte to
// the sources, so this runner discovers nothing itself. Contract-level proofs
// (`expectActivityLogProof`) resolve statically in that same inventory and execute with their
// owning package's suite.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FAILURE_SURFACE_INVENTORY_RELATIVE_PATH } from "./lib/activity-log-failure-surfaces.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST_FILE = /^(?:packages\/[a-z0-9-]+\/src|tests)\/[\w./-]+\.test\.(?:ts|tsx|mts)$/u;

function compareCodepoints(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** The sorted, unique test files the inventory resolves any scenario to. */
export function activityLogScenarioFiles(inventory) {
  const scenarios = inventory?.scenarios;
  if (typeof scenarios !== "object" || scenarios === null || Array.isArray(scenarios)) {
    throw new TypeError("activity-log scenarios: the inventory has no scenarios map");
  }
  const files = Object.values(scenarios).flatMap((entry) => {
    if (!Array.isArray(entry) || !entry.every((file) => TEST_FILE.test(file))) {
      throw new TypeError("activity-log scenarios: the inventory names a non-test path");
    }
    return entry;
  });
  return [...new Set(files)].toSorted(compareCodepoints);
}

/** Runs the given test files with the repository's own vitest; true only for a clean zero exit. */
export function vitestRunner(spawn = spawnSync) {
  return (files) => {
    const result = spawn(
      process.execPath,
      [join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"), "run", ...files],
      { cwd: REPO_ROOT, shell: false, stdio: "inherit" },
    );
    return result.error === undefined && result.signal === null && result.status === 0;
  };
}

/** Exit code: 0 when every resolved scenario passed, 1 otherwise or when none resolves. */
export function main(dependencies = {}) {
  const deps = {
    readInventory: () =>
      JSON.parse(readFileSync(join(REPO_ROOT, FAILURE_SURFACE_INVENTORY_RELATIVE_PATH), "utf8")),
    run: vitestRunner(),
    write: (line) => console.log(line),
    ...dependencies,
  };
  const files = activityLogScenarioFiles(deps.readInventory());
  if (files.length === 0) {
    deps.write("activity-log scenarios FAIL — the inventory resolves no scenario test.");
    return 1;
  }
  const passed = deps.run(files);
  deps.write(
    `activity-log scenarios ${passed ? "PASS" : "FAIL"} — ran the ${String(files.length)} ` +
      "scenario test file(s) the failure-surface inventory resolves.",
  );
  return passed ? 0 : 1;
}

if (isMainModule(import.meta.url)) process.exitCode = main();
