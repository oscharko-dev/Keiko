import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compiler = join(repoRoot, "node_modules", "@typescript", "native", "bin", "tsc");
const MAX_ATTEMPTS = 3;

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isValidEmptyOutputAllowlistEntry(entry, allowed) {
  if (typeof entry !== "string" || entry.includes("\\") || allowed.has(entry)) return false;
  const segments = entry.split("/");
  if (
    segments.length < 4 ||
    segments[0] !== "packages" ||
    segments[1] === "" ||
    segments[2] !== "dist"
  ) {
    return false;
  }
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function readEmptyOutputAllowlist(root) {
  const path = join(root, "scripts", "empty-build-output-allowlist.json");
  if (!existsSync(path)) return new Set();
  const entries = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(entries)) throw new Error("Empty build-output allowlist must be an array");
  const allowed = new Set();
  for (const entry of entries) {
    if (!isValidEmptyOutputAllowlistEntry(entry, allowed)) {
      throw new Error(`Invalid empty build-output allowlist entry: ${String(entry)}`);
    }
    allowed.add(entry);
  }
  return allowed;
}

function collectEmptyFiles(directory, root, results, allowed) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectEmptyFiles(path, root, results, allowed);
    else if (entry.isFile() && statSync(path).size === 0) {
      const output = relative(root, path).replaceAll("\\", "/");
      if (!allowed.has(output)) results.push(output);
    }
  }
}

export function findEmptyPackageBuildOutputs(root = repoRoot) {
  const results = [];
  const allowed = readEmptyOutputAllowlist(root);
  const packagesRoot = join(root, "packages");
  if (!existsSync(packagesRoot)) return results;
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (entry.isDirectory())
      collectEmptyFiles(join(packagesRoot, entry.name, "dist"), root, results, allowed);
  }
  return results.sort(compareCodeUnits);
}

function defaultCompilerRun(root) {
  return spawnSync(process.execPath, [compiler, "-b", "tsconfig.packages.json", "--force"], {
    cwd: root,
    stdio: "inherit",
  });
}

export function buildPackages({ root = repoRoot, runCompiler = defaultCompilerRun } = {}) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = runCompiler(root);
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Native TypeScript package build exited with ${String(result.status)}`);
    }
    const emptyOutputs = findEmptyPackageBuildOutputs(root);
    if (emptyOutputs.length === 0) return;
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(
        `Native TypeScript emitted empty package outputs:\n${emptyOutputs.join("\n")}`,
      );
    }
    console.error(
      `Native TypeScript emitted ${String(emptyOutputs.length)} empty package output(s); ` +
        `retrying forced build (${String(attempt)}/${String(MAX_ATTEMPTS - 1)}).`,
    );
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    buildPackages();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
