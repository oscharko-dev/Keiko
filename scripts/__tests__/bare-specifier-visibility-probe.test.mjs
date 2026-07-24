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
    // Redacted contract (Wave-2 audit #2627): the failure result carries only a
    // bounded reason and the numeric exit status. Raw subprocess text MUST NOT
    // leak into the returned outcome so gate logs stay path-free.
    expect(outcome).toEqual({ ok: false, reason: "rule-not-fired", exitStatus: 0 });
    expect(outcome).not.toHaveProperty("stdout");
    expect(outcome).not.toHaveProperty("stderr");
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
    expect(outcome).toEqual({ ok: false, reason: "rule-not-fired", exitStatus: 1 });
    expect(outcome).not.toHaveProperty("stdout");
    expect(outcome).not.toHaveProperty("stderr");
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

  // The writer must live inside the same try boundary as the runner: a writer
  // that partially creates the probe (opens the file, writes some bytes, then
  // throws — disk full, permissions race, filesystem gone) would otherwise
  // leak an orphan probe into the working tree.
  it("removes the probe file even when the writer creates it and then throws", () => {
    const removeProbeFile = vi.fn();
    let writeInvoked = false;
    const writeProbeFile = vi.fn(() => {
      writeInvoked = true;
      throw new Error("disk full after partial write");
    });
    expect(() =>
      runBareSpecifierVisibilityProbe(
        baseOptions({
          runDepcruise: () => ({ status: 0, stdout: "", stderr: "" }),
          writeProbeFile,
          removeProbeFile,
        }),
      ),
    ).toThrow("disk full after partial write");
    expect(writeInvoked).toBe(true);
    expect(removeProbeFile).toHaveBeenCalledOnce();
    expect(removeProbeFile).toHaveBeenCalledWith("/repo/packages/keiko-security/src/__probe.ts");
  });
});
