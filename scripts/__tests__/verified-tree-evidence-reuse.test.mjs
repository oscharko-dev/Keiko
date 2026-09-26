import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { acceptMergedPullCandidate } from "../resolve-verified-tree-evidence.mjs";
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

// `!cancelled()`, never `always()` (ADR-0157): both run a job after a failed need, but GitHub keeps
// a running job whose `if:` is still true when the run is cancelled, so `always()` left superseded
// pull-request runs alive and holding the concurrency group the new head's run waits on.
const COND = (extra) => "${{ !cancelled() && " + (extra ? extra + " && " : "") + GUARD + " }}";
const EDITOR_CLAUSE =
  "(github.event_name != 'pull_request' || github.base_ref != 'feat/keiko-editor')";
const DOC_ONLY_CLAUSE = "needs.change-scope.outputs.documentation-only != 'true'";
// The ONE sanctioned escape from the guard (ADR-0178 D1, amended 2026-09-25): the coverage chain
// and the SonarCloud analysis run on every push to `dev` even for a proven tree, because SonarCloud
// files an analysis under the branch or pull request the scanner names — the pull-request analysis
// measures the same bytes but never advances `dev`'s branch history. Only a `push` to exactly
// `refs/heads/dev` qualifies; a pull request, a merge group or another branch keeps the plain guard.
const DEV_PUSH_CLAUSE = "(github.event_name == 'push' && github.ref == 'refs/heads/dev')";
const COND_OR_DEV_PUSH = () => "${{ !cancelled() && (" + GUARD + " || " + DEV_PUSH_CLAUSE + ") }}";

/**
 * The EXACT condition each gated job must carry. A substring check would also accept a
 * contradictory or weakened expression (`false && <guard>`, or an added `||` escape hatch), so
 * every condition is compared whole, including its job-specific clauses.
 */
const EXPECTED_CONDITIONS = Object.freeze({
  "semantic-duplication": COND(),
  "core-quality": COND(),
  "coverage-packages": COND_OR_DEV_PUSH(),
  "coverage-ui": COND_OR_DEV_PUSH(),
  "coverage-scripts": COND_OR_DEV_PUSH(),
  "coverage-sonar": COND_OR_DEV_PUSH(),
  "build-scan-sbom-smoke": COND(EDITOR_CLAUSE),
  "cross-platform-smoke": COND(DOC_ONLY_CLAUSE),
  "node-26-compatibility": COND(DOC_ONLY_CLAUSE),
  ui: COND(),
});

/**
 * Run the resolver for real under one environment and report what it published AND why.
 *
 * The reason matters: a resolver whose event condition was weakened still ends at
 * `tree-verified=false` here, because it walks on and fails against the unusable token. Asserting
 * only the value would pass over exactly the regression this suite exists to catch.
 * @param {Record<string, string>} env
 * @returns {{ verified: string, reason: string }}
 */
function runResolver(env) {
  const outputFile = join(mkdtempSync(join(tmpdir(), "keiko-resolver-")), "out");
  writeFileSync(outputFile, "");
  // Both branches below assign it, so an initialiser here would be dead (no-useless-assignment).
  let stdout;
  try {
    stdout = execFileSync(
      process.execPath,
      [join(repoRoot, "scripts", "resolve-verified-tree-evidence.mjs")],
      { env: { ...process.env, ...env, GITHUB_OUTPUT: outputFile }, encoding: "utf8" },
    );
  } catch (error) {
    stdout = String(error.stdout ?? "");
  }
  return {
    verified: /^tree-verified=(.*)$/mu.exec(readFileSync(outputFile, "utf8"))?.[1] ?? "",
    reason: stdout.trim(),
  };
}

