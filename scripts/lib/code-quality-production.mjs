import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import ts from "typescript";

function localPath(root, path) {
  const result = relative(root, path).replaceAll("\\", "/");
  if (isAbsolute(result) || result === ".." || result.startsWith("../")) {
    throw new TypeError("production-source-escape");
  }
  return result;
}

function unwrappedExpression(node) {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node))
  )
    node = node.expression;
  return node;
}

function valueImport(node, options) {
  const clause = node.importClause;
  if (clause?.isTypeOnly) return undefined;
  const bindings = clause?.namedBindings;
  if (
    !clause?.name &&
    bindings &&
    ts.isNamedImports(bindings) &&
    onlyTypeBindings(bindings) &&
    !options.verbatimModuleSyntax
  ) {
    return undefined;
  }
  return node.moduleSpecifier;
}

function onlyTypeBindings(bindings) {
  return bindings.elements.length > 0 && bindings.elements.every((entry) => entry.isTypeOnly);
}

function valueExport(node, options) {
  if (node.isTypeOnly) return undefined;
  const bindings = node.exportClause;
  if (
    bindings &&
    ts.isNamedExports(bindings) &&
    onlyTypeBindings(bindings) &&
    !options.verbatimModuleSyntax
  )
    return undefined;
  return node.moduleSpecifier;
}

function runtimeImport(node, requireAliases, options) {
  if (ts.isImportDeclaration(node)) return valueImport(node, options);
  if (ts.isExportDeclaration(node)) return valueExport(node, options);
  if (ts.isImportEqualsDeclaration(node)) return importEqualsValue(node);
  if (ts.isCallExpression(node) && isRuntimeLoader(node.expression, requireAliases)) {
    return node.arguments[0];
  }
  return undefined;
}

function importEqualsValue(node) {
  return !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)
    ? node.moduleReference.expression
    : undefined;
}

function isRuntimeLoader(expression, aliases) {
  expression = unwrappedExpression(expression);
  return (
    expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(expression) && aliases.has(expression.text))
  );
}

function constBindings(source) {
  const strings = new Map();
  const loaders = new Set(["require"]);
  const links = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of node.declarations) recordBinding(declaration, strings, links);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const queue = [...strings.keys(), ...loaders];
  for (const name of queue) propagateBinding(name, links, strings, loaders, queue);
  return { strings, loaders };
}

function recordBinding(node, strings, links) {
  if (!ts.isIdentifier(node.name) || !node.initializer) return;
  const name = node.name.text;
  const value = unwrappedExpression(node.initializer);
  if (ts.isStringLiteralLike(value)) {
    const values = strings.get(name) ?? new Set();
    values.add(value.text);
    strings.set(name, values);
  }
  if (ts.isIdentifier(value)) {
    const destinations = links.get(value.text) ?? new Set();
    destinations.add(name);
    links.set(value.text, destinations);
  }
}

function propagateBinding(name, links, strings, loaders, queue) {
  for (const destination of links.get(name) ?? []) {
    const values = strings.get(destination) ?? new Set();
    const previousSize = values.size;
    for (const value of strings.get(name) ?? []) values.add(value);
    strings.set(destination, values);
    const newLoader = loaders.has(name) && !loaders.has(destination);
    if (newLoader) loaders.add(destination);
    if (values.size !== previousSize || newLoader) queue.push(destination);
  }
}

