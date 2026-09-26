import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { releaseAlignmentExitCode } from "../check-release-alignment.mjs";

// The standing release-alignment lane asks, between two releases, the question the publisher only
// asks at the end of a publish. During the v1.0.0 cut a half-finished release sat unnoticed because
// the check ran only by hand. These pins keep the lane scheduled, detection-only, and honest about
// the difference between a divergence and a check that could not answer.

const workflow = parse(readFileSync(".github/workflows/release-alignment.yml", "utf8"));
const job = workflow.jobs.alignment;
const MARKER = "keiko-release-alignment-diverged";

function namedStep(name) {
  const step = job.steps.find((candidate) => candidate.name === name);
  if (step === undefined) throw new Error(`missing step: ${name}`);
  return step;
}

// Exit codes are taken from the checker, never restated here.
const EXIT = {
  aligned: releaseAlignmentExitCode({ aligned: true, unanswered: [] }),
  diverged: releaseAlignmentExitCode({ aligned: false, unanswered: [] }),
  unanswered: releaseAlignmentExitCode({ aligned: false, unanswered: ["npm latest dist-tag"] }),
};

describe("release alignment lane", () => {
  it("runs on a schedule and on demand, never on a push or a pull request", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.permissions).toEqual({});
    expect(workflow.concurrency).toEqual({
      group: "release-alignment",
      "cancel-in-progress": false,
    });
    expect(Object.keys(workflow.jobs)).toEqual(["alignment"]);
  });

  it("holds exactly the read grants the check needs and the one write grant its report needs", () => {
    expect(job.permissions).toEqual({ contents: "read", deployments: "read", issues: "write" });
    expect(job.environment).toBeUndefined();
  });

  it("reads every tag from a credential-free checkout and installs without lifecycle scripts", () => {
    const checkout = job.steps.find((step) => String(step.uses).startsWith("actions/checkout@"));
    expect(checkout.with).toEqual({ "fetch-depth": 0, "persist-credentials": false });
    const names = job.steps.map((step) => step.name);
    expect(names.indexOf("Verify governed Node.js and npm toolchain")).toBeLessThan(
      names.indexOf("Install dependencies"),
    );
    expect(namedStep("Install dependencies").run).toBe("npm ci --ignore-scripts");
  });

  it("maps the checker's exit codes and files nothing when the check could not answer", () => {
    const check = namedStep("Check release alignment");
    expect(check.id).toBe("alignment");
    expect(check.run).toContain("node scripts/check-release-alignment.mjs");
    expect(new Set(Object.values(EXIT)).size).toBe(3);
    expect(check.run).toContain(`${String(EXIT.aligned)}) status=aligned ;;`);
    expect(check.run).toContain(`${String(EXIT.diverged)}) status=diverged ;;`);
    // Every other exit leaves the step before a status is written, so no report step can run.
    const unanswered = check.run.indexOf("*)");
    expect(unanswered).toBeGreaterThan(0);
    expect(check.run.indexOf('exit "${checker_exit}"', unanswered)).toBeGreaterThan(unanswered);
    expect(check.run.indexOf('echo "status=${status}"')).toBeGreaterThan(
      check.run.indexOf('exit "${checker_exit}"'),
    );
    expect(EXIT.unanswered).not.toBe(EXIT.diverged);
  });

  it("reports a divergence in one tracking issue, fails the lane, and closes the issue once aligned", () => {
    const report = namedStep("Report a diverged release");
    const close = namedStep("Close a resolved divergence report");
    const failLane = namedStep("Fail the lane when the release diverged");
    expect(report.if).toBe("steps.alignment.outputs.status == 'diverged'");
    expect(failLane.if).toBe("steps.alignment.outputs.status == 'diverged'");
    expect(failLane.run).toBe("exit 1");
    expect(close.if).toBe("steps.alignment.outputs.status == 'aligned'");
    for (const step of [report, close]) {
      expect(step.run).toContain(`marker="${MARKER}"`);
      expect(step.run).toContain('--search "\\"${marker}\\" in:body"');
      expect(step.run).toContain("set -eo pipefail");
    }
    expect(report.run.indexOf("gh issue list")).toBeLessThan(report.run.indexOf("gh issue create"));
    expect(report.run).toContain('--title "Release alignment diverged"');
    expect(close.run).toContain("gh issue close");
    expect(close.run).not.toContain("gh issue create");
  });

  it("passes no expression into a shell script", () => {
    for (const step of job.steps) {
      if (step.run !== undefined) expect(step.run, String(step.name)).not.toContain("${{");
    }
  });
});