/** Inventory entries the resolver requires evidence for, read from its source. */
function resolverInventory(constant) {
  const source = readFileSync(
    join(repoRoot, "scripts", "resolve-verified-tree-evidence.mjs"),
    "utf8",
  );
  const body =
    new RegExp(constant + " = Object.freeze\\(\\[([\\s\\S]*?)\\]", "u").exec(source)?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

describe("every expensive job is gated on proven-tree evidence", () => {
  it.each(GATED_JOBS)("%s carries EXACTLY the approved condition", (name) => {
    expect(String(jobs[name].if)).toBe(EXPECTED_CONDITIONS[name]);
  });

  it("names an expected condition for every gated job, so none is added unchecked", () => {
    expect(Object.keys(EXPECTED_CONDITIONS).sort()).toEqual([...GATED_JOBS].sort());
  });

  it.each(GATED_JOBS)("%s can resolve the guard it is asked about", (name) => {
    expect([].concat(jobs[name].needs ?? [])).toContain("verified-tree");
  });

  it("aggregates the resolver itself, which is never reusable evidence", () => {
    expect([].concat(jobs.ci.needs)).toContain("verified-tree");
  });
});

// Asserted by RUNNING the resolver, not by matching its source: a weakened event condition would
// still contain the same text fragment. Hermetic — the event is refused before any network call.
describe("the resolver refuses every event that may not reuse", () => {
  // An EMPTY event name is refused one step earlier, by the required-variable check, so it is
  // asserted separately below rather than here.
  it.each(["pull_request", "workflow_dispatch", "schedule", "pushy", "Push", "MERGE_GROUP"])(
    "refuses event %s on the event itself, before any lookup",
    (event) => {
      const outcome = runResolver({
        KEIKO_EVENT_NAME: event,
        KEIKO_REPOSITORY: "oscharko-dev/Keiko",
        KEIKO_HEAD_SHA: "0".repeat(40),
        KEIKO_TOKEN: "unused-the-event-is-refused-first",
      });
      expect(outcome.verified).toBe("false");
      // The REASON pins that the event gate is what stopped it. Without this, a weakened event
      // condition still reads as `false` here because the run dies on the unusable token instead.
      expect(outcome.reason).toContain(`event ${event} always runs the full matrix`);
    },
  );

  it.each([
    ["an empty event name", { KEIKO_EVENT_NAME: "" }],
    ["a missing repository", { KEIKO_EVENT_NAME: "push", KEIKO_REPOSITORY: "" }],
    ["a missing head sha", { KEIKO_EVENT_NAME: "push", KEIKO_HEAD_SHA: "" }],
    ["a missing token", { KEIKO_EVENT_NAME: "push", KEIKO_TOKEN: "" }],
  ])("refuses, and says so, on %s", (_description, env) => {
    const outcome = runResolver({
      KEIKO_REPOSITORY: "oscharko-dev/Keiko",
      KEIKO_HEAD_SHA: "0".repeat(40),
      KEIKO_TOKEN: "unused",
      ...env,
    });
    expect(outcome.verified).toBe("false");
    expect(outcome.reason).toContain("missing required environment variable");
  });
});

// A candidate run is only evidence if it EXECUTED every job this run skips, which holds only while
// the resolver's inventory covers all of them. A job gated in the workflow but missing from the
// resolver would let an unmeasured gate pass itself off as proven.
describe("the resolver inventory covers every gated job", () => {
  const names = resolverInventory("REUSED_JOB_NAMES");
  const prefixes = resolverInventory("REUSED_JOB_PREFIXES");

  it("reads a non-empty inventory, so a parsing regression cannot pass this vacuously", () => {
    expect(names.length).toBeGreaterThan(0);
    expect(prefixes.length).toBeGreaterThan(0);
  });

  it.each(GATED_JOBS)("%s is covered by the resolver inventory", (job) => {
    const displayName = String(jobs[job].name);
    const covered =
      names.includes(displayName) || prefixes.some((prefix) => displayName.startsWith(prefix));
    expect(covered, `${displayName} is gated but the resolver requires no evidence for it`).toBe(
      true,
    );
  });

  it("carries no inventory entry that matches no gated job", () => {
    const displayNames = GATED_JOBS.map((job) => String(jobs[job].name));
    for (const entry of [...names, ...prefixes]) {
      expect(
        displayNames.some((name) => name === entry || name.startsWith(entry)),
        `resolver inventory entry "${entry}" matches no gated job`,
      ).toBe(true);
    }
  });
});

describe("the aggregator still fails closed", () => {
  it("accepts a complete reuse claim whose gates were skipped by the guard", () => {
    expect(runAggregator(REUSING)).toBe(0);
  });

  // A push to `dev` reuses the other gates but runs the coverage chain and the Sonar analysis
  // (ADR-0178 D1, 2026-09-25): a passed analysis is an always-on gate that ran, a failed one is
  // exactly the red `dev` verdict the branch analysis exists to produce.
  it("accepts a reuse claim on which the dev Sonar analysis ran and passed", () => {
    expect(runAggregator({ ...REUSING, COVERAGE_SONAR_RESULT: "success" })).toBe(0);
  });

  it.each([
    ["the dev Sonar analysis ran and failed", { ...REUSING, COVERAGE_SONAR_RESULT: "failure" }],
    ["the evidence run id is missing", { ...REUSING, TREE_EVIDENCE_RUN_ID: "" }],
    ["the evidence tree sha is missing", { ...REUSING, TREE_EVIDENCE_TREE_SHA: "" }],
    ["the evidence head sha is missing", { ...REUSING, TREE_EVIDENCE_HEAD_SHA: "" }],
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

// The commit-association endpoint returns every pull request ASSOCIATED with a commit, including
// ones that merely contain it and ones that were never merged. Reuse hangs off picking exactly the
// pull request this commit IS the squash of, so each rejection is proven directly here rather than
// through a network round trip.
describe("acceptMergedPullCandidate", () => {
  const SHA = "e93e1c5d76c06f911bd99c91e461f7312e861786";
  const valid = Object.freeze({
    number: 3561,
    merged_at: "2026-09-20T07:16:40Z",
    merge_commit_sha: SHA,
    head: { sha: "ff5c58ea61685b4de7b9546c8ae7fe48fa75c77d" },
  });

  it("accepts the pull request this commit is the squash of", () => {
    expect(acceptMergedPullCandidate(valid, SHA)).toEqual({
      number: 3561,
      headSha: "ff5c58ea61685b4de7b9546c8ae7fe48fa75c77d",
    });
  });

  it.each([
    ["merged_at is absent", { ...valid, merged_at: undefined }],
    ["merged_at is null", { ...valid, merged_at: null }],
    ["merged_at is empty", { ...valid, merged_at: "" }],
    ["merged_at is not a string", { ...valid, merged_at: 1758351400 }],
    ["merged_at is an object", { ...valid, merged_at: {} }],
  ])("refuses an unmerged candidate where %s", (_description, candidate) => {
    expect(acceptMergedPullCandidate(candidate, SHA)).toBeNull();
  });

  it.each([
    ["it merely contains the commit", { ...valid, merge_commit_sha: "f".repeat(40) }],
    ["merge_commit_sha is absent", { ...valid, merge_commit_sha: undefined }],
    ["merge_commit_sha is null", { ...valid, merge_commit_sha: null }],
  ])("refuses a candidate whose merge commit is not this commit (%s)", (_d, candidate) => {
    expect(acceptMergedPullCandidate(candidate, SHA)).toBeNull();
  });

  it.each([
    ["the number is missing", { ...valid, number: undefined }],
    ["the number is a string", { ...valid, number: "3561" }],
    ["the head sha is missing", { ...valid, head: {} }],
    ["the head is missing", { ...valid, head: undefined }],
    ["the head sha is empty", { ...valid, head: { sha: "" } }],
  ])("refuses a candidate with no usable identity (%s)", (_d, candidate) => {
    expect(acceptMergedPullCandidate(candidate, SHA)).toBeNull();
  });

  it.each([[null], [undefined], ["not an object"], [42], [[]]])(
    "refuses a malformed payload (%s)",
    (candidate) => {
      expect(acceptMergedPullCandidate(candidate, SHA)).toBeNull();
    },
  );
});
