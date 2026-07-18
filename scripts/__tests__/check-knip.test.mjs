import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../check-knip.mjs";

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
});
