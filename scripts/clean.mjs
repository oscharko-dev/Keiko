// Graph-derived clean: discover every workspace package's emit directory from the
// root workspace manifest and delete it, plus root dist/ and coverage/.
//
// Per-package emit conventions:
//   - keiko-* tsc packages emit to dist/
//   - keiko-ui (Next.js) emits to .next/ and out/

import { lstat, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const ROOT_TARGETS = ["dist", "coverage"];
const UI_TARGETS = [".next", "out"];
export const CLEAN_RM_OPTIONS = Object.freeze({
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
});

import { collectWorkspacePackages } from "./workspace-graph.mjs";

function isWithin(rootPath, candidatePath) {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function parseArgs(argv) {
  const rootArg = argv.find((arg) => arg.startsWith("--root="));
  return {
    root: resolve(rootArg ? rootArg.slice("--root=".length) : process.cwd()),
  };
}

export async function planCleanTargets(root) {
  const packages = await collectWorkspacePackages(root);
  const targets = ROOT_TARGETS.map((target) => join(root, target));
  for (const pkg of packages) {
    if (pkg.name === "@oscharko-dev/keiko-ui") {
      for (const target of UI_TARGETS) {
        targets.push(join(pkg.dir, target));
      }
      continue;
    }
    targets.push(join(pkg.dir, "dist"));
  }
  return targets;
}

export async function lstatIfExists(targetPath, inspect = lstat) {
  try {
    return await inspect(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function rmIfExistsSafe(rootReal, targetPath, remove = rm) {
  const stats = await lstatIfExists(targetPath);
  if (!stats) {
    return false;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`refusing to delete symbolic-link target: ${targetPath}`);
  }
  const canonicalParent = await realpath(dirname(targetPath));
  const canonicalTarget = join(canonicalParent, basename(targetPath));
  if (!isWithin(rootReal, canonicalTarget)) {
    throw new Error(
      `refusing to delete path outside repository: ${targetPath} -> ${canonicalTarget}`,
    );
  }
  await remove(canonicalTarget, CLEAN_RM_OPTIONS);
  console.log(`removed ${targetPath}`);
  return true;
}

export async function main(argv = process.argv.slice(2)) {
  const { root } = parseArgs(argv);
  const rootReal = await realpath(root);
  const targets = await planCleanTargets(root);
  for (const target of targets) {
    await rmIfExistsSafe(rootReal, target);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]).endsWith("clean.mjs");
if (invokedDirectly) {
  await main();
}
