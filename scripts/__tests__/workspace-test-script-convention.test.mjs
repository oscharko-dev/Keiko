import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// KEIKO-0915 (#3336): every workspace package's `scripts.test` is exactly `"vitest run"`, never
// `"npm run build && vitest run"`. An isolated `npm test --workspace <pkg>` therefore requires a
// prior `npm run build:packages`, which root `npm test` performs for you once, workspace-wide,
// before it invokes vitest. A per-package `npm run build && vitest run` only duplicates that
// already-performed build — it is not what makes an isolated run correct, and it slows down every
// isolated invocation for no correctness benefit.
//
// The workspace set below is derived from the root manifest's own `workspaces` globs (never
// re-declared here), and a package.json that cannot be read or parsed fails the test instead of
// being silently dropped from the check — a guard that ignores unreadable input is a guard that
// can be defeated by making the input unreadable.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

function workspaceGlobs() {
  const rootManifestPath = path.join(REPO_ROOT, "package.json");
  const rootManifest = JSON.parse(readFileSync(rootManifestPath, "utf8"));
  const globs = rootManifest.workspaces;
  if (!Array.isArray(globs) || globs.length === 0) {
    throw new TypeError(`${rootManifestPath}: "workspaces" must be a non-empty array of globs`);
  }
  return globs;
}

function packagesInGlob(glob) {
  if (!glob.endsWith("/*")) {
    throw new Error(`unsupported workspaces glob shape: "${glob}" (expected "<dir>/*")`);
  }
  const dir = path.join(REPO_ROOT, glob.slice(0, -2));
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      packageJsonPath: path.join(dir, entry.name, "package.json"),
    }));
}

function workspacePackages() {
  return workspaceGlobs().flatMap((glob) => packagesInGlob(glob));
}

describe("workspace scripts.test convention", () => {
  it.each(workspacePackages())(
    '$name declares scripts.test as "vitest run"',
    ({ packageJsonPath }) => {
      // No try/catch: an unreadable or malformed manifest must fail this test, not be dropped
      // from the workspace set it checks.
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      expect(pkg.scripts?.test).toBe("vitest run");
    },
  );
});
