import { describe, expect, it } from "vitest";
import { half } from "../src/buggy.js";

// This regression test FAILS against the buggy source (half(10) === 3.33…) and PASSES once the
// integration test applies the fix (n / 2). It is the verified evidence that the bug reproduces and
// the fix resolves it.
describe("half", () => {
  it("returns half of the input", () => {
    expect(half(10)).toBe(5);
  });
});
