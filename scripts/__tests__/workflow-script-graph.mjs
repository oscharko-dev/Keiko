import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { parse } from "yaml";

// One answer, shared by the workflow guard tests, to "which repository scripts does a workflow run,
// and what do they import". release-portable-assets-workflow.test.mjs pins per-job dist
// provisioning with it; workflow-script-module-graph.test.mjs pins that every such script resolves
// its relative imports the way plain node does.

const RELATIVE_IMPORT =
  /\b(?:import|export)\b([^;]*?)\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gu;
const CODE_EXTENSION = /\.(?:mjs|cjs|js|ts|mts)$/u;

function rootPackageScripts(root) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
}

export function repositoryScriptsIn(command, scripts = rootPackageScripts(process.cwd())) {
  const found = [...String(command).matchAll(/\bnode ((?:scripts|native)\/[\w./-]+\.mjs)/gu)].map(
    (match) => match[1],
  );
  for (const [, name] of String(command).matchAll(/\bnpm run ([\w:.-]+)/gu)) {
    const script = scripts[name];
    if (typeof script === "string") found.push(...repositoryScriptsIn(script, scripts));
  }
  return found;
}

export function workflowEntryScripts(workflowsDir = ".github/workflows") {
  const scripts = rootPackageScripts(process.cwd());
  const entries = new Set();
  for (const name of readdirSync(workflowsDir).filter((file) => file.endsWith(".yml"))) {
    const document = parse(readFileSync(join(workflowsDir, name), "utf8"));
    for (const job of Object.values(document.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        for (const script of repositoryScriptsIn(step.run ?? "", scripts)) entries.add(script);
      }
    }
  }
  return [...entries].sort();
}

// Static relative imports of one module. `import type` / `export type` are erased before node
// resolves anything, so they are not runtime edges.
function relativeImports(file) {
  const edges = [];
  for (const match of readFileSync(file, "utf8").matchAll(RELATIVE_IMPORT)) {
    const clause = match[1] ?? "";
    const specifier = match[2] ?? match[3];
    if (!specifier.startsWith(".")) continue;
    if (/^\s*type\b/u.test(clause)) continue;
    edges.push({ specifier, target: resolve(dirname(file), specifier) });
  }
  return edges;
}

function isRegularFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

function isBuiltOutput(path) {
  return path.split(/[\\/]/u).includes("dist");
}

export function importGraphReachesDist(entry, seen = new Set()) {
  const file = resolve(entry);
  if (seen.has(file) || !isRegularFile(file)) return false;
  seen.add(file);
  for (const { target } of relativeImports(file)) {
    if (isBuiltOutput(target)) return true;
    if (!target.endsWith(".ts") && importGraphReachesDist(target, seen)) return true;
  }
  return false;
}

// Every relative specifier in the graph that plain node cannot load as written: node's ESM loader
// adds no extension and never rewrites ".js" to ".ts", while vitest does both. Built output is left
// to the per-job provisioning pin.
export function unresolvableImports(entry, root = process.cwd()) {
  const unresolved = [];
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const { specifier, target } of relativeImports(file)) {
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
