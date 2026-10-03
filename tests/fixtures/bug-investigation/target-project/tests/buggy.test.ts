import { readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { strictEqual } from "node:assert";
// Refresh the fixture's single-entry source parent before loading the atomically replaced module.
// Docker Desktop can otherwise retain a stale bind-mount dentry after the real workflow patch.
readdirSync(new URL("../src/", import.meta.url));

const { half } = (await import(
  new URL("../src/buggy.ts", import.meta.url).href
)) as typeof import("../src/buggy.js");

// The real workflow integration executes this regression before and after applying the fix.
void describe("half", () => {
  void it("returns half of the input", () => {
    strictEqual(half(10), 5);
  });
});
