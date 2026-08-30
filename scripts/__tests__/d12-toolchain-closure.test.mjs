// The digest must cover what it claims to cover: every tests/e2e module a D12 measuring file
// actually imports.
//
// It did not. `editor-performance.spec.ts` and `editor-debugging-2348.spec.ts` both import
// `support/editor-chord.ts` (the select-all chord itself), and the latter also imports
// `support/debugSessionStartCapture.ts` — neither was a member, so either could have changed a
// measured action while `measurementHarnessSha256` stayed put, which is the exact blindness the
// digest exists to prevent (PR #3355 review, P1).
//
// This derives the requirement from the import graph rather than restating the list, so the next
// helper a measuring spec reaches for is caught the day it is added instead of the day someone
// re-reads the list. Deliberately NOT in the digest itself (scripts/__tests__/ is excluded), so the
// guard can be maintained without forcing a reference-container re-measurement.
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { D12_MEASUREMENT_TOOLCHAIN_PATHS } from "../d12-measurement-toolchain.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const members = new Set(D12_MEASUREMENT_TOOLCHAIN_PATHS);

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

// Parsed, not grepped. `editor-performance.spec.ts` GENERATES fixture sources inside template
// literals, and those contain their own `import … from "./${name}.js"` lines: a text search — even
// one anchored to the start of a line — reads them as imports of the spec itself and reports three
// unresolvable specifiers that do not exist. The AST distinguishes a real module-level import from
// a string that merely looks like one, which no regex over this file can.
function relativeImportsOf(repoPath) {
  const source = readFileSync(join(repoRoot, repoPath), "utf8");
  const sourceFile = ts.createSourceFile(repoPath, source, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    if (specifier.text.startsWith(".")) specifiers.push(specifier.text);
  }
  return specifiers;
}

// Every tests/e2e file reachable from the D12 members, following relative imports.
function reachableFromMembers() {
  const seen = new Set();
  const unresolved = [];
  const queue = D12_MEASUREMENT_TOOLCHAIN_PATHS.filter(
    (path) => path.startsWith("tests/e2e/") && /\.(ts|mjs|js)$/u.test(path),
  );
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const specifier of relativeImportsOf(current)) {
      const resolved = resolveImport(current, specifier);
      // An import this walker cannot resolve is REPORTED, never skipped: skipping it would silently
      // remove the very coverage this file asserts.
      if (resolved === undefined) {
        unresolved.push(`${current} -> ${specifier}`);
        continue;
      }
      if (resolved.startsWith("tests/e2e/")) queue.push(resolved);
    }
  }
  return { reachable: seen, unresolved };
}

describe("the D12 digest covers every tests/e2e module its measuring files import", () => {
  const { reachable, unresolved } = reachableFromMembers();

  it("resolves every relative import it walked", () => {
    expect(unresolved).toEqual([]);
  });

  it("lists every reachable tests/e2e module as a digest member", () => {
    const missing = [...reachable].filter((path) => !members.has(path)).sort();
    expect(
      missing,
      "These shape a measured action but are not hashed into measurementHarnessSha256, so a change " +
        "to them would move the numbers without invalidating the evidence. Add them to " +
        "D12_MEASUREMENT_TOOLCHAIN_PATHS and regenerate in the reference container.",
    ).toEqual([]);
  });

  // Without this the assertion above would keep passing if the walker stopped following imports.
  it("actually walked the import graph", () => {
    expect(reachable.size).toBeGreaterThanOrEqual(6);
    for (const path of [
      "tests/e2e/editor-performance.spec.ts",
      "tests/e2e/editor-debugging-2348.spec.ts",
      "tests/e2e/support/editor-chord.ts",
      "tests/e2e/support/editorWorkspace.ts",
      "tests/e2e/support/debugSessionStartCapture.ts",
      "tests/e2e/support/dapOperatorProvisioning.ts",
    ]) {
      expect([...reachable]).toContain(path);
    }
  });

  // `window-chrome.ts` was named by the same review as a missing member. It is NOT added, and this
  // pins why rather than leaving the omission to look like an oversight: nothing in the D12 set
  // imports it (its consumers are release-smoke, editor-fidelity-1295, editor-formatting-1380 and
  // the shared playwright.config), so it cannot shape a measured number — and adding it would force
  // a 35-minute reference-container re-measurement for every edit that provably cannot move one.
  it("does not pull in a helper no measuring file imports", () => {
    expect([...reachable]).not.toContain("tests/e2e/support/window-chrome.ts");
    expect(members.has("tests/e2e/support/window-chrome.ts")).toBe(false);
  });
});
