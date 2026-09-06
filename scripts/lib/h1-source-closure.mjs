// H1 evidence binds the first-party runtime closure, including shared safety helpers. Reuse the
// existing AST-based runtime import reader: type-only edges never execute, value re-exports do.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { runtimeSpecifiers, resolveRuntimeSpecifier } from "../check-browser-baseline.mjs";
import { compareStrings } from "./compare-strings.mjs";
import { GOVERNED_TOOL_CONTRACT_PINS } from "./governed-tool-contract-pins.mjs";

function sourcePath(root, path) {
  const local = relative(root, path).split(sep).join("/");
  if (!local.startsWith("packages/") || local.includes("../")) {
    throw new TypeError("H1 runtime dependency escaped the first-party source tree");
  }
  return local
    .replace(/^(packages\/[^/]+)\/dist\//u, "$1/src/")
    .replace(/\.js$/u, ".ts")
    .replace(/\.mjs$/u, ".mts");
}

function regularSourcePath(root, path) {
  const lexical = join(root, path);
  const entry = lstatSync(lexical);
  if (!entry.isFile() || entry.isSymbolicLink() || realpathSync(lexical) !== lexical) {
    throw new TypeError("H1 runtime dependency must be a regular first-party source file");
  }
  return lexical;
}

function runtimeDependency(root, importer, specifier) {
  if (specifier.startsWith(".")) return sourcePath(root, resolve(dirname(importer), specifier));
  if (!specifier.startsWith("@oscharko-dev/")) return undefined;
  return sourcePath(root, resolveRuntimeSpecifier(importer, specifier));
}

export function collectH1OwnedSourcePaths(root = process.cwd()) {
  const canonicalRoot = realpathSync(resolve(root));
  const pending = [...GOVERNED_TOOL_CONTRACT_PINS.pendingH1.ownedImplementation];
  const paths = new Set();
  const manifests = new Set(["package-lock.json"]);
  while (pending.length > 0) {
    const path = pending.pop();
    if (paths.has(path)) continue;
    paths.add(path);
    manifests.add(`packages/${path.split("/")[1]}/package.json`);
    const absolute = regularSourcePath(canonicalRoot, path);
    const text = readFileSync(absolute, "utf8");
    if (path.endsWith(".json")) continue;
    for (const specifier of runtimeSpecifiers(absolute, text)) {
      const dependency = runtimeDependency(canonicalRoot, absolute, specifier);
      if (dependency !== undefined) pending.push(dependency);
    }
  }
  // The lockfile binds third-party runtime implementations; manifests bind workspace export maps.
  const owned = [...new Set([...paths, ...manifests])].sort(compareStrings);
  for (const path of owned) regularSourcePath(canonicalRoot, path);
  return owned;
}
