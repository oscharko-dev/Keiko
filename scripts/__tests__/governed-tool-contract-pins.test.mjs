import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkGovernedToolContract } from "../check-governed-tool-contract.mjs";
import { GOVERNED_TOOL_CONTRACT_PINS as PINS } from "../lib/governed-tool-contract-pins.mjs";
import { checkInventoryProbes } from "../lib/governed-tool-contract.mjs";

const root = resolve(import.meta.dirname, "../..");
const contract = JSON.parse(
  readFileSync(resolve(root, "docs/architecture/governed-tool-contract.v1.json"), "utf8"),
);
const digestProbes = [
  ["packages/keiko-security/src/hashing.ts", "export function sha256Hex("],
  [
    "packages/keiko-security/src/hashing.ts",
    'export { canonicalise } from "@oscharko-dev/keiko-contracts/runtime/canonical-json";',
  ],
  ["packages/keiko-contracts/src/canonical-json.ts", "export function canonicalise("],
];
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function digestInventoryFixture() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-digest-inventory-"));
  directories.push(directory);
  const paths = new Set([
    ...PINS.inventory.flatMap((row) =>
      (PINS.inventoryMigrations[row.id]?.replacements ?? [row]).map((source) => source.path),
    ),
    ...digestProbes.map(([path]) => path),
  ]);
  for (const path of paths) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(resolve(root, path), "utf8"));
  }
  return directory;
}

describe("governed-tool-contract-pins: retained digest owner and shared canonical producer", () => {
  it("keeps Security ownership and the complete audited inventory with its shared producer", () => {
    const fixture = digestInventoryFixture();
    expect(PINS.owners.digestPrimitives).toBe("keiko-security");
    expect(checkInventoryProbes(contract, fixture)).toEqual([]);
  });

  it.each(digestProbes)("refuses a missing active digest probe in %s: %s", (path, probe) => {
    const fixture = digestInventoryFixture();
    expect(checkInventoryProbes(contract, fixture)).toEqual([]);
    const target = join(fixture, path);
    const source = readFileSync(target, "utf8");
    expect(source).toContain(probe);
    writeFileSync(target, source.replace(probe, "retired-digest-probe"));
    expect(checkInventoryProbes(contract, fixture)).toContain(
      `inventory digest-primitives${probe.includes("sha256Hex") ? "" : ` (${path})`}: source probe missing`,
    );
  });
});

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
