import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  EXPECTED_NODE_BASELINE,
  EXPECTED_NODE_COMPATIBILITY_BASELINE,
} from "../check-runtime-toolchain.mjs";

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
const NODE_26_JOB = ".github/workflows/ci.yml:node-26-compatibility";
const APPROVED_NODE_BASELINES = new Set([
  EXPECTED_NODE_BASELINE,
  EXPECTED_NODE_COMPATIBILITY_BASELINE,
]);

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
// A mention is not an execution. `# node scripts/check-runtime-toolchain.mjs --exact` in a comment,
// or an `echo` that names it, satisfied the old substring test and made a job look gated while the
// runtime it selected was never verified — the same defect as counting a `uses:` pin that appears
// only in a YAML comment. Only a non-comment line that actually invokes the script counts.
function runsGate(script) {
  return script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("#"))
    .flatMap((line) => line.split(/&&|\|\||[;|]/u))
    .map((segment) => segment.trim())
    .some((segment) => /^(?:node|npx)\s+\S*check-runtime-toolchain\.mjs\b/u.test(segment));
}

function classify(steps) {
  const setupNode = [];
  const gates = [];
  const installs = [];
  steps.forEach((step, index) => {
    if (typeof step?.uses === "string" && step.uses.includes(SETUP_NODE)) setupNode.push(index);
    if (typeof step?.run !== "string") return;
    if (runsGate(step.run)) gates.push(index);
    // `npm\s+ci`, not `npm ci`: a step written with two spaces would not be recognised as an
    // install, and the ordering assertion below would be skipped rather than fail.
    if (/\bnpm\s+ci\b/u.test(step.run)) installs.push(index);
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

const fixture = (...lines) => stepGroups(parse(lines.join("\n")), "fixture.yml");

// The assertions above read the real repository, which is the point of an anchor test — but a
// repository that happens to be correct cannot demonstrate that a violation would be caught. These
// drive the same `classify` helper with documents the repository must never contain.
describe("workflow Node toolchain parity rejects", () => {
  const gate = "- run: node scripts/check-runtime-toolchain.mjs --exact";
  const setup = "- uses: actions/setup-node@abc # v7.0.0";

  it("a second setup-node placed after the only gate", () => {
    const [group] = fixture(
      "jobs:",
      "  a:",
      "    steps:",
      `      ${setup}`,
      `      ${gate}`,
      `      ${setup}`,
    );
    const { setupNode, gates } = classify(group.steps);
    expect(setupNode).toHaveLength(2);
    // The first setup is covered; the second selects a new runtime that nothing verifies.
    expect(gates.find((index) => index > setupNode[0])).toBeDefined();
    expect(gates.find((index) => index > setupNode[1])).toBeUndefined();
  });

  it("npm ci written with extra whitespace, which must still count as an install", () => {
    const [group] = fixture(
      "jobs:",
      "  a:",
      "    steps:",
      `      ${setup}`,
      "      - run: npm  ci",
      `      ${gate}`,
    );
    const { gates, installs } = classify(group.steps);
    expect(installs).toEqual([1]);
    expect(gates[0]).toBeGreaterThan(installs[0]);
  });

  it("a gate that lives in a different job from the setup it is supposed to cover", () => {
    const groups = fixture(
      "jobs:",
      "  a:",
      "    steps:",
      `      ${setup}`,
      "  b:",
      "    steps:",
      `      ${gate}`,
    );
    const withSetup = groups.filter((group) => classify(group.steps).setupNode.length > 0);
    expect(withSetup).toHaveLength(1);
    expect(classify(withSetup[0].steps).gates).toEqual([]);
  });

  it("a gate that is only mentioned in a comment, which executes nothing", () => {
    const [group] = fixture(
      "jobs:",
      "  a:",
      "    steps:",
      `      ${setup}`,
      "      - run: |",
      "          # node scripts/check-runtime-toolchain.mjs --exact",
      "          npm ci",
    );
    expect(classify(group.steps).gates).toEqual([]);
  });

  it("a gate that is only echoed, which also executes nothing", () => {
    const [group] = fixture(
      "jobs:",
      "  a:",
      "    steps:",
      `      ${setup}`,
      '      - run: echo "run node scripts/check-runtime-toolchain.mjs --exact first"',
    );
    expect(classify(group.steps).gates).toEqual([]);
  });

  it("a document with no steps at all, which must contribute no group", () => {
    expect(fixture("jobs:", "  a:", "    runs-on: ubuntu-latest")).toEqual([]);
  });

  it("malformed YAML, by failing loudly rather than contributing an empty group", () => {
    // Silence here would be the worst outcome: an unparseable workflow that yields zero groups
    // reads exactly like a compliant one.
    expect(() => fixture("jobs:", "  a:", "   steps:", "  - uses: [")).toThrow();
  });
});

describe("workflow Node toolchain parity", () => {
  it("finds the Node setup steps at all, so a parsing regression cannot pass this file vacuously", () => {
    // Without this, a YAML shape change that made `stepGroups` return nothing would turn every
    // assertion below into a loop over an empty array and report success.
    // The real count is 27. A floor of 8 would still pass after `ci.yml` and
    // `portable-assets.yml` silently dropped out — 70% of the coverage — so the floor sits
    // just under the true number instead of at a round guess.
    expect(withSetupNode.length).toBeGreaterThanOrEqual(25);
  });

  it("pins every actions/setup-node step to an approved exact Node version", () => {
    for (const group of withSetupNode) {
      for (const index of classify(group.steps).setupNode) {
        const step = group.steps[index];
        expect(
          APPROVED_NODE_BASELINES.has(String(step.with?.["node-version"])),
          `${group.label} step ${index}`,
        ).toBe(true);
      }
    }
  });

  it("confines the Node 26 compatibility baseline to its dedicated CI job", () => {
    const node26Groups = withSetupNode.filter((group) =>
      classify(group.steps).setupNode.some(
        (index) =>
          String(group.steps[index]?.with?.["node-version"]) ===
          EXPECTED_NODE_COMPATIBILITY_BASELINE,
      ),
    );
    expect(node26Groups.map((group) => group.label)).toEqual([NODE_26_JOB]);
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
