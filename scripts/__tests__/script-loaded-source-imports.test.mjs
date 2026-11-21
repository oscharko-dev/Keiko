// Repository scripts load some package source files directly (`../packages/<pkg>/src/<file>.ts`)
// through Node's type stripping. Several of them, such as provision-usearch.mjs and
// qualify-portable-secure-read.mjs, run in CI before `npm run build:packages`. A value import of a
// workspace package (`@oscharko-dev/...`) resolves to that package's `dist`, which does not exist
// yet, and stops the script with ERR_MODULE_NOT_FOUND.
//
// REVIEW-3918-090: slice 4 of #3933 added a keiko-contracts import to
// keiko-security/src/windows-system-directory.ts, and every coverage shard, the policy job and the
// portable secure-read smokes failed at provisioning. This pin walks every script-loaded source file
// and its relative imports and refuses a workspace value import. `import type` is erased by type
// stripping and stays allowed.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SKIPPED_DIRECTORIES = new Set(["node_modules", "__tests__", "fixtures"]);
const VALUE_IMPORT =
  /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gmu;
const PACKAGE_SOURCE = /\/packages\/[^/]+\/src\/.+\.ts$/u;

// update-portable-handoff-tree.ts imported keiko-security before this pin existed. Its only script
// loader, windows-portable-signing.mjs, works on a staged portable payload (--stage-root), which
// exists only after the packages are built.
const REVIEWED_WORKSPACE_IMPORTS = new Set([
  "packages/keiko-server/src/update-portable-handoff-tree.ts -> @oscharko-dev/keiko-security/portable-tree-attestation",
]);

function scriptFiles(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) scriptFiles(path, out);
    } else if (/\.m?js$/u.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

function valueImports(path) {
  return [...readFileSync(path, "utf8").matchAll(VALUE_IMPORT)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
}

function scriptLoadedSources() {
  const entries = new Set();
  for (const script of scriptFiles(join(ROOT, "scripts"))) {
    for (const specifier of valueImports(script)) {
      if (PACKAGE_SOURCE.test(specifier)) entries.add(resolve(dirname(script), specifier));
    }
  }
  return entries;
}

function workspaceImportsInClosure(entries) {
  const seen = new Set();
  const found = [];
  const visit = (path) => {
    if (seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    for (const specifier of valueImports(path)) {
      if (specifier.startsWith("@oscharko-dev/")) {
        found.push(`${relative(ROOT, path)} -> ${specifier}`);
      } else if (specifier.startsWith(".")) {
        visit(resolve(dirname(path), specifier.replace(/\.js$/u, ".ts")));
      }
    }
  };
  for (const entry of entries) visit(entry);
  return { found, visited: seen.size };
}

describe("package source loaded by repository scripts", () => {
  it("imports no workspace package by value, so it loads before the build", () => {
    const entries = scriptLoadedSources();
    const { found, visited } = workspaceImportsInClosure(entries);
    expect(entries.has(join(ROOT, "packages/keiko-security/src/windows-system-directory.ts"))).toBe(
      true,
    );
    expect(visited).toBeGreaterThanOrEqual(entries.size);
    expect(found.filter((edge) => !REVIEWED_WORKSPACE_IMPORTS.has(edge))).toEqual([]);
  });
});
