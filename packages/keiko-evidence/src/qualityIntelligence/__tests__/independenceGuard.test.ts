// Independence guard for ADR-0023 D12. Every file under
// `packages/keiko-evidence/src/qualityIntelligence/` (production source + this directory itself)
// must be free of any reference to the standalone reference implementation's npm namespace —
// including in JSDoc / line comments where TypeScript would not catch the import. This is a
// belt-and-braces complement to the global `npm run check:qi-supply-chain` script: when this
// test fails locally, the developer sees the precise file and line BEFORE pushing.
//
// The forbidden substrings are built at runtime from disjoint fragments so this file itself
// never contains the literal substring (the supply-chain scanner skips `__tests__/` so this is
// belt-and-braces, but explicit construction also documents intent).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const QI_SRC_DIR = new URL("..", import.meta.url).pathname;

// Disjoint-fragment construction so the literal substrings never appear in this source file.
const NS_PREFIX = "@oscharko-dev/";
const FORBIDDEN_NAMESPACES: readonly string[] = [
  `${NS_PREFIX}test-intelligence`,
  `${NS_PREFIX}ti-`,
];

interface FileScanResult {
  readonly file: string;
  readonly lines: readonly { readonly lineNumber: number; readonly match: string }[];
}

async function listAllFiles(dir: string): Promise<readonly string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Recurse into __tests__ so this guard self-applies.
      for (const sub of await listAllFiles(join(dir, entry.name))) {
        out.push(sub);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.endsWith(".ts")) {
      continue;
    }
    out.push(join(dir, entry.name));
  }
  return out;
}

async function scanForNamespaces(file: string): Promise<FileScanResult> {
  const source = await readFile(file, "utf8");
  const lines = source.split("\n");
  const hits: { lineNumber: number; match: string }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const namespace of FORBIDDEN_NAMESPACES) {
      if (line.includes(namespace)) {
        hits.push({ lineNumber: i + 1, match: namespace });
      }
    }
  }
  return { file, lines: hits };
}

describe("independence guard for QI sub-module (ADR-0023 D12)", () => {
  it("no production or test file references the forbidden npm namespaces", async () => {
    const files = await listAllFiles(QI_SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    // Exclude THIS file from the scan: it intentionally constructs the namespaces at runtime to
    // document the trap, but the fragments would not match the `.includes` filter anyway. Filter
    // by basename so the absolute-path comparison stays portable across worktrees.
    const selfBasename = "independenceGuard.test.ts";
    const scanned = files.filter((f) => !f.endsWith(selfBasename));
    const results = await Promise.all(scanned.map((f) => scanForNamespaces(f)));
    const violations = results.filter((r) => r.lines.length > 0);
    if (violations.length > 0) {
      const summary = violations
        .map(
          (v) =>
            `${v.file}:\n` +
            v.lines.map((l) => `  line ${String(l.lineNumber)}: matches ${l.match}`).join("\n"),
        )
        .join("\n");
      throw new Error(`Forbidden namespace references found:\n${summary}`);
    }
    expect(violations).toEqual([]);
  });

  it("the supply-chain gate skips __tests__/ so this test file is allowed to construct the strings", () => {
    // Documents the trust boundary: the QI supply-chain script's IGNORED_DIRECTORIES set includes
    // `__tests__`. If that ever changes, this test file would need to refactor its
    // FORBIDDEN_NAMESPACES construction further. The fragment build above is the durable form.
    expect(FORBIDDEN_NAMESPACES.length).toBe(2);
    for (const ns of FORBIDDEN_NAMESPACES) {
      expect(ns.startsWith(NS_PREFIX)).toBe(true);
    }
  });
});
