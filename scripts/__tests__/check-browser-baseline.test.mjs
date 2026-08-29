import { describe, expect, it, vi } from "vitest";

import { parseDeclaredFloors } from "../check-browser-baseline.mjs";

// Review finding (F1): parseDeclaredFloors kept only the LAST floor per engine — for
// ["chrome >= 100", "chrome >= 111"] it checked only Chrome 111, even though Browserslist itself
// resolves and unions every query in the array, so Chrome 100 stays a real declared-supported
// target. A guarded API needing Chrome 103-110 would then pass this gate while remaining
// unreachable on a browser Browserslist still declares supported. This pins the fail-closed
// replacement: a duplicate engine is a gate FAILURE, matching every other unparsable-declaration
// path in this file, never a silent last-write-wins overwrite.
describe("parseDeclaredFloors", () => {
  it("keeps one floor per engine for a well-formed declaration", () => {
    expect(parseDeclaredFloors(["chrome >= 111", "firefox >= 100", "safari >= 16.4"])).toEqual(
      new Map([
        ["chrome", 111],
        ["firefox", 100],
        ["safari", 16.4],
      ]),
    );
  });

  it("fails closed on a duplicate engine instead of silently keeping only the last floor", () => {
    const exitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = parseDeclaredFloors(["chrome >= 100", "chrome >= 111"]);
      expect(result).toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("chrome more than once (100 and 111)"),
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
      error.mockRestore();
    }
  });

  it("fails closed on an unparsable browserslist entry", () => {
    const exitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(parseDeclaredFloors(["chrome >= 111", "not a floor"])).toBeUndefined();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('"not a floor"'));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
      error.mockRestore();
    }
  });
});
