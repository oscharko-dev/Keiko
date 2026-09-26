// The digest must cover what it claims to cover: every scripts/ or tests/e2e module a D12 producer,
// checker, config, or measuring spec actually imports, plus repository data those entrypoints read.
//
// It did not. `editor-performance.spec.ts` and `editor-debugging-2348.spec.ts` both import
// `support/editor-chord.ts` (the select-all chord itself), and the latter also imports
// `support/debugSessionStartCapture.ts` — neither was a member, so either could have changed a
// measured action while `measurementHarnessSha256` stayed put, which is the exact blindness the
// digest exists to prevent (PR #3355 review, P1).
//
// The producer side matters just as much: `run-d12-perf-comparison.mjs` and three other bound scripts
// select host executables through `scripts/lib/host-executable.mjs`. Leaving that resolver outside
// the digest lets a change move the runtime that produces evidence without moving the evidence's
// measurementHarnessSha256 binding.
//
// This derives the requirement from the import graph rather than restating the list, so the next
// helper a measuring spec OR producer reaches for is caught the day it is added instead of the day
// someone re-reads the list. Deliberately NOT in the digest itself (scripts/__tests__/ is excluded),
// so the guard can be maintained without forcing a reference-container re-measurement.
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { D12_MEASUREMENT_TOOLCHAIN_PATHS } from "../d12-measurement-toolchain.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const members = new Set(D12_MEASUREMENT_TOOLCHAIN_PATHS);

function isClosureRoot(path) {
  const scriptProducer = /^scripts\/(?!lib\/).+\.mjs$/u.test(path);
  const e2eConfig = /^tests\/e2e\/config\/playwright\..+\.config\.ts$/u.test(path);
  const measuringSpec = /^tests\/e2e\/[^/]+\.spec\.ts$/u.test(path);
  return scriptProducer || e2eConfig || measuringSpec;
}

const closureRoots = Object.freeze(D12_MEASUREMENT_TOOLCHAIN_PATHS.filter(isClosureRoot));

function toRepoPath(absolute) {
  return relative(repoRoot, absolute).split("\\").join("/");
}

// The specs import compiled specifiers (`./support/editor-chord.js`) that resolve to the `.ts`
// source; a `.js` on disk is used as-is so this keeps working if a helper is ever plain JavaScript.
function resolveImport(fromRepoPath, specifier) {
  const candidate = join(repoRoot, dirname(fromRepoPath), specifier);
  for (const path of [candidate.replace(/\.js$/u, ".ts"), candidate]) {
    try {
      readFileSync(path, "utf8");
      return toRepoPath(path);
    } catch {
      // Try the next spelling; an unresolvable specifier is reported by the caller, never skipped.
    }
  }
  return undefined;
}

function staticNewUrlSpecifier(expression) {
  if (
    !ts.isPropertyAccessExpression(expression) ||
    expression.name.text !== "href" ||
    !ts.isNewExpression(expression.expression) ||
    !ts.isIdentifier(expression.expression.expression) ||
    expression.expression.expression.text !== "URL"
  ) {
    return undefined;
  }
  return expression.expression.arguments?.[0];
}

function dynamicImportSpecifier(call) {
  const argument = call.arguments[0];
  if (argument === undefined) return undefined;
  return staticNewUrlSpecifier(argument) ?? argument;
}

