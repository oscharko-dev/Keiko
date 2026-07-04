#!/usr/bin/env node
// Dependency-hygiene gate (GEN-SYNTH-COVERAGE-005 / GEN-PKG-DEPENDENCY-001/003/004/005).
//
// The dependency-analysis follow-up the general audit never completed. This is the missing verifier
// (GEN-PKG-DEPENDENCY-005): it fails closed on the concrete dependency-placement regressions the audit
// found and prevents their recurrence:
//   (1) A type-only `@types/*` package declared in a runtime `dependencies` block (it would leak into
//       the shipped tarball). Belongs in devDependencies. [GEN-PKG-DEPENDENCY-001]
//   (2) A workspace package missing an `engines` field (Node/npm floor). [GEN-PKG-DEPENDENCY-003]
//   (3) A bare build-tool import used by a `scripts/*.mjs` that is NOT declared in the root
//       package.json (relying on transitive resolution — build fragility). [GEN-PKG-DEPENDENCY-004]
//
// It is intentionally conservative (no network, no install): it reads package.json manifests and the
// static import specifiers of the build scripts only.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const problems = [];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const rootPkg = readJson(join(repoRoot, "package.json"));
const rootDeclared = new Set([
  ...Object.keys(rootPkg.dependencies ?? {}),
  ...Object.keys(rootPkg.devDependencies ?? {}),
  ...Object.keys(rootPkg.optionalDependencies ?? {}),
]);

// ── (1) + (2): per-package manifest checks ──────────────────────────────────
const packagesDir = join(repoRoot, "packages");
const workspaceManifests = [
  { label: "<root>", path: join(repoRoot, "package.json"), pkg: rootPkg },
];
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(packagesDir, entry.name, "package.json");
  try {
    workspaceManifests.push({ label: entry.name, path: manifestPath, pkg: readJson(manifestPath) });
  } catch {
    // A package directory without a manifest is not a hygiene concern here.
  }
}

for (const { label, pkg } of workspaceManifests) {
  // (1) No type-only @types/* in a runtime dependencies block.
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (dep.startsWith("@types/")) {
      problems.push(
        `${label}: "${dep}" is a type-only package in "dependencies" — move it to "devDependencies" (it would ship in the tarball).`,
      );
    }
  }
  // (2) Every workspace package (not the root aggregator) declares an engines floor.
  if (label !== "<root>" && (pkg.engines === undefined || pkg.engines.node === undefined)) {
    problems.push(`${label}: missing an "engines.node" floor (align with the root >=22).`);
  }
}

// ── (3): every bare build-tool import in scripts/*.mjs is declared at the root ──
// Anchored to line start so dynamic `import(...)` calls and `import`/`from` appearing inside string
// literals are not matched, and the captured specifier is validated as a plausible bare package name.
const scriptsDir = join(repoRoot, "scripts");
const importRe = /^\s*import\s+(?:[^"'\n]*?\sfrom\s+)?["']([^"']+)["']\s*;?\s*$/gm;
const BARE_PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w.-]+)*$/i;
function packageNameOf(specifier) {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return name === undefined ? specifier : `${scope}/${name}`;
  }
  return specifier.split("/")[0];
}
for (const file of readdirSync(scriptsDir)) {
  if (!file.endsWith(".mjs")) continue;
  const source = readFileSync(join(scriptsDir, file), "utf8");
  for (const match of source.matchAll(importRe)) {
    const specifier = match[1];
    if (
      specifier.startsWith(".") ||
      specifier.startsWith("/") ||
      specifier.startsWith("node:") ||
      specifier.startsWith("@oscharko-dev/") ||
      !BARE_PACKAGE.test(specifier)
    ) {
      continue;
    }
    const name = packageNameOf(specifier);
    if (!rootDeclared.has(name)) {
      problems.push(
        `scripts/${file}: imports "${name}" which is not declared in the root package.json (relies on transitive resolution — declare it in devDependencies).`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("check:dependency-hygiene FAIL — dependency-placement regressions:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `check:dependency-hygiene PASS — ${String(workspaceManifests.length)} manifests: no @types/* in runtime deps, engines floors present, build-tool script imports declared at root.`,
);
