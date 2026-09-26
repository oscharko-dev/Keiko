// #3401 review finding (T42): deliverySourceHashes()'s provenance list in
// coding-issue-delivery-evidence.ts is manually curated. The #3401 checkpoint added a new
// generation fixture (coding-issue-description-model.mts) that the journey's entry server
// (coding-issue-delivery-server.mts) imports and dispatches a mocked gateway turn through, and for
// one checkpoint it was silently absent from that list — so a regenerated `journey-proof.json`
// could attest reviewed sources while the unlisted fixture's evidence-id extraction drifted
// underneath it. This pin does not restate the list: it walks the ACTUAL import graph starting at
// the journey's real entry point and asserts every sibling `tests/e2e/servers/` fixture module it
// reaches is present in `DELIVERY_SOURCE_PATHS`, so a future fixture left out fails here instead
// of failing silently (AGENTS.md §7 — derive the expectation from the production entry point).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DELIVERY_SOURCE_PATHS } from "./coding-issue-delivery-evidence.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVERS_PREFIX = "tests/e2e/servers/";

// Matches a single (possibly multi-line, `import type` handled via the captured group)
// `import ... from "<relative specifier>";` statement.
const IMPORT_STATEMENT = /import\s+(type\s+)?[^;]*?from\s+"(\.[^"]+)"\s*;/gsu;

/** Value (non `import type`) relative import specifiers named by a repo-relative source file. */
function relativeValueImportSpecifiers(repoRelativeFile: string): readonly string[] {
  const text = readFileSync(join(REPO_ROOT, repoRelativeFile), "utf8");
  const specifiers: string[] = [];
  for (const match of text.matchAll(IMPORT_STATEMENT)) {
    const [, isTypeOnly, specifier] = match;
    if (isTypeOnly !== undefined) continue; // type-only: no runtime behavior to attest
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

/** Resolves a compiled-output specifier (".mjs"/".js") to the repo-relative TS source path. */
function resolveToSourcePath(fromFile: string, specifier: string): string {
  const resolved = resolve(dirname(join(REPO_ROOT, fromFile)), specifier);
  const relative = resolved.slice(REPO_ROOT.length + 1);
  if (relative.endsWith(".mjs")) return `${relative.slice(0, -".mjs".length)}.mts`;
  if (relative.endsWith(".js")) return `${relative.slice(0, -".js".length)}.ts`;
  return relative;
}

/**
 * Every `tests/e2e/servers/` fixture module transitively reachable from the journey's real entry
 * point, by following only relative value imports that land back inside that same directory —
 * production package files are an intentionally curated subset, not walked here.
 */
function reachableServerFixtures(entry: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const specifier of relativeValueImportSpecifiers(current)) {
      const target = resolveToSourcePath(current, specifier);
      if (target.startsWith(SERVERS_PREFIX) && !visited.has(target)) queue.push(target);
    }
  }
  visited.delete(entry);
  return visited;
}

describe("delivery journey provenance stays bound to its actual fixture graph (#3401)", () => {
  it("hashes every sibling fixture reachable from the journey's entry server", () => {
    const entry = "tests/e2e/servers/coding-issue-delivery-server.mts";
    const fixtures = reachableServerFixtures(entry);
    // Guards the guard: if the parser ever stops matching anything, this must fail loudly rather
    // than pass vacuously.
    expect(fixtures.size).toBeGreaterThan(0);
    for (const fixture of fixtures) {
      expect(DELIVERY_SOURCE_PATHS, `missing from DELIVERY_SOURCE_PATHS: ${fixture}`).toContain(
        fixture,
      );
    }
  });

  it("includes the #3401 generation fixture specifically", () => {
    expect(DELIVERY_SOURCE_PATHS).toContain("tests/e2e/servers/coding-issue-description-model.mts");
  });

  it("hashes the journey spec itself", () => {
    expect(DELIVERY_SOURCE_PATHS).toContain("tests/e2e/coding-issue-delivery.spec.ts");
  });
});
