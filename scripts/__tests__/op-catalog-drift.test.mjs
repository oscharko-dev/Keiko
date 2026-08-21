import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateOpCatalog } from "../generate-op-catalog.mjs";

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

// Builds a throwaway `<tmp>/packages/<pkgName>/src/fixture.ts` and runs `check(root)` against it,
// always cleaning up afterward. `generateOpCatalog` discovers package roots by listing `packages/*`
// under whatever root it is given (see `scannedPackageRoots`), so pointing it at a fixture root
// exercises the real production entry point end to end — no re-derivation of any of the
// generator's own extraction rules inside the test.
function withFixturePackage(pkgName, fileContents, check) {
  const root = mkdtempSync(join(tmpdir(), "op-catalog-fixture-"));
  try {
    const srcDir = join(root, "packages", pkgName, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "fixture.ts"), fileContents, "utf8");
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("op catalog drift", () => {
  it("matches the checked-in file exactly, by value, in the same order", () => {
    const regenerated = generateOpCatalog(repoRoot);
    const checkedIn = readCheckedInCatalog();
    expect(regenerated).toEqual(checkedIn);
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

  // Proves the drift gate actually fails closed: mutating a COPY of the checked-in catalog must
  // make it stop matching what the generator produces right now. Without this, a future change
  // that made `generateOpCatalog` just return the parsed checked-in file (or made the "matches the
  // checked-in file" comparison above lenient) could leave every other test in this file green.
  describe("rejects a tampered copy of the checked-in catalog", () => {
    it("when one entry's op value is changed", () => {
      const regenerated = generateOpCatalog(repoRoot);
      const tampered = structuredClone(readCheckedInCatalog());
      const first = tampered.entries[0];
      if (first === undefined) throw new Error("checked-in catalog has no entries to tamper with");
      tampered.entries[0] = { ...first, op: `${first.op}.tampered` };
      expect(regenerated).not.toEqual(tampered);
    });

    it("when one entry is removed", () => {
      const regenerated = generateOpCatalog(repoRoot);
      const tampered = structuredClone(readCheckedInCatalog());
      tampered.entries.pop();
      expect(regenerated).not.toEqual(tampered);
    });

    it("when two entries are reordered", () => {
      const regenerated = generateOpCatalog(repoRoot);
      const tampered = structuredClone(readCheckedInCatalog());
      const [first, second] = tampered.entries;
      if (first === undefined || second === undefined) {
        throw new Error("checked-in catalog needs at least two entries to reorder");
      }
      tampered.entries[0] = second;
      tampered.entries[1] = first;
      expect(regenerated).not.toEqual(tampered);
    });
  });

  // Pins the op-name vocabulary shape with fixed positive/negative examples, driven through the
  // real generator entry point rather than by re-applying OP_NAME_PATTERN to already-generated
  // entries (the previous version of this test: it turned red only when `regenerated.violations`
  // was non-empty, which the drift-equality and violations-empty tests above already detect) or by
  // importing OP_NAME_PATTERN into the test at all (AGENTS.md §7: a fixture must never restate a
  // formula the code under test owns — asserting the SAME regex against a STRING is exactly that).
  it("flags a malformed op name and accepts a well-formed one", () => {
    withFixturePackage(
      "zzz-fixture-vocabulary",
      [
        "export const events = [",
        '  { category: "custom", op: "gateway.chat.completed" },',
        '  { category: "custom", op: "Gateway.Chat" },',
        '  { category: "custom", op: "a.b.c.d.e.f.g" },',
        "];",
        "",
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        const violationOps = catalog.violations.map((violation) => violation.op);
        expect(violationOps).toContain("Gateway.Chat");
        expect(violationOps).toContain("a.b.c.d.e.f.g");
        expect(violationOps).not.toContain("gateway.chat.completed");
      },
    );
  });

  // A package root outside any hardcoded list must still be scanned — `SCANNED_PACKAGE_ROOTS` was
  // replaced by `scannedPackageRoots`, which lists `packages/*/src` directly, so a new instrumented
  // package is never invisible to the generator again.
  it("discovers instrumentation in a package outside any hardcoded root list", () => {
    withFixturePackage(
      "zzz-fixture-new-package",
      'export const events = [\n  { category: "custom", op: "fixture.new-package.discovered" },\n];\n',
      (root) => {
        const catalog = generateOpCatalog(root);
        const ops = catalog.entries.map((entry) => entry.op);
        expect(ops).toContain("fixture.new-package.discovered");
      },
    );
  });

  // A nested ternary must resolve to `<dynamic>`, never silently drop the first branch's literal.
  // `flag ? "a" : other ? "b" : "c"` used to match `TERNARY_OF_LITERALS`'s lazy prefix against the
  // SECOND `?`, returning `["b", "c"]` and dropping `"a"` without any `<dynamic>` marker at all.
  it("reports a nested ternary as dynamic instead of dropping its first branch", () => {
    withFixturePackage(
      "zzz-fixture-nested-ternary",
      [
        "const flag = true;",
        "const other = false;",
        "export const events = [",
        '  { category: "custom", op: flag ? "fixture.branch.a" : other ? "fixture.branch.b" : "fixture.branch.c" },',
        "];",
        "",
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        const fixtureEntries = catalog.entries.filter((entry) => entry.site.includes("fixture.ts"));
        const ops = fixtureEntries.map((entry) => entry.op);
        expect(ops).not.toContain("fixture.branch.a");
        expect(ops).not.toContain("fixture.branch.b");
        expect(ops).not.toContain("fixture.branch.c");
        expect(ops).toContain("<dynamic>");
      },
    );
  });

  // A commented-out `op:` must never become a catalog entry, and blanking a preceding comment must
  // not shift the LINE NUMBER of the real entry that follows it — the generator used to strip
  // comments only for the file-level category-binding tier, and its line-comment handling emitted
  // an extra newline per `//` comment, which would have shifted this site's line number by 3.
  it("ignores a commented-out op and keeps the real entry's line number exact", () => {
    withFixturePackage(
      "zzz-fixture-comments",
      [
        "// comment line 1",
        "// comment line 2",
        // Shaped exactly like the real false positive this fix removed from the checked-in
        // catalog: `server-logger.ts`'s header illustrates a call as a doc comment
        // (`// log.warn({ op: "indexing.job.skipped", ... });`), and a raw (unblanked) scan reads
        // the quoted literal right off that comment line as a real entry.
        '// log.warn({ op: "fixture.comment.op", extra: { reason } });',
        "export const events = [",
        '  { category: "custom", op: "fixture.real.op" },',
        "];",
        "",
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        const fixtureEntries = catalog.entries.filter((entry) => entry.site.includes("fixture.ts"));
        const ops = fixtureEntries.map((entry) => entry.op);
        expect(ops).not.toContain("fixture.comment.op");
        const real = fixtureEntries.find((entry) => entry.op === "fixture.real.op");
        expect(real?.site.endsWith(":5")).toBe(true);
      },
    );
  });

  // A type/interface/parameter declaration named `op` must be skipped entirely — no entry at all,
  // dynamic or otherwise — because it never carries a runtime value.
  it("skips op type declarations without emitting a dynamic entry", () => {
    withFixturePackage(
      "zzz-fixture-type-declarations",
      [
        "interface FixtureEvent {",
        "  readonly op: string;",
        "}",
        "",
        "function fixtureHelper(op: () => Promise<void>): void {",
        "  op().catch(() => {});",
        "}",
        "",
        "export const events = [",
        '  { category: "custom", op: "fixture.real.declaration-check" },',
        "];",
        "",
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        const fixtureEntries = catalog.entries.filter((entry) => entry.site.includes("fixture.ts"));
        expect(fixtureEntries).toHaveLength(1);
        expect(fixtureEntries[0]?.op).toBe("fixture.real.declaration-check");
      },
    );
  });

  // A positional-helper call whose argument the bracket scan cannot read (here: an unterminated
  // call reaching end of file) must surface as a `<dynamic>` entry, never vanish silently.
  // `gatewayEvent` is one of the unscoped `POSITIONAL_OP_HELPERS` entries, so it is recognized in
  // any file, fixture included.
  it("reports an unreadable helper-call argument as dynamic instead of dropping the site", () => {
    withFixturePackage(
      "zzz-fixture-unreadable-call",
      "export const trigger = gatewayEvent(\n",
      (root) => {
        const catalog = generateOpCatalog(root);
        const fixtureEntries = catalog.entries.filter((entry) => entry.site.includes("fixture.ts"));
        expect(fixtureEntries).toHaveLength(1);
        expect(fixtureEntries[0]?.op).toBe("<dynamic>");
        expect(fixtureEntries[0]?.category).toBe("gateway");
      },
    );
  });
});
