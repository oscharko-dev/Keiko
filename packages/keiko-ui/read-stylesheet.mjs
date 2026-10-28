import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { compileProductDesignTokens, PRODUCT_TOKEN_OUTPUT } from "./design-tokens.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function importTarget(parameters) {
  const match = /^\s*["']([^"']+)["']\s*$/u.exec(parameters);
  if (match === null) throw new Error("Unsupported stylesheet import form");
  return match[1];
}

function assertStylesheetContainment(path) {
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new Error("Stylesheet source escapes repository");
}

function containedPath(file, root) {
  const candidate = resolve(file);
  assertStylesheetContainment(relative(root, candidate));
  const resolved =
    candidate === resolve(root, PRODUCT_TOKEN_OUTPUT) ? candidate : realpathSync(candidate);
  const path = relative(root, resolved);
  assertStylesheetContainment(path);
  return resolved;
}

function composedScope(rule) {
  const match = /^([A-Za-z0-9_-]+)(?:\s+from\s+["']([^"']+)["'])?$/u.exec(rule.value);
  if (
    match === null ||
    rule.parent.type !== "rule" ||
    !/^\.[A-Za-z0-9_-]+$/u.test(rule.parent.selector)
  ) {
    throw new Error("Unsupported CSS Module composition");
  }
  return { name: match[1], file: match[2], selector: rule.parent.selector };
}

function expandComposedScopes(sheet, file, root, active) {
  const inherited = [];
  sheet.walkDecls("composes", (declaration) => {
    const binding = composedScope(declaration);
    const shared =
      binding.file === undefined
        ? sheet
        : postcss.parse(expandedStylesheet(resolve(dirname(file), binding.file), root, active));
    let found = false;
    shared.walkRules((rule) => {
      const marker = new RegExp(String.raw`\.${binding.name}(?![\w-])`, "gu");
      if (!marker.test(rule.selector)) return;
      if (rule.parent.type !== "root")
        throw new Error("Conditional CSS Module composition needs explicit projection");
      found = true;
      if (rule.nodes.some((node) => node.type === "decl" && node.prop === "composes"))
        throw new Error("Nested local CSS composition needs explicit projection");
      const projected = rule.clone();
      projected.selector = rule.selector.replace(marker, binding.selector);
      inherited.push(projected);
    });
    if (!found) throw new Error("Composed CSS Module scope is unavailable");
    declaration.remove();
  });
  sheet.prepend(...inherited);
}

function expandedStylesheet(file, root, active) {
  const path = containedPath(file, root);
  if (active.has(path)) throw new Error("Cyclic stylesheet import");
  active.add(path);
  const source =
    path === resolve(root, PRODUCT_TOKEN_OUTPUT)
      ? compileProductDesignTokens(root)
      : readFileSync(path, "utf8");
  const sheet = postcss.parse(source);
  sheet.walkAtRules("import", (rule) => {
    if (rule.parent.type !== "root") throw new Error("Stylesheet import must be top-level");
    const child = resolve(dirname(path), importTarget(rule.params));
    const imported = postcss.parse(expandedStylesheet(child, root, active));
    rule.replaceWith(...imported.nodes);
  });
  expandComposedScopes(sheet, path, root, active);
  active.delete(path);
  return sheet.toString();
}

/** Resolve local standard CSS imports, using the same token producer as the Next build. */
export function readStylesheet(file, root = REPOSITORY_ROOT) {
  const physicalRoot = realpathSync(root);
  const logical = relative(resolve(root), resolve(file));
  const withinLogical = logical !== ".." && !logical.startsWith(`..${sep}`) && !isAbsolute(logical);
  const position = withinLogical ? logical : relative(physicalRoot, resolve(file));
  assertStylesheetContainment(position);
  return expandedStylesheet(resolve(physicalRoot, position), physicalRoot, new Set());
}
