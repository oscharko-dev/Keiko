// Scans every production source file under src/domain/ and asserts NO denied
// node:* core-module import is present. Tests are allowed to use node:fs/node:path
// for fixture loading; production source must not.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOMAIN_ROOT = resolve(HERE, "..", "domain");

const DENIED_PATTERNS: readonly RegExp[] = [
  /["']node:fs["']/u,
  /["']node:fs\/promises["']/u,
  /["']node:net["']/u,
  /["']node:http["']/u,
  /["']node:https["']/u,
  /["']node:tls["']/u,
  /["']node:dns["']/u,
  /["']node:child_process["']/u,
  /["']node:os["']/u,
  /["']node:process["']/u,
  // Bareword form ("fs" without node: prefix).
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
];

const collectProductionFiles = (directory: string): readonly string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = resolve(directory, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
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

describe("domain purity guard", () => {
  it("contains no denied node:* core-module import in any production source file", () => {
    const files = collectProductionFiles(DOMAIN_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const pattern of DENIED_PATTERNS) {
        if (pattern.test(text)) {
          violations.push(`${file} matched ${pattern.toString()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
