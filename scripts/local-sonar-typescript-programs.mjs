#!/usr/bin/env node

// Changed-file TypeScript programs for the local pre-push Sonar scan (docker/gates/run-sonar.sh).
//
// `sonar.typescript.tsconfigPaths` names the root tsconfig, whose program holds about 6,400 files.
// SonarJS builds the whole program of every tsconfig that owns an analysed file, so one changed file
// under `src/`, `tests/` or `packages/*/src` made the local scan load all of it and run out of the
// bridge heap (4608 MiB) on a machine whose Docker VM cannot give it ten gigabytes. A program rooted
// at the changed files instead, with the owning tsconfig's compiler options and its ambient
// declarations, resolves the same types for those files: imports are followed exactly as before.
//
// Each generated tsconfig lives in the owning tsconfig's directory under `.keiko/` (gitignored at
// any depth and excluded from the Sonar index), so module and `types` resolution start where the
// owner's do. The runner removes them when it exits.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DECLARATION_FILE = /\.d\.[cm]?ts$/u;
const CHECKOUT_ID = /^[0-9a-f]{12}$/u;
const byPath = (left, right) => left.localeCompare(right);
const TSCONFIG_PATHS_PROPERTY = "sonar.typescript.tsconfigPaths";

function toPosix(path) {
  return path.replaceAll("\\", "/");
}

export function readTsconfigPaths(properties) {
  const line = properties
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${TSCONFIG_PATHS_PROPERTY}=`));
  if (line === undefined) throw new TypeError(`${TSCONFIG_PATHS_PROPERTY} is not configured`);
  const paths = line
    .slice(TSCONFIG_PATHS_PROPERTY.length + 1)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (paths.length === 0) throw new TypeError(`${TSCONFIG_PATHS_PROPERTY} is empty`);
  return paths;
}

export function generatedTsconfigPath(configPath, checkoutId) {
  if (!CHECKOUT_ID.test(checkoutId)) throw new TypeError("checkout id must be 12 hex characters");
  const directory = dirname(toPosix(configPath));
  const name = `.keiko/local-sonar-tsconfig-${checkoutId}.json`;
  return directory === "." ? name : `${directory}/${name}`;
}

function relativeFrom(fromDirectory, path) {
  const result = toPosix(relative(fromDirectory, path));
  return result.startsWith(".") ? result : `./${result}`;
}

/**
 * Assigns every changed file to the first configured tsconfig whose program contains it and returns
 * one tsconfig per owner that received a file. Paths are repository-relative with forward slashes.
 */
export function planChangedTypeScriptPrograms({ changedPaths, owners, checkoutId }) {
  const changed = new Set(changedPaths.map((path) => toPosix(path)));
  const assigned = new Set();
  const plans = [];
  for (const owner of owners) {
    const ownFiles = owner.fileNames.filter((path) => changed.has(path) && !assigned.has(path));
    if (ownFiles.length === 0) continue;
    for (const path of ownFiles) assigned.add(path);
    const path = generatedTsconfigPath(owner.configPath, checkoutId);
    const directory = dirname(path);
    const declarations = owner.fileNames.filter(
      (file) => DECLARATION_FILE.test(file) && !ownFiles.includes(file),
    );
    plans.push({
      path,
      config: {
        extends: relativeFrom(directory, owner.configPath),
        // TypeScript 6 defaults rootDir to the tsconfig's own directory; keep the owner's.
        compilerOptions: { rootDir: relativeFrom(directory, owner.rootDir) },
        include: [],
        files: [...ownFiles, ...declarations]
          .sort(byPath)
          .map((file) => relativeFrom(directory, file)),
      },
    });
  }
  return plans;
}

async function loadTypeScript(repoRoot) {
  const entry = join(repoRoot, "node_modules", "typescript", "lib", "typescript.js");
  const module = await import(pathToFileURL(entry).href);
  return module.default ?? module;
}

function readOwner(ts, repoRoot, configPath) {
  const absolute = resolve(repoRoot, configPath);
  const read = ts.readConfigFile(absolute, ts.sys.readFile);
  if (read.error !== undefined) throw new TypeError(`${configPath} cannot be read`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(absolute));
  return {
    configPath,
    rootDir: toPosix(relative(repoRoot, parsed.options.rootDir ?? dirname(absolute))) || ".",
    fileNames: parsed.fileNames.map((file) => toPosix(relative(repoRoot, file))).sort(byPath),
  };
}

export async function writeChangedTypeScriptPrograms({ repoRoot, changedPaths, checkoutId }) {
  const ts = await loadTypeScript(repoRoot);
  const properties = readFileSync(join(repoRoot, "sonar-project.properties"), "utf8");
  const owners = readTsconfigPaths(properties).map((configPath) =>
    readOwner(ts, repoRoot, configPath),
  );
  const plans = planChangedTypeScriptPrograms({ changedPaths, owners, checkoutId });
  for (const plan of plans) {
    const target = join(repoRoot, plan.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(plan.config, null, 2)}\n`);
  }
  return plans.map((plan) => plan.path);
}

export function removeChangedTypeScriptPrograms({ repoRoot, checkoutId }) {
  const properties = readFileSync(join(repoRoot, "sonar-project.properties"), "utf8");
  for (const configPath of readTsconfigPaths(properties)) {
    rmSync(join(repoRoot, generatedTsconfigPath(configPath, checkoutId)), { force: true });
  }
}

export async function runCli({ argv, repoRoot, stdin, stdout, stderr }) {
  const [mode, checkoutId = ""] = argv;
  try {
    if (mode === "--remove") {
      removeChangedTypeScriptPrograms({ repoRoot, checkoutId });
      return 0;
    }
    if (mode !== "--write") throw new TypeError("usage: --write <checkout id> | --remove <id>");
    const changedPaths = JSON.parse(stdin());
    if (!Array.isArray(changedPaths) || changedPaths.some((path) => typeof path !== "string")) {
      throw new TypeError("the changed-path inventory must be a JSON array of strings");
    }
    const paths = await writeChangedTypeScriptPrograms({ repoRoot, changedPaths, checkoutId });
    stdout(paths.join(","));
    return 0;
  } catch (error) {
    stderr(`local-sonar-typescript-programs: FAIL - ${error.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await runCli({
    argv: process.argv.slice(2),
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    stdin: () => readFileSync(0, "utf8"),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(`${text}\n`),
  });
}
