// ADR-0152 D1 (Issue #2632): `isValidVectorIndexQuery` is the ONE precondition check on the
// port's query path. Every port implementation must run it and rely on it exclusively — a
// second implementation with its own guard would let a query pass one implementation but be
// refused by another, silently diverging what "valid" means. The rule has to be structural,
// not a one-time review pass, because a copy that drifts fails OPEN: a query the canonical
// guard rejects would still be answered.
//
// The check here is a source-scan for `VectorIndexPort` implementations: every production
// `search(query: VectorIndexQuery)` implementation must reference `isValidVectorIndexQuery`
// in its module. That is not "the query hit it at runtime" — a stronger check would require
// coverage or symbolic tracing — but it is sufficient to prevent an implementation from
// silently shipping without the guard at all, and it fits the same lightweight guarantee as
// `identity-key-single-owner.test.ts`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCANNED_ROOTS = ["packages", "src"];
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "out",
  ".next",
  "coverage",
  "__tests__",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".js"]);

// The contract-defining file is exempt: it exports the interface and the guard together.
// It is not itself a `VectorIndexPort` implementation.
const CONTRACT_FILE = "packages/keiko-contracts/src/vector-index-port.ts";

// The signature we look for is the exact method-definition head a class or object literal
// spelling of the port's `search` field must use. TypeScript arrow forms
// (`search: (query: VectorIndexQuery) => ...`) also match through the fallback pattern.
const SEARCH_METHOD_PATTERN = /search\s*\([^)]*VectorIndexQuery[^)]*\)/u;
const SEARCH_FIELD_PATTERN = /search\s*:\s*\([^)]*VectorIndexQuery[^)]*\)/u;
// A plain-substring probe: the sentinel is a single identifier. `String#includes` is what
// the linter prefers here — a regex would be doing the same thing with more machinery.
const GUARD_MENTION = "isValidVectorIndexQuery";

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (SOURCE_EXTENSIONS.has(extname(entry)) && !/\.test\.[cm]?[jt]sx?$/u.test(entry)) {
      yield full;
    }
  }
}

function pathIsContractFile(file: string): boolean {
  return relative(REPO_ROOT, file).split("\\").join("/") === CONTRACT_FILE;
}

function fileImplementsPort(text: string): boolean {
  return SEARCH_METHOD_PATTERN.test(text) || SEARCH_FIELD_PATTERN.test(text);
}

describe("VectorIndexPort — one precondition guard per implementation", () => {
  it("every implementation module references isValidVectorIndexQuery", () => {
    const missing: string[] = [];
    for (const root of SCANNED_ROOTS) {
      const absoluteRoot = join(REPO_ROOT, root);
      for (const file of sourceFiles(absoluteRoot)) {
        if (pathIsContractFile(file)) continue;
        const text = readFileSync(file, "utf8");
        if (!fileImplementsPort(text)) continue;
        if (!text.includes(GUARD_MENTION)) {
          missing.push(relative(REPO_ROOT, file).split("\\").join("/"));
        }
      }
    }
    expect(
      missing,
      `implementations without an isValidVectorIndexQuery reference: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
