import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDeclaredKnipEntry, run } from "../check-knip.mjs";

// The dead-code / unused-export gate (knip.json) must fail closed: a clean run passes, any reported
// finding fails, and a knip launch failure (e.g. a missing/corrupt install) fails rather than being
// silently treated as green. These pin that behaviour without invoking the real knip binary.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("check:knip gate", () => {
  it("passes when knip exits clean", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const spawn = vi.fn(() => ({ error: undefined, status: 0 }));

    expect(run(spawn)).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("check:knip PASS"));
  });

  it("fails when knip reports findings", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spawn = vi.fn(() => ({ error: undefined, status: 1 }));

    expect(run(spawn)).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("check:knip FAILED"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("knip.json"));
  });

  it("fails closed when knip cannot be launched at all", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spawn = vi.fn(() => ({ error: new Error("spawn ENOENT"), status: null }));

    expect(run(spawn)).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("could not launch knip"));
  });

  it("treats a missing exit status (e.g. a killed process) as a failure", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spawn = vi.fn(() => ({ error: undefined, status: null }));

    expect(run(spawn)).toBe(1);
  });

  it("fails when knip prints an internal loading error despite status zero", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const spawn = vi.fn(() => ({ error: undefined, status: 0, stderr: "ERROR: config failed" }));

    expect(run(spawn)).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("internal error"));
  });

  it("fails before spawn when installed package metadata cannot be resolved", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spawn = vi.fn();
    const resolveEntry = vi.fn(() => {
      throw new Error("missing metadata");
    });

    expect(run(spawn, resolveEntry)).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("declared executable"));
  });

  it("replays non-error output and preserves a clean verdict", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const spawn = vi.fn(() => ({
      error: undefined,
      status: 0,
      stdout: "configuration hint\n",
      stderr: "diagnostic note\n",
    }));

    expect(run(spawn)).toBe(0);
    expect(stdout).toHaveBeenCalledWith("configuration hint\n");
    expect(stderr).toHaveBeenCalledWith("diagnostic note\n");
  });
});

describe("knip executable resolution", () => {
  const packageJsonPath = "/workspace/node_modules/knip/package.json";

  it.each([
    ["string bin", { bin: "bin/knip.js" }],
    ["named bin", { bin: { knip: "dist/cli.js", other: "dist/other.js" } }],
  ])("resolves a declared %s inside the installed package", (_label, metadata) => {
    expect(resolveDeclaredKnipEntry(packageJsonPath, metadata)).toMatch(
      /^\/workspace\/node_modules\/knip\/(?:bin\/knip|dist\/cli)\.js$/u,
    );
  });

  it.each([
    ["missing bin", {}],
    ["missing named bin", { bin: { other: "bin/other.js" } }],
    ["empty bin", { bin: { knip: "" } }],
    ["package escape", { bin: "../outside.js" }],
  ])("fails closed for %s metadata", (_label, metadata) => {
    expect(() => resolveDeclaredKnipEntry(packageJsonPath, metadata)).toThrow();
  });
});
