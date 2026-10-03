import { describe, it } from "node:test";
import { strictEqual } from "node:assert";
import { half } from "../src/buggy.ts";

// The real workflow integration executes this regression before and after applying the fix.
describe("half", () => {
  it("returns half of the input", () => {
    strictEqual(half(10), 5);
  });
});
