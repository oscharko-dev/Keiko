// Remove build-only metadata and compiled test fixtures from workspace dist trees before packaging.
// The tarball gate still fails closed if any matching path survives; this script keeps the normal
// prepack/prepublish flow from shipping tsc incremental state or test-only helpers.

import { readdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = resolve(process.env.KEIKO_REPO_ROOT ?? resolve(import.meta.dirname, ".."));
const currentFile = fileURLToPath(import.meta.url);

function isWithin(rootPath, candidatePath) {
  const rel = relative(rootPath, candidatePath);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function assertWithinRepo(repoRoot, path) {
  const resolved = resolve(path);
  if (!isWithin(repoRoot, resolved)) {
    throw new Error(`refusing to prune path outside repository: ${path}`);
  }
  return resolved;
}

function isCompiledTestArtifact(name) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || /\.(test|spec)\.d\.ts(?:\.map)?$/.test(name);
}

function pruneDistTree(repoRoot, distDir, removed) {
  const entries = readdirSync(distDir, { withFileTypes: true });
  for (const entry of entries) {
    const path = assertWithinRepo(repoRoot, join(distDir, entry.name));
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") {
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
        continue;
      }
      pruneDistTree(repoRoot, path, removed);
      continue;
    }
    if (entry.name.endsWith(".tsbuildinfo") || isCompiledTestArtifact(entry.name)) {
      rmSync(path, { force: true });
      removed.push(path);
    }
  }
}

export function prunePackageBuildArtifacts(repoRoot = defaultRepoRoot) {
  const removed = [];
  const packagesRoot = join(repoRoot, "packages");
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const distDir = assertWithinRepo(repoRoot, join(packagesRoot, entry.name, "dist"));
    try {
      if (!statSync(distDir).isDirectory()) continue;
    } catch {
      continue;
    }
    pruneDistTree(repoRoot, distDir, removed);
  }
  return removed;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(currentFile);

if (invokedDirectly) {
  const removed = prunePackageBuildArtifacts();
  if (removed.length === 0) {
    console.log("prune-package-build-artifacts: no build-only package artifacts present");
  } else {
    console.log(`prune-package-build-artifacts: removed ${String(removed.length)} build-only artifacts`);
  }
}
