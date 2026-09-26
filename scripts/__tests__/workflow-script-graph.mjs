import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { parse } from "yaml";

// One answer, shared by the workflow guard tests, to "which repository scripts does a workflow step
// run, does their import graph load built workspace output, does an earlier step build it, and does
// every relative import resolve the way plain node resolves it".

// Named and namespace forms, dynamic import(), and the bare side-effect form `import "x";`.
const IMPORT_STATEMENT =
  /\b(?:import|export)\b([^;]*?)\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/gu;
// A .cjs module in the graph loads its neighbours through require(); node resolves those literally too.
const REQUIRE_CALL = /\brequire\(\s*["']([^"']+)["']\s*\)/gu;
const WORKSPACE_SPECIFIER = /^(@[^/]+\/[^/]+)(\/.+)?$/u;
// A step provides packages/*/dist when it builds the packages itself or stages the product, which
// runs `npm run build` on the way (stage-portable-runtime.mjs) before any later step can execute.
const BUILT_PACKAGE_PROVIDERS = [
  /\bnpm run build:packages\b/u,
  /\bnpm run build\b(?!:)/u,
  /\brun-portable-assets-stage\.mjs\b/u,
];
const NPM_RUN = /\bnpm run(?:-script)?(?:\s+-s)?\s+([\w:.-]+)/gu;
const NPM_TEST = /\bnpm (?:test|t)\b/u;
const CODE_EXTENSION = /\.(?:mjs|cjs|js|ts|mts)$/u;

export function rootPackageScripts(root = process.cwd()) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
}

export function repositoryScriptsIn(command, scripts = rootPackageScripts()) {
  const found = [...String(command).matchAll(/\bnode ((?:scripts|native)\/[\w./-]+\.mjs)/gu)].map(
    (match) => match[1],
  );
  for (const [, name] of String(command).matchAll(NPM_RUN)) {
    const script = scripts[name];
    if (typeof script === "string") found.push(...repositoryScriptsIn(script, scripts));
  }
  return found;
}

// A build hidden behind an npm script still provides the output: `npm test` and `npm run typecheck`
// both run build:packages first.
export function providesBuiltPackages(command, scripts = rootPackageScripts(), depth = 0) {
  const text = String(command ?? "");
  if (BUILT_PACKAGE_PROVIDERS.some((pattern) => pattern.test(text))) return true;
  if (depth > 8) return false;
  const nested = [...text.matchAll(NPM_RUN)].map((match) => scripts[match[1]]);
  if (NPM_TEST.test(text)) nested.push(scripts.test);
  return nested.some(
    (script) => typeof script === "string" && providesBuiltPackages(script, scripts, depth + 1),
  );
}

function isRegularFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

// An unreadable manifest must stop the walk: skipping it would hide every import of that package.
function readWorkspaceManifest(manifestPath) {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`unreadable workspace manifest: ${manifestPath}`);
  }
}

function workspacePackages(root) {
  const packages = new Map();
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return packages;
  for (const dir of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, dir, "package.json");
    if (!isRegularFile(manifestPath)) continue;
    const manifest = readWorkspaceManifest(manifestPath);
    packages.set(manifest.name, { dir: join(packagesDir, dir), manifest });
  }
  return packages;
}

function conditionTarget(value) {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return undefined;
  return conditionTarget(value.import ?? value.node ?? value.default ?? value.require);
}

function wildcardExportTarget(exports, subpath) {
  for (const [key, value] of Object.entries(exports)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      const match = subpath.slice(prefix.length, subpath.length - suffix.length);
      return conditionTarget(value)?.replaceAll("*", match);
    }
  }
  return undefined;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Without "exports", node loads subpaths from the package root and the root from "main".
function legacyTarget(manifest, subpath) {
  if (subpath !== ".") return subpath;
  if (manifest.main === undefined) return "index.js";
  return typeof manifest.main === "string" ? manifest.main : undefined;
}

function exportTarget(manifest, subpath) {
  const { exports } = manifest;
  if (exports === undefined) return legacyTarget(manifest, subpath);
  if (typeof exports === "string") return subpath === "." ? exports : undefined;
  if (!isPlainObject(exports)) return undefined;
  return exports[subpath] === undefined
    ? wildcardExportTarget(exports, subpath)
    : conditionTarget(exports[subpath]);
}

