import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkGovernedToolContract } from "../check-governed-tool-contract.mjs";
import { GOVERNED_TOOL_CONTRACT_PINS as PINS } from "../lib/governed-tool-contract-pins.mjs";

const root = resolve(import.meta.dirname, "../..");
const contract = JSON.parse(
  readFileSync(resolve(root, "docs/architecture/governed-tool-contract.v1.json"), "utf8"),
);

// #3413 F8 review, finding b1-9: the live "coding-delivery-policy" inventory row shares its `id`
// with an `inventoryMigrations` entry for the same key. `checkActiveInventoryProbe`
// (governed-tool-contract.mjs) routes any row whose id matches a migrations key through the
// migration branch INSTEAD of probing the row's own declared `path`/`probe` — so this row's own
// fields (a source #2958 deleted from the tree) are never independently verified; only the
// migration's replacement probes are. Before this fix, nothing in the contract doc told a reader
// that "retain owner"/the literal path/probe do not mean what they mean on every other row, and
// the whole file's overview comment did not document this second sanctioned pattern at all.
describe("governed-tool-contract-pins: retired-row-via-inventoryMigrations pattern", () => {
  it("still passes the real gate end to end", () => {
    expect(checkGovernedToolContract(root)).toEqual([]);
  });

  it("routes coding-delivery-policy through inventoryMigrations, not its own (deleted) probe", () => {
    const row = PINS.inventory.find((entry) => entry.id === "coding-delivery-policy");
    expect(row).toBeDefined();
    expect(Object.hasOwn(PINS.inventoryMigrations, row.id)).toBe(true);
    // The row's own declared source is gone -- if this ever starts existing again, the "retired
    // source restored" branch of checkActiveInventoryProbe (not this pin) must catch it; this pin
    // only proves the row's fields describe a retired source, not a currently-probed one.
    expect(() => readFileSync(resolve(root, row.path), "utf8")).toThrow(/ENOENT/u);
  });

  it("verifies every replacement probe inventoryMigrations lists for coding-delivery-policy actually exists", () => {
    const migration = PINS.inventoryMigrations["coding-delivery-policy"];
    expect(migration.replacements.length).toBeGreaterThan(0);
    for (const replacement of migration.replacements) {
      const source = readFileSync(resolve(root, replacement.path), "utf8");
      expect(source).toContain(replacement.probe);
    }
  });

  // The regression this pin actually guards: a row this file's own top comment says must record
  // its retirement in `scope` had a scope string with no retirement wording at all ("full access
  // and mode-independent hard denials"), so a reader trusting `disposition: "retain owner"` plus a
  // literal `path`/`probe` had no signal that neither is currently probed.
  it("documents its own retirement in scope, naming the removal issue", () => {
    const row = contract.inventory.find((entry) => entry.id === "coding-delivery-policy");
    const migration = PINS.inventoryMigrations["coding-delivery-policy"];
    expect(row.scope).toContain(String(migration.removalIssue));
    expect(row.scope).toMatch(/removed|retired/iu);
  });
});
