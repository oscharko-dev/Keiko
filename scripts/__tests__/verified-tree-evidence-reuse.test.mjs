import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

// ADR-0178. `dev` is protected with linear history and signed squash merges, so the commit that
// lands carries a new sha but the IDENTICAL tree as the pull-request head the required matrix
// already measured. Re-running that matrix cannot discover anything the pull-request run missed —
// it only re-rolls per-job infrastructure flake against a proven tree. Measured before this change:
// 100 of 100 `dev` runs carried an already-proven tree, 15 of them went red anyway (~1% flake
// across ~18 jobs), at ~48 minutes each.
//
// Two halves are pinned here, and both must hold for the reuse to stay safe:
//   1. every expensive job is actually gated, and can resolve the gate it is asked about;
//   2. the aggregator still fails closed — reuse is accepted ONLY with complete evidence, and
//      never covers a gate that ran and failed on this run.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = YAML.parse(readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8"));
const jobs = workflow.jobs;

/** Every job whose verdict a verified tree lets this run reuse. */
const GATED_JOBS = Object.freeze([
  "semantic-duplication",
  "core-quality",
  "coverage-packages",
  "coverage-ui",
  "coverage-scripts",
  "coverage-sonar",
  "build-scan-sbom-smoke",
  "cross-platform-smoke",
  "node-26-compatibility",
  "ui",
]);

const GUARD = "needs.verified-tree.outputs.tree-verified != 'true'";

/** Default job results for one aggregator case: everything green, no reuse. */
const AGGREGATOR_DEFAULTS = Object.freeze({
  CHANGE_SCOPE_RESULT: "success",
  PROTECTED_BRANCH_RESULT: "success",
  CORE_QUALITY_RESULT: "success",
  COVERAGE_SONAR_RESULT: "success",
  SECRET_SCAN_RESULT: "success",
  SEMANTIC_DUPLICATION_RESULT: "success",
  UI_RESULT: "success",
  BUILD_SCAN_SBOM_SMOKE_RESULT: "success",
  CROSS_PLATFORM_RESULT: "success",
  NODE_26_COMPATIBILITY_RESULT: "success",
  DOCUMENTATION_ONLY: "false",
  EDITOR_FAST_PR: "false",
  VERIFIED_TREE_RESULT: "success",
  TREE_VERIFIED: "false",
  TREE_EVIDENCE_RUN_ID: "",
  TREE_EVIDENCE_HEAD_SHA: "",
  TREE_EVIDENCE_TREE_SHA: "",
});

/** A fully populated reuse claim: tree proven, every gated job skipped by the guard. */
const REUSING = Object.freeze({
  TREE_VERIFIED: "true",
  TREE_EVIDENCE_RUN_ID: "35494673014",
  TREE_EVIDENCE_HEAD_SHA: "ff5c58ea61685b4de7b9546c8ae7fe48fa75c77d",
  TREE_EVIDENCE_TREE_SHA: "a2847b68a9c436c015dd07e6e542169c1eb56470",
  CORE_QUALITY_RESULT: "skipped",
  COVERAGE_SONAR_RESULT: "skipped",
  SEMANTIC_DUPLICATION_RESULT: "skipped",
  UI_RESULT: "skipped",
  BUILD_SCAN_SBOM_SMOKE_RESULT: "skipped",
  CROSS_PLATFORM_RESULT: "skipped",
  NODE_26_COMPATIBILITY_RESULT: "skipped",
});

/**
 * Run the aggregator's real shell body under one environment and report its exit code.
 * @param {Record<string, string>} overrides
 * @returns {number}
 */
function runAggregator(overrides) {
  const script = jobs.ci.steps.find((step) => typeof step.run === "string").run;
  try {
    execFileSync("bash", ["-e", "-c", script], {
      env: { ...process.env, ...AGGREGATOR_DEFAULTS, ...overrides },
      stdio: "pipe",
    });
    return 0;
  } catch (error) {
    return typeof error.status === "number" ? error.status : 1;
  }
}

