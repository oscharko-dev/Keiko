import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateOpCatalog } from "../generate-op-catalog.mjs";
import {
  TOOL_CATALOG_OPERATIONS_PATH,
  generateToolCatalogOperations,
  toolCatalogOperationsBytes,
} from "../lib/tool-catalog-operations.mjs";

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
  it("pins the separate future lifecycle contract without inventing runtime source sites", async () => {
    const catalog = generateOpCatalog(repoRoot);
    const bytes = readFileSync(join(repoRoot, TOOL_CATALOG_OPERATIONS_PATH), "utf8");
    expect(catalog.operationContracts).toEqual([TOOL_CATALOG_OPERATIONS_PATH]);
    expect(bytes).toBe(await toolCatalogOperationsBytes(repoRoot));
    expect(JSON.parse(bytes)).toEqual(generateToolCatalogOperations(repoRoot));
  });
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

  // PR #3394 regression: a stale regeneration dropped these 26 still-emitted operations while
  // leaving the catalog internally self-consistent. Pin the incident's complete vocabulary at the
  // production generator boundary so regenerating the JSON cannot silently bless the same loss.
  it("retains every operation lost by the issue-to-PR catalog regression", () => {
    const catalog = generateOpCatalog(repoRoot);
    expect(catalog.operations).toEqual(
      expect.arrayContaining([
        "coding-runtime.description",
        "coding-runtime.operation.refused",
        "coding-runtime.run.recovery-acknowledged",
        "coding-sidecar.gateway.readiness-insufficient",
        "coding-sidecar.gateway.rejected",
        "coding-sidecar.tool-facade.rejected",
        "editor.producer-turn.completed",
        "gateway.tool-catalog.native-passthrough",
        "git-change.chat.apply",
        "git-change.chat.blocked",
        "git-change.chat.connected",
        "git-change.chat.refreshed",
        "git-change.chat.stale",
        "git.delivery.commit.approval.minted",
        "git.delivery.commit.approval.required",
        "git.delivery.pr.approval.minted",
        "git.delivery.pr.approval.required",
        "git.delivery.push.approval.minted",
        "git.delivery.push.approval.required",
        "git.journey-outcome.recorded",
        "pr-description.chat.turn.admitted",
        "pr-description.chat.turn.denied",
        "pr-description.model-egress.denied",
        "pr-description.workbench.egress.denied",
        "runtime.confinement.unavailable",
        "tool-catalog.dispatch-unbound",
      ]),
    );
  });

  // #2902 W5: orchestrator.ts's logIndexing/logEmbeddingRun/logDocument hardcode `category` inside
  // their OWN body rather than the caller's object literal, so tier 1 (findSiblingCategory) never
  // finds a sibling `category:` at these call sites, and tier 3 (fileCategoryBinding) backs off
  // because the file binds two distinct categories. Before OBJECT_ARG_CATEGORY_FUNCTIONS, both ops
  // below resolved to "unknown" even though the runtime always stamps a deterministic category for
  // them. Driven through the real generator entry point, not a re-derivation of its category rules.
  it("attributes the deterministic category to an op:-only call site of a checked-in object-arg category function", () => {
    const catalog = generateOpCatalog(repoRoot);
    const byOp = (op) => catalog.entries.find((entry) => entry.op === op);
    expect(byOp("indexing.document.failed")?.category).toBe("indexing");
    expect(byOp("embedding.preflight.identity-rejected")?.category).toBe("embedding");
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
  // Covers both new `isTypeAnnotationValue` branches this change added — a bare PascalCase type
  // reference (`OpName`) and a quoted string-literal union (`"pull" | "put"`) — neither of which
  // the pre-existing `op: string;`/`op: () => Promise<void>` cases below exercise. Both new
  // members deliberately end WITHOUT a `;`, closing over their interface's own `}` instead: a
  // `;`- or `)`-terminated member is already skipped by `closesOverDeclaration` regardless of
  // `isTypeAnnotationValue`, so ending on `;`/`)` would let either new branch be silently deleted
  // without ever failing this test.
  it("skips op type declarations without emitting a dynamic entry", () => {
    withFixturePackage(
      "zzz-fixture-type-declarations",
      [
        "interface FixtureEvent {",
        "  readonly op: string;",
        "}",
        "",
        "interface FixtureTypedEvent {",
        "  readonly op: OpName",
        "}",
        "",
        "interface FixtureUnionEvent {",
        '  readonly op: "pull" | "put"',
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

  // Regression: before this fix, `isTypeAnnotationValue`'s parenthesis branch matched ANY value
  // starting with `(`, so a parenthesized RUNTIME value (not a function type) was skipped like a
  // type annotation — no entry at all, not even `<dynamic>`. Requiring a top-level `=>` after the
  // MATCHING close paren (found by depth, not a regex) narrows the branch to actual function
  // types, so a parenthesized runtime expression now falls through to `resolveLiteralValues`
  // (which cannot enumerate a ternary whose match is broken by the trailing `)`) and reports
  // `<dynamic>` instead of silently vanishing from the catalog.
  it("reports a parenthesized runtime value as dynamic instead of dropping it as a type", () => {
    withFixturePackage(
      "zzz-fixture-parenthesized-runtime-value",
      [
        "export function fixtureRuntimeParen(flag) {",
        '  return { category: "custom", op: (flag ? "a" : "b") };',
        "}",
        "",
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        const fixtureEntries = catalog.entries.filter((entry) => entry.site.includes("fixture.ts"));
        expect(fixtureEntries.map((entry) => entry.op)).toEqual(["<dynamic>"]);
      },
    );
  });

  // Regression (#2902 PR review, round 3): before this fix, `isTypeAnnotationValue`'s
  // parenthesized-function-type check looked only at the value's own content (does it start with
  // `(` and have a top-level `=>` after the matching close paren?), never at WHERE its value span
  // actually stopped. A runtime arrow function assigned as an object-literal property — the exact
  // shape CodeRabbit's finding cited, `op: (value) => value,` — is structurally identical to a
  // function-type annotation past the opening paren, and was misclassified as a type: the site was
  // dropped entirely, not even recorded `<dynamic>`. The fix defers the parenthesized-function-type
  // case entirely to `closesOverDeclaration`'s `stopChar` check (already run first in
  // `opPropertyEntries`), so a real declaration (`;` or the enclosing `)`) is still skipped, while
  // an object-literal property — which always stops at `,` or `}` — now falls through to
  // `resolveLiteralValues` and reports `<dynamic>` instead of vanishing.
  it("reports a runtime arrow-function op value as dynamic instead of dropping it as a type", () => {
    withFixturePackage(
      "zzz-fixture-runtime-arrow-value",
      [
        "export function fixtureRuntimeArrow(value) {",
        "  return {",
        '    category: "custom",',
        "    op: (value) => value,",
        "  };",
        "}",
        "",
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        const fixtureEntries = catalog.entries.filter((entry) => entry.site.includes("fixture.ts"));
        expect(fixtureEntries).toHaveLength(1);
        expect(fixtureEntries[0]?.op).toBe("<dynamic>");
        expect(fixtureEntries[0]?.category).toBe("custom");
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

describe("approved diagnostic operation source extraction", () => {
  it("captures literal operations through the diagnostic builder and emitter", () => {
    withFixturePackage(
      "keiko-server",
      `
      emitServerDiagnostic(sink, {
        operation: "tool-catalog.invocation.failed",
        correlationId: "fixture", errorClass: "Error", message: "server-operation-failed",
      });
      const record = serverDiagnosticFromError({
        operation: "tool-catalog.bind.unavailable", error,
      });
      emitServerDiagnostic(sink, serverDiagnosticFromError({ operation: "fixture.nested", error }));
      defaultServerDiagnosticSink.record({ operation: "fixture.default", errorClass: "Error" });
    `,
      (root) => {
        const catalog = generateOpCatalog(root);
        const literals = catalog.entries.filter((entry) => entry.op !== "<dynamic>");
        expect(literals.map((entry) => entry.op)).toEqual([
          "fixture.default",
          "fixture.nested",
          "tool-catalog.bind.unavailable",
          "tool-catalog.invocation.failed",
        ]);
        expect(
          literals.every(
            (entry) =>
              entry.category === "diagnostic" && entry.sourceKind === "diagnostic-operation",
          ),
        ).toBe(true);
      },
    );
  });
  it("does not catalogue payload fields, nested fields, prose or unsupported wrappers as literal operations", () => {
    withFixturePackage(
      "keiko-server",
      `
      const data = { operation: "payload.operation" };
      unsupportedDiagnostic({ operation: "wrapper.operation" });
      object.emitServerDiagnostic(sink, { operation: "object.operation" });
      const prose = 'emitServerDiagnostic(sink, { operation: "prose.operation" })';
      emitServerDiagnostic(sink, { extra: { operation: "nested.payload" }, operation: runtimeOperation });
      emitServerDiagnostic(sink, wrap({ operation: "wrapped.operation" }));
    `,
      (root) => {
        const catalog = generateOpCatalog(root);
        expect(catalog.entries.every((entry) => entry.op === "<dynamic>")).toBe(true);
        expect(catalog.entries).toHaveLength(2);
      },
    );
  });
});

describe("diagnostic source completeness and false-positive boundaries", () => {
  it("does not resolve a constant from prose or conflicting lexical bindings", () => {
    withFixturePackage(
      "keiko-server",
      `
      const FROM_PROSE = runtime();
      const prose = 'const FROM_PROSE = "fixture.fabricated";';
      emitServerDiagnostic(sink, { operation: FROM_PROSE });
      if (flag) { const SHADOWED = "fixture.first"; emitServerDiagnostic(sink, { operation: SHADOWED }); }
      else { const SHADOWED = "fixture.second"; emitServerDiagnostic(sink, { operation: SHADOWED }); }
      const MIXED = "fixture.constant";
      function local() { const MIXED = runtime(); emitServerDiagnostic(sink, { operation: MIXED }); }
    `,
      (root) => {
        const catalog = generateOpCatalog(root);
        expect(catalog.entries).toHaveLength(4);
        expect(catalog.entries.every((entry) => entry.op === "<dynamic>")).toBe(true);
      },
    );
  });
});

describe("diagnostic operation projection rules", () => {
  it("keeps source sites while deduplicating the actual operation vocabulary", () => {
    withFixturePackage(
      "keiko-server",
      `
      const FAILURE_OP = "fixture.repeat";
      emitServerDiagnostic(sink, { operation: FAILURE_OP });
      emitServerDiagnostic(sink, { operation: "fixture.repeat" });
      emitServerDiagnostic(sink, { operation: flag ? "fixture.same" : "fixture.same" });
    `,
      (root) => {
        const catalog = generateOpCatalog(root);
        expect(catalog.operations).toEqual(["fixture.repeat", "fixture.same"]);
        expect(catalog.entries.filter((entry) => entry.op === "fixture.repeat")).toHaveLength(2);
        expect(new Set(catalog.entries.map((entry) => entry.site)).size).toBe(3);
        expect(catalog.entries.filter((entry) => entry.op === "fixture.same")).toHaveLength(1);
      },
    );
  });
  it("keeps concatenation, templates and overwritable fields dynamic", () => {
    withFixturePackage(
      "keiko-server",
      [
        'emitServerDiagnostic(sink, { operation: "fixture." + suffix });',
        "emitServerDiagnostic(sink, { operation: `fixture.${suffix}` });",
        'emitServerDiagnostic(sink, { operation: "fixture.before-spread", ...input });',
        'emitServerDiagnostic(sink, { operation: "fixture.before-key", [key]: value });',
        'emitServerDiagnostic(sink, { operation: "fixture.before-getter", get operation() { return value; } });',
        'emitServerDiagnostic(sink, { ...input, operation: "fixture.after-spread" });',
        'serverDiagnosticFromError(({ operation: "fixture.wrapped" }));',
        'emitServerDiagnostic(sink, { extra: { operation: "nested.payload" }, operation: "fixture.outer" });',
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        expect(catalog.operations).toEqual(["fixture.after-spread", "fixture.outer"]);
        expect(catalog.entries.filter((entry) => entry.op === "<dynamic>")).toHaveLength(6);
      },
    );
  });
  it("retains approved diagnostic spelling without relaxing activity-op validation", () => {
    withFixturePackage(
      "keiko-server",
      `
      emitServerDiagnostic(sink, { operation: "figma.snapshotBuild" });
      serverDiagnosticFromError({ operation: "POST /api/gateway/setup" });
      emitServerDiagnostic(sink, { operation: "invalid@operation" });
      log.write({ category: "diagnostic", op: "figma.snapshotBuild" });
    `,
      (root) => {
        const catalog = generateOpCatalog(root);
        expect(catalog.violations.map((entry) => entry.op)).toEqual([
          "figma.snapshotBuild",
          "invalid@operation",
        ]);
        expect(
          catalog.entries.find((entry) => entry.op === "POST /api/gateway/setup")?.sourceKind,
        ).toBe("diagnostic-operation");
      },
    );
  });
  it("includes the three current direct-sink owners and ignores unrelated record methods", () => {
    const catalog = generateOpCatalog(repoRoot);
    for (const operation of [
      "grounded.entailment",
      "coding-runtime.sse-fanout",
      "coding-app-session.channel.subscribe",
    ])
      expect(
        catalog.entries.some(
          (entry) => entry.op === operation && entry.sourceKind === "diagnostic-operation",
        ),
      ).toBe(true);
    withFixturePackage(
      "keiko-server",
      'diagnostics.record({operation: "unapproved.record"}); sink.record({operation: "unapproved.sink"});',
      (root) => {
        expect(generateOpCatalog(root).entries).toEqual([]);
      },
    );
  });
  it("proves closed spread keys without guessing runtime or overriding keys", () => {
    withFixturePackage(
      "keiko-server",
      [
        'emitServerDiagnostic(sink, { operation: "fixture.closed", ...(code === undefined ? {} : { code }) });',
        'emitServerDiagnostic(sink, { operation: "fixture.object", ...{ code, source: nested() } });',
        'emitServerDiagnostic(sink, { operation: "fixture.overridden", ...(flag ? {} : { operation }) });',
        'emitServerDiagnostic(sink, { operation: "fixture.computed", ...(flag ? {} : { [key]: value }) });',
        'emitServerDiagnostic(sink, { operation: "fixture.spread", ...(flag ? {} : { ...input }) });',
        'emitServerDiagnostic(sink, { operation: "fixture.shorthand", operation });',
        'emitServerDiagnostic(sink, { operation: "fixture.method", operation() { return value; } });',
        'emitServerDiagnostic(sink, { operation: "fixture.getter", get "operation"() { return value; } });',
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        expect(catalog.operations).toEqual(["fixture.closed", "fixture.object"]);
        expect(catalog.entries.filter((entry) => entry.op === "<dynamic>")).toHaveLength(6);
      },
    );
  });
  it("rejects a generated vocabulary or source-kind tamper", () => {
    const generated = generateOpCatalog(repoRoot);
    const removed = structuredClone(generated);
    removed.operations.pop();
    expect(removed).not.toEqual(generated);
    const provenance = structuredClone(generated);
    const diagnostic = provenance.entries.find(
      (entry) => entry.sourceKind === "diagnostic-operation",
    );
    expect(diagnostic).toBeDefined();
    delete diagnostic.sourceKind;
    expect(provenance).not.toEqual(generated);
  });
});
