import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { OP_NAME_PATTERN, generateOpCatalog } from "../generate-op-catalog.mjs";

// Pins docs/observability/op-catalog.generated.json against the generator that derives it — the
// same "derive, don't restate, pin with a drift test" pattern route-template.test.ts already runs
// against API_ROUTES (see AGENTS.md §7). A hand-edited catalog entry, a new instrumentation site
// added without regenerating, or a generator change that silently reorders/drops entries all turn
// this red. The fix is always `npm run generate:op-catalog`, never editing the JSON by hand.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATALOG_PATH = join(repoRoot, "docs", "observability", "op-catalog.generated.json");

function readCheckedInCatalog() {
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
}

describe("op catalog drift", () => {
  it("matches the checked-in file exactly, by value, in the same order", () => {
    const regenerated = generateOpCatalog(repoRoot);
    const checkedIn = readCheckedInCatalog();
    expect(regenerated).toEqual(checkedIn);
  });

  // Belt-and-braces: even if the checked-in file and the generator ever agreed on a bad value,
  // this pins the vocabulary shape itself, independent of the file on disk.
  it("emits every non-dynamic op matching OP_NAME_PATTERN", () => {
    const regenerated = generateOpCatalog(repoRoot);
    for (const entry of regenerated.entries) {
      if (entry.op === "<dynamic>") continue;
      expect(entry.op, `${entry.op} at ${entry.site}`).toMatch(OP_NAME_PATTERN);
    }
  });

  // The generator's own audit is expected to be empty today (verified in the generator's
  // docstring against every current literal) — this is the assertion AGENTS.md's addenda calls
  // for: red only when a violation genuinely exists, never widened to accept one.
  it("has no OP_NAME_PATTERN violations in the checked-in catalog", () => {
    const checkedIn = readCheckedInCatalog();
    expect(checkedIn.violations).toEqual([]);
  });

  it("carries the schema and generator identity the catalog contract promises", () => {
    const checkedIn = readCheckedInCatalog();
    expect(checkedIn.$schema).toBe("keiko-op-catalog/1");
    expect(checkedIn.generatedBy).toBe("scripts/generate-op-catalog.mjs");
  });
});
