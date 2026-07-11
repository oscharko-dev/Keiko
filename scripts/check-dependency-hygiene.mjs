#!/usr/bin/env node
// Dependency-hygiene gate (GEN-SYNTH-COVERAGE-005 / GEN-PKG-DEPENDENCY-001/003/004/005).
//
// This deterministic, offline gate fails closed on dependency placement, missing workspace engine
// floors, undeclared script imports, and tracked generated Next.js output. It reports metadata only:
// package names, policy descriptions, counts, and control-character-safe paths — never file bodies.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(here, "..");
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const NEXT_BUILD_SEGMENT = /(?:^|\/)\.next(?:\/|$)/u;
const BARE_PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w.-]+)*$/i;
const GIT_EXECUTABLE_CANDIDATES = [
  "/usr/bin/git",
  String.raw`C:\Program Files\Git\bin\git.exe`,
  String.raw`C:\Program Files\Git\cmd\git.exe`,
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function packageNameOf(specifier) {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return name === undefined ? specifier : `${scope}/${name}`;
  }
  return specifier.split("/")[0];
}

function readWorkspaceManifests(repoRoot) {
  const rootPackage = readJson(join(repoRoot, "package.json"));
  const manifests = [{ label: "<root>", pkg: rootPackage }];
  for (const entry of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      manifests.push({
        label: entry.name,
        pkg: readJson(join(repoRoot, "packages", entry.name, "package.json")),
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

function resolveGitExecutable() {
  const executable = GIT_EXECUTABLE_CANDIDATES.find((candidate) => existsSync(candidate));
  if (executable === undefined) {
    throw new Error("Git index inspection requires Git in a governed system installation path.");
  }
  return executable;
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
    throw new Error("Git index inspection did not complete successfully.");
  }
  return result.stdout.split("\0").filter((path) => path.length > 0);
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
  } catch {
    problems.push("Git index inspection did not complete successfully.");
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
    `check:dependency-hygiene PASS — ${result.manifestCount} manifests and ${result.trackedPathCount} tracked paths: dependency placement, engines, script imports, and generated-output policy satisfied.\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
