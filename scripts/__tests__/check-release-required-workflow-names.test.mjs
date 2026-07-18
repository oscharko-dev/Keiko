import { describe, expect, it } from "vitest";

import {
  portableReleaseAuthorityFailures,
  releaseRequiredChecks,
  workflowJobNames,
} from "../check-release-required-workflow-names.mjs";

// S8786 remediation: `releaseRequiredChecks` used to extract its value with
// `/^\s*RELEASE_REQUIRED_CHECKS:\s*'([^']+)'/m` and `workflowJobNames` matched job names with
// `/^ {4}name:\s*(.+)$/u`. Both chain an unbounded quantifier around a literal token in a single
// pattern - the shape Sonar's S8786 rule flags for super-linear backtracking risk. Neither
// measured exponential/quadratic in practice (both are anchored and their quantified spans are
// bounded by real YAML indentation), but they were rewritten as plain per-line string scans that
// cannot backtrack at all, removing the shape structurally rather than arguing the heuristic down.

describe("releaseRequiredChecks", () => {
  it("extracts the quoted JSON array declared on env.RELEASE_REQUIRED_CHECKS", () => {
    const source = [
      "env:",
      "  RELEASE_BASE_BRANCH: 'dev'",
      '  RELEASE_REQUIRED_CHECKS: \'["ci","ui","actionlint"]\'',
    ].join("\n");
    expect(releaseRequiredChecks(source)).toEqual(["ci", "ui", "actionlint"]);
  });

  it("finds the key across blank lines and varying indentation", () => {
    const source = ["env:", "", "   ", "     RELEASE_REQUIRED_CHECKS: '[\"ci\"]'"].join("\n");
    expect(releaseRequiredChecks(source)).toEqual(["ci"]);
  });
});

describe("workflowJobNames", () => {
  it("uses the job id when no explicit name is set, and the name when it is", () => {
    const source = [
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "  test:",
      "    name: Test Suite",
    ].join("\n");
    expect(workflowJobNames(source)).toEqual(["build", "Test Suite"]);
  });

  it("expands a matrix-templated name into one entry per matrix value", () => {
    const source = [
      "jobs:",
      "  scan:",
      "    strategy:",
      "      matrix:",
      "        target: [actions, javascript-typescript]",
      "    name: Analyze (${{ matrix.target }})",
    ].join("\n");
    expect(workflowJobNames(source)).toEqual([
      "Analyze (actions)",
      "Analyze (javascript-typescript)",
    ]);
  });

  it("treats a name line with only whitespace after the colon as an empty name (quirk-preserving)", () => {
    // `unquoteYamlScalar` trims its input, so a `name:` line with nothing but trailing
    // whitespace after the colon still counts as "matched" (an empty job name) rather than
    // falling back to the job id - this pins that exact historical behavior across the rewrite.
    const source = ["jobs:", "  job1:", "    name:   "].join("\n");
    expect(workflowJobNames(source)).toEqual([""]);
  });

  it("falls back to the job id when nothing at all follows the name: token", () => {
    const source = ["jobs:", "  job1:", "    name:"].join("\n");
    expect(workflowJobNames(source)).toEqual(["job1"]);
  });

  it("ignores a name: line that is not indented by exactly 4 spaces", () => {
    const source = ["jobs:", "     name: not a job name line", "  job1:"].join("\n");
    expect(workflowJobNames(source)).toEqual(["job1"]);
  });

  it("completes within budget for a large, mostly non-matching workflow source (S8786 regression)", () => {
    const jobBlock = (index) =>
      [`  job${String(index)}:`, "    runs-on: ubuntu-latest", `    name: ${"x".repeat(60)}`].join(
        "\n",
      );
    const source = ["jobs:", ...Array.from({ length: 6000 }, (_, index) => jobBlock(index))].join(
      "\n",
    );

    const start = Date.now();
    const names = workflowJobNames(source);
    expect(Date.now() - start).toBeLessThan(300);
    expect(names).toHaveLength(6000);
  });
});

describe("portableReleaseAuthorityFailures", () => {
  it("reports no drift when both workflows declare matching authority values", () => {
    const release = [
      "env:",
      "  RELEASE_BASE_BRANCH: 'dev'",
      "  RELEASE_REQUIRED_CHECKS: '[\"ci\"]'",
    ].join("\n");
    const portable = release;
    expect(portableReleaseAuthorityFailures(release, portable)).toEqual([]);
  });

  it("reports the drifted key when a value diverges between workflows", () => {
    const release = [
      "env:",
      "  RELEASE_BASE_BRANCH: 'dev'",
      "  RELEASE_REQUIRED_CHECKS: '[\"ci\"]'",
    ].join("\n");
    const portable = [
      "env:",
      "  RELEASE_BASE_BRANCH: 'main'",
      "  RELEASE_REQUIRED_CHECKS: '[\"ci\"]'",
    ].join("\n");
    expect(portableReleaseAuthorityFailures(release, portable)).toEqual(["RELEASE_BASE_BRANCH"]);
  });
});
