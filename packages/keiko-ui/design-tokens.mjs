import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import postcss from "postcss";

const SOURCE_NAMES = new Set(
  ["tokens", "semantic-tokens", "editor-tokens", "ai", "data", "dataviz", "inputs", "nav"].map(
    (name) => `design-system/keiko-${name}.css`,
  ),
);
export const PRODUCT_TOKEN_OUTPUT = "packages/keiko-ui/dist/styles/product-tokens.css";

function sourceConditions(node) {
  const result = [];
  for (let parent = node.parent; parent?.type !== "root"; parent = parent?.parent) {
    if (parent?.type === "atrule") result.unshift({ name: parent.name, params: parent.params });
    if (parent === undefined) break;
  }
  return result;
}

function referenceKey(selector, conditions, property) {
  return JSON.stringify([selector.replace(/\s+/gu, " ").trim(), conditions, property]);
}

function sourceDeclarations(root, source) {
  if (!SOURCE_NAMES.has(source)) throw new Error("Unknown canonical token source");
  const index = new Map();
  postcss.parse(readFileSync(join(root, source), "utf8")).walkRules((rule) => {
    rule.walkDecls((declaration) => {
      if (!declaration.prop.startsWith("--")) return;
      const key = referenceKey(rule.selector, sourceConditions(rule), declaration.prop);
      if (index.has(key)) throw new Error("Ambiguous canonical token binding");
      index.set(key, { value: declaration.value, important: declaration.important });
    });
  });
  return index;
}

function tokenDeclaration(root, declaration, sources) {
  if (declaration.comment !== undefined) return postcss.comment({ text: declaration.comment });
  if (declaration.source === undefined)
    return postcss.decl({
      prop: declaration.property,
      value: declaration.value,
      important: declaration.important,
    });
  if (!sources.has(declaration.source))
    sources.set(declaration.source, sourceDeclarations(root, declaration.source));
  const value = sources
    .get(declaration.source)
    .get(referenceKey(declaration.selector, declaration.conditions, declaration.property));
  if (value === undefined) throw new Error("Canonical token binding is unavailable");
  return postcss.decl({ prop: declaration.property, ...value });
}

export function compileProductDesignTokens(root) {
  const manifest = JSON.parse(
    readFileSync(join(root, "design-system/product-token-bindings.json"), "utf8"),
  );
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.rules))
    throw new Error("Invalid product token bindings");
  const output = postcss.root();
  const sources = new Map();
  for (const entry of manifest.rules) {
    const rule = postcss.rule({ selector: entry.selector });
    rule.raws.semicolon = true;
    for (const declaration of entry.declarations)
      rule.append(tokenDeclaration(root, declaration, sources));
    let parent = output;
    for (const condition of entry.conditions) {
      const last = parent.last;
      const existing =
        last?.type === "atrule" && last.name === condition.name && last.params === condition.params;
      if (!existing) parent.append(postcss.atRule(condition));
      parent = parent.last;
    }
    parent.append(rule);
  }
  output.walk((node) => {
    let depth = 0;
    for (let parent = node.parent; parent?.type !== "root"; parent = parent?.parent) {
      if (parent === undefined) break;
      depth += 1;
    }
    node.raws.before = node === output.first ? "" : "\n" + "  ".repeat(depth);
    if (node.type === "decl") node.raws.between = ": ";
    if (node.type === "rule" || node.type === "atrule") {
      node.raws.between = " ";
      node.raws.after = "\n" + "  ".repeat(depth);
    }
  });
  return output.toString();
}

export function writeProductDesignTokens(root) {
  const css = compileProductDesignTokens(root);
  const output = join(root, PRODUCT_TOKEN_OUTPUT);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, css);
}
