// Asserts the package never references @oscharko-dev/test-intelligence or
// @oscharko-dev/ti-* in any source file under src/ (production OR tests). The
// supply-chain gate at scripts/check-quality-intelligence-supply-chain.mjs
// covers manifests; this guard adds an in-tree code-side defence so a future
// agent cannot accidentally re-introduce the dependency in a test stub.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, "..");

// Match an import/export/require statement whose module specifier references
// the forbidden namespaces. JSDoc/header citations are deliberately allowed —
// they document the structural inspiration without taking a code-side dep.
const FORBIDDEN_IMPORT_PATTERNS: readonly RegExp[] = [
  /\bfrom\s+["']@oscharko-dev\/test-intelligence(?:[/"'])/u,
  /\bfrom\s+["']@oscharko-dev\/ti-/u,
  /\brequire\(\s*["']@oscharko-dev\/test-intelligence(?:[/"'])/u,
  /\brequire\(\s*["']@oscharko-dev\/ti-/u,
  /\bimport\(\s*["']@oscharko-dev\/test-intelligence(?:[/"'])/u,
  /\bimport\(\s*["']@oscharko-dev\/ti-/u,
];

const collectSourceFiles = (directory: string): readonly string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = resolve(directory, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      for (const nested of collectSourceFiles(absolute)) {
        out.push(nested);
      }
      continue;
    }
    if (!(absolute.endsWith(".ts") || absolute.endsWith(".mts"))) {
      continue;
    }
    out.push(absolute);
  }
  return out;
};

describe("independence guard", () => {
  it("contains no @oscharko-dev/test-intelligence or @oscharko-dev/ti-* IMPORT anywhere under src/", () => {
    const files = collectSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      if (file === fileURLToPath(import.meta.url)) {
        // Skip self — this file contains the forbidden patterns as regex literals.
        continue;
      }
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