function isImportMetaUrl(expression) {
  return (
    expression !== undefined &&
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "url" &&
    ts.isMetaProperty(expression.expression) &&
    expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

// Data files are closure edges too. This is the production spelling used by
// editor-release-evidence.mjs for its authoritative budget JSON; parsing the call keeps the pin
// coupled to the real read instead of restating a path-to-script map in the test.
function relativeReadFileDataSpecifier(call) {
  if (
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== "readFileSync" ||
    !ts.isNewExpression(call.arguments[0]) ||
    !ts.isIdentifier(call.arguments[0].expression) ||
    call.arguments[0].expression.text !== "URL"
  ) {
    return undefined;
  }
  const [specifier, base] = call.arguments[0].arguments ?? [];
  return isImportMetaUrl(base) ? specifier : undefined;
}

// Parsed, not grepped. `editor-performance.spec.ts` GENERATES fixture sources inside template
// literals, and those contain their own `import … from "./${name}.js"` lines: a text search — even
// one anchored to the start of a line — reads them as imports of the spec itself and reports three
// unresolvable specifiers that do not exist. The AST distinguishes real static and nested dynamic
// imports from a string that merely looks like one, which no regex over this file can.
function relativeImportSpecifiersOf(sourceFile) {
  const specifiers = [];
  const record = (specifier) => {
    if (
      specifier !== undefined &&
      ts.isStringLiteralLike(specifier) &&
      specifier.text.startsWith(".")
    ) {
      specifiers.push(specifier.text);
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      record(dynamicImportSpecifier(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function relativeDataSpecifiersOf(sourceFile) {
  const specifiers = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const specifier = relativeReadFileDataSpecifier(node);
      if (
        specifier !== undefined &&
        ts.isStringLiteralLike(specifier) &&
        specifier.text.startsWith(".")
      ) {
        specifiers.push(specifier.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function relativeDependenciesOf(repoPath) {
  const source = readFileSync(join(repoRoot, repoPath), "utf8");
  const sourceFile = ts.createSourceFile(repoPath, source, ts.ScriptTarget.Latest, true);
  return {
    data: relativeDataSpecifiersOf(sourceFile),
    imports: relativeImportSpecifiersOf(sourceFile),
  };
}

function belongsToUnhashedSourceDomain(path) {
  return path.startsWith("scripts/") || path.startsWith("tests/e2e/");
}

// Every source file reachable from the actual D12 producer/config/spec entrypoints, following local
// imports. Library and support files are deliberately NOT initial queue members:
// `discoveredViaImport` would be vacuous if the digest list itself pre-seeded every helper this test
// is meant to discover. Product sources are covered by sourceTreeSha256; this closure owns the two
// source domains that digest deliberately excludes.
function reachableFromClosureRoots() {
  const seen = new Set();
  const discoveredViaData = new Set();
  const discoveredViaImport = new Set();
  const unresolved = [];
  const queue = [...closureRoots];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const dependencies = relativeDependenciesOf(current);
    for (const [kind, specifiers] of Object.entries(dependencies)) {
      for (const specifier of specifiers) {
        const resolved = resolveImport(current, specifier);
        // An import this walker cannot resolve is REPORTED, never skipped: skipping it would silently
        // remove the very coverage this file asserts.
        if (resolved === undefined) {
          unresolved.push(`${current} -> ${kind}:${specifier}`);
          continue;
        }
        if (belongsToUnhashedSourceDomain(resolved)) {
          if (kind === "data") discoveredViaData.add(resolved);
          else discoveredViaImport.add(resolved);
          queue.push(resolved);
        }
      }
    }
  }
  return { reachable: seen, discoveredViaData, discoveredViaImport, unresolved };
}

function missingToolchainMembers(paths, boundMembers = members) {
  return [...paths].filter((path) => !boundMembers.has(path)).sort();
}

describe("the D12 digest covers every local module its producers and measuring files import", () => {
  const { reachable, discoveredViaData, discoveredViaImport, unresolved } =
    reachableFromClosureRoots();

  it("walks nested dynamic imports as well as static imports and exports", () => {
    const sourceFile = ts.createSourceFile(
      "dynamic-import-fixture.ts",
      [
        'import "./static.js";',
        'export { value } from "./reexport.js";',
        "async function load(flag, computed) {",
        '  if (flag) await import("./nested.js");',
        "  await import(`./template.js`);",
        '  await import(new URL("./url-relative.js", import.meta.url).href);',
        "  await import(computed);",
        "}",
        "const generated = 'import(\"./not-an-edge.js\")';",
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
    );
    expect(relativeImportSpecifiersOf(sourceFile).sort()).toEqual([
      "./nested.js",
      "./reexport.js",
      "./static.js",
      "./template.js",
      "./url-relative.js",
    ]);
  });

  it("parses a repository data read without treating an unrelated URL as a closure edge", () => {
    const sourceFile = ts.createSourceFile(
      "data-read-fixture.mjs",
      [
        'const bound = readFileSync(new URL("./budget.json", import.meta.url), "utf8");',
        'const remote = new URL("./not-repository-data.json", "https://keiko.local");',
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
    );
    expect(relativeDataSpecifiersOf(sourceFile)).toEqual(["./budget.json"]);
  });

  it("resolves every relative import it walked", () => {
    expect(unresolved).toEqual([]);
  });

  it("lists every reachable local module as a digest member", () => {
    const missing = missingToolchainMembers(reachable);
    expect(
      missing,
      "These shape a measured action but are not hashed into measurementHarnessSha256, so a change " +
        "to them would move the numbers without invalidating the evidence. Add them to " +
        "D12_MEASUREMENT_TOOLCHAIN_PATHS and regenerate in the reference container.",
    ).toEqual([]);
  });

  it("reports a transitive producer dependency when its digest binding is removed", () => {
    const incompleteMembers = new Set(members);
    incompleteMembers.delete("scripts/lib/host-executable.mjs");
    expect(missingToolchainMembers(reachable, incompleteMembers)).toContain(
      "scripts/lib/host-executable.mjs",
    );
  });

  it("reports the production budget data dependency when its digest binding is removed", () => {
    const incompleteMembers = new Set(members);
    incompleteMembers.delete("scripts/editor-bundle-size.budget.json");
    expect(missingToolchainMembers(reachable, incompleteMembers)).toContain(
      "scripts/editor-bundle-size.budget.json",
    );
  });

  // These are not roots. Each can enter `discoveredViaImport` only through a parsed, resolved edge,
  // so disabling traversal makes this assertion fail even though every one remains a digest member.
  it("actually discovers support and script-library modules through the import graph", () => {
    for (const path of [
      "scripts/check-runtime-toolchain.mjs",
      "scripts/lib/compare-strings.mjs",
      "scripts/lib/git-changed-paths.mjs",
      "scripts/lib/host-executable.mjs",
      "scripts/lib/json.mjs",
      "tests/e2e/support/editor-chord.ts",
      "tests/e2e/support/editorWorkspace.ts",
      "tests/e2e/support/debugSessionStartCapture.ts",
      "tests/e2e/support/dapOperatorProvisioning.ts",
      "tests/e2e/support/window-chrome.ts",
    ]) {
      expect([...discoveredViaImport]).toContain(path);
    }
  });

  it("actually discovers the editor bundle budget through the production data read", () => {
    expect([...discoveredViaData]).toContain("scripts/editor-bundle-size.budget.json");
  });

  // Keep negative controls so a walker that indiscriminately includes every helper in either source
  // domain cannot satisfy the positive assertion.
  it("does not pull in helpers no producer or measuring file imports", () => {
    expect([...reachable]).not.toContain("scripts/lib/digest.mjs");
    expect(members.has("scripts/lib/digest.mjs")).toBe(false);
    expect([...reachable]).not.toContain("tests/e2e/support/axe.ts");
    expect(members.has("tests/e2e/support/axe.ts")).toBe(false);
  });
});