describe("verified-tree resolver job", () => {
  it("exists and publishes the identity the aggregator verifies", () => {
    expect(jobs["verified-tree"]).toBeDefined();
    expect(Object.keys(jobs["verified-tree"].outputs)).toEqual(
      expect.arrayContaining([
        "tree-verified",
        "evidence-run-id",
        "evidence-head-sha",
        "evidence-tree-sha",
      ]),
    );
  });

  it("reads no secrets and cannot write anything", () => {
    const permissions = jobs["verified-tree"].permissions;
    expect(permissions).toEqual({ actions: "read", contents: "read", "pull-requests": "read" });
    expect(JSON.stringify(jobs["verified-tree"])).not.toContain("secrets.");
  });
});

describe("every expensive job is gated on proven-tree evidence", () => {
  it.each(GATED_JOBS)("%s carries the guard", (name) => {
    expect(String(jobs[name].if)).toContain(GUARD);
  });

  it.each(GATED_JOBS)("%s can resolve the guard it is asked about", (name) => {
    expect([].concat(jobs[name].needs ?? [])).toContain("verified-tree");
  });

  it("aggregates the resolver itself, which is never reusable evidence", () => {
    expect([].concat(jobs.ci.needs)).toContain("verified-tree");
  });

  it("leaves the pull-request matrix untouched — reuse is a push/merge_group concept only", () => {
    const resolver = readFileSync(
      join(repoRoot, "scripts", "resolve-verified-tree-evidence.mjs"),
      "utf8",
    );
    expect(resolver).toContain('eventName !== "push" && eventName !== "merge_group"');
  });
});

describe("the aggregator still fails closed", () => {
  it("accepts a complete reuse claim whose gates were skipped by the guard", () => {
    expect(runAggregator(REUSING)).toBe(0);
  });

  it.each([
    ["the evidence run id is missing", { ...REUSING, TREE_EVIDENCE_RUN_ID: "" }],
    ["the evidence tree sha is missing", { ...REUSING, TREE_EVIDENCE_TREE_SHA: "" }],
    ["the resolver did not succeed", { ...REUSING, VERIFIED_TREE_RESULT: "failure" }],
    ["the resolver was skipped", { ...REUSING, VERIFIED_TREE_RESULT: "skipped" }],
    ["a gate ran and failed anyway", { ...REUSING, SECRET_SCAN_RESULT: "failure" }],
    ["a gated job failed rather than skipping", { ...REUSING, UI_RESULT: "failure" }],
    ["a gated job was cancelled", { ...REUSING, UI_RESULT: "cancelled" }],
    ["a gated job reports an empty result", { ...REUSING, UI_RESULT: "" }],
    ["a gated job reports an unknown state", { ...REUSING, UI_RESULT: "unknown" }],
  ])("rejects a run where %s", (_description, overrides) => {
    expect(runAggregator(overrides)).toBe(1);
  });

  it.each([
    ["all gates green", {}, 0],
    ["ui failed", { UI_RESULT: "failure" }, 1],
    ["ui skipped without reuse", { UI_RESULT: "skipped" }, 1],
    [
      "cross-platform skipped without a documentation-only change",
      { CROSS_PLATFORM_RESULT: "skipped" },
      1,
    ],
    [
      "cross-platform skipped for a documentation-only change",
      {
        CROSS_PLATFORM_RESULT: "skipped",
        NODE_26_COMPATIBILITY_RESULT: "skipped",
        DOCUMENTATION_ONLY: "true",
      },
      0,
    ],
    [
      "build-scan skipped outside an editor fast-path PR",
      { BUILD_SCAN_SBOM_SMOKE_RESULT: "skipped" },
      1,
    ],
  ])("keeps the non-reuse verdict for %s", (_description, overrides, expected) => {
    expect(runAggregator(overrides)).toBe(expected);
  });
});