function isInside(root, path) {
  const offset = relative(root, path);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

// Where node would load a workspace package specifier from, or undefined for any other package.
// A workspace import that resolves to no file inside its package cannot be proven to load without
// a build, so it counts as built output and the provisioning pin fails closed.
function workspaceImportTarget(specifier, packages) {
  const match = WORKSPACE_SPECIFIER.exec(specifier);
  const workspace = match === null ? undefined : packages.get(match[1]);
  if (workspace === undefined) return undefined;
  const target = exportTarget(workspace.manifest, `.${match[2] ?? ""}`);
  const resolved = typeof target === "string" ? resolve(workspace.dir, target) : undefined;
  return resolved !== undefined && isInside(workspace.dir, resolved)
    ? resolved
    : join(workspace.dir, "dist", "(unresolvable)");
}

function isBuiltOutput(path) {
  return path.split(/[\\/]/u).includes("dist");
}

// Runtime import edges of one module; `import type` / `export type` are erased before node loads it.
function runtimeImportTargets(file, packages) {
  const targets = [];
  for (const match of readFileSync(file, "utf8").matchAll(IMPORT_STATEMENT)) {
    if (/^\s*type\b/u.test(match[1] ?? "")) continue;
    const specifier = match[2] ?? match[3] ?? match[4];
    const target = specifier.startsWith(".")
      ? resolve(dirname(file), specifier)
      : workspaceImportTarget(specifier, packages);
    if (target !== undefined) targets.push(target);
  }
  return targets;
}

// True when loading `entry` with plain node needs packages/*/dist: through a relative path into
// built output, or through a workspace package whose export resolves there, at any depth.
export function importGraphReachesDist(entry, root = process.cwd()) {
  const packages = workspacePackages(root);
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !isRegularFile(file)) return false;
    seen.add(file);
    return runtimeImportTargets(file, packages).some(
      (target) => isBuiltOutput(target) || visit(target),
    );
  };
  return visit(resolve(root, entry));
}

export function workflowJobs(workflowsDir = ".github/workflows") {
  return readdirSync(workflowsDir)
    .filter((file) => file.endsWith(".yml"))
    .sort()
    .flatMap((file) => {
      const document = parse(readFileSync(join(workflowsDir, file), "utf8"));
      return Object.entries(document.jobs ?? {}).map(([name, job]) => ({ file, name, job }));
    });
}

export function workflowEntryScripts(workflowsDir = ".github/workflows") {
  const scripts = rootPackageScripts();
  const entries = new Set();
  for (const { job } of workflowJobs(workflowsDir)) {
    for (const step of job.steps ?? []) {
      for (const script of repositoryScriptsIn(step.run ?? "", scripts)) entries.add(script);
    }
  }
  return [...entries].sort();
}

// Relative runtime import and require() edges of one module, exactly as written.
function relativeImportEdges(file) {
  const source = readFileSync(file, "utf8");
  const specifiers = [];
  for (const match of source.matchAll(IMPORT_STATEMENT)) {
    if (/^\s*type\b/u.test(match[1] ?? "")) continue;
    specifiers.push(match[2] ?? match[3] ?? match[4]);
  }
  for (const match of source.matchAll(REQUIRE_CALL)) specifiers.push(match[1]);
  return specifiers
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => ({ specifier, target: resolve(dirname(file), specifier) }));
}

// Every relative specifier in the graph that plain node cannot load as written: node's ESM loader
// adds no extension and never rewrites ".js" to ".ts", while vitest does both. Built output is left
// to the provisioning pin.
export function unresolvableImports(entry, root = process.cwd()) {
  const unresolved = [];
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const { specifier, target } of relativeImportEdges(file)) {
      if (isBuiltOutput(target)) continue;
      if (!isRegularFile(target)) {
        unresolved.push({ from: relative(root, file), specifier });
        continue;
      }
      if (CODE_EXTENSION.test(target)) visit(target);
    }
  };
  const start = resolve(root, entry);
  if (!isRegularFile(start)) return [{ from: entry, specifier: "(entry point missing)" }];
  visit(start);
  return unresolved;
}
