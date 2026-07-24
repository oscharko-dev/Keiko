import { describe, expect, it, vi } from "vitest";

import { runBareSpecifierVisibilityProbe } from "../lib/bare-specifier-visibility-probe.mjs";

function baseOptions(overrides) {
  return {
    repoRoot: "/repo",
    rulesFile: ".dependency-cruiser.cjs",
    hostPackageSrc: "packages/keiko-security/src",
    probeFileBasename: "__probe.ts",
    targetSpecifier: "@oscharko-dev/keiko-harness",
    expectedRule: "adr-0019-direction-2-security-only-contracts",
    expectedResolved: "packages/keiko-harness/dist/index.js",
    ...overrides,
  };
}

describe("runBareSpecifierVisibilityProbe", () => {
  it("returns ok when dep-cruiser reports the expected rule against the expected resolved edge", () => {
    const writeProbeFile = vi.fn();
    const removeProbeFile = vi.fn();
    const runDepcruise = vi.fn(() => ({
      status: 1,
      stdout:
        "  error adr-0019-direction-2-security-only-contracts: " +
        "packages/keiko-security/src/__probe.ts → packages/keiko-harness/dist/index.js\n" +
        "x 1 dependency violations (1 errors, 0 warnings).",
      stderr: "",
    }));

    const outcome = runBareSpecifierVisibilityProbe(
      baseOptions({ runDepcruise, writeProbeFile, removeProbeFile }),
    );

    expect(outcome).toEqual({ ok: true });
    expect(writeProbeFile).toHaveBeenCalledOnce();
    expect(writeProbeFile.mock.calls[0][0]).toBe("/repo/packages/keiko-security/src/__probe.ts");
    expect(writeProbeFile.mock.calls[0][1]).toContain('from "@oscharko-dev/keiko-harness"');
    expect(removeProbeFile).toHaveBeenCalledWith("/repo/packages/keiko-security/src/__probe.ts");
    expect(runDepcruise).toHaveBeenCalledOnce();
    const [, args] = runDepcruise.mock.calls[0];
    expect(args).toContain("--validate");
    expect(args).toContain(".dependency-cruiser.cjs");
    expect(args).toContain("/repo/packages/keiko-security/src/__probe.ts");
  });

  it("returns spawn-failed when the subprocess could not start", () => {
    const removeProbeFile = vi.fn();
    const outcome = runBareSpecifierVisibilityProbe(
      baseOptions({
        runDepcruise: () => ({ status: null, stdout: "", stderr: "" }),
        writeProbeFile: () => undefined,
        removeProbeFile,
      }),
    );
    expect(outcome).toEqual({ ok: false, reason: "spawn-failed" });
    expect(removeProbeFile).toHaveBeenCalledOnce();
  });

  it("returns rule-not-fired when dep-cruiser exits 0 (no violations)", () => {
    const outcome = runBareSpecifierVisibilityProbe(
      baseOptions({
        runDepcruise: () => ({
          status: 0,
          stdout: "no violations",
          stderr: "",
        }),
        writeProbeFile: () => undefined,
        removeProbeFile: () => undefined,
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("rule-not-fired");
    expect(outcome.stdout).toBe("no violations");
  });

  it("returns rule-not-fired when the expected substring is absent from stdout", () => {
    const outcome = runBareSpecifierVisibilityProbe(
      baseOptions({
        runDepcruise: () => ({
          status: 1,
          stdout: "some other rule fired",
          stderr: "warnings",
        }),
        writeProbeFile: () => undefined,
        removeProbeFile: () => undefined,
      }),
    );
    expect(outcome).toEqual({
      ok: false,
      reason: "rule-not-fired",
      stdout: "some other rule fired",
      stderr: "warnings",
    });
  });

  it("removes the probe file even when the assertion fails", () => {
    const removeProbeFile = vi.fn();
    runBareSpecifierVisibilityProbe(
      baseOptions({
        runDepcruise: () => ({ status: 0, stdout: "", stderr: "" }),
        writeProbeFile: () => undefined,
        removeProbeFile,
      }),
    );
    expect(removeProbeFile).toHaveBeenCalledOnce();
  });

  it("removes the probe file even when the runner throws", () => {
    const removeProbeFile = vi.fn();
    expect(() =>
      runBareSpecifierVisibilityProbe(
        baseOptions({
          runDepcruise: () => {
            throw new Error("boom");
          },
          writeProbeFile: () => undefined,
          removeProbeFile,
        }),
      ),
    ).toThrow("boom");
    expect(removeProbeFile).toHaveBeenCalledOnce();
  });
});
