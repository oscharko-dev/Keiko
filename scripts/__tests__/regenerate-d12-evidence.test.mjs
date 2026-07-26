import { describe, expect, it, vi } from "vitest";

import {
  buildContainerArgs,
  buildRegenerationPlan,
  CONTAINER_IMAGE,
  CONTAINER_REMEDIATION,
  CONTAINER_SCRIPT,
  PLAYWRIGHT_PIN,
  regenerateEvidence,
  regenerateInContainer,
  executeRegenerationCli,
  resolveCliIo,
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
      "scripts/perf-evidence-gate.mjs",
      "scripts/editor-bundle-size.mjs",
    ]);
  });

  it("validates the regenerated evidence with the full source-freshness contract (ADR-0139 D10)", () => {
    const check = plan.commands.find((step) => step.args[0] === "scripts/perf-evidence-gate.mjs");
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

  // The invariant is that a non-Linux host is handed a COMPLETE, pinned way to measure. It used to
  // be prose the reader retyped, so the pin read the prose. The prose is now one command and the
  // steps it names are executed, so the pin follows them there — same three parts, checked where
  // they now bind rather than where they were quoted.
  it("directs non-Linux hosts to the pinned container invocation", () => {
    expect(CONTAINER_REMEDIATION).toContain("node:24.18.0-bookworm");
    expect(CONTAINER_REMEDIATION).toContain("npm run perf:evidence:regen:container");
    expect(CONTAINER_SCRIPT).toContain("bubblewrap");
    expect(CONTAINER_SCRIPT).toContain("scripts/regenerate-d12-evidence.mjs");
    expect(CONTAINER_SCRIPT).toContain(PLAYWRIGHT_PIN);
    expect(buildContainerArgs("/tmp/c")).toContain(CONTAINER_IMAGE);
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

describe("regenerateInContainer", () => {
  it("clones, runs the pinned container against that clone, and copies both documents back", () => {
    const deps = injectedDeps({ platform: "darwin" });
    const result = regenerateInContainer(deps);

    const [clone] = deps.run.mock.calls[0][1].slice(-1);
    expect(deps.run.mock.calls[0][0]).toBe("git");
    // --no-local matters: a worktree's .git is a file the container cannot resolve.
    expect(deps.run.mock.calls[0][1]).toContain("--no-local");
    // call 0 clones, call 1 re-points the clone's origin at the REAL remote — without that the
    // in-container fallback fetch would target a host path the container cannot resolve — and
    // call 2 is the container itself.
    expect(deps.run.mock.calls[1][0]).toBe("git");
    expect(deps.run.mock.calls[1][1]).toEqual(["remote", "set-url", "origin", deps.originUrl()]);
    expect(deps.run.mock.calls[2][0]).toBe("docker");
    expect(deps.run.mock.calls[2][1]).toEqual(buildContainerArgs(clone));
    expect(deps.copyFile).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true, clone });
  });

  it("mounts the clone read-write at /repo and pins the image", () => {
    const args = buildContainerArgs("/tmp/x.noindex");

    // Pinned deliberately: two narrower profiles (seccomp/apparmor unconfined, and that plus
    // --cap-add=SYS_ADMIN) were each measured end to end and each failed with the debug capability
    // `notProvisioned`, because the bubblewrap sandbox could not unshare. If this assertion is ever
    // relaxed, re-measure before believing the narrower profile works.
    expect(args).toContain("--privileged");
    expect(args.join(" ")).toContain("-v /tmp/x.noindex:/repo");
    expect(args).toContain(CONTAINER_IMAGE);
    // Without safe.directory git refuses the host-owned bind mount with a bare status 128.
    expect(CONTAINER_SCRIPT).toMatch(/safe\.directory/u);
  });
});

describe("command line dispatch", () => {
  it("routes --container to the container lane and nothing else", () => {
    const container = vi.fn().mockReturnValue({ ok: true });
    const regenerate = vi.fn();

    executeRegenerationCli(["node", "x", "--container"], { container, regenerate });

    expect(container).toHaveBeenCalledOnce();
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("runs the host lane by default and stays silent when it succeeds", () => {
    const regenerate = vi.fn().mockReturnValue({ ok: true });
    const error = vi.fn();
    const setExitCode = vi.fn();

    expect(executeRegenerationCli(["node", "x"], { regenerate, error, setExitCode })).toEqual({
      ok: true,
    });
    expect(error).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it("prints the remediation and exits non-zero when the host lane refuses", () => {
    const regenerate = vi
      .fn()
      .mockReturnValue({ ok: false, remediation: "run it on the reference" });
    const error = vi.fn();
    const setExitCode = vi.fn();

    executeRegenerationCli(["node", "x"], { regenerate, error, setExitCode });

    expect(error).toHaveBeenCalledWith("run it on the reference");
    expect(setExitCode).toHaveBeenCalledWith(1);
  });
});

describe("dispatch collaborators", () => {
  it("defaults to the real lanes and the real sinks", () => {
    const deps = resolveCliIo();

    expect(deps.container).toBe(regenerateInContainer);
    expect(deps.regenerate).toBe(regenerateEvidence);
    expect(typeof deps.error).toBe("function");
    expect(typeof deps.setExitCode).toBe("function");
  });

  it("lets every collaborator be replaced", () => {
    const overrides = {
      container: () => "c",
      regenerate: () => "r",
      error: () => "e",
      setExitCode: () => "x",
    };

    expect(resolveCliIo(overrides)).toEqual(overrides);
  });
});

describe("dirty-tree warning", () => {
  it("warns before the clock starts that uncommitted work is not measured", () => {
    const log = vi.fn();
    const deps = {
      dirtyFiles: () => " M scripts/check-perf-evidence.mjs",
      makeWorkdir: () => "/tmp/x",
      run: vi.fn(),
      copyFile: vi.fn(),
      log,
    };

    regenerateInContainer(deps);

    expect(log.mock.calls[0][0]).toContain("uncommitted changes");
    expect(log.mock.calls[0][0]).toContain("scripts/check-perf-evidence.mjs");
  });

  it("says nothing when the tree is clean", () => {
    const log = vi.fn();

    regenerateInContainer({
      dirtyFiles: () => "",
      makeWorkdir: () => "/tmp/x",
      run: vi.fn(),
      copyFile: vi.fn(),
      log,
    });

    expect(log.mock.calls[0][0]).not.toContain("uncommitted");
  });
});
