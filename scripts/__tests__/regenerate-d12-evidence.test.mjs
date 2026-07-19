import { describe, expect, it, vi } from "vitest";

import {
  buildRegenerationPlan,
  CONTAINER_REMEDIATION,
  regenerateEvidence,
} from "../regenerate-d12-evidence.mjs";
import { BASELINE_COMMIT } from "../run-d12-perf-comparison.mjs";

function injectedDeps(overrides = {}) {
  return {
    capture: vi.fn(() => "cafebabecafebabecafebabecafebabecafebabe"),
    copyFile: vi.fn(),
    hasCommit: vi.fn(() => true),
    log: vi.fn(),
    makeWorkdir: vi.fn(() => "/work"),
    originUrl: vi.fn(() => "https://github.com/oscharko-dev/Keiko.git"),
    platform: "linux",
    run: vi.fn(),
    ...overrides,
  };
}

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

  it("validates the regenerated evidence with the full source-freshness contract (ADR-0139 D10)", () => {
    const check = plan.commands.find((step) => step.args[0] === "scripts/check-perf-evidence.mjs");
    expect(check?.args).toContain("--enforce-source-freshness");
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

describe("regenerateEvidence orchestration", () => {
  it("fails closed with the container remediation on non-Linux hosts", () => {
    const deps = injectedDeps({ platform: "darwin" });
    const result = regenerateEvidence(deps);

    expect(result).toEqual({ ok: false, remediation: CONTAINER_REMEDIATION });
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it("provisions both checkouts, runs every step, and copies both documents back", () => {
    const deps = injectedDeps();

    const result = regenerateEvidence(deps);

    expect(result.ok).toBe(true);
    expect(result.headCommit).toBe("cafebabecafebabecafebabecafebabecafebabe");
    const checkouts = deps.run.mock.calls.filter((call) => call[1].includes("checkout"));
    expect(checkouts).toHaveLength(2);
    const nodeSteps = deps.run.mock.calls.filter((call) => call[0] === "node");
    expect(nodeSteps).toHaveLength(6);
    expect(deps.copyFile).toHaveBeenCalledTimes(2);
    // Every commit is already present locally, so no remote fetch is issued.
    expect(deps.run.mock.calls.some((call) => call[1].includes("fetch"))).toBe(false);
  });

  it("fetches a host-missing commit from the true origin instead of --unshallow", () => {
    // A shallow host lacks the pinned baseline; hasCommit reports it absent for the baseline
    // checkout only, so exactly that checkout fetches the commit from the real origin URL.
    const deps = injectedDeps({
      hasCommit: vi.fn((root) => !root.endsWith("baseline")),
    });

    regenerateEvidence(deps);

    const fetches = deps.run.mock.calls.filter((call) => call[1].includes("fetch"));
    expect(fetches).toHaveLength(1);
    expect(fetches[0][1]).toEqual([
      "fetch",
      "--quiet",
      "https://github.com/oscharko-dev/Keiko.git",
      BASELINE_COMMIT,
    ]);
    // No --unshallow against the local clone origin is ever attempted.
    expect(deps.run.mock.calls.some((call) => call[1].includes("--unshallow"))).toBe(false);
  });

  it("routes every default boundary (run, capture, hasCommit, originUrl) through the executor", () => {
    // `cat-file` (the hasCommit probe) throws → default hasCommit returns false → the default
    // originUrl and the remote fetch run, so every executor-derived boundary is exercised.
    const exec = vi.fn((_bin, args) => {
      if (args.includes("cat-file")) throw new Error("missing commit");
      return "  abcabcabcabcabcabcabcabcabcabcabcabcabca  \n";
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      // Only the executor and copy sink are injected, so the default log, workdir, hasCommit,
      // and originUrl factories run without touching real subprocesses or git.
      regenerateEvidence({ copyFile: vi.fn(), exec, platform: "linux" });
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }

    // capture requests utf8 and trims; run inherits stdio; the hasCommit probe passes
    // stdio:"ignore"; and a remote fetch (originUrl resolved) is issued for the absent commit.
    expect(exec.mock.calls.some((call) => call[2]?.encoding === "utf8")).toBe(true);
    expect(exec.mock.calls.some((call) => call[2]?.stdio === "inherit")).toBe(true);
    expect(exec.mock.calls.some((call) => call[2]?.stdio === "ignore")).toBe(true);
    expect(exec.mock.calls.some((call) => call[1].includes("fetch"))).toBe(true);
    expect(exec.mock.calls.every((call) => typeof call[0] === "string")).toBe(true);
  });
});
