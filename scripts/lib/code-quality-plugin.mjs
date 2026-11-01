import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const POLICY_TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const POLICY_PLUGIN_ROOT = join(POLICY_TOOL_ROOT, "node_modules/oxlint-plugin-anti-slop");

export function policyPluginSources(directory = join(POLICY_PLUGIN_ROOT, "src"), prefix = "src") {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isSymbolicLink()) throw new TypeError("unsafe-upstream-source");
      const path = `${prefix}/${entry.name}`;
      return entry.isDirectory() ? policyPluginSources(join(directory, entry.name), path) : [path];
    })
    .sort((left, right) => left.localeCompare(right));
}

export function compilePolicyPluginDirectory(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new TypeError("unsafe-upstream-source");
    const input = join(source, entry.name);
    const output = join(target, entry.name);
    if (entry.isDirectory()) compilePolicyPluginDirectory(input, output);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
      compileFile(input, output);
  }
}

function compileFile(source, target) {
  const result = ts.transpileModule(readFileSync(source, "utf8"), {
    fileName: source,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.ESNext,
      rewriteRelativeImportExtensions: true,
      sourceMap: false,
      removeComments: false,
    },
  });
  if (result.diagnostics.some((entry) => entry.category === ts.DiagnosticCategory.Error)) {
    throw new TypeError("upstream-transpile-failed");
  }
  writeFileSync(target.slice(0, -3) + ".js", result.outputText);
}

// Node intentionally refuses to strip TS in node_modules. Compile immutable upstream source with
// Keiko's existing compiler; the temporary ESM directory resolves the same locked plugin bridge.
export function withCompiledPolicyPlugin(callback) {
  const source = dirname(fileURLToPath(import.meta.resolve("oxlint-plugin-anti-slop")));
  const temporary = mkdtempSync(join(POLICY_TOOL_ROOT, "node_modules/.keiko-policy-"));
  try {
    writeFileSync(join(temporary, "package.json"), JSON.stringify({ type: "module" }));
    compilePolicyPluginDirectory(source, join(temporary, "src"));
    return callback(temporary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
