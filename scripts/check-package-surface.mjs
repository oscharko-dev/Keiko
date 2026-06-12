// Package-surface verification (ADR-0011 D6). Asserts the publish tarball ships the UI assets,
// exposes an executable CLI bin, and includes nothing it must not: no source maps, no `.env`,
// no workspace `packages/keiko-ui/` source, and no absolute local paths. Run from `prepack`/`prepublishOnly`
// after the build steps.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
// Inline-script SHA-256 helper for the CSP-hash audit. Lives on the BFF package
// (@oscharko-dev/keiko-server) — the BFF folds the hashes into script-src at request time, and
// this script audits the packed UI bundle against the same set.
import { extractInlineScriptHashes } from "@oscharko-dev/keiko-server";
import { findForbiddenPaths } from "./package-surface-rules.mjs";

const EXPECTED_BUNDLE_EXCLUSIONS = new Map([
  [
    "@oscharko-dev/keiko-ui",
    "build-time-only workspace whose runtime artifact is copied into dist/ui/static",
  ],
]);

function packFiles() {
  const env = { ...process.env };
  delete env.npm_command;
  delete env.npm_lifecycle_event;
  delete env.npm_lifecycle_script;
  delete env.npm_package_json;
  // `--ignore-scripts` prevents the prepack hook from re-running this check recursively (npm runs
  // prepack on `npm pack`); the build steps already ran before this check in the prepack chain.
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed: ${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return entry?.files ?? [];
}

function fail(message) {
  console.error(`package-surface check failed: ${message}`);
  process.exit(1);
}

function collectHtmlFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectHtmlFiles(full));
    } else if (entry.name.endsWith(".html")) {
      files.push(full);
    }
  }
  return files;
}

function readJsonArray(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(parsed) ? parsed : [];
}

function listPrivateWorkspacePackages() {
  const packagesDir = "packages";
  const workspaces = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.private === true && typeof manifest.name === "string") {
      workspaces.push(manifest.name);
    }
  }
  return workspaces.sort();
}

function assertCspHashesMatchStaticHtml() {
  const staticRoot = join("dist", "ui", "static");
  const htmlFiles = collectHtmlFiles(staticRoot);
  const expected = extractInlineScriptHashes(htmlFiles.map((file) => readFileSync(file, "utf8")));
  const actual = readJsonArray(join("dist", "ui", "csp-hashes.json")).filter(
    (entry) => typeof entry === "string",
  );
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((hash) => !actualSet.has(hash));
  const stale = actual.filter((hash) => !expectedSet.has(hash));
  if (missing.length > 0 || stale.length > 0 || expected.length !== actual.length) {
    fail(
      "dist/ui/csp-hashes.json does not match dist/ui/static HTML inline scripts " +
        `(missing ${String(missing.length)}, stale ${String(stale.length)}). Run \`npm run build:ui\`.`,
    );
  }
}

const WORKFLOW_HANDOFF_DIST_FILES = [
  "node_modules/@oscharko-dev/keiko-contracts/dist/workflow-handoff.js",
  "node_modules/@oscharko-dev/keiko-contracts/dist/workflow-handoff.d.ts",
];
const ROOT_PACKAGE_SURFACE_CONTRACT_PATH = join("scripts", "root-package-surface.contract.json");

function readRootPackageSurfaceContract() {
  return JSON.parse(readFileSync(ROOT_PACKAGE_SURFACE_CONTRACT_PATH, "utf8"));
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function formatTsDiagnostics(diagnostics) {
  return diagnostics
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      if (diagnostic.file === undefined || diagnostic.start === undefined) {
        return message;
      }
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return `${diagnostic.file.fileName}:${String(line + 1)}:${String(character + 1)} ${message}`;
    })
    .join("\n");
}

function diffExpectedExports(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((item) => !actualSet.has(item)),
    unexpected: actual.filter((item) => !expectedSet.has(item)),
  };
}

function collectTypeExports(entryPoint) {
  const compilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true,
  };
  const absoluteEntryPoint = resolve(entryPoint);
  const program = ts.createProgram([absoluteEntryPoint], compilerOptions);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    fail(`${entryPoint} does not typecheck:\n${formatTsDiagnostics(diagnostics)}`);
  }
  const sourceFile = program.getSourceFile(absoluteEntryPoint);
  if (sourceFile === undefined) {
    fail(`TypeScript source file not found: ${entryPoint}`);
  }
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(sourceFile);
  if (symbol === undefined) {
    fail(`TypeScript module symbol not found for: ${entryPoint}`);
  }
  return checker
    .getExportsOfModule(symbol)
    .map((item) => item.getName())
    .sort();
}

function assertServerRuntimeSurface(paths) {
  for (const required of ["dist/ui/csp-hashes.json"]) {
    if (!paths.includes(required)) {
      fail(
        `the tarball does not include ${required} ` +
          "(keiko-server runtime surface — run `npm run build && npm run build:ui`).",
      );
    }
  }
}

