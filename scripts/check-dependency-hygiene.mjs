#!/usr/bin/env node
// Dependency-hygiene gate (GEN-SYNTH-COVERAGE-005 / GEN-PKG-DEPENDENCY-001/003/004/005).
//
// This deterministic, offline gate fails closed on dependency placement, missing workspace engine
// floors, a workspace lint toolchain that has drifted off the root's single lane, undeclared script
// imports, and tracked generated Next.js output. It reports metadata only: package names, policy
// descriptions, counts, and control-character-safe paths — never file bodies.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { readJsonFile } from "./lib/json.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(here, "..");
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const NEXT_BUILD_SEGMENT = /(?:^|\/)\.next(?:\/|$)/u;
const BARE_PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w.-]+)*$/i;
// Issue #2777: packages/keiko-ui runs `../../node_modules/eslint/bin/eslint.js`, so it has no
// ESLint of its own to execute — the monorepo lints through one installed binary and the root and
// the workspace must therefore move between ESLint majors together. When the declared ranges drift
// npm satisfies the workspace separately: PR #3290 left the root on "^10.8.1" (resolved 10.9.1) and
// keiko-ui on "10.8.1", which installed a second, never-executed ESLint under
// packages/keiko-ui/node_modules and silently reopened the divergence this lane exists to prevent.
//
// This gate owns BOTH layers of that invariant, because npm owns neither. `npm ls` raises a problem
// only for a missing, invalid, or extraneous edge (npm/lib/commands/ls.js getProblems); a second
// copy that satisfies its own workspace's declared range is a valid node, so `npm ls eslint` prints
// both and exits 0. check:eslint-lane therefore answers peer-edge validity and nothing else — the
// duplicate is only ever caught here.
const SINGLE_LANE_PACKAGES = ["eslint"];
const GOVERNED_GIT_EXECUTABLE_PATHS = [
  "/usr/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
  String.raw`C:\Program Files\Git\bin\git.exe`,
  String.raw`C:\Program Files\Git\cmd\git.exe`,
];

function packageNameOf(specifier) {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return name === undefined ? specifier : `${scope}/${name}`;
  }
  return specifier.split("/")[0];
}

function readWorkspaceManifests(repoRoot) {
  const rootPackage = readJsonFile(join(repoRoot, "package.json"));
  const manifests = [{ label: "<root>", pkg: rootPackage }];
  for (const entry of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      manifests.push({
        label: entry.name,
        pkg: readJsonFile(join(repoRoot, "packages", entry.name, "package.json")),
      });
    } catch {
      // Package directories without manifests are outside this gate's dependency scope.
    }
  }
  return { manifests, rootPackage };
}

function collectManifestProblems(manifests) {
  const problems = [];
  for (const { label, pkg } of manifests) {
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      if (dependency.startsWith("@types/")) {
        problems.push(
          `${label}: "${dependency}" is a type-only package in "dependencies" — move it to "devDependencies" (it would ship in the tarball).`,
        );
      }
    }
    if (label !== "<root>" && (pkg.engines === undefined || pkg.engines.node === undefined)) {
      problems.push(`${label}: missing an "engines.node" floor (align with the root).`);
    }
  }
  return problems;
}

function declaredRange(pkg, dependency) {
  return pkg.dependencies?.[dependency] ?? pkg.devDependencies?.[dependency];
}

function collectSingleLaneProblems(manifests, rootPackage) {
  const problems = [];
  for (const dependency of SINGLE_LANE_PACKAGES) {
    const rootRange = declaredRange(rootPackage, dependency);
    for (const { label, pkg } of manifests) {
      if (label === "<root>") continue;
      const range = declaredRange(pkg, dependency);
      if (range === undefined || range === rootRange) continue;
      problems.push(
        rootRange === undefined
          ? `${label}: declares "${dependency}": "${range}" while the root declares none — the workspace executes the root's installed ${dependency}, so declare it at the root instead.`
          : `${label}: declares "${dependency}": "${range}" but the root declares "${rootRange}" — the workspace executes the root's installed ${dependency}, so a diverging range installs a second copy that never runs.`,
      );
    }
  }
  return problems;
}

function collectDuplicateInstallProblems(repoRoot, manifests) {
  const problems = [];
  for (const dependency of SINGLE_LANE_PACKAGES) {
    // No root copy means nothing is installed yet; the manifest rule above still applies.
    if (!existsSync(join(repoRoot, "node_modules", dependency))) continue;
    for (const { label } of manifests) {
      if (label === "<root>") continue;
      if (!existsSync(join(repoRoot, "packages", label, "node_modules", dependency))) continue;
      problems.push(
        `${label}: a second "${dependency}" is installed at packages/${label}/node_modules/${dependency} — the workspace executes the root's copy, so this one never runs and the two can drift apart.`,
      );
    }
  }
  return problems;
}

function declaredRootPackages(rootPackage) {
  return new Set([
    ...Object.keys(rootPackage.dependencies ?? {}),
    ...Object.keys(rootPackage.devDependencies ?? {}),
    ...Object.keys(rootPackage.optionalDependencies ?? {}),
  ]);
}

function isExternalBuildImport(specifier) {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("node:") &&
    !specifier.startsWith("@oscharko-dev/") &&
    BARE_PACKAGE.test(specifier)
  );
}

