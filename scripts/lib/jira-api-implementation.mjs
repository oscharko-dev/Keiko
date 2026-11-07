// Offline implementation accounting; these facts cannot register a tool or authorize a request.
import { existsSync, readFileSync } from "node:fs";
import { URL } from "node:url";
import ts from "typescript";
import { sha256 } from "./digest.mjs";
import { requireJiraInventory as requireValid } from "./jira-api-sources.mjs";

export const JIRA_REGISTRY_SOURCE = "packages/keiko-server/src/atlassian/jiraOperationRegistry.ts";
export const JIRA_REGISTRY_FILE = new URL(`../../${JIRA_REGISTRY_SOURCE}`, import.meta.url);

const BUILDER_FORMS = {
  read: { parameters: 3, returned: ["GET", "read", 0, 1, 2] },
  write: { parameters: 4, returned: [0, "write", 1, 2, 3] },
  issueRead: { parameters: 2, returned: ["GET", "read", 0, "visible-issues", 1] },
};

function nativeDeclaration(ast) {
  const declarations = ast.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === "NATIVE");
  requireValid(declarations.length === 1, "registry-native-owner");
  const initializer = declarations[0].initializer;
  requireValid(
    initializer !== undefined && ts.isObjectLiteralExpression(initializer),
    "registry-native-shape",
  );
  return initializer;
}
function hasIdentifier(node, name) {
  if (ts.isIdentifier(node) && node.text === name) return true;
  return ts.forEachChild(node, (child) => hasIdentifier(child, name)) === true;
}
function changesBuilder(ast, name) {
  function changed(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      hasIdentifier(node.left, name)
    )
      return true;
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      hasIdentifier(node.operand, name)
    )
      return true;
    return ts.forEachChild(node, changed) === true;
  }
  return (
    changed(ast) ||
    ast.statements.some(
      (node) =>
        (ts.isVariableStatement(node) &&
          node.declarationList.declarations.some((declaration) =>
            hasIdentifier(declaration.name, name),
          )) ||
        (ts.isImportDeclaration(node) &&
          node.importClause !== undefined &&
          hasIdentifier(node.importClause, name)),
    )
  );
}
function builderParameters(declaration, name) {
  const parameters = declaration.parameters;
  requireValid(
    parameters.length === BUILDER_FORMS[name].parameters,
    "registry-native-builder-parameters",
  );
  for (const [index, parameter] of parameters.entries()) {
    requireValid(
      ts.isIdentifier(parameter.name) &&
        parameter.dotDotDotToken === undefined &&
        parameter.questionToken === undefined &&
        (parameter.modifiers?.length ?? 0) === 0,
      "registry-native-builder-parameters",
    );
    const last = index === parameters.length - 1;
    requireValid(
      last ? nativeRootDefault(parameter.initializer) : parameter.initializer === undefined,
      "registry-native-builder-default",
    );
  }
  const names = parameters.map((parameter) => parameter.name.text);
  requireValid(new Set(names).size === names.length, "registry-native-builder-parameters");
  return names;
}
function nativeRootDefault(initializer) {
  return (
    initializer !== undefined &&
    ts.isStringLiteralLike(initializer) &&
    initializer.text === "/rest/api/2"
  );
}
function builderReturn(declaration, name, parameters) {
  const body = declaration.body;
  requireValid(
    body !== undefined && body.statements.length === 1 && ts.isReturnStatement(body.statements[0]),
    "registry-native-builder-body",
  );
  const returned = body.statements[0].expression;
  requireValid(
    returned !== undefined && ts.isArrayLiteralExpression(returned),
    "registry-native-builder-return",
  );
  const expected = BUILDER_FORMS[name].returned.map((slot) =>
    typeof slot === "number" ? ["identifier", parameters[slot]] : ["literal", slot],
  );
  requireValid(
    returned.elements.length === expected.length &&
      returned.elements.every((element, index) => {
        const [kind, value] = expected[index];
        return (
          (kind === "literal" ? ts.isStringLiteralLike(element) : ts.isIdentifier(element)) &&
          element.text === value
        );
      }),
    "registry-native-builder-return",
  );
}
function verifyBuilder(ast, name, verified) {
  if (verified.has(name)) return;
  const declarations = ast.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  requireValid(
    declarations.length === 1 && !changesBuilder(ast, name),
    "registry-native-builder-owner",
  );
  const declaration = declarations[0];
  requireValid(
    (declaration.modifiers?.length ?? 0) === 0 &&
      declaration.asteriskToken === undefined &&
      (declaration.typeParameters?.length ?? 0) === 0,
    "registry-native-builder-shape",
  );
  builderReturn(declaration, name, builderParameters(declaration, name));
  verified.add(name);
}
function literalTuple(tuple) {
  requireValid(
    (tuple.length === 4 || tuple.length === 5) && tuple.every(ts.isStringLiteralLike),
    "registry-native-tuple",
  );
  return tuple.map((node) => node.text);
}
function nativeTuple(initializer, ast, verified) {
  if (ts.isArrayLiteralExpression(initializer)) return literalTuple(initializer.elements);
  requireValid(
    ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      Object.hasOwn(BUILDER_FORMS, initializer.expression.text) &&
      initializer.typeArguments === undefined,
    "registry-native-builder-call",
  );
  const name = initializer.expression.text;
  verifyBuilder(ast, name, verified);
  const count = BUILDER_FORMS[name].parameters - 1;
  requireValid(
    (initializer.arguments.length === count || initializer.arguments.length === count + 1) &&
      initializer.arguments.every(ts.isStringLiteralLike),
    "registry-native-builder-arguments",
  );
  const args = initializer.arguments.map((node) => node.text);
  if (args.length === count) args.push("/rest/api/2");
  return BUILDER_FORMS[name].returned.map((slot) => (typeof slot === "number" ? args[slot] : slot));
}
function nativeEntry(property, ast, verified) {
  requireValid(
    ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.name),
    "registry-native-property",
  );
  const [method, effect, path, permissionPolicy, root = "/rest/api/2"] = nativeTuple(
    property.initializer,
    ast,
    verified,
  );
  requireValid(
    new Set(["GET", "POST", "PUT", "DELETE"]).has(method) && new Set(["read", "write"]).has(effect),
    "registry-native-effect",
  );
  requireValid(
    new Set(["/rest/api/2", "/rest/agile/1.0"]).has(root) &&
      path.startsWith("/") &&
      !path.includes("?"),
    "registry-native-path",
  );
  return {
    tool: property.name.text,
    identity: `${method} ${root}${path}`,
    effect,
    permissionPolicy,
  };
}
/** Parse only literals and verified closed builder declarations. Never import/evaluate the runtime. */
export function readJiraNativeRegistry(file = JIRA_REGISTRY_FILE) {
  const bytes = readFileSync(file);
  const ast = ts.createSourceFile(
    JIRA_REGISTRY_SOURCE,
    bytes.toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  requireValid(ast.parseDiagnostics.length === 0, "registry-native-syntax");
  const verified = new Set();
  const entries = nativeDeclaration(ast)
    .properties.map((property) => nativeEntry(property, ast, verified))
    .sort((a, b) => a.tool.localeCompare(b.tool, "en"));
  requireValid(
    entries.length > 0 && new Set(entries.map((entry) => entry.tool)).size === entries.length,
    "registry-native-duplicate",
  );
  return { sourceFile: JIRA_REGISTRY_SOURCE, sha256: sha256(bytes), entries };
}
function textList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.length > 0)
  );
}
function notesFor(capability) {
  requireValid(
    capability !== undefined && typeof capability === "object" && capability !== null,
    "current-capability-notes",
  );
  requireValid(
    typeof capability.constraints === "string" && capability.constraints.length > 0,
    "current-capability-constraints",
  );
  requireValid(
    textList(capability.sourceFiles) && textList(capability.testFiles),
    "current-capability-references",
  );
  for (const path of [...capability.sourceFiles, ...capability.testFiles])
    requireValid(
      /^(?:packages|scripts|tests)\/[A-Za-z0-9_./-]+$/u.test(path) &&
        !path.split("/").includes("..") &&
        existsSync(new URL(`../../${path}`, import.meta.url)),
      "current-capability-path",
    );
  return {
    constraints: capability.constraints,
    sourceFiles: capability.sourceFiles,
    testFiles: capability.testFiles,
  };
}
function capabilitiesFor(ledger, registry) {
  const notes = ledger.currentCapabilities;
  requireValid(
    notes !== undefined && typeof notes === "object" && !Array.isArray(notes),
    "current-capabilities",
  );
  requireValid(
    JSON.stringify(Object.keys(notes).sort()) ===
      JSON.stringify(registry.entries.map((entry) => entry.tool).sort()),
    "current-capability-completeness",
  );
  return Object.fromEntries(
    registry.entries.map(({ tool, ...entry }) => [
      tool,
      { ...entry, kind: "constrained-tool", ...notesFor(notes[tool]) },
    ]),
  );
}
function capabilityIds(identity, capabilities) {
  return Object.entries(capabilities)
    .filter(([, capability]) => capability.identity === identity)
    .map(([tool]) => tool)
    .sort();
}
/** Update only implementation mappings; source provenance, historical facts and qualification stay intact. */
export function reconcileJiraImplementation(ledger, registry) {
  const currentCapabilities = capabilitiesFor(ledger, registry);
  const identities = new Set(ledger.operations.map((row) => row.identity));
  requireValid(
    registry.entries.every((entry) => identities.has(entry.identity)),
    "registry-operation-not-published",
  );
  const { operations, ...historical } = ledger;
  return {
    ...historical,
    currentRegistry: {
      sourceFile: registry.sourceFile,
      sha256: registry.sha256,
      nativeOperationCount: registry.entries.length,
    },
    currentCapabilities,
    operations: operations.map((row) => {
      const currentCapabilityIds = capabilityIds(row.identity, currentCapabilities);
      return {
        ...row,
        currentCapabilityIds,
        implementationState:
          currentCapabilityIds.length > 0 && row.implementationState === "not-implemented"
            ? "partial"
            : row.implementationState,
      };
    }),
  };
}
export function validateJiraImplementation(ledger, registry) {
  const expected = reconcileJiraImplementation(ledger, registry);
  requireValid(
    JSON.stringify(ledger.currentRegistry) === JSON.stringify(expected.currentRegistry),
    "current-registry-drift",
  );
  requireValid(
    JSON.stringify(ledger.currentCapabilities) === JSON.stringify(expected.currentCapabilities),
    "current-capability-drift",
  );
  for (let index = 0; index < ledger.operations.length; index++) {
    const row = ledger.operations[index];
    const current = expected.operations[index];
    requireValid(
      JSON.stringify(row.currentCapabilityIds) === JSON.stringify(current.currentCapabilityIds),
      "current-operation-mapping",
    );
    requireValid(
      row.implementationState === current.implementationState,
      "current-implementation-state",
    );
  }
}