async function assertRootPublicApiContract(paths) {
  const contract = readRootPackageSurfaceContract();
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  if (stableJson(manifest.exports ?? {}) !== stableJson(contract.packageExports ?? {})) {
    fail(
      `package.json exports drifted from ${ROOT_PACKAGE_SURFACE_CONTRACT_PATH} ` +
        "(the root package must stay monolithic-root only).",
    );
  }
  for (const required of ["dist/index.js", "dist/index.d.ts"]) {
    if (!paths.includes(required)) {
      fail(`the tarball does not include ${required} (SDK root export — run \`npm run build\`).`);
    }
  }
  const url = pathToFileURL(resolve("dist/index.js")).href;
  const runtimeExports = Object.keys(await import(url)).sort();
  const runtimeDiff = diffExpectedExports(runtimeExports, contract.runtimeExports);
  if (runtimeDiff.missing.length > 0 || runtimeDiff.unexpected.length > 0) {
    fail(
      "root runtime export contract drifted " +
        `(missing ${String(runtimeDiff.missing.length)}, unexpected ${String(runtimeDiff.unexpected.length)}).`,
    );
  }
  const typeExports = collectTypeExports(resolve("dist/index.d.ts"));
  const typeDiff = diffExpectedExports(typeExports, contract.declarationExports);
  if (typeDiff.missing.length > 0 || typeDiff.unexpected.length > 0) {
    fail(
      "root declaration export contract drifted " +
        `(missing ${String(typeDiff.missing.length)}, unexpected ${String(typeDiff.unexpected.length)}).`,
    );
  }
}

function assertBundledPayload(paths) {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const bundled = Array.isArray(manifest.bundleDependencies) ? manifest.bundleDependencies : [];
  if (bundled.length === 0) {
    fail("package.json declares no bundleDependencies — the workspace bundle would be empty.");
  }
  for (const name of bundled) {
    const shortName = name.replace(/^@oscharko-dev\//, "");
    const distPrefix = `node_modules/@oscharko-dev/${shortName}/dist/`;
    if (!paths.some((p) => p.startsWith(distPrefix))) {
      fail(
        `bundleDependencies entry ${name} ships no files under ${distPrefix} ` +
          "— the workspace bundle is incomplete (run `npm run build:packages`).",
      );
    }
  }
}

function assertRootWorkspaceContract() {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const dependencies =
    manifest.dependencies && typeof manifest.dependencies === "object" ? manifest.dependencies : {};
  const bundled = new Set(
    Array.isArray(manifest.bundleDependencies) ? manifest.bundleDependencies : [],
  );
  for (const workspaceName of listPrivateWorkspacePackages()) {
    const excludedBecause = EXPECTED_BUNDLE_EXCLUSIONS.get(workspaceName);
    const inDependencies = Object.prototype.hasOwnProperty.call(dependencies, workspaceName);
    const inBundle = bundled.has(workspaceName);
    if (excludedBecause !== undefined) {
      if (inDependencies || inBundle) {
        fail(
          `${workspaceName} is marked as an explicit bundle exclusion (${excludedBecause}) ` +
            "but is still listed in the root published-package contract.",
        );
      }
      continue;
    }
    if (!inDependencies || !inBundle) {
      fail(
        `${workspaceName} must appear in root dependencies and bundleDependencies ` +
          `(dependencies=${String(inDependencies)}, bundleDependencies=${String(inBundle)}).`,
      );
    }
  }
}

function assertWorkflowHandoffSubpath(paths) {
  for (const required of WORKFLOW_HANDOFF_DIST_FILES) {
    if (!paths.includes(required)) {
      fail(
        `workflow-handoff contract subpath is missing ${required} ` +
          "— the #186 governed handoff contract is not publishable.",
      );
    }
  }
}

function assertLocalKnowledgeDistPath(paths) {
  const required = "node_modules/@oscharko-dev/keiko-local-knowledge/dist/index.js";
  if (!paths.includes(required)) {
    fail(
      `the tarball does not include ${required} ` +
        "— keiko-local-knowledge is missing from bundleDependencies (Epic #189 O7).",
    );
  }
}

const files = packFiles();
const paths = files.map((f) => f.path);

if (!paths.some((p) => p.startsWith("dist/ui/static/"))) {
  fail("the tarball does not include dist/ui/static (run `npm run build:ui`).");
}

if (!paths.includes("dist/ui/csp-hashes.json")) {
  fail("the tarball does not include dist/ui/csp-hashes.json (run `npm run build:ui`).");
}

if (!paths.includes("NOTICE")) {
  fail("the tarball does not include NOTICE.");
}

if (!paths.includes("TRADEMARKS.md")) {
  fail("the tarball does not include TRADEMARKS.md.");
}

const cliBin = files.find((file) => file.path === "dist/cli/index.js");
if (cliBin === undefined) {
  fail("the tarball does not include dist/cli/index.js.");
}

if ((cliBin.mode & 0o111) === 0) {
  fail("dist/cli/index.js is not executable in the tarball (run `npm run prepare:bin`).");
}

// Forbidden-path rule set lives in scripts/package-surface-rules.mjs (dependency-free, unit-tested).
for (const hit of findForbiddenPaths(paths)) {
  fail(`tarball contains ${hit.label}: ${hit.path}`);
}

assertCspHashesMatchStaticHtml();
assertServerRuntimeSurface(paths);
await assertRootPublicApiContract(paths);
assertRootWorkspaceContract();
assertBundledPayload(paths);
assertWorkflowHandoffSubpath(paths);
assertLocalKnowledgeDistPath(paths);

console.log(`package-surface check passed: ${String(paths.length)} files, dist/ui/static present.`);
