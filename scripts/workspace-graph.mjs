import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const WORKSPACE_DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

function isWithin(rootPath, candidatePath) {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function normalizeWorkspaces(manifest) {
  if (Array.isArray(manifest.workspaces)) {
    return manifest.workspaces;
  }
  if (manifest.workspaces && Array.isArray(manifest.workspaces.packages)) {
    return manifest.workspaces.packages;
  }
  throw new Error("root package.json does not declare workspaces");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function collectInternalDeps(manifest) {
  const internalDeps = new Set();
  for (const field of WORKSPACE_DEP_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      internalDeps.add(name);
    }
  }
  return internalDeps;
}

async function expandWorkspacePattern(root, pattern) {
  const normalized = pattern.replaceAll("\\", "/");
  if (normalized.endsWith("/*")) {
    const baseDir = resolve(root, normalized.slice(0, -2));
    const entries = await readdir(baseDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(baseDir, entry.name))
      .sort();
  }

  if (normalized.includes("*")) {
    throw new Error(`unsupported workspace pattern: ${pattern}`);
  }
  return [resolve(root, normalized)];
}

async function readWorkspacePackage(repoRootReal, dir) {
  const stats = await lstat(dir).catch(() => null);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    return null;
  }
  const dirReal = await realpath(dir);
  if (!isWithin(repoRootReal, dirReal)) {
    return null;
  }

  const manifestPath = join(dir, "package.json");
  const manifestStats = await lstat(manifestPath).catch(() => null);
  if (!manifestStats?.isFile()) {
    return null;
  }

  const manifest = await readJson(manifestPath);

  return {
    dir,
    dirReal,
    manifest,
    manifestPath,
    name: manifest.name,
    scripts: manifest.scripts ?? {},
    internalDeps: collectInternalDeps(manifest),
  };
}

export async function collectWorkspacePackages(root) {
  const repoRoot = resolve(root);
  const repoRootReal = await realpath(repoRoot);
  const rootManifest = await readJson(join(repoRoot, "package.json"));
  const workspacePatterns = normalizeWorkspaces(rootManifest);
  const packageDirs = new Set();
  for (const pattern of workspacePatterns) {
    for (const dir of await expandWorkspacePattern(repoRoot, pattern)) {
      packageDirs.add(dir);
    }
  }

  const packages = [];
  for (const dir of [...packageDirs].sort()) {
    const pkg = await readWorkspacePackage(repoRootReal, dir);
    if (pkg) {
      packages.push(pkg);
    }
  }

  return packages;
}