function runtimeSpecifiers(path, text, options) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length > 0) throw new TypeError("invalid-production-source");
  const bindings = constBindings(source);
  const result = new Set();
  const visit = (node) => {
    const value = unwrappedExpression(runtimeImport(node, bindings.loaders, options));
    if (value && ts.isStringLiteralLike(value)) result.add(value.text);
    if (value && ts.isIdentifier(value)) {
      // Conservative union avoids shadowed-name ambiguity becoming a filename exemption.
      for (const text of bindings.strings.get(value.text) ?? []) result.add(text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...result];
}

function manifestTargets(value) {
  if (typeof value === "string") return [value];
  if (value === undefined || value === null) return [];
  if (typeof value !== "object") throw new TypeError("invalid-production-target");
  return Object.values(value).flatMap(manifestTargets);
}

export function emittedSources(root, contexts, files) {
  const outputs = new Map();
  for (const config of contexts.values()) {
    if (config.options.noEmit) continue;
    for (const source of config.fileNames)
      recordEmittedSource(root, config, source, files, outputs);
  }
  return outputs;
}

function recordEmittedSource(root, config, source, files, outputs) {
  const path = localPath(root, source);
  if (!files.has(path) || /\.d\.[cm]?ts$/u.test(path)) return;
  for (const output of ts.getOutputFileNames(config, source, !ts.sys.useCaseSensitiveFileNames)) {
    const emitted = localPath(root, output);
    const previous = outputs.get(emitted);
    if (previous !== undefined && previous !== path) {
      throw new TypeError("ambiguous-production-output");
    }
    outputs.set(emitted, path);
  }
}

function publicSources(root, workspaces, outputs, files) {
  const manifests = [
    { dir: root, manifest: JSON.parse(readFileSync(join(root, "package.json"))) },
    ...workspaces,
  ];
  return manifests.flatMap(({ dir, manifest }) => {
    const targets = [manifest.exports, manifest.main, manifest.bin].flatMap(manifestTargets);
    return targets
      .filter((target) => !/\.d\.[cm]?ts$/u.test(target))
      .map((target) => {
        const path = localPath(root, join(dir, target));
        const source = files.has(path) ? path : outputs.get(path);
        if (source === undefined && /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/u.test(target)) {
          throw new TypeError("unmapped-production-export");
        }
        return source;
      })
      .filter((path) => path !== undefined);
  });
}

function sourceContext(path, contexts) {
  const owners = [...contexts.keys()].filter(
    (directory) => directory === "" || path.startsWith(`${directory}/`),
  );
  owners.sort((left, right) => right.length - left.length);
  return contexts.get(owners[0]);
}

function resolvedSource(root, path, specifier, options, files, outputs, cache) {
  const result = ts.resolveModuleName(
    specifier,
    join(root, path),
    options,
    ts.sys,
    cache,
  ).resolvedModule;
  if (result === undefined) {
    return undefined;
  }
  const absolute = result.resolvedFileName;
  const relativeName = relative(root, absolute).replaceAll("\\", "/");
  const mapped = outputs.get(relativeName);
  if (mapped !== undefined) return mapped;
  if (files.has(relativeName) && !/\.d\.[cm]?ts$/u.test(relativeName)) return relativeName;
  if (result.isExternalLibraryImport || /(?:^|\/)node_modules\//u.test(relativeName))
    return undefined;
  const resolved = localPath(root, absolute);
  if (/\.d\.[cm]?ts$/u.test(resolved) || resolved.endsWith(".json")) return undefined;
  throw new TypeError("unaccounted-production-import");
}

// Reconcile provisional test/documentary paths against actual value edges and public emission.
// This parses source syntax once; it does not perform another analyzer or type-checker evaluation.
export function reconcileProductionSources(input) {
  const { root, files, contexts, workspaces, safeFile, classify } = input;
  const byPath = new Map(files.map((file) => [file.path, file]));
  const outputs = input.outputs ?? emittedSources(root, contexts, byPath);
  const queue = [
    ...files.filter((file) => file.production).map((file) => file.path),
    ...publicSources(root, workspaces, outputs, byPath),
  ];
  const visited = new Set();
  const promoted = [];
  const caches = new Map();
  for (const path of queue) {
    if (visited.has(path)) continue;
    visited.add(path);
    const file = byPath.get(path);
    safeFile(root, path);
    if (!file.production) {
      Object.assign(file, classify(path), { reason: "production-runtime-reachable" });
      promoted.push(path);
    }
    const config = sourceContext(path, contexts);
    if (!caches.has(config))
      caches.set(
        config,
        ts.createModuleResolutionCache(root, (value) => value, config.options),
      );
    const text = readFileSync(join(root, path), "utf8");
    if (createHash("sha256").update(text).digest("hex") !== file.sha256) {
      throw new TypeError("production-source-changed");
    }
    for (const specifier of runtimeSpecifiers(path, text, config.options)) {
      const resolved = resolvedSource(
        root,
        path,
        specifier,
        config.options,
        byPath,
        outputs,
        caches.get(config),
      );
      if (resolved !== undefined) queue.push(resolved);
    }
  }
  return { promoted: promoted.toSorted((left, right) => left.localeCompare(right)) };
}
