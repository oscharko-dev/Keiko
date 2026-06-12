// Scans every production source file under src/ (excluding __tests__ directories) and asserts
// NO denied node:* core-module import is present. Tests are allowed to use node:fs/node:path
// for fixture loading; production source must not (ADR-0023 D4: keiko-quality-intelligence is
// a pure-domain leaf — no IO, no network, no provider SDKs).
//
// CRITICAL false-positive trap: five production files contain the literal text `node:fs`
// inside purity comments (not in import specifiers):
//   src/ingestion/index.ts:4
//   src/ingestion/untrustedContentNormalisation.ts:5
//   src/ingestion/adfParser.ts:7
//   src/hardening/oversizeGuards.ts:9
//   src/export/index.ts:7
// The node:-prefixed entries are therefore matched via the quote-prefix includes form —
// `"node:fs` / `'node:fs` — which catches the quoted specifier in
// `import … from "node:fs"` but NOT a backtick or plain-prose mention.
//
// Bareword entries (`fs`, `http`, …) must NOT use the same quote-prefix form because
// string literals like `"network error"` contain `"net`, `"https://…"` contains `"http`,
// and `"process the file"` contains `"process`. Instead, barewords are matched by an
// anchored regex that requires a closing quote immediately after the module name — mirroring
// the style of packages/keiko-evidence/src/qualityIntelligence/__tests__/purityGuard.test.ts.
// All three real specifier syntaxes are covered: `from "fs"`, `require("fs")`, `import("fs")`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
// Expand scan root from src/domain/ to all of src/ so ingestion/, generation/, review/,
// export/, hardening/, and top-level src/*.ts are all guarded.
const SRC_ROOT = resolve(HERE, "..");

// node:-prefixed specifiers: the `node:` prefix is unambiguous — prose comments never say
// `from "node:fs"` — so the opening-quote prefix form is safe and avoids regex overhead.
const DENIED_SPECIFIER_PREFIXES: readonly string[] = [
  "node:fs",
  "node:fs/promises",
  "node:net",
  "node:http",
  "node:https",
  "node:tls",
  "node:dns",
  "node:child_process",
  "node:os",
  "node:process",
];

// Bareword module names that must also be absent. Closing-quote anchoring is mandatory:
// `"net` alone would match `"network error"`, `"http` would match `"https://…"`, etc.
// Each regex covers the three syntactic forms a TypeScript file can use to pull in a module:
//   • static import:  from "fs"
//   • CommonJS:       require("fs")
//   • dynamic import: import("fs")
const DENIED_BAREWORD_MODULES: readonly RegExp[] = [
  /from\s+["']fs["']/u,
  /from\s+["']fs\/promises["']/u,
  /from\s+["']http["']/u,
  /from\s+["']https["']/u,
  /from\s+["']net["']/u,
  /from\s+["']tls["']/u,
  /from\s+["']dns["']/u,
  /from\s+["']child_process["']/u,
  /from\s+["']os["']/u,
  /from\s+["']process["']/u,
  /require\(["']fs["']\)/u,
  /require\(["']fs\/promises["']\)/u,
  /require\(["']http["']\)/u,
  /require\(["']https["']\)/u,
  /require\(["']net["']\)/u,
  /require\(["']tls["']\)/u,
  /require\(["']dns["']\)/u,
  /require\(["']child_process["']\)/u,
  /require\(["']os["']\)/u,
  /require\(["']process["']\)/u,
  /import\(["']fs["']\)/u,
  /import\(["']fs\/promises["']\)/u,
  /import\(["']http["']\)/u,
  /import\(["']https["']\)/u,
  /import\(["']net["']\)/u,
  /import\(["']tls["']\)/u,
  /import\(["']dns["']\)/u,
  /import\(["']child_process["']\)/u,
  /import\(["']os["']\)/u,
  /import\(["']process["']\)/u,
];

// Recursively collects all production .ts files under `directory`, excluding any subdirectory
// named `__tests__` so test helpers do not pollute the purity scan.
const collectProductionFiles = (directory: string): readonly string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = resolve(directory, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      if (entry === "__tests__") {
        // Skip all nested test directories: src/__tests__/, src/export/__tests__/,
        // src/hardening/__tests__/, src/ingestion/__tests__/, src/review/__tests__/.
        continue;
      }
      for (const nested of collectProductionFiles(absolute)) {
        out.push(nested);
      }
      continue;
    }
    if (!absolute.endsWith(".ts")) {
      continue;
    }
    if (absolute.endsWith(".test.ts")) {
      continue;
    }
    out.push(absolute);
  }
  return out;
};

// Checks a single source text for all denied specifier forms. Returns one violation string
// per match so the caller can aggregate across files.
const checkSource = (label: string, text: string): readonly string[] => {
  const violations: string[] = [];
  for (const prefix of DENIED_SPECIFIER_PREFIXES) {
    if (text.includes(`"${prefix}`) || text.includes(`'${prefix}`)) {
      violations.push(`${label} imports denied specifier "${prefix}"`);
    }
  }
  for (const pattern of DENIED_BAREWORD_MODULES) {
    if (pattern.test(text)) {
      violations.push(`${label} imports denied bareword module (${pattern.source})`);
    }
  }
  return violations;
};

describe("domain purity guard (expanded to all of src/)", () => {
  it("contains no denied node:* core-module import specifier in any production source file", () => {
    const files = collectProductionFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const v of checkSource(file, text)) {
        violations.push(v);
      }
    }
    expect(violations).toEqual([]);
  });

  it("bareword matcher does NOT fire on prose/string literals that share a prefix with a module name", () => {
    // Regression guard: proves the over-match landmine from the previous quote-prefix-only
    // approach is gone. These strings appeared in real production code patterns and must
    // produce zero violations.
    const proseLiterals = [
      `const msg = "network error occurred";`,
      `const url = "https://example.com/api";`,
      `const desc = "process the queue";`,
      `const pkg = "oscharko-dev";`,
      `const x = "https://other.host";`,
      `throw new Error("http request failed");`,
    ].join("\n");
    const violations = checkSource("<prose-literals>", proseLiterals);
    expect(violations).toEqual([]);
  });

  it("bareword matcher DOES fire on actual module-specifier syntax", () => {
    // Confirms true-positive detection is intact after the fix. One line per syntax form.
    // Each assertion uses a dedicated checkSource call so a missing detection fails precisely.
    const staticImport = `import { readFileSync } from "node:fs";`;
    const barewordImport = `import http from "http";`;
    const requireCall = `const cp = require("child_process");`;
    const dynamicImport = `const mod = await import("fs/promises");`;

    expect(checkSource("<static-node>", staticImport).length).toBeGreaterThan(0);
    expect(checkSource("<bareword-http>", barewordImport).length).toBeGreaterThan(0);
    expect(checkSource("<require-cp>", requireCall).length).toBeGreaterThan(0);
    expect(checkSource("<dynamic-fs>", dynamicImport).length).toBeGreaterThan(0);
  });
});
