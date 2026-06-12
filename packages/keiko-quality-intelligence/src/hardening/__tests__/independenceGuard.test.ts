// Independence guard scoped to the hardening sub-namespace (Issue #284).
//
// The package-wide guard at `src/__tests__/independenceGuard.test.ts` covers
// every src file. This additional scoped guard documents the rule explicitly
// for the new sub-namespace so a future agent cannot weaken it via a forgotten
// stub import within `src/hardening/**`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARDENING_ROOT = resolve(HERE, "..");

const FORBIDDEN_IMPORT_PATTERNS: readonly RegExp[] = [
  /\bfrom\s+["']@oscharko-dev\/test-intelligence(?:[/"'])/u,
  /\bfrom\s+["']@oscharko-dev\/ti-/u,
  /\brequire\(\s*["']@oscharko-dev\/test-intelligence(?:[/"'])/u,
  /\brequire\(\s*["']@oscharko-dev\/ti-/u,
  /\bimport\(\s*["']@oscharko-dev\/test-intelligence(?:[/"'])/u,
  /\bimport\(\s*["']@oscharko-dev\/ti-/u,
  // Bare side-effect imports: `import "@oscharko-dev/ti-foo";` — no `from`, no parens.
  /^\s*import\s+["']@oscharko-dev\/test-intelligence(?:[/"'])/mu,
  /^\s*import\s+["']@oscharko-dev\/ti-/mu,
  // Dynamic-evasion form: a dynamic import or require whose specifier is a template literal that
  // interpolates a variable right after the @oscharko-dev/ scope, so the forbidden package name
  // never appears as a contiguous literal. The negated character class keeps the match inside the
  // package-name segment, so dynamic subpaths of statically-named packages stay allowed.
  /\b(?:import|require)\s*\(\s*`[^`]*@oscharko-dev\/[^`/]*\$\{/u,
];

const collectFiles = (directory: string): readonly string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = resolve(directory, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      for (const nested of collectFiles(absolute)) {
        out.push(nested);
      }
      continue;
    }
    if (!(absolute.endsWith(".ts") || absolute.endsWith(".mts"))) continue;
    out.push(absolute);
  }
  return out;
};

describe("hardening independence guard", () => {
  it("contains no @oscharko-dev/test-intelligence or @oscharko-dev/ti-* import under src/hardening/", () => {
    const files = collectFiles(HARDENING_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      if (file === fileURLToPath(import.meta.url)) continue;
      const text = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
        if (pattern.test(text)) {
          violations.push(`${file} matched ${pattern.toString()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
