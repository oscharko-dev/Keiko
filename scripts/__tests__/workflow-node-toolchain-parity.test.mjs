import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { EXPECTED_NODE_BASELINE } from "../check-runtime-toolchain.mjs";

// Anchor test for `docs/runtime-toolchain.md`'s claim that every GitHub Actions Node setup is
// followed by the governed toolchain check. That claim was hand-maintained across 26 setup steps in
// eight workflows and had already drifted: `nightly-perf-evidence.yml` was added after the Node 24
// migration, pinned the version, and skipped the gate — so a lane installed with an unverified
// toolchain while the documentation said none could. Only `release.yml`'s npm pin had a lockstep
// test; this is the Node-side equivalent.
//
// The version is compared against EXPECTED_NODE_BASELINE, the same constant
// `scripts/check-runtime-toolchain.mjs` enforces at runtime, never against a literal of this test's
// own. A fixture that recopies the value cannot detect the case where the governed version moves
// and the workflows do not: both sides would change together and the test would stay green over a
// broken lane.

const repoRoot = resolve(import.meta.dirname, "..", "..");
const WORKFLOW_DIR = join(repoRoot, ".github", "workflows");
const ACTION_DIR = join(repoRoot, ".github", "actions");
const GATE_SCRIPT = "check-runtime-toolchain.mjs";
const SETUP_NODE = "actions/setup-node@";

function collectYaml(directory, accumulator = []) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return accumulator;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      collectYaml(path, accumulator);
      continue;
    }
    if (/\.ya?ml$/u.test(entry)) accumulator.push(path);
  }
  return accumulator;
}

// A workflow's steps live under `jobs.<id>.steps`; a composite action's under `runs.steps`. Both
// shapes are collected so a Node setup hidden in a composite action cannot escape the rule.
function stepGroups(document, label) {
  const groups = [];
  for (const [jobId, job] of Object.entries(document?.jobs ?? {})) {
    if (Array.isArray(job?.steps)) groups.push({ label: `${label}:${jobId}`, steps: job.steps });
  }
  if (Array.isArray(document?.runs?.steps)) {
    groups.push({ label: `${label}:runs`, steps: document.runs.steps });
  }
  return groups;
}

// Every occurrence is kept, not just the first. Collapsing to one index per kind is what let a
// second `setup-node` added AFTER the gate satisfy an assertion about "every" setup.
function classify(steps) {
  const setupNode = [];
  const gates = [];
  const installs = [];
  steps.forEach((step, index) => {
    if (typeof step?.uses === "string" && step.uses.includes(SETUP_NODE)) setupNode.push(index);
    if (typeof step?.run !== "string") return;
    if (step.run.includes(GATE_SCRIPT)) gates.push(index);
    if (/\bnpm ci\b/u.test(step.run)) installs.push(index);
  });
  return { setupNode, gates, installs };
}

function allGroups() {
  const groups = [];
  for (const path of [...collectYaml(WORKFLOW_DIR), ...collectYaml(ACTION_DIR)]) {
    const label = relative(repoRoot, path);
    groups.push(...stepGroups(parse(readFileSync(path, "utf8")), label));
  }
  return groups;
}

const groups = allGroups();
const withSetupNode = groups.filter((group) => classify(group.steps).setupNode.length > 0);

describe("workflow Node toolchain parity", () => {
  it("finds the Node setup steps at all, so a parsing regression cannot pass this file vacuously", () => {
    // Without this, a YAML shape change that made `stepGroups` return nothing would turn every
    // assertion below into a loop over an empty array and report success.
    expect(withSetupNode.length).toBeGreaterThanOrEqual(8);
  });

  it("pins every actions/setup-node step to the governed Node version", () => {
    for (const group of withSetupNode) {
      for (const index of classify(group.steps).setupNode) {
        const step = group.steps[index];
        expect(String(step.with?.["node-version"]), `${group.label} step ${index}`).toBe(
          EXPECTED_NODE_BASELINE,
        );
      }
    }
  });

  it("verifies the governed toolchain after every Node setup and before npm ci", () => {
    // Asserted per setup step, independently. A job that sets up Node twice must verify the
    // toolchain after each one: the second setup selects a different runtime, and a gate that ran
    // before it proves nothing about what the following `npm ci` actually installs with.
    for (const group of withSetupNode) {
      const { setupNode, gates, installs } = classify(group.steps);
      for (const setup of setupNode) {
        const gate = gates.find((index) => index > setup);
        expect(
          gate,
          `${group.label}: the setup-node at step ${String(setup)} is never followed by ${GATE_SCRIPT}`,
        ).toBeDefined();
        const install = installs.find((index) => index > setup);
        if (install !== undefined) {
          expect(
            gate,
            `${group.label}: npm ci at step ${String(install)} runs before the toolchain is verified`,
          ).toBeLessThan(install);
        }
      }
    }
  });
});
