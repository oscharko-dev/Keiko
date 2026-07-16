import { describe, expect, it } from "vitest";

import { buildRegenerationPlan, CONTAINER_REMEDIATION } from "../regenerate-d12-evidence.mjs";
import { BASELINE_COMMIT } from "../run-d12-perf-comparison.mjs";

describe("D12 evidence regeneration plan", () => {
  const plan = buildRegenerationPlan({
    headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    workdir: "/work",
  });

  it("provisions the candidate at HEAD and the baseline at the pinned commit", () => {
    expect(plan.checkouts).toEqual([
      { commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", root: "/work/candidate" },
      { commit: BASELINE_COMMIT, root: "/work/baseline" },
    ]);
  });

  it("runs every producer and checker step from the candidate checkout", () => {
    expect(plan.commands.every((step) => step.cwd === "/work/candidate")).toBe(true);
    const scripts = plan.commands.map((step) => step.args[0]);
    expect(scripts).toEqual([
      "scripts/build-d12-bundle-input.mjs",
      "scripts/build-d12-bundle-input.mjs",
      "scripts/run-d12-perf-comparison.mjs",
      "scripts/editor-release-evidence.mjs",
      "scripts/check-perf-evidence.mjs",
      "scripts/editor-bundle-size.mjs",
    ]);
  });

  it("writes the comparison into the candidate release document location", () => {
    const runner = plan.commands.find(
      (step) => step.args[0] === "scripts/run-d12-perf-comparison.mjs",
    );
    const outputIndex = (runner?.args.indexOf("--output") ?? -1) + 1;
    expect(runner?.args[outputIndex]).toBe("/work/candidate/docs/release/1209-perf-evidence.json");
  });

  it("keeps artifacts outside both checkouts", () => {
    const runner = plan.commands.find(
      (step) => step.args[0] === "scripts/run-d12-perf-comparison.mjs",
    );
    const artifactsIndex = (runner?.args.indexOf("--artifacts-root") ?? -1) + 1;
    expect(runner?.args[artifactsIndex]).toBe("/work/out/d12-perf-runs");
  });

  it("directs non-Linux hosts to the pinned container invocation", () => {
    expect(CONTAINER_REMEDIATION).toContain("node:24.18.0-bookworm");
    expect(CONTAINER_REMEDIATION).toContain("bubblewrap");
    expect(CONTAINER_REMEDIATION).toContain("scripts/regenerate-d12-evidence.mjs");
  });
});