function collectScriptImportProblems(repoRoot, rootPackage) {
  const problems = [];
  const declaredPackages = declaredRootPackages(rootPackage);
  const scriptsDirectory = join(repoRoot, "scripts");
  for (const file of readdirSync(scriptsDirectory)) {
    if (!file.endsWith(".mjs")) continue;
    const source = readFileSync(join(scriptsDirectory, file), "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      if (!isExternalBuildImport(specifier)) continue;
      const packageName = packageNameOf(specifier);
      if (!declaredPackages.has(packageName)) {
        problems.push(
          `scripts/${file}: imports "${packageName}" which is not declared in the root package.json (relies on transitive resolution — declare it in devDependencies).`,
        );
      }
    }
  }
  return problems;
}

function executableNames(env = process.env) {
  if (process.platform !== "win32") return ["git"];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension.length > 0);
  return ["git", ...extensions.map((extension) => `git${extension.toLowerCase()}`)];
}

function pathGitCandidates(env = process.env) {
  return (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0 && isAbsolute(entry))
    .flatMap((entry) => executableNames(env).map((name) => join(entry, name)));
}

function governedGitCandidates(env = process.env) {
  return [
    ...GOVERNED_GIT_EXECUTABLE_PATHS,
    env.LOCALAPPDATA === undefined
      ? undefined
      : join(env.LOCALAPPDATA, "Programs", "Git", "bin", "git.exe"),
    env.LOCALAPPDATA === undefined
      ? undefined
      : join(env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe"),
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
}

function unique(values) {
  return [...new Set(values)];
}

export function gitExecutableCandidates(env = process.env) {
  return unique([
    env.KEIKO_GIT_EXECUTABLE,
    ...governedGitCandidates(env),
    ...pathGitCandidates(env),
  ]).filter((candidate) => typeof candidate === "string" && candidate.length > 0);
}

export function resolveGitExecutable(env = process.env) {
  const executable = gitExecutableCandidates(env).find((candidate) => existsSync(candidate));
  if (executable === undefined) {
    throw new Error(
      "Git executable could not be resolved from KEIKO_GIT_EXECUTABLE, governed system paths, or PATH.",
    );
  }
  return realpathSync(executable);
}

function normalizeTrackedPath(path) {
  return path.startsWith("./") ? path.slice(2) : path;
}

export function findTrackedNextBuildPaths(paths) {
  return paths
    .map(normalizeTrackedPath)
    .filter((path) => NEXT_BUILD_SEGMENT.test(path))
    .sort();
}

function readTrackedRepositoryPaths(repoRoot) {
  const result = spawnSync(resolveGitExecutable(), ["ls-files", "-z", "--"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(gitInspectionFailureMessage(result));
  }
  return result.stdout.split("\0").filter((path) => path.length > 0);
}

function safeDiagnostic(value) {
  return String(value ?? "")
    .replaceAll("\0", String.raw`\0`)
    .replace(/[^\P{Cc}\r\n\t]/gu, "?")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

function gitInspectionFailureMessage(result) {
  if (result.error !== undefined) {
    return `git ls-files could not start: ${safeDiagnostic(result.error.message)}`;
  }
  if (result.signal !== null) {
    return `git ls-files terminated by signal ${safeDiagnostic(result.signal)}`;
  }
  if (result.status !== 0) {
    return `git ls-files exited with status ${String(result.status)}`;
  }
  return "git ls-files returned no parseable stdout";
}

function collectTrackedNextProblems(repoRoot) {
  const trackedPaths = readTrackedRepositoryPaths(repoRoot);
  const violations = findTrackedNextBuildPaths(trackedPaths);
  return {
    problems: violations.map((path) => `tracked .next output path: ${JSON.stringify(path)}`),
    trackedPathCount: trackedPaths.length,
    violationCount: violations.length,
  };
}

export function checkDependencyHygiene(repoRoot) {
  const { manifests, rootPackage } = readWorkspaceManifests(repoRoot);
  const problems = [
    ...collectManifestProblems(manifests),
    ...collectSingleLaneProblems(manifests, rootPackage),
    ...collectDuplicateInstallProblems(repoRoot, manifests),
    ...collectScriptImportProblems(repoRoot, rootPackage),
  ];
  try {
    const tracked = collectTrackedNextProblems(repoRoot);
    problems.push(...tracked.problems);
    return {
      manifestCount: manifests.length,
      problems,
      trackedPathCount: tracked.trackedPathCount,
      trackedNextViolationCount: tracked.violationCount,
    };
  } catch (error) {
    problems.push(
      `Git index inspection did not complete successfully: ${
        error instanceof Error ? safeDiagnostic(error.message) : safeDiagnostic(error)
      }`,
    );
    return {
      manifestCount: manifests.length,
      problems,
      trackedPathCount: 0,
      trackedNextViolationCount: 0,
    };
  }
}

function requestedRoot(argv) {
  const rootArgument = argv.find((argument) => argument.startsWith("--root="));
  return rootArgument === undefined
    ? defaultRepoRoot
    : resolve(rootArgument.slice("--root=".length));
}

function main(argv) {
  const result = checkDependencyHygiene(requestedRoot(argv));
  if (result.problems.length > 0) {
    process.stderr.write(
      `check:dependency-hygiene FAIL — ${result.trackedNextViolationCount} tracked .next path(s); ${result.problems.length} total hygiene problem(s):\n`,
    );
    for (const problem of result.problems) process.stderr.write(`  - ${problem}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `check:dependency-hygiene PASS — ${result.manifestCount} manifests and ${result.trackedPathCount} tracked paths: dependency placement, engines, single-lane lint toolchain, script imports, and generated-output policy satisfied.\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
