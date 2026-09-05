import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";

const READINESS_PROBE_PATH = "packages/keiko-server/src/gateway-tool-calling-probe.ts";
const READINESS_PROBE = Object.freeze({
  name: "report_readiness",
  description: "Report gateway readiness.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { status: { type: "string", enum: ["ok"] } },
    required: ["status"],
  },
});
function literalValue(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literalValue);
  if (ts.isObjectLiteralExpression(node) && node.properties.every(ts.isPropertyAssignment))
    return Object.fromEntries(
      node.properties.map((property) => [
        propertyName(property),
        literalValue(property.initializer),
      ]),
    );
  return { unsupported: true };
}
function nonDispatchProbe(path, node) {
  if (path !== READINESS_PROBE_PATH) return false;
  let owner = node.parent;
  while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
  return (
    owner?.name?.text === "toolCallingBody" &&
    canonicalise(literalValue(node)) === canonicalise(READINESS_PROBE)
  );
}
export function nonDispatchProbeDisposition() {
  return {
    id: "gateway-readiness-probe",
    ownerIssue: 3406,
    disposition: "non-dispatch-capability-probe",
    source: READINESS_PROBE_PATH,
    function: "toolCallingBody",
    contractDigest: sha256Hex(canonicalise(READINESS_PROBE)),
  };
}

import { listFilesSorted } from "../stage-dev-coding-runtime.mjs";
import { checkInventoryProbes } from "./governed-tool-contract.mjs";

function propertyName(property) {
  return property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
    ? property.name.text
    : undefined;
}
function declaresRegistry(node) {
  if (!ts.isObjectLiteralExpression(node)) return false;
  const fields = new Map(
    node.properties
      .filter(ts.isPropertyAssignment)
      .map((property) => [propertyName(property), property.initializer]),
  );
  const name = fields.get("name");
  const namedSchema =
    name &&
    ts.isStringLiteralLike(name) &&
    ["parameters", "arguments", "inputSchema", "input_schema"].some((key) => fields.has(key));
  const id = fields.get("canonicalId");
  return Boolean(namedSchema || (id && ts.isStringLiteralLike(id) && id.text.startsWith("keiko.")));
}
/** Initial AST forms: literal tool/schema rows and canonical IDs. Migration closeout extends detection. */
export function scanToolRegistrySource(path, source, permittedPaths) {
  if (path.startsWith("packages/keiko-tool-catalog/src/") || permittedPaths.has(path)) return [];
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const errors = [];
  function visit(node) {
    if (declaresRegistry(node) && !nonDispatchProbe(path, node))
      errors.push(
        `tool registry outside frozen inventory: ${path}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`,
      );
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return errors;
}
function sourceRoots(root) {
  return [
    join(root, "src"),
    ...readdirSync(join(root, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, "packages", entry.name, "src")),
  ];
}
export function checkToolCatalogInventory(root) {
  const contract = JSON.parse(
    readFileSync(join(root, "docs/architecture/governed-tool-contract.v1.json"), "utf8"),
  );
  const allowed = new Set(contract.inventory.map((row) => row.path));
  for (const migration of Object.values(contract.inventoryMigrations))
    for (const replacement of migration.replacements) allowed.add(replacement.path);
  const errors = checkInventoryProbes(contract, root);
  for (const directory of sourceRoots(root)) {
    for (const file of listFilesSorted(directory)) {
      const path = relative(root, file).split(sep).join("/");
      if (
        !/\.[cm]?[jt]sx?$/u.test(path) ||
        /(?:\.test\.|\.spec\.|\.stories\.|\.d\.ts$|\/__fixtures__\/|\/__tests__\/)/u.test(path)
      )
        continue;
      errors.push(...scanToolRegistrySource(path, readFileSync(file, "utf8"), allowed));
    }
  }
  return errors;
}
